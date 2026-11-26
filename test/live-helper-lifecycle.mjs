// Real sockets/processes prove helper correlation, failure settlement and cleanup.
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";
import { createMcpClient, createMcpTransport, connectMcpClient } from "./helpers/mcp-client.mjs";
import { allocatePorts } from "./free-port.mjs";
import { watchdog } from "./watchdog.mjs";

const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(server, "listening");
const observers = [];
const stopWatchdog = watchdog(() => {
  for (const observer of observers) observer.socket.terminate();
  for (const peer of server.clients) peer.terminate();
  server.close();
});
server.on("connection", peer => peer.on("message", data => {
  const request = JSON.parse(data.toString());
  if (request.method === "silent") return;
  if (request.method === "close") { peer.close(); return; }
  if (request.method === "invalid") { peer.send("{invalid JSON"); return; }
  if (request.method === "error") { peer.send(JSON.stringify({ id: request.id, error: { message: "actual protocol refusal" } })); return; }
  peer.send(JSON.stringify({ method: "Target.targetCreated", params: { targetId: "observed" } }));
  peer.send(JSON.stringify({ id: request.id + 1000, result: { wrong: true } }));
  peer.send(JSON.stringify({ id: request.id, result: { method: request.method, sessionId: request.sessionId } }));
}));
const endpoint = `ws://127.0.0.1:${server.address().port}`;
const events = [];
let failedTransport;
async function open() {
  const observer = await openCdpObserver(endpoint, { timeoutMs: 1000, handshakeTimeout: 1000,
    timeoutMessage: method => `${method} deadline`, closedMessage: "owned observer closed", onEvent: event => events.push(event) });
  observers.push(observer);
  return observer;
}
try {
  const observer = await open();
  assert.deepEqual(await observer.rpc("echo", {}, "own-target"), { method: "echo", sessionId: "own-target" });
  assert.equal(events[0].method, "Target.targetCreated");
  assert.equal(observer.pendingCount, 0);
  await assert.rejects(observer.rpc("error"), /actual protocol refusal/);
  await assert.rejects(observer.rpc("silent", {}, undefined, 25), /silent deadline/);
  assert.equal(observer.pendingCount, 0);
  const closing = await Promise.allSettled([observer.rpc("close"), observer.rpc("silent")]);
  assert.ok(closing.every(result => result.status === "rejected" && /owned observer closed/.test(result.reason.message)));
  assert.equal(observer.pendingCount, 0);

  const invalid = await open();
  const closed = once(invalid.socket, "close");
  await assert.rejects(invalid.rpc("invalid"), SyntaxError);
  await closed;
  assert.equal(invalid.pendingCount, 0);
  const [unusedPort] = await allocatePorts(1);
  await assert.rejects(openCdpObserver(`ws://127.0.0.1:${unusedPort}`, { timeoutMs: 1000, handshakeTimeout: 1000, timeoutMessage: () => "unexpected timeout" }), /ECONNREFUSED/);

  const client = createMcpClient({ name: "failed-setup", version: "1.0.0" });
  failedTransport = createMcpTransport({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
  // An already-started transport makes SDK setup fail before its initialize
  // cleanup path. The owned child stays alive until our helper closes it.
  await failedTransport.start();
  const childPid = failedTransport.pid;
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  process.kill(childPid, 0);
  await assert.rejects(connectMcpClient(client, failedTransport), /already started/i);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  console.log("live-helper-lifecycle: correlation/events, protocol error, timeout, close, invalid JSON, socket/setup failure and owned cleanup PASS");
} finally {
  await failedTransport?.close();
  for (const observer of observers) observer.socket.terminate();
  for (const peer of server.clients) peer.terminate();
  await new Promise(resolve => server.close(resolve));
  stopWatchdog();
}
