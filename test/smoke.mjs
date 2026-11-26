// Smoke test: spawn the MCP server over stdio on ISOLATED ports (never touches
// your live 9223/9225), verify the initialize identity, list tools, and confirm
// a tool call fails gracefully when no Chrome extension is connected to the
// auto-spawned broker.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { killPort } from "./kill-port.mjs";
import { allocatePorts } from "./free-port.mjs";
import assert from "node:assert/strict";
import { watchdog } from "./watchdog.mjs";
import { EXTENSION_TOOLS } from "../dist/tool-names.mjs";

const stopWatchdog = watchdog(() => {
  // Stop the reconnecting server before reaping the broker it spawned.
  try { if (transport.pid) process.kill(transport.pid, "SIGTERM"); } catch {}
  killPort(CLIENT_PORT);
  killPort(PORT);
  rmSync(home, { recursive: true, force: true });
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [PORT, CLIENT_PORT] = await allocatePorts(2);
// The server and the broker it spawns keep their token lookup, logs and stores
// inside a temporary home.
const home = mkdtempSync(join(tmpdir(), "tabai-smoke-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "server.js")],
  cwd: root,
  // Short cold-start grace so the no-extension call fails fast (still graceful).
  env: { ...process.env, HOME: home, USERPROFILE: home, CCMCP_LOG_DIR: join(home, "logs"), CCMCP_CONFIG_DIR: join(home, "config"),
    CCMCP_PORT: PORT, CCMCP_CLIENT_PORT: CLIENT_PORT, CCMCP_GRACE_MS: "1000" },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
let graceful = false;
try {
  await client.connect(transport);
  console.log("connected to server ✓");

  // The initialize identity is the product name, independent of the client's
  // registration key; the version tracks package.json.
  const identity = client.getServerVersion();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(identity?.name, "tabai");
  assert.equal(identity?.version, pkg.version);
  console.log(`server identity ${identity.name}@${identity.version} ✓`);
  // Both executable names are the entry this smoke just spawned.
  for (const bin of ["tabai", "claude-chrome-mcp"]) assert.equal(join(root, pkg.bin[bin]), join(root, "dist", "server.js"), bin);
  console.log("tabai and claude-chrome-mcp executables map to the same server entry ✓");

  const { tools } = await client.listTools();
  console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
  const listed = new Set(tools.map((t) => t.name));
  const orchestrated = ["browser_batch", "upload_image", "recipe_save", "recipe_list", "recipe_run"];
  for (const name of [...EXTENSION_TOOLS, ...orchestrated]) assert.ok(listed.has(name), `tool ${name} is no longer listed`);
  console.log(`all ${EXTENSION_TOOLS.length + orchestrated.length} tools still listed ✓`);
  for (const name of ["wait_for", "download"]) {
    assert.equal(tools.find(t => t.name === name)?.inputSchema.properties.timeoutMs.maximum, 270000);
  }
  const invalidWait = await client.callTool({ name: "wait_for", arguments: { tabId: 1, predicate: "true", timeoutMs: 300000 } });
  assert.equal(invalidWait.isError, true);
  assert.match(invalidWait.content[0].text, /270000/);
  console.log("worker-limit schema caps enforced ✓");

  const res = await client.callTool({
    name: "tabs_context_mcp",
    arguments: { createIfEmpty: true },
  });
  const text = res.content?.[0]?.text ?? "";
  // No extension is connected to the auto-spawned broker: the call must fail with
  // the no-extension code or its message, not with whatever other error occurs.
  graceful = res.isError === true && /^NO_EXTENSION\b|No Chrome extension connected to the bridge/.test(text);
  console.log(`callTool isError=${res.isError === true} ->`, text);
} finally {
  // Always tear down — a thrown assertion must not leak the auto-spawned broker
  // squatting the isolated ports into the next run (a stale-build false pass).
  await client.close().catch(() => {});
  killPort(CLIENT_PORT);
  killPort(PORT);
  rmSync(home, { recursive: true, force: true });
}
console.log(graceful ? "smoke test complete ✓" : "smoke FAIL: expected graceful no-extension error ✗");
stopWatchdog();
process.exit(graceful ? 0 : 1);
