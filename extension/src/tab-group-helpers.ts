// MCP tab-group ownership — PER SESSION. Each broker-authenticated sessionId owns
// its own tab group; a session can only see/control tabs in ITS group. Stored as
// a map { [sessionId]: groupId } in chrome.storage.local.
//
// sessionId is injected into every tool's args by the service worker
// (background.ts) from the broker-stamped, authenticated value — never from
// client-supplied data. Missing/empty sessionId FAILS CLOSED (no shared
// "default" group): isolation is the trust boundary.

import { ToolError } from "./tool-error";
import { bindDiagnosticTab, traceOperation } from "./diagnostics";
import { groupTitle, normalizeSessionName } from "../../shared/session-name";
export { groupTitle } from "../../shared/session-name";

const GROUPS_KEY = "mcpGroups";
const SESSION_NAME_PREFIX = "mcpSessionName:";
const GROUP_IDENTITY_PREFIX = "mcpGroupIdentity:";

type GroupMap = Record<string, number>;
type GroupIdentity = { groupId: number; targets: Record<string, string> };

function sessionNameKey(sessionId: string): string {
  return SESSION_NAME_PREFIX + sessionId;
}

/** Extract the SW-injected, broker-authenticated sessionId from a tool's args.
 *  Throws (fail-closed) if it's missing — no call touches a group without one. */
export function sessionOf(args: unknown): string {
  const sid = (args as { __sessionId?: unknown } | null)?.__sessionId;
  if (typeof sid !== "string" || !sid) {
    throw new ToolError("NO_SESSION", "No session for this call — reconnect the MCP server.");
  }
  return sid;
}

async function loadGroups(sessionId?: string): Promise<GroupMap> {
  const stored = await traceOperation(sessionId, "storage.local.get", () => chrome.storage.local.get(GROUPS_KEY));
  const m = stored[GROUPS_KEY];
  return m && typeof m === "object" ? (m as GroupMap) : {};
}

/** Previous readable identity, accepted only as an exact migration input. */
function legacyGroupTitle(sessionId: string): string {
  const prefix = sessionId.slice(0, 4);
  // An injective encoding of the existing 16-bit title identity: friendly names
  // must not reduce the ownership check to a generic brand prefix.
  const syllables = ["lu", "mi", "na", "ra", "so", "vi", "lo", "ne", "sa", "li", "mo", "va", "no", "ri", "ma", "ve"];
  const name = /^[0-9a-f]{4}$/.test(prefix)
    ? [prefix.slice(0, 2), prefix.slice(2)].map(pair => {
      const word = [...pair].map(char => syllables[parseInt(char, 16)]).join("");
      return word[0].toUpperCase() + word.slice(1);
    }).join(" ")
    : prefix;
  return `Tabai · ${name}`;
}

async function sessionTitle(sessionId: string): Promise<string> {
  const key = sessionNameKey(sessionId);
  const stored = await traceOperation(sessionId, "storage.local.get", () => chrome.storage.local.get(key));
  return groupTitle(sessionId, stored[key]);
}

/** The hello label is stable for this session. Persist before creating or
 *  migrating its group so worker restarts retain the exact expected title.
 *  Every call carries the label but only the first has anything to write, so
 *  only that one waits for the group write lock (and re-reads under it). */
export async function rememberSessionName(sessionId: string, value: unknown): Promise<void> {
  const name = normalizeSessionName(value);
  if (!name) return;
  const key = sessionNameKey(sessionId);
  const stored = async () => normalizeSessionName(
    (await traceOperation(sessionId, "storage.local.get", () => chrome.storage.local.get(key)))[key]);
  if (await stored()) return;
  await withGroupsLock(async () => {
    if (await stored()) return;
    await traceOperation(sessionId, "storage.local.set", () => chrome.storage.local.set({ [key]: name }));
  });
}

async function isLegacyTitle(title: string | undefined, sessionId: string): Promise<boolean> {
  const suffix = sessionId.slice(0, 4);
  return title === `${await sessionTitle(sessionId)} · ${suffix}` || title === `Tabai · ${suffix}`
    || title === legacyGroupTitle(sessionId) || title === `MCP·${suffix}`;
}

/** Only opaque page-target UUIDs are retained, never URLs or page titles.
 *  Unlike numeric tab/group IDs, these identify the actual live browser targets. */
