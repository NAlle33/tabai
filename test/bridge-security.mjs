// @ts-check
// Bridge handshake-gate + connection-management tests. Binds an EPHEMERAL port
// (0) — never 9223 — so it can't collide with a live extension on the default
// port. Requires `npm run build` first (imports dist/bridge.mjs).
//
// The gate runs at the HTTP upgrade: a browser page (no chrome-extension://
// Origin) gets HTTP 403, a bad token HTTP 401 — neither ever becomes "the
// extension". Post-upgrade close codes (4002 superseded) keep their meaning.
import { openSocket, closeSockets } from "./helpers/socket-fixture.mjs";
import { watchdog } from "./watchdog.mjs";
import { serializeToolResponse } from "./protocol-fixtures.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The transport logs every call and every refused handshake; keep them out of the
// user's log directory. The directory is read when the logger loads, so the bridge
// is imported afterwards.
const logDir = mkdtempSync(join(tmpdir(), "tabai-bridge-security-"));
process.env.CCMCP_LOG_DIR = logDir;
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));
const { Bridge } = await import("../dist/bridge.mjs");

const sockets = new Set();
const stopWatchdog = watchdog(async () => { await closeSockets(sockets); bridge.close(); });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "chrome-extension://ccmcp-test";
const EXT = { headers: { Origin: ORIGIN } };
// Resolve with the WS close code (or "timeout"); swallow errors.
const closeCode = (ws) =>
  new Promise((res) => {
    const t = setTimeout(() => res("timeout"), 3000);
    ws.on("close", (c) => {
      clearTimeout(t);
      res(c);
    });
    ws.on("error", () => {});
  });
// Dial and resolve with the HTTP status the server answered the upgrade with
// (parsed from ws's error text — the same path BridgeClient uses), "open" when
// accepted, or the close code for a post-upgrade rejection.
const handshake = (url, opts) =>
  new Promise((res) => {
    const ws = openSocket(sockets, url, opts);
    const t = setTimeout(() => res("timeout"), 3000);
    const done = (v) => {
      clearTimeout(t);
      res(v);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.on("error", (e) => {
      const m = /Unexpected server response: (\d+)/.exec(e.message);
      if (m) done(Number(m[1]));
    });
    ws.on("open", () => done("open"));
    ws.on("close", (c) => done(c));
  });

const TOKEN = "test-secret";
const bridge = new Bridge(TOKEN, 0);
const port = await bridge.ready();
const url = `ws://127.0.0.1:${port}`;
const authed = `${url}?token=${encodeURIComponent(TOKEN)}`;
console.log(`bridge listening on ephemeral port ${port}`);

// --- Origin gate (HTTP 403 at the upgrade) ---
const noOriginStarted = Date.now(), noOriginStatus = await handshake(authed);
check("no Origin (Node/raw client) → HTTP 403", noOriginStatus === 403,
  JSON.stringify({ actual: noOriginStatus, elapsedMs: Date.now() - noOriginStarted }));
check(
  "web-page Origin → HTTP 403",
  (await handshake(authed, { headers: { Origin: "https://evil.example" } })) === 403,
);
check("file:// Origin → HTTP 403", (await handshake(authed, { headers: { Origin: "file://" } })) === 403);

// --- Token gate (HTTP 401 at the upgrade, after the Origin passes) ---
check("extension Origin without token → HTTP 401", (await handshake(url, EXT)) === 401);
check("extension Origin with wrong token → HTTP 401", (await handshake(`${url}?token=wrong`, EXT)) === 401);

// A rejected upgrade must still end in `close` (ws emits error THEN close): that
// is what keeps BridgeClient's reconnect loop alive after a 401/403.
{
  const ws = openSocket(sockets, `${url}?token=wrong`, EXT);
  let sawError = false;
  ws.on("error", () => (sawError = true));
  const c = await closeCode(ws);
  check("rejected upgrade emits error then close (reconnect path stays alive)", sawError && typeof c === "number", `close=${c}`);
}

// --- Accepted: extension Origin + correct token; a tool call round-trips ---
const ws = openSocket(sockets, authed, EXT);
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
ws.on("message", (data) => {
  const req = JSON.parse(data.toString());
  if (!req || typeof req.id !== "string") return;
  if (req.tool === "fixture-error") {
    ws.send(serializeToolResponse({
      id: req.id,
      ok: false,
      error: {
        code: "FIXTURE_ERROR",
        message: "fixture tool failed",
        ...(typeof req.args.retryable === "boolean" ? { retryable: req.args.retryable } : {}),
      },
    }));
    return;
  }
  ws.send(serializeToolResponse({ id: req.id, ok: true, result: { echoed: req.tool } }));
});
let rt = null;
try {
  rt = await bridge.call("navigate", { url: "example.com", tabId: 1 }, 3000);
} catch (e) {
  rt = { err: String(e?.message ?? e) };
}
check("accepts extension Origin + correct token, round-trips a call", rt?.echoed === "navigate", JSON.stringify(rt));

for (const retryable of [undefined, false, true]) {
  let error;
  try {
    await bridge.call("fixture-error", { retryable }, 3000);
  } catch (e) {
    error = e;
  }
  check(
    `extension error preserves code/message and retryability (${retryable ?? "omitted"})`,
    error?.code === "FIXTURE_ERROR" && error?.message.includes("fixture tool failed") &&
      error?.retryable === (retryable ?? false),
    String(error?.message ?? "unexpected success"),
  );
}

// --- Newest authed connection supersedes the previous (close code 4002). ---
const firstClosed = closeCode(ws);
const ws2 = openSocket(sockets, authed, EXT);
await new Promise((res, rej) => {
  ws2.on("open", res);
  ws2.on("error", rej);
});
check("newest connection supersedes previous (4002)", (await firstClosed) === 4002);

// --- With the client gone (but one connected earlier this session), a call now
// QUEUES for a reconnect and times out cleanly if none comes (resilience). ---
ws2.close();
await wait(150);
let msg = "";
const t0 = Date.now();
try {
  await bridge.call("navigate", { url: "x", tabId: 1 }, 800);
} catch (e) {
  msg = String(e?.message ?? e);
}
check(
  "call queues then times out when the client is gone",
  /timed out/i.test(msg) && Date.now() - t0 >= 700,
  msg,
);
bridge.close();

// --- Optional extension-id pin: only the pinned id's Origin passes. ---
{
  const PIN = "abcdefghijklmnopabcdefghijklmnop";
  const pinned = new Bridge("", 0, undefined, 0, undefined, PIN);
  const pUrl = `ws://127.0.0.1:${await pinned.ready()}`;
  check("pinned: another extension's Origin → HTTP 403", (await handshake(pUrl, EXT)) === 403);
  check(
    "pinned: the pinned extension's Origin is accepted",
    (await handshake(pUrl, { headers: { Origin: `chrome-extension://${PIN}` } })) === "open",
  );
  pinned.close();
}

await closeSockets(sockets);
console.log(`\n=== bridge-security: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
