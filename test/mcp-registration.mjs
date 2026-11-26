// Registration policy on synthetic records: fresh install, reuse of either
// supported name, both names present, another checkout, stale/alias repointing
// with field preservation, idempotence, the duplicate-name guard, the CLI
// replacement flow with verification and restore, Windows shell safety, and
// paths containing spaces. Pure Node — no real ~/.claude.json is read or
// written; the file reader is exercised against a temp directory passed in.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NAME,
  KNOWN_FIELDS,
  SUPPORTED_NAMES,
  addCommandArgs,
  classifyEntry,
  planRegistration,
  quoteForWindowsShell,
  readUserRegistrations,
  sameRegistration,
  updateRegistration,
  withServerPath,
} from "../scripts/mcp-registration.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (error) {
    console.log(`  ✗ ${name} — ${error.message}`);
    fail++;
  }
}

// Every path carries a space: the policy must never split or re-quote them.
const here = "/home/some one/tabai/dist/server.js";
const oldPath = "/home/some one/claude-chrome-mcp/dist/server.js";
const elsewhere = "/opt/other checkout/dist/server.js";
const probes = (existing, aliases = {}) => ({
  exists: (path) => existing.includes(path),
  realpath: (path) => aliases[path] ?? (existing.includes(path) ? path : null),
});
const nodeEntry = (path, extra = {}) => ({ type: "stdio", command: "node", args: [path], env: {}, ...extra });
const plan = (entries, requestedName, pr = probes([here, elsewhere])) =>
  planRegistration({ entries, serverPath: here, requestedName, probes: pr, platform: "linux" });

check("default name is tabai, both supported names are known, four stored fields", () => {
  assert.equal(DEFAULT_NAME, "tabai");
  assert.deepEqual([...SUPPORTED_NAMES].sort(), ["claude-chrome", "tabai"]);
  assert.deepEqual(KNOWN_FIELDS, ["type", "command", "args", "env"]);
});

check("fresh install registers tabai", () => {
  const d = plan({});
  assert.equal(d.action, "add");
  assert.equal(d.name, "tabai");
  assert.equal(d.found.length, 0);
});

check("unrelated servers do not count as ours", () => {
  const d = plan({ github: { type: "stdio", command: "npx", args: ["-y", "x"] } });
  assert.equal(d.action, "add");
  assert.equal(d.name, "tabai");
});

check("existing claude-chrome entry for this checkout is reused as-is", () => {
  const d = plan({ "claude-chrome": nodeEntry(here) });
  assert.equal(d.action, "none");
  assert.equal(d.name, "claude-chrome");
});

check("existing tabai entry for this checkout is reused as-is", () => {
  const d = plan({ tabai: nodeEntry(here, { env: { BRIDGE_TOKEN: "x" } }) });
  assert.equal(d.action, "none");
  assert.equal(d.name, "tabai");
});

check("unchanged entry is idempotent across repeated runs", () => {
  const entries = { "claude-chrome": nodeEntry(here) };
  assert.equal(plan(entries).action, "none");
  assert.equal(plan(entries).action, "none");
  assert.equal(plan(entries, "claude-chrome").action, "none");
});

check("both names: the one already pointing here wins, the other is left alone", () => {
  const d = plan({ tabai: nodeEntry(elsewhere), "claude-chrome": nodeEntry(here) });
  assert.equal(d.action, "none");
  assert.equal(d.name, "claude-chrome");
  assert.deepEqual(d.found.map((f) => [f.name, f.kind]), [["tabai", "foreign"], ["claude-chrome", "current"]]);
});

check("both names, neither current: stop and require an explicit choice", () => {
  const entries = { tabai: nodeEntry(elsewhere), "claude-chrome": nodeEntry(oldPath) };
  const d = plan(entries);
  assert.equal(d.action, "stop");
  assert.equal(d.name, null);
  assert.match(d.reason, /explicitly/);
  assert.equal(plan(entries, "claude-chrome").action, "update");
  assert.equal(plan(entries, "tabai").action, "update");
});

check("a name pointing at another existing checkout is not overwritten implicitly", () => {
  const d = plan({ "claude-chrome": nodeEntry(elsewhere) });
  assert.equal(d.action, "stop");
  assert.equal(d.name, "claude-chrome");
  assert.match(d.reason, /--name claude-chrome/);
  assert.match(d.reason, /other checkout/);
});

check("explicit --name repoints a foreign entry, preserving its fields", () => {
  const previous = nodeEntry(elsewhere, { env: { CCMCP_LOG_DIR: "/var/log/x y" } });
  const d = plan({ "claude-chrome": previous }, "claude-chrome");
  assert.equal(d.action, "update");
  assert.deepEqual(d.previous, previous);
  assert.deepEqual(d.next, { ...previous, args: [here] });
});

check("explicit --name on a missing name adds it when nothing else registers this checkout", () => {
  const d = plan({ "claude-chrome": nodeEntry(oldPath) }, "tabai");
  assert.equal(d.action, "add");
  assert.equal(d.name, "tabai");
});

