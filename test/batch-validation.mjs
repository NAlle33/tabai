// Chrome-free test for the browser_batch / recipe_run semantics in
// src/tool-orchestration.ts: every step is validated with its tool's own schema
// and FAILS CLOSED when none is recorded; binary results are never inlined;
// pdf/gif results are saved like the direct tools; a cancelled batch stops.
// Uses a fake bridge `call` + a small schema map (the real map is proven complete
// by the server's startup assertion + tool-names-consistency).
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(configDir, { recursive: true, force: true }));

// The store location is read at import time — point it at a temp dir FIRST.
const configDir = mkdtempSync(join(tmpdir(), "ccmcp-batchtest-"));
process.env.CCMCP_CONFIG_DIR = configDir;
const { runActions, stepTimeout, summarizeBinary, injectTabId, BATCH_MAX_STEPS } = await import(
  "../dist/tool-orchestration.mjs"
);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const schemas = new Map([
  ["navigate", z.object({ url: z.string(), tabId: z.number() })],
  ["wait_for", z.object({ tabId: z.number(), timeoutMs: z.number().int().positive().max(270_000).optional() })],
  ["computer", z.object({ action: z.string(), tabId: z.number(), repeat: z.number().int().min(1).max(200).optional(),
    pointerMode: z.enum(["synthetic", "browser"]).optional(), coordinate: z.array(z.number()).optional() })],
  ["screenshot", z.object({ tabId: z.number() })],
  ["print_to_pdf", z.object({ tabId: z.number() })],
  ["gif_creator", z.object({ action: z.string(), tabId: z.number() })],
  ["tabs_create_mcp", z.object({})],
  ["download", z.object({ action: z.string(), tabId: z.number(), timeoutMs: z.number().optional() })],
  ["javascript_tool", z.object({ text: z.string(), tabId: z.number() })],
  // read_page deliberately NOT in the map → fail-closed case below
]);
const calls = [];
const makeCall =
  (reply = () => ({ echoed: true })) =>
  async (tool, args, timeoutMs) => {
    calls.push({ tool, args, timeoutMs });
    const r = reply(tool, args);
    if (r instanceof Error) throw r;
    return r;
  };
const run = (actions, opts = {}) => {
  calls.length = 0;
  return runActions(actions, { call: makeCall(opts.reply), schemas, signal: opts.signal });
};

