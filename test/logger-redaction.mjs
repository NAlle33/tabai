// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(logDir, { recursive: true, force: true }));
const logDir = mkdtempSync(join(tmpdir(), "tabai-logger-redaction-"));
process.env.CCMCP_LOG_DIR = logDir;

const sentinel = "TABAI_REDACTION_SENTINEL_7f68a0";
const cases = [
  { id: "plain", src: "server", error: `browser echoed ${sentinel}`, code: "TOOL_ERROR" },
  { id: "prefixed", src: "broker", error: `SW_ERROR: browser echoed ${sentinel}`, code: "SW_ERROR" },
  { id: "stack", src: "broker", error: `Error: ${sentinel}\n    at browser-handler:1:1`, code: "TOOL_ERROR" },
  { id: "unhandled", src: "broker", error: `unhandled rejection ${sentinel}`, code: "TOOL_ERROR" },
  { id: "uppercase-secret", src: "server", error: "PRIVATE_CREDENTIAL_VALUE", code: "TOOL_ERROR" },
  { id: "error-object", src: "server", error: new Error(sentinel), code: "TOOL_ERROR" },
  { id: "unknown-object", src: "server", error: { detail: sentinel }, code: "TOOL_ERROR" },
];

try {
  const [{ logEvent }, { PendingCalls }] = await Promise.all([
    import("../src/logger.ts"),
    import("../dist/pending-calls.mjs"),
  ]);

  for (const entry of cases) {
    logEvent({
      id: entry.id,
      src: entry.src,
      tool: "form_input",
      event: "err",
      ms: 17,
      error: entry.error,
    });
  }

  // Exercise the concrete browser-response path that originally copied an
  // extension-provided message into both the server and broker loggers.
  const calls = new PendingCalls({ write: () => true, isOpen: () => true });
  const rejected = calls.add("settle", "{}", "form_input", 1000).catch(error => error);
  calls.settle("settle", false, null, {
    code: "SW_ERROR",
    message: `browser echoed ${sentinel}`,
    retryable: false,
  });
  assert.equal((await rejected).code, "SW_ERROR");

  // A transport timer expiry is diagnosable: it keeps its own code, and whether
  // the call had been written decides if it may already have run.
  const written = new PendingCalls({ write: () => true, isOpen: () => true });
  const queued = new PendingCalls({ write: () => false, isOpen: () => false, queueWhenDisconnected: true });
  const [writtenTimeout, queuedTimeout] = await Promise.all([
    written.add("timer-sent", "{}", "navigate", 1000).catch(error => error),
    queued.add("timer-queued", "{}", "navigate", 1000).catch(error => error),
  ]);
  assert.equal(writtenTimeout.code, "TIMEOUT");
  assert.equal(queuedTimeout.code, "TIMEOUT");

  const files = readdirSync(logDir).filter(name => name.endsWith(".log"));
  assert.ok(files.some(name => name.startsWith("server-")), "server log was not produced");
  assert.ok(files.some(name => name.startsWith("broker-")), "broker log was not produced");
  const rawLogs = files.map(name => readFileSync(join(logDir, name), "utf8")).join("");
  assert.equal(rawLogs.includes(sentinel), false, "sensitive error detail reached a log sink");

  const entries = rawLogs.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const expectedCodes = new Map(cases.map(entry => [entry.id, entry.code]));
  expectedCodes.set("settle", "SW_ERROR");
  for (const [id, code] of expectedCodes) {
    const entry = entries.find(candidate => candidate.id === id && candidate.event === "err");
    assert.ok(entry, `missing err event for ${id}`);
    assert.equal(entry.error, code, `${id} did not retain only its machine-readable code`);
    assert.equal(entry.tool, "form_input", `${id} lost tool metadata`);
    assert.equal(typeof entry.ts, "number", `${id} lost timestamp metadata`);
    assert.equal(typeof entry.ms, "number", `${id} lost timing metadata`);
  }
  for (const [id, sent] of [["timer-sent", true], ["timer-queued", false]]) {
    const entry = entries.find(candidate => candidate.id === id && candidate.event === "err");
    assert.ok(entry, `missing err event for ${id}`);
    assert.equal(entry.error, "TIMEOUT", `${id}: a timer expiry must log the TIMEOUT code`);
    assert.equal(entry.sent, sent, `${id}: a timer expiry must log whether the call was written`);
  }

  console.log("=== logger-redaction: PASS ===");
} finally {
  rmSync(logDir, { recursive: true, force: true });
  stopWatchdog();
}
