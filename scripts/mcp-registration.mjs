// Registration policy shared by `npm run register` and `npm run doctor`.
//
// Claude Code loads user-scope servers from ~/.claude.json → mcpServers. This
// server is registered under one of two supported names: `tabai` for a fresh
// install, `claude-chrome` for an install that predates the rename. An existing
// entry keeps its name — and therefore its `mcp__<name>__*` tool prefix — plus
// every field Claude Code stores for it; only the server path is repointed, and
// only when the stored path is stale (moved checkout) or an alias of this one.
// A path that belongs to ANOTHER checkout is never overwritten implicitly.
//
// Pure policy with injectable filesystem probes and platform so the test suite
// can exercise every branch on synthetic records without a real ~/.claude.json.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export const SUPPORTED_NAMES = ["tabai", "claude-chrome"];
export const DEFAULT_NAME = "tabai";
export const SCOPE = "user";
// The stdio fields Claude Code stores. `claude mcp add-json` drops anything
// else, so these four are the whole contract to preserve.
export const KNOWN_FIELDS = ["type", "command", "args", "env"];

/** @typedef {{ exists(path: string): boolean, realpath(path: string): string | null }} PathProbes */
/** @typedef {{ type?: string, command?: string, args?: string[], env?: Record<string, string>, [field: string]: unknown }} Registration */
/** @typedef {"current" | "stale" | "alias" | "foreign" | "unsupported"} Classification */
/** @typedef {{ name: string, kind: Classification, path: string | null }} Found */
/**
 * @typedef {object} Decision
 * @property {"add" | "none" | "update" | "stop"} action
 * @property {string | null} name
 * @property {Registration} [previous]
 * @property {Registration} [next]
 * @property {Found[]} found
 * @property {string} reason
 */

