import assert from "node:assert/strict";
import { LoopGuard } from "../dist/loop-guard.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const args = { tabId: 7, action: "left_click", ref: "ref_1" };
const page = (elements = "[ref_1] button Continue", documentId = "document-a") => ({ ok: true, compact: true, filter: "all", truncated: false, elements, frames: [{ frameId: 0, documentId }], scrollPositions: [{ frameId: 0, x: 0, y: 0, elements: [] }] });
const guard = new LoopGuard();
let calls = 0;
const dispatch = async () => { calls++; return { ok: true }; };
const run = (owner = guard, options = args, inspect = async () => page()) => owner.run("computer", options, dispatch, inspect);
for (let i = 0; i < 3; i++) await run();
await assert.rejects(run(), error => error.code === "LOOP_DETECTED" && error.retryable === false);
assert.equal(calls, 3, "the fourth mutation is stopped before its dispatch");
const pause = guard.snapshot()[0]; assert.equal(pause.repetitions, 3);
await assert.rejects(run(guard, { ...args, ref: "ref_2" }), /NOT dispatched/);
for (let i = 0; i < 10; i++) await guard.run("read_page", { tabId: 7 }, dispatch, async () => { throw new Error("reads must not probe"); });
assert.equal(guard.continue(7, "stale"), false);
await assert.rejects(guard.run("navigate", { tabId: 7 }, async () => { throw new Error("navigation failed"); }, async () => page()), /navigation failed/);
assert.equal(guard.snapshot()[0].pauseId, pause.pauseId, "a failed navigation cannot erase a pause");
assert.equal(guard.continue(8, pause.pauseId), false);
assert.equal(guard.continue(7, pause.pauseId), true);
assert.equal(calls, 13, "continuation never dispatches or replays an action");
await run();
assert.equal(calls, 14);
for (const inspect of [async () => ({ ok: true }), async () => ({ ...page(), truncated: true }), async () => { throw new Error("no observation"); }]) {
  const owner = new LoopGuard();
  for (let i = 0; i < 6; i++) await run(owner, args, inspect);
  assert.deepEqual(owner.snapshot(), [], "incomplete observations cannot prove stagnation");
}
for (const change of [i => page(String(i)), i => page("same", `document-${i}`)]) {
  const owner = new LoopGuard();
  for (let i = 0; i < 6; i++) await run(owner, args, async () => change(i));
  assert.deepEqual(owner.snapshot(), [], "page/document progress resets the streak");
}
const failed = new LoopGuard();
for (let i = 0; i < 6; i++) await assert.rejects(failed.run("computer", args, async () => { throw new Error("uncertain result"); }, async () => page()), /uncertain/);
assert.deepEqual(failed.snapshot(), [], "uncertain dispatches are neither counted nor retried");
const reportedFailure = new LoopGuard();
for (let i = 0; i < 6; i++) await reportedFailure.run("computer", args, async () => ({ ok: false }), async () => page());
assert.deepEqual(reportedFailure.snapshot(), [], "reported failures are not counted as successful mutations");
const independent = new LoopGuard();
await run(independent); await run(independent); await run(independent);
await run(independent, { ...args, tabId: 8 });
await assert.rejects(run(independent), /LOOP_DETECTED/);
await run(new LoopGuard());
const concurrent = new LoopGuard();
let release; const held = new Promise(resolve => { release = resolve; });
const first = concurrent.run("computer", args, async () => { await held; return {}; }, async () => page());
await run(concurrent); release(); await first;
for (let i = 0; i < 3; i++) await run(concurrent);
assert.deepEqual(concurrent.snapshot(), [], "concurrent mutations invalidate evidence rather than establish ordering");
const threshold = new LoopGuard();
for (let i = 0; i < 3; i++) await run(threshold);
let releaseInspection, reachedInspection;
const inspectHeld = new Promise(resolve => { releaseInspection = resolve; });
const inspectReached = new Promise(resolve => { reachedInspection = resolve; });
const thresholdRun = run(threshold, args, async () => { reachedInspection(); await inspectHeld; return page(); });
await inspectReached;
await run(threshold); releaseInspection(); await thresholdRun;
assert.deepEqual(threshold.snapshot(), [], "concurrency during the threshold probe invalidates the pause decision");
for (const action of ["scroll_to", "left_click_drag"]) {
  const owner = new LoopGuard();
  for (let i = 0; i < 3; i++) await run(owner, { ...args, action });
  await assert.rejects(run(owner, { ...args, action }), /LOOP_DETECTED/);
}
for (const nested of [false, true]) {
  const owner = new LoopGuard();
  for (let i = 0; i < 6; i++) await run(owner, { ...args, action: "scroll" }, async () => ({ ...page(),
    scrollPositions: [{ frameId: 0, x: 0, y: nested ? 0 : i * 100, elements: nested ? [[12, 0, i * 100]] : [] }] }));
  assert.deepEqual(owner.snapshot(), [], "root and nested scrolling are observed progress");
}
const bounded = new LoopGuard();
for (let tabId = 0; tabId < 32; tabId++) {
  for (let i = 0; i < 4; i++) await run(bounded, { ...args, tabId }).catch(error => { assert.equal(error.code, "LOOP_DETECTED"); });
}
assert.equal(bounded.snapshot().length, 32, "paused tabs have a fixed memory ceiling");
const beforeCapacity = calls;
await assert.rejects(run(bounded, { ...args, tabId: 33 }), error => error.code === "LOOP_GUARD_CAPACITY" && !error.retryable);
assert.equal(calls, beforeCapacity, "capacity cannot silently disable protection for another tab");
assert.equal(bounded.continue(0, bounded.snapshot()[0].pauseId), true);
await run(bounded, { ...args, tabId: 33 });
stopWatchdog();
console.log("Loop guard: pre-dispatch pause, reads, explicit continuation, progress, incomplete evidence, uncertainty, isolation, concurrency and capacity passed");
