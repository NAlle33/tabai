import assert from "node:assert/strict";
import { PanelRouter } from "../dist/panel-router.mjs";
import { watchdog } from "./watchdog.mjs";
const stopWatchdog = watchdog();
const router = new PanelRouter(), sentA = [], sentB = [], replies = [];
const a = { sessionId: "aaaaaaaaaaaaaaaa", sessionName: "Hej och Hå", panelVersion: 1, serverVersion: "0.12.0", send: value => sentA.push(value) };
const b = { sessionId: "bbbbbbbbbbbbbbbb", panelVersion: 1, serverVersion: "0.12.0", send: value => sentB.push(value) };
const old = { sessionId: "cccccccccccccccc", send: () => { throw new Error("Old client must never receive reverse requests"); } };
router.add(a); router.add(b); router.add(old);
const request = command => router.request({ id: "ui-request", command }, reply => replies.push(reply));
request({ action: "sessions" });
const sessions = replies.pop().result;
assert.deepEqual(sessions.map(s => s.supported), [true, true, false]);
assert.equal(sessions[0].sessionName, 'Hej och Hå');
assert.equal(sessions[2].sessionName, undefined);
request({ action: "snapshot", sessionId: a.sessionId });
assert.equal(sentA.length, 1); assert.equal(sentB.length, 0);
router.respond(b, { id: sentA[0].id, ok: true, result: "forged" });
assert.equal(replies.length, 0, "a foreign socket cannot reply to another client's request");
router.respond(a, { id: sentA[0].id, ok: true, result: "owned" });
assert.equal(replies.pop().result, "owned");
router.respond(a, { id: sentA[0].id, ok: true, result: "duplicate" });
assert.equal(replies.length, 0);
request({ action: "snapshot", sessionId: old.sessionId }); assert.equal(replies.pop().ok, false);
for (const command of [
  { action: "arbitrary_tool", sessionId: a.sessionId },
  { action: "start", sessionId: a.sessionId, name: "x", tabId: 1, parameters: {}, __sessionId: b.sessionId },
  { action: "record", sessionId: a.sessionId, runId: "../../private" },
  { action: "start", sessionId: a.sessionId, name: "x", tabId: 1, parameters: { a: "x".repeat(600000) } },
]) { request(command); assert.equal(replies.pop().ok, false); }
assert.equal(sentA.length, 1, "malformed requests never dispatch");
request({ action: "start", sessionId: b.sessionId, name: "x", tabId: 1, parameters: {} });
assert.equal(sentB.length, 1);
router.remove(b); assert.match(replies.pop().error, /disconnected/);
router.add(b); assert.equal(sentB.length, 1, "reconnect never replays a start");
request({ action: "snapshot", sessionId: b.sessionId });
router.respond(b, { id: sentB[1].id, ok: true, result: "x".repeat(3 * 1024 * 1024) });
assert.match(replies.pop().error, /too large/);
router.add({ ...a }); request({ action: "snapshot", sessionId: a.sessionId });
assert.match(replies.pop().error, /ambiguous/);
stopWatchdog();
console.log("=== panel-router: capability, ownership, no replay, request validation and response bounds passed ===");
