// @ts-check
// Chrome-free multi-session test: spawn the broker, attach a fake extension, and
// connect TWO raw clients. Proves the multi-client guarantees that make
// concurrent sessions safe:
//   - per-client routing: same local id from two clients never collides;
//   - per-session stamping: each client's calls carry its OWN stable sessionId;
//   - failure isolation: one client disconnecting doesn't affect the other;
//   - session announcements: the extension hears session-open for every accepted
//     hello, and a newly connected extension hears it for every live session
//     before any session-closed, so a persisted cleanup never closes a live group.
// (Per-session TAB-GROUP isolation is exercised live in Phase 3 / e2e.)
import { openSocket, waitOpen, closeSockets, stopChild, pendingResponses } from "./helpers/socket-fixture.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { killPort } from "./kill-port.mjs";
import { allocatePorts } from "./free-port.mjs";
import { clientWsUrl } from "../scripts/resolve-token.mjs";
import { PROTOCOL_VERSION } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";
import { serializeToolResponse } from "./protocol-fixtures.mjs";

const sockets = new Set();
const stopWatchdog = watchdog(cleanup);
async function cleanup() {
  await closeSockets(sockets);
  await stopChild(broker);
  killPort(CLIENT_PORT);
  killPort(EXT_PORT);
  rmSync(home, { recursive: true, force: true });
}

