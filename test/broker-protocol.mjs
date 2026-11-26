// @ts-check
// Chrome-free test for the broker's singleton election + client handshake guards.
// Covers the safety mechanisms otherwise only verified by inspection:
//   - singleton election: a 2nd broker loses the CLIENT_PORT bind race and exits
//     0 WITHOUT touching the extension port (no two-port split-brain);
//   - handshake rejects: a non-hello first frame -> close 4003; a version-skew
//     hello -> close 4004 (the stale-build guard);
//   - per-session in-flight cap: the (N+1)th concurrent call -> SESSION_BUSY.
//   - a call's deadline: never dispatched once passed, it bounds the broker's timer,
//     and a call still queued for a reconnecting extension is dropped at it;
//   - the client-port token: a missing or wrong token is refused with HTTP 401;
//   - a real BridgeClient survives a broker crash without replaying a sent call.
import { openSocket, waitOpen, closeSockets, stopChild, ownChild, stopChildren } from "./helpers/socket-fixture.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { killPort } from "./kill-port.mjs";
import { allocatePorts } from "./free-port.mjs";
import { clientWsUrl } from "../scripts/resolve-token.mjs";
import { PROTOCOL_VERSION } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";
import { serializeToolResponse } from "./protocol-fixtures.mjs";

const sockets = new Set();
const children = new Set();
let brokerA;
let brokerB;
let brokerC;
let crashClient;
const stopWatchdog = watchdog(cleanup);

async function cleanup() {
  // The client must stop reconnecting before any surviving broker is reaped.
  await stopChild(crashClient);
  await closeSockets(sockets);
  await stopChildren(children);
  for (const port of [CLIENT_PORT, EXT_PORT, TOKEN_CLIENT_PORT, TOKEN_EXT_PORT]) killPort(port);
  rmSync(home, { recursive: true, force: true });
}

// Every broker and client here resolves its token file, logs and stores inside a
// temporary home, never the user's installation.
const home = mkdtempSync(join(tmpdir(), "tabai-broker-protocol-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, CCMCP_LOG_DIR: join(home, "logs"), CCMCP_CONFIG_DIR: join(home, "config") });
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [EXT_PORT, CLIENT_PORT, TOKEN_EXT_PORT, TOKEN_CLIENT_PORT] = await allocatePorts(4);
const brokerPath = join(root, "dist", "broker.js");
// Token-aware URLs so the test still passes on a machine with the opt-in token
// configured (env or the 0600 file); else the broker refuses the upgrade (HTTP 401).
const CLIENT_URL = clientWsUrl(CLIENT_PORT);
const extToken = process.env.BRIDGE_TOKEN || "";
const EXT_URL = `ws://127.0.0.1:${EXT_PORT}${extToken ? `?token=${encodeURIComponent(extToken)}` : ""}`;
// The extension port admits only a chrome-extension:// Origin; the client port
// admits only Origin-LESS (Node) clients — so `opts` is passed per dial site.
const EXT = { headers: { Origin: "chrome-extension://ccmcp-test" } };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await wait(25);
  }
}



async function connectWs(url, opts, onMessage) {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = openSocket(sockets, url, opts);
      if (onMessage) ws.on("message", d => onMessage(ws, JSON.parse(d.toString())));
      await waitOpen(ws);
      return ws;
    } catch {
      await wait(200);
    }
  }
  throw new Error(`never connected: ${url}`);
}

// Open a raw client connection, send a first frame, resolve with the ws close
// code the broker replies with (the handshake-reject path), or null on timeout.
function expectClose(firstFrame) {
  return new Promise((resolve) => {
    const ws = openSocket(sockets, CLIENT_URL);
    let done = false;
    let timer;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code);
    };
    ws.on("open", () => ws.send(JSON.stringify(firstFrame)));
    ws.on("close", (c) => finish(c));
    ws.on("error", () => {});
    timer = setTimeout(() => {
      try { ws.close(); } catch {}
      finish(null);
    }, 2000);
  });
}

// Broker A — owns CLIENT_PORT first. PER_CLIENT_MAX=2 keeps the cap test small.
brokerA = ownChild(children, spawn(process.execPath, [brokerPath], {
  env: { ...process.env, CCMCP_PORT: EXT_PORT, CCMCP_CLIENT_PORT: CLIENT_PORT, CCMCP_PER_CLIENT_MAX: "2" },
  stdio: "ignore",
}));

