import assert from "node:assert/strict";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let state;
const reset = () => {
  state = { calls: 0, documentId: "document-one", tab: { status: "complete", url: "https://fixture.test/" },
    probe: () => ({ ok: false, kind: "selector" }) };
};
reset();
globalThis.waitFixture = {
  async assertTabInGroup(sessionId, tabId) {
    assert.equal(sessionId, "owner");
    assert.equal(tabId, 7);
    return state.ownership ? state.ownership() : state.tab;
  },
  async executeScript(injection) {
    state.calls++;
    (state.targets ??= []).push(injection.target);
    const result = await state.probe(...injection.args);
    return [{ frameId: state.frameId ?? 0, documentId: state.documentId, result }];
  },
  async evaluateInPage(request) {
    state.calls++;
    const result = await state.probe(...request.args);
    return state.evaluationStatus === "document-changed" ? { status: "document-changed" }
      : { status: "ok", documentId: state.documentId, value: result };
  },
};
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { waitInTab, waitForActionableRef } from './extension/src/page-wait.ts';
  export { checkWaitForInPage } from './extension/src/wait-probe.ts';
  export { toolWaitFor } from './extension/src/browser-tools.ts';
` }, bundle: true, write: false,
  platform: "node", format: "esm", plugins: [{ name: "wait-boundaries", setup(build) {
    build.onResolve({ filter: /^\.\/(diagnostics|tab-group-helpers|page-evaluation|cdp|browser-pointer|computer-input|capture-tools)$/ }, args =>
      ({ path: args.path, namespace: "wait-test" }));
    build.onLoad({ filter: /.*/, namespace: "wait-test" }, args => ({ contents: {
      "./diagnostics": "export const executeScript=(...args)=>globalThis.waitFixture.executeScript(...args)",
      "./tab-group-helpers": `export const assertTabInGroup=(...args)=>globalThis.waitFixture.assertTabInGroup(...args);
        export const sessionOf=args=>{ if (typeof args?.__sessionId !== "string" || !args.__sessionId) throw new Error("NO_SESSION"); return args.__sessionId; };`,
      "./cdp": "export const cdpSend=()=>{}; export const withRuntimeDomain=()=>{};",
      // Other browser-tools handlers; wait_for never reaches them.
      "./browser-pointer": "export const browserPointer=()=>{ throw new Error('unused'); };",
      "./computer-input": "export const cdpInteract=()=>{ throw new Error('unused'); };",
      "./capture-tools": "export const captureComputerScreenshot=()=>{ throw new Error('unused'); };",
      "./page-evaluation": `export class PreDispatchError extends Error {}
        export const validatePredicateInPage=async()=>{};
        export const evaluateInPage=(...args)=>globalThis.waitFixture.evaluateInPage(...args);`,
    }[args.path] }));
  } }] });
const { waitInTab, waitForActionableRef, checkWaitForInPage, toolWaitFor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const wait = (kind, value, timeoutMs, options) => waitInTab("owner", 7, kind, value, timeoutMs, 500, undefined, options);
const captureTimeout = async (...args) => {
  let error;
  try { await wait(...args); } catch (caught) { error = caught; }
  assert.equal(error?.code, "TIMEOUT", error?.message ?? "wait unexpectedly succeeded");
  return error;
};

try {
  state.probe = () => ({ ok: false, kind: "selector", observation: { status: "unmatched", matched: false, matchCount: 0 } });
  const timedOut = await captureTimeout("selector", "#private-selector", 1050);
  assert.ok(timedOut.diagnostics, "false polls must leave bounded timeout observations");
  assert.equal(timedOut.diagnostics.requestedTimeoutMs, 1050);
  assert.ok(timedOut.diagnostics.elapsedMs >= 1000);
  assert.ok(timedOut.diagnostics.completedPollCount >= 9);
  assert.equal(timedOut.diagnostics.polls.length, 8);
  assert.equal(timedOut.diagnostics.lastObservation.status, "false");
  assert.equal(timedOut.diagnostics.lastObservation.ok, false);
  assert.deepEqual(timedOut.diagnostics.document, { frameId: 0, documentId: "document-one", changeCount: 0 });
  for (const poll of timedOut.diagnostics.polls) assert.ok(poll.finishedMs >= poll.startedMs);
  assert.deepEqual(JSON.parse(timedOut.message.split("waitDiagnostics=")[1]), timedOut.diagnostics);
  assert.doesNotMatch(JSON.stringify(timedOut.diagnostics), /private-selector/);
  console.log("  ✓ false polls leave bounded serializable timeout observations without selector text");

  reset();
  state.probe = () => ({ ok: true, kind: "predicate", observation: { status: "matched", matched: true } });
  assert.deepEqual(await wait("predicate", "true", 500), { ok: true, kind: "predicate" });
  console.log("  ✓ legacy success shape is preserved");

  reset();
  state.probe = () => ({ ok: state.calls !== 2, kind: "predicate" });
  const falseReset = await wait("predicate", "fixture condition", 1200, { stableForMs: 150 });
  assert.ok(state.calls >= 5, "a false observation must restart the stability interval");
  assert.ok(falseReset.diagnostics.stableElapsedMs >= 150);
  console.log("  ✓ a false sample resets stability");

  reset();
  state.probe = () => state.calls === 2 ? { ok: false, kind: "predicate", diagnostic: "ReferenceError: fixture pending" }
    : { ok: true, kind: "predicate" };
  await wait("predicate", "fixture condition", 1200, { stableForMs: 150 });
  assert.ok(state.calls >= 5, "a predicate error must restart the stability interval");
  console.log("  ✓ a retryable predicate error resets stability");

  reset();
  state.probe = () => {
    if (state.calls === 3) state.documentId = "document-two";
    return { ok: true, kind: "predicate" };
  };
  const changed = await wait("predicate", "fixture condition", 1500, { stableForMs: 250 });
  assert.ok(state.calls >= 6, "stability from the old document must not certify the new one");
  assert.equal(changed.diagnostics.document.changeCount, 1);
  assert.equal(changed.diagnostics.document.documentId, "document-two");
  assert.ok(changed.diagnostics.polls.some(poll => poll.status === "document-changed"));
  console.log("  ✓ a new document resets stability and records its identity");

  reset();
  state.probe = () => {
    state.tab.status = state.calls === 2 ? "loading" : "complete";
    return { ok: true, kind: "selector" };
  };
  await wait("selector", "#fixture", 1200, { stableForMs: 150 });
  assert.ok(state.calls >= 5, "loading must restart the stability interval");
  console.log("  ✓ loading resets stability");

  reset();
  let release;
  state.probe = () => new Promise(resolve => { release = resolve; });
  const stalled = await captureTimeout("predicate", "secret predicate source", 90);
  assert.equal(stalled.diagnostics.completedPollCount, 0);
  assert.equal(stalled.diagnostics.unfinishedProbe.phase, "evaluation");
  assert.equal(stalled.diagnostics.lastObservation, undefined);
  const stalledSnapshot = JSON.stringify(stalled.diagnostics);
  release({ ok: true, kind: "predicate", rawResult: "private evaluation output" });
  await delay(160);
  assert.equal(state.calls, 1, "a late true result must not start another probe");
  assert.equal(JSON.stringify(stalled.diagnostics), stalledSnapshot, "late results must not change the returned timeout snapshot");
  assert.doesNotMatch(stalledSnapshot, /secret predicate|private evaluation/);
  console.log("  ✓ a stalled predicate is distinguished from false and late truth never restarts polling");

  reset();
  state.probe = async () => { await delay(180); return { ok: true, kind: "selector" }; };
  const late = await captureTimeout("selector", "#late-marker", 70);
  assert.equal(late.diagnostics.unfinishedProbe.phase, "injection");
  await delay(220);
  assert.equal(state.calls, 1);
  assert.equal(late.diagnostics.completedPollCount, 0);
  console.log("  ✓ a selector becoming true after deadline cannot satisfy or restart a wait");

  reset();
  state.probe = () => ({ ok: false, kind: "predicate", diagnostic: "ReferenceError: fixture is not ready" });
  const errored = await captureTimeout("predicate", "private predicate source", 180);
  assert.match(errored.message, /last predicate error: ReferenceError: fixture is not ready/);
  assert.equal(errored.diagnostics.lastObservation.status, "predicate-error");
  assert.doesNotMatch(JSON.stringify(errored.diagnostics), /ReferenceError|private predicate source/);
  console.log("  ✓ retryable error text stays in the legacy message and out of observations");

  reset();
  state.probe = () => { throw new Error("Cannot access contents of this page"); };
  await assert.rejects(wait("selector", "#fixture", 1000), /Cannot access contents/);
  assert.equal(state.calls, 1, "plain injection failures must remain prompt");
  console.log("  ✓ permission errors remain prompt and are not hidden by diagnostics");

  const actionable = { ok: true, rect: { x: 10, y: 20, w: 40, h: 30 } };
  const refWait = (timeout = 500, documentId) => waitForActionableRef("owner", 7, "ref_1", timeout, documentId);
  reset(); state.probe = () => actionable;
  assert.equal(await refWait(), "document-one");
  assert.equal(state.calls, 2, "two identical worker samples authorize actionability");
  assert.deepEqual(state.targets, [{ tabId: 7 }, { tabId: 7, documentIds: ["document-one"] }]);
  console.log("  ✓ ref actionability pins its first document and samples geometry twice");

  for (const mode of ["hidden", "disabled", "moving"]) {
    reset();
    state.probe = () => mode === "moving" ? { ...actionable, rect: { ...actionable.rect, x: state.calls } }
      : { ...actionable, ok: false, reason: mode };
    await assert.rejects(refWait(160), error => error.code === "TIMEOUT");
  }
  for (const mode of ["document", "frame", "stale", "duplicate", "missing"]) {
    reset();
    state.probe = () => {
      if (mode === "document") state.documentId = "document-two";
      if (mode === "frame") state.frameId = 2;
      if (mode === "missing") return undefined;
      return mode === "stale" || mode === "duplicate" ? { ok: false, fatal: mode + " ref" } : actionable;
    };
    await assert.rejects(refWait(500, "document-one"), /mismatch|stale|duplicate|unavailable/);
    assert.equal(state.calls, 1, "identity failures must not follow/retry another document");
  }
  console.log("  ✓ DOM state, unstable geometry and invalid ref/frame/document cannot authorize input");

  for (const phase of ["probe", "ownership-before", "ownership-after"]) {
    reset();
    let release, ownershipCalls = 0;
    state.probe = () => phase === "probe" ? new Promise(resolve => { release = resolve; }) : actionable;
    state.ownership = () => {
      ownershipCalls++;
      if ((phase === "ownership-before" && ownershipCalls === 1) || (phase === "ownership-after" && ownershipCalls === 2))
        return new Promise(resolve => { release = resolve; });
      return state.tab;
    };
    await assert.rejects(refWait(60), error => error.code === "TIMEOUT");
    const calls = state.calls, owners = ownershipCalls;
    release(phase === "probe" ? actionable : state.tab);
    await delay(120);
    assert.equal(state.calls, calls, phase + " late result must not start another probe");
    assert.equal(ownershipCalls, owners, phase + " late result must not start another ownership check");
  }
  reset();
  let releaseSecond;
  state.probe = () => state.calls === 1 ? actionable : new Promise(resolve => { releaseSecond = resolve; });
  await assert.rejects(refWait(160), error => error.code === "TIMEOUT");
  releaseSecond(actionable);
  await delay(120);
  assert.equal(state.calls, 2, "late stable geometry never satisfies or restarts a wait");
  console.log("  ✓ stalled probes/ownership and late stable results expire at the worker and stay stopped");

  // wait_for asking for more than the worker's request budget still waits at
  // most 270 s: Chrome ends a single worker request after five minutes. The long
  // timer is fired at once here; its requested delay is what the worker scheduled.
  reset();
  state.probe = () => ({ ok: false, kind: "selector" });
  const scheduled = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...rest) => {
    if (delay > 60_000) { scheduled.push(delay); delay = 0; }
    return realSetTimeout(callback, delay, ...rest);
  };
  let clamped;
  try { await toolWaitFor({ __sessionId: "owner", tabId: 7, selector: "#fixture", timeoutMs: 999_999 }); }
  catch (error) { clamped = error; }
  finally { globalThis.setTimeout = realSetTimeout; }
  assert.deepEqual(scheduled, [270_000], "the wait's deadline timer is clamped to 270 000 ms");
  assert.equal(clamped?.code, "TIMEOUT", clamped?.message ?? "wait unexpectedly succeeded");
  assert.equal(clamped.diagnostics.requestedTimeoutMs, 270_000);
  assert.match(clamped.message, /timed out after 270000ms/);
  console.log("  ✓ wait_for above 270 s is clamped to a 270 000 ms deadline");

  const previous = Object.fromEntries(["window", "document", "location", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Input { constructor() { this.type = "text"; this.value = "observed-private-value"; } }
  let matches = [];
  let invalid = false;
  const element = { getBoundingClientRect: () => ({ width: 40, height: 20 }) };
  let style = { display: "block", visibility: "visible" };
  Object.assign(globalThis, { window: { getComputedStyle: el => el.style ?? style }, location: { protocol: "https:", href: "https://fixture.test/" },
    document: { querySelectorAll: () => { if (invalid) throw new Error("invalid selector"); return matches; } },
    HTMLInputElement: Input, HTMLTextAreaElement: class {}, HTMLSelectElement: class {} });
  try {
    assert.equal(checkWaitForInPage("selector", "#fixture", "attached").ok, false);
    assert.equal(checkWaitForInPage("selector", "#fixture", "hidden").ok, true);
    assert.equal(checkWaitForInPage("selector", "#fixture", "detached").ok, true);
    matches = [element];
    assert.equal(checkWaitForInPage("selector", "#fixture", "attached").ok, true);
    assert.equal(checkWaitForInPage("selector", "#fixture", "visible").ok, true);
    assert.equal(checkWaitForInPage("selector", "#fixture", "hidden").ok, false);
    assert.equal(checkWaitForInPage("selector", "#fixture", "detached").ok, false);
    style = { display: "none", visibility: "visible" };
    assert.equal(checkWaitForInPage("selector", "#fixture", "visible").ok, false);
    assert.equal(checkWaitForInPage("selector", "#fixture", "hidden").ok, true);
    style = { display: "block", visibility: "hidden" };
    assert.equal(checkWaitForInPage("selector", "#fixture", "visible").ok, false);
    matches = [element, { style: { display: "block", visibility: "visible" }, getBoundingClientRect: element.getBoundingClientRect }];
    assert.equal(checkWaitForInPage("selector", ".collection", "hidden").ok, false,
      "a hidden first match must not hide a visible second match");
    assert.equal(checkWaitForInPage("selector", ".collection", "visible").ok, true);
    invalid = true;
    assert.match(checkWaitForInPage("selector", "[", "hidden").fatal, /invalid/);
    invalid = false;
    matches = [new Input()];
    const field = checkWaitForInPage("field_value", { selector: "#private-field", value: "expected-private-value" });
    assert.equal(field.observation.valueMatches, false);
    assert.doesNotMatch(JSON.stringify(field), /expected-private|observed-private|private-field/);
    const promised = checkWaitForInPage("predicate", "Promise.resolve(false)");
    assert.equal(promised.ok, true, "Promise truthiness must remain synchronous");
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
  console.log("  ✓ selector collections/states, invalid selectors, field privacy and synchronous predicates are covered");
} finally {
  delete globalThis.waitFixture;
  stopWatchdog();
}
