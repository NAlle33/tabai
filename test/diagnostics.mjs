import assert from "node:assert/strict";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const compiled = await build({ entryPoints: ["extension/src/diagnostics.ts"], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
const { traceOperation, diagnosticSnapshot, bindDiagnosticTab, traceTab, reapDiagnostics, executeScript } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const originalNow = Date.now;
let now = 1000;
Date.now = () => now;
try {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const task = traceOperation("session-a", "presence.render", () => gate, { tabId: 11, budgetMs: 250, password: "private-fixture-value" });
  now += 400;
  const waiting = diagnosticSnapshot("session-a");
  assert.equal(waiting.active.length, 1); assert.equal(waiting.active[0].operation, "presence.render");
  assert.equal(waiting.active[0].durationMs, 400); assert.equal(waiting.degraded, true);
  assert.deepEqual(diagnosticSnapshot("session-b").active, []);
  assert.doesNotMatch(JSON.stringify(waiting), /private-fixture-value|password/);
  waiting.active[0].operation = "changed by caller";
  assert.equal(diagnosticSnapshot("session-a").active[0].operation, "presence.render");
  const value = { pageText: "private-fixture-value" };
  release(value); assert.equal(await task, value);
  assert.equal(diagnosticSnapshot("session-a").active.length, 0);
  assert.doesNotMatch(JSON.stringify(diagnosticSnapshot("session-a")), /private-fixture-value|pageText/);

  const error = Object.assign(new Error("private-fixture-value"), { code: "TAB_NOT_IN_GROUP" });
  await assert.rejects(traceOperation("session-a", "ownership.check", async () => { throw error; }), e => e === error);
  assert.equal(diagnosticSnapshot("session-a").recent[0].errorCode, "TAB_NOT_IN_GROUP");
  await assert.rejects(traceOperation("session-a", "tool.execute", async () => { throw { code: "private-fixture-value" }; }));
  assert.equal(diagnosticSnapshot("session-a").recent[0].errorCode, "TOOL_ERROR");
  await assert.rejects(traceOperation("session-a", "tool.execute", async () => { throw { code: "PRIVATE_FIXTURE_VALUE" }; }));
  assert.equal(diagnosticSnapshot("session-a").recent[0].errorCode, "TOOL_ERROR", "arbitrary uppercase values are still page data, not approved error classifications");
  for (let i = 0; i < 30; i++) await traceOperation("session-a", "tabs.get", async () => i);
  assert.equal(diagnosticSnapshot("session-a").recent.length, 20);

  let unlock;
  const held = new Promise(resolve => { unlock = resolve; });
  let executions = 0;
  const many = Array.from({ length: 100 }, () => traceOperation("bounded", "tool.execute", () => { executions++; return held; }));
  assert.equal(diagnosticSnapshot("bounded").active.length, 96);
  assert.equal(diagnosticSnapshot("bounded").dropped, 4); assert.equal(executions, 100);
  reapDiagnostics("bounded"); unlock(); await Promise.all(many);
  assert.deepEqual(diagnosticSnapshot("bounded").recent, []);

  bindDiagnosticTab("session-b", 21);
  let finishScript;
  const script = new Promise(resolve => { finishScript = resolve; });
  const injection = { target: { tabId: 21 }, func: () => "private-fixture-value", args: ["private-fixture-value"] };
  globalThis.chrome = { scripting: { executeScript: options => { assert.equal(options, injection); return script; } } };
  const running = executeScript(injection);
  assert.equal(diagnosticSnapshot("session-b").active[0].operation, "scripting.executeScript");
  assert.doesNotMatch(JSON.stringify(diagnosticSnapshot("session-b")), /private-fixture-value/);
  finishScript([{ result: "private-fixture-value" }]);
  assert.equal((await running)[0].result, "private-fixture-value");
  await traceTab(999, "tabs.get", async () => "unbound");
  console.log("Diagnostics: pending stages, elapsed time, isolation, privacy, bounds, cleanup and native forwarding passed");
} finally { Date.now = originalNow; delete globalThis.chrome; stopWatchdog(); }
