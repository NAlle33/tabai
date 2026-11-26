// Structured JSON-line log for the MCP server + broker: one line per tool-call
// lifecycle event (call / ok / err) with id, tool, timing. Size-rotated + day-
// partitioned, with a retention sweep. Best-effort — logging must never break a
// tool call. (Date is fine here; this is Node server code, not a Workflow script.)
//
// Writes are SYNC on purpose: the broker runs detached with no console, so each
// line must be durable immediately — an async buffer would lose exactly the last
// events before a crash, which are the ones worth keeping. The per-event cost is
// kept to a single appendFileSync by caching the dir check and tracking file size
// in-process instead of an existsSync + statSync on every event.

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Build-time fallback dir (esbuild define; "" in a normal build). CI bakes its
// isolated dir so a broker respawned from the CI build still logs there.
declare const __CCMCP_LOG_DIR__: string;
// CCMCP_LOG_DIR (runtime env) wins; then the baked define; then the per-user default.
const LOG_DIR =
  process.env.CCMCP_LOG_DIR ||
  (typeof __CCMCP_LOG_DIR__ === "string" && __CCMCP_LOG_DIR__) ||
  join(homedir(), ".claude-chrome-mcp", "logs");
const MAX_BYTES = 5 * 1024 * 1024;
const RETAIN_DAYS = 7;
const ERROR_CODES = new Set([
  "NO_SESSION", "TAB_NOT_IN_GROUP", "TAB_NOT_FOUND", "FOCUS_DISABLED", "NO_EXTENSION",
  "TIMEOUT", "SESSION_BUSY", "QUEUE_FULL", "NO_BRIDGE", "SW_ERROR", "TOOL_ERROR",
]);

let dirReady = false; // mkdir once per process, not per event
let lastSweepDay = "";
const fileBytes = new Map<string, number>(); // in-process size per file → no statSync per event

function ensureDir(): void {
  if (dirReady) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  dirReady = true;
}

function sweepOldLogs(): void {
  try {
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.endsWith(".log") && !name.endsWith(".log.1")) continue;
      const p = join(LOG_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* ignore a file that vanished mid-sweep */
      }
    }
  } catch {
    /* ignore */
  }
}

function logFile(src: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  if (day !== lastSweepDay) {
    sweepOldLogs();
    lastSweepDay = day;
    fileBytes.clear();
  }
  // Per-PROCESS file (pid in the name): each process is the SOLE writer of its
  // file, so the in-process size counter is authoritative (no divergence across
  // the concurrent per-session servers sharing one file) and appends never
  // interleave. The prefix is just the role — "broker" for the singleton daemon's
  // lifecycle events, "server" for each session's per-call events.
  const prefix = src === "broker" ? "broker" : "server";
  return join(LOG_DIR, `${prefix}-${day}-${process.pid}.log`);
}

export function logEvent(entry: Record<string, unknown>): void {
  try {
    ensureDir();
    const file = logFile(typeof entry.src === "string" ? entry.src : "");
    // Browser errors can echo entered credentials. Retain only known codes,
    // including on broker crash paths; never persist messages or stacks.
    const candidate = typeof entry.error === "string" ? entry.error.split(":", 1)[0] : "";
    const safe = "error" in entry
      ? { ...entry, error: ERROR_CODES.has(candidate) ? candidate : "TOOL_ERROR" }
      : entry;
    const line = JSON.stringify({ ts: Date.now(), ...safe }) + "\n";
    // Seed the size counter from disk the first time we touch a file this process;
    // thereafter track it in-process so rotation needs no per-event statSync.
    let size = fileBytes.get(file);
    if (size === undefined) {
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
    }
    if (size > MAX_BYTES) {
      try {
        renameSync(file, file + ".1");
      } catch {
        /* ignore */
      }
      size = 0;
    }
    appendFileSync(file, line);
    fileBytes.set(file, size + Buffer.byteLength(line));
  } catch {
    /* never let logging break a tool call */
  }
}
