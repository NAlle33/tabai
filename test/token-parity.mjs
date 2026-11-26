import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(tokenHome, { recursive: true, force: true }));
const tokenHome = mkdtempSync(join(tmpdir(), "ccmcp-token-test-"));
try {
  mkdirSync(join(tokenHome, ".claude-chrome-mcp"));
  const tokenFile = join(tokenHome, ".claude-chrome-mcp", "bridge-token");
  const code = `import assert from 'node:assert/strict'; import { resolveToken as server } from './dist/auth.mjs'; import { resolveToken as helper } from './scripts/resolve-token.mjs'; assert.equal(server(),helper()); assert.equal(server(),process.env.CCMCP_EXPECTED_TOKEN);`;
  for (const [file, envToken, expected] of [["file-fixture", "env-fixture", "env-fixture"], ["file-fixture", "", "file-fixture"], [null, "", ""]]) {
    if (file === null) rmSync(tokenFile, { force: true }); else writeFileSync(tokenFile, file + "\n", { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, HOME: tokenHome, USERPROFILE: tokenHome, BRIDGE_TOKEN: envToken, CCMCP_EXPECTED_TOKEN: expected }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, "server/helper token resolution disagreed");
  }
} finally { rmSync(tokenHome, { recursive: true, force: true }); }
console.log("=== token-parity: env / file / neither passed ===");
stopWatchdog();
