// Broker daemon — the singleton that lets MANY MCP-server sessions share the ONE
// Chrome extension concurrently. It owns:
//   - the extension endpoint (BRIDGE_PORT, via Bridge), and
//   - a client endpoint (CLIENT_PORT) the per-session servers connect to.
// Each client's tool calls are routed to the extension and the response back,
// CLOSURE-bound to the originating socket so cross-client misrouting is
// impossible by construction. The broker stamps the connection's authenticated
// sessionId onto every extension frame (per-session tab-group isolation).
//
// Singleton election: CLIENT_PORT is the mutex. Only the process that binds it
// constructs the Bridge (touches BRIDGE_PORT); a process that loses the bind race
// exits(0) WITHOUT ever touching the extension port (no two-port split-brain).
// And it couples the lock to CAPABILITY: if the extension port itself is held by
// a stray, the winner exits(0) to RELEASE the lock rather than wedge.

import { WebSocketServer } from "ws";
import { BRIDGE_HOST, BRIDGE_PORT, CLIENT_PORT } from "./ports";
import { CALL_TIMEOUT_MAX_MS, SESSION_CLOSED } from "../shared/protocol";
import { Bridge } from "./bridge";
import { SessionReaper } from "./session-reaper";
import { AssistantPulse } from "./assistant-pulse";
import { logEvent } from "./logger";
import { resolveExtensionId, resolveToken } from "./auth";
import { gateClient, verifyClientWith } from "./handshake-gate";
import { intEnv } from "./env";
import { PanelRouter } from "./panel-router";
import { createBrokerClientSession } from "./broker-client-session";
import { PersonalModules } from "./personal-modules";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
declare const __CCMCP_MODULE_CONFIG_DIR__: string;

// The module store (the assistant's data and the module registry) belongs to the
// singleton, not to whichever client first spawns it: that client may run with a
// disposable CCMCP_CONFIG_DIR (a test's temp store) that is deleted afterwards.
// Order: the build's baked directory (the CI build bakes its own), then
// CCMCP_MODULE_CONFIG_DIR (a module's browser client passes its owner's store on),
// then the per-user default. The spawner's CCMCP_CONFIG_DIR wins only when it
// already holds module data (the assistant's stored state or the module
// registry), so an installation that has relied on it keeps its data and its
// registered modules instead of silently starting over in the default.
function moduleConfigDir(): string {
  const configured = __CCMCP_MODULE_CONFIG_DIR__ || process.env.CCMCP_MODULE_CONFIG_DIR;
  if (configured) return configured;
  const spawnerStore = process.env.CCMCP_CONFIG_DIR;
  if (spawnerStore && holdsModuleData(spawnerStore)) return spawnerStore;
  return join(homedir(), ".claude-chrome-mcp");
}
function holdsModuleData(dir: string): boolean {
  try {
    if (statSync(join(dir, "assistant")).isDirectory()) return true;
  } catch {
    /* no assistant state */
  }
  try {
    // The registry file PersonalModules reads.
    return statSync(join(dir, "personal-modules.json")).isFile();
  } catch {
    return false;
  }
}

const bundleDir = dirname(fileURLToPath(import.meta.url));
const modules = new PersonalModules(moduleConfigDir(), [{
  id: "daily-assistant", command: process.execPath,
  args: [join(bundleDir, "assistant.js"), join(bundleDir, "..")], cwd: join(bundleDir, ".."),
}], notice => { bridge?.sendControl({ type: "control", event: "assistant-attention", notice }); });
const panel = new PanelRouter(modules);

// Client port (:9225) token — BRIDGE_TOKEN env OR the opt-in 0600 token file
// (resolveToken), so the server + broker match with zero config. The extension
// port (:9223) keeps using BRIDGE_TOKEN env only (the popup field), unchanged.
// Both sources are kept on purpose: changing which token a port expects would
// lock out an installation that works today.
const CLIENT_TOKEN = resolveToken();
const EXT_TOKEN = process.env.BRIDGE_TOKEN ?? "";

