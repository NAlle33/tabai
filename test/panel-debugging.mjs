import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunHistory } from "../dist/run-history.mjs";
import { WorkflowControl } from "../dist/workflow-control.mjs";
import { LoopGuard } from "../dist/loop-guard.mjs";
import { z } from "zod";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const source = await build({ entryPoints: ["src/server-workflows.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { createServerWorkflows } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString("base64")}`);
const dir = mkdtempSync(join(tmpdir(), "tabai-panel-evidence-"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==";
try {
  const history = new RunHistory(dir), workflows = new WorkflowControl();
  const incidentId = randomUUID();
  const run = workflows.start([{ tool: "computer", args: { tabId: 1 } }], {
    schemas: new Map([["computer", z.object({ tabId: z.number() })]]), call: async tool => {
      if (tool === "screenshot") return { mimeType: "image/png", base64: PNG };
      throw Object.assign(new Error("private page error"), { code: "TIMEOUT", incidentId });
    },
  }, history, "Evidence", true);
  await run.done;
  assert.equal(history.get(run.runId).record.steps[0].incidentId, incidentId);
  assert.doesNotMatch(JSON.stringify(history.get(run.runId).record), /private page error/);
  const record = { runId: randomUUID(), startedAt: new Date().toISOString(), durationMs: 1, status: "failed", totalSteps: 1, completedSteps: 0, failedStep: 1,
    steps: [{ index: 1, tool: "computer", durationMs: 1, status: "failed", stage: "dispatch", error: "dispatch.failed", incidentId }] };
  await history.save(record, PNG);
  let panel;
  const loopGuard = new LoopGuard();
  createServerWorkflows({ bridge: { configurePanel: (_version, handler) => { panel = handler; }, call: async () => ({}), activity: () => ({ calls: [] }), connected: true, pendingCount: 0,
    incidents: { get: id => { assert.equal(id, incidentId); return { incidentId }; }, list: () => [] }, loopGuard },
    recipes: { load: () => ({}) }, history, workflows, schemas: new Map(), serverVersion: "test" });
  const chunk = await panel({ action: "history-image", runId: record.runId, offset: 0 });
  assert.equal(chunk.base64, PNG); assert.equal(chunk.mimeType, "image/png"); assert.equal(chunk.total, PNG.length);
  await assert.rejects(panel({ action: "history-image", runId: record.runId, offset: 1 }), /bildposition/);
  await assert.rejects(panel({ action: "history-image", runId: record.runId, offset: PNG.length }), /bildposition/);
  await assert.rejects(panel({ action: "history-image", runId: randomUUID(), offset: 0 }));
  assert.equal((await panel({ action: "history" })).find(item => item.runId === record.runId).steps[0].incidentId, incidentId);
  assert.deepEqual(await panel({ action: "incident", incidentId }), { incidentId });
  const large = Buffer.concat([Buffer.from(PNG, "base64").subarray(0, -12), Buffer.alloc(2 * 1024 * 1024), Buffer.from(PNG, "base64").subarray(-12)]).toString("base64");
  const largeRecord = { ...record, runId: randomUUID() }; await history.save(largeRecord, large);
  let encoded = "";
  while (encoded.length < large.length) {
    const part = await panel({ action: "history-image", runId: largeRecord.runId, offset: encoded.length });
    assert.equal(part.offset, encoded.length); assert.equal(part.total, large.length);
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < 2 * 1024 * 1024);
    encoded += part.base64;
  }
  assert.equal(encoded, large, "saved images larger than one panel frame are retrieved losslessly");

  // A helper store that cannot be read empties only its own list and is named;
  // the session's runs and their Stop control stay available.
  let releaseStep;
  const busy = workflows.start([{ tool: "computer", args: { tabId: 1 } }, { tool: "computer", args: { tabId: 1 } }], {
    schemas: new Map([["computer", z.object({ tabId: z.number() })]]),
    call: () => new Promise(resolve => { releaseStep = resolve; }),
  }, history, "Running beside broken stores");
  const unreadable = () => { throw new Error("Invalid or unreadable private metadata store"); };
  let broken;
  createServerWorkflows({ bridge: { configurePanel: (_version, handler) => { broken = handler; }, call: async () => ({}), activity: () => ({ calls: [] }), connected: false, pendingCount: 0,
    incidents: { get: unreadable, list: unreadable }, loopGuard },
    checkpoints: { list: unreadable }, recipes: { load: () => ({}) }, history, workflows, schemas: new Map(), serverVersion: "test" });
  const state = await broken({ action: "snapshot" });
  assert.ok(state.runs.some(item => item.runId === busy.runId && item.status === "running"), "runs are listed beside broken stores");
  assert.deepEqual(state.calls, []);
  assert.equal(state.recording.state, "idle");
  assert.deepEqual(state.checkpoints, []);
  assert.deepEqual(state.incidents, []);
  assert.deepEqual(state.storeErrors, ["checkpoints", "incidents"], "each failed store is named");
  assert.doesNotMatch(JSON.stringify(state.storeErrors), /Invalid or unreadable/);
  assert.deepEqual(await broken({ action: "stop", runId: busy.runId }), { requested: true });
  releaseStep({ ok: true });
  assert.equal((await busy.done).structuredContent.status, "cancelled", "Stop still ends the run before its next step");
  console.log("Panel debugging: actual private PNG storage, bounded chunks, retention failures, incident correlation, on-demand retrieval and per-store snapshot errors passed");
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
