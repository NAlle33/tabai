import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { WorkflowControl } from "../dist/workflow-control.mjs";
import { RunHistory } from "../dist/run-history.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const dir = mkdtempSync(join(tmpdir(), "tabai-control-"));
const history = new RunHistory(dir);
const schemas = new Map([
  ["computer", z.object({ tabId: z.number(), action: z.string() })],
  ["wait_for", z.object({ tabId: z.number(), text: z.string() })],
]);
const step = { tool: "computer", args: { tabId: 1, action: "left_click" }, expect: { text: "Done" } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
try {
  for (const stoppedAt of ["preflight", "dispatch", "expect"]) {
    const control = new WorkflowControl(), reached = deferred(), release = deferred(), calls = [];
    const run = control.start([step, step], {
      schemas,
      ensureCapabilities: async () => { if (stoppedAt === "preflight") { reached.resolve(); await release.promise; } },
      call: async tool => {
        calls.push(tool);
        if ((stoppedAt === "dispatch" && tool === "computer") || (stoppedAt === "expect" && tool === "wait_for")) {
          reached.resolve(); await release.promise;
        }
        return { ok: true };
      },
    }, history, "Stop check");
    await reached.promise;
    assert.equal(control.stop(run.runId), true);
    assert.equal(control.snapshot()[0].status, "stopping");
    release.resolve();
    const response = await run.done;
    assert.equal(response.structuredContent.status, "cancelled");
    assert.deepEqual(calls, stoppedAt === "preflight" ? [] : ["computer", "wait_for"], "finish the original step and its observation, never dispatch the second");
    assert.equal(response.structuredContent.completedSteps, stoppedAt === "preflight" ? 0 : 1);
    assert.equal(control.busy, false);
    assert.equal(control.stop(run.runId), false, "completed runs cannot be restarted by stop");
    assert.equal(history.get(run.runId).record.status, "cancelled");
  }
  const control = new WorkflowControl(), reached = deferred(), release = deferred();
  const run = control.start([step], { schemas, call: async () => { reached.resolve(); await release.promise; return { ok: true }; } }, history, "Final step");
  await reached.promise; control.stop(run.runId); release.resolve();
  assert.equal((await run.done).structuredContent.status, "succeeded", "a completed final step is successful even when stop was requested");
  const failed = control.start([step], { schemas, call: async () => { throw new Error("secret page input"); } }, history, "Failure");
  await failed.done;
  assert.equal(control.snapshot()[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(control.snapshot()), /secret page input/);
  assert.equal(control.snapshot()[0].steps[0].error, "dispatch.failed");
  const copy = control.snapshot(); copy[0].steps.length = 0;
  assert.equal(control.snapshot()[0].steps.length, 1, "UI snapshots cannot mutate the active owner");
  let dispatched = 0;
  const invalid = control.start([step, { tool: "computer", args: {} }], { schemas, call: async () => { dispatched++; } }, history, "Invalid");
  assert.equal((await invalid.done).structuredContent.failedStep, 2);
  assert.equal(dispatched, 0);
  console.log("=== workflow-control: safe stop boundaries, final-step success, validation, redaction and durable history passed ===");
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
