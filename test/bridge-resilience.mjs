// @ts-check
// Bridge resilience tests: queue-while-disconnected, at-most-once (a sent call is
// NOT replayed), fast-fail when never connected, and timeout when no client
// reconnects. Uses an
// EPHEMERAL port (0) — never 9223. Requires `npm run build` (imports dist/bridge.mjs).
//
// Handlers are attached BEFORE the socket opens (mirroring the real offscreen,
// which sets ws.onmessage before connect) so the bridge's flush-on-connect — sent
// synchronously when the server sees the connection — is never missed.
import { openSocket, waitOpen, closeSockets } from "./helpers/socket-fixture.mjs";
import { CALL_TIMEOUT_MAX_MS } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeToolResponse } from "./protocol-fixtures.mjs";

// The transport logs every call; keep them out of the user's log directory. The
// directory is read when the logger loads, so the bridge is imported afterwards.
const logDir = mkdtempSync(join(tmpdir(), "tabai-bridge-resilience-"));
process.env.CCMCP_LOG_DIR = logDir;
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));
const { Bridge } = await import("../dist/bridge.mjs");
const { PendingCalls } = await import("../dist/pending-calls.mjs");

const sockets = new Set();
const stopWatchdog = watchdog(async () => { await closeSockets(sockets); bridge.close(); });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The extension port only accepts a chrome-extension:// Origin (see bridge-security).
const EXT = { headers: { Origin: "chrome-extension://ccmcp-test" } };
const bridge = new Bridge("", 0);
const port = await bridge.ready();
const url = `ws://127.0.0.1:${port}`;
// onMessage(ws, req) is attached before 'open' so no flushed message is lost.
const connect = (onMessage) =>
  new Promise((res, rej) => {
    const ws = openSocket(sockets, url, EXT);
    if (onMessage) ws.on("message", (d) => onMessage(ws, JSON.parse(d.toString())));
    waitOpen(ws).then(res, rej);
  });
const echo = (ws, r) => ws.send(serializeToolResponse({ id: r.id, ok: true, result: { echoed: r.tool } }));

// 1. Fast-fail when NO extension has ever connected (not loaded → don't hang).
//    Also: the rejection carries the structured NO_EXTENSION code + retryable.
{
  let err = null;
  try {
    await bridge.call("navigate", { url: "x", tabId: 1 }, 500);
  } catch (e) {
    err = e;
  }
  check(
    "fast-fail when no extension ever connected (NO_EXTENSION, retryable)",
    /No Chrome extension/i.test(String(err?.message)) && err?.code === "NO_EXTENSION" && err?.retryable === true,
    `code=${err?.code} retryable=${err?.retryable}`,
  );
}

// Connect once (everConnected = true), then drop.
const c1 = await connect();
await wait(100);
c1.close();
await wait(150);

// 2. A call issued while disconnected is QUEUED and resolves on reconnect.
{
  const callP = bridge.call("navigate", { url: "q", tabId: 1 }, 5000);
  await wait(200); // queued — no client yet
  const c2 = await connect(echo);
  let res = null;
  try {
    res = await callP;
  } catch (e) {
    res = { err: String(e?.message ?? e) };
  }
  check("queued-while-disconnected resolves on reconnect", res?.echoed === "navigate", JSON.stringify(res));
  c2.close();
  await wait(150);
}

// 3. A call already SENT when the client drops is NOT replayed (at-most-once) —
//    it times out instead, so a non-idempotent tool can't double-execute.
{
  let firstId = null;
  await connect((ws, r) => {
    firstId = r.id;
    ws.close(); // receive (so it's "sent"), drop WITHOUT answering
  });
  const callP = bridge.call("navigate", { url: "r", tabId: 2 }, 800);
  await wait(300);
  let replayId = null;
  const c4 = await connect((ws, r) => {
    replayId = r.id; // should NEVER fire — sent calls aren't replayed
    echo(ws, r);
  });
  let msg = "";
  let errObj = null;
  try {
    await callP;
  } catch (e) {
    errObj = e;
    msg = String(e?.message ?? e);
  }
  check(
    "sent-then-dropped call is NOT replayed (at-most-once), times out, and is NOT retryable",
    !!firstId && replayId === null && /timed out/i.test(msg) && errObj?.retryable === false,
    `first=${firstId} replay=${replayId} retryable=${errObj?.retryable} msg=${msg}`,
  );
  c4.close();
  await wait(150);
}

