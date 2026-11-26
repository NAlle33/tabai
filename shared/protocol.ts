// Bridge wire protocol — shared between the MCP server (Node) and the Chrome
// extension (offscreen document). Bundled into both builds by esbuild.

export const BRIDGE_HOST = "127.0.0.1";
// Baked at build time via esbuild define (CCMCP_PORT env, default 9223). Lets
// the CI harness run on a dedicated port, isolated from an always-on extension
// connected to 9223 in the user's everyday Chrome.
declare const __CCMCP_PORT__: string | undefined;
export const BRIDGE_PORT =
  typeof __CCMCP_PORT__ !== "undefined" ? Number(__CCMCP_PORT__) : 9223;

/** MCP server -> extension: execute a tool. */
export interface ToolRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** extension -> MCP server: result of a tool call. */
export interface ToolResponseOk {
  id: string;
  ok: true;
  result: unknown;
}
export interface ToolResponseErr {
  id: string;
  ok: false;
  error: { code: string; message: string; retryable?: boolean };
}
export type ToolResponse = ToolResponseOk | ToolResponseErr;

// --- Multi-session broker ---------------------------------------------------
// The broker owns the extension endpoint (BRIDGE_PORT) and a SECOND endpoint
// that the per-session MCP servers connect to as clients. Kept on its own
// build-time override so the CI harness can isolate BOTH ports.
declare const __CCMCP_CLIENT_PORT__: string | undefined;
export const CLIENT_PORT =
  typeof __CCMCP_CLIENT_PORT__ !== "undefined" ? Number(__CCMCP_CLIENT_PORT__) : 9225;

/** Bumped when the client<->broker handshake/wire changes (version-skew guard). */
export const PROTOCOL_VERSION = 1;

// Chrome terminates an extension worker when a single request exceeds five
// minutes. Leave room for the wait result and both transport hops to finish.
export const CALL_TIMEOUT_MIN_MS = 1_000;
export const CALL_TIMEOUT_MAX_MS = 300_000;
export const WAIT_TIMEOUT_MAX_MS = 270_000;

/** The per-call budget both transport hops enforce: a finite request is clamped
 *  to the bounds above, anything else gets the 30 s default. */
export function clampCallTimeout(timeoutMs: unknown): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(Math.max(timeoutMs, CALL_TIMEOUT_MIN_MS), CALL_TIMEOUT_MAX_MS)
    : 30_000;
}

/** MCP server (client) -> broker: one tool call. `deadline` is the absolute time
 *  (epoch ms) at which the client gives up, so time spent queued on the client
 *  counts against the broker's timer too. It is optional: a broker that predates
 *  it ignores it and an older client omits it, so it needs no version bump. */
export interface ClientCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  deadline?: number;
}

/** MCP server (client) -> broker: first frame on every client connection.
 *  `sessionKey` is a stable, high-entropy, per-process secret; the broker
 *  derives an opaque sessionId from it and stamps THAT on extension frames.
 *  The key itself never travels further than the broker and is never logged. */
export interface ClientHello {
  role: "client";
  sessionKey: string;
  /** Project directory name; display metadata, never an ownership key. */
  sessionName?: string;
  version: number;
  token?: string;
  /** Optional reverse control-plane capability; absent on older servers. */
  panelVersion?: number;
  serverVersion?: string;
  buildStatusVersion?: number;
}

/** broker -> extension: out-of-band control frame (NOT a tool call — no id). */
export const SESSION_CLOSED = "session-closed";
/** Sent when the broker accepts a session's hello: the session is alive, so no
 *  retried cleanup may close its group. Older extensions ignore the event. */
export const SESSION_OPEN = "session-open";
export interface SessionControlMessage {
  type: "control";
  event: typeof SESSION_CLOSED | typeof SESSION_OPEN;
  sessionId: string;
}
export type ControlMessage = SessionControlMessage | { type: "control"; event: "assistant-attention"; notice: import("./assistant-notice").AssistantNotice };

// --- Extension version guard ------------------------------------------------
// Bump together with extension/manifest.json on any extension-contract change.
// The SERVER compares MIN_EXTENSION_VERSION (baked into its build) against the
// running extension's reported version, so a not-reloaded (stale) extension is
// detectable — the silent "isolation off until you click ↻" trap.
export const EXTENSION_VERSION = "0.24.1";
export const MIN_EXTENSION_VERSION = "0.24.1";

/** Numeric semver compare: <0 if a<b, 0 if equal, >0 if a>b (tolerates missing parts). */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// --- Tool-error taxonomy ----------------------------------------------------
// Tool failures surface to the agent as "CODE: message" (isError content), so an
// unattended /loop agent can branch retry-vs-abort. Codes:
//   NO_SESSION        reconnect the MCP server (not retryable)
//   TAB_NOT_IN_GROUP  call tabs_context_mcp / use your own tab (not retryable)
//   TAB_NOT_FOUND     the tab is gone (not retryable)
//   FOCUS_DISABLED    user has not allowed agent foreground requests (not retryable)
//   NO_EXTENSION      extension not connected yet — retry after a moment
//   TIMEOUT           the peer didn't answer in time — retry
//   SESSION_BUSY      per-session in-flight cap hit — retry after backoff
//   QUEUE_FULL        global in-flight cap hit — retry after backoff
//   NO_BRIDGE         broker still starting — retry
//   TOOL_ERROR        generic page/tool failure (not auto-retryable)
//   SW_ERROR          worker died mid-call; tool may have run (not retryable)
export type ToolErrorCode =
  | "NO_SESSION"
  | "TAB_NOT_IN_GROUP"
  | "TAB_NOT_FOUND"
  | "FOCUS_DISABLED"
  | "NO_EXTENSION"
  | "TIMEOUT"
  | "SESSION_BUSY"
  | "QUEUE_FULL"
  | "NO_BRIDGE"
  | "SW_ERROR"
  | "TOOL_ERROR";

const RETRYABLE_CODES = new Set<string>([
  "NO_EXTENSION",
  "TIMEOUT",
  "SESSION_BUSY",
  "QUEUE_FULL",
  "NO_BRIDGE",
]);

/** Whether a tool-error code denotes a transient failure worth retrying. */
export function isRetryable(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}