// 1. unknown / non-batchable tool stops the batch before any call.
{
  const r = await run([{ tool: "recipe_run", args: {} }, { tool: "navigate", args: { url: "x", tabId: 1 } }]);
  check("unknown tool → error, nothing called", r.length === 1 && r[0].ok === false && /non-batchable/.test(r[0].error) && calls.length === 0, JSON.stringify(r));
}
// 2. a tool with NO recorded schema fails closed (never runs unvalidated).
{
  const r = await run([{ tool: "read_page", args: { tabId: 1 } }]);
  check("missing schema → fails closed, not called", r[0].ok === false && /no input schema/.test(r[0].error) && calls.length === 0, r[0].error);
}
// 3. schema violations are reported by field and stop the batch.
{
  const r = await run([
    { tool: "wait_for", args: { tabId: 1, timeoutMs: "30000" } },
    { tool: "navigate", args: { url: "x", tabId: 1 } },
  ]);
  check("wait_for timeoutMs as a string → invalid, names the field, stops", r.length === 1 && r[0].ok === false && /timeoutMs/.test(r[0].error) && calls.length === 0, r[0].error);
  const r2 = await run([{ tool: "computer", args: { action: "key", tabId: 1, repeat: 1e9 } }]);
  check("computer repeat 1e9 → invalid", r2[0].ok === false && /repeat/.test(r2[0].error), r2[0].error);
  const r3 = await run([{ tool: "navigate", args: { url: "x" } }]);
  check("missing required tabId → invalid", r3[0].ok === false && /tabId/.test(r3[0].error), r3[0].error);
}
// 4. the bridge receives the PARSED args (unknown keys stripped, like a direct call).
{
  await run([{ tool: "tabs_create_mcp", args: { tabId: 5 } }]);
  check("unknown keys stripped before the call", calls.length === 1 && !("tabId" in calls[0].args), JSON.stringify(calls[0]?.args));
}
// 5. image results are summarized — no base64 leaves the batch.
{
  const b64 = Buffer.from("pngbytes-here").toString("base64");
  const r = await run([{ tool: "screenshot", args: { tabId: 1 } }], {
    reply: () => ({ kind: "image", base64: b64, mimeType: "image/png", source: "cdp" }),
  });
  const res = r[0].result;
  check(
    "image result → {kind, mimeType, bytes, source, note} without base64",
    r[0].ok && res.kind === "image" && !("base64" in res) && res.bytes === 13 && res.source === "cdp" && /binary omitted/.test(res.note),
    JSON.stringify(res),
  );
  check("JSON of the step has no base64 payload", !JSON.stringify(r).includes(b64));
}
// 6. pdf / gif results are saved under the (temp) config dir; the path is returned.
{
  const pdfB64 = Buffer.from("%PDF-1.4 fake").toString("base64");
  const r = await run([{ tool: "print_to_pdf", args: { tabId: 1 } }], { reply: () => ({ kind: "pdf", base64: pdfB64 }) });
  const p = r[0].result?.path ?? "";
  check("pdf result saved under CCMCP_CONFIG_DIR/pdfs", p.startsWith(join(configDir, "pdfs")) && existsSync(p) && readFileSync(p, "utf8").startsWith("%PDF-"), p);
  const gifB64 = Buffer.from("GIF89a fake").toString("base64");
  const g = await run([{ tool: "gif_creator", args: { action: "export", tabId: 1 } }], { reply: () => ({ kind: "gif", base64: gifB64, frames: 3 }) });
  const gp = g[0].result?.path ?? "";
  check("gif result saved under CCMCP_CONFIG_DIR/gifs with frames", gp.startsWith(join(configDir, "gifs")) && existsSync(gp) && g[0].result.frames === 3, gp);
}
// 7. a failing call stops the batch with its error; later steps never run.
{
  const r = await run(
    [{ tool: "navigate", args: { url: "x", tabId: 1 } }, { tool: "navigate", args: { url: "y", tabId: 1 } }],
    { reply: (t, a) => (a.url === "x" ? new Error("TAB_NOT_FOUND: gone") : { ok: true }) },
  );
  check("failing call → {ok:false,error}, batch stops", r.length === 1 && r[0].ok === false && /TAB_NOT_FOUND/.test(r[0].error) && calls.length === 1);
}
for (const failure of [
  { ok: false, armed: false, error: "could not persist the download arm" },
  { ok: false, armed: false, note: "another session is capturing a download" },
  // The call succeeded but nothing was armed: the click after it would start a download that is not this session's capture.
  { ok: true, armed: false, note: "this session's download has finished and its result is waiting — call collect next; do not trigger it again" },
]) {
  const r = await run([
    { tool: "download", args: { action: "arm", tabId: 1 } },
    { tool: "computer", args: { action: "left_click", tabId: 1 } },
  ], { reply: () => failure });
  check("rejected download arm stops before the triggering click", r.length === 1 && r[0].ok === false && r[0].error === (failure.error ?? failure.note) && calls.length === 1);
}
{
  const value = { ok: false, error: "business record" };
  const r = await run([
    { tool: "javascript_tool", args: { text: "({ok:false,error:'business record'})", tabId: 1 } },
    { tool: "tabs_create_mcp", args: {} },
  ], { reply: tool => tool === "javascript_tool" ? value : { ok: true } });
  check("page-returned ok:false is ordinary JavaScript data", r.length === 2 && r[0].ok && r[0].result === value && calls.length === 2);
}
// 8. cancellation after dispatch is terminal even when it was the final step.
{
  const ac = new AbortController();
  const r = await run(
    [{ tool: "navigate", args: { url: "a", tabId: 1 } }, { tool: "navigate", args: { url: "b", tabId: 1 } }],
    {
      reply: () => {
        ac.abort();
        return { ok: true };
      },
      signal: ac.signal,
    },
  );
  check("abort signal → in-flight step reports cancellation, no next call", r.length === 1 && r[0].ok === false && /cancelled/.test(r[0].error) && calls.length === 1);
}
// 9. bridge-timeout margins mirror the direct registrations.
check("stepTimeout wait_for default +2000", stepTimeout("wait_for", {}) === 17_000);
check("stepTimeout wait_for explicit +2000", stepTimeout("wait_for", { timeoutMs: 60_000 }) === 62_000);
check("stepTimeout download default +5000", stepTimeout("download", {}) === 35_000);
check("stepTimeout navigate/tab_reload 35s", stepTimeout("navigate", {}) === 35_000 && stepTimeout("tab_reload", {}) === 35_000);
check("stepTimeout others → bridge default", stepTimeout("computer", {}) === undefined);
// 10. recipe tabId injection covers arg-less steps and never overrides an explicit tabId.
{
  const inj = injectTabId([{ tool: "get_page_text" }, { tool: "navigate", args: { url: "x", tabId: 9 } }, { tool: "find", args: { query: "q" } }], 4);
  check(
    "injectTabId fills arg-less + tabId-less steps only",
    inj[0].args.tabId === 4 && inj[1].args.tabId === 9 && inj[2].args.tabId === 4 && inj[2].args.query === "q",
    JSON.stringify(inj),
  );
  check("injectTabId without a default leaves steps untouched", injectTabId([{ tool: "get_page_text" }], undefined)[0].args === undefined);
}
// 11. non-binary results pass through untouched; the cap constant is 50.
check("summarizeBinary passes plain results through", summarizeBinary({ ok: true, x: 1 }).x === 1 && summarizeBinary("s") === "s");
check("batch cap is 50 steps", BATCH_MAX_STEPS === 50);
// 12. a trusted pointer step needs the extension's declared capability before ANY dispatch.
{
  const pointerStep = { tool: "computer", args: { action: "left_click", tabId: 1, pointerMode: "browser", coordinate: [10, 10] } };
  const leading = { tool: "navigate", args: { url: "x", tabId: 1 } };
  const r = await run([leading, pointerStep], { reply: tool => tool === "health" ? { extVersion: "9.9.9", capabilities: { diagnostics: 1 } } : { ok: true } });
  check("pointer step without browserPointer → refused before the first dispatch",
    r.length === 1 && r[0].ok === false && /browser pointer/.test(r[0].error) && calls.every(c => c.tool === "health"), JSON.stringify(calls.map(c => c.tool)));
  const ok = await run([leading, pointerStep], { reply: tool => tool === "health" ? { capabilities: { browserPointer: 1 } } : { ok: true } });
  check("pointer step with browserPointer → dispatched once with its mode",
    ok.length === 2 && ok.every(step => step.ok) && calls.filter(c => c.tool === "computer").length === 1 &&
    calls.find(c => c.tool === "computer").args.pointerMode === "browser", JSON.stringify(calls.map(c => c.tool)));
  const synthetic = await run([{ tool: "computer", args: { action: "left_click", tabId: 1, coordinate: [10, 10] } }]);
  check("synthetic pointer step needs no capability probe", synthetic[0].ok && calls.every(c => c.tool !== "health"));
}
// 13. browser_batch and recipe_run through the actual registered catalog.
{
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerCatalog } = await import("../dist/tool-catalog.mjs");
  const { RecipeStore } = await import("../dist/recipe-store.mjs");
  const { RunHistory } = await import("../dist/run-history.mjs");
  const { WorkflowControl } = await import("../dist/workflow-control.mjs");
  const { recipeSchema } = await import("../dist/workflow-schema.mjs");
  const { EXTENSION_VERSION } = await import("../dist/protocol.mjs");
  const bridgeCalls = [];
  let capabilities = { diagnostics: 1 };
  const bridge = {
    connected: true, pendingCount: 0, configurePanel() {}, activity: () => ({ calls: [] }),
    async call(tool, args) {
      bridgeCalls.push({ tool, args });
      return tool === "health" ? { extVersion: EXTENSION_VERSION, capabilities } : { ok: true };
    },
  };
  const server = new McpServer({ name: "batch-validation", version: "1.0.0" });
  const client = new Client({ name: "batch-validation-test", version: "1.0.0" });
  registerCatalog(server, { bridge, recipes: new RecipeStore(join(configDir, "recipes.json"), value => recipeSchema.parse(value)),
    history: new RunHistory(join(configDir, "runs")), workflows: new WorkflowControl(), tempUploads: new Set(), serverVersion: EXTENSION_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const pointerStep = { tool: "computer", args: { tabId: 1, action: "left_click", pointerMode: "browser", ref: "ref_1" } };
    const leading = { tool: "form_input", args: { tabId: 1, ref: "ref_2", value: "first" } };
    bridgeCalls.length = 0;
    const batch = await client.callTool({ name: "browser_batch", arguments: { actions: [leading, pointerStep] } });
    check("browser_batch pointer step without the capability → refused before any dispatch",
      batch.isError === true && /browser pointer/.test(batch.content[0].text) && bridgeCalls.every(c => c.tool === "health"), JSON.stringify(bridgeCalls.map(c => c.tool)));
    await client.callTool({ name: "recipe_save", arguments: { name: "pointer-recipe", actions: [leading, pointerStep] } });
    bridgeCalls.length = 0;
    const recipe = await client.callTool({ name: "recipe_run", arguments: { name: "pointer-recipe" } });
    check("recipe_run pointer step without the capability → refused before any dispatch",
      recipe.isError === true && /browser pointer/.test(recipe.content[0].text) && bridgeCalls.every(c => c.tool === "health"), JSON.stringify(bridgeCalls.map(c => c.tool)));
    capabilities = { diagnostics: 1, browserPointer: 1 };
    bridgeCalls.length = 0;
    const allowed = await client.callTool({ name: "browser_batch", arguments: { actions: [leading, pointerStep] } });
    check("browser_batch pointer step with the capability → each step dispatched once",
      !allowed.isError && bridgeCalls.filter(c => c.tool === "computer").length === 1 && bridgeCalls.filter(c => c.tool === "form_input").length === 1);
    const literal = "Hej {{first_name}}";
    bridgeCalls.length = 0;
    const plain = await client.callTool({ name: "browser_batch", arguments: { actions: [
      { tool: "form_input", args: { tabId: 1, ref: "ref_2", value: literal } },
      { tool: "find", args: { tabId: 1, query: "{{query}}" } },
    ] } });
    check("browser_batch passes {{word}} text unchanged, as a direct call does",
      !plain.isError && bridgeCalls.find(c => c.tool === "form_input")?.args.value === literal &&
      bridgeCalls.find(c => c.tool === "find")?.args.query === "{{query}}", plain.content?.[0]?.text?.slice(0, 200));
    await client.callTool({ name: "recipe_save", arguments: { name: "greeting", parameters: { first_name: { type: "string" } },
      actions: [{ tool: "form_input", args: { tabId: 1, ref: "ref_2", value: literal } }] } });
    bridgeCalls.length = 0;
    const greeted = await client.callTool({ name: "recipe_run", arguments: { name: "greeting", parameters: { first_name: "Anna" } } });
    check("recipes still bind {{word}} parameters", !greeted.isError && bridgeCalls.find(c => c.tool === "form_input")?.args.value === "Hej Anna");
  } finally {
    await client.close();
    await server.close();
  }
}

rmSync(configDir, { recursive: true, force: true });
check("gif export uses 90s in a batch", stepTimeout("gif_creator", { action: "export" }) === 90000);
console.log(`\n=== batch-validation: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
