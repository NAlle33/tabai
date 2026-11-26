// Unit test for the broker's session lifecycle (no Chrome, no ws). Covers the
// trickiest logic: refcount of concurrent clients, reconnect-cancels-reap, and
// reap-after-grace. Requires `npm run build` (imports dist/session-reaper.mjs).
import { SessionReaper } from "../dist/session-reaper.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();

let pass = 0;
let fail = 0;
function check(name, ok) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. reap fires after grace when the only client disconnects
{
  let reaped = null;
  const r = new SessionReaper(60, (sid) => (reaped = sid));
  r.connected("A");
  r.disconnected("A");
  check("no reap before grace; one timer pending", reaped === null && r.pendingReaps === 1);
  await sleep(120);
  check("reap fires after grace; timer cleared", reaped === "A" && r.pendingReaps === 0);
}

// 2. reconnect within grace cancels the reap
{
  let reaped = null;
  const r = new SessionReaper(60, (sid) => (reaped = sid));
  r.connected("B");
  r.disconnected("B");
  r.connected("B"); // reconnect within grace
  await sleep(120);
  check("reconnect within grace cancels reap", reaped === null && r.pendingReaps === 0);
}

// 3. two concurrent clients: first close no-ops, second close reaps
{
  let reaped = null;
  const r = new SessionReaper(60, (sid) => (reaped = sid));
  r.connected("C");
  r.connected("C"); // 2 clients on one session
  r.disconnected("C");
  check("first of two closes does not schedule", r.pendingReaps === 0 && reaped === null);
  r.disconnected("C");
  check("second close schedules the reap", r.pendingReaps === 1);
  await sleep(120);
  check("reap fires once both clients are gone", reaped === "C");
}

console.log(`\n=== session-reaper: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
