import { NoFallbackError, ToolError } from "./tool-error";
import { cdpSend, withRuntimeDomain } from "./cdp";
import { executeScript } from "./diagnostics";

/** Serialized in the extension isolated world. Attributes alone cannot prove
 * node identity: a page can clone a ref without cloning this world's map. */
function resolveIssuedRefInPage(ref: string): Element {
  if (!/^ref_\d+$/.test(ref)) throw new Error("invalid ref");
  const w = window as any;
  const state = w.__ccmcpRefState;
  if (state?.document !== document || !/^ref_\d{50}$/.test(ref) ||
      ref.slice(4, 44) !== state.namespace) throw new Error(`Stale ref ${ref}; read the page again`);
  const el = w.__ccmcpRefMap?.[ref];
  if (!el?.isConnected || el.ownerDocument !== document || el.getAttribute("data-ccmcp-ref") !== ref)
    throw new Error(`Stale ref ${ref}; read the page again`);
  let matches = 0;
  const visit = (root: Document | ShadowRoot): void => {
    for (const candidate of root.querySelectorAll(`[data-ccmcp-ref="${ref}"]`)) {
      if (candidate.isConnected && candidate.ownerDocument === document) {
        if (candidate !== el || ++matches > 1) throw new Error(`Ambiguous ref ${ref}; read the page again`);
      }
    }
    for (const node of root.querySelectorAll("*")) if (node.shadowRoot) visit(node.shadowRoot);
  };
  visit(document);
  if (matches !== 1) throw new Error(`Stale ref ${ref}; read the page again`);
  return el;
}

/** A CDP expression for the selected extension ISOLATED context only. It never
 * searches MAIN or another frame, and fails before a stale/duplicate mutation. */
export function deepByAttrExpr(ref: string, _frameId = 0): string {
  return `(${resolveIssuedRefInPage.toString()})(${JSON.stringify(ref)})`;
}

// A temporary listener discovers worlds even after a worker restart leaves
// Runtime enabled. Keep disable/enable atomic with predicate compilation.
async function isolatedContexts(tabId: number): Promise<{ id: number; origin: string; auxData?: { isDefault?: boolean; frameId?: string } }[]> {
  type Context = { id: number; origin: string; auxData?: { isDefault?: boolean; frameId?: string } };
  const contexts = new Map<number, Context>();
  let expired = false;
  const guard = () => { if (expired) throw new Error("Reference context discovery timed out"); };
  const listener = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== tabId || method !== "Runtime.executionContextCreated") return;
    const context = (params as { context?: Context })?.context;
    if (context?.origin === `chrome-extension://${chrome.runtime.id}` && context.auxData?.isDefault !== true)
      contexts.set(context.id, context);
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = withRuntimeDomain(tabId, async () => {
    guard();
    chrome.debugger.onEvent.addListener(listener);
    try {
      // Safe attachment recovery also re-runs this guard before each send.
      await cdpSend(tabId, "Runtime.disable", {}, guard);
      await cdpSend(tabId, "Runtime.enable", {}, guard);
      guard();
      if (contexts.size > 256) throw new Error("Too many isolated reference contexts; narrow the page first");
      return [...contexts.values()];
    } finally { chrome.debugger.onEvent.removeListener(listener); }
  });
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => {
        expired = true;
        chrome.debugger.onEvent.removeListener(listener);
        reject(new Error("Reference context discovery timed out"));
      }, 2000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
  // On timeout the shared lock stays held until the pending CDP command settles;
  // no delayed disable can slip between another caller's enable and compile.
}

/** Authenticate the ref in its exact Chrome frame/document, then evaluate only
 * in the matching extension context. Any uncertain evaluation is terminal;
 * callers must never replay it through MAIN or a synthetic fallback. */
