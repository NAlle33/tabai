// Tabai MCP bootstrap: process-owned resources, stdio and lifecycle.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { BridgeClient } from "./bridge-client";
import { CONFIG_DIR, RECIPES_FILE } from "./config-dir";
import { recipeSchema } from "../shared/workflow-schema";
import { RecipeStore } from "./recipe-store";
import { RunHistory } from "./run-history";
import { WorkflowControl } from "./workflow-control";
import { registerCatalog } from "./tool-catalog";
import { RecipeCheckpoints } from "./recipe-checkpoints";

const recipes = new RecipeStore(RECIPES_FILE, value => recipeSchema.parse(value));
const history = new RunHistory(join(CONFIG_DIR, "runs"));
const workflows = new WorkflowControl();
const checkpoints = new RecipeCheckpoints(CONFIG_DIR);

// Private directories of synthesized upload PNGs (upload_image with no path) are
// removed on process EXIT, not right after the upload call: DOM.setFileInputFiles
// snapshots metadata but reads the bytes LAZILY (on a later submit/FileReader), so
// an immediate unlink would break a submit that follows the attach. OS tmp cleanup
// is the backstop for a hard kill that skips these handlers.
const tempUploads = new Set<string>();
function removeTempUploads(): void {
  for (const directory of tempUploads) {
    // The process is ending: a directory that cannot be removed is left to the OS.
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempUploads.clear();
}
process.on("exit", removeTempUploads);
// A signal listener replaces Node's default termination, which would skip the
// exit cleanup: remove the files, then end with the code a shell reports for
// that signal (128 + its number).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    removeTempUploads();
    process.exit(128 + osConstants.signals[signal]);
  });
}
const SERVER_VERSION = "0.24.1";
// Thin client to the shared broker (drop-in for Bridge: .call/.connected/.pendingCount).
// Multiple MCP sessions fan into the one broker, each in its own tab group.
const bridge = new BridgeClient();
// The initialize identity is the product name; the registration key a client
// chose (`tabai` or the pre-rename `claude-chrome`) is independent of it.
const server = new McpServer({ name: "tabai", version: SERVER_VERSION });

registerCatalog(server, { bridge, recipes, history, workflows, checkpoints, tempUploads, serverVersion: SERVER_VERSION });

const transport = new StdioServerTransport();
await server.connect(transport);

// Self-reap: exit when the MCP stdio link closes (Claude Code disconnect) or our
// parent dies — so a session never leaks a server process (which would otherwise
// linger as a broker client). The broker is a detached singleton with its own
// lifecycle; only this thin client exits here.
const priorOnClose = transport.onclose;
transport.onclose = () => {
  try {
    priorOnClose?.();
  } finally {
    process.exit(0);
  }
};
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
const parentPid = process.ppid;
if (parentPid && parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0); // existence probe; throws if the parent is gone
    } catch {
      process.exit(0);
    }
  }, 5000).unref();
}
console.error("[server] tabai running on stdio");