let fakeExt;
let exitCode = 1;
try {
  // Wait until A owns the client port.
  const probe = await connectWs(CLIENT_URL);
  probe.close();

  const statusFrames = [];
  const statusClient = await connectWs(CLIENT_URL, undefined, (_ws, frame) => statusFrames.push(frame));
  statusClient.send(JSON.stringify({ role: "client", sessionKey: "build-status-test", version: PROTOCOL_VERSION, buildStatusVersion: 1 }));
  await waitFor(() => statusFrames.length > 0, "broker build status");
  check("opt-in protocol-v1 hello reports the running broker build", statusFrames[0].type === "broker-status" && /^sha256:[a-f0-9]{64}$/.test(statusFrames[0].buildId));
  statusClient.close();

  // --- Election: a 2nd broker must lose the race and exit 0. ---
  brokerB = ownChild(children, spawn(process.execPath, [brokerPath], {
    env: { ...process.env, CCMCP_PORT: EXT_PORT, CCMCP_CLIENT_PORT: CLIENT_PORT },
    stdio: "ignore",
  }));
  const bExit = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 4000);
    brokerB.once("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  check("2nd broker loses CLIENT_PORT race and exits 0", bExit === 0, `exit=${bExit}`);

  const stillUp = await connectWs(CLIENT_URL).then(
    (ws) => { ws.close(); return true; },
    () => false,
  );
  check("original broker still owns the client port after the loser exits", stillUp);

  // --- Upgrade gate: a browser page (any Origin) is refused on the client port
  // with HTTP 403; the extension port refuses an Origin-less dial the same way.
  // Node clients (no Origin) handshake as before — every connectWs above proves it.
  const upgradeStatus = (u, opts) =>
    new Promise((res) => {
      const ws = openSocket(sockets, u, opts);
      const timer = setTimeout(() => finish("timeout"), 3000);
      const finish = value => { clearTimeout(timer); res(value); };
      ws.on("error", (e) => finish(/Unexpected server response: (\d+)/.exec(e.message)?.[1] ?? e.message));
      ws.on("open", () => {
        ws.close();
        finish("open");
      });
    });
  const pageOnClient = await upgradeStatus(CLIENT_URL, { headers: { Origin: "https://evil.example" } });
  check("client port refuses a browser Origin (HTTP 403)", pageOnClient === "403", `got=${pageOnClient}`);
  const bareOnExt = await upgradeStatus(EXT_URL);
  check("extension port refuses an Origin-less dial (HTTP 403)", bareOnExt === "403", `got=${bareOnExt}`);

  // --- Client-port token: the opt-in token is enforced at the upgrade. ---
  const token = "broker-protocol-token";
  const tokenBroker = ownChild(children, spawn(process.execPath, [brokerPath], {
    env: { ...process.env, BRIDGE_TOKEN: token, CCMCP_PORT: TOKEN_EXT_PORT, CCMCP_CLIENT_PORT: TOKEN_CLIENT_PORT },
    stdio: "ignore",
  }));
  const tokenBase = `ws://127.0.0.1:${TOKEN_CLIENT_PORT}`;
  (await connectWs(`${tokenBase}?token=${token}`)).close();
  const missingToken = await upgradeStatus(tokenBase);
  const wrongToken = await upgradeStatus(`${tokenBase}?token=wrong-${token}`);
  check("client port refuses a missing token (HTTP 401)", missingToken === "401", `got=${missingToken}`);
  check("client port refuses a wrong token (HTTP 401)", wrongToken === "401", `got=${wrongToken}`);
  await stopChild(tokenBroker);

  // --- Handshake rejects ---
  const c4003 = await expectClose({ id: "x", tool: "navigate", args: {} });
  check("non-hello first frame is rejected (4003)", c4003 === 4003, `code=${c4003}`);

  const c4004 = await expectClose({ role: "client", sessionKey: "k", version: PROTOCOL_VERSION + 1 });
  check("version-skew hello is rejected (4004)", c4004 === 4004, `code=${c4004}`);

  // --- Per-session in-flight cap (PER_CLIENT_MAX=2) ---
  // Attach a fake extension that ACKs the socket but NEVER replies, so each call
  // is written ("sent") and genuinely held in-flight until its own timeout. That
  // pins inflight at the cap across event-loop turns, making the (N+1)th call's
  // SESSION_BUSY deterministic — not dependent on TCP/loop coalescing of the sends.
  fakeExt = await connectWs(EXT_URL, EXT);
  const forwarded = [];
  fakeExt.on('message', data => forwarded.push(JSON.parse(data.toString())));
  fakeExt.on("message", () => {
    /* swallow — never respond, so the call stays in-flight holding the slot */
  });
  await wait(150);

  const ws = await connectWs(CLIENT_URL);
  const responses = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    responses.set(m.id, m);
  });
  ws.send(JSON.stringify({ role: "client", sessionKey: "cap-test", sessionName: "Hej och Hå", version: PROTOCOL_VERSION }));
  await wait(150);
  for (const id of ["a", "b", "c"]) {
    ws.send(JSON.stringify({ id, tool: "navigate", sessionName: "forged", args: { tabId: 1, __sessionName: "forged" }, timeoutMs: 1500 }));
  }
  await wait(400);
  const busy = [...responses.values()].some(
    (m) => m.ok === false && m.error?.code === "SESSION_BUSY",
  );
  // The extension also receives session control frames; this is about tool calls.
  const forwardedCalls = forwarded.filter(frame => typeof frame.tool === "string");
  check('broker forwards the hello project label instead of per-call names', forwardedCalls.length === 2
    && forwardedCalls.every(frame => frame.sessionName === 'Hej och Hå'));
  check(
    "(N+1)th concurrent call hits the per-session cap (SESSION_BUSY)",
    busy,
    `responses=${[...responses.values()].map((m) => m.error?.code ?? "ok").join(",") || "none"}`,
  );
  ws.close();

  // --- Deadline: time a call spent queued on its client counts against it. ---
  // The fake extension still never answers, so only the broker's timer ends a call.
  const deadlineClient = await connectWs(CLIENT_URL);
  const deadlineAnswers = new Map();
  deadlineClient.on("message", d => { const m = JSON.parse(d.toString()); if (m.id) deadlineAnswers.set(m.id, m); });
  deadlineClient.send(JSON.stringify({ role: "client", sessionKey: "deadline-test", version: PROTOCOL_VERSION }));
  await wait(150);
  deadlineClient.send(JSON.stringify({ id: "expired", tool: "expired-mutation", args: {}, timeoutMs: 30000, deadline: Date.now() - 1 }));
  deadlineClient.send(JSON.stringify({ id: "bounded", tool: "bounded-mutation", args: {}, timeoutMs: 30000, deadline: Date.now() + 1500 }));
  await waitFor(() => deadlineAnswers.has("expired") && deadlineAnswers.has("bounded"), "deadline answers", 10000).catch(() => {});
  const expired = deadlineAnswers.get("expired");
  const bounded = deadlineAnswers.get("bounded");
  check("a call whose deadline passed before dispatch is never forwarded", !forwarded.some(frame => frame.tool === "expired-mutation"));
  check("an expired call fails TIMEOUT and stays retryable", expired?.ok === false && expired.error?.code === "TIMEOUT" && expired.error?.retryable === true, JSON.stringify(expired));
  check("a forwarded call's broker timer ends at its deadline, not at its full timeout",
    forwarded.some(frame => frame.tool === "bounded-mutation") && bounded?.ok === false && bounded.error?.code === "TIMEOUT", JSON.stringify(bounded));
  deadlineClient.close();

  // The extension hop raises a short budget to its one-second floor. A call still
  // queued there at its client's deadline must be dropped, never written to an
  // extension that connects after the deadline but inside that floor.
  fakeExt.close();
  await wait(150);
  const lateClient = await connectWs(CLIENT_URL);
  const lateAnswers = new Map();
  lateClient.on("message", d => { const m = JSON.parse(d.toString()); if (m.id) lateAnswers.set(m.id, m); });
  lateClient.send(JSON.stringify({ role: "client", sessionKey: "late-test", version: PROTOCOL_VERSION }));
  await wait(150);
  const lateDeadline = Date.now() + 300;
  lateClient.send(JSON.stringify({ id: "late", tool: "late-mutation", args: {}, timeoutMs: 30000, deadline: lateDeadline }));
  await wait(Math.max(0, lateDeadline + 300 - Date.now()));
  const lateDelivered = [];
  fakeExt = await connectWs(EXT_URL, EXT, (_ws, frame) => lateDelivered.push(frame));
  await waitFor(() => lateAnswers.has("late"), "the late call's answer", 5000).catch(() => {});
  await wait(250);
  const late = lateAnswers.get("late");
  check("a call still queued at its deadline is never written to an extension that connects later",
    !lateDelivered.some(frame => frame.tool === "late-mutation"));
  check("a call cancelled at its deadline fails TIMEOUT and stays retryable",
    late?.ok === false && late.error?.code === "TIMEOUT" && late.error?.retryable === true, JSON.stringify(late));
  lateClient.close();

  // A disconnected caller cannot leave a never-sent mutation in the queue.
  fakeExt.close();
  await wait(150);
  const abandoned = await connectWs(CLIENT_URL);
  abandoned.send(JSON.stringify({ role: "client", sessionKey: "abandoned", version: PROTOCOL_VERSION }));
  abandoned.send(JSON.stringify({ id: "queued", tool: "abandoned-mutation", args: {}, timeoutMs: 5000 }));
  await wait(150);
  abandoned.close();
  await wait(150);
  const delivered = [];
  fakeExt = openSocket(sockets, EXT_URL, EXT);
  fakeExt.on("message", d => delivered.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { fakeExt.once("open", resolve); fakeExt.once("error", reject); });
  await wait(250);
  check("disconnect cancels a never-sent call before extension reconnect", !delivered.some(m => m.tool === "abandoned-mutation"));

  // A mutation that reached the extension stays sent across both disconnects.
  const sentClient = await connectWs(CLIENT_URL);
  sentClient.send(JSON.stringify({ role: "client", sessionKey: "sent-client", version: PROTOCOL_VERSION }));
  sentClient.send(JSON.stringify({ id: "sent", tool: "sent-mutation", args: {}, timeoutMs: 1500 }));
  for (let i = 0; i < 20 && !delivered.some(m => m.tool === "sent-mutation"); i++) await wait(25);
  check("mutation reached extension before caller disconnect", delivered.filter(m => m.tool === "sent-mutation").length === 1);
  sentClient.close();
  fakeExt.close();
  await wait(150);
  fakeExt = openSocket(sockets, EXT_URL, EXT);
  fakeExt.on("message", d => delivered.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { fakeExt.once("open", resolve); fakeExt.once("error", reject); });
  await wait(250);
  check("sent call is never replayed after caller and extension reconnect", delivered.filter(m => m.tool === "sent-mutation").length === 1);

  // Exercise the actual client hop, whose PendingCalls must survive the loss of
  // all broker memory. The extension observes the mutation but never answers it.
  const clientMessages = [];
  let clientStderr = "";
  crashClient = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e", `
    import { BridgeClient } from './dist/bridge-client.mjs';
    const client = new BridgeClient();
    const report = (type, result) => process.send({ type, ...result });
    const outcome = promise => promise.then(
      result => ({ ok: true, result }),
      error => ({ ok: false, code: error.code, retryable: error.retryable, message: error.message }),
    );
    outcome(client.call('crash-mutation', {}, 12000)).then(result => report('mutation', result));
    process.on('message', message => {
      if (message.type === 'probe') {
        outcome(client.call('after-crash-probe', {}, 5000)).then(result => report('probe', result));
      }
    });
  `], {
    cwd: root,
    env: { ...process.env, CCMCP_PORT: EXT_PORT, CCMCP_CLIENT_PORT: CLIENT_PORT },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  crashClient.on("message", message => clientMessages.push(message));
  crashClient.stderr.on("data", data => { clientStderr += data; });
  await waitFor(() => delivered.some(m => m.tool === "crash-mutation"), "mutation delivery before broker crash");
  const firstMutation = delivered.find(m => m.tool === "crash-mutation");
  check("real client mutation reaches extension exactly once before broker crash", delivered.filter(m => m.tool === "crash-mutation").length === 1);
  check('real client names the session after its project directory', firstMutation.sessionName === basename(resolve(root)));

  await stopChild(brokerA, "SIGKILL");
  check("original broker has exited before respawn", brokerA.exitCode !== null || brokerA.signalCode !== null);
  brokerC = ownChild(children, spawn(process.execPath, [brokerPath], {
    env: { ...process.env, CCMCP_PORT: EXT_PORT, CCMCP_CLIENT_PORT: CLIENT_PORT },
    stdio: "ignore",
  }));
  // Install the observer before open: a replay queued by the new broker would
  // otherwise be flushed before the test starts listening, giving a false pass.
  fakeExt = await connectWs(EXT_URL, EXT, (ws, request) => {
    delivered.push(request);
    if (request.tool === "after-crash-probe") {
      ws.send(serializeToolResponse({ id: request.id, ok: true, result: { sessionId: request.sessionId } }));
    }
  });
  crashClient.send({ type: "probe" });
  await waitFor(() => clientMessages.some(m => m.type === "probe"), "post-crash client round trip");
  const probeResult = clientMessages.find(m => m.type === "probe");
  check("same client reconnects to respawned broker while mutation remains pending", probeResult.ok === true && !clientMessages.some(m => m.type === "mutation"), JSON.stringify(probeResult));
  check("client session id survives broker crash", probeResult.result?.sessionId === firstMutation.sessionId);
  check('project label survives broker reconnect', delivered.find(m => m.tool === 'after-crash-probe')?.sessionName === firstMutation.sessionName);
  await waitFor(() => clientMessages.some(m => m.type === "mutation"), "sent mutation timeout", 15000);
  const timedOut = clientMessages.find(m => m.type === "mutation");
  check("delivered mutation is never replayed through the respawned broker", delivered.filter(m => m.tool === "crash-mutation").length === 1);
  check("delivered mutation eventually fails TIMEOUT with retryable:false", timedOut.ok === false && timedOut.code === "TIMEOUT" && timedOut.retryable === false, JSON.stringify(timedOut));
  check("real client remains alive after broker crash and timeout", crashClient.exitCode === null && crashClient.signalCode === null, clientStderr);

  exitCode = fail === 0 ? 0 : 1;
} finally {
  await cleanup();
}
console.log(`\n=== broker-protocol: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(exitCode);
