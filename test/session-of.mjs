// Chrome-free unit test for the per-session trust boundary's pure half.
// sessionOf() MUST fail closed on a missing/empty/non-string __sessionId — the
// documented "no shared default group" guarantee. It imports the REAL bundled
// extension function (dist/tab-group-helpers.mjs), not a copy, so a regression in
// the fail-closed branch is caught here in CI without Chrome. (The full
// assertTabInGroup path needs chrome.* and is exercised by the live harness.)
import { sessionOf } from "../dist/tab-group-helpers.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// Fails closed = throws NO_SESSION (never returns a default/empty session).
const failsClosed = (args, label) => {
  try {
    const got = sessionOf(args);
    check(`${label} fails closed`, false, `returned ${JSON.stringify(got)} instead of throwing`);
  } catch (e) {
    check(`${label} fails closed`, e?.code === "NO_SESSION", `code=${e?.code}`);
  }
};

check("valid sessionId is returned verbatim", sessionOf({ __sessionId: "abc123" }) === "abc123");
failsClosed({}, "missing __sessionId");
failsClosed({ __sessionId: "" }, "empty-string __sessionId");
failsClosed(undefined, "undefined args");
failsClosed(null, "null args");
failsClosed({ __sessionId: 123 }, "numeric __sessionId");
failsClosed({ __sessionId: {} }, "object __sessionId");

console.log(`\n=== session-of: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
