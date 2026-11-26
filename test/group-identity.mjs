// Chrome-free test for the per-session GROUP IDENTITY rule: a stored
// sessionId → groupId mapping is trusted only while the live group still carries
// that session's own title ("MCP·<sid4>"). Group ids are unique per browser
// session, so after a Chrome restart a stale id can name a stranger's group —
// the read path must drop it instead of handing the tabs to the session.
// Stubs the chrome.* surface the helpers touch; imports the REAL bundled module
// (dist/tab-group-helpers.mjs) so a regression is caught without Chrome.
import { watchdog } from "./watchdog.mjs";
import assert from "node:assert/strict";

const stopWatchdog = watchdog();
let store = {}; // chrome.storage.local backing
const groupsById = new Map(); // id -> { title }
const tabsById = new Map(); // id -> { groupId }
const removed = []; // chrome.tabs.remove calls
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let onGroupGet = null; // test hook: runs inside chrome.tabGroups.get (simulates a race or a held lock)
const createdWindows = [], createdTabs = [];
let nextTab = 2000, nextGroup = 200;
let browserIdentity = 'browser-one';
let identityWrites = 0, failIdentityWrites = false;
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: clone(store[key]) }),
      set: async (obj) => {
        const identity = Object.keys(obj).some(k => k.startsWith('mcpGroupIdentity:'));
        if (identity && failIdentityWrites) throw new Error('temporary identity write failure');
        if (identity) identityWrites++;
        for (const [k, v] of Object.entries(obj)) store[k] = clone(v);
      },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
    },
  },
  debugger: { getTargets: async () => [...tabsById.keys()].map(tabId => ({ tabId, id: `${browserIdentity}:${tabId}`, type: 'page' })) },
  tabGroups: {
    query: async () => [...groupsById.entries()].map(([id, group]) => ({ id, ...group })),
    update: async (id, values) => { groupsById.set(id, { ...groupsById.get(id), ...values }); },
    get: async (id) => {
      if (onGroupGet) await onGroupGet(id);
      const g = groupsById.get(id);
      if (!g) throw new Error(`No group with id: ${id}.`);
      return { id, ...g };
    },
  },
  tabs: {
    create: async options => {
      createdTabs.push(options);
      const tab = { id: ++nextTab, groupId: -1, ...options };
      tabsById.set(tab.id, tab); return tab;
    },
    group: async ({ tabIds, createProperties }) => {
      const groupId = ++nextGroup;
      for (const id of tabIds) {
        const tab = tabsById.get(id);
        assert.equal(tab.windowId, createProperties.windowId);
        tab.groupId = groupId;
      }
      groupsById.set(groupId, {}); return groupId;
    },
    get: async (id) => {
      const t = tabsById.get(id);
      if (!t) throw new Error(`No tab with id: ${id}.`);
      return { id, ...t };
    },
    query: async ({ groupId }) =>
      [...tabsById.entries()].filter(([, t]) => t.groupId === groupId).map(([id, t]) => ({ id, ...t })),
    remove: async (ids) => {
      removed.push(...(Array.isArray(ids) ? ids : [ids]));
      for (const id of Array.isArray(ids) ? ids : [ids]) tabsById.delete(id);
    },
  },
  windows: {
    get: async id => { if (![42, 43].includes(id)) throw new Error('No window'); return { id, type: 'normal', incognito: false }; },
    create: async options => {
      createdWindows.push(options);
      return { tabs: [await chrome.tabs.create({ windowId: 43, url: options.url, active: false })] };
    },
  },
};
const helpers = await import("../dist/tab-group-helpers.mjs");
const { getGroupId, assertTabInGroup, reapSession, groupTitle, refreshGroupAppearance, createMcpGroup, rememberSessionName, refreshGroupIdentity } = helpers;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const SID = "abcd0123456789ef"; // title "MCP·abcd"
const reset = (mapping) => {
  store = { mcpGroups: mapping };
  groupsById.clear();
  tabsById.clear();
  for (const groupId of Object.values(mapping)) tabsById.set(groupId * 100 + 1, { groupId });
  removed.length = 0;
  onGroupGet = null;
};
const mapped = () => store.mcpGroups?.[SID];

