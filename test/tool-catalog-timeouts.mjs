// Exercise actual SDK registrations and the workflow runner at the bridge boundary.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCatalog } from "../dist/tool-catalog.mjs";
import { RecipeStore } from "../dist/recipe-store.mjs";
import { RunHistory } from "../dist/run-history.mjs";
import { WorkflowControl } from "../dist/workflow-control.mjs";
import { recipeSchema } from "../dist/workflow-schema.mjs";
import { EXTENSION_VERSION } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(async () => { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
const dir = mkdtempSync(join(tmpdir(), "tabai-catalog-"));
const calls = [];
let failObservation = false;
let partialAction = false;
let extensionVersion = EXTENSION_VERSION;
const bridge = {
  connected: true, pendingCount: 0, configurePanel() {}, activity: () => ({ calls: [] }),
  async call(tool, args, timeoutMs) {
    calls.push({ tool, args, timeoutMs });
    if (tool === "health") return { extVersion: extensionVersion };
    if (tool === "wait_for" && failObservation) throw new Error("TIMEOUT: declared state never appeared");
    if (tool === "fill_form" && partialAction) return { ok: false, results: [{ ok: true }, { ok: false }] };
    return { ok: true };
  },
};
const server = new McpServer({ name: "catalog-timeouts", version: "1.0.0" });
const client = new Client({ name: "catalog-timeouts-test", version: "1.0.0" });
registerCatalog(server, { bridge, recipes: new RecipeStore(join(dir, "recipes.json"), value => recipeSchema.parse(value)),
  history: new RunHistory(join(dir, "runs")), workflows: new WorkflowControl(), tempUploads: new Set(), serverVersion: EXTENSION_VERSION });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let checked = 0;
  for (const mode of ["direct", "workflow"]) {
    for (const timeoutMs of [undefined, 1, 270000]) {
      for (const [tool, args, expected] of [
        ["download", { action: "arm", tabId: 1, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, mode === "direct" ? undefined : (timeoutMs ?? 30000) + 5000],
        ["download", { action: "collect", tabId: 1, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, (timeoutMs ?? 30000) + 5000],
        ["wait_for", { tabId: 1, selector: "body", ...(timeoutMs === undefined ? {} : { timeoutMs }) }, (timeoutMs ?? 15000) + 2000],
      ]) {
        calls.length = 0;
        const result = await client.callTool(mode === "direct" ? { name: tool, arguments: args }
          : { name: "browser_batch", arguments: { actions: [{ tool, args }] } });
        assert.ok(!result.isError, JSON.stringify(result));
        const dispatched = calls.filter(call => call.tool === tool);
        assert.equal(dispatched.length, 1, "dispatch exactly once");
        assert.equal(dispatched[0].timeoutMs, expected, `${mode} ${tool} ${args.action ?? ""} ${timeoutMs}`);
        checked++;
      }
    }
  }
  for (const [tool, args] of [
    ["computer", { tabId: 1, action: "left_click", ref: "ref_1" }],
    ["form_input", { tabId: 1, ref: "ref_1", value: "typed" }],
    ["fill_form", { tabId: 1, fields: [{ ref: "ref_1", value: "typed" }] }],
    ["select_option", { tabId: 1, ref: "ref_1", value: "b" }],
  ]) {
    for (const fail of [false, true]) {
      calls.length = 0; failObservation = fail;
      const result = await client.callTool({ name: tool, arguments: { ...args, expect: { selector: "#dialog", state: "hidden", timeoutMs: 200, stableForMs: 50 } } });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(result.isError === true, fail);
      assert.equal(payload.actionState, "completed");
      assert.equal(payload.outcome.status, fail ? "unverified" : "verified");
      assert.equal(calls.filter(call => call.tool === tool).length, 1, "postcondition never repeats mutation");
      assert.equal(calls.filter(call => call.tool === "wait_for").length, 1);
      assert.equal(calls.find(call => call.tool === tool).args.expect, undefined, "expect is host-owned");
      assert.equal(calls.find(call => call.tool === "wait_for").args.state, "hidden");
      checked++;
    }
  }
  failObservation = false;
  for (const args of [
    { tabId: 1, ref: "ref_1", value: "x", expect: { predicate: "true", state: "hidden" } },
    { tabId: 1, ref: "ref_1", value: "x", expect: { text: "x", stableForMs: -1 } },
    { tabId: 1, ref: "ref_1", value: "x", expect: { text: "   " } },
    { tabId: 1, ref: "ref_1", value: "x", expect: { fieldValue: { selector: "#x", value: { $param: "missing" } } } },
  ]) {
    calls.length = 0;
    const result = await client.callTool({ name: "form_input", arguments: args });
    assert.ok(result.isError); assert.equal(calls.length, 0, "invalid expectation rejected before any call"); checked++;
  }
  calls.length = 0; extensionVersion = "0.1.0";
  const stale = await client.callTool({ name: "form_input", arguments: { tabId: 1, ref: "ref_1", value: "x", expect: { text: "saved" } } });
  assert.ok(stale.isError); assert.deepEqual(calls.map(call => call.tool), ["health"]); checked++;
  extensionVersion = EXTENSION_VERSION;
  calls.length = 0; partialAction = true;
  const partial = await client.callTool({ name: "fill_form", arguments: { tabId: 1, fields: [{ ref: "ref_1", value: "x" }], expect: { text: "saved" } } });
  assert.ok(partial.isError); assert.equal(calls.filter(call => call.tool === "wait_for").length, 0); checked++;
  partialAction = false;
  for (const both of [false, true]) {
    calls.length = 0;
    const result = await client.callTool({ name: "browser_batch", arguments: { actions: [{ tool: "form_input", args: { tabId: 1, ref: "ref_1", value: "x", expect: { text: "saved" } }, ...(both ? { expect: { text: "other" } } : {}) }] } });
    assert.equal(result.isError === true, both);
    assert.equal(calls.filter(call => call.tool === "form_input").length, both ? 0 : 1);
    assert.equal(calls.filter(call => call.tool === "wait_for").length, both ? 0 : 1); checked++;
  }
  console.log(`tool-catalog-timeouts: ${checked} actual direct/workflow callouts PASS`);
} finally {
  await client.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