// The broker resolves its token file, logs and stores inside a temporary home.
const home = mkdtempSync(join(tmpdir(), "tabai-multi-session-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home, CCMCP_LOG_DIR: join(home, "logs"), CCMCP_CONFIG_DIR: join(home, "config") });
// A short reap grace lets a session end while the extension is away within the test.
const REAP_GRACE_MS = 300;
const sessionIdOf = key => createHash("sha256").update(key).digest("hex").slice(0, 16);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [EXT_PORT, CLIENT_PORT] = await allocatePorts(2);
const brokerPath = join(root, "dist", "broker.js");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

// The extension port admits only a chrome-extension:// Origin; the client port
// admits only Origin-LESS (Node) clients — so `opts` is passed per dial site.
const EXT = { headers: { Origin: "chrome-extension://ccmcp-test" } };
async function connectWs(url, opts) {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = openSocket(sockets, url, opts);
      await waitOpen(ws);
      return ws;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`never connected: ${url}`);
}

// Two distinct session keys -> the broker must derive two distinct sessionIds.
async function makeClient(sessionKey) {
  const ws = await connectWs(clientWsUrl(CLIENT_PORT));
  ws.send(JSON.stringify({ role: "client", sessionKey, version: PROTOCOL_VERSION }));
  const responses = pendingResponses(ws, { timeoutMs: 5000, timeoutMessage: id => `fixture timed out waiting for response ${id}` });
  ws.on("message", data => { const frame = JSON.parse(data.toString()); responses.resolve(frame.id, frame); });
  return {
    call: (id, tool, args, sessionId) => responses.wait(id, () => ws.send(JSON.stringify({ id, tool, args, sessionId, timeoutMs: 5000 }))),
    ws,
  };
}

const broker = spawn(process.execPath, [brokerPath], {
  env: { ...process.env, CCMCP_PORT: EXT_PORT, CCMCP_CLIENT_PORT: CLIENT_PORT, CCMCP_REAP_GRACE_MS: String(REAP_GRACE_MS) },
  stdio: "ignore",
});

let exitCode = 1;
try {
  // Fake extension: echo each request, including the sessionId the broker stamped.
  const ext = await connectWs(`ws://127.0.0.1:${EXT_PORT}`, EXT);
  const controls = [];
  ext.on("message", (d) => {
    const req = JSON.parse(d.toString());
    if (req?.type === "control") controls.push(req);
    if (!req || typeof req.id !== "string") return;
    ext.send(
      serializeToolResponse({
        id: req.id,
        ok: true,
        result: { tool: req.tool, sessionId: req.sessionId, args: req.args },
      }),
    );
  });

  const A = await makeClient("session-key-A");
  const B = await makeClient("session-key-B");
  await new Promise((r) => setTimeout(r, 200));

  // Both use the SAME local id "1" concurrently — must not collide.
  const [ra, rb] = await Promise.all([
    A.call("1", "navigate", { tabId: 11 }),
    B.call("1", "navigate", { tabId: 22 }),
  ]);
  check("client A response routed to A", ra.ok && ra.result?.args?.tabId === 11, JSON.stringify(ra.result?.args));
  check("client B response routed to B (same id, no collision)", rb.ok && rb.result?.args?.tabId === 22, JSON.stringify(rb.result?.args));
  check(
    "A and B get DISTINCT session ids",
    !!ra.result?.sessionId && !!rb.result?.sessionId && ra.result.sessionId !== rb.result.sessionId,
    `${ra.result?.sessionId} vs ${rb.result?.sessionId}`,
  );
  const ra2 = await A.call("2", "navigate", { tabId: 33 });
  check("session id is stable per client", ra2.result?.sessionId === ra.result?.sessionId);

  const forged = await A.call("forged", "navigate", { tabId: 11, __sessionId: "forged" }, "forged");
  check("broker overwrites both forged session ids", forged.result?.sessionId === ra.result?.sessionId && forged.result?.args?.__sessionId === ra.result?.sessionId);

  // Killing A must not affect B.
  A.ws.close();
  await new Promise((r) => setTimeout(r, 150));
  const rb2 = await B.call("3", "navigate", { tabId: 44 });
  check("client B unaffected after A disconnects", rb2.ok && rb2.result?.args?.tabId === 44);

  const opened = controls.filter(frame => frame.event === "session-open").map(frame => frame.sessionId);
  check("an accepted hello is announced to the connected extension (session-open)",
    opened.includes(sessionIdOf("session-key-A")) && opened.includes(sessionIdOf("session-key-B")), JSON.stringify(opened));

  // While the extension is away, D ends (its reap is deferred) and C says hello.
  ext.close();
  await new Promise((r) => setTimeout(r, 150));
  const D = await makeClient("session-key-D");
  await new Promise((r) => setTimeout(r, 150));
  D.ws.close();
  const C = await makeClient("session-key-C");
  await new Promise((r) => setTimeout(r, REAP_GRACE_MS + 400));
  // Record from the first frame: the broker writes as soon as it accepts the socket.
  const replay = [];
  const returned = openSocket(sockets, `ws://127.0.0.1:${EXT_PORT}`, EXT);
  returned.on("message", d => replay.push(JSON.parse(d.toString())));
  await waitOpen(returned);
  const endedD = frame => frame.event === "session-closed" && frame.sessionId === sessionIdOf("session-key-D");
  for (let i = 0; i < 40 && !replay.some(endedD); i++) await new Promise((r) => setTimeout(r, 25));
  const firstClosed = replay.findIndex(frame => frame.event === "session-closed");
  const announced = replay.filter(frame => frame.event === "session-open");
  const live = [sessionIdOf("session-key-B"), sessionIdOf("session-key-C")];
  check("a returning extension hears session-open for every live session, also one that said hello while it was away",
    live.every(id => announced.some(frame => frame.sessionId === id)) && !announced.some(frame => frame.sessionId === sessionIdOf("session-key-D")),
    JSON.stringify(replay));
  check("every session-open precedes the deferred session-closed",
    firstClosed > 0 && replay.some(endedD)
      && replay.every((frame, index) => frame.event !== "session-open" || index < firstClosed), JSON.stringify(replay));

  returned.close();
  C.ws.close();
  B.ws.close();
  exitCode = fail === 0 ? 0 : 1;
} finally {
  await cleanup();
}
console.log(`\n=== multi-session: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(exitCode);