// (a) mapping + a live group with THIS session's title → the id is returned.
reset({ [SID]: 7 });
groupsById.set(7, { title: "MCP·abcd" });
check("own title → id returned", (await getGroupId(SID)) === 7);
check("own title → mapping kept", mapped() === 7);
await refreshGroupAppearance(SID);
check("verified legacy title migrates to a plain blue group with internal identity", groupsById.get(7).title === "Tabai" && groupsById.get(7).color === "blue");
check("new exact title retains ownership", (await getGroupId(SID)) === 7);
check("the visible project name contains no session code", groupTitle(SID, 'Hej och Hå') === 'Hej och Hå');

// (b) the group is gone (tabGroups.get throws) → null, mapping removed.
reset({ [SID]: 8 });
check("missing group → null", (await getGroupId(SID)) === null);
check("missing group → mapping removed", mapped() === undefined);

// (c) a stranger's (user) group recycled the id → null, mapping removed, and the
// chokepoint refuses a tab that lives in it.
reset({ [SID]: 9 });
groupsById.set(9, { title: "Banking" });
await refreshGroupAppearance(SID);
check("appearance migration leaves foreign group untouched", groupsById.get(9).title === "Banking" && groupsById.get(9).color === undefined);
tabsById.set(901, { groupId: 9 });
check("foreign title → null", (await getGroupId(SID)) === null);
check("foreign title → mapping removed", mapped() === undefined);
{
  let code = null;
  try {
    await assertTabInGroup(SID, 901);
  } catch (e) {
    code = e?.code;
  }
  check("assertTabInGroup refuses a tab in the recycled group (TAB_NOT_IN_GROUP)", code === "TAB_NOT_IN_GROUP", `code=${code}`);
}

// (d) ANOTHER session's MCP group recycled the id → null, mapping removed
// (a bare "MCP" prefix check would have accepted it).
reset({ [SID]: 10 });
groupsById.set(10, { title: "MCP·zzzz" });
check("another session's MCP title → null", (await getGroupId(SID)) === null);
check("another session's MCP title → mapping removed", mapped() === undefined);
reset({ [SID]: 10 });
groupsById.set(10, { title: groupTitle("abce") });
check("another readable session title is refused", (await getGroupId(SID)) === null);

// (e) compare-and-delete: a concurrent createMcpGroup replaced the mapping with a
// fresh id between the read and the drop → the fresh mapping is kept.
reset({ [SID]: 11 });
groupsById.set(11, { title: "Banking" });
onGroupGet = (id) => {
  if (id === 11) store.mcpGroups[SID] = 12; // the race: a new group was written meanwhile
};
check("stale id → null", (await getGroupId(SID)) === null);
check("compare-and-delete keeps a mapping that changed underneath", mapped() === 12);

// (f) reap closes ONLY a group carrying this session's title: a recycled id
// pointing at another session's group (or a user's) must not have its tabs closed.
reset({ [SID]: 13 });
groupsById.set(13, { title: "MCP·zzzz" });
tabsById.set(1301, { groupId: 13 });
await reapSession(SID);
check("reap skips a group with another session's title", removed.length === 0 && mapped() === undefined);
reset({ [SID]: 14 });
groupsById.set(14, { title: "MCP·abcd" });
tabsById.set(1401, { groupId: 14 });
await reapSession(SID);
check("reap closes the session's own group", removed.includes(1401) && mapped() === undefined);