/** @type {PathProbes} */
const fsProbes = {
  exists: (path) => existsSync(path),
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

/** User-scope entries by name from ~/.claude.json; {} when missing or unreadable. */
export function readUserRegistrations(home = homedir()) {
  try {
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    const servers = config?.mcpServers;
    return servers && typeof servers === "object" ? { ...servers } : {};
  } catch {
    return {};
  }
}

/** Path semantics follow the host by default; tests inject the platform an entry was written on. */
const pathApi = (/** @type {string} */ platform) => (platform === "win32" ? win32 : posix);

/**
 * Windows paths compare case-insensitively; every platform ignores `..`/`.` noise.
 * @param {string} path
 * @param {string} [platform]
 */
function comparablePath(path, platform = process.platform) {
  const normalized = pathApi(platform).normalize(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeCommand(command, platform) {
  const api = pathApi(platform);
  return (
    typeof command === "string" &&
    (command === "node" ||
      command === "node.exe" ||
      (api.isAbsolute(command) && /^node(?:\.exe)?$/i.test(api.basename(command))))
  );
}

/**
 * Classify one stored entry against this checkout's server path.
 *  current     — already `node <serverPath>`; nothing to do
 *  stale       — a node entry whose file no longer exists (the checkout moved)
 *  alias       — a node entry whose file IS this server via another path (symlink)
 *  foreign     — a node entry pointing at a different, existing server file
 *  unsupported — not a plain `node <file>` stdio entry (http, other command, extra args)
 * @param {Registration | undefined} entry
 * @param {string} serverPath
 * @param {PathProbes} [probes]
 * @param {string} [platform]
 * @returns {{ kind: Classification, path: string | null }}
 */
export function classifyEntry(entry, serverPath, probes = fsProbes, platform = process.platform) {
  const args = entry?.args;
  const stdio = !entry?.type || entry.type === "stdio";
  const shape =
    stdio &&
    isNodeCommand(entry?.command, platform) &&
    Array.isArray(args) &&
    args.length === 1 &&
    typeof args[0] === "string" &&
    pathApi(platform).isAbsolute(args[0]);
  if (!shape) return { kind: "unsupported", path: null };
  const path = args[0];
  if (comparablePath(path, platform) === comparablePath(serverPath, platform)) return { kind: "current", path };
  if (!probes.exists(path)) return { kind: "stale", path };
  const stored = probes.realpath(path);
  const ours = probes.realpath(serverPath);
  if (stored && ours && comparablePath(stored, platform) === comparablePath(ours, platform)) return { kind: "alias", path };
  return { kind: "foreign", path };
}

/**
 * A copy of the entry that points at this checkout; every other field survives.
 * @param {Registration} entry
 * @param {string} serverPath
 * @returns {Registration}
 */
export function withServerPath(entry, serverPath) {
  return { ...entry, args: [serverPath] };
}

/**
 * Decide what `npm run register` should do.
 * @param {{ entries: Record<string, Registration>, serverPath: string, requestedName?: string, probes?: PathProbes, platform?: string }} input
 * @returns {Decision}
 */
export function planRegistration({ entries, serverPath, requestedName, probes = fsProbes, platform = process.platform }) {
  /** @type {Found[]} */
  const found = SUPPORTED_NAMES.filter((name) => entries[name]).map((name) => ({
    name,
    ...classifyEntry(entries[name], serverPath, probes, platform),
  }));
  const byName = Object.fromEntries(found.map((f) => [f.name, f]));
  const current = found.find((f) => f.kind === "current");

  if (requestedName !== undefined) {
    if (!SUPPORTED_NAMES.includes(requestedName)) {
      return { action: "stop", name: null, found, reason: `'${requestedName}' is not a supported name; use one of ${SUPPORTED_NAMES.join(", ")}` };
    }
    const target = byName[requestedName];
    if (target) return decideFor(target, entries, serverPath, found, true);
    if (current) {
      // Two names for one checkout would load the server twice, once per prefix.
      return {
        action: "stop",
        name: requestedName,
        found,
        reason: `'${current.name}' already registers this checkout; adding '${requestedName}' too would load the server twice. To switch names, remove the old entry first: claude mcp remove ${current.name} -s ${SCOPE}`,
      };
    }
    return { action: "add", name: requestedName, found, reason: "no entry with that name yet" };
  }

  if (found.length === 0) return { action: "add", name: DEFAULT_NAME, found, reason: "fresh install" };
  if (current) return { action: "none", name: current.name, found, reason: "already registered for this checkout" };
  if (found.length > 1) {
    return {
      action: "stop",
      name: null,
      found,
      reason: "both supported names exist and neither points at this checkout; choose one explicitly",
    };
  }
  return decideFor(found[0], entries, serverPath, found, false);
}

/**
 * @param {Found} target
 * @param {Record<string, Registration>} entries
 * @param {string} serverPath
 * @param {Found[]} found
 * @param {boolean} explicit
 * @returns {Decision}
 */
function decideFor(target, entries, serverPath, found, explicit) {
  const repoint = (reason) => ({
    action: /** @type {const} */ ("update"),
    name: target.name,
    previous: entries[target.name],
    next: withServerPath(entries[target.name], serverPath),
    found,
    reason,
  });
  switch (target.kind) {
    case "current":
      return { action: "none", name: target.name, found, reason: "already registered for this checkout" };
    case "stale":
      return repoint("stored path no longer exists");
    case "alias":
      return repoint("stored path is an alias of this checkout");
    case "foreign":
      if (explicit) return repoint("explicitly selected; repointing from another checkout");
      return {
        action: "stop",
        name: target.name,
        found,
        reason: `'${target.name}' points at another checkout (${target.path}); pass --name ${target.name} to repoint it`,
      };
    default:
      return {
        action: "stop",
        name: target.name,
        found,
        reason: `'${target.name}' is not a plain \`node <server>\` stdio entry; inspect it with \`claude mcp get ${target.name}\` before changing it`,
      };
  }
}

/**
 * argv for `claude mcp add` that recreates `entry` under `name`. Every stored
 * field travels as a plain argument (`-e KEY=VALUE`, then `-- command args`),
 * so no JSON has to survive a shell. On Windows the npm `.cmd` shim runs through
 * cmd.exe, which cannot carry a double quote or a `%NAME%` reference intact;
 * such an entry is refused here, before anything is removed.
 * @param {string} name
 * @param {Registration} entry
 * @param {string} [platform]
 */
export function addCommandArgs(name, entry, platform = process.platform) {
  const unsafe = (value) => platform === "win32" && (/["\r\n]/.test(value) || /%[^%\s]+%/.test(value));
  const args = ["mcp", "add", name, "-s", SCOPE];
  for (const [key, value] of Object.entries(entry.env ?? {})) {
    if (/[=\s"]/.test(key) || unsafe(key)) throw new Error(`environment variable name ${JSON.stringify(key)} cannot be passed through the shell`);
    if (unsafe(value)) throw new Error(`the value of environment variable ${key} contains a quote or %NAME% reference the Windows shell cannot pass through`);
    args.push("-e", `${key}=${value}`);
  }
  const command = String(entry.command);
  const commandArgs = (entry.args ?? []).map(String);
  for (const value of [command, ...commandArgs]) {
    if (unsafe(value)) throw new Error(`path ${value} contains a quote or %NAME% reference the Windows shell cannot pass through`);
  }
  args.push("--", command, ...commandArgs);
  return args;
}

/** Same stored contract (type, command, args, env), ignoring env key order. */
export function sameRegistration(a, b) {
  const canonical = (entry) =>
    JSON.stringify({
      type: entry?.type ?? "stdio",
      command: entry?.command,
      args: entry?.args ?? [],
      env: Object.fromEntries(Object.entries(entry?.env ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    });
  return canonical(a) === canonical(b);
}

/**
 * Replace an entry through the Claude CLI: remove, re-add the repointed copy,
 * confirm what was stored, and on any failure put the captured original back
 * the same way. Both argv lists are prepared before the removal, so an entry
 * the shell cannot carry is refused with nothing changed. `run(args)` executes
 * `claude <args>` and returns `{ ok }`; `verify(entry)` re-reads the stored
 * entry and reports whether it matches. Success is never reported unless the
 * new entry was added and verified.
 * @param {{ name: string, previous: Registration, next: Registration, run(args: string[]): { ok: boolean, detail?: string }, verify?(expected: Registration): { ok: boolean, detail?: string }, platform?: string }} input
 */
export function updateRegistration({ name, previous, next, run, verify = () => ({ ok: true }), platform = process.platform }) {
  const addNext = addCommandArgs(name, next, platform);
  const addPrevious = addCommandArgs(name, previous, platform);
  const steps = [];
  const attempt = (step, result) => {
    steps.push({ step, ok: result.ok, detail: result.detail });
    return result.ok;
  };
  if (!attempt("remove", run(["mcp", "remove", name, "-s", SCOPE]))) return { ok: false, restored: null, steps };
  if (attempt("add", run(addNext)) && attempt("verify", verify(next))) return { ok: true, restored: null, steps };
  const restored = attempt("restore", run(addPrevious)) && attempt("verify-restore", verify(previous));
  return { ok: false, restored, steps };
}

/**
 * Argument quoting for the npm `.cmd` shim on Windows, where Node's shell mode
 * joins argv with spaces: a quoted argument keeps a checkout path with spaces
 * whole. Arguments never contain quotes themselves (`addCommandArgs` refuses them).
 * @param {string} arg
 */
export function quoteForWindowsShell(arg) {
  return `"${arg}"`;
}
