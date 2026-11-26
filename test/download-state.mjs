// Real download-state transitions with Chrome's session storage/events supplied
// by a deterministic adapter. A fresh module instance simulates worker restart.
import assert from "node:assert/strict";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const created = [];
const changed = [];
let stored = {};
let rejectWrite = false;
globalThis.chrome = {
  storage: { session: {
    get: async () => structuredClone(stored),
    set: async value => { if (rejectWrite) throw new Error("quota"); stored = structuredClone(value); },
  } },
  downloads: {
    onCreated: { addListener: fn => created.push(fn) },
    onChanged: { addListener: fn => changed.push(fn) },
    search: async ({ id }) => [{ id, filename: `/fixture/download-${id}.txt`, fileSize: 2 }],
  },
};
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
const event = async (listeners, value) => { for (const fn of listeners) fn(value); await turn(); };
let api = await import("../dist/download-state.mjs");
const state = { lock: null, sessions: {} };
assert.equal(api.armDecision(state, "a", 0), "grant");
state.lock = { sid: "a", armedAt: 0 };
assert.equal(api.armDecision(state, "b", api.DOWNLOAD_ARM_TTL_MS - 1), "busy");
assert.equal(api.armDecision(state, "b", api.DOWNLOAD_ARM_TTL_MS), "takeover");
console.log("  ✓ grant/busy/takeover obey the arm TTL");

assert.equal((await api.armDownload("a")).ok, true);
assert.equal((await api.armDownload("b")).ok, false);
const waiting = api.collectDownload("a", 1000);
await turn();
const beforeRefresh = stored.dl.lock.armedAt;
assert(beforeRefresh > 0);
const clock = Date.now;
Date.now = () => beforeRefresh + api.DOWNLOAD_ARM_TTL_MS;
try { assert.equal((await api.armDownload("b")).ok, true); } finally { Date.now = clock; }
assert.equal((await waiting).state, "preempted");
assert.equal(stored.dl.sessions.a, undefined);
assert.equal(stored.dl.lock.sid, "b");
console.log("  ✓ takeover clears stale ownership and resolves its waiter");

for (const id of [1, 2]) for (const fn of created) fn({ id });
await turn();
assert.equal(stored.dl.sessions.b.captureId, 1);
await event(changed, { id: 2, state: { current: "complete" } });
assert.equal(stored.dl.sessions.b.done, null);
await event(changed, { id: 1, state: { current: "complete" } });
assert.equal(stored.dl.sessions.b.done.path, "/fixture/download-1.txt");
console.log("  ✓ simultaneous download events attribute only the first to the lock owner");

created.length = 0; changed.length = 0;
api = await import("../dist/download-state.mjs?worker-restart");
assert.equal((await api.collectDownload("b", 10)).path, "/fixture/download-1.txt");
assert.equal((await api.collectDownload("b", 10)).state, "timeout");
console.log("  ✓ completed state survives worker restart and is consumed once");

await api.armDownload("a");
created.length = 0; changed.length = 0;
api = await import("../dist/download-state.mjs?armed-restart");
await event(created, { id: 3 });
await event(changed, { id: 3, state: { current: "complete" } });
assert.equal((await api.collectDownload("a", 10)).path, "/fixture/download-3.txt");
console.log("  ✓ an arm survives worker restart before the download begins");

rejectWrite = true;
assert.deepEqual(await api.armDownload("a"), { ok: false, armed: false, error: "could not persist the download arm" });
assert.equal(stored.dl.lock, null);
rejectWrite = false;
assert.equal((await api.armDownload("a")).ok, true);
console.log("  ✓ failed persistence cannot grant an arm or poison subsequent writes");

const collect = api.collectDownload("a", 500);
await turn();
await event(created, { id: 4 });
await event(changed, { id: 4, state: { current: "complete" } });
assert.equal((await collect).state, "completed");
assert.equal((await api.collectDownload("a", 10)).state, "timeout");
console.log("  ✓ an active collect consumes completion once");

await api.armDownload("a");
assert.equal((await api.collectDownload("b", 10)).state, "timeout");
assert.equal(stored.dl.lock.sid, "a");
await api.reapDownloadState("a");
assert.equal(stored.dl.lock, null);
assert.equal(stored.dl.sessions.a, undefined);
console.log("  ✓ another session's collect cannot release the arm; reap removes it");

// A collect that ends while the captured download is still running keeps the
// capture: the agent is told to collect again, never to trigger a duplicate.
await api.armDownload("a");
await event(created, { id: 5 });
const running = await api.collectDownload("a", 20);
assert.equal(running.state, "in_progress");
assert.match(running.note, /collect again/i);
assert.match(running.note, /do not trigger/i);
assert.equal(stored.dl.lock.sid, "a");
assert.equal(stored.dl.sessions.a.captureId, 5);
await event(changed, { id: 5, state: { current: "complete" } });
assert.equal((await api.collectDownload("a", 10)).path, "/fixture/download-5.txt");
assert.equal(stored.dl.lock, null);
console.log("  ✓ a collect that times out mid-download keeps the capture for the next collect");

