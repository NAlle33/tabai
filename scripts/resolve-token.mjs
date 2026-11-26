// Shared token resolution for the raw-ws dev/diagnostic helpers (reload-extension,
// doctor stale-probe, the extension-reload test). Mirrors src/auth.ts resolveToken
// so these helpers still reach the client port when the OPT-IN token is set —
// otherwise the broker refuses the upgrade (HTTP 401) and `npm run reload` / doctor hang.
// BRIDGE_TOKEN env → 0600 token file → "" (no-auth default, unchanged).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try {
    return readFileSync(join(homedir(), ".claude-chrome-mcp", "bridge-token"), "utf8").trim();
  } catch {
    return ""; // no file → no-auth default
  }
}

/** ws URL for the broker client port, carrying the token as ?token= when set. */
export function clientWsUrl(port) {
  const t = resolveToken();
  return `ws://127.0.0.1:${port}${t ? `?token=${encodeURIComponent(t)}` : ""}`;
}
