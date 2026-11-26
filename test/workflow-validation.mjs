import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { z } from "zod";
import { bindParameters, recipeSchema, recipeActions, targetSchema } from "../dist/workflow-schema.mjs";
import { runWorkflow, injectTabId, summarizeBinary } from "../dist/tool-orchestration.mjs";
import { workflowResponse } from "../dist/workflow-report.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(checkpointDir, { recursive: true, force: true }));
const definitions = { query: { type: "string" }, enabled: { type: "boolean", default: true }, count: { type: "number", default: 4 } };
const template = [{ tool: "form_input", args: { value: { $param: "enabled" }, tabId: { $param: "count" } }, target: { selector: "#{{query}}" } }];
const bound = bindParameters(template, definitions, { query: "name" });
assert.equal(bound[0].args.value, true);
assert.equal(bound[0].args.tabId, 4);
assert.equal(bound[0].target.selector, "#name");
assert.deepEqual(template[0].args.value, { $param: "enabled" }, "binding does not mutate saved recipes");
assert.equal(bindParameters([{ tool: "find", args: { query: "{{query}}" } }], definitions, { query: "{{unknown}}" })[0].args.query, "{{unknown}}", "no recursive interpolation");
for (const inputs of [{}, { query: 2 }, { query: "x", count: "4" }, { query: "x", unwanted: true }])
  assert.throws(() => bindParameters(template, definitions, inputs));
for (const action of [
  { tool: "javascript_tool", args: { text: "window.{{query}}()" } },
  { tool: "wait_for", args: { predicate: "window.x === '{{query}}'" } },
  { tool: "computer", expect: { predicate: "window.{{query}}" } },
  { tool: "computer", args: { expect: { predicate: "window.{{query}}" } } },
  { tool: "form_input", args: { expect: { predicate: { $param: "query" } } } },
]) assert.throws(() => bindParameters([action], definitions, { query: "x" }), /executable/);
assert.throws(() => bindParameters([{ tool: "find", args: JSON.parse('{"__proto__":{"admin":true}}') }]), /reserved/);
assert.equal(recipeActions(recipeSchema.parse([{ tool: "tabs_create_mcp" }])).length, 1);
assert.equal(recipeActions(recipeSchema.parse({ version: 2, actions: template, parameters: definitions }), { query: "x" })[0].args.value, true);
assert.throws(() => recipeSchema.parse({ version: 3, actions: template }));
for (const name of ["user.name", "user name", "9query", "__proto__"])
  assert.throws(() => bindParameters([], JSON.parse(`{"${name}":{"type":"string"}}`), {}), undefined, `invalid parameter name ${name}`);
const marked = summarizeBinary({ kind: "image", base64: "cG5n", targets: [{ number: 1, ref: "ref_1" }], documentId: "document-A", width: 800, height: 600, coverage: { scope: "main-frame" } });
assert.equal(marked.documentId, "document-A");
assert.equal(marked.width, 800);
assert.equal(marked.targets[0].ref, "ref_1");
assert.equal(marked.coverage.scope, "main-frame");
assert.match(marked.note, /screenshot_marked/);
assert.equal(marked.base64, undefined);

