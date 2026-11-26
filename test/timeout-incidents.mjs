import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const compiled = await build({ entryPoints: ["src/timeout-incidents.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { TimeoutIncidents } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const dir = mkdtempSync(join(tmpdir(), "tabai-incidents-"));
const file = join(dir, "timeout-incidents.json");
try {
  const store = new TimeoutIncidents(dir);
  const brokerBuild = `sha256:${"b".repeat(64)}`, extensionBuild = `sha256:${"e".repeat(64)}`;
  const id = await store.capture("computer", 1000, 1000, brokerBuild, async () => ({ buildId: extensionBuild, secret: "private-page",
    diagnostics: { active: [{ id: 1, operation: "scripting.executeScript", startedAt: 1, durationMs: 999, status: "pending", args: "private-page" }], recent: [], dropped: 0, degraded: false, page: "private-page" },
  }));
  const saved = new TimeoutIncidents(dir).get(id);
  assert.equal(saved.operations.active[0].operation, "scripting.executeScript");
  assert.equal(saved.brokerBuildId, brokerBuild);
  assert.doesNotMatch(readFileSync(file, "utf8"), /private-page|secret|args/);
  assert.equal(saved.diagnosticsAvailable, true);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const unavailable = await store.capture("navigate", 1000, 1000, undefined, async () => { throw new Error("private-error"); });
  assert.equal(store.get(unavailable).diagnosticsAvailable, false);
  const invalid = await store.capture("navigate", 1000, 1000, undefined, async () => ({ diagnostics: { active: [{ operation: "private-page" }], recent: [], dropped: 0, degraded: false } }));
  assert.equal(store.get(invalid).diagnosticsAvailable, false);
  const invalidBuild = await store.capture("wait_for", 1, 1, "private-broker-data", async () => ({ buildId: "private-extension-data" }));
  assert.equal(store.get(invalidBuild).extensionBuildId, undefined);
  assert.equal(store.get(invalidBuild).brokerBuildId, undefined);
  assert.equal(await store.capture("private-tool-name", 1, 1, undefined, async () => { throw new Error("must not probe"); }), undefined);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let probes = 0;
  const captures = Array.from({ length: 4 }, () => store.capture("wait_for", 1, 1, undefined, async () => { probes++; await held; return {}; }));
  const capped = await store.capture("wait_for", 1, 1, undefined, async () => { throw new Error("probe capacity must be bounded"); });
  assert.equal(store.get(capped).diagnosticsAvailable, false, "capacity preserves minimal evidence instead of losing the timeout");
  assert.equal(probes, 4);
  release(); await Promise.all(captures);
  for (let index = 0; index < 50; index++) await store.capture("wait_for", 1000, 1000, undefined, async () => ({}));
  assert.equal(store.list(50).length, 50);
  assert.throws(() => store.get(id), /No timeout incident/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /private-/);
  writeFileSync(file, "{corrupt");
  await assert.rejects(store.capture("wait_for", 1, 1, undefined, async () => ({})), /Invalid or unreadable/);
  assert.equal(readFileSync(file, "utf8"), "{corrupt");
  console.log("Timeout incidents: persistence, bounded retention, private metadata, unavailable evidence and corrupt-store preservation passed");
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
