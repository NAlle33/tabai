// Direct calls and workflows deliberately differ for download arm.
import assert from "node:assert/strict";
import { bridgeTimeoutFor } from "../dist/tool-timeouts.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const cases = [
  ["wait_for", {}, 17000],
  ["wait_for", { timeoutMs: 1 }, 2001],
  ["wait_for", { timeoutMs: 270000 }, 272000],
  ["navigate", {}, 35000],
  ["tab_reload", {}, 35000],
  ["gif_creator", { action: "export" }, 90000],
  ["gif_creator", { action: "start_recording" }, undefined],
  ["computer", { action: "screenshot" }, undefined],
  ["health", {}, undefined],
  ["download", { action: "collect" }, 35000],
  ["download", { action: "collect", timeoutMs: 1 }, 5001],
  ["download", { action: "collect", timeoutMs: 270000 }, 275000],
];
for (const source of ["direct", "workflow"]) {
  for (const [tool, args, expected] of cases) {
    assert.equal(bridgeTimeoutFor(source, tool, args), expected, `${source} ${tool} ${JSON.stringify(args)}`);
  }
}
for (const timeoutMs of [undefined, 1, 270000]) {
  const args = { action: "arm", timeoutMs };
  assert.equal(bridgeTimeoutFor("direct", "download", args), undefined);
  assert.equal(bridgeTimeoutFor("workflow", "download", args), (timeoutMs ?? 30000) + 5000);
}
stopWatchdog();
console.log("=== tool-timeouts: direct/workflow budgets and arm/collect contracts pass ===");