async function groupTargets(id: number, sessionId: string): Promise<Record<string, string>> {
  const tabs = await traceOperation(sessionId, "tabs.query", () => chrome.tabs.query({ groupId: id }));
  const ids = new Set(tabs.map(tab => tab.id));
  const targets = await traceOperation(sessionId, "debugger.getTargets", () => chrome.debugger.getTargets());
  return Object.fromEntries(targets.filter(target => target.type === "page" && target.tabId !== undefined && ids.has(target.tabId))
    .map(target => [String(target.tabId), target.id]));
}

/** Called only under the group write lock, after creation or verified ownership. */
async function saveGroupIdentity(id: number, sessionId: string, live?: Record<string, string>): Promise<void> {
  const targets = live ?? await groupTargets(id, sessionId);
  if (!Object.keys(targets).length) throw new ToolError("GROUP_IDENTITY_UNAVAILABLE", "Could not verify this group's browser identity. Try again once its tabs are ready.");
  const identity: GroupIdentity = { groupId: id, targets };
  await traceOperation(sessionId, "storage.local.set", () => chrome.storage.local.set({ [GROUP_IDENTITY_PREFIX + sessionId]: identity }));
}

/** `stale`: owned, but tabs joined or left the group since its proof was
 *  recorded. An exact legacy title carries no recorded set and reports nothing. */
type Ownership =
  | { owned: false }
  | { owned: true; legacy: true; stale: false }
  | { owned: true; legacy: false; stale: boolean; live: Record<string, string> };

function sameTargets(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => b[key] === a[key]);
}

/** A project title is display metadata. Plain names require an exact stored
 *  mapping AND at least one recorded target still inside that same group. A
 *  recycled numeric group/tab ID after Chrome restarts cannot supply that UUID.
 *  Old encoded titles are accepted exactly, only as migration inputs. Runs with
 *  or without the group lock held and never takes it. */
async function inspectSessionGroup(id: number, sessionId: string): Promise<Ownership> {
  try {
    let group: chrome.tabGroups.TabGroup;
    try { group = await traceOperation(sessionId, "tabGroups.get", () => chrome.tabGroups.get(id)); }
    catch {
      // A failed read is not evidence of deletion. Confirm absence independently
      // before allowing the caller to discard ownership and create a new window.
      const groups = await traceOperation(sessionId, "tabGroups.query", () => chrome.tabGroups.query({}));
      if (!groups.some(group => group.id === id)) return { owned: false };
      throw new Error('The mapped group still exists but could not be inspected.');
    }
    const { title } = group;
    if (await isLegacyTitle(title, sessionId)) return { owned: true, legacy: true, stale: false };
    if (title !== await sessionTitle(sessionId)) return { owned: false };
    const key = GROUP_IDENTITY_PREFIX + sessionId;
    const stored = await traceOperation(sessionId, "storage.local.get", () => chrome.storage.local.get(key));
    const identity = stored[key] as GroupIdentity | undefined;
    if (!identity || identity.groupId !== id || !identity.targets || typeof identity.targets !== "object") return { owned: false };
    const live = await groupTargets(id, sessionId);
    if (!Object.entries(live).some(([tabId, targetId]) => identity.targets[tabId] === targetId)) return { owned: false };
    return { owned: true, legacy: false, stale: !sameTargets(live, identity.targets), live };
  } catch {
    throw new ToolError("GROUP_IDENTITY_UNAVAILABLE", "Could not verify this session's group temporarily. Its mapping was retained; inspect the previous action's outcome before continuing.");
  }
}

async function isSessionGroup(id: number, sessionId: string): Promise<boolean> {
  return (await inspectSessionGroup(id, sessionId)).owned;
}

/** Re-verify ownership under the group write lock, then record the group's
 *  current tabs — including ones the page opened itself (target=_blank,
 *  window.open), so closing the recorded tabs cannot cost the session its own
 *  group. Never from a title alone; nothing is written when the sets match. */
export async function refreshGroupIdentity(sessionId: string): Promise<boolean> {
  return withGroupsLock(async () => {
    const id = (await loadGroups(sessionId))[sessionId];
    if (typeof id !== "number") return false;
    const ownership = await inspectSessionGroup(id, sessionId);
    if (!ownership.owned) return false;
    if (ownership.legacy || ownership.stale) await saveGroupIdentity(id, sessionId, ownership.legacy ? undefined : ownership.live);
    return true;
  });
}

