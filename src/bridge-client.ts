// BridgeClient — the MCP server's transport to the shared broker. A drop-in for
// Bridge's public surface (`call` / `connected` / `pendingCount`) so server.ts is
// unchanged. Connects as a ws CLIENT to the broker's client endpoint; if no
// broker is running, auto-spawns one (singleton — losers exit on the bind race).
//
// At-most-once is shared with Bridge via PendingCalls: a call already written to
// the broker is NEVER replayed on reconnect (it times out) — so a broker crash +
// respawn can't double-run a non-idempotent tool. Calls are written only after
// the broker has acknowledged this socket's hello, so a broker that rejects the
// hello leaves them unwritten: queued, and retryable if they time out.

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BRIDGE_HOST, CLIENT_PORT } from "./ports";
import { PROTOCOL_VERSION, clampCallTimeout, type ClientCall } from "../shared/protocol";
import { PendingCalls } from "./pending-calls";
import { resolveToken } from "./auth";
import { PANEL_VERSION, type PanelCommand, type PanelCall } from "../shared/control-panel";

import { respondToPanelRequest } from "./server-panel-channel";
import { TimeoutIncidents } from "./timeout-incidents";
import { CONFIG_DIR } from "./config-dir";
import { LoopGuard } from "./loop-guard";
import { normalizeSessionName } from "../shared/session-name";

// broker.js sits next to this module's bundle (dist/). Resolve ABSOLUTELY — the
// MCP server is launched with the user's project cwd, not the repo, so a relative
// path would ENOENT in production.
const BROKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "broker.js");
// A broker built before the acknowledgement existed never sends one. After this
// grace an unacknowledged socket that is still open counts as accepted; a
// rejection (close 4003/4004 right after the hello) arrives well within it.
const UNACKNOWLEDGED_GRACE_MS = 1000;

/** The environment for a spawned broker. It runs in its bundle directory, so a
 *  relative store or log directory set here, which names a directory under this
 *  client's working directory, is made absolute against it first. Every other
 *  variable is passed on unchanged. */
function brokerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["CCMCP_CONFIG_DIR", "CCMCP_LOG_DIR", "CCMCP_MODULE_CONFIG_DIR"]) {
    const value = env[key];
    if (value && !isAbsolute(value)) env[key] = resolve(value);
  }
  return env;
}

/** Append the absolute deadline to a serialized call frame, which is a JSON
 *  object, so the arguments are serialized only once. */
function withDeadline(frame: string, deadline: number): string {
  return `${frame.slice(0, -1)},"deadline":${deadline}}`;
}

