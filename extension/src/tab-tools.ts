import { assertTabInGroup, sessionOf, createMcpGroup, dropGroupIfStale, getGroupId, tabSummary, tabsInGroup, refreshGroupIdentity, ensureGroupIdentityCurrent } from "./tab-group-helpers";
import { waitInTab } from "./page-wait";
import { cdpSend } from "./cdp";
import { ToolError } from "./tool-error";
import { assertAgentFocusAllowed } from "./agent-focus";
import { normalizeNavigationUrl } from "../../shared/url-guard";
// ---- tabs / navigation -----------------------------------------------------

export async function toolTabsContext(args: { createIfEmpty?: boolean; createWindowId?: number; incognito?: boolean }) {
  const version = chrome.runtime.getManifest().version;
  const sessionId = sessionOf(args);
  let groupId = await getGroupId(sessionId);
  // Record tabs the page opened itself before answering: the caller may close
  // the recorded ones next. A group lost meanwhile is re-read (and dropped). A
  // failed recording does not cost the answer: tabs_close_mcp records again
  // and closes nothing when it cannot.
  if (groupId != null) {
    let owned = true;
    try { owned = await ensureGroupIdentityCurrent(sessionId); } catch { /* answered as verified above */ }
    if (!owned) groupId = await getGroupId(sessionId);
  }
  if (groupId != null) {
    const tabs = await tabsInGroup(groupId, sessionId);
    if (tabs.length > 0)
      return { version, groupId, tabs: tabs.map(tabSummary) };
    // Empty group: drop the mapping unless a concurrent create already replaced it.
    await dropGroupIfStale(sessionId, groupId);
    groupId = null;
  }
  if (!args.createIfEmpty) {
    return {
      version,
      groupId: null,
      tabs: [],
      note: "No MCP tab group. Call again with createIfEmpty=true to create one.",
    };
  }
  const { groupId: newGroupId } = await createMcpGroup(sessionId, args.createWindowId, args.incognito === true);
  const tabs = await tabsInGroup(newGroupId, sessionId);
  return { version, groupId: newGroupId, tabs: tabs.map(tabSummary) };
}


export async function toolTabsClose(args: { tabId: number }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  // Closing the last recorded tab must not cost the session the tabs the page
  // opened itself: record them first. Nothing is closed when that fails, so the
  // caller can safely try again.
  let recorded = false;
  try { recorded = await ensureGroupIdentityCurrent(sessionId); } catch { /* refused below */ }
  if (!recorded) {
    throw new ToolError("GROUP_IDENTITY_UNAVAILABLE", `Could not record this session's tabs before closing tab ${args.tabId}; nothing was closed. Call tabs_context_mcp, then try again.`);
  }
  // A recording can wait long for the group lock; the tab may have left the group meanwhile.
  await assertTabInGroup(sessionId, args.tabId);
  await chrome.tabs.remove(args.tabId);
  return { ok: true, closed: args.tabId };
}


export async function toolResizeWindow(args: {
  width: number;
  height: number;
  tabId: number;
}) {
  const tab = await assertTabInGroup(sessionOf(args), args.tabId);
  await chrome.windows.update(tab.windowId, {
    width: args.width,
    height: args.height,
    state: "normal",
  });
  const win = await chrome.windows.get(tab.windowId);
  return { ok: true, width: win.width, height: win.height };
}


