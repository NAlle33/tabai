// Unit tests for the navigation URL guard (the navigate allowlist). Pure Node,
// no Chrome, no ports. Requires `npm run build` first (imports dist/url-guard.mjs).
import { normalizeNavigationUrl } from "../dist/url-guard.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  cond ? pass++ : fail++;
};
const allow = (input, expected) => {
  const r = normalizeNavigationUrl(input);
  ok(`allow ${JSON.stringify(input)} → ${expected}`, "url" in r && r.url === expected, JSON.stringify(r));
};
const reject = (input) => {
  const r = normalizeNavigationUrl(input);
  ok(`reject ${JSON.stringify(input)}`, "error" in r, JSON.stringify(r));
};

// Allowed: http/https (+ scheme-less → https) and about:blank. URL preserved as-is.
allow("example.com", "https://example.com");
allow("https://example.com/p?q=1#h", "https://example.com/p?q=1#h");
allow("http://example.com", "http://example.com");
allow("localhost:3000", "https://localhost:3000"); // host:port must survive
allow("127.0.0.1:8080/x", "https://127.0.0.1:8080/x");
allow("about:blank", "about:blank");
allow("EXAMPLE.com", "https://EXAMPLE.com"); // case preserved in output

// Refused: never emit a non-http(s)/non-about:blank URL.
reject("");
reject("   ");
reject("file:///etc/passwd");
reject("FILE:///etc/passwd"); // scheme match is case-insensitive
reject("chrome://settings");
reject("chrome-extension://abcdefghijklmnop/x");
reject("devtools://devtools/bundled/x");
reject("javascript:alert(1)");
reject("javascript://%0aalert(1)");
reject("data:text/html,<h1>x</h1>");
reject("blob:https://example.com/uuid");
reject("view-source:http://example.com");
reject("about:config");
reject("mailto:a@b.com"); // ambiguous scheme-less userinfo

// Robustness: ASCII control chars stripped from the input; non-string rejected.
allow("https://exa\tmple.com", "https://example.com");
allow("htt\nps://example.com", "https://example.com");
reject(123);
reject(null);

console.log(`\n=== url-guard: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
