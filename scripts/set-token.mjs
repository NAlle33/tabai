// Opt-in client-port hardening: generate a random token + write it 0600 to
// ~/.claude-chrome-mcp/bridge-token. With the file present, only same-user
// processes that can read it (the MCP server + broker) connect to the client port
// (:9225) — closing the casual rogue-client door with zero further config. Absent
// file + empty BRIDGE_TOKEN = the default no-auth posture (unchanged). After
// running, restart the broker so it picks up the token: npm run kill-broker.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const tokenPath = join(homedir(), ".claude-chrome-mcp", "bridge-token");
mkdirSync(dirname(tokenPath), { recursive: true });
writeFileSync(tokenPath, randomBytes(24).toString("hex"), { mode: 0o600 });
// chmod again for idempotent re-runs (mode on writeFileSync only applies at
// creation). No-op on Windows, where the user-profile ACL on ~ is the protection.
try {
  chmodSync(tokenPath, 0o600);
} catch {
  /* Windows: POSIX modes unsupported; profile-dir ACL protects it */
}
console.log(`wrote ${tokenPath} (0600 on POSIX; on Windows the user-profile ACL protects it)`);
console.log("restart the broker to apply: npm run kill-broker");