reset({});
tabsById.set(1, { windowId: 42, groupId: -1 });
const [anchored, same] = await Promise.all([createMcpGroup(SID, 42), createMcpGroup(SID, 42)]);
check('panel task creates its owned group in the specified existing window', anchored.tab.windowId === 42 && createdWindows.length === 0);
check('concurrent anchored creates reuse one group and leave user tabs ungrouped', anchored.groupId === same.groupId && createdTabs.length === 1 && tabsById.get(1).groupId === -1);
await assert.rejects(assertTabInGroup(SID, 1), /not in your session/);
await reapSession(SID);
check('reaping an anchored group preserves the window and its user tabs', !removed.includes(1) && removed.includes(anchored.tab.id));
const windowsBefore = createdWindows.length, tabsBefore = createdTabs.length;
await assert.rejects(createMcpGroup(SID, 404), /window|fönster/i);
check('a closed target window does not fall back to a different window', createdWindows.length === windowsBefore && createdTabs.length === tabsBefore);
await createMcpGroup(SID);
check('ordinary sessions still create a background window', createdWindows.length === windowsBefore + 1 && createdWindows.at(-1).focused === false);

// Labels remain display metadata: persist them across worker reloads, compare
// the whole expected title, and keep same-project sessions separate.
reset({ [SID]: 7 });
groupsById.set(7, { title: "Tabai · Mova Nori" });
await rememberSessionName(SID, "Hej och Hå");
check('old syllable title is still owned after learning the project name', await getGroupId(SID) === 7);
await refreshGroupAppearance(SID);
check('old syllable title migrates to the project name', groupsById.get(7).title === 'Hej och Hå');
const reloaded = await import('../dist/tab-group-helpers.mjs?worker-restart');
check('worker restart reads the saved project name', await reloaded.getGroupId(SID) === 7);
await rememberSessionName(SID, 'Different project');
await refreshGroupAppearance(SID);
check('a later label cannot silently change the session identity', groupsById.get(7).title === 'Hej och Hå');
groupsById.set(7, { title: 'Another project' });
check('same identity suffix with a foreign project title is refused', await getGroupId(SID) === null);

reset({});
await Promise.all([rememberSessionName(SID, 'Hej och Hå'), rememberSessionName('abce0123456789ef', 'Hej och Hå')]);
const first = await createMcpGroup(SID), second = await createMcpGroup('abce0123456789ef');
check('same-project sessions have separate groups with the requested plain name', first.groupId !== second.groupId
  && groupsById.get(first.groupId).title === 'Hej och Hå'
  && groupsById.get(second.groupId).title === 'Hej och Hå');
await assert.rejects(assertTabInGroup(SID, second.tab.id), /not in your session/);
store.mcpGroups[SID] = second.groupId;
check('equal project names cannot authorize another session group', await getGroupId(SID) === null);
store.mcpGroups[SID] = first.groupId;
tabsById.set(9999, { groupId: first.groupId });
await refreshGroupIdentity(SID);
tabsById.delete(first.tab.id);
check('recorded additional tabs preserve ownership when the first tab closes', await getGroupId(SID) === first.groupId);
await reapSession(SID);
check('reaping a named session closes only its own tabs and removes its metadata', removed.includes(9999)
  && !removed.includes(second.tab.id) && store['mcpSessionName:' + SID] === undefined && store['mcpGroupIdentity:' + SID] === undefined);
check('another named session retains ownership after reap', await getGroupId('abce0123456789ef') === second.groupId);
browserIdentity = 'browser-two';
check('recycled group and tab IDs with new target UUIDs are refused', await getGroupId('abce0123456789ef') === null);
check('display labels preserve Swedish characters and normalize control characters', groupTitle(SID, '  Hej\n och\t Hå  ') === 'Hej och Hå');
check('long labels stay bounded', groupTitle(SID, 'å'.repeat(200)) === 'å'.repeat(64));
check('missing labels use the product fallback', groupTitle(SID, ' \n ') === 'Tabai');

reset({ [SID]: 7 });
await rememberSessionName(SID, 'Hej och Hå');
groupsById.set(7, { title: 'Hej och Hå' });
check('a plain title alone never establishes ownership', await getGroupId(SID) === null);

