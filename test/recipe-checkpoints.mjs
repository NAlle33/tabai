import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const compiled = await build({ stdin: { contents: `export * from './src/recipe-checkpoints.ts';export * from './src/recipe-execution.ts';export * from './src/workflow-control.ts';export * from './src/run-history.ts';export { z } from 'zod';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "esm" });
const { RecipeCheckpoints, startCheckpointRecipe, checkpointFingerprint, fingerprint, WorkflowControl, RunHistory, z } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const dir = mkdtempSync(join(tmpdir(), "tabai-checkpoints-"));
const schemas = new Map([
  ["computer", z.object({ tabId: z.number(), action: z.string(), ref: z.string(), documentId: z.string() })],
  ["resolve_target", z.object({ tabId: z.number(), target: z.object({ selector: z.string() }) })],
  ["wait_for", z.object({ tabId: z.number(), text: z.string().optional(), selector: z.string().optional(), timeoutMs: z.number().optional() })],
]);
const actions = [1, 2].map(index => ({ tool: "computer", args: { action: "left_click", tabId: 1 }, target: { selector: `#button-${index}` }, expect: { text: `complete-${index}` } }));
const store = new RecipeCheckpoints(dir), history = new RunHistory(join(dir, "runs"));
let clicks = [], url = "https://private.example/account?secret=value", expectation = true;
const call = async (tool, args) => {
  if (tool === "tabs_context_mcp") return { tabs: [{ tabId: args.foreign ? 2 : 1, url }] };
  if (tool === "resolve_target") return { ref: `ref_${args.target.selector.endsWith("1") ? 1 : 2}`, documentId: "fresh-document" };
  if (tool === "computer") { clicks.push(args.ref); return { ok: true }; }
  if (tool === "wait_for") { if (!expectation) throw new Error("observation failed"); return { ok: true }; }
  throw new Error(`Unexpected ${tool}`);
};
const options = () => ({ store, history, workflows: new WorkflowControl(), deps: { schemas, call }, actions, tabId: 1, name: "checkpoint-test" });
async function stopped() {
  const config = options();
  config.deps.call = async (tool, args) => {
    const result = await call(tool, args);
    if (tool === "wait_for" && args.text === "complete-1") config.workflows.stop(run.runId);
    return result;
  };
  const run = await startCheckpointRecipe(config);
  assert.equal((await run.done).structuredContent.status, "cancelled");
  return run;
}
try {
  const run = await stopped();
  assert.deepEqual(clicks, ["ref_1"]);
  assert.equal(new RecipeCheckpoints(dir).list()[0].resumable, true, "checkpoint survives reconstructed process-owned services");
  const resumeId = run.resumeId;
  url += "changed";
  await assert.rejects(startCheckpointRecipe({ ...options(), resumeId }), /URL changed/);
  assert.deepEqual(clicks, ["ref_1"]);
  url = url.slice(0, -7);
  expectation = false;
  await assert.rejects(startCheckpointRecipe({ ...options(), resumeId }), /observation failed/);
  expectation = true;
  await assert.rejects(startCheckpointRecipe({ ...options(), name: "different-recipe", resumeId }), /name changed/);
  const navigationRace = options();
  navigationRace.deps.call = async (tool, args) => {
    const result = await call(tool, args);
    if (tool === "resolve_target") url += "redirected";
    return result;
  };
  const raced = await startCheckpointRecipe({ ...navigationRace, resumeId });
  assert.equal((await raced.done).structuredContent.status, "failed");
  assert.deepEqual(clicks, ["ref_1"], "navigation after validation blocks the first continued action");
  url = url.slice(0, -10);
  const changed = structuredClone(actions); changed[1].target.selector = "#changed";
  await assert.rejects(startCheckpointRecipe({ ...options(), actions: changed, resumeId }), /parameters changed/);
  const resumed = await startCheckpointRecipe({ ...options(), store: new RecipeCheckpoints(dir), resumeId });
  const response = await resumed.done;
  assert.equal(response.structuredContent.status, "succeeded");
  assert.equal(response.structuredContent.skippedSteps, 1);
  assert.deepEqual(clicks, ["ref_1", "ref_2"], "verified click is never replayed");
  await assert.rejects(startCheckpointRecipe({ ...options(), resumeId }), /No safe checkpoint/);
  assert.doesNotMatch(readFileSync(join(dir, "recipe-checkpoints.json"), "utf8"), /private.example|secret=value|complete-1|#button/);

  const ambiguous = options();
  ambiguous.deps.call = async (tool, args, timeout) => {
    const result = await call(tool, args, timeout);
    if (tool === "computer") throw new Error("lost reply after actual click");
    return result;
  };
  const failed = await startCheckpointRecipe(ambiguous);
  await failed.done;
  const before = clicks.length;
  await assert.rejects(startCheckpointRecipe({ ...options(), resumeId: failed.resumeId }), /No safe checkpoint/);
  assert.equal(clicks.length, before);

  const deniedWrite = options();
  deniedWrite.store = { create: (...args) => store.create(...args), change: async () => { throw new Error("disk unavailable"); } };
  const beforeWriteFailure = clicks.length;
  const unwritable = await startCheckpointRecipe(deniedWrite);
  const unwritableResponse = await unwritable.done;
  assert.equal(unwritableResponse.structuredContent.status, "failed");
  assert.match(unwritableResponse.structuredContent.checkpointError, /disk unavailable/, "the final write failure is reported beside the run's own outcome");
  assert.equal(clicks.length, beforeWriteFailure, "durable intent failure prevents dispatch");

  const ready = await stopped();
  const hash = checkpointFingerprint(actions, 1);
  const claims = await Promise.allSettled([store.claim(ready.resumeId, hash), new RecipeCheckpoints(dir).claim(ready.resumeId, hash)]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1, "only one process can claim a checkpoint");
  assert.equal(claims.filter(result => result.status === "rejected").length, 1);
  const owner = claims.find(result => result.status === "fulfilled").value;
  await assert.rejects(store.change({ ...owner, owner: { ...owner.owner, token: "00000000-0000-4000-8000-000000000000" } }, { phase: "dispatching" }), /ownership changed/);
  assert.equal(fingerprint("same"), fingerprint("same"));
  assert.throws(() => checkpointFingerprint([{ ...actions[0], args: { tabId: 1, ref: "ref_1" } }], 1), /stored refs/);
  assert.throws(() => checkpointFingerprint([{ ...actions[0], expect: { predicate: "window.mutated=true" } }], 1), /declarative/);
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal(dead.status, 0);
  const crashRecord = await store.create("crash-at-checkpoint", hash, 2);
  await store.change(crashRecord, { phase: "verified", cursor: 1, urlHash: fingerprint(url) });
  const file = join(dir, "recipe-checkpoints.json");
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  persisted.records.find(item => item.resumeId === crashRecord.resumeId).owner.pid = dead.pid;
  writeFileSync(file, JSON.stringify(persisted));
  assert.equal(store.list().find(item => item.resumeId === crashRecord.resumeId).resumable, true);
  const recovered = await store.claim(crashRecord.resumeId, hash);
  await store.change(recovered, { phase: "dispatching" }, true);
  await assert.rejects(store.claim(crashRecord.resumeId, hash), /No safe checkpoint/, "dead owner never authorizes replay of an ambiguous action");

  const finalWrite = options();
  finalWrite.store = { create: (...args) => store.create(...args), change: async (record, fields, release) => {
    if (release) throw new Error("final write unavailable");
    return store.change(record, fields, release);
  } };
  const beforeFinalWrite = clicks.length;
  const completed = await startCheckpointRecipe(finalWrite);
  const completedResponse = await completed.done;
  assert.equal(completedResponse.structuredContent.status, "succeeded", "a completed run keeps its result");
  assert.match(completedResponse.structuredContent.checkpointError, /final write unavailable/);
  assert.equal(completedResponse.structuredContent.resumeId, completed.resumeId);
  assert.deepEqual(JSON.parse(completedResponse.content[0].text).map(step => step.ok), [true, true], "the step results are returned");
  assert.equal(clicks.length, beforeFinalWrite + 2);

  const undispatched = options();
  undispatched.deps = { ...undispatched.deps, ensureCapabilities: async () => { throw new Error("Reload the extension"); } };
  const beforePreflight = clicks.length;
  const preflight = await startCheckpointRecipe(undispatched);
  assert.equal((await preflight.done).structuredContent.status, "failed");
  assert.equal(clicks.length, beforePreflight);
  assert.equal(store.list().some(item => item.resumeId === preflight.resumeId), false, "a run that dispatched nothing leaves no checkpoint");
  assert.equal("resumeId" in (await preflight.done).structuredContent, false, "a run whose checkpoint was removed answers without a resumeId");

  // Capacity: a record still in phase `new` proves that nothing was dispatched.
  const stamp = new Date().toISOString();
  const fresh = owner => ({ resumeId: randomUUID(), name: "started", fingerprint: hash, createdAt: stamp, updatedAt: stamp,
    cursor: 0, totalSteps: 2, phase: "new", ...(owner ? { owner } : {}) });
  const liveOwner = () => ({ pid: process.pid, host: hostname(), token: randomUUID() });
  const deadOwner = () => ({ pid: dead.pid, host: hostname(), token: randomUUID() });
  const persist = records => writeFileSync(file, JSON.stringify({ version: 1, records }), { mode: 0o600 });
  persist(Array.from({ length: 100 }, () => fresh()));
  const afterReleased = await startCheckpointRecipe(options());
  assert.equal((await afterReleased.done).structuredContent.status, "succeeded", "100 released new records do not block a resumable start");
  const starting = fresh(liveOwner());
  persist([starting, ...Array.from({ length: 99 }, () => fresh(deadOwner()))]);
  const afterAbandoned = await store.create("checkpoint-test", hash, 2);
  const kept = JSON.parse(readFileSync(file, "utf8")).records;
  assert.equal(kept.length, 100);
  assert.ok(kept.some(item => item.resumeId === starting.resumeId), "a new record whose owner still runs is kept");
  assert.ok(kept.some(item => item.resumeId === afterAbandoned.resumeId));
  persist(Array.from({ length: 100 }, () => fresh(liveOwner())));
  await assert.rejects(store.create("checkpoint-test", hash, 2), /capacity/, "runs that are just starting keep their records");
  console.log("Recipe checkpoints: restart, verified resume, page/input changes, ambiguous effects, atomic claims, metadata privacy, final write errors and new-record capacity passed");
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
