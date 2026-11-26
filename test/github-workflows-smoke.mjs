// Read-only searches in the operator's real Chrome. Intentionally outside CI:
// GitHub layout, login state and network timing are external dependencies.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [reportPath, countText = "3"] = process.argv.slice(2);
const rounds = Number(countText);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, "rounds must be 1–10");
const recipe = JSON.parse(readFileSync(join(root, "test/fixtures/github-pr-search-recipe.json"), "utf8"));
const configDir = mkdtempSync(join(tmpdir(), "tabai-github-smoke-"));
const client = new Client({ name: "github-workflows-smoke", version: "0.0.0" });
const tabs = new Set();
const report = { startedAt: new Date().toISOString(), rounds, samples: [] };
let current;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    current = undefined;
    for (const tabId of tabs) await call("tabs_close_mcp", { tabId }).catch(() => {});
    await client.close();
    rmSync(configDir, { recursive: true, force: true });
  })();
}
const watchdog = setTimeout(() => {
  console.error("GitHub workflow smoke exceeded five minutes");
  setTimeout(() => process.exit(1), 5000);
  cleanup().finally(() => process.exit(1));
}, 300000);
async function call(name, args = {}) {
  if (current) current.mcpCalls++;
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError === true, false, `${name}: ${result.content?.[0]?.text}`);
  if (current && name === "navigate") current.navigation = JSON.parse(result.content[0].text);
  return result.content?.[0]?.text ?? "";
}
const evaluate = (tabId, text) => call("javascript_tool", { tabId, text });
const searchQuery = 'is:pr is:merged "completed Tabai migration" in:title';
const expectedTitle = "docs: record the completed Tabai migration and close the plan";
const resultSelector = 'a[href$="/NAlle33/tabai/pull/7"]';
async function verifyResult(tabId, query) {
  await call("wait_for", { tabId, selector: resultSelector, timeoutMs: 10000 });
  const result = JSON.parse(await evaluate(tabId,
    `({url:location.href,title:document.querySelector(${JSON.stringify(resultSelector)})?.textContent.trim()})`));
  assert.equal(new URL(result.url).searchParams.get("q"), query);
  assert.equal(result.title, expectedTitle);
  current.resultUrl = result.url;
  current.resultTitle = result.title;
}
async function searchPullRequests(tabId) {
  await call("navigate", { tabId, url: "https://github.com/NAlle33/tabai/pulls" });
  await call("wait_for", { tabId, selector: "#repo-pulls-dashboard-filter-input", timeoutMs: 10000 });
  const found = JSON.parse(await call("find", { tabId, query: "Search pull requests" })).matches;
  const ref = found.match(/\[(ref_\d+)\] (?:combobox|textbox) "Search pull requests"/)?.[1];
  assert.ok(ref, "search field was not found");
  await call("form_input", { tabId, ref, value: searchQuery });
  await call("computer", { tabId, ref, action: "left_click" });
  await call("computer", { tabId, action: "key", text: "Enter" });
  await verifyResult(tabId, searchQuery);
}
async function advancedSearch(tabId) {
  await call("navigate", { tabId, url: "https://github.com/search/advanced" });
  const page = JSON.parse(await call("read_page", { tabId, maxChars: 14000, maxResults: 180 })).elements;
  const queryRef = page.match(/\[(ref_\d+)\] textbox "Advanced search"/)?.[1];
  const repoRef = page.match(/\[(ref_\d+)\] textbox "In these repositories"/)?.[1];
  const submitRef = page.match(/\[(ref_\d+)\] button "Search"/)?.[1];
  assert.ok(queryRef && repoRef && submitRef, "advanced search controls were not found");
  const stateRef = await evaluate(tabId, "document.getElementById('search_state')?.getAttribute('data-ccmcp-ref')");
  assert.match(stateRef, /^ref_\d+$/);
  const query = 'is:pr "completed Tabai migration" in:title';
  const filled = JSON.parse(await call("fill_form", { tabId, fields: [
    { ref: queryRef, value: query }, { ref: repoRef, value: "NAlle33/tabai" },
  ] }));
  assert.ok(filled.ok && filled.results.every(result => result.ok), "one or more fields failed");
  await call("select_option", { tabId, ref: stateRef, value: "closed" });
  const fields = JSON.parse(await evaluate(tabId,
    `({query:document.querySelector('[data-ccmcp-ref="${queryRef}"]').value,repo:document.getElementById('search_repos').value,state:document.getElementById('search_state').value})`));
  assert.deepEqual(fields, { query, repo: "NAlle33/tabai", state: "closed" });
  await call("computer", { tabId, ref: submitRef, action: "left_click" });
  // GitHub advanced search opens Issues even with is:pr. Select its PR facet
  // through the actual UI before asserting the canonical pull-request result.
  await call("wait_for", { tabId, selector: 'a[href*="type=pullrequests"]', timeoutMs: 10000 });
  await call("read_page", { tabId, maxChars: 14000, maxResults: 180 });
  const facetRef = await evaluate(tabId,
    `[...document.querySelectorAll('a')].find(a=>new URL(a.href).searchParams.get('type')==='pullrequests')?.getAttribute('data-ccmcp-ref')`);
  assert.match(facetRef, /^ref_\d+$/);
  await call("computer", { tabId, ref: facetRef, action: "left_click" });
  await verifyResult(tabId, `${query} repo:NAlle33/tabai state:closed`);
}
async function savedRecipe(tabId) {
  const steps = JSON.parse(await call("recipe_run", { name: recipe.name, tabId }));
  current.recipeSteps = steps.length;
  assert.equal(steps.length, recipe.actions.length);
  for (const step of steps) assert.ok(step.ok, `${step.tool}: ${step.error}`);
  assert.ok(JSON.stringify(steps.at(-1).result).includes(expectedTitle), "recipe did not return the expected PR");
  await verifyResult(tabId, searchQuery);
}

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "dist/server.js")], cwd: root,
    env: { CCMCP_PORT: "9223", CCMCP_CLIENT_PORT: "9225", CCMCP_CONFIG_DIR: configDir },
  }));
  const context = JSON.parse(await call("tabs_context_mcp", { createIfEmpty: true }));
  for (const tab of context.tabs) tabs.add(tab.tabId);
  report.runtime = JSON.parse(await call("health"));
  await call("recipe_save", recipe);
  for (const [name, run] of [
    ["github-pr-search", searchPullRequests],
    ["github-advanced-search", advancedSearch],
    ["saved-github-recipe", savedRecipe],
  ]) {
    for (let round = 1; round <= rounds; round++) {
      const tab = JSON.parse(await call("tabs_create_mcp"));
      tabs.add(tab.tabId);
      assert.equal(tab.active, false, "each sample must start in a fresh inactive tab");
      current = { name, round, success: false, mcpCalls: 0, manualInterventions: 0 };
      const started = performance.now();
      try {
        await run(tab.tabId);
        const after = JSON.parse(await call("tabs_context_mcp"));
        assert.equal(after.tabs.find(t => t.tabId === tab.tabId)?.active, false, "workflow activated its tab");
        current.success = true;
      } catch (error) {
        current.error = error.message;
      }
      current.durationMs = Math.round(performance.now() - started);
      report.samples.push(current);
      console.log(JSON.stringify(current));
      current = undefined;
      await call("tabs_close_mcp", { tabId: tab.tabId });
      tabs.delete(tab.tabId);
    }
  }
} finally {
  await cleanup();
  clearTimeout(watchdog);
  report.finishedAt = new Date().toISOString();
  if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + "\n");
}
const failed = report.samples.filter(sample => !sample.success).length;
console.log(`GitHub workflows: ${report.samples.length - failed}/${report.samples.length} succeeded`);
process.exitCode = failed ? 1 : 0;
