import { executeScript } from "./diagnostics";
// One CSP-capable path for running user-supplied JavaScript in a page.
//
// javascript_tool and wait_for predicates both run a SERIALIZED page function
// (evalInPage / checkWaitForInPage) through Runtime.evaluate. A MAIN-world
// chrome.scripting injection inherits the page's Content-Security-Policy, so a
// page whose script-src omits 'unsafe-eval' refuses to evaluate a string at all.
// Runtime.evaluate carries a per-call allowance instead, and that allowance is
// scoped to the one evaluation — the page's own eval stays refused before and
// after it.
//
// The path is chosen BEFORE any user code runs and there is no fallback: a
// command that failed ambiguously may already have mutated the page, so a second
// attempt through another evaluator could duplicate the mutation.

import { cdpSend, withRuntimeDomain } from "./cdp";
import { assertTabInGroup } from "./tab-group-helpers";

/** A failure that provably happened BEFORE user code was dispatched. The wait
 *  loop may classify it with its ordinary loading / frame-replacement rules and
 *  poll again; every other failure from this module is terminal, because the
 *  supplied code may already have run. */
export class PreDispatchError extends Error {
  readonly reason: unknown;
  constructor(message: string, reason: unknown) {
    super(message);
    this.name = "PreDispatchError";
    this.reason = reason;
  }
}

export interface PageEvaluationRequest {
  sessionId: string;
  tabId: number;
  /** Absolute epoch-ms deadline owned by the CALLER. Never extended here. */
  deadline: number;
  /** True once the caller abandoned the request (timeout, tab closed). */
  isStopped?: () => boolean;
  /** The error the caller wants when its own deadline has passed. */
  expired: () => Error;
  /** A self-contained injected page function; serialized with toString(). */
  func: (...args: any[]) => unknown;
  /** JSON-encodable arguments for that function. */
  args: unknown[];
  /** Await a promise the function returns (javascript_tool only). Predicates are
   *  synchronous by contract: a returned Promise object is truthy, never awaited. */
  awaitPromise: boolean;
  /** `isolated` runs in a fresh isolated world of the main frame: the page's
   *  own JavaScript (patched prototypes, globals) is invisible there, the DOM
   *  is shared. Absent means the page's MAIN world. */
  world?: "main" | "isolated";
}

type PageRequestScope = Pick<PageEvaluationRequest, "sessionId" | "tabId" | "deadline" | "isStopped" | "expired">;

function requestGuards(request: PageRequestScope) {
  const open = () => {
    if (request.isStopped?.() || Date.now() >= request.deadline) throw request.expired();
  };
  const guard = async () => {
    open();
    await assertTabInGroup(request.sessionId, request.tabId);
    open();
  };
  return { open, guard };
}

/** Parse the unchanged predicate using Chromium's Script grammar, just like
 * indirect eval. FunctionBody grammar would accept illegal top-level return /
 * new.target and reject a valid hashbang. Compilation neither executes nor
 * persists the source; successful validation is cached only by this wait. */
export async function validatePredicateInPage(request: PageRequestScope, source: string): Promise<void> {
  const { open, guard } = requestGuards(request);
  let response: {
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  } | undefined;
  try {
    response = await withRuntimeDomain(request.tabId, async () => {
      await guard();
      const compiled = await cdpSend(request.tabId, "Runtime.compileScript", {
        expression: source,
        sourceURL: "",
        persistScript: false,
      }, async () => {
        // Runtime must be enabled on the CURRENT attachment. This guard also
        // runs after safe recovery. Ref-context discovery cannot disable it
        // between this enable and compile while this sequence holds the lock.
        await cdpSend(request.tabId, "Runtime.enable", {}, guard);
        await guard();
      });
      await guard();
      return compiled;
    });
  } catch (error) {
    open();
    // Only browser setup/compilation ran, so the ordinary loading/frame retry
    // may safely try again. Syntax exceptions below are always terminal.
    throw new PreDispatchError(`could not validate the predicate: ${String((error as Error)?.message ?? error)}`, error);
  }
  if (!response || typeof response !== "object") {
    throw new Error("the debugger returned no predicate compilation result");
  }
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails;
    const message = detail.exception?.description ?? detail.text ?? "invalid Script";
    throw new Error(`wait_for predicate: predicate has a syntax error: ${message.slice(0, 500)}`);
  }
}

/** `document-changed` means the evaluation completed but the document it ran in
 *  was replaced before the result could be accepted. A polling caller may take a
 *  fresh snapshot and probe again; a one-shot caller must report a failure
 *  rather than run the supplied code a second time. */
export type PageEvaluation<T> =
  | { status: "ok"; value: T; documentId: string }
  | { status: "document-changed" };

// U+2028/U+2029 are legal inside a JSON string but were once illegal in a JS
// string literal; escaping them keeps the generated expression portable.
function encodeArguments(args: unknown[]): string {
  return JSON.stringify(args).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The caller's text travels as a JSON-encoded ARGUMENT, never as generated
 *  syntax, so the page runs exactly the injected function the tests cover. */
function callExpression(func: (...args: any[]) => unknown, args: unknown[]): string {
  return `(${func.toString()}).apply(undefined, ${encodeArguments(args)})`;
}

/** The browser's identity for the tab's CURRENT main-frame document. A fresh
 *  document — including a same-URL reload — gets a new one even when the frame
 *  survives, so an equal pair around the evaluation shows that no replacement was
 *  observed. This is a snapshot, not an atomic fence: an A-to-B-to-A restoration
 *  from the back-forward cache could return the same identity twice. The probe
 *  evaluates nothing, so the page's policy cannot refuse it. */
async function documentIdOf(tabId: number, phase: "before" | "after"): Promise<string> {
  let injected: chrome.scripting.InjectionResult[] | undefined;
  try {
    injected = await executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func: () => null,
    });
  } catch (error) {
    const message = `could not identify the page's document: ${String((error as Error)?.message ?? error)}`;
    if (phase === "before") throw new PreDispatchError(message, error);
    throw new Error(message);
  }
  const documentId = injected?.[0]?.documentId;
  if (!documentId) {
    const message = "the page's current document could not be identified";
    if (phase === "before") throw new PreDispatchError(message, undefined);
    throw new Error(message);
  }
  return documentId;
}

