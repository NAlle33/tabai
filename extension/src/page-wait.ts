import { sampleActionableInPage } from "./injected-interaction-scripts";
import { parseRef, frameTarget } from "./element-ref";
import { executeScript } from "./diagnostics";
import { checkWaitForInPage, type SelectorWaitState, type WaitObservation, type WaitProbeResult } from "./wait-probe";
import { evaluateInPage, PreDispatchError, validatePredicateInPage } from "./page-evaluation";
import { assertTabInGroup } from "./tab-group-helpers";

export interface WaitOptions {
  state?: SelectorWaitState;
  stableForMs?: number;
}

type PollStatus = "true" | "false" | "predicate-error" | "probe-error" | "document-changed" | "loading" | "missing-result";
interface PollObservation {
  startedMs: number;
  finishedMs: number;
  status: PollStatus;
  ok?: boolean;
  observation?: WaitObservation;
}
export interface WaitDiagnostics {
  startedAt: string;
  requestedTimeoutMs: number;
  elapsedMs: number;
  completedPollCount: number;
  stableForMs: number;
  stableElapsedMs: number;
  lastObservation?: PollObservation;
  polls: PollObservation[];
  document: { frameId: number; documentId?: string; changeCount: number };
  unfinishedProbe?: { startedMs: number; phase: "ownership" | "compilation" | "evaluation" | "injection" | "result-check" };
}

/** Poll the current document under one service-worker deadline. A page-owned
 * promise can disappear or freeze when navigation replaces its document.
 *
 * Predicates go through the debugger evaluator (page-evaluation.ts) so a page
 * whose policy forbids string evaluation can still be waited on; selector, text
 * and network-idle probes keep their plain injection. */
