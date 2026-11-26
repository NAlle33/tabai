import { attachedTabIds, cdpSend, detachTab, onCdpEvent, sendIfAttached } from "./cdp";
import { assertTabInGroup, isOwnedTab, isTabInMappedGroup, sessionOf } from "./tab-group-helpers";

type DialogBehavior = "accept" | "dismiss";
type DialogArm = { behavior: DialogBehavior; promptText?: string };
type DialogEntry = { tabId: number; type: string; message: string; url: string; ts: number };
type DialogState = { arms: Map<number, DialogArm>; buffers: Map<number, DialogEntry[]> };
// Accept arms stay in memory and belong to their authenticated session, even if
// a tab moves into another session's group without detaching the debugger.
const sessions = new Map<string, DialogState>();

function forgetTab(tabId: number, buffers: boolean) {
  for (const [sessionId, state] of sessions) {
    state.arms.delete(tabId);
    if (buffers) state.buffers.delete(tabId);
    if (!state.arms.size && !state.buffers.size) sessions.delete(sessionId);
  }
}
chrome.tabs.onRemoved.addListener(tabId => forgetTab(tabId, true));
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId != null) forgetTab(source.tabId, false);
});
export function reapDialogState(sessionId: string): void { sessions.delete(sessionId); }

/** Tabs this extension may still be attached to. Its attachment survives a
 *  worker restart and the in-memory set does not, so every page target Chrome
 *  reports as attached is a candidate too. That list also names attachments of
 *  DevTools or another extension: their release steps are refused as "not
 *  attached", which is harmless, and nothing is ever attached to release. An
 *  unreadable list leaves the in-memory set. */
async function releaseCandidates(): Promise<number[]> {
  const tabIds = new Set(attachedTabIds());
  try {
    for (const target of await chrome.debugger.getTargets()) {
      if (target.type === "page" && target.attached && typeof target.tabId === "number") tabIds.add(target.tabId);
    }
  } catch { /* the in-memory set alone */ }
  return [...tabIds];
}

/** A tab that left every session's group is the user's again: its dialogs are
 *  no longer answered, emulation does not linger and the debugger detaches.
 *  The attachment is one per tab and records no session, so a tab in ANY mapped
 *  group keeps it — another session may own and use it now, and the ownership
 *  re-check below already refuses the previous owner's arms. Ownership is
 *  checked again right before every step; default-dismiss stays unchanged. */
export async function releaseUnownedTabs(): Promise<void> {
  await Promise.all((await releaseCandidates()).map(async tabId => {
    // An unreadable tab or mapping is not evidence of release; keep it.
    const unowned = () => isTabInMappedGroup(tabId).then(mapped => !mapped, () => false);
    if (!(await unowned())) return;
    forgetTab(tabId, false);
    await sendIfAttached(tabId, "Page.disable").catch(() => {});
    if (!(await unowned())) return;
    await sendIfAttached(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    if (!(await unowned())) return;
    await detachTab(tabId).catch(() => {});
  }));
}

function answer(tabId: number, arm?: DialogArm) {
  // Never replay an ambiguous dispatch. Dismiss also handles worker restarts,
  // absent arms and unavailable ownership without leaving the renderer wedged.
  try {
    chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog",
      { accept: arm?.behavior === "accept", ...(arm?.behavior === "accept" ? { promptText: arm.promptText } : {}) },
      () => void chrome.runtime.lastError);
  } catch { /* dialog already gone or debugger detached */ }
}

onCdpEvent("Page.javascriptDialogOpening", (tabId, params) => {
  const owner = [...sessions].find(([, state]) => state.arms.has(tabId));
  if (!owner) { answer(tabId); return; }
  const [sessionId, state] = owner, arm = state.arms.get(tabId)!;
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let owned = false;
    try {
      // Read-only: the renderer is blocked on this dialog, so the check must
      // neither wait for the group write lock nor start an identity refresh.
      owned = await Promise.race([
        isOwnedTab(sessionId, tabId).catch(() => false),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!owned || sessions.get(sessionId) !== state || state.arms.get(tabId) !== arm) {
      if (state.arms.get(tabId) === arm) state.arms.delete(tabId);
      answer(tabId); return;
    }
    const entries = state.buffers.get(tabId) ?? [];
    entries.push({ tabId, type: String(params?.type ?? "dialog"), message: String(params?.message ?? ""), url: String(params?.url ?? ""), ts: Date.now() });
    if (entries.length > 50) entries.shift();
    state.buffers.set(tabId, entries);
    const buffers = [...sessions.values()].flatMap(value => [...value.buffers.values()]);
    if (buffers.reduce((total, buffer) => total + buffer.length, 0) > 500) {
      buffers.filter(buffer => buffer.length).sort((a, b) => a[0].ts - b[0].ts)[0].shift();
    }
    answer(tabId, arm);
  })().catch(() => answer(tabId));
});

export async function toolDialog(args: {
  action: "arm" | "disarm" | "get";
  tabId: number;
  behavior?: DialogBehavior;
  promptText?: string;
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  if (args.action === "arm") {
    await cdpSend(args.tabId, "Page.enable");
    await assertTabInGroup(sessionId, args.tabId);
    forgetTab(args.tabId, false);
    const state = sessions.get(sessionId) ?? { arms: new Map(), buffers: new Map() };
    sessions.set(sessionId, state);
    state.arms.set(args.tabId, { behavior: args.behavior ?? "dismiss", promptText: args.promptText });
    return { ok: true, armed: true, behavior: args.behavior ?? "dismiss" };
  }
  const state = sessions.get(sessionId);
  if (args.action === "disarm") {
    state?.arms.delete(args.tabId);
    try { await cdpSend(args.tabId, "Page.disable"); } catch { /* not attached / already gone */ }
    return { ok: true, armed: false };
  }
  const dialogs = state?.buffers.get(args.tabId) ?? [];
  return { armed: state?.arms.has(args.tabId) ?? false, count: dialogs.length, dialogs };
}