/** Whether this session owns its mapped group, with its current tabs recorded.
 *  The inspection takes no lock: only a legacy title or live tabs that differ
 *  from the recorded ones go on to refreshGroupIdentity, so a call whose proof
 *  is current never queues behind another session's stuck cleanup. A failed
 *  inspection or recording throws. */
export async function ensureGroupIdentityCurrent(sessionId: string): Promise<boolean> {
  const id = (await loadGroups(sessionId))[sessionId];
  if (typeof id !== "number") return false;
  const ownership = await inspectSessionGroup(id, sessionId);
  if (!ownership.owned) return false;
  return ownership.legacy || ownership.stale ? refreshGroupIdentity(sessionId) : true;
}

/** Checks that run after an action must neither wait for the group lock nor
 *  fail (and so invite a replay) because of a refresh. Start one in the
 *  background instead: one per session, with one follow-up when another check
 *  asked meanwhile. A failed refresh is ignored; the next stale check retries. */
const backgroundRefreshes = new Map<string, { again: boolean }>();
export function refreshGroupIdentitySoon(sessionId: string): void {
  const running = backgroundRefreshes.get(sessionId);
  if (running) { running.again = true; return; }
  const state = { again: false };
  backgroundRefreshes.set(sessionId, state);
  const run = (): void => {
    void refreshGroupIdentity(sessionId).catch(() => false).then(() => {
      if (!state.again) { backgroundRefreshes.delete(sessionId); return; }
      state.again = false;
      run();
    });
  };
  run();
}

/** The session's group id, or null when unmapped or the mapped id no longer
 *  names this session's group (the stale mapping is dropped). A group whose
 *  tabs changed since its proof was recorded is refreshed in the background.
 *  Never call this inside withGroupsLock — the drop takes that lock. */
export async function getGroupId(sessionId: string): Promise<number | null> {
  const id = (await loadGroups(sessionId))[sessionId];
  if (typeof id !== "number") return null;
  const ownership = await inspectSessionGroup(id, sessionId);
  if (ownership.owned) {
    if (ownership.stale) refreshGroupIdentitySoon(sessionId);
    return id;
  }
  await dropGroupIfStale(sessionId, id);
  return null;
}

/** Ownership lookup for observers (health, the panel's tab list, the dialog
 *  race): it never records tabs, never drops a stale mapping and never waits for
 *  the group write lock. Tool handlers use getGroupId/assertTabInGroup. */
export async function lookupGroupId(sessionId: string): Promise<number | null> {
  const id = (await loadGroups(sessionId))[sessionId];
  return typeof id === "number" && await isSessionGroup(id, sessionId) ? id : null;
}

/** Read-only counterpart of assertTabInGroup for observers; see lookupGroupId. */
export async function isOwnedTab(sessionId: string, tabId: number): Promise<boolean> {
  const groupId = await lookupGroupId(sessionId);
  if (groupId == null) return false;
  const tab = await traceOperation(sessionId, "tabs.get", () => chrome.tabs.get(tabId), { tabId });
  return tab.groupId === groupId;
}

/** Whether the tab sits in a group that any session has mapped. */
export async function isTabInMappedGroup(tabId: number): Promise<boolean> {
  const [tab, groups] = await Promise.all([chrome.tabs.get(tabId), loadGroups()]);
  return Object.values(groups).includes(tab.groupId);
}

// All mcpGroups mutations funnel through the single service worker; serialize the
// read-modify-write so two sessions creating their first group CONCURRENTLY can't
// clobber each other's entry (last-writer-wins on the whole stored object).
let groupsWriteChain: Promise<unknown> = Promise.resolve();
function withGroupsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = groupsWriteChain.then(fn, fn);
  groupsWriteChain = run.catch(() => {});
  return run;
}

/** Compare-and-delete: drop the session's mapping ONLY if it still points at
 *  `staleId`. A createMcpGroup that raced in and already wrote a fresh id must
 *  not lose it (the loser would orphan the new window). */
export async function dropGroupIfStale(sessionId: string, staleId: number): Promise<void> {
  await withGroupsLock(async () => {
    const groups = await loadGroups(sessionId);
    if (groups[sessionId] !== staleId) return;
    delete groups[sessionId];
    await traceOperation(sessionId, "storage.local.set", () => chrome.storage.local.set({ [GROUPS_KEY]: groups }));
  });
}

/** All sessionId -> groupId entries (for lifecycle sweeps in later phases). */
export async function allGroups(): Promise<GroupMap> {
  return loadGroups();
}