export async function waitInTab(
  sessionId: string,
  tabId: number,
  kind: string,
  value: string | { selector: string; value: string | number | boolean },
  timeoutMs: number,
  idleMs = 500,
  frameId?: number,
  options?: WaitOptions,
): Promise<WaitProbeResult & { diagnostics?: WaitDiagnostics }> {
  if (options?.state !== undefined && kind !== "selector") throw new Error("wait_for state requires a selector");
  if (options?.state !== undefined && !["attached", "visible", "hidden", "detached"].includes(options.state)) {
    throw new Error("wait_for selector state is invalid");
  }
  if (options?.stableForMs !== undefined && (!Number.isFinite(options.stableForMs) || options.stableForMs < 0)) {
    throw new Error("wait_for stableForMs must be a non-negative finite number");
  }
  const stableForMs = Math.min(270_000, options?.stableForMs ?? 0);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  // The last retryable predicate error, so a timeout says WHY it never settled
  // instead of reporting a bare deadline.
  let diagnostic: string | undefined;
  let stableSince: number | undefined;
  let documentId: string | undefined;
  let documentChangeCount = 0;
  let pendingDocumentChange = false;
  let observedFrameId = frameId ?? 0;
  let completedPollCount = 0;
  const polls: PollObservation[] = [];
  let unfinishedProbe: WaitDiagnostics["unfinishedProbe"];
  const relativeNow = () => Math.max(0, Date.now() - startedAt);
  const diagnostics = (): WaitDiagnostics => ({
    startedAt: new Date(startedAt).toISOString(),
    requestedTimeoutMs: timeoutMs,
    elapsedMs: relativeNow(),
    completedPollCount,
    stableForMs,
    stableElapsedMs: stableSince === undefined ? 0 : Math.max(0, Date.now() - stableSince),
    ...(polls.length ? { lastObservation: polls[polls.length - 1] } : {}),
    polls: polls.slice(),
    document: { frameId: observedFrameId, ...(documentId ? { documentId } : {}), changeCount: documentChangeCount },
    ...(unfinishedProbe ? { unfinishedProbe: { ...unfinishedProbe } } : {}),
  });
  const timeoutError = () => {
    const snapshot = diagnostics();
    return Object.assign(new Error(
      `wait_for ${kind} timed out after ${timeoutMs}ms` +
        (diagnostic ? ` (last predicate error: ${diagnostic})` : "") +
        ` waitDiagnostics=${JSON.stringify(snapshot)}`,
    ), { code: "TIMEOUT", retryable: false, diagnostics: snapshot });
  };
  const success = (result: WaitProbeResult) => {
    // Preserve the legacy success shape for callers that supplied no options.
    const { observation: _observation, ...legacy } = result;
    return options === undefined ? legacy : { ...legacy, diagnostics: diagnostics() };
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      reject(timeoutError());
    }, timeoutMs);
  });

  const poll = async () => {
    let predicateValidated = false;
    let idleSince: number | undefined;
    while (!stopped && Date.now() < deadline) {
      unfinishedProbe = { startedMs: relativeNow(), phase: "ownership" };
      await assertTabInGroup(sessionId, tabId);
      if (stopped || Date.now() >= deadline) throw timeoutError();
      let probe: { documentId?: string; frameId?: number; result?: WaitProbeResult } | undefined;
      let probeError = false;
      let documentChanged = false;
      try {
        if (kind === "predicate") {
          const scope = { sessionId, tabId, deadline, isStopped: () => stopped, expired: timeoutError };
          if (!predicateValidated) {
            unfinishedProbe.phase = "compilation";
            await validatePredicateInPage(scope, value as string);
            predicateValidated = true;
          }
          unfinishedProbe.phase = "evaluation";
          // Shares this wait's single deadline — never its own per-probe timeout.
          const evaluated = await evaluateInPage<WaitProbeResult>({
            ...scope,
            func: checkWaitForInPage,
            args: [kind, value],
            awaitPromise: false,
          });
          // A result from a document that has since been replaced is discarded:
          // the next ordinary poll takes fresh snapshots in the new document.
          if (evaluated.status === "ok") probe = { documentId: evaluated.documentId, result: evaluated.value };
          else documentChanged = true;
        } else {
          unfinishedProbe.phase = "injection";
          [probe] = await executeScript({
            target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] },
            world: "MAIN",
            injectImmediately: true,
            args: [kind, value, options?.state ?? "attached"],
            func: checkWaitForInPage,
          });
        }
      } catch (error) {
        // A terminal evaluator failure can follow a DISPATCHED predicate, so it
        // must bypass the loading/frame-replacement retry below: a page that is
        // still loading is no evidence that the predicate did not run.
        if (kind === "predicate" && !(error instanceof PreDispatchError)) throw error;
        probeError = true;
        const cause = error instanceof PreDispatchError ? error.reason : error;
        // Recheck membership/existence before classifying an injection failure.
        // Only a replaced frame or an actively loading tab warrants another probe.
        const tab = await assertTabInGroup(sessionId, tabId);
        if (stopped || Date.now() >= deadline) throw timeoutError();
        if (kind === "network_idle" && tab.status !== "loading" && !/^https?:/i.test(tab.url ?? "")) {
          // A non-HTTP page has no network capture; it still needs sampled
          // stability when the caller explicitly requested a quiet duration.
          probe = { result: { ok: true, kind, note: "no network capture on this document — treated as idle" } };
          probeError = false;
        } else {
          const replacedFrame = /frame.*(?:removed|not found)|no frame with id|document.*(?:unloaded|removed)|context.*(?:destroyed|invalidated)/i.test(String(cause));
          // A loading parent cannot hide unrelated errors in an explicit frame.
          if (!replacedFrame && (frameId !== undefined || tab.status !== "loading")) throw error;
          if (replacedFrame) documentChanged = true;
        }
      }
      if (stopped || Date.now() >= deadline) throw timeoutError();
      unfinishedProbe.phase = "result-check";
      const tab = await assertTabInGroup(sessionId, tabId);
      if (stopped || Date.now() >= deadline) throw timeoutError();
      const result = probe?.result;
      if (documentChanged) {
        if (!pendingDocumentChange) documentChangeCount++;
        pendingDocumentChange = true;
        diagnostic = undefined;
      }
      const probeDocumentId = probe?.documentId?.slice(0, 128);
      if (probeDocumentId && documentId !== probeDocumentId) {
        if (documentId !== undefined && !pendingDocumentChange) documentChangeCount++;
        documentChanged = documentId !== undefined || documentChanged;
        documentId = probeDocumentId;
        diagnostic = undefined;
      }
      if (probeDocumentId) pendingDocumentChange = false;
      if (probe?.frameId !== undefined) observedFrameId = probe.frameId;
      if (!result || probeError || documentChanged || !result.ok || result.diagnostic || tab.status === "loading") {
        idleSince = undefined;
        stableSince = undefined;
      }
      // A poll that evaluated cleanly replaces the stored reason with nothing.
      if (result) diagnostic = result.diagnostic?.slice(0, 500);
      const sample: PollObservation = {
        startedMs: unfinishedProbe.startedMs,
        finishedMs: relativeNow(),
        status: documentChanged ? "document-changed" : probeError ? "probe-error"
          : tab.status === "loading" ? "loading" : !result ? "missing-result"
            : result.diagnostic ? "predicate-error" : result.ok ? "true" : "false",
        ...(result ? { ok: result.ok, ...(result.observation ? { observation: result.observation } : {}) } : {}),
      };
      completedPollCount++;
      polls.push(sample);
      if (polls.length > 8) polls.shift();
      unfinishedProbe = undefined;
      // Permanent: reported even while the tab loads, because both document
      // snapshots already confirmed which document answered.
      if (result?.fatal) throw new Error(`wait_for ${kind}: ${result.fatal}`);
      if (result?.reason && tab.status !== "loading") {
        throw new Error(`wait_for ${kind}: ${result.reason}`);
      }
      if (result?.ok) {
        const stable = stableForMs === 0 || (tab.status !== "loading" && !result.diagnostic &&
          Date.now() - (stableSince ??= Date.now()) >= stableForMs);
        if (kind !== "network_idle" && stable) return success(result);
        if (kind === "network_idle" && tab.status !== "loading") {
          if (result.note && stable) return success(result);
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= idleMs && stable) return success(result);
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
    throw timeoutError();
  };

  try {
    // Even a browser injection that stalls during navigation must respect the
    // caller's deadline. Its eventual completion must not start another probe.
    return await Promise.race([poll(), expired]);
  } finally {
    stopped = true;
    clearTimeout(timer!);
  }
}