// A tab the page opens itself (target=_blank, window.open) joins the group
// without being recorded. One ownership check must record it, so closing the
// recorded tab afterwards does not cost the session its own group.
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const attempt = async run => { try { return { ok: true, value: await run() }; } catch (error) { return { ok: false, error }; } };
const within = (promise, ms = 500) => Promise.race([promise.then(value => ({ value }), error => ({ error })),
  new Promise(resolve => setTimeout(() => resolve("waited"), ms))]);
const identityKey = 'mcpGroupIdentity:' + SID;
reset({});
const own = await createMcpGroup(SID);
tabsById.set(7777, { groupId: own.groupId });
check('a group with an unrecorded page-opened tab is still owned', await getGroupId(SID) === own.groupId);
await settle();
check('one ownership check records the page-opened tab', Boolean(store[identityKey]?.targets?.['7777']));
tabsById.delete(own.tab.id);
check('the group stays owned after its recorded tab closes', await getGroupId(SID) === own.groupId);
{
  const remaining = await attempt(() => assertTabInGroup(SID, 7777));
  check('the remaining page-opened tab stays controllable', remaining.ok && remaining.value.id === 7777, remaining.error?.message);
}

// Checks that run after an action never wait for the group write lock and are
// never failed by the refresh; read-only lookups neither refresh nor wait.
reset({});
const mine = await createMcpGroup(SID);
const neighbour = await createMcpGroup('abce0123456789ef');
tabsById.set(7778, { groupId: mine.groupId });
let releaseLock, entered;
const lockHeld = new Promise(resolve => { releaseLock = resolve; });
const reaping = new Promise(resolve => { entered = resolve; });
onGroupGet = async id => { if (id === neighbour.groupId) { entered(); await lockHeld; } };
const heldReap = reapSession('abce0123456789ef'); // holds the lock inside its ownership inspection
await reaping;
{
  const asserted = await within(assertTabInGroup(SID, mine.tab.id));
  check('assertTabInGroup answers while the lock is held and the tab sets differ', asserted.value?.id === mine.tab.id, asserted === "waited" ? "waited for the lock" : asserted.error?.message);
  const looked = await within(attempt(() => helpers.lookupGroupId(SID)));
  check('the read-only group lookup answers while the lock is held', looked.value?.ok && looked.value.value === mine.groupId, looked === "waited" ? "waited for the lock" : looked.value?.error?.message);
  const dialogCheck = await within(attempt(() => helpers.isOwnedTab(SID, mine.tab.id)));
  check('the dialog ownership check answers while the lock is held', dialogCheck.value?.ok && dialogCheck.value.value === true, dialogCheck === "waited" ? "waited for the lock" : dialogCheck.value?.error?.message);
}
onGroupGet = null; releaseLock(); await heldReap; await settle();
check('the deferred refresh records the joined tab once the lock is free', Boolean(store[identityKey]?.targets?.['7778']));

reset({});
const readOnly = await createMcpGroup(SID);
tabsById.set(7779, { groupId: readOnly.groupId });
{
  const lookups = await attempt(async () => [await helpers.lookupGroupId(SID), await helpers.isOwnedTab(SID, readOnly.tab.id)]);
  await settle();
  check('read-only lookups confirm ownership', lookups.ok && lookups.value[0] === readOnly.groupId && lookups.value[1] === true, lookups.error?.message);
  check('read-only lookups never record tabs', lookups.ok && !store[identityKey]?.targets?.['7779']);
  failIdentityWrites = true;
  const failedRefresh = await attempt(() => assertTabInGroup(SID, readOnly.tab.id));
  await settle();
  failIdentityWrites = false;
  check('a refresh that fails does not fail the ownership check', failedRefresh.ok && failedRefresh.value.id === readOnly.tab.id, failedRefresh.error?.message);
  await getGroupId(SID); await settle();
  const writes = identityWrites;
  await getGroupId(SID); await assertTabInGroup(SID, readOnly.tab.id); await settle();
  check('equal recorded and live sets cause no identity write', identityWrites === writes);
}

console.log(`\n=== group-identity: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