/** The post-dispatch identity, with one retry. A probe issued while a
 *  cross-document commit is in flight is rejected with the same
 *  `Frame ... was removed` that the wait loop has always retried, and treating
 *  that as terminal would fail a wait for the very navigation it exists to
 *  survive. The second probe resolves against whichever document is now current,
 *  and the caller's before/after comparison still decides whether the result may
 *  be accepted. A probe that fails twice leaves the identity unverifiable, which
 *  never certifies a result. */
async function documentIdAfterDispatch(
  tabId: number,
  deadline: number,
  guard: () => Promise<void>,
): Promise<string> {
  await guard();
  try {
    return await documentIdOf(tabId, "after");
  } catch {
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
    );
    await guard();
    return await documentIdOf(tabId, "after");
  }
}

/** A fresh isolated world in the tab's main frame, created through the same
 *  attachment and ownership guard as the evaluation. Nothing of the caller's
 *  code has run yet, so a failure here is pre-dispatch; there is no fallback to
 *  the MAIN world, because a caller asked for isolation on purpose. */
async function isolatedContext(tabId: number, guard: () => Promise<void>): Promise<number> {
  try {
    const tree = await cdpSend<{ frameTree?: { frame?: { id?: string } } }>(tabId, "Page.getFrameTree", {}, guard);
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) throw new Error("the main frame could not be identified");
    const world = await cdpSend<{ executionContextId?: number }>(tabId, "Page.createIsolatedWorld", {
      frameId, worldName: "tabai-isolated", grantUniveralAccess: false,
    }, guard);
    if (!Number.isSafeInteger(world?.executionContextId)) throw new Error("no execution context was returned");
    return world.executionContextId!;
  } catch (error) {
    throw new PreDispatchError(`could not create an isolated world in the main frame: ${String((error as Error)?.message ?? error)}`, error);
  }
}

/** Read the Runtime.evaluate envelope. Both wrappers return an object, so an
 *  absent, thrown or non-object payload is reported as an actionable failure
 *  rather than accepted as success or undefined. */
function decodeEnvelope<T>(response: unknown): T {
  const envelope = response as
    | {
        result?: { type?: string; value?: unknown };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string; value?: unknown };
        };
      }
    | null
    | undefined;
  if (!envelope || typeof envelope !== "object") {
    throw new Error("the debugger returned no evaluation result for this page");
  }
  if (envelope.exceptionDetails) {
    const { text, exception } = envelope.exceptionDetails;
    const described = exception?.description ?? exception?.value ?? text ?? "unknown error";
    throw new Error(`page evaluation failed: ${String(described).slice(0, 500)}`);
  }
  const value = envelope.result?.value;
  if (value === null || typeof value !== "object") {
    throw new Error(
      `the page returned an unusable evaluation envelope (${envelope.result?.type ?? "no result"})`,
    );
  }
  return value as T;
}

/** Run one serialized page function through the debugger under the caller's
 *  deadline and session ownership. */
export async function evaluateInPage<T>(request: PageEvaluationRequest): Promise<PageEvaluation<T>> {
  const { tabId, deadline } = request;
  const { open, guard } = requestGuards(request);

  await guard();
  const before = await documentIdOf(tabId, "before");
  open();
  // Created after the document snapshot: a world in a replacement document is
  // caught by the same before/after comparison as any other evaluation.
  const contextId = request.world === "isolated" ? await isolatedContext(tabId, guard) : undefined;
  open();

  const params = {
    expression: callExpression(request.func, request.args),
    ...(contextId === undefined ? {} : { contextId }),
    returnByValue: true,
    awaitPromise: request.awaitPromise,
    // Scoped to this ONE evaluation; the page's own policy is untouched.
    allowUnsafeEvalBlockedByCSP: true,
    userGesture: false,
    includeCommandLineAPI: false,
    // Filled only after attachment and the asynchronous ownership guard.
    timeout: 1,
  };
  let response: unknown;
  try {
    response = await cdpSend(
      tabId,
      "Runtime.evaluate",
      params,
      async () => {
        // Runs immediately before each send, including the one safe resend
        // after a pre-execution "not attached" rejection. Time spent attaching
        // or checking ownership must consume the renderer's execution budget.
        await guard();
        open();
        // Bounds synchronous execution only; the caller bounds pending promises.
        params.timeout = Math.max(1, deadline - Date.now());
      },
    );
  } catch (error) {
    // A request that ran out of budget reports its own deadline rather than the
    // terminated evaluation that expiry caused.
    open();
    throw error;
  }

  // The supplied code may have run from here on: no retry, no other evaluator.
  open();
  const value = decodeEnvelope<T>(response);
  const after = await documentIdAfterDispatch(tabId, deadline, guard);
  await guard();
  if (before !== after) return { status: "document-changed" };
  return { status: "ok", value, documentId: after };
}
