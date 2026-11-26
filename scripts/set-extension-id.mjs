// Opt-in extension-id pin for the extension port: with the file present the
// broker accepts ONLY that extension's Origin on :9223 (without it, any installed
// extension passes the chrome-extension:// Origin check and, under newest-
// connection-wins, could supersede the real one). The id is shown in the popup.
//   npm run set-extension-id -- <32-letter id>     write the pin
//   npm run set-extension-id -- --clear            remove it
// Restart the broker afterwards so it re-reads the file: npm run kill-broker.
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const pinPath = join(homedir(), ".claude-chrome-mcp", "extension-id");
const arg = process.argv[2];
if (arg === "--clear") {
  try {
    unlinkSync(pinPath);
  } catch {
    /* already absent */
  }
  console.log(`removed ${pinPath} — any installed extension is accepted again`);
} else if (arg && /^[a-p]{32}$/.test(arg)) {
  mkdirSync(dirname(pinPath), { recursive: true });
  writeFileSync(pinPath, arg + "\n");
  console.log(`wrote ${pinPath}`);
} else {
  console.error("usage: npm run set-extension-id -- <32-letter extension id | --clear>  (the id is shown in the popup)");
  process.exit(1);
}
console.log("restart the broker to apply: npm run kill-broker");
