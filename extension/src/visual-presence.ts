import { allGroups, assertTabInGroup, getGroupId, refreshGroupAppearance, refreshGroupIdentitySoon, tabsInGroup } from "./tab-group-helpers";
import { renderPresence } from "./presence-script";
import { executeScript, traceOperation } from "./diagnostics";

// The page only ever sees keyed hashes: one of its origin, which recognises an
// older Tabai surface there, and one of origin plus session as the owner. The
// key stays in extension storage, so neither the session ID nor the extension
// ID reaches the page, and two origins never see the same value.
const MARKER_KEY = "presenceMarkerKey";
let markerKey: Promise<CryptoKey> | undefined;
async function storeNewMarkerKey(): Promise<Uint8Array<ArrayBuffer>> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  // Persist before first use: a surface painted under an unsaved key could
  // not be recognised (and removed) after a worker restart.
  await chrome.storage.local.set({ [MARKER_KEY]: btoa(String.fromCharCode(...raw)) });
  return raw;
}
function useMarkerKey(raw: () => Promise<Uint8Array<ArrayBuffer>>): Promise<CryptoKey> {
  const key = (async () => crypto.subtle.importKey("raw", await raw(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]))();
  markerKey = key;
  key.catch(() => { if (markerKey === key) markerKey = undefined; });
  return key;
}
function loadMarkerKey(): Promise<CryptoKey> {
  return markerKey ?? useMarkerKey(async () => {
    const stored = (await chrome.storage.local.get(MARKER_KEY))[MARKER_KEY];
    const raw = typeof stored === "string" ? Uint8Array.from(atob(stored), char => char.charCodeAt(0)) : undefined;
    return raw?.length === 32 ? raw : storeNewMarkerKey();
  });
}
// The key is fixed between browser starts, so repaints reuse their tokens.
const markerTokens = new Map<string, Promise<string>>();
function markerToken(...parts: string[]): Promise<string> {
  const input = JSON.stringify(parts);
  let token = markerTokens.get(input);
  if (token) return token;
  if (markerTokens.size >= 512) markerTokens.clear();
  token = (async () => {
    const signature = await crypto.subtle.sign("HMAC", await loadMarkerKey(), new TextEncoder().encode(input));
    return [...new Uint8Array(signature, 0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  })();
  markerTokens.set(input, token);
  token.catch(() => { if (markerTokens.get(input) === token) markerTokens.delete(input); });
  return token;
}
/** A key kept forever would make the origin token a fixed identifier of this
 *  install on every site. No surface survives a browser start (pages load
 *  afresh, and a group from before it has no live recorded page target, so it
 *  is not painted), so each browser start gets a new key and nothing painted
 *  under the old one is stranded. A failed rotation keeps the stored key. */
function rotateMarkerKey(): void {
  markerTokens.clear();
  useMarkerKey(storeNewMarkerKey).catch(() => console.warn("[presence] could not rotate the marker key"));
}
function originOf(url: string | undefined): string {
  try { return new URL(url ?? "").origin; } catch { return "null"; }
}

/** A tab created inside a mapped group (a page's target=_blank or window.open)
 *  must join that session's recorded identity, or closing the recorded tabs
 *  would cost the session its group. Its page target may not exist yet when it
 *  is created, so its first completed load tries once more. */
const joining = new Set<number>();
async function recordGroupMember(groupId: number | undefined): Promise<void> {
  if (groupId === undefined || groupId < 0) return;
  for (const [sessionId, id] of Object.entries(await allGroups())) if (id === groupId) refreshGroupIdentitySoon(sessionId);
}

type RenderQueue = { running?: Promise<void>; queued?: Promise<void>; hidden: number };
type Presence = {
  sessionId: string; tabId: number; working: number; waiting: number;
  queue: RenderQueue; retired: boolean;
};
const surfaces = new Map<number, Presence>();
const syncing = new Map<string, Promise<void>>();
let reconciliation: Promise<void> | undefined;
let enabled = true;
let ready: Promise<void> = Promise.resolve();
let logo: Promise<string> | undefined;
const COSMETIC_WAIT_MS = 250;
const HIDE_WAIT_MS = 1000;
const deadlines = new WeakMap<Promise<unknown>, Map<number, Promise<void>>>();
const ignored = new WeakMap<Promise<unknown>, Promise<void>>();

/** Bound the caller's wait, never discard or replay an unresolved Chrome call.
 *  In particular, captures still have to pass the original rendering queue. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let waits = deadlines.get(promise);
  if (!waits) { waits = new Map(); deadlines.set(promise, waits); }
  const existing = waits.get(ms);
  if (existing) return existing;
  const wait = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Visual presence did not settle; capture refused if hiding was required.")), ms);
      })]);
    } finally { clearTimeout(timer); }
  })();
  // Repeated events/calls share the same expired wait rather than retaining a
  // fresh promise reaction on a Chrome operation that may never settle.
  waits.set(ms, wait);
  void promise.then(() => deadlines.delete(promise), () => deadlines.delete(promise));
  return wait;
}

function loadLogo(): Promise<string> {
  return logo ??= fetch(chrome.runtime.getURL("icons/tabai-48.png"))
    .then(response => response.arrayBuffer())
    .then(buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))))
    .catch(() => { logo = undefined; return ""; });
}

function surfaceFor(sessionId: string, tabId: number): Presence {
  const current = surfaces.get(tabId);
  if (current?.sessionId === sessionId && !current.retired) return current;
  const state: Presence = { sessionId, tabId, working: 0, waiting: 0,
    queue: current?.queue ?? { hidden: 0 }, retired: false };
  surfaces.set(tabId, state);
  return state;
}

/** At most one running and one queued rendering per tab. Coalesce event storms
 *  while keeping the original barrier: a late paint must finish BEFORE a hide
 *  can authorize capture. Suppression survives changes of surface owner. */
function paint(state: Presence): Promise<void> {
  const queue = state.queue;
  if (queue.queued) return queue.queued;
  const run = (queue.running ?? Promise.resolve()).catch(() => {}).then(async () => {
    queue.queued = undefined;
    queue.running = run;
    try { await paintNow(surfaces.get(state.tabId) ?? state); }
    finally { if (queue.running === run) queue.running = undefined; }
  });
  queue.queued = run;
  return run;
}

async function paintNow(state: Presence): Promise<void> {
  let owned = !state.retired && surfaces.get(state.tabId) === state;
  let tab: chrome.tabs.Tab | undefined;
  if (owned) {
    try { tab = await traceOperation(state.sessionId, "ownership.check", () => assertTabInGroup(state.sessionId, state.tabId), { tabId: state.tabId }); }
    catch {
      owned = false;
      // Retain the queue until the tab closes. A later successful ownership
      // check must not bypass an unresolved removal/paint from this surface.
    }
  }
  owned = owned && !state.retired && surfaces.get(state.tabId) === state;
  const mode = !owned || !enabled ? "remove" : state.queue.hidden ? "hidden"
    : state.working ? "working" : state.waiting ? "waiting" : "idle";
  if (owned && !/^https?:/.test(tab?.url ?? "")) return;
  // Removal touches only our isolated-world host with the matching owner,
  // even if the user has since moved the tab out of the group.
  const image = mode === "remove" || mode === "hidden" ? "" : await traceOperation(state.sessionId,
    "presence.logo", loadLogo, { tabId: state.tabId, budgetMs: COSMETIC_WAIT_MS });
  const origin = originOf((tab ?? await chrome.tabs.get(state.tabId).catch(() => undefined))?.url);
  const [owner, originMarker] = await Promise.all([markerToken("owner", origin, state.sessionId), markerToken("origin", origin)]);
  const result = await traceOperation(state.sessionId, "presence.render", () => executeScript({
    // Default injection waits for document_idle and would hold up tools that
    // deliberately evaluate a still-loading page (including wait_for).
    target: { tabId: state.tabId }, injectImmediately: true, func: renderPresence,
    args: [owner, mode, image, originMarker],
  }), { tabId: state.tabId, budgetMs: COSMETIC_WAIT_MS });
  if ((mode === "hidden" || mode === "remove") && result[0]?.result !== false) {
    throw new Error("Visual presence hiding was not confirmed; capture refused.");
  }
}

function quietly(promise: Promise<unknown>): Promise<void> {
  let quiet = ignored.get(promise);
  if (!quiet) { quiet = promise.then(() => {}, () => {}); ignored.set(promise, quiet); }
  return quiet;
}

function syncSession(sessionId: string): Promise<void> {
  const current = syncing.get(sessionId);
  if (current) return current;
  const run = (async () => {
    try {
      const id = await getGroupId(sessionId);
      if (id == null) return;
      await Promise.all([
        quietly(traceOperation(sessionId, "group.appearance", () => refreshGroupAppearance(sessionId), { budgetMs: COSMETIC_WAIT_MS })),
        (async () => {
          await Promise.all((await tabsInGroup(id)).flatMap(tab =>
            tab.id == null ? [] : [quietly(paint(surfaceFor(sessionId, tab.id)))]));
        })(),
      ]);
    } finally { syncing.delete(sessionId); }
  })();
  syncing.set(sessionId, run);
  return run;
}

function reconcile(): Promise<void> {
  return reconciliation ??= (async () => {
    try {
      for (const sessionId of Object.keys(await allGroups())) void quietly(syncSession(sessionId));
      for (const state of surfaces.values()) void quietly(paint(state));
    } finally { reconciliation = undefined; }
  })();
}

/** Installed by the worker, not CDP imports used by standalone Node tests.
 *  `onOwnershipChange` runs when a tab changes group or a group mapping changes. */
export function initializePresence(onOwnershipChange?: () => void): void {
  // Registered synchronously, in the worker's first turn: Chrome dispatches the
  // event that started the worker only to listeners added then.
  chrome.runtime.onStartup.addListener(rotateMarkerKey);
  ready = chrome.storage.local.get("showVisualPresence").then(values => {
    enabled = values.showVisualPresence !== false;
    void quietly(reconcile());
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.showVisualPresence) {
      enabled = changes.showVisualPresence.newValue !== false;
      void quietly(reconcile());
    }
    if (changes.mcpGroups) { onOwnershipChange?.(); void quietly(reconcile()); }
  });
  chrome.tabs.onCreated.addListener(tab => {
    if (tab.id === undefined || tab.groupId === undefined || tab.groupId < 0) return;
    joining.add(tab.id);
    void quietly(recordGroupMember(tab.groupId));
  });
  chrome.tabs.onUpdated.addListener((tabId, changes) => {
    if (changes.status !== "complete" && changes.groupId === undefined) return;
    if (changes.groupId !== undefined) {
      onOwnershipChange?.();
      void quietly(recordGroupMember(changes.groupId));
    }
    if (changes.status === "complete" && joining.delete(tabId)) {
      void quietly(chrome.tabs.get(tabId).then(tab => recordGroupMember(tab.groupId)));
    }
    const state = surfaces.get(tabId);
    if (state) void quietly(paint(state));
    else if (changes.groupId !== undefined) void quietly(reconcile());
  });
  chrome.tabGroups.onUpdated.addListener(() => {
    // Validate existing surfaces after a user renames a group. Do not rename
    // arbitrary user titles back to ours or let their old badge linger.
    for (const state of surfaces.values()) void quietly(paint(state));
  });
  chrome.tabs.onRemoved.addListener(tabId => { surfaces.delete(tabId); joining.delete(tabId); });
}

export function reapPresence(sessionId: string): void {
  for (const state of surfaces.values()) {
    if (state.sessionId !== sessionId) continue;
    state.retired = true;
    void quietly(paint(state));
  }
}

/** Cosmetics never retry or change the result of a tool action. */
export async function withPresence<T>(
  sessionId: unknown, tool: string, args: Record<string, unknown>, run: () => Promise<T>,
): Promise<T> {
  await quietly(within(ready, COSMETIC_WAIT_MS));
  let state: Presence | undefined;
  let finished = false;
  const waiting = tool === "wait_for" || (tool === "computer" && args.action === "wait")
    || (tool === "download" && args.action === "collect");
  const counter = waiting ? "waiting" : "working";
  if (typeof sessionId === "string" && sessionId && typeof args.tabId === "number") {
    const tabId = args.tabId;
    await quietly(within((async () => {
      await assertTabInGroup(sessionId, tabId);
      if (finished) return;
      state = surfaceFor(sessionId, tabId);
      state[counter]++;
    })(), COSMETIC_WAIT_MS)); // The real handler owns validation and its errors.
    if (state) await quietly(within(paint(state), COSMETIC_WAIT_MS));
  }
  try { return await run(); }
  finally {
    finished = true;
    const cosmetics: Promise<unknown>[] = [];
    if (state) { state[counter]--; cosmetics.push(paint(state)); }
    if (typeof sessionId === "string" && sessionId &&
      ["tabs_context_mcp", "tabs_create_mcp", "tab_duplicate"].includes(tool)) {
      cosmetics.push(syncSession(sessionId));
    }
    await Promise.all(cosmetics.map(promise => quietly(within(promise, COSMETIC_WAIT_MS))));
  }
}

/** Reference counting covers overlapping captures and work finishing mid-shot.
 *  If hiding cannot be confirmed (including a late first paint), refuse capture. Restore
 *  failures never mask a completed screenshot or print operation. */
export async function withoutPresence<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
  const state = surfaces.get(tabId);
  // Startup/preparation may have timed out before registering a surface. An
  // older worker's host can still exist in the page, so absence is not proof.
  if (!state) throw new Error("Visual presence ownership is not ready; capture refused.");
  state.queue.hidden++;
  try {
    await traceOperation(state.sessionId, "capture.hide", () => within(paint(state), HIDE_WAIT_MS), { tabId, budgetMs: HIDE_WAIT_MS });
    return await capture();
  } finally {
    state.queue.hidden--;
    await quietly(within(paint(state), COSMETIC_WAIT_MS));
  }
}