/** Upgrade only a still-mapped, exactly identified group. This writes no group
 *  mapping, so it must not hold the ownership lock while a cosmetic Chrome API
 *  is pending. Chrome group IDs are unique within this browser session. */
export async function refreshGroupAppearance(sessionId: string): Promise<void> {
  const id = (await loadGroups(sessionId))[sessionId];
  if (typeof id !== "number") return;
  const group = await traceOperation(sessionId, "tabGroups.get", () => chrome.tabGroups.get(id));
  const title = await sessionTitle(sessionId);
  if (!(await isSessionGroup(id, sessionId))) return;
  // Establish durable browser identity before removing a legacy identity from
  // the visible title. Release the write lock before the cosmetic update.
  if (group.title !== title && !(await refreshGroupIdentity(sessionId))) return;
  if ((await loadGroups(sessionId))[sessionId] !== id) return;
  if (group.title !== title || group.color !== "blue") {
    await traceOperation(sessionId, "tabGroups.update", () => chrome.tabGroups.update(id, { title, color: "blue" }));
  }
}

export async function tabsInGroup(groupId: number, sessionId?: string): Promise<chrome.tabs.Tab[]> {
  try {
    return await traceOperation(sessionId, "tabs.query", () => chrome.tabs.query({ groupId }));
  } catch {
    throw new ToolError("GROUP_IDENTITY_UNAVAILABLE", "The group's tabs are temporarily unavailable. Its mapping was retained; inspect the previous action's outcome before continuing.");
  }
}

export function tabSummary(t: chrome.tabs.Tab) {
  return {
    tabId: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    status: t.status,
    index: t.index,
    favIconUrl: t.favIconUrl,
    incognito: t.incognito,
  };
}

/** Throw unless tabId exists and belongs to THIS session's MCP group. The single
 *  isolation chokepoint — fails closed on a missing session or a foreign tab. */
export async function assertTabInGroup(
  sessionId: string,
  tabId: number,
): Promise<chrome.tabs.Tab> {
  const groupId = await getGroupId(sessionId);
  if (groupId == null) {
    throw new ToolError(
      "TAB_NOT_IN_GROUP",
      "No MCP tab group for this session. Call tabs_context_mcp with createIfEmpty=true first.",
    );
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await traceOperation(sessionId, "tabs.get", () => chrome.tabs.get(tabId), { tabId });
  } catch {
    throw new ToolError("TAB_NOT_FOUND", `Tab ${tabId} not found.`);
  }
  if (tab.groupId !== groupId) {
    throw new ToolError(
      "TAB_NOT_IN_GROUP",
      `Tab ${tabId} is not in your session's MCP tab group. Only your own MCP tabs are controllable.`,
    );
  }
  bindDiagnosticTab(sessionId, tabId);
  return tab;
}

/** Create an owned tab group for this session, persist its id. An explicit
 *  target window creates a new tab there; otherwise create a background window.
 *  The group is automation-owned: the session's tools operate inside it and reap
 *  closes everything in it. Group + title + mapping are committed under the SAME
 *  lock so a concurrent reap can't observe a titled-but-unmapped group. */
