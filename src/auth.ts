// Optional client-port auth token (node-only). The token stays OPTIONAL: empty by
// default. Opt in with `npm run set-token`, which writes a 0600 file here; the
// BRIDGE_TOKEN env still takes precedence. Empty env + no file = the no-auth
// default (unchanged). Used by the server (BridgeClient) AND the broker's client
// port so they match with ZERO further config; the extension port (:9223) keeps
// using BRIDGE_TOKEN env only (the popup field).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_PATH = join(homedir(), ".claude-chrome-mcp", "bridge-token");
export const EXTENSION_ID_PATH = join(homedir(), ".claude-chrome-mcp", "extension-id");

export function resolveToken(): string {
  const env = process.env.BRIDGE_TOKEN;
  if (env) return env;
  try {
    return readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return ""; // no file → no-auth default
  }
}

/** Optional extension-id pin for the extension port, written by
 *  `npm run set-extension-id`. Empty (no file) = no pin: any installed extension
 *  passes the chrome-extension:// Origin check; with a pin only that id does. */
export function resolveExtensionId(): string {
  try {
    return readFileSync(EXTENSION_ID_PATH, "utf8").trim();
  } catch {
    return "";
  }
}