// The in-progress lifetime runs from the download's start; repeated collects
// cannot extend it, so a stuck download releases the shared arm on time.
await api.armDownload("a");
await event(created, { id: 6 });
const started = stored.dl.lock.armedAt;
const realNow = Date.now;
try {
  Date.now = () => started + api.DOWNLOAD_ARM_TTL_MS - 1000;
  assert.equal((await api.collectDownload("a", 10)).state, "in_progress");
  Date.now = () => started + api.DOWNLOAD_ARM_TTL_MS - 1;
  assert.equal((await api.collectDownload("a", 10)).state, "in_progress");
  assert.equal((await api.armDownload("b")).ok, false, "a live in-progress capture keeps the arm");
  Date.now = () => started + api.DOWNLOAD_ARM_TTL_MS;
  assert.equal((await api.armDownload("b")).ok, true, "collect calls did not extend the capture's lifetime");
} finally { Date.now = realNow; }
await event(changed, { id: 6, state: { current: "complete" } });
assert.equal(stored.dl.sessions.a, undefined, "the expired capture cannot claim a late completion");
await api.reapDownloadState("b");
console.log("  ✓ an in-progress capture expires on its own lifetime even when collect keeps being called");

// A capture that expires while its download may still run must not advise
// arming and triggering again: that would start a second download.
await api.armDownload("a");
await event(created, { id: 7 });
const begun = stored.dl.lock.armedAt;
const clockBeforeExpiry = Date.now;
try {
  Date.now = () => begun + api.DOWNLOAD_ARM_TTL_MS;
  const expired = await api.collectDownload("a", 10);
  assert.equal(expired.state, "timeout");
  assert.match(expired.note, /download started/i);
  assert.match(expired.note, /did not finish within the capture's lifetime/i);
  assert.match(expired.note, /may still be running/i);
  assert.match(expired.note, /do not trigger it again without checking/i);
  assert.doesNotMatch(expired.note, /arm BEFORE/i);
} finally { Date.now = clockBeforeExpiry; }
assert.equal(stored.dl.lock, null, "the expired capture is cleared");
assert.equal(stored.dl.sessions.a, undefined);
console.log("  ✓ an expired capture whose download started says it may still be running instead of advising a new trigger");

// Arming again while this session's download runs changes nothing: the running
// capture and its lifetime are kept, and collect returns its file. The reply is
// armed:false, because the catalog tells the caller to trigger only on armed:true.
await api.armDownload("a");
await event(created, { id: 8 });
const running8 = structuredClone(stored.dl);
const again = await api.armDownload("a");
assert.equal(again.ok, true);
assert.equal(again.armed, false, "a second arm during a running download must not invite a second trigger");
assert.match(again.note, /already in progress/i);
assert.match(again.note, /collect/i);
assert.deepEqual(stored.dl, running8, "arming again changes nothing while the download runs");
await event(changed, { id: 8, state: { current: "complete" } });
assert.equal((await api.collectDownload("a", 10)).path, "/fixture/download-8.txt");
assert.equal(stored.dl.lock, null);
console.log("  ✓ arming again during a running download keeps it, answers armed:false, and collect returns its file");

// Arming again after this session's download finished but before it was
// collected keeps the result: replacing it would make the next collect advise
// arming and triggering again, which downloads the file twice.
await api.armDownload("a");
await event(created, { id: 9 });
await event(changed, { id: 9, state: { current: "complete" } });
const finished9 = structuredClone(stored.dl);
assert.equal(finished9.sessions.a.done.path, "/fixture/download-9.txt");
const afterFinish = await api.armDownload("a");
assert.equal(afterFinish.ok, true);
assert.equal(afterFinish.armed, false, "an arm that would discard a finished download is not granted");
assert.match(afterFinish.note, /finished/i);
assert.match(afterFinish.note, /collect/i);
assert.match(afterFinish.note, /download-9\.txt/, "the note names the file that is waiting");
assert.deepEqual(stored.dl, finished9, "arming again changes nothing after the download finished");
assert.equal((await api.collectDownload("a", 10)).path, "/fixture/download-9.txt");
assert.equal(stored.dl.sessions.a, undefined);
console.log("  ✓ arming again after the download finished keeps its result for collect");

// A finished result that nobody collected for an arm's lifetime no longer refuses
// a new arm: the session could otherwise never capture a download again.
await api.armDownload("a");
await event(created, { id: 10 });
await event(changed, { id: 10, state: { current: "complete" } });
assert.equal(stored.dl.sessions.a.done.path, "/fixture/download-10.txt");
stored.dl.sessions.a.doneAt -= api.DOWNLOAD_ARM_TTL_MS;
assert.deepEqual(await api.armDownload("a"), { ok: true, armed: true }, "a result left uncollected for an arm's lifetime gives way to a new arm");
assert.equal(stored.dl.sessions.a.done, null);
await event(created, { id: 11 });
await event(changed, { id: 11, state: { current: "complete" } });
assert.equal((await api.collectDownload("a", 10)).path, "/fixture/download-11.txt");
assert.equal(stored.dl.sessions.a, undefined);
console.log("  ✓ a finished result left uncollected for an arm's lifetime gives way to a new arm");

// A collect asking for more than the worker's request budget still waits at most
// 270 s: Chrome ends a single worker request after five minutes. The long timer
// is fired at once here; its requested delay is what the worker scheduled.
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...rest) => {
  if (delay > 60_000) { scheduled.push(delay); delay = 0; }
  return realSetTimeout(callback, delay, ...rest);
};
let clamped;
try { clamped = await api.collectDownload("a", 999_999); } finally { globalThis.setTimeout = realSetTimeout; }
assert.deepEqual(scheduled, [270_000], "the collect timer is clamped to 270 000 ms");
assert.equal(clamped.state, "timeout");
assert.match(clamped.note, /within 270000ms/);
console.log("  ✓ a collect above 270 s is clamped to a 270 000 ms timer");
console.log("=== download-state: PASS ===");
stopWatchdog();