export async function createMcpGroup(
  sessionId: string,
  createWindowId?: number,
  incognito = false,
): Promise<{ groupId: number; tab: chrome.tabs.Tab }> {
  // The WHOLE operation (window create included) runs under the lock, re-checking
  // the mapping FIRST. Two concurrent createMcpGroup calls for one session
  // (parallel tool calls / retries) must not each spawn a window: the first wins,
  // the second reuses it. Creating the window OUTSIDE the lock orphans the loser's
  // window — reapSession only closes the MAPPED group, so it could never collect
  // it (a window that leaks past session end).
  return await withGroupsLock(async () => {
    const unfinished = pendingCreations.get(sessionId);
    if (unfinished) await cleanFailedCreation(sessionId, unfinished);
    const existing = (await loadGroups(sessionId))[sessionId];
    if (typeof existing === "number" && (await isSessionGroup(existing, sessionId))) {
      const tabs = await traceOperation(sessionId, "tabs.query", () => chrome.tabs.query({ groupId: existing }));
      if (tabs[0]?.id) return { groupId: existing, tab: tabs[0] };
      // mapping present but the group is empty/gone — fall through to recreate
      // (the stale id is overwritten below, under this same lock).
    }
    let tab: chrome.tabs.Tab | undefined;
    if (incognito) {
      // A separate incognito window keeps the user's normal sign-ins out. Chrome
      // allows it only after the user enabled "Allow in Incognito" for Tabai.
      if (createWindowId !== undefined) throw new ToolError("INVALID_ARGUMENT", "createWindowId and incognito cannot be combined.");
      if (!(await chrome.extension.isAllowedIncognitoAccess())) throw new ToolError("INCOGNITO_UNAVAILABLE", "Tabai is not allowed in incognito windows. Enable \"Allow in Incognito\" for Tabai in chrome://extensions.");
      const win = await traceOperation(sessionId, "windows.create", () => chrome.windows.create({ focused: false, incognito: true, url: "about:blank" }));
      tab = win.tabs?.[0];
    } else if (createWindowId !== undefined) {
      if (!Number.isInteger(createWindowId) || createWindowId < 0) throw new ToolError("WINDOW_UNAVAILABLE", "Panelens Chrome-fönster kunde inte hittas. Öppna panelen igen.");
      let win: chrome.windows.Window;
      try { win = await traceOperation(sessionId, "windows.get", () => chrome.windows.get(createWindowId)); }
      catch { throw new ToolError("WINDOW_UNAVAILABLE", "Panelens Chrome-fönster har stängts. Starta uppdraget från panelen i ett öppet fönster."); }
      if (win.type !== "normal" || win.incognito) throw new ToolError("WINDOW_UNAVAILABLE", "Starta uppdraget från panelen i ett vanligt Chrome-fönster.");
      tab = await traceOperation(sessionId, "tabs.create", () => chrome.tabs.create({ windowId: createWindowId, active: false, url: "about:blank" }));
    } else {
      // Ordinary external sessions still leave the user's foreground alone.
      const win = await traceOperation(sessionId, "windows.create", () => chrome.windows.create({ focused: false, url: "about:blank" }));
      tab = win.tabs?.[0];
    }
    if (!tab?.id) throw new Error("Failed to create window/tab.");
    let gid: number | undefined;
    try {
      gid = await traceOperation(sessionId, "tabs.group", () => chrome.tabs.group({ tabIds: [tab!.id!], createProperties: { windowId: tab!.windowId } }), { tabId: tab.id });
      const title = await sessionTitle(sessionId);
      await traceOperation(sessionId, "tabGroups.update", () => chrome.tabGroups.update(gid!, { title, color: "blue" }));
      await saveGroupIdentity(gid, sessionId);
      const groups = await loadGroups(sessionId);
      groups[sessionId] = gid;
      await traceOperation(sessionId, "storage.local.set", () => chrome.storage.local.set({ [GROUPS_KEY]: groups }));
      return { groupId: gid, tab };
    } catch (error) {
      const pending: FailedCreation = { tab, groupId: gid };
      pendingCreations.set(sessionId, pending);
      try {
        if (await cleanFailedCreation(sessionId, pending)) return { groupId: gid!, tab };
      } catch { retryFailedCreation(sessionId, pending, 2); }
      throw error;
    }
  });
}

type FailedCreation = { tab: chrome.tabs.Tab; groupId?: number; timer?: ReturnType<typeof setTimeout> };
const pendingCreations = new Map<string, FailedCreation>();

/** Runs under the group lock. A failed cleanup remains reachable, and blocks a
 * replacement creation until the old resource is removed or adopted by a user. */
async function cleanFailedCreation(sessionId: string, pending: FailedCreation): Promise<boolean> {
  if (pending.timer) clearTimeout(pending.timer);
  const { tab, groupId } = pending, groups = await loadGroups(sessionId);
  // A rejected storage write may have committed. Never roll back a verified,
  // published group just because its acknowledgement was lost.
  if (groupId !== undefined && groups[sessionId] === groupId && await isSessionGroup(groupId, sessionId)) {
    pendingCreations.delete(sessionId); return true;
  }
  let current: chrome.tabs.Tab | undefined;
  try { current = await chrome.tabs.get(tab.id!); }
  catch (error) {
    if ((await chrome.tabs.query({})).some(candidate => candidate.id === tab.id)) throw error;
  }
  if (current && current.windowId === tab.windowId && current.groupId === (groupId ?? tab.groupId)
    && current.url === "about:blank" && (!current.pendingUrl || current.pendingUrl === "about:blank")) {
    await traceOperation(sessionId, "tabs.remove", () => chrome.tabs.remove(tab.id!));
  }
  if (groupId !== undefined && groups[sessionId] === groupId) {
    delete groups[sessionId];
    await chrome.storage.local.set({ [GROUPS_KEY]: groups });
  }
  await chrome.storage.local.remove(GROUP_IDENTITY_PREFIX + sessionId);
  pendingCreations.delete(sessionId);
  return false;
}