// The broker runs detached with stdio:'ignore', so console output is discarded.
// Persist diagnostics to the file log so failures are actually observable.
function logBroker(event: string, extra: Record<string, unknown> = {}): void {
  logEvent({ src: "broker", event, ...extra });
}

// A single bad call must never take down the broker — that would kill EVERY
// concurrent session at once. Log and keep serving.
process.on("uncaughtException", (e) => logBroker("uncaught", { error: String((e as Error)?.stack ?? e) }));
process.on("unhandledRejection", (e) => logBroker("unhandledRejection", { error: String(e) }));
// Boot marker — a detached daemon leaves no console, so record (re)starts to the log.
logBroker("boot", { pid: process.pid, ppid: process.ppid });

// Per-session in-flight cap so one client can't monopolize the shared extension
// hop (Bridge's global MAX_PENDING of 200) — sized so several busy sessions fit
// under it. Tunable via CCMCP_PER_CLIENT_MAX for unusually heavy fan-out.
// Parse a non-negative numeric env var; fall back to the default for empty/NaN or
// below `min` — so an explicit CCMCP_GRACE_MS=0 disables grace (min 0), while a
// nonsensical CCMCP_PER_CLIENT_MAX=0 doesn't wedge every call (min 1). A clean-env
// respawn (no var set) degrades to the default.
const PER_CLIENT_MAX = intEnv("CCMCP_PER_CLIENT_MAX", 32, 1, 200);

// Cold-start grace: a freshly (re)spawned broker queues calls (instead of fast-
// failing "no extension") for this window while the extension re-dials, then fails
// them NO_EXTENSION. Tunable via CCMCP_GRACE_MS (0 disables).
const GRACE_MS = intEnv("CCMCP_GRACE_MS", 8000, 0, CALL_TIMEOUT_MAX_MS);

let bridge: Bridge | undefined;
let assistantTimer: ReturnType<typeof setInterval> | undefined;
// The scheduler pulse, also while the extension is away: the assistant tells a
// lost connection from a page that hung only if it hears about the loss.
const assistantPulse = new AssistantPulse(async browserConnected => {
  try {
    const view = await modules.request("daily-assistant", "status", { scheduler: "true", browserConnected: String(browserConnected) });
    if (view.assistant?.attention) {
      const { count, critical, createdAt } = view.assistant.attention;
      bridge?.sendControl({ type: "control", event: "assistant-attention", notice: { id: createHash("sha256").update(createdAt).digest("hex"), count, critical, desktop: false } });
    }
  } catch { logBroker("assistant-poll-unavailable"); }
}, () => !!bridge?.connected);

// Session lifecycle: reap a session's tab group when its last client disconnects
// (a reconnect within the grace window cancels). The refcount/grace logic lives
// in the pure SessionReaper unit; here we wire it to the extension control
// channel and log whether the reap was actually delivered.
declare const __CCMCP_REAP_GRACE_MS__: string; // build-time fallback ("" in a normal build)
// Deferred reaps: if the extension WS is down when a reap fires, sendControl
// returns false and the SESSION_CLOSED frame is lost — the tab group would
// orphan with no retry. Queue the sessionId and re-deliver on the next extension
// (re)connect. A client that reconnects first cancels its own pending reap (see
// onClient), so a revived session's group is never closed out from under it.
const pendingReaps = new Set<string>();

function deliverReap(sessionId: string): void {
  const sent = bridge?.sendControl({ type: "control", event: SESSION_CLOSED, sessionId }) ?? false;
  if (sent) {
    pendingReaps.delete(sessionId);
    logBroker("session-reaped", { sessionId });
  } else {
    pendingReaps.add(sessionId);
    logBroker("session-reap-deferred", { sessionId });
  }
}

function flushPendingReaps(): void {
  for (const sessionId of [...pendingReaps]) deliverReap(sessionId);
}

const reaper = new SessionReaper(
  intEnv("CCMCP_REAP_GRACE_MS", Number(__CCMCP_REAP_GRACE_MS__) || 45_000, 0, 2_147_483_647),
  (sessionId) => deliverReap(sessionId),
);

