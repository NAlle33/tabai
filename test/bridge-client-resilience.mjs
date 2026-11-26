// @ts-check
// Real client-hop sockets: token refresh, rejected upgrades, a TCP peer that
// never completes the WebSocket handshake, and calls that wait for the broker to
// acknowledge the hello. Children own no production ports: every client gets its
// own extension port too, so a broker it spawns can never reach the user's.
import { trackedSocket, closeSockets, stopChild, ownChild, stopChildren } from "./helpers/socket-fixture.mjs";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { watchdog } from "./watchdog.mjs";
import { killPort } from "./kill-port.mjs";
import { allocatePorts } from "./free-port.mjs";
import { serializeToolResponse } from "./protocol-fixtures.mjs";
import { PROTOCOL_VERSION } from "../dist/protocol.mjs";

const wait = ms => new Promise(r => setTimeout(r, ms));
let child;
let wss;
let tcp;
let fake;
let foreign;
const sockets = new Set();
const children = new Set();
const clientPorts = new Set();
const stopWatchdog = watchdog(cleanup);

// Clients, and any broker one of them spawns, keep their token lookup, logs and
// stores inside a temporary home.
const home = mkdtempSync(join(tmpdir(), "tabai-bridge-client-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, CCMCP_LOG_DIR: join(home, "logs"), CCMCP_CONFIG_DIR: join(home, "config") });
const [EXT_PORT] = await allocatePorts(1);
const childEnv = (clientPort, extra = {}) => {
  clientPorts.add(String(clientPort));
  return { ...process.env, CCMCP_PORT: EXT_PORT, CCMCP_CLIENT_PORT: String(clientPort), ...extra };
};

async function cleanup() {
  // Stop the client before releasing its test listener; otherwise its next
  // reconnect can elect an orphan broker on the now-free port.
  await stopChild(child);
  await stopChildren(children);
  await closeSockets(sockets);
  if (tcp) await new Promise(r => tcp.close(r));
  if (foreign) { foreign.closeAllConnections(); await new Promise(r => foreign.close(r)); }
  foreign = null;
  for (const server of [wss, fake]) {
    if (server) { for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); }
  }
  wss = fake = null;
  // Our own listeners are closed: whatever still listens on these ports is a
  // broker one of the clients spawned.
  for (const port of [EXT_PORT, ...clientPorts]) killPort(port);
  rmSync(home, { recursive: true, force: true });
}
const acknowledgement = () => JSON.stringify({ type: "broker-status", buildId: `sha256:${"0".repeat(64)}`, version: PROTOCOL_VERSION });
try {
  let rejected = 0;
  let accepted = 0;
  let projectName;
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: ({ req }, done) => {
    if (new URL(req.url, "http://localhost").searchParams.get("token") !== "updated-test-token") {
      rejected++; done(false, 401); return;
    }
    done(true);
  } });
  await once(wss, "listening");
  wss.on("connection", ws => {
    accepted++;
    ws.on("message", d => {
      const msg = JSON.parse(d.toString());
      // Like the real broker, acknowledge an accepted hello.
      if (msg.role === 'client') { projectName = msg.sessionName; ws.send(acknowledgement()); }
      if (msg.id) ws.send(serializeToolResponse(msg.tool === "health"
        ? { id: msg.id, ok: false, error: { code: "TIMEOUT", message: "diagnostic fixture failure" } }
        : { id: msg.id, ok: true, result: "connected" }));
    });
  });
  const source = `import assert from 'node:assert/strict'; import { BridgeClient } from './dist/bridge-client.mjs';
    let token = 'old-test-token';
    const b = new BridgeClient(() => token);
    process.stdin.once('data', () => { token = 'updated-test-token'; });
    console.log(await b.call('test', {}, 10000));
    const inspection = b.call('health', {}, 10000, false);
    assert.equal(b.pendingCount, 1); assert.deepEqual(b.activity(), {calls:[]});
    await assert.rejects(inspection, /diagnostic fixture failure/);
    assert.deepEqual(b.activity(), {calls:[]});
    const action = b.call('test', {}, 10000);
    assert.equal(b.activity().calls.length, 1);
    await action; assert.equal(b.activity().calls.length, 0);
    console.log('observation activity passed');`;
  let stderr = "";
  let stdout = "";
  const wsAddress = wss.address();
  assert(wsAddress && typeof wsAddress !== "string");
  child = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: childEnv(wsAddress.port, { INIT_CWD: join(tmpdir(), 'Hej och Hå'), npm_lifecycle_event: 'start', npm_package_name: 'tabai' }),
    stdio: ["pipe", "pipe", "pipe"],
  }));
  child.stderr.on("data", d => stderr += d);
  child.stdout.on("data", d => stdout += d);
  for (let i = 0; i < 100 && rejected < 2; i++) await wait(25);
  assert(rejected >= 2, "rejected upgrades must reconnect");
  child.stdin.write("rotate\n");
  for (let i = 0; i < 200 && !stdout.includes("observation activity passed"); i++) await wait(25);
  assert(accepted >= 1 && stdout.includes("observation activity passed"), `next connect must refresh token and preserve activity semantics: ${stderr}`);
  assert.equal((stderr.match(/broker rejected the token/g) ?? []).length, 1);
  assert.equal(projectName, 'Hej och Hå', 'npm start must name the caller project, not the Tabai installation');
  await stopChild(child);
  projectName = undefined;
  child = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e",
    "import { BridgeClient } from './dist/bridge-client.mjs'; new BridgeClient(() => 'updated-test-token');"], {
    env: childEnv(wsAddress.port, { INIT_CWD: join(tmpdir(), 'Unrelated parent'), npm_lifecycle_event: 'test', npm_package_name: 'tabai' }),
    stdio: 'ignore',
  }));
  for (let i = 0; i < 100 && projectName === undefined; i++) await wait(25);
  assert.equal(projectName, basename(process.cwd()), 'direct Node launches must ignore an unrelated inherited npm directory');
  await stopChild(child);
  await new Promise(r => wss.close(r));
  wss = null;
  console.log("  ✓ token refreshed on reconnect; HTTP 401 warning emitted once");
  console.log("  ✓ diagnostic polling keeps transport accounting without appearing as user work or errors");

  // A call is written only once the broker has accepted the hello. One call is
  // queued before the socket opens; BridgeClient's own open listener sends the
  // hello first, so the second is made while the socket is open and before any
  // answer to the hello can have arrived.
  let behaviour = "reject";
  const received = [];
  // Time left until each written call's deadline, as the broker sees it on arrival.
  const remaining = [];
  fake = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(fake, "listening");
  fake.on("connection", ws => ws.on("message", data => {
    const msg = JSON.parse(data.toString());
    if (msg.role === "client") {
      if (behaviour === "reject") ws.close(4004, "protocol version mismatch");
      if (behaviour === "acknowledge") ws.send(acknowledgement());
      // "silent": a broker built before the acknowledgement existed sends nothing.
      return;
    }
    received.push(msg.tool);
    remaining.push(typeof msg.deadline === "number" ? msg.deadline - Date.now() : NaN);
    if (behaviour !== "reject") ws.send(serializeToolResponse({ id: msg.id, ok: true, result: msg.tool }));
  }));
  const fakeAddress = fake.address();
  assert(fakeAddress && typeof fakeAddress !== "string");
  const fakePort = fakeAddress.port;
  const twoCalls = timeoutMs => `import { BridgeClient } from './dist/bridge-client.mjs';
    const client = new BridgeClient(() => '');
    const report = (name, promise) => promise.then(
      () => process.send({ name, ok: true }),
      error => process.send({ name, ok: false, code: error.code, retryable: error.retryable }));
    report('queued', client.call('queued-before-open', {}, ${timeoutMs}));
    client.ws.once('open', () => report('direct', client.call('made-after-open', {}, ${timeoutMs})));`;
  async function runTwoCalls(mode, timeoutMs) {
    behaviour = mode;
    received.length = 0;
    remaining.length = 0;
    const results = new Map();
    child = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e", twoCalls(timeoutMs)], {
      env: childEnv(fakePort), stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
    child.on("message", message => results.set(message.name, message));
    for (let i = 0; i < 600 && results.size < 2; i++) await wait(25);
    await stopChild(child);
    return { queued: results.get("queued"), direct: results.get("direct"), received: [...received], remaining: [...remaining] };
  }

  const rejectedHello = await runTwoCalls("reject", 3000);
  assert.deepEqual(rejectedHello.received, [], "no call may be written to a broker that rejects the hello");
  for (const name of ["queued", "direct"]) {
    const result = rejectedHello[name];
    assert.ok(result && result.ok === false && result.code === "TIMEOUT" && result.retryable === true,
      `the ${name} call never reached the broker, so its timeout must stay retryable: ${JSON.stringify(result)}`);
  }
  console.log("  ✓ a hello rejected with 4004 leaves queued and direct calls unsent and retryable");

  const acknowledged = await runTwoCalls("acknowledge", 10000);
  assert.ok(acknowledged.queued?.ok && acknowledged.direct?.ok, JSON.stringify(acknowledged));
  assert.deepEqual([...acknowledged.received].sort(), ["made-after-open", "queued-before-open"], "after the acknowledgement each call is written once");
  console.log("  ✓ after the broker's acknowledgement each call is written exactly once");
  assert.ok(acknowledged.remaining.length === 2 && acknowledged.remaining.every(left => left > 0 && left <= 10000),
    `each call carries the absolute deadline at which its client gives up: ${JSON.stringify(acknowledged.remaining)}`);
  console.log("  ✓ each written call carries its client's deadline");

  const legacy = await runTwoCalls("silent", 10000);
  assert.ok(legacy.queued?.ok && legacy.direct?.ok, JSON.stringify(legacy));
  assert.deepEqual([...legacy.received].sort(), ["made-after-open", "queued-before-open"], "a broker that never acknowledges gets each call once after the grace");
  console.log("  ✓ a broker that sends no acknowledgement receives the calls after the grace");
  await new Promise(r => fake.close(r));
  fake = null;

  // Another program answering HTTP on the client port is not a broker: the client
  // says so once and starts no broker, which could only lose the election. Its
  // spawn is replaced before the client loads, so no real broker can start here.
  let foreignUpgrades = 0;
  const refuse = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
  foreign = createHttpServer((_req, res) => { res.writeHead(404); res.end(); });
  foreign.on("upgrade", (_req, socket) => { foreignUpgrades++; trackedSocket(sockets, socket); socket.on("error", () => {}); socket.end(refuse); });
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  const foreignAddress = foreign.address();
  assert(foreignAddress && typeof foreignAddress !== "string");
  let foreignStderr = "";
  let foreignStdout = "";
  child = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.spawn = () => { console.log('broker spawn'); return Object.assign(new EventEmitter(), { unref() {} }); };
    syncBuiltinESMExports();
    const { BridgeClient } = await import('./dist/bridge-client.mjs');
    new BridgeClient(() => '');`], {
    env: childEnv(foreignAddress.port), stdio: ["ignore", "pipe", "pipe"],
  }));
  child.stdout.on("data", d => foreignStdout += d);
  child.stderr.on("data", d => foreignStderr += d);
  for (let i = 0; i < 320 && foreignUpgrades < 3; i++) await wait(25);
  await stopChild(child);
  assert(foreignUpgrades >= 3, `the client must keep reconnecting to the port: ${foreignUpgrades} upgrades`);
  assert.equal((foreignStderr.match(/is not the broker/g) ?? []).length, 1, `one warning that the port is held by another program: ${foreignStderr}`);
  assert.match(foreignStderr, /npm run doctor/);
  assert.doesNotMatch(foreignStdout, /broker spawn/, "an HTTP answer on the client port must not start a broker");
  await new Promise(r => foreign.close(r));
  foreign = null;
  console.log("  ✓ another program answering HTTP 404 on the client port is reported once and starts no broker");

  let connections = 0;
  tcp = createServer(socket => {
    connections++; trackedSocket(sockets, socket);
    socket.on("error", () => {});
  });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const tcpAddress = tcp.address();
  assert(tcpAddress && typeof tcpAddress !== "string");
  child = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e", `import { BridgeClient } from './dist/bridge-client.mjs'; new BridgeClient(() => '');`], {
    env: childEnv(tcpAddress.port), stdio: "ignore",
  }));
  for (let i = 0; i < 320 && connections < 2; i++) await wait(25);
  assert(connections >= 2, "TCP-only peer must not wedge connecting past handshakeTimeout");
  assert.equal(child.exitCode, null, "client survives failed broker election");
  console.log("  ✓ TCP-only listener times out and client reconnects");
} finally {
  await cleanup();
}
console.log("=== bridge-client-resilience: PASS ===");
stopWatchdog();