function retryFailedCreation(sessionId: string, pending: FailedCreation, remaining: number): void {
  pending.timer = setTimeout(() => {
    void withGroupsLock(async () => {
      if (pendingCreations.get(sessionId) !== pending) return;
      try { await cleanFailedCreation(sessionId, pending); }
      catch {
        if (remaining) retryFailedCreation(sessionId, pending, remaining - 1);
        else console.warn("[tabs] Creation cleanup pending; the next creation will retry it");
      }
    });
  }, 1000);
}

/** Reap a session's tab group when its session ends: close the group's own tabs +
 *  drop the mapping (closing the group's tabs empties — and thus closes — the
 *  MCP-created window). Guards against Chrome group-id reuse: only reap a group
 *  still UNIQUELY mapped to this session AND still carrying its own title. */
export async function reapSession(sessionId: string, isCurrent: () => boolean = () => true): Promise<void> {
  await withGroupsLock(async () => {
    if (!isCurrent()) return;
    const groups = await loadGroups(sessionId);
    const groupId = groups[sessionId];
    // Validate while the stored name still exists; removing it first would
    // make an owned project title look foreign to the reaper.
    const owned = typeof groupId === "number" && await isSessionGroup(groupId, sessionId);
    if (typeof groupId === "number" && owned && !Object.entries(groups).some(([other, id]) => other !== sessionId && id === groupId)) {
      const tabs = await traceOperation(sessionId, "tabs.query", () => chrome.tabs.query({ groupId }));
      const ids = tabs.map(tab => tab.id).filter((id): id is number => typeof id === "number");
      if (!isCurrent()) return;
      if (ids.length) {
        try { await traceOperation(sessionId, "tabs.remove", () => chrome.tabs.remove(ids)); }
        catch (error) {
          // Only confirmed absence makes a failed close harmless. Retain the
          // complete ownership proof for a later attempt after transient errors.
          if ((await traceOperation(sessionId, "tabs.query", () => chrome.tabs.query({ groupId }))).length) throw error;
        }
      }
    }
    if (!isCurrent()) return;
    delete groups[sessionId];
    await traceOperation(sessionId, "storage.local.set", () => chrome.storage.local.set({ [GROUPS_KEY]: groups }));
    if (!isCurrent()) return;
    await traceOperation(sessionId, "storage.local.remove", () => chrome.storage.local.remove([sessionNameKey(sessionId), GROUP_IDENTITY_PREFIX + sessionId]));
  });
}

