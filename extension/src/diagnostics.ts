import { DIAGNOSTIC_OPERATIONS, type DiagnosticEntry, type DiagnosticOperation, type DiagnosticSnapshot } from "../../shared/diagnostics";
import type { ToolErrorCode } from "../../shared/protocol";

type ActiveEntry = { entry: DiagnosticEntry; budgetMs?: number };
type SessionState = { active: Map<number, ActiveEntry>; recent: DiagnosticEntry[]; dropped: number };
const sessions = new Map<string, SessionState>();
const tabSessions = new Map<number, string>();
const allowed = new Set<string>(DIAGNOSTIC_OPERATIONS);
const errorCodes: ReadonlySet<string> = new Set<ToolErrorCode>([
  "NO_SESSION", "TAB_NOT_IN_GROUP", "TAB_NOT_FOUND", "NO_EXTENSION", "TIMEOUT",
  "SESSION_BUSY", "QUEUE_FULL", "NO_BRIDGE", "SW_ERROR", "TOOL_ERROR",
]);
const MAX_SESSIONS = 128, MAX_ACTIVE = 96, MAX_RECENT = 20, MAX_TABS = 4096;
let nextId = 0;

function stateFor(sessionId: string): SessionState | undefined {
  const current = sessions.get(sessionId);
  if (current) return current;
  if (sessions.size >= MAX_SESSIONS) {
    const idle = [...sessions].find(([, state]) => state.active.size === 0);
    if (!idle) return undefined;
    sessions.delete(idle[0]);
  }
  const state: SessionState = { active: new Map(), recent: [], dropped: 0 };
  sessions.set(sessionId, state);
  return state;
}

export function bindDiagnosticTab(sessionId: string, tabId: number): void {
  if (!tabSessions.has(tabId) && tabSessions.size >= MAX_TABS) return;
  tabSessions.set(tabId, sessionId);
}
export function forgetDiagnosticTab(tabId: number): void { tabSessions.delete(tabId); }
export function reapDiagnostics(sessionId: string): void {
  sessions.delete(sessionId);
  for (const [tabId, owner] of tabSessions) if (owner === sessionId) tabSessions.delete(tabId);
}

/** Observation never changes the action result, retries it, or persists payloads. */
export async function traceOperation<T>(
  sessionId: unknown, operation: DiagnosticOperation, run: () => Promise<T>,
  options: { tabId?: number; budgetMs?: number } = {},
): Promise<T> {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128 || !allowed.has(operation)) return run();
  const state = stateFor(sessionId);
  if (!state || state.active.size >= MAX_ACTIVE) {
    if (state) state.dropped = Math.min(state.dropped + 1, Number.MAX_SAFE_INTEGER);
    return run();
  }
  // Pick only these fields: even a caller passing a larger object cannot log it.
  const entry: DiagnosticEntry = { id: ++nextId, operation, startedAt: Date.now(), durationMs: 0, status: "pending",
    ...(Number.isSafeInteger(options.tabId) && options.tabId! >= 0 ? { tabId: options.tabId } : {}) };
  state.active.set(entry.id, { entry, budgetMs: options.budgetMs });
  try {
    const result = await run();
    entry.status = "succeeded";
    return result;
  } catch (error) {
    entry.status = "failed";
    const code = (error as { code?: unknown } | null)?.code;
    entry.errorCode = typeof code === "string" && errorCodes.has(code) ? code : "TOOL_ERROR";
    throw error;
  } finally {
    entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
    state.active.delete(entry.id);
    // A late completion after session cleanup must not resurrect its history.
    if (sessions.get(sessionId) === state) {
      state.recent.unshift(entry);
      state.recent.length = Math.min(state.recent.length, MAX_RECENT);
    }
  }
}

export function traceTab<T>(tabId: number, operation: DiagnosticOperation, run: () => Promise<T>): Promise<T> {
  return traceOperation(tabSessions.get(tabId), operation, run, { tabId });
}

export function diagnosticSnapshot(sessionId: string): DiagnosticSnapshot {
  const state = sessions.get(sessionId);
  const now = Date.now();
  const active = [...(state?.active.values() ?? [])].map(({ entry, budgetMs }) => ({ ...entry,
    durationMs: Math.max(0, now - entry.startedAt),
    status: budgetMs !== undefined && now - entry.startedAt > budgetMs ? "overdue" as const : "pending" as const,
  }));
  return { active, recent: (state?.recent ?? []).map(entry => ({ ...entry })), dropped: state?.dropped ?? 0,
    degraded: active.some(entry => entry.status === "overdue") };
}

/** Preserve the native injection signature and payload; observe Promise callers.
 *  Callback callers keep native behavior and are not treated as Promise jobs. */
export const executeScript = ((...args: unknown[]) => {
  const invoke = () => Reflect.apply(chrome.scripting.executeScript, chrome.scripting, args);
  if (typeof args[1] === "function") return invoke();
  const tabId = (args[0] as { target: { tabId: number } }).target.tabId;
  return traceTab(tabId, "scripting.executeScript", invoke);
}) as typeof chrome.scripting.executeScript;
