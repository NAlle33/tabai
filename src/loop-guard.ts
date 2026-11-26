import { createHash, randomUUID } from "node:crypto";
import type { PanelLoopPause } from "../shared/control-panel";

const MAX_TABS = 32;
const FRESH_MS = 30_000;
const MUTATING_TOOLS = new Set(["form_input", "fill_form", "select_option", "file_upload", "file_drop"]);
const MUTATING_INPUT = new Set(["left_click", "right_click", "double_click", "triple_click", "type", "key", "scroll", "scroll_to", "left_click_drag"]);
type Observation = { document: string; page: string };
type State = { signature: string; observation?: Observation; unchanged: number; completed: boolean; busy: boolean; invalidated?: boolean; at: number; pause?: PanelLoopPause };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function guarded(tool: string, args: Record<string, unknown>): boolean {
  return MUTATING_TOOLS.has(tool) || tool === "computer" && MUTATING_INPUT.has(String(args.action));
}
function observation(value: unknown): Observation | undefined {
  const snapshot = value as { ok?: unknown; compact?: unknown; filter?: unknown; truncated?: unknown; elements?: unknown; frames?: unknown; scrollPositions?: unknown } | undefined;
  if (!snapshot || snapshot.ok !== true || snapshot.compact !== true || snapshot.filter !== "all" || snapshot.truncated !== false
    || typeof snapshot.elements !== "string" || snapshot.elements.length > 80_000 || !Array.isArray(snapshot.frames)
    || !snapshot.frames.length || snapshot.frames.length > 500 || snapshot.frames.some(frame => !Number.isSafeInteger(frame?.frameId) || typeof frame.documentId !== "string" || !frame.documentId)) return;
  const frames = [...snapshot.frames].sort((a, b) => a.frameId - b.frameId);
  if (!Array.isArray(snapshot.scrollPositions) || snapshot.scrollPositions.length !== frames.length) return;
  const positions = [...snapshot.scrollPositions].sort((a, b) => a.frameId - b.frameId);
  if (positions.some((position, index) => position.frameId !== frames[index].frameId || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || !Array.isArray(position.elements) || position.elements.length > 500 || position.elements.some((entry: unknown) => !Array.isArray(entry) || entry.length !== 3 || entry.some(n => typeof n !== "number" || !Number.isFinite(n))))) return;
  return { document: digest(frames), page: digest([snapshot.elements, positions]) };
}

/** Session-local, bounded evidence. No page data or arguments survive a process restart. */
export class LoopGuard {
  private states = new Map<number, State>();
  snapshot(): PanelLoopPause[] { return [...this.states.values()].flatMap(state => state.pause ? [{ ...state.pause }] : []); }
  continue(tabId: number, pauseId: string): boolean {
    const state = this.states.get(tabId);
    if (!state?.pause || state.pause.pauseId !== pauseId || state.busy) return false;
    this.states.delete(tabId); return true;
  }
  private blocked() {
    return Object.assign(new Error("LOOP_DETECTED: Three identical actions completed without an observed page change. This action was NOT dispatched. Inspect the page, then use Continue after inspection in the Tabai panel. Nothing is queued or replayed."), { code: "LOOP_DETECTED", retryable: false });
  }
  async run<T>(tool: string, args: Record<string, unknown>, dispatch: () => Promise<T>, inspect: (tabId: number) => Promise<unknown>): Promise<T> {
    const tabId = args.tabId;
    if (typeof tabId !== "number" || !Number.isSafeInteger(tabId)) return dispatch();
    const previous = this.states.get(tabId);
    // A pause fences every recognized mutation, even when its arguments change.
    if (guarded(tool, args) && previous?.pause) throw this.blocked();
    if (!guarded(tool, args)) {
      const resets = ["navigate", "tab_reload", "tabs_close_mcp"].includes(tool);
      if (resets && previous?.busy) previous.invalidated = true;
      const result = await dispatch();
      if (resets && this.states.get(tabId) === previous) this.states.delete(tabId);
      return result;
    }
    if (previous?.busy) { previous.invalidated = true; return dispatch(); }
    if (!previous && this.states.size >= MAX_TABS) {
      const disposable = [...this.states].find(([, state]) => !state.busy && !state.pause);
      if (!disposable) throw Object.assign(new Error("LOOP_GUARD_CAPACITY: All 32 observed tabs are paused or busy. This action was NOT dispatched. Inspect and continue or close an observed tab before mutating another tab."), { code: "LOOP_GUARD_CAPACITY", retryable: false });
      this.states.delete(disposable[0]);
    }
    const signature = digest([tool, canonical(args)]);
    const state: State = { signature, unchanged: 0, completed: false, busy: true, at: Date.now() };
    this.states.set(tabId, state);
    let current: Observation | undefined;
    const started = Date.now();
    try { current = observation(await inspect(tabId)); } catch { /* Missing evidence never establishes stagnation. */ }
    if (Date.now() - started > 2000) current = undefined;
    if (previous?.completed && previous.signature === signature && started - previous.at <= FRESH_MS
      && current && previous.observation?.document === current.document && previous.observation.page === current.page) {
      state.unchanged = previous.unchanged + 1;
    }
    state.observation = current;
    try {
      if (state.unchanged >= 3 && !state.invalidated) {
        state.pause = { pauseId: randomUUID(), tabId, tool, repetitions: state.unchanged, pausedAt: new Date().toISOString() };
        throw this.blocked();
      }
      const result = await dispatch();
      state.completed = !state.invalidated && !(result && typeof result === "object" && "ok" in result && result.ok === false);
      return result;
    } finally { state.busy = false; state.at = Date.now(); }
  }
}
