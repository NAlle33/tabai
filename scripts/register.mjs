// One-command user-scope registration of the Tabai MCP server with Claude Code.
// Computes the absolute path to dist/server.js, builds if missing, then goes
// through the official `claude mcp` CLI (never hand-edits ~/.claude.json).
//
// Policy (scripts/mcp-registration.mjs): a fresh install is registered as
// `tabai`; an existing `tabai` or `claude-chrome` entry keeps its name, prefix
// and fields and is only repointed when its path is stale or an alias of this
// checkout. Both names present, or a name pointing at another checkout, stops
// before any mutation — pass `--name tabai` / `--name claude-chrome` to choose.
// A replacement is backed up first, re-added with every stored field, verified
// by re-reading the configuration, and restored if any of that fails.
//
// NOTE: run this with Claude Code CLOSED (a running session rewrites ~/.claude.json
// on exit and can drop a change made mid-session), then start Claude Code.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  SCOPE,
  SUPPORTED_NAMES,
  planRegistration,
  quoteForWindowsShell,
  readUserRegistrations,
  sameRegistration,
  updateRegistration,
} from "./mcp-registration.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist", "server.js");

const nameFlag = process.argv.indexOf("--name");
const requestedName = nameFlag === -1 ? undefined : process.argv[nameFlag + 1];
if (nameFlag !== -1 && !SUPPORTED_NAMES.includes(requestedName)) {
  console.error(`usage: npm run register [-- --name <${SUPPORTED_NAMES.join("|")}>]`);
  process.exit(1);
}

if (!existsSync(serverPath)) {
  console.log("dist/server.js missing — building first…");
  const b = spawnSync(process.execPath, [join(root, "build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (b.status !== 0) {
    console.error("✗ build failed — fix the build, then re-run `npm run register`.");
    process.exit(1);
  }
}

const claude = (args, stdio) => {
  const windows = process.platform === "win32";
  // npm installs a .cmd shim on Windows. Node's shell mode joins argv with
  // spaces, so quote each argument to preserve checkout paths containing them.
  return windows
    ? spawnSync(`claude ${args.map(quoteForWindowsShell).join(" ")}`, { cwd: root, shell: true, stdio })
    : spawnSync("claude", args, { cwd: root, stdio });
};
const run = (args) => {
  const r = claude(args, "inherit");
  return { ok: !r.error && r.status === 0, detail: r.error ? r.error.message : `exit ${r.status}` };
};

const decision = planRegistration({ entries: readUserRegistrations(), serverPath, requestedName });
const describe = (f) => `'${f.name}' → ${f.kind}${f.path ? ` (${f.path})` : ""}`;
// Manual equivalent of an entry, with environment values masked: this is
// printed, and a value may be a secret.
const manualAdd = (name, entry) =>
  [`claude mcp add ${name} -s ${SCOPE}`, ...Object.keys(entry.env ?? {}).map((key) => `-e ${key}=<value>`), `-- ${entry.command} "${entry.args.join('" "')}"`].join(" ");

switch (decision.action) {
  case "none": {
    console.log(`✓ '${decision.name}' already registered (${SCOPE} scope) → node ${serverPath}`);
    const others = decision.found.filter((f) => f.name !== decision.name);
    for (const other of others) console.log(`  ℹ ${describe(other)} also exists; left untouched`);
    console.log(`→ Tools appear as mcp__${decision.name}__<tool>.`);
    break;
  }
  case "stop": {
    console.error(`✗ not changing any registration: ${decision.reason}`);
    for (const f of decision.found) console.error(`  · ${describe(f)}`);
    // An explicit name only helps when the blocker is ambiguity or another
    // checkout; an unsupported or duplicate entry needs the action named above.
    if (decision.found.some((f) => f.kind === "stale" || f.kind === "alias" || f.kind === "foreign")) {
      console.error(
        `  → choose explicitly: npm run register -- --name tabai   |   npm run register -- --name claude-chrome`,
      );
    }
    process.exit(1);
  }
  case "add": {
    const manual = `claude mcp add ${decision.name} -s ${SCOPE} -- node "${serverPath}"`;
    const r = run(["mcp", "add", decision.name, "-s", SCOPE, "--", "node", serverPath]);
    if (!r.ok) {
      console.error(`\n✗ 'claude mcp add' failed (${r.detail}). Run manually:\n  ${manual}`);
      process.exit(1);
    }
    console.log(`\n✓ Registered '${decision.name}' (${SCOPE} scope) → node ${serverPath}`);
    console.log(`→ Tools appear as mcp__${decision.name}__<tool>.`);
    break;
  }
  case "update": {
    // Private backup of the entry about to be replaced: its fields (env included)
    // are never printed, only the file path is.
    const backupDir = join(homedir(), ".claude-chrome-mcp", "backups");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
    const backup = join(backupDir, `claude-mcp-${decision.name}-${stamp}.json`);
    writeFileSync(backup, JSON.stringify(decision.previous, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(backup, 0o600);
    } catch {
      /* Windows: POSIX modes unsupported; profile-dir ACL protects it */
    }
    console.log(`repointing '${decision.name}' (${decision.reason}); backup: ${backup}`);
    // The stored entry is re-read after each write: the CLI's exit code alone
    // does not prove what ended up in the configuration.
    const verify = (expected) => {
      const stored = readUserRegistrations()[decision.name];
      if (!stored) return { ok: false, detail: "entry missing after the write" };
      return sameRegistration(stored, expected) ? { ok: true } : { ok: false, detail: "stored entry differs from the intended one" };
    };
    let result;
    try {
      result = updateRegistration({ name: decision.name, previous: decision.previous, next: decision.next, run, verify });
    } catch (error) {
      // Refused before any removal: the entry is still in place.
      console.error(`\n✗ not changing '${decision.name}': ${error.message}`);
      console.error(`  → register it by hand from a shell that passes the value through intact:\n    ${manualAdd(decision.name, decision.next)}`);
      process.exit(1);
    }
    if (result.ok) {
      console.log(`\n✓ '${decision.name}' now → node ${serverPath} (other fields preserved and verified)`);
      console.log(`→ Tools keep appearing as mcp__${decision.name}__<tool>.`);
      break;
    }
    const failed = result.steps.find((s) => !s.ok);
    console.error(`\n✗ ${failed.step} failed (${failed.detail}); registration NOT updated.`);
    if (result.restored === true) console.error(`  ✓ previous '${decision.name}' entry restored and verified`);
    else if (result.restored === false)
      console.error(`  ✗ restore failed too — put it back from the backup (${backup}) with:\n    ${manualAdd(decision.name, decision.previous)}`);
    else console.error(`  · nothing was removed; the previous entry is still in place`);
    process.exit(1);
  }
}

console.log(
  "→ Restart Claude Code to load it. (New servers don't hot-load; /mcp 'reconnect' only re-attaches already-loaded servers.)",
);
