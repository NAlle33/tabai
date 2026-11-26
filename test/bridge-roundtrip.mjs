// @ts-check
// Integration test: MCP call -> broker -> bridge -> WS -> (fake extension) -> back.
// Runs on ISOLATED ports; the broker is auto-spawned by the server. The fake
// "extension" connects to the broker's extension port (retry until it binds).
// The only link this does NOT cover is the extension's Chrome-API code (covered
// by the dedicated live suite).
import { openSocket, waitOpen, closeSockets } from "./helpers/socket-fixture.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { killPort } from "./kill-port.mjs";
import { allocatePorts } from "./free-port.mjs";
import { watchdog } from "./watchdog.mjs";
import { serializeToolResponse } from "./protocol-fixtures.mjs";

const sockets = new Set();
let client, transport, PORT, CLIENT_PORT, signalled;
let cleanupPromise;
// The server and the broker it spawns keep their token lookup, logs and stores
// inside a temporary home.
const home = mkdtempSync(join(tmpdir(), "tabai-bridge-roundtrip-"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==";
function cleanup() {
  return cleanupPromise ??= (async () => {
    // The SDK transport owns this exact child and closes stdin, then performs
    // bounded TERM/KILL escalation. Await it before releasing the broker ports.
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    if (signalled && signalled.exitCode === null && signalled.signalCode === null) {
      const exited = once(signalled, "exit");
      signalled.kill("SIGKILL");
      await exited;
    }
    await closeSockets(sockets);
    if (CLIENT_PORT) killPort(CLIENT_PORT);
    if (PORT) killPort(PORT);
    rmSync(home, { recursive: true, force: true });
  })();
}
const stopWatchdog = watchdog(cleanup);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
[PORT, CLIENT_PORT] = await allocatePorts(2);

transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "server.js")],
  cwd: root,
  env: { ...process.env, HOME: home, USERPROFILE: home, CCMCP_LOG_DIR: join(home, "logs"), CCMCP_CONFIG_DIR: join(home, "config"),
    CCMCP_PORT: PORT, CCMCP_CLIENT_PORT: CLIENT_PORT },
});
client = new Client({ name: "roundtrip", version: "0.0.0" });

// The broker is auto-spawned by the server's first connect attempt; retry the
// fake extension's connection to its extension port until the broker binds it.
async function connectExtension() {
  for (let i = 0; i < 60; i++) {
    try {
      // The extension port admits only a chrome-extension:// Origin.
      const ws = openSocket(sockets, `ws://127.0.0.1:${PORT}`, {
        headers: { Origin: "chrome-extension://ccmcp-test" },
      });
      await waitOpen(ws);
      return ws;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`broker extension port ${PORT} never came up`);
}

/** upload_image without a path writes the screenshot into a private temp
 *  directory; SIGTERM removes it and ends the server with code 128+15. Plain
 *  JSON-RPC over the child's own stdio, so the exit code is observable. */
async function uploadThenTerminate() {
  const temp = join(home, "tmp");
  mkdirSync(temp, { mode: 0o700 });
  signalled = spawn(process.execPath, [join(root, "dist", "server.js")], {
    cwd: root, stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: temp, CCMCP_LOG_DIR: join(home, "logs"), CCMCP_CONFIG_DIR: join(home, "config"),
      CCMCP_PORT: PORT, CCMCP_CLIENT_PORT: CLIENT_PORT },
  });
  const waiting = new Map();
  let buffer = "";
  signalled.stdout.setEncoding("utf8");
  signalled.stdout.on("data", chunk => {
    buffer += chunk;
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      waiting.get(message.id)?.(message);
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} got no reply`)), 20_000);
    waiting.set(id, message => { clearTimeout(timer); resolve(message); });
    signalled.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "signal-cleanup", version: "0.0.0" } });
  signalled.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const reply = await request(2, "tools/call", { name: "upload_image", arguments: { ref: "ref_1", tabId: 321 } });
  const uploaded = JSON.parse(reply.result?.content?.[0]?.text ?? "{}").uploadedPath;
  const privateFile = typeof uploaded === "string" && existsSync(uploaded) && (statSync(uploaded).mode & 0o777) === 0o600;
  const privateDirectory = typeof uploaded === "string" && dirname(uploaded) !== temp && (statSync(dirname(uploaded)).mode & 0o777) === 0o700;
  const exited = once(signalled, "exit");
  signalled.kill("SIGTERM");
  const [code, signal] = await exited;
  const leftovers = readdirSync(temp);
  const signalPass = privateFile && privateDirectory && code === 143 && signal === null && leftovers.length === 0;
  console.log(`upload_image signal cleanup: ${signalPass ? "PASS" : "FAIL"} — file 0600=${privateFile}, own 0700 directory=${privateDirectory}, exit code=${code}, signal=${signal}, left in temp=${JSON.stringify(leftovers)}`);
  return signalPass;
}

let ws = null;
let pass = false;
try {
  await client.connect(transport);
  console.log("MCP client connected ✓");
  ws = await connectExtension();
  console.log("fake extension connected to broker ✓");

  ws.on("message", (data) => {
    const req = JSON.parse(data.toString());
    if (!req || typeof req.id !== "string") return; // ignore pings/non-requests
    if (req.tool === "computer" && req.args.action === "screenshot") {
      ws.send(serializeToolResponse({ id: req.id, ok: true, result: { kind: "image", mimeType: "image/png", base64: PNG } }));
      return;
    }
    if (req.args.tabId === 456 || req.args.tabId === 457) {
      ws.send(serializeToolResponse({
        id: req.id,
        ok: false,
        error: { code: "TOOL_ERROR", message: "fixture tool failed", retryable: req.args.tabId === 457 },
      }));
      return;
    }
    ws.send(
      serializeToolResponse({
        id: req.id,
        ok: true,
        result: { echoedTool: req.tool, echoedArgs: req.args, fake: true },
      }),
    );
  });

  // Give the bridge a moment to register the (newest) connection.
  await new Promise((r) => setTimeout(r, 300));

  const res = await client.callTool({
    name: "navigate",
    arguments: { url: "example.com", tabId: 123 },
  });
  const text = res.content?.[0]?.text ?? "";
  try {
    const parsed = JSON.parse(text);
    pass = parsed.fake === true && parsed.echoedArgs?.tabId === 123;
  } catch {
    /* parse failure = fail */
  }
  console.log("round-trip result:", text);
  for (const retryable of [false, true]) {
    const error = await client.callTool({
      name: "navigate",
      arguments: { url: "https://error.example/", tabId: retryable ? 457 : 456 },
    });
    const errorText = error.content?.[0]?.text ?? "";
    const errorPass = error.isError === true && errorText.includes("TOOL_ERROR") &&
      errorText.includes("fixture tool failed") && errorText.includes("(retryable)") === retryable;
    pass = pass && errorPass;
    console.log(`error round-trip (retryable=${retryable}): ${errorPass ? "PASS" : "FAIL"} — ${errorText}`);
  }
  // Windows has no catchable SIGTERM: a kill there ends the process without
  // handlers, so this lifecycle contract is POSIX-only.
  if (process.platform !== "win32") {
    const signalPass = await uploadThenTerminate();
    pass = pass && signalPass;
  } else console.log("upload_image signal cleanup: skipped on Windows (signals cannot be handled)");
  console.log(pass ? "ROUND-TRIP PASS ✓" : "ROUND-TRIP FAIL ✗");
} finally {
  await cleanup();
}
stopWatchdog();
process.exit(pass ? 0 : 1);
