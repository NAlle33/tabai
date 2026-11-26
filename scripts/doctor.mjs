// Diagnose the Tabai MCP setup in one command: is dist built, is port 9223
// free, is the server registered where Claude Code loads it (under either
// supported name), is Node new enough. Prints a fix hint per failed check.
// Pure Node, no deps. Never changes configuration.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";
import { clientWsUrl } from "./resolve-token.mjs";
import { SUPPORTED_NAMES, classifyEntry, readUserRegistrations } from "./mcp-registration.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_PORT = Number(process.env.CCMCP_PORT || 9223);
const CLIENT_PORT = Number(process.env.CCMCP_CLIENT_PORT || 9225);
function probe(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      res(v);
    };
    s.on("connect", () => done("in-use"));
    s.on("error", () => res("free"));
    setTimeout(() => done("free"), 800);
  });
}
let problems = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const info = (m) => console.log(`  ℹ ${m}`);
const bad = (m, fix) => {
  console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ""}`);
  problems++;
};

console.log("Tabai doctor\n");

// 1. dist built
existsSync(join(root, "dist", "server.js")) && existsSync(join(root, "dist", "broker.js"))
  ? ok("dist built (server.js + broker.js)")
  : bad("dist build missing (server.js / broker.js)", "npm run build");
let protocolVersion;
try {
  ({ PROTOCOL_VERSION: protocolVersion } = await import("../dist/protocol.mjs"));
} catch {
  bad("protocol build missing or unreadable (dist/protocol.mjs)", "npm run build");
}

// 2. broker endpoints — the broker owns the extension port (9223) + the client
// port (9225). A held extension port with NO broker on the client port means a
// stray/old server is squatting it (the broker can't bind → exits).
const extState = await probe(EXT_PORT);
const clientState = await probe(CLIENT_PORT);
if (clientState === "in-use") {
  info(`broker running (client :${CLIENT_PORT}${extState === "in-use" ? `, extension :${EXT_PORT}` : ""})`);
} else if (extState === "in-use") {
  bad(
    `extension port :${EXT_PORT} held but no broker on :${CLIENT_PORT} — a stray/old server is squatting it`,
    "npm run kill-broker   (frees both ports; the broker re-spawns on next use)",
  );
} else {
  info(`no broker running (auto-spawns on first use; ext :${EXT_PORT} / client :${CLIENT_PORT})`);
}

// 2b. stale extension — compare the RUNNING extension's version (via a quick health
// round-trip through the broker) against the build on disk (what a reload loads).
let extensionConnected = false;
if (clientState === "in-use" && protocolVersion !== undefined) {
  let extVersion = null;
  try {
    extVersion = await new Promise((resolve) => {
      const ws = new WebSocket(clientWsUrl(CLIENT_PORT));
      const id = randomUUID();
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        resolve(v);
      };
      ws.on("open", () => {
        ws.send(JSON.stringify({ role: "client", sessionKey: randomUUID(), version: protocolVersion }));
        ws.send(JSON.stringify({ id, tool: "health", args: {}, timeoutMs: 4000 }));
      });
      ws.on("message", (d) => {
        try {
          const m = JSON.parse(d.toString());
          if (m && m.id === id) done(m.ok && m.result ? m.result.extVersion : null);
        } catch { /* ignore */ }
      });
      ws.on("error", () => done(null));
      setTimeout(() => done(null), 5000);
    });
  } catch { /* skip */ }
  if (extVersion) {
    extensionConnected = true;
    let buildVersion = "0.0.0";
    try {
      buildVersion = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8")).version;
    } catch { /* ignore */ }
    const lt = (a, b) => {
      const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d < 0;
      }
      return false;
    };
    lt(extVersion, buildVersion)
      ? bad(
          `extension running ${extVersion} but build is ${buildVersion} — STALE (per-session isolation may be off)`,
          "reload the extension (↻ in chrome://extensions)",
        )
      : ok(`extension ${extVersion} matches the build`);
  } else {
    bad("extension health probe failed", "check the extension is loaded and connected, then run npm run doctor again");
  }
}

if (!extensionConnected) {
  // Only display known diagnostic fields, never the raw log line or Origin:
  // unrelated tool events and caller-controlled headers may contain secrets.
  const logDir = process.env.CCMCP_LOG_DIR || join(homedir(), ".claude-chrome-mcp", "logs");
  let latest;
  try {
    for (const name of readdirSync(logDir)) {
      if (!/^broker-\d{8}-\d+\.log(?:\.1)?$/.test(name)) continue;
      try {
        for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
          try {
            const entry = JSON.parse(line);
            if (entry?.src === "broker" && entry.event === "handshake-reject" &&
                Number.isFinite(entry.ts) && Math.abs(entry.ts) <= 8.64e15 &&
                (!latest || entry.ts > latest.ts)) latest = entry;
          } catch { /* ignore partial or malformed lines */ }
        }
      } catch { /* rotated or unreadable log */ }
    }
  } catch { /* no readable broker logs yet */ }
  if (latest) {
    const knownReasons = new Set(["origin not allowed", "extension id does not match the pin", "invalid token"]);
    const reason = knownReasons.has(latest.reason) ? latest.reason : "handshake rejected";
    const port = Number.isInteger(latest.port) && latest.port > 0 && latest.port <= 65535 ? ` on :${latest.port}` : "";
    const status = latest.status === 401 || latest.status === 403 ? ` (HTTP ${latest.status})` : "";
    info(`latest broker handshake-reject${port}${status}: ${reason} [${new Date(latest.ts).toISOString()}]`);
  }
}

// 3. registered where Claude Code actually loads servers (~/.claude.json
// mcpServers) under either supported name, pointing at THIS checkout's server.
// Diagnosis only: an ambiguous or foreign entry is reported, never rewritten.
const serverPath = join(root, "dist", "server.js");
const entries = readUserRegistrations();
const found = SUPPORTED_NAMES.filter((name) => entries[name]).map((name) => ({
  name,
  ...classifyEntry(entries[name], serverPath),
}));
const current = found.find((f) => f.kind === "current");
if (!found.length) {
  bad(
    `not registered as '${SUPPORTED_NAMES.join("' or '")}' where Claude Code loads it`,
    "npm run register   (then restart Claude Code)",
  );
} else if (current) {
  ok(`registered as '${current.name}' (user scope) in ~/.claude.json for this checkout — tools are mcp__${current.name}__*`);
  for (const other of found.filter((f) => f !== current)) {
    info(`'${other.name}' is also registered (${other.kind}${other.path ? `: ${other.path}` : ""}); npm run register leaves it alone`);
  }
} else {
  for (const f of found) {
    const what =
      f.kind === "stale" ? `points at a missing file (${f.path})`
      : f.kind === "alias" ? `reaches this checkout through another path (${f.path})`
      : f.kind === "foreign" ? `points at another checkout (${f.path})`
      : "is not a plain `node <server>` stdio entry";
    // With both names present register stops until one is chosen explicitly.
    const choose = found.length > 1 ? ` -- --name ${f.name}` : "";
    const fix =
      f.kind === "stale" || f.kind === "alias"
        ? `npm run register${choose}   (repoints it, keeping its name and fields; then restart Claude Code)`
        : f.kind === "foreign"
          ? `npm run register -- --name ${f.name}   (repoints it here; leave it if that checkout is intentional)`
          : `claude mcp get ${f.name}   (inspect it before changing anything)`;
    bad(`'${f.name}' registration ${what}`, fix);
  }
}

// 4. node version
const major = Number(process.versions.node.split(".")[0]);
major >= 22
  ? ok(`node ${process.versions.node}`)
  : bad(`node ${process.versions.node} is < 22`, "upgrade Node to >= 22");

console.log(problems === 0 ? "\n✓ all good" : `\n${problems} problem(s) above`);
process.exit(problems === 0 ? 0 : 1);