// 4. A queued call times out cleanly if no client reconnects (TIMEOUT code).
{
  const t0 = Date.now();
  let err = null;
  try {
    await bridge.call("navigate", { url: "t", tabId: 3 }, 600);
  } catch (e) {
    err = e;
  }
  check(
    "queued (never-sent) call times out (TIMEOUT) and stays retryable",
    /timed out/i.test(String(err?.message)) && err?.code === "TIMEOUT" && err?.retryable === true && Date.now() - t0 >= 550,
    `code=${err?.code} retryable=${err?.retryable}`,
  );
}

// 4b. Every closed extension connection is reported, also one a newer connection
//     superseded: the broker tells the assistant at once that calls on it are lost.
{
  let lost = 0;
  bridge.extensionLost = () => { lost++; };
  const older = await connect();
  await wait(50);
  const newer = await connect();
  await wait(150);
  const afterSupersede = lost;
  newer.close();
  await wait(150);
  check(
    "a superseded and a closed extension connection are each reported as lost",
    afterSupersede === 1 && lost === 2 && older.readyState !== older.OPEN,
    `afterSupersede=${afterSupersede} lost=${lost}`,
  );
  bridge.extensionLost = undefined;
}

bridge.close();

// --- Cold-start grace (a SEPARATE bridge with a grace window) ---------------
// 5. During grace, a call with no client connected QUEUES (doesn't fast-fail)
//    and resolves once the extension connects within the window.
{
  const gBridge = new Bridge("", 0, undefined, 1000); // 1s grace
  const gPort = await gBridge.ready();
  const gUrl = `ws://127.0.0.1:${gPort}`;
  const callP = gBridge.call("navigate", { url: "g", tabId: 1 }, 5000);
  await wait(200); // no client yet, but within grace → queued, not fast-failed
  const gc = await new Promise((res, rej) => {
    const ws = openSocket(sockets, gUrl, EXT);
    ws.on("message", (d) => {
      const r = JSON.parse(d.toString());
      echo(ws, r);
    });
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
  let res = null;
  try {
    res = await callP;
  } catch (e) {
    res = { err: String(e?.message ?? e) };
  }
  check("cold-start grace: call queues then resolves on connect within grace", res?.echoed === "navigate", JSON.stringify(res));
  gc.close();
  gBridge.close();
}

// 6. Grace expiry: if no extension connects within the window, the queued call
//    fails NO_EXTENSION promptly — NOT after the (much longer) per-call timeout.
{
  const gBridge = new Bridge("", 0, undefined, 400); // 400ms grace
  await gBridge.ready();
  const t0 = Date.now();
  let err = null;
  try {
    await gBridge.call("navigate", { url: "g2", tabId: 1 }, 10000); // 10s timeout
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - t0;
  check(
    "cold-start grace expiry fails NO_EXTENSION before the per-call timeout",
    err?.code === "NO_EXTENSION" && err?.retryable === true && elapsed < 3000,
    `code=${err?.code} elapsed=${elapsed}ms`,
  );
  gBridge.close();
}
// Observe the actual timer budget, shortening only its elapsed time for the test.
{
  const realTimeout = globalThis.setTimeout;
  let effective;
  globalThis.setTimeout = Object.assign((fn, ms, ...args) => {
    effective = ms;
    return realTimeout(fn, Math.min(ms, 1000), ...args);
  }, realTimeout);
  const calls = new PendingCalls({ write: () => false, isOpen: () => false, queueWhenDisconnected: true });
  const p = calls.add("clamp", "{}", "wait_for", 99_999_999_999).catch(e => e);
  globalThis.setTimeout = realTimeout;
  await wait(100);
  check("huge timeout is clamped and still pending after 100ms", effective === CALL_TIMEOUT_MAX_MS && calls.size === 1);
  const err = await p;
  check("clamped timeout reports the effective budget", err.code === "TIMEOUT" && err.message.includes("300000ms"));
  for (const [value, expected] of [[-1, 1000], [0, 1000], [NaN, 30000], [Infinity, 30000]]) {
    globalThis.setTimeout = Object.assign((fn, ms, ...args) => {
      effective = ms;
      return realTimeout(fn, ms, ...args);
    }, realTimeout);
    const p = calls.add("bound", "{}", "test", value).catch(e => e);
    globalThis.setTimeout = realTimeout;
    calls.cancel("bound");
    await p;
    check(`timeout boundary ${value}`, effective === expected);
  }
  const bad = calls.add("bad-error", "{}", "test", 1000).catch(e => e);
  // Deliberately bypass valid wire fixtures to exercise malformed-input handling.
  calls.settle("bad-error", false, null, { code: 123, retryable: "yes" });
  const malformed = await bad;
  check("malformed error code/retryability fail closed", malformed.code === "TOOL_ERROR" && malformed.retryable === false);
  const sw = calls.add("sw", "{}", "test", 1000).catch(e => e);
  calls.settle("sw", false, null, { code: "SW_ERROR", message: "worker stopped" });
  check("worker loss is non-retryable", (await sw).retryable === false);
}
{
  let b;
  const frames = [];
  const queuedId = randomUUID();
  const cancelledId = randomUUID();
  const sentId = randomUUID();
  b = new Bridge("", 0, undefined, 5000, () => b.sendControl({ type: "control", event: "session-closed", sessionId: "old" }));
  const p = b.call("navigate", {}, 5000, "new", queuedId);
  const cancelled = b.call("navigate", {}, 5000, "gone", cancelledId).catch(e => e);
  check("explicit queued id can be cancelled", b.cancel(cancelledId));
  check("cancel rejects before send", /cancelled/.test((await cancelled).message));
  const ws = openSocket(sockets, `ws://127.0.0.1:${await b.ready()}`, EXT);
  ws.on("message", d => {
    const m = JSON.parse(d.toString()); frames.push(m);
    if (m.id) echo(ws, m);
  });
  await p;
  check("reap control is written before queued call", frames[0]?.type === "control" && frames[1]?.id === queuedId && frames.length === 2);
  const sent = b.call("navigate", {}, 1000, "new", sentId);
  check("sent call refuses cancellation", b.cancel(sentId) === false);
  await sent;
  ws.close(); b.close();
}
// Shutdown: the port stays bound but routes nothing. The connected extension is
// closed by the broker (1001) and a new one is refused at the upgrade (HTTP 503).
{
  const b = new Bridge("", 0);
  const stopPort = await b.ready();
  const stopUrl = `ws://127.0.0.1:${stopPort}`;
  const current = openSocket(sockets, stopUrl, EXT);
  await waitOpen(current);
  const closeCode = new Promise(resolve => current.once("close", code => resolve(code)));
  b.stopRouting();
  check("stopping closes the connected extension with 1001", await closeCode === 1001);
  const refused = await new Promise(resolve => {
    const ws = openSocket(sockets, stopUrl, EXT);
    ws.on("error", e => resolve(/Unexpected server response: (\d+)/.exec(e.message)?.[1] ?? e.message));
    ws.on("open", () => { ws.close(); resolve("open"); });
  });
  check("a stopping bridge refuses a new extension upgrade with HTTP 503", refused === "503", `got=${refused}`);
  check("a stopping bridge keeps its port bound", b.connected === false && (await b.ready()) === stopPort);
  b.close();
}
await closeSockets(sockets);
console.log(`\n=== bridge-resilience: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