check("explicit --name never registers the same checkout twice", () => {
  const d = plan({ "claude-chrome": nodeEntry(here) }, "tabai");
  assert.equal(d.action, "stop");
  assert.equal(d.name, "tabai");
  assert.match(d.reason, /load the server twice/);
  assert.match(d.reason, /claude mcp remove claude-chrome -s user/);
});

check("a stale path (moved checkout) is repointed with every other field preserved", () => {
  const previous = nodeEntry(oldPath, { env: { BRIDGE_TOKEN: "secret value" } });
  const d = plan({ "claude-chrome": previous });
  assert.equal(d.action, "update");
  assert.equal(d.name, "claude-chrome");
  assert.match(d.reason, /no longer exists/);
  assert.deepEqual(d.next, { type: "stdio", command: "node", args: [here], env: { BRIDGE_TOKEN: "secret value" } });
  assert.deepEqual(d.previous, previous, "the captured original is untouched");
});

check("an alias path (symlink to this checkout) is repointed to the canonical path", () => {
  const pr = probes([here, elsewhere, oldPath], { [oldPath]: here });
  const d = plan({ tabai: nodeEntry(oldPath) }, undefined, pr);
  assert.equal(d.action, "update");
  assert.match(d.reason, /alias/);
  assert.deepEqual(d.next.args, [here]);
});

check("after an update the repointed entry needs no further change", () => {
  const d = plan({ "claude-chrome": nodeEntry(oldPath) });
  assert.equal(plan({ "claude-chrome": d.next }).action, "none");
});

check("withServerPath changes only args", () => {
  const entry = { type: "stdio", command: "/usr/local/bin/node", args: [oldPath], env: { A: "1" } };
  assert.deepEqual(withServerPath(entry, here), { ...entry, args: [here] });
  assert.deepEqual(entry.args, [oldPath], "input is not mutated");
});

check("entries that are not a plain node <server> stdio entry stop even when named explicitly", () => {
  const cases = {
    http: { type: "http", url: "https://example.com/mcp" },
    otherCommand: { type: "stdio", command: "npx", args: ["-y", "tabai"] },
    extraArgs: { type: "stdio", command: "node", args: [here, "--flag"] },
    relative: { type: "stdio", command: "node", args: ["dist/server.js"] },
  };
  for (const [label, entry] of Object.entries(cases)) {
    assert.equal(classifyEntry(entry, here, probes([here])).kind, "unsupported", label);
    assert.equal(plan({ tabai: entry }).action, "stop", label);
    assert.equal(plan({ tabai: entry }, "tabai").action, "stop", `${label} explicit`);
  }
  assert.match(plan({ tabai: cases.http }).reason, /claude mcp get tabai/);
});

check("an unsupported requested name stops before any mutation", () => {
  const d = plan({}, "chrome");
  assert.equal(d.action, "stop");
  assert.match(d.reason, /tabai, claude-chrome/);
});

check("absent type means stdio; an absolute node.exe command counts as node", () => {
  const entry = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\Some One\\Tabai\\dist\\server.js"] };
  const result = classifyEntry(entry, "c:\\users\\some one\\tabai\\dist\\server.js", probes([]), "win32");
  assert.equal(result.kind, "current", "Windows paths compare case-insensitively");
});

// Re-adding an entry: plain `claude mcp add` arguments, never JSON on the command line.
check("addCommandArgs recreates an entry with -e for each env value and the command after --", () => {
  const entry = { type: "stdio", command: "/usr/local/bin/node", args: [here], env: { B: "a=b c", A: "", EMPTY: "" } };
  assert.deepEqual(addCommandArgs("claude-chrome", entry, "linux"), [
    "mcp", "add", "claude-chrome", "-s", "user",
    "-e", "B=a=b c", "-e", "A=", "-e", "EMPTY=",
    "--", "/usr/local/bin/node", here,
  ]);
  assert.deepEqual(addCommandArgs("tabai", nodeEntry(here), "linux"), ["mcp", "add", "tabai", "-s", "user", "--", "node", here]);
});