const pendingReaps = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
function stopPendingReap(sessionId: string): void {
  const pending = pendingReaps.get(sessionId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingReaps.delete(sessionId);
}

// Reaps that exhausted their retries survive worker restarts in session storage
// and are tried again when a later session-closed frame arrives. That is safe
// only on a broker connection that announces sessions (session-open, on every
// accepted hello and for every live session when the extension connects):
// without the announcement a reconnected idle session would look exactly like
// an ended one, and a late retry would close its live group. Frames on one
// connection are ordered, so a retry started by a session-closed frame runs
// after that connection's announcements; a retry at worker start could run
// before them, which is why there is none. A retry is also bounded in time: the
// user may start using a leftover window, so an entry is retried for ten minutes
// from the moment its cleanup gave up and never later.
const REAP_RETRY_KEY = "reapRetry";
const MAX_FAILED_REAPS = 256;
const REAP_RETRY_MAX_AGE_MS = 10 * 60_000;
type FailedReap = { sessionId: string; failedAt: number };
type ReapRetry = { sessionOpenSeen: boolean; sessions: FailedReap[] };
function retryable(entry: unknown, now: number): entry is FailedReap {
  if (!entry || typeof entry !== "object") return false;
  const { sessionId, failedAt } = entry as Partial<FailedReap>;
  return typeof sessionId === "string" && sessionId.length > 0 && typeof failedAt === "number"
    && now - failedAt >= 0 && now - failedAt <= REAP_RETRY_MAX_AGE_MS;
}
let reapRetryWrites: Promise<unknown> = Promise.resolve();
function updateReapRetry(change: (state: ReapRetry) => boolean): Promise<ReapRetry> {
  const run = reapRetryWrites.then(async () => {
    const stored = (await chrome.storage.session.get(REAP_RETRY_KEY))[REAP_RETRY_KEY] as { sessionOpenSeen?: unknown; sessions?: unknown } | undefined;
    const entries: unknown[] = Array.isArray(stored?.sessions) ? stored.sessions : [];
    // Entries past the age limit, or in any other shape, are dropped with this update.
    const now = Date.now();
    const sessions = entries.filter((entry): entry is FailedReap => retryable(entry, now));
    const state: ReapRetry = { sessionOpenSeen: stored?.sessionOpenSeen === true, sessions };
    if (change(state) || sessions.length !== entries.length) await chrome.storage.session.set({ [REAP_RETRY_KEY]: state });
    return state;
  });
  // A rejected write fails its caller, but cannot poison the next update.
  reapRetryWrites = run.catch(() => {});
  return run;
}
function forget(state: ReapRetry, sessionId: string): boolean {
  const index = state.sessions.findIndex(entry => entry.sessionId === sessionId);
  if (index < 0) return false;
  state.sessions.splice(index, 1);
  return true;
}

/** The session is alive (it made a call): stop any reap of it, now and after a
 *  worker restart. */
export function cancelSessionReap(sessionId: string): void {
  stopPendingReap(sessionId);
  void updateReapRetry(state => forget(state, sessionId)).catch(() => console.warn("[tabs] could not forget a failed session cleanup"));
}

/** A new broker connection has announced nothing yet, and an older broker never
 *  will: persisted retries wait until this connection announces a session. */
export async function noteBrokerConnected(): Promise<void> {
  await updateReapRetry(state => {
    const changed = state.sessionOpenSeen;
    state.sessionOpenSeen = false;
    return changed;
  });
}

/** The broker accepted this session's hello. It is alive, and this connection is
 *  known to announce returning sessions, which makes persisted retries safe. */
export async function noteSessionOpen(sessionId: string): Promise<void> {
  stopPendingReap(sessionId);
  await updateReapRetry(state => {
    const changed = !state.sessionOpenSeen;
    state.sessionOpenSeen = true;
    return forget(state, sessionId) || changed;
  });
}

/** Retry reaps that exhausted their retries, if this broker connection announces
 *  sessions. Called for a session-closed frame only; see the note above. */
export async function retryFailedReaps(): Promise<void> {
  const state = await updateReapRetry(() => false);
  if (!state.sessionOpenSeen) return;
  for (const { sessionId, failedAt } of state.sessions) if (!pendingReaps.has(sessionId)) startSessionReap(sessionId, failedAt);
}

/** Bounded cleanup retries, cancelled when the authenticated session returns. */
export function scheduleSessionReap(sessionId: string): void {
  startSessionReap(sessionId);
}

/** `gaveUpAt`: when an earlier cleanup of this session gave up. A retry that
 *  gives up again keeps that time, so retries never extend the age limit. */
function startSessionReap(sessionId: string, gaveUpAt?: number): void {
  stopPendingReap(sessionId);
  const pending: { timer?: ReturnType<typeof setTimeout> } = {};
  pendingReaps.set(sessionId, pending);
  const attempt = async (remaining: number) => {
    if (pendingReaps.get(sessionId) !== pending) return;
    try {
      await reapSession(sessionId, () => pendingReaps.get(sessionId) === pending);
      if (pendingReaps.get(sessionId) !== pending) return;
      pendingReaps.delete(sessionId);
      void updateReapRetry(state => forget(state, sessionId)).catch(() => {});
    } catch {
      if (pendingReaps.get(sessionId) !== pending) return;
      if (remaining) { pending.timer = setTimeout(() => void attempt(remaining - 1), 1000); return; }
      pendingReaps.delete(sessionId);
      void updateReapRetry(state => {
        const entry: FailedReap = { sessionId, failedAt: gaveUpAt ?? Date.now() };
        if (!state.sessionOpenSeen || !retryable(entry, Date.now()) || state.sessions.some(other => other.sessionId === sessionId)) return false;
        state.sessions.push(entry);
        state.sessions.splice(0, Math.max(0, state.sessions.length - MAX_FAILED_REAPS));
        return true;
      }).catch(() => {}).then(() => console.warn("[tabs] Session cleanup failed; ownership retained for later cleanup"));
    }
  };
  void attempt(2);
}
