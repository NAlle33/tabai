import assert from "node:assert/strict";
import { intEnv } from "../dist/env.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
for (const [raw, min, expected] of [["0", 1, 7], ["0", 0, 0], ["abc", 0, 7], [undefined, 0, 7], ["", 0, 7], ["101", 0, 7], ["1.5", 0, 7], ["42", 0, 42]]) {
  if (raw === undefined) delete process.env.CCMCP_TEST_INTEGER; else process.env.CCMCP_TEST_INTEGER = raw;
  assert.equal(intEnv("CCMCP_TEST_INTEGER", 7, min, 100), expected);
}
delete process.env.CCMCP_TEST_INTEGER;
console.log("=== num-env: 8 cases passed ===");
stopWatchdog();