const schemas = new Map([
  ["computer", z.object({ action: z.string(), tabId: z.number(), ref: z.string().optional(), documentId: z.string().optional() })],
  ["form_input", z.object({ tabId: z.number(), ref: z.string(), documentId: z.string().optional(), value: z.union([z.string(), z.boolean(), z.number()]) })],
  ["resolve_target", z.object({ tabId: z.number(), target: targetSchema })],
  ["wait_for", z.object({ tabId: z.number(), text: z.string().optional(), fieldValue: z.object({ selector: z.string(), value: z.union([z.string(), z.boolean()]) }).optional(), timeoutMs: z.number().optional() })],
  ["navigate", z.object({ tabId: z.number(), url: z.string() })],
]);
const click = { tool: "computer", args: { tabId: 1, action: "left_click" }, target: { selector: "#go" } };
const calls = [];
let reply = () => ({ ok: true });
const deps = { schemas, call: async (tool, args) => {
  calls.push({ tool, args });
  if (tool === "resolve_target") return { ok: true, ref: "ref_7", documentId: "doc-A", frameId: 0 };
  return reply(tool, args);
} };
const run = async (actions, extra = {}) => { calls.length = 0; return runWorkflow(actions, { ...deps, ...extra }); };
let result = await run([click, { tool: "navigate", args: { tabId: 1, url: 5 } }]);
assert.equal(result.failedStep, 2);
assert.equal(result.completedSteps, 0);
assert.equal(calls.length, 0, "whole-run static preflight before mutation");
result = await run([click], { ensureCapabilities: async () => { throw new Error("Reload old extension"); } });
assert.equal(result.ok, false);
assert.equal(calls.length, 0, "mixed-version preflight prevents action");
result = await run([click]);
assert.equal(result.ok, true);
assert.equal(result.completedSteps, 1);
assert.deepEqual(calls.map(call => call.tool), ["resolve_target", "computer"]);
assert.equal(calls[1].args.documentId, "doc-A");
assert.equal(calls[1].args.ref, "ref_7");
assert.ok(result.durationMs >= 0 && result.steps[0].durationMs >= 0);

reply = tool => { if (tool === "wait_for") throw new Error("secret field value in browser failure"); return { ok: true }; };
result = await run([{ ...click, expect: { text: "Done", timeoutMs: 100 } }, click]);
assert.equal(result.failedStep, 1);
assert.equal(result.steps[0].stage, "expect");
assert.equal(result.steps[0].actionState, "completed");
assert.equal(calls.filter(c => c.tool === "computer").length, 1, "no action replay or continuation after failed effect");
assert.deepEqual(calls.map(c => c.tool), ["resolve_target", "computer", "wait_for"]);

const failed = result;
let saved;
const response = await workflowResponse(result, [click], { history: { save: async record => { saved = record; } }, call: deps.call });
assert.equal(response.isError, true);
assert.equal(response.structuredContent.failedStep, 1);
assert.equal(JSON.parse(response.content[0].text)[0].ok, false);
assert.doesNotMatch(JSON.stringify(saved), /secret field value/);
assert.equal(saved.steps[0].error, "expect.failed");
assert.equal(saved.steps[0].index, 1);
const historyFailure = await workflowResponse(result, [click], {
  history: { save: async () => { throw new Error("disk full"); } },
  call: async () => { throw new Error("tab gone"); }, captureOnError: true,
});
assert.equal(historyFailure.structuredContent.status, failed.status);
assert.equal(historyFailure.structuredContent.historySaved, false);
assert.equal(historyFailure.structuredContent.screenshotSaved, false);
assert.match(historyFailure.structuredContent.screenshotError, /unavailable/);