/** Ref waits never follow a replacement document. Only the worker owns timers;
 * a frozen page/probe may finish later but cannot authorize input or another poll. */
export async function waitForActionableRef(
  sessionId: string,
  tabId: number,
  ref: string,
  timeoutMs = 5000,
  documentId?: string,
): Promise<string> {
  const { base, frameId } = parseRef(ref);
  frameTarget(tabId, frameId, documentId);
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  let reason = "not stable";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => Object.assign(new Error(
    `Element ${ref} not actionable within ${timeoutMs}ms (${reason}).`,
  ), { code: "TIMEOUT" });
  const checkDeadline = () => { if (stopped || Date.now() >= deadline) throw timeoutError(); };
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { stopped = true; reject(timeoutError()); }, timeoutMs);
  });
  const poll = async () => {
    let previous: ReturnType<typeof sampleActionableInPage>["rect"];
    while (true) {
      checkDeadline();
      await assertTabInGroup(sessionId, tabId);
      checkDeadline();
      const results = await executeScript({
        target: frameTarget(tabId, frameId, documentId),
        func: sampleActionableInPage,
        args: [base],
      });
      checkDeadline();
      const result = results[0];
      if (results.length !== 1 || result?.frameId !== frameId || !result.documentId ||
          (documentId !== undefined && result.documentId !== documentId)) {
        throw new Error("Reference frame/document mismatch; resolve the target again before acting");
      }
      documentId = result.documentId;
      const sample = result.result;
      if (!sample) throw new Error("Reference actionability sample unavailable");
      if (sample.fatal) throw new Error(sample.fatal);
      await assertTabInGroup(sessionId, tabId);
      checkDeadline();
      const rect = sample.rect;
      if (sample.ok && rect && previous && previous.x === rect.x && previous.y === rect.y &&
          previous.w === rect.w && previous.h === rect.h) return documentId;
      previous = sample.ok ? rect : undefined;
      reason = sample.reason ?? "not stable";
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
      checkDeadline();
    }
  };
  try { return await Promise.race([poll(), expired]); }
  finally { stopped = true; clearTimeout(timer); }
}