function sessionProjectName(): string | undefined {
  // npm --prefix runs start in the installation directory. INIT_CWD retains
  // the caller's project; unrelated inherited npm environments must not win.
  const initialDirectory = process.env.npm_lifecycle_event === "start" && process.env.npm_package_name === "tabai"
    ? process.env.INIT_CWD : undefined;
  return normalizeSessionName(basename(initialDirectory && isAbsolute(initialDirectory) ? initialDirectory : process.cwd()));
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  // The socket whose hello the broker acknowledged (its broker-status frame).
  // Per socket, so every new connection starts unacknowledged.
  private acknowledged: WebSocket | null = null;
  private acknowledgeTimer?: ReturnType<typeof setTimeout>;
  private tokenProvider: () => string;
  // Stable per process → a reconnect (even to a freshly respawned broker)
  // re-attaches to the same session/tab-group.
  private sessionKey = randomUUID();
  private sessionName = sessionProjectName();
  private calls: PendingCalls;
  private backoff = 250;
  private connecting = false;
  private nextSpawnAt = 0;
  private spawnAttempts = 0;
  // Each distinct rejection is surfaced ONCE (a reconnect loop would otherwise
  // repeat it every backoff tick); the session keeps retrying regardless.
  private warned = new Set<string>();
  private panelHandler?: (command: PanelCommand) => Promise<unknown>;
  private active = new Map<string, PanelCall>();
  private lastError?: PanelCall;
  private serverVersion = "";
  private brokerBuild?: string;
  readonly incidents = new TimeoutIncidents(CONFIG_DIR);
  readonly loopGuard = new LoopGuard();
  get brokerBuildId(): string | undefined { return this.connected ? this.brokerBuild : undefined; }

  configurePanel(version: string, handler: (command: PanelCommand) => Promise<unknown>): void {
    this.serverVersion = version;
    this.panelHandler = handler;
  }

  activity() {
    return { calls: [...this.active.values()], ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  constructor(tokenProvider: () => string = resolveToken) {
    this.tokenProvider = tokenProvider;
    this.calls = new PendingCalls({
      // Both the flush and a direct send go through these two checks, so no
      // call is written before the broker has accepted the hello.
      write: (frame) => {
        if (!this.writable()) return false;
        try {
          this.ws!.send(frame);
          return true;
        } catch {
          return false;
        }
      },
      isOpen: () => this.writable(),
      // Cold-start: queue until the broker + extension are up; the per-call
      // timeout (and the broker's own "no extension" error) handle real failure.
      queueWhenDisconnected: true,
    });
    this.connect();
  }

  get connected(): boolean {
    return this.writable();
  }
  get pendingCount(): number {
    return this.calls.size;
  }

  /** The socket is open: a broker is up, whether or not it accepted the hello. */
  private socketOpen(): boolean {
    return this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Calls may be written: the open socket's hello was acknowledged. */
  private writable(): boolean {
    return this.socketOpen() && this.acknowledged === this.ws;
  }

  private acknowledge(ws: WebSocket): void {
    if (ws !== this.ws || this.acknowledged === ws || ws.readyState !== WebSocket.OPEN) return;
    clearTimeout(this.acknowledgeTimer);
    this.acknowledged = ws;
    this.calls.onConnected();
  }

  private url(): string {
    const base = `ws://${BRIDGE_HOST}:${CLIENT_PORT}`;
    const token = this.tokenProvider();
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  private connect(): void {
    if (this.connecting || this.socketOpen()) return;
    this.connecting = true;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url(), { handshakeTimeout: 5000 });
    } catch {
      this.connecting = false;
      this.ensureBroker();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.connecting = false;
      this.backoff = 250;
      this.spawnAttempts = 0;
      this.nextSpawnAt = 0;
      // Handshake FIRST (the broker expects the hello as the first frame). Queued
      // calls wait for the broker's acknowledgement: a broker that rejects the
      // hello (4003/4004) closes the socket before sending one, and a call
      // written into that socket would count as sent and time out unretryable.
      // Auth is via the URL query (see url()), not the hello body.
      try {
        ws.send(
          JSON.stringify({
            role: "client",
            sessionKey: this.sessionKey,
            sessionName: this.sessionName,
            version: PROTOCOL_VERSION,
            buildStatusVersion: 1,
            ...(this.panelHandler ? { panelVersion: PANEL_VERSION, serverVersion: this.serverVersion } : {}),
          }),
        );
      } catch {
        return; // a failed hello drops the socket; reconnect retries
      }
      clearTimeout(this.acknowledgeTimer);
      this.acknowledgeTimer = setTimeout(() => this.acknowledge(ws), UNACKNOWLEDGED_GRACE_MS);
      this.acknowledgeTimer.unref?.();
    });
    ws.on("message", (data) => this.onMessage(data.toString(), ws));
    ws.on("close", (code) => {
      this.connecting = false;
      if (this.ws === ws) { this.ws = null; this.brokerBuild = undefined; clearTimeout(this.acknowledgeTimer); }
      if (this.acknowledged === ws) this.acknowledged = null;
      if (code === 4003) {
        this.warnOnce("4003", "broker rejected the client hello — run 'npm run doctor' to check the running build.");
      } else if (code === 4004) {
        // A lingering OLD broker rejects our hello. Surface it (don't fail
        // silently forever); kill-broker frees it and we respawn from the build.
        this.warnOnce(
          "4004",
          "broker rejected us (protocol version mismatch) — a stale broker is running. Run 'npm run kill-broker', then it respawns from the new build.",
        );
      }
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      // An HTTP status in the error text means the broker IS up and refused the
      // upgrade (401 token / 403 Origin). ws still emits `close` afterwards, which
      // schedules the reconnect — so do NOT add an `unexpected-response` listener:
      // it replaces ws's abort path and neither `error` nor `close` would fire,
      // leaving `connecting` stuck forever.
      const status = /Unexpected server response: (\d+)/.exec(err.message)?.[1];
      if (status === "401") {
        this.warnOnce(
          "401",
          "broker rejected the token — run 'npm run set-token' here or unset BRIDGE_TOKEN, then 'npm run kill-broker'.",
        );
      } else if (status === "403") {
        this.warnOnce("403", "broker rejected this client's Origin (the client port accepts only Origin-less Node clients).");
      } else if (status && status !== "503") {
        // The broker refuses this client's upgrade only with 401, 403 or 503
        // (shutting down): any other status comes from another program.
        this.warnOnce(
          "foreign",
          `client port ${CLIENT_PORT} answered HTTP ${status}: it is held by a program that is not the broker — run 'npm run doctor' to see what holds it.`,
        );
      }
      // Any HTTP answer means something holds the port (503: a broker shutting
      // down that keeps it until its modules have exited). A spawned broker
      // would only lose the election, so just let the close handler reconnect.
      if (status) return;
      // Anything else (ECONNREFUSED…) → the broker is likely absent → spawn it;
      // the close handler schedules the reconnect.
      this.ensureBroker();
    });
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.error(`[bridge-client] ${message}`);
  }

  private onMessage(raw: string, origin: WebSocket): void {
    let msg: {
      type?: unknown;
      command?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      buildId?: unknown;
      version?: unknown;
      error?: { code?: string; message?: string; retryable?: boolean };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (origin !== this.ws || !msg) return;
    if (msg.type === "broker-status") {
      if (msg.version === PROTOCOL_VERSION && typeof msg.buildId === "string" && msg.buildId.length <= 100) this.brokerBuild = msg.buildId;
      // The broker sends it only after accepting the hello: calls may go out.
      this.acknowledge(origin);
      return;
    }
    if (typeof msg.id !== "string") return;
    if (msg.type === "panel-request") {
      respondToPanelRequest(msg.id, msg.command, origin, this.panelHandler);
      return;
    }
    this.calls.settle(msg.id, msg.ok === true, msg.result, msg.error);
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  /** Spawn the broker daemon if it isn't running (single-flight). Detached +
   *  stdio-ignored + windowsHide so it OUTLIVES this session and never inherits
   *  our stdio (which would tear it down when this session ends). */
  private ensureBroker(): void {
    if (Date.now() < this.nextSpawnAt) return;
    this.spawnAttempts++;
    this.nextSpawnAt = Date.now() + Math.min(2000 * 2 ** Math.min(this.spawnAttempts - 1, 2), 8000);
    if (this.spawnAttempts >= 3) {
      this.warnOnce("spawn", "broker did not come up — run 'npm run doctor'.");
    }
    try {
      // The singleton outlives this session: run it in its own bundle directory,
      // not in the project directory this session happened to start in.
      const child = spawn(process.execPath, [BROKER_PATH], {
        cwd: dirname(BROKER_PATH),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: brokerEnvironment(),
      });
      // spawn can fail asynchronously (ENOENT/EACCES); unhandled 'error' would
      // crash this MCP session instead of allowing the next reconnect attempt.
      child.on("error", () => {});
      child.unref();
    } catch {
      /* ignore — scheduleReconnect retries, and a real failure surfaces as a
         per-call timeout */
    }
  }

  call(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
    observe = true,
  ): Promise<unknown> {
    if (!this.socketOpen()) this.ensureBroker();
    const id = randomUUID();
    let frame: string;
    try {
      // Serialize once, up front, so non-serializable args fail FAST. Forward
      // the per-call timeout so the broker uses the SAME value (the
      // download/wait_for paths exceed 30s).
      const request: Omit<ClientCall, "deadline"> = { id, tool, args, timeoutMs };
      frame = JSON.stringify(request);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    // The deadline is stamped when the call enters the transport queue, where its
    // timer starts (a loop-guard read may come first), so the broker never runs a
    // call that waited in the queue after this client has given up on it.
    const enqueue = () => this.calls.add(id, withDeadline(frame, Date.now() + clampCallTimeout(timeoutMs)), tool, timeoutMs);
    // Internal panel diagnostics use the same at-most-once transport, but must
    // not appear as user work or overwrite its last error.
    if (!observe) return enqueue();
    const activity: PanelCall = { id, tool, startedAt: Date.now(), ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}) };
    this.active.set(id, activity);
    return this.loopGuard.run(tool, args, enqueue,
      tabId => this.call("read_page", { tabId, compact: true, filter: "all", maxResults: 500, maxChars: 80_000,
        mintRefs: false }, 1500, false)).catch(async error => {
      // Browser errors may contain page text or entered values. Observe only a code.
      this.lastError = { ...activity, error: /^[A-Z_]{1,60}$/.test(error?.code) ? error.code : "TOOL_ERROR" };
      if (error?.code === "TIMEOUT") {
        try {
          const incidentId = await this.incidents.capture(tool, Date.now() - activity.startedAt, timeoutMs, this.brokerBuildId,
            () => this.call("health", {}, 1500, false));
          if (incidentId) error.incidentId = incidentId;
        } catch { console.error("[Tabai diagnostics] Timeout evidence could not be saved"); }
      }
      throw error;
    }).finally(() => this.active.delete(id));
  }
}