export async function toolTabsCreate(args: unknown) {
  const sessionId = sessionOf(args);
  const groupId = await getGroupId(sessionId);
  const groupTabs = groupId != null ? await tabsInGroup(groupId, sessionId) : [];
  if (groupId == null || groupTabs.length === 0) {
    // Group lost (or never created) — auto-recover with a fresh window + group
    // instead of failing.
    const { tab } = await createMcpGroup(sessionId);
    return tabSummary(await chrome.tabs.get(tab.id!));
  }
  const windowId = groupTabs[0]?.windowId;
  const tab = await chrome.tabs.create({
    windowId,
    url: "about:blank",
    active: false,
  });
  if (!tab.id) throw new Error("Failed to create tab.");
  try {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
    if (!(await refreshGroupIdentity(sessionId))) throw new Error("Session group changed while adding the tab.");
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
  return tabSummary(await chrome.tabs.get(tab.id));
}


export async function toolNavigate(args: {
  url: string;
  tabId: number;
  waitUntil?: "load" | "networkIdle";
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  if (args.url === "back" || args.url === "forward") {
    // The tabs API follows Chrome's UI skipping rules for entries without
    // user activation. Tools need the adjacent entry, including synthetic clicks
    // and pushState entries that those rules would skip.
    const history = await cdpSend<{
      currentIndex: number;
      entries: { id: number; url: string }[];
    }>(args.tabId, "Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + (args.url === "back" ? -1 : 1)];
    if (!entry) throw new Error(`No ${args.url === "back" ? "previous" : "next"} page in history.`);
    const norm = normalizeNavigationUrl(entry.url);
    if ("error" in norm) throw new Error(norm.error);
    return navigateAndSettle(
      sessionId,
      args.tabId,
      () => cdpSend(args.tabId, "Page.navigateToHistoryEntry", { entryId: entry.id }),
      args.waitUntil,
    );
  }
  // Allowlist: only http/https (+ scheme-less → https) and about:blank.
  const norm = normalizeNavigationUrl(args.url);
  if ("error" in norm) throw new Error(norm.error);
  return navigateAndSettle(
    sessionId,
    args.tabId,
    () => chrome.tabs.update(args.tabId, { url: norm.url }),
    args.waitUntil,
  );
}


/**
 * Arm the load-complete listener BEFORE triggering navigation (so a fast
 * 'complete' that fires before we attach isn't missed), run the nav action,
 * then wait for load complete and (default) for the network to go idle.
 */
async function navigateAndSettle(
  sessionId: string,
  tabId: number,
  action: () => Promise<unknown>,
  waitUntil: string | undefined,
): Promise<unknown> {
  await assertTabInGroup(sessionId, tabId);
  const pending = waitForComplete(tabId);
  try {
    await action();
  } catch (e) {
    // Nav call itself failed — tear down the
    // armed listener immediately instead of leaving it until its timeout.
    pending.cancel();
    throw e;
  }
  const result = await pending.promise;
  if ((waitUntil ?? "networkIdle") === "networkIdle") {
    try {
      await waitInTab(sessionId, tabId, "network_idle", "", 5000);
    } catch {
      /* best-effort — don't fail navigate if not idle */
    }
  }
  await assertTabInGroup(sessionId, tabId);
  return result;
}


function waitForComplete(
  tabId: number,
  timeoutMs = 25_000,
): { promise: Promise<unknown>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    // Pre-navigation URL, for the same-document case below. Read asynchronously
    // so the listeners are armed synchronously (before the caller's action).
    let urlBefore: string | undefined;
    let snapshotDone = false;
    chrome.tabs
      .get(tabId)
      .then((t) => {
        urlBefore = t.url;
      })
      .catch(() => {})
      .finally(() => {
        snapshotDone = true;
      });
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (id !== tabId) return;
      if (info.status === "complete") {
        cleanup();
        resolve(tabSummary(tab));
        return;
      }
      // Same-document navigation (fragment / pushState): Chrome only reports the
      // new `url` while the tab stays "complete" — there is no loading/complete
      // cycle to wait for, and waiting would run into the timeout.
      if (info.url && tab.status === "complete" && (!snapshotDone || info.url !== urlBefore)) {
        cleanup();
        resolve(tabSummary(tab));
      }
    };
    const onRemoved = (id: number) => {
      if (id !== tabId) return;
      cleanup();
      reject(new ToolError("TAB_NOT_FOUND", `Tab ${tabId} was closed during navigation.`));
    };
    const timer = setTimeout(() => {
      cleanup();
      chrome.tabs
        .get(tabId)
        .then((t) =>
          resolve({
            ...tabSummary(t),
            note: "load did not reach 'complete' before timeout",
          }),
        )
        .catch(reject);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    cancel = cleanup;
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
  return { promise, cancel };
}


export async function toolTabSwitch(args: { tabId: number; bringToFront?: boolean }) {
  const tab = await assertTabInGroup(sessionOf(args), args.tabId);
  if (args.bringToFront === true) await assertAgentFocusAllowed();
  await chrome.tabs.update(args.tabId, { active: true });
  if (args.bringToFront === true) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* window may be unfocusable; activating the tab is the main effect */
    }
  }
  return tabSummary(await chrome.tabs.get(args.tabId));
}


/** tab_reload: reload a tab + wait for load (and, by default, network idle). */
export async function toolTabReload(args: {
  tabId: number;
  waitUntil?: "load" | "networkIdle";
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  return navigateAndSettle(sessionId, args.tabId, () => chrome.tabs.reload(args.tabId), args.waitUntil);
}


/** tab_duplicate: duplicate a tab; the copy joins the CALLER's group. */
export async function toolTabDuplicate(args: { tabId: number }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const groupId = await getGroupId(sessionId);
  if (groupId == null) throw new Error("No MCP group for this session.");
  const dup = await chrome.tabs.duplicate(args.tabId);
  if (!dup?.id) throw new Error("Failed to duplicate tab.");
  try {
    await chrome.tabs.group({ groupId, tabIds: [dup.id] });
    if (!(await refreshGroupIdentity(sessionId))) throw new Error("Session group changed while duplicating the tab.");
  } catch (e) {
    // Don't leave the copy orphaned — an ungrouped tab is never reaped.
    await chrome.tabs.remove(dup.id).catch(() => {});
    throw e;
  }
  return tabSummary(await chrome.tabs.get(dup.id));
}