export async function evaluateRefInTab<T = any>(
  tabId: number,
  ref: string,
  expression: string,
  returnByValue = true,
): Promise<T> {
  const { base, frameId } = parseRef(ref);
  const inspect = async (documentId?: string) => {
    const results = await executeScript({
      target: frameTarget(tabId, frameId, documentId),
      func: (r: string) => {
        const state = (window as any).__ccmcpRefState;
        const node = (window as any).__ccmcpRefMap?.[r];
        if (state?.document !== document || !/^ref_\d{50}$/.test(r) || r.slice(4, 44) !== state.namespace ||
            !node?.isConnected || node.ownerDocument !== document || node.getAttribute("data-ccmcp-ref") !== r)
          throw new Error(`Stale ref ${r}; read the page again`);
        return state.namespace as string;
      },
      args: [base],
    });
    const result = results[0];
    if (results.length !== 1 || result?.frameId !== frameId || !result.documentId || !result.result ||
        (documentId && result.documentId !== documentId)) throw new Error("Reference frame/document changed; read the page again");
    return { namespace: result.result, documentId: result.documentId };
  };
  try {
    const before = await inspect();
    const contexts = await isolatedContexts(tabId);
    const matched: number[] = [];
    for (const context of contexts) {
      try {
        const probe = await cdpSend<any>(tabId, "Runtime.evaluate", {
          contextId: context.id,
          expression: `window.__ccmcpRefState?.document===document&&window.__ccmcpRefState?.namespace===${JSON.stringify(before.namespace)}`,
          returnByValue: true,
        });
        if (!probe.exceptionDetails && probe.result?.value === true) matched.push(context.id);
      } catch (error) {
        // Only a read-only namespace probe may skip an unrelated world removed
        // during discovery. A mutation or uncertain transport is never retried.
        if (!/cannot find context with specified id|execution context (?:was )?(?:destroyed|not found)|cannot find execution context/i.test(String((error as Error)?.message ?? error))) throw error;
      }
    }
    if (!matched.length && frameId !== 0) {
      // The ref was live in its frame a moment ago. If it still is, its world is
      // missing because the frame runs in another renderer process (a cross-site
      // frame), which this tab's debugger session cannot evaluate in.
      await inspect(before.documentId);
      throw new Error(`${ref} is inside a cross-site frame that runs in its own process; debugger-based actions such as file_upload cannot reach it. Open the frame's page in its own tab and act there.`);
    }
    if (matched.length !== 1) throw new Error("Reference isolated context is stale, ambiguous or unavailable; read the page again");
    const current = await inspect(before.documentId);
    if (current.namespace !== before.namespace) throw new Error("Reference document changed; read the page again");
    const result = await cdpSend<any>(tabId, "Runtime.evaluate", {
      contextId: matched[0], expression, returnByValue,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "reference evaluation failed";
      throw new Error(detail);
    }
    if (!result.result) throw new Error("Reference evaluation returned no result");
    return result as T;
  } catch (error) {
    throw new NoFallbackError(String((error as Error)?.message ?? error));
  }
}

// Refs are frame-qualified: "ref_N" lives in the main frame; "ref_N@<frameId>"
// lives in a sub-frame (cross-origin or not). Parse + target the right frame.
// Anything else is refused up front — the base is interpolated into selectors
// by every resolver, and a malformed ref must never silently become frame 0.
export function parseRef(ref: string): { base: string; frameId: number } {
  const m = /^(ref_\d+)(?:@(\d+))?$/.exec(String(ref));
  if (!m) {
    throw new ToolError(
      "TOOL_ERROR",
      `invalid ref "${String(ref).slice(0, 40)}" — refs look like ref_12 or ref_12@5 (from read_page/find)`,
    );
  }
  return { base: m[1], frameId: m[2] ? parseInt(m[2], 10) : 0 };
}

export function frameTarget(
  tabId: number,
  frameId: number,
  documentId?: string,
): chrome.scripting.InjectionTarget {
  if (documentId !== undefined) {
    if (typeof documentId !== "string" || !documentId.trim()) throw new Error("documentId must be a non-empty string");
    // A frame ID survives navigation; a document ID does not. Never fall back to
    // the frame when this document has been replaced.
    return { tabId, documentIds: [documentId] };
  }
  return frameId ? { tabId, frameIds: [frameId] } : { tabId };
}