// Set on SIGTERM/SIGINT: from then on nothing is routed (see shutdown below).
let stopping = false;

const clientSessions = createBrokerClientSession({
  getBridge: () => (stopping ? undefined : bridge), reaper, panel, pendingReaps,
  perClientMax: PER_CLIENT_MAX, logBroker,
});

// --- Election: bind the CLIENT port FIRST as the singleton lock. ---
// Browser pages (any Origin header) and bad tokens are refused at the HTTP
// upgrade (403 / 401) — they never become clients.
const verifyClient = verifyClientWith(
  () => CLIENT_PORT,
  (req) => gateClient(req, CLIENT_TOKEN),
);
const clientWss = new WebSocketServer({
  host: BRIDGE_HOST,
  port: CLIENT_PORT,
  // While stopping, the port is still the lock but routes nothing (HTTP 503). A
  // client treats any HTTP answer as a running broker and spawns no other.
  verifyClient: (info: Parameters<typeof verifyClient>[0], done: Parameters<typeof verifyClient>[1]) =>
    stopping ? done(false, 503, "broker shutting down") : verifyClient(info, done),
});

clientWss.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    // Another broker already owns the client port → it is THE singleton. Exit
    // without ever constructing the Bridge (never touch BRIDGE_PORT).
    logBroker("client-port-busy-exit", { port: CLIENT_PORT });
    process.exit(0);
  }
  logBroker("client-server-error", { error: e.message });
});

clientWss.on("listening", () => {
  logBroker("client-endpoint-up", { port: CLIENT_PORT });
  // Only the client-port winner owns the extension endpoint. Couple the lock to
  // CAPABILITY: if BRIDGE_PORT is held by a stray (old-arch server / orphan), we
  // can't serve — exit(0) to RELEASE the client-port lock so the next spawn wins
  // it once the stray frees the port, instead of wedging + blocking replacements.
  bridge = new Bridge(
    EXT_TOKEN,
    BRIDGE_PORT,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        logBroker("extension-port-busy-exit", { port: BRIDGE_PORT });
        process.exit(0);
      }
      logBroker("bridge-server-error", { error: e.message });
    },
    GRACE_MS,
    // A new extension socket first hears every live session, then the reaps
    // deferred while it was away (never for a live session; a hello cancels
    // its own). Frames on one socket keep this order.
    () => { clientSessions.announceSessions(); flushPendingReaps(); },
    resolveExtensionId(),
  );
  bridge.panelHandler = (message, reply) => panel.request(message, reply);
  // Only the actual extension advertises this capability. Fake/test bridges and
  // older peers never warm a scheduler against a user's private module store.
  bridge.assistantReady = () => {
    if (!assistantTimer) { assistantTimer = setInterval(() => void assistantPulse.pulse(), 30_000); assistantTimer.unref(); }
    void assistantPulse.pulse();
  };
  // Only once the real extension has started the pulse: a fake bridge never reaches the module store.
  bridge.extensionLost = () => { if (assistantTimer) void assistantPulse.pulse(true); };
});

clientWss.on("connection", clientSessions.onClient);

// Orderly shutdown. The client port is the single-instance lock, so it stays
// bound until the module processes have exited: a replacement broker cannot
// start a second assistant on the same data meanwhile. Routing stops at once:
// both ports refuse upgrades (503) and the open sockets close, which leaves every
// call a client has not yet written queued on that client for the next broker.
const MODULE_EXIT_BOUND_MS = 10_000;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logBroker("shutdown", { signal });
  clearInterval(assistantTimer);
  bridge?.stopRouting();
  for (const ws of clientWss.clients) ws.close(1001, "broker shutting down");
  // Modules are killed after 3 s; this only keeps a wedged exit from holding the lock forever.
  const bound = setTimeout(() => {
    logBroker("shutdown-module-exit-timeout");
    process.exit(0);
  }, MODULE_EXIT_BOUND_MS);
  await modules.close();
  clearTimeout(bound);
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(signal));