for (const stage of ["resolve", "dispatch", "expect"]) {
  const controller = new AbortController();
  let mutations = 0;
  result = await run([{ ...click, expect: { text: "Done" } }], {
    signal: controller.signal,
    call: async tool => {
      if (tool === "computer") mutations++;
      if ((stage === "resolve" && tool === "resolve_target") || (stage === "dispatch" && tool === "computer") || (stage === "expect" && tool === "wait_for")) controller.abort();
      return tool === "resolve_target" ? { ref: "ref_7", documentId: "doc-A" } : { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "cancelled", "cancellation during the final step cannot report success");
  assert.equal(result.steps[0].stage, stage);
  assert.equal(mutations, stage === "resolve" ? 0 : 1);
}
result = await run([click], { call: async () => { throw new Error("Ambiguous target"); } });
assert.equal(result.steps[0].actionState, "not-started");
assert.equal(result.steps[0].stage, "resolve");
result = await run([{ ...click, tool: "navigate", args: { tabId: 1, url: "https://example.com" } }]);
assert.equal(result.ok, false, "schema stripping cannot silently discard dynamic target");
assert.equal(calls.length, 0);
assert.equal(injectTabId([click], 4)[0].target.selector, "#go");

const execution = await build({ stdin: { contents: "export * from './src/recipe-execution.ts'; export * from './src/recipe-checkpoints.ts'; export * from './src/workflow-control.ts'; export * from './src/run-history.ts';", resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "esm" });
const { checkpointFingerprint, startCheckpointRecipe, RecipeCheckpoints, WorkflowControl, RunHistory } = await import(`data:text/javascript;base64,${Buffer.from(execution.outputFiles[0].text).toString("base64")}`);
// A resumable recipe cannot carry a document-bound ref, also not inside fill_form.
for (const args of [{ tabId: 1, fields: [{ ref: "ref_3", value: "x" }] }, { tabId: 1, fields: [], submitRef: "ref_4" }])
  assert.throws(() => checkpointFingerprint([{ tool: "fill_form", args, expect: { text: "Sent" } }], 1), /fresh targets/, JSON.stringify(args));
assert.equal(typeof checkpointFingerprint([{ ...click, expect: { text: "Done" } }], 1), "string");

const checkpointDir = mkdtempSync(join(tmpdir(), "tabai-resume-stability-"));
try {
  const resumeSchemas = new Map([
    ["computer", z.object({ action: z.string(), tabId: z.number(), ref: z.string().optional(), documentId: z.string().optional() })],
    ["resolve_target", z.object({ tabId: z.number(), target: targetSchema })],
    ["wait_for", z.object({ tabId: z.number(), text: z.string().optional(), stableForMs: z.number().optional(), timeoutMs: z.number().optional() })],
  ]);
  const steps = [
    { tool: "computer", args: { tabId: 1, action: "left_click" }, target: { selector: "#first" }, expect: { text: "Ready", stableForMs: 2000 } },
    { tool: "computer", args: { tabId: 1, action: "left_click" }, target: { selector: "#second" }, expect: { text: "Finish" } },
  ];
  const waits = [], clicks = [];
  const page = async (tool, args) => {
    if (tool === "tabs_context_mcp") return { tabs: [{ tabId: 1, url: "https://example.test/resume" }] };
    if (tool === "resolve_target") return { ref: args.target.selector === "#first" ? "ref_1" : "ref_2", documentId: "doc-resume" };
    if (tool === "computer") { clicks.push(args.ref); return { ok: true }; }
    if (tool === "wait_for") {
      waits.push(args);
      // The extension samples about every 100 ms from its first poll, so a
      // stability window needs that much room inside the wait's own timeout.
      if ((args.stableForMs ?? 0) + 100 > (args.timeoutMs ?? 15_000)) throw new Error(`wait_for text timed out after ${args.timeoutMs}ms`);
      return { ok: true };
    }
    throw new Error(`Unexpected ${tool}`);
  };
  const store = new RecipeCheckpoints(checkpointDir), history = new RunHistory(join(checkpointDir, "runs"));
  const first = new WorkflowControl();
  let started;
  started = await startCheckpointRecipe({ store, history, workflows: first, actions: steps, tabId: 1, name: "stable-resume",
    deps: { schemas: resumeSchemas, call: async (tool, args) => {
      const result = await page(tool, args);
      if (tool === "wait_for" && args.text === "Ready") first.stop(started.runId);
      return result;
    } } });
  assert.equal((await started.done).structuredContent.status, "cancelled");
  assert.deepEqual(clicks, ["ref_1"]);
  waits.length = 0;
  const resumed = await startCheckpointRecipe({ store, history, workflows: new WorkflowControl(), actions: steps, tabId: 1,
    name: "stable-resume", resumeId: started.resumeId, deps: { schemas: resumeSchemas, call: page } });
  const response = await resumed.done;
  assert.equal(response.structuredContent.status, "succeeded", "a long stability window still revalidates");
  assert.deepEqual(clicks, ["ref_1", "ref_2"], "the verified first click is not replayed");
  const revalidation = waits[0];
  assert.equal(revalidation.text, "Ready");
  assert.ok(revalidation.stableForMs > 0 && revalidation.stableForMs < revalidation.timeoutMs, JSON.stringify(revalidation));
} finally { rmSync(checkpointDir, { recursive: true, force: true }); stopWatchdog(); }
console.log("=== workflow-validation: parameters, preflight, targets, observations, summaries, cancellation, diagnostic failures, fill_form refs and resume stability passed ===");
