// Real sockets and the actual offscreen entrypoint exercise callback ownership.
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { respondToPanelRequest } from "../dist/server-panel-channel.mjs";
import { closeSockets } from "./helpers/socket-fixture.mjs";
import { watchdog } from "./watchdog.mjs";

const sockets = new Set(), peers = [], delayedCloses = [], statuses = [], intervals = [];
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
server.on("connection", socket => {
  sockets.add(socket);
  const peer = { socket, frames: [] };
  peers.push(peer);
  socket.on("message", data => peer.frames.push(JSON.parse(String(data))));
});
const endpoint = `ws://127.0.0.1:${server.address().port}`;
const originals = { WebSocket: globalThis.WebSocket, chrome: globalThis.chrome, setInterval: globalThis.setInterval };
let listener;

// Hold only close callback delivery. Frames and readyState are real; select the
// adverse event order deterministically instead of hoping for a timing race.
class DeferredCloseSocket extends WebSocket {
  static instances = [];
  closeHandler = null;
  constructor(...args) {
    super(...args);
    sockets.add(this);
    DeferredCloseSocket.instances.push(this);
    this.on("error", () => {});
    this.on("close", (code, reason) => delayedCloses.push({ socket: this, deliver: () => this.closeHandler?.({ code, reason }) }));
  }
  get onclose() { return this.closeHandler; }
  set onclose(handler) { this.closeHandler = handler; }
}

