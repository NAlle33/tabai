import assert from "node:assert/strict";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
async function load(entry, plugin) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    define: { __CCMCP_BUILD_ID__: JSON.stringify("sha256:test-server") }, plugins: plugin ? [plugin] : [] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { collectHealth, panelDiagnostics } = await load("src/health.ts");
const bridge = { connected: true, pendingCount: 2, async call(tool, args, timeout) {
  assert.equal(tool, "health"); assert.deepEqual(args, {}); assert.equal(timeout, 1500);
  return { extVersion: "0.15.0", buildId: "sha256:test-server", diagnostics: { active: [], recent: [], dropped: 0, degraded: false } };
} };
assert.equal((await collectHealth(bridge, "0.15.0")).serverBuildId, "sha256:test-server");
assert.equal(panelDiagnostics(await collectHealth(bridge, "0.15.0")).buildMismatch, false);
const completeChain = await collectHealth({ ...bridge, brokerBuildId: "sha256:test-server" }, "0.16.0");
assert.equal(completeChain.brokerBuildStatus, "matching");
assert.deepEqual(completeChain.refresh, []);
const staleBroker = await collectHealth({ ...bridge, brokerBuildId: "sha256:old-broker" }, "0.16.0");
assert.equal(staleBroker.buildMismatch, true);
assert.deepEqual(staleBroker.refresh, ["broker"]);
assert.equal(panelDiagnostics(staleBroker).brokerBuildId, "sha256:old-broker");
assert.equal((await collectHealth(bridge, "0.16.0")).brokerBuildStatus, "unknown");
const mismatch = await collectHealth({ ...bridge, call: async () => ({ extVersion: "0.14.1", buildId: "older" }) }, "0.15.0");
assert.equal(mismatch.buildMismatch, true); assert.equal(mismatch.staleExtension, true);
assert.equal(panelDiagnostics(mismatch).available, false);
assert.equal((await collectHealth({ ...bridge, connected: false, call: () => { throw new Error("must not call"); } }, "0.15.0")).extension, "disconnected");
assert.match((await collectHealth({ ...bridge, call: async () => { throw new Error("unavailable"); } }, "0.15.0")).extension.error, /unavailable/);

let release, reads = 0;
const held = new Promise(resolve => { release = resolve; });
globalThis.healthFixture = {
  async getGroupId(session) { reads++; return session === "held" ? held : 3; },
  async tabsInGroup() { return [{ id: 10 }, { id: 11 }]; },
  attachedTabIds() { return [10, 99]; },
};
globalThis.chrome = { runtime: { getManifest: () => ({ version: "0.15.0" }) } };
const { extensionHealth, reapHealth } = await load("extension/src/health.ts", { name: "health-boundaries", setup(build) {
  build.onResolve({ filter: /^\.\/(cdp|tab-group-helpers)$/ }, args => ({ path: args.path, namespace: "health-test" }));
  build.onLoad({ filter: /.*/, namespace: "health-test" }, args => ({ contents: args.path === "./cdp"
    ? "export const attachedTabIds = () => globalThis.healthFixture.attachedTabIds();"
    : "export const lookupGroupId = s => globalThis.healthFixture.getGroupId(s); export const tabsInGroup = g => globalThis.healthFixture.tabsInGroup(g);" }));
} });
try {
  const healthy = await extensionHealth("own");
  assert.deepEqual(healthy.attachedTabs, [10], "foreign attached tabs must never leak");
  assert.equal(healthy.buildId, "sha256:test-server");
  const [first, second] = await Promise.all([extensionHealth("held"), extensionHealth("held")]);
  assert.equal(first.inspection, "unavailable"); assert.equal(second.inspection, "unavailable");
  assert.equal(reads, 2, "concurrent health polls share one inspection");
  assert.equal((await extensionHealth("held")).inspection, "unavailable");
  assert.equal(reads, 2, "a timed-out Chrome read must not accumulate with polling");
  release(3); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await extensionHealth("held")).inspection, "available");
  reapHealth("held");
  console.log("Health diagnostics: build mismatch, stale peers, unavailable Chrome, coalesced polling and session privacy passed");
} finally { delete globalThis.chrome; delete globalThis.healthFixture; stopWatchdog(); }