check("Windows refuses values the .cmd shim cannot carry, naming the field but not the value", () => {
  const quoted = nodeEntry(here, { env: { BRIDGE_TOKEN: 'se"cret' } });
  assert.throws(() => addCommandArgs("tabai", quoted, "win32"), (error) => /BRIDGE_TOKEN/.test(error.message) && !/se"cret/.test(error.message));
  const expanded = nodeEntry("C:\\Users\\%USERNAME%\\tabai\\dist\\server.js");
  assert.throws(() => addCommandArgs("tabai", expanded, "win32"), /%NAME%/);
  assert.throws(() => addCommandArgs("tabai", nodeEntry(here, { env: { "BAD KEY": "1" } }), "linux"), /BAD KEY/);
  // The same values are fine where no shell is involved.
  assert.doesNotThrow(() => addCommandArgs("tabai", quoted, "linux"));
  assert.doesNotThrow(() => addCommandArgs("tabai", expanded, "linux"));
  // A lone percent sign or an ordinary Windows path passes.
  assert.doesNotThrow(() => addCommandArgs("tabai", nodeEntry("C:\\Users\\Some One\\tabai\\dist\\server.js", { env: { RATE: "50%" } }), "win32"));
});

check("Windows shell quoting keeps a path with spaces whole", () => {
  assert.equal(quoteForWindowsShell("C:\\a b\\server.js"), '"C:\\a b\\server.js"');
});

check("sameRegistration compares the stored contract, ignoring env key order and defaulting type", () => {
  assert.ok(sameRegistration({ command: "node", args: [here], env: { A: "1", B: "2" } }, { type: "stdio", command: "node", args: [here], env: { B: "2", A: "1" } }));
  assert.ok(!sameRegistration(nodeEntry(here), nodeEntry(oldPath)));
  assert.ok(!sameRegistration(nodeEntry(here, { env: { A: "1" } }), nodeEntry(here)));
});

// Replacement flow with an injected CLI runner and verifier.
const previous = nodeEntry(oldPath, { env: { BRIDGE_TOKEN: "keep me" } });
const next = withServerPath(previous, here);
function runner({ failOn = [], storedAfterAdd = null } = {}) {
  const calls = [];
  let adds = 0;
  const run = (args) => {
    calls.push(args);
    const step = args[1] === "remove" ? "remove" : ++adds === 1 ? "add" : "restore";
    return { ok: !failOn.includes(step), detail: step };
  };
  const verified = [];
  const verify = (expected) => {
    verified.push(expected);
    const stored = storedAfterAdd ?? expected;
    return sameRegistration(stored, expected) ? { ok: true } : { ok: false, detail: "differs" };
  };
  return { calls, verified, run, verify };
}

check("successful replacement removes, re-adds the repointed entry with its env, and verifies it", () => {
  const { calls, verified, run, verify } = runner();
  const result = updateRegistration({ name: "claude-chrome", previous, next, run, verify, platform: "linux" });
  assert.equal(result.ok, true);
  assert.equal(result.restored, null);
  assert.deepEqual(calls, [
    ["mcp", "remove", "claude-chrome", "-s", "user"],
    ["mcp", "add", "claude-chrome", "-s", "user", "-e", "BRIDGE_TOKEN=keep me", "--", "node", here],
  ]);
  assert.deepEqual(verified, [next]);
  assert.deepEqual(result.steps.map((s) => [s.step, s.ok]), [["remove", true], ["add", true], ["verify", true]]);
});

check("a failed add restores the captured entry, verifies it, and reports failure, not success", () => {
  const { calls, verified, run, verify } = runner({ failOn: ["add"] });
  const result = updateRegistration({ name: "claude-chrome", previous, next, run, verify, platform: "linux" });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ["mcp", "add", "claude-chrome", "-s", "user", "-e", "BRIDGE_TOKEN=keep me", "--", "node", oldPath]);
  assert.deepEqual(verified, [previous]);
  assert.deepEqual(result.steps.map((s) => [s.step, s.ok]), [["remove", true], ["add", false], ["restore", true], ["verify-restore", true]]);
});

check("an add whose stored result differs from the intent is treated as a failure and restored", () => {
  const { run, verify } = runner({ storedAfterAdd: nodeEntry(here) }); // env lost by the CLI
  const result = updateRegistration({ name: "tabai", previous, next, run, verify, platform: "linux" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map((s) => [s.step, s.ok]), [["remove", true], ["add", true], ["verify", false], ["restore", true], ["verify-restore", false]]);
  assert.equal(result.restored, false, "the restore is verified the same way");
});

check("a failed restore is reported as such", () => {
  const { run, verify } = runner({ failOn: ["add", "restore"] });
  const result = updateRegistration({ name: "tabai", previous, next, run, verify, platform: "linux" });
  assert.equal(result.ok, false);
  assert.equal(result.restored, false);
});

check("a failed remove leaves the previous entry in place and adds nothing", () => {
  const { calls, run, verify } = runner({ failOn: ["remove"] });
  const result = updateRegistration({ name: "tabai", previous, next, run, verify, platform: "linux" });
  assert.equal(result.ok, false);
  assert.equal(result.restored, null);
  assert.equal(calls.length, 1);
});

check("an entry the Windows shell cannot carry is refused before anything is removed", () => {
  const { calls, run, verify } = runner();
  const unsafe = nodeEntry(oldPath, { env: { BRIDGE_TOKEN: 'a"b' } });
  assert.throws(() => updateRegistration({ name: "tabai", previous: unsafe, next: withServerPath(unsafe, here), run, verify, platform: "win32" }), /BRIDGE_TOKEN/);
  assert.equal(calls.length, 0, "no CLI call was made");
});

// Reader against an explicit temp home, never the real one.
const home = mkdtempSync(join(tmpdir(), "tabai-registration-"));
try {
  check("missing config file reads as no registrations", () => {
    assert.deepEqual(readUserRegistrations(home), {});
  });
  check("user-scope mcpServers are read; malformed JSON reads as none", () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "claude-chrome": nodeEntry(here) }, projects: {} }));
    assert.deepEqual(readUserRegistrations(home), { "claude-chrome": nodeEntry(here) });
    writeFileSync(join(home, ".claude.json"), "{ not json");
    assert.deepEqual(readUserRegistrations(home), {});
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n=== mcp-registration: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