async function until(predicate, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const sender = { id: "panel-test", url: "chrome-extension://panel-test/sidepanel.html" };
function request(command, origin = sender) {
  let settled = false, replies = 0, resolve;
  const promise = new Promise(done => { resolve = done; });
  const retained = listener({ type: "panel-command", command }, origin, reply => { settled = true; replies++; resolve(reply); });
  return { promise, retained, get settled() { return settled; }, get replies() { return replies; } };
}
function deliverClose(socket) {
  const index = delayedCloses.findIndex(entry => entry.socket === socket);
  assert.ok(index >= 0, "actual close must precede callback delivery");
  delayedCloses.splice(index, 1)[0].deliver();
}
const frames = peer => peer.frames.filter(frame => frame.type === "panel-request");
const start = { action: "start", sessionId: "aaaaaaaaaaaaaaaa", name: "owned-start", tabId: 1, parameters: {} };
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const timer of intervals) clearInterval(timer);
    await closeSockets(sockets);
    await new Promise(resolve => server.close(resolve));
    Object.assign(globalThis, originals);
  })();
}
const stopWatchdog = watchdog(cleanup);
try {
  globalThis.WebSocket = DeferredCloseSocket;
  globalThis.chrome = new Proxy({ runtime: {
    id: sender.id, getURL: path => `chrome-extension://panel-test/${path}`,
    onMessage: { addListener: callback => { listener = callback; } },
    async sendMessage(message) {
      if (message.type === "get-config") return { url: endpoint, token: "" };
      if (message.type === "set-status") { statuses.push(message.status); return; }
      throw new Error(`Unexpected runtime route: ${message.type}`);
    },
  } }, { get(target, key) {
    assert.equal(key, "runtime", "offscreen must use chrome.runtime only");
    return target[key];
  } });
  globalThis.setInterval = (...args) => { const timer = originals.setInterval(...args); intervals.push(timer); return timer; };
  await import("../dist/offscreen.mjs");
  globalThis.setInterval = originals.setInterval;
  await until(() => statuses.at(-1) === "connected", "A open");
  const a = DeferredCloseSocket.instances[0], old = request(start);
  await until(() => frames(peers[0]).length === 1, "A request sent");
  assert.equal(listener({ type: "reconnect" }, sender, reply => assert.equal(reply.ok, true)), true);
  await until(() => peers.length === 2 && statuses.at(-1) === "connected" && delayedCloses.some(entry => entry.socket === a), "B opens before A close callback");
  const b = DeferredCloseSocket.instances[1], current = request(start);
  await until(() => frames(peers[1]).length === 1, "B pending");
  const bId = frames(peers[1])[0].id;
  a.onmessage({ data: JSON.stringify({ type: "panel-response", id: bId, ok: true, result: "foreign" }) });
  assert.equal(current.settled, false, "A cannot settle B's ID");
  const before = [...statuses], timeout = globalThis.setTimeout, scheduled = [];
  try {
    globalThis.setTimeout = (...args) => { scheduled.push(args[1]); return timeout(...args); };
    deliverClose(a);
  } finally { globalThis.setTimeout = timeout; }
  assert.deepEqual(scheduled, [], "late A close cannot schedule a reconnect");
  assert.deepEqual(statuses, before, "late A close cannot alter B status");
  assert.match((await old.promise).error, /Kontrollera körstatus/);
  assert.equal(current.settled, false, "B stays pending after A close");
  peers[1].socket.send(JSON.stringify({ type: "panel-response", id: bId, ok: true, result: "B-owned" }));
  assert.deepEqual(await current.promise, { ok: true, result: "B-owned" });
  assert.equal(frames(peers[0]).length, 1);
  assert.equal(frames(peers[1]).length, 1, "replacement never replays A's start");

  const untrusted = request({ action: "sessions" }, { ...sender, url: "https://foreign.example/" });
  assert.equal(untrusted.retained, false);
  assert.match((await untrusted.promise).error, /Untrusted/);
  assert.equal((await request({ action: "invalid" }).promise).ok, false);
  assert.equal(frames(peers[1]).length, 1, "rejected commands never dispatch");
  const batch = Array.from({ length: 16 }, () => request({ action: "sessions" }));
  assert.match((await request({ action: "sessions" }).promise).error, /Panelen arbetar/);
  await until(() => frames(peers[1]).length === 17, "sixteen pending slots");
  for (const frame of frames(peers[1]).slice(1)) peers[1].socket.send(JSON.stringify({ type: "panel-response", id: frame.id, ok: true, result: frame.id }));
  assert.ok((await Promise.all(batch.map(entry => entry.promise))).every(reply => reply.ok));

  const begun = Date.now(), timed = request(start);
  await until(() => frames(peers[1]).length === 18, "timeout request sent once");
  assert.match((await timed.promise).error, /En start kan redan ha körts/);
  assert.ok(Date.now() - begun >= 11_900, "10s + 2s deadline retained");
  peers[1].socket.send(JSON.stringify({ type: "panel-response", id: frames(peers[1]).at(-1).id, ok: true, result: "late" }));
  const disconnected = request(start);
  await until(() => frames(peers[1]).length === 19, "request before disconnect");
  peers[1].socket.close();
  await until(() => delayedCloses.some(entry => entry.socket === b), "B actual close");
  assert.match((await request({ action: "sessions" }).promise).error, /Ingen anslutning/);
  deliverClose(b);
  assert.match((await disconnected.promise).error, /Kontrollera körstatus/);
  await until(() => peers.length === 3 && statuses.at(-1) === "connected", "normal reconnect C");
  assert.equal(frames(peers[2]).length, 0, "timed out/disconnected starts never replay");
  assert.equal(timed.replies, 1, "late response cannot settle twice");

  // A server handler awaiting on a closed origin must not reply on its successor.
  const originA = peers[2].socket, receiverA = DeferredCloseSocket.instances[2];
  let finish;
  respondToPanelRequest("held", { action: "sessions" }, originA, () => new Promise(resolve => { finish = resolve; }));
  const closedA = once(originA, "close");
  receiverA.close();
  await closedA;
  const replacement = new WebSocket(endpoint), received = [];
  sockets.add(replacement);
  replacement.on("message", data => received.push(JSON.parse(String(data))));
  await once(replacement, "open");
  const originB = peers.at(-1).socket;
  finish("old result");
  respondToPanelRequest("new", { action: "sessions" }, originB, async command => command.action);
  await until(() => received.length === 1, "new origin reply");
  assert.deepEqual(received, [{ type: "panel-response", id: "new", ok: true, result: "sessions" }]);
  for (const [id, value, handler, error] of [
    ["unsupported", { action: "sessions" }, undefined, /Restart the MCP server/],
    ["invalid", { action: "invalid" }, async () => { throw new Error("must not run"); }, /Invalid discriminator/],
    ["large", { action: "sessions" }, async () => "x".repeat(3 * 1024 * 1024), /too large/],
    ["failure", { action: "sessions" }, async () => { throw new Error("owned failure"); }, /owned failure/],
  ]) {
    const count = received.length;
    respondToPanelRequest(id, value, originB, handler);
    await until(() => received.length > count, id);
    assert.equal(received.at(-1).id, id);
    assert.equal(received.at(-1).ok, false);
    assert.match(received.at(-1).error, error);
  }
  console.log("panel-channel-lifecycle: real offscreen callbacks, stale close/response, origin await, 16-slot cap, 12s timeout, no replay, sender/command/response bounds PASS");
} finally {
  await cleanup();
  stopWatchdog();
}
