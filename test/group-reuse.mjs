import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

// Real retry timers and repeated worker imports run about 18 s.
const stopWatchdog = watchdog(() => rmSync(directory, { recursive: true, force: true }), 180_000);
// Transport-bound failures must never become evidence that an owned group disappeared.
const directory = mkdtempSync(join(tmpdir(), 'tabai-group-reuse-'));
const storage = {}, sessionStorage = {}, groups = new Map(), tabs = new Map();
let sequence = 0, windows = 0, failure;
function inspect(operation) { if (failure?.operation === operation && --failure.after === 0) throw new Error('temporary Chrome read failure'); }
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: 'test' }) },
  storage: {
    local: { async get(key) { inspect('storage.local.get'); return { [key]: structuredClone(storage[key]) }; }, async set(value) { inspect('storage.local.set'); Object.assign(storage, structuredClone(value)); }, async remove(keys) { for (const key of [keys].flat()) delete storage[key]; } },
    session: { async get(key) { return { [key]: structuredClone(sessionStorage[key]) }; }, async set(value) { Object.assign(sessionStorage, structuredClone(value)); } },
  },
  debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} }, async getTargets() { inspect('debugger.getTargets'); return [...tabs.values()].map(tab => ({ type: 'page', tabId: tab.id, id: `target-${tab.id}` })); } },
  tabGroups: {
    async get(id) { inspect('tabGroups.get'); if (!groups.has(id)) throw new Error('group no longer exists'); return { id, ...groups.get(id) }; },
    async query() { inspect('tabGroups.query'); return [...groups.entries()].map(([id, group]) => ({ id, ...group })); },
    async update(id, value) { inspect('tabGroups.update'); groups.set(id, { ...groups.get(id), ...value }); },
  },
  tabs: {
    onRemoved: { addListener() {} },
    async query({ groupId }) { inspect('tabs.query'); return [...tabs.values()].filter(tab => groupId === undefined || tab.groupId === groupId).map(tab => ({ ...tab })); },
    async get(id) { if (!tabs.has(id)) throw new Error('tab no longer exists'); return { ...tabs.get(id) }; },
    async create(options) { const tab = { ...options, id: ++sequence, groupId: -1 }; tabs.set(tab.id, tab); return { ...tab }; },
    async group({ tabIds, groupId, createProperties }) { const id = groupId ?? ++sequence; groups.set(id, groups.get(id) ?? {}); for (const tabId of tabIds) Object.assign(tabs.get(tabId), { groupId: id, ...(createProperties ? { windowId: createProperties.windowId } : {}) }); return id; },
    async remove(ids) { inspect('tabs.remove'); for (const id of [ids].flat()) tabs.delete(id); },
  },
  windows: { async create(options) { windows++; return { tabs: [await chrome.tabs.create({ ...options, windowId: 100 + windows })] }; } },
};
try {
  await build({ stdin: { contents: "export * from './extension/src/tab-group-helpers'; export { toolTabsContext, toolTabsCreate, toolTabsClose, toolNavigate } from './extension/src/tab-tools';", resolveDir: process.cwd() }, outfile: join(directory, 'group-reuse.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const bundle = pathToFileURL(join(directory, 'group-reuse.mjs')).href;
  const helpers = await import(bundle);
  const { createMcpGroup, getGroupId, reapSession, scheduleSessionReap, cancelSessionReap, toolTabsContext, toolTabsCreate, toolTabsClose, toolNavigate } = helpers;
  const session = 'abcd0123456789ef', args = { __sessionId: session, createIfEmpty: true };
  const original = await createMcpGroup(session);
  const failNext = (operation, after = 1) => { failure = { operation, after }; };
  for (const operation of ['storage.local.get', 'tabGroups.get', 'tabs.query', 'debugger.getTargets']) {
    for (const attempt of [() => toolTabsContext(args), () => toolTabsCreate(args), () => createMcpGroup(session)]) {
      failNext(operation);
      await assert.rejects(attempt(), /temporary Chrome|temporarily|Could not verify|unavailable/i);
      failure = undefined;
      assert.equal(storage.mcpGroups[session], original.groupId, `${operation} retains mapping`);
      assert.equal(windows, 1, `${operation} creates no replacement window`);
      assert.equal((await toolTabsContext(args)).groupId, original.groupId);
    }
  }
  // The context's list read follows two ownership inspections (each one list
  // query): the verification and the lock-free check that its tabs are recorded.
  failNext('tabs.query', 3);
  await assert.rejects(toolTabsContext(args), /temporarily|Could not verify|unavailable/i);
  failure = undefined;
  assert.equal(storage.mcpGroups[session], original.groupId);
  assert.equal((await toolTabsContext(args)).tabs[0].tabId, original.tab.id);
  assert.equal((await createMcpGroup(session)).tab.windowId, original.tab.windowId);
  assert.equal(windows, 1);
  // A real history mutation can complete before its final ownership guard fails.
  // The error must not invite a second back action.
  const updated = new Set();
  chrome.tabs.onUpdated = { addListener: listener => updated.add(listener), removeListener: listener => updated.delete(listener) };
  chrome.tabs.onRemoved.removeListener = () => {};
  chrome.debugger.attach = (_source, _version, done) => done();
  let dispatched = 0;
  tabs.get(original.tab.id).url = 'https://example.test/second';
  chrome.debugger.sendCommand = async (_source, method) => {
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 1, url: 'https://example.test/first' }, { id: 2, url: 'https://example.test/second' }] };
    assert.equal(method, 'Page.navigateToHistoryEntry'); dispatched++;
    const tab = tabs.get(original.tab.id); tab.url = 'https://example.test/first'; tab.status = 'complete';
    for (const listener of updated) listener(tab.id, { status: 'complete' }, { ...tab });
    failNext('debugger.getTargets'); return {};
  };
  await assert.rejects(toolNavigate({ ...args, tabId: original.tab.id, url: 'back', waitUntil: 'load' }), error => error.code === 'GROUP_IDENTITY_UNAVAILABLE' && error.retryable === false);
  failure = undefined;
  assert.equal(dispatched, 1); assert.equal(storage.mcpGroups[session], original.groupId);
  assert.equal(await getGroupId(session), original.groupId);
  // A second failed read cannot turn the first failure into a disappearance.
  const query = chrome.tabGroups.query;
  chrome.tabGroups.query = async () => { throw new Error('temporary inventory failure'); };
  failNext('tabGroups.get');
  await assert.rejects(getGroupId(session), /temporarily|Could not verify|unavailable/i);
  chrome.tabGroups.query = query; failure = undefined;
  assert.equal(storage.mcpGroups[session], original.groupId);
  groups.delete(original.groupId); tabs.delete(original.tab.id);
  assert.equal(await getGroupId(session), null, 'confirmed absence drops the stale mapping');
  await toolTabsContext(args);
  assert.equal(windows, 2, 'confirmed missing groups can legitimately recover');
  for (const [operation, after] of [['tabGroups.update', 1], ['storage.local.set', 1], ['storage.local.set', 2]]) {
    const before = [...tabs.keys()];
    failNext(operation, after);
    await assert.rejects(createMcpGroup('failed-creation'), /temporary Chrome/);
    failure = undefined;
    assert.deepEqual([...tabs.keys()], before, 'failed creation removes its own new blank tab');
    assert.equal(storage.mcpGroups['failed-creation'], undefined);
  }
  const remove = chrome.tabs.remove;
  for (const adopted of [false, true]) {
    const before = new Set(tabs.keys());
    chrome.tabs.remove = async () => { throw new Error('temporary close failure'); };
    failNext('tabGroups.update');
    await assert.rejects(createMcpGroup('rollback-retry'), /temporary Chrome/);
    failure = undefined; chrome.tabs.remove = remove;
    const orphan = [...tabs.values()].find(tab => !before.has(tab.id));
    assert(orphan, 'failed rollback retains a resource for cleanup');
    if (adopted) orphan.url = 'https://example.test/user-navigation';
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(tabs.has(orphan.id), adopted, 'cleanup retries close only an unchanged blank creation');
  }
  const returning = await createMcpGroup('returning-session');
  const targets = chrome.debugger.getTargets;
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  chrome.debugger.getTargets = async () => { entered(); await blocked; return targets(); };
  scheduleSessionReap('returning-session'); await reached;
  cancelSessionReap('returning-session'); release();
  chrome.debugger.getTargets = targets;
  assert.equal((await createMcpGroup('returning-session')).groupId, returning.groupId);
  assert(tabs.has(returning.tab.id), 'a returning session cancels cleanup during ownership inspection');
  assert(storage['mcpGroupIdentity:returning-session'], 'cancelled cleanup preserves identity');
  const retained = await createMcpGroup('reap-retry');
  const identity = structuredClone(storage['mcpGroupIdentity:reap-retry']);
  failNext('tabs.remove');
  await assert.rejects(reapSession('reap-retry'), /temporary Chrome/);
  failure = undefined;
  assert.equal(storage.mcpGroups['reap-retry'], retained.groupId);
  assert.deepEqual(storage['mcpGroupIdentity:reap-retry'], identity);
  assert(tabs.has(retained.tab.id));
  await reapSession('reap-retry');
  assert(!tabs.has(retained.tab.id));
  assert.equal(storage.mcpGroups['reap-retry'], undefined);
  assert.equal(storage['mcpGroupIdentity:reap-retry'], undefined);

  // A tab the page opened itself joins the group unrecorded. The two calls that
  // can precede losing the recorded tabs record it before they answer or close.
  const pageOpened = async owner => {
    const tab = await chrome.tabs.create({ windowId: owner.tab.windowId, url: 'https://example.test/opened' });
    tabs.get(tab.id).groupId = owner.groupId;
    return tab.id;
  };
  const listed = await createMcpGroup('context-session');
  const listedOpened = await pageOpened(listed);
  await toolTabsContext({ __sessionId: 'context-session' });
  assert(storage['mcpGroupIdentity:context-session'].targets[listedOpened], 'tabs_context_mcp records a page-opened tab before it answers');
  const closing = await createMcpGroup('closing-session');
  const closingOpened = await pageOpened(closing);
  await toolTabsClose({ __sessionId: 'closing-session', tabId: closing.tab.id });
  assert(!tabs.has(closing.tab.id));
  assert.deepEqual((await toolTabsContext({ __sessionId: 'closing-session' })).tabs.map(tab => tab.tabId), [closingOpened],
    'closing the recorded tab leaves the page-opened tab under the session');
  const refused = await createMcpGroup('refused-close');
  await pageOpened(refused);
  const localSet = chrome.storage.local.set;
  chrome.storage.local.set = async value => {
    if (Object.keys(value).some(key => key.startsWith('mcpGroupIdentity:'))) throw new Error('temporary Chrome write failure');
    return localSet(value);
  };
  try {
    await assert.rejects(toolTabsClose({ __sessionId: 'refused-close', tabId: refused.tab.id }),
      error => error.code === 'GROUP_IDENTITY_UNAVAILABLE' && /nothing was closed/i.test(error.message));
  } finally { chrome.storage.local.set = localSet; }
  assert(tabs.has(refused.tab.id), 'a close whose identity refresh failed closes nothing');
  // Listing needs no new proof: a failed identity write still gets an answer.
  const listing = await createMcpGroup('listing-write-failure');
  const listingOpened = await pageOpened(listing);
  chrome.storage.local.set = async value => {
    if (Object.keys(value).some(key => key.startsWith('mcpGroupIdentity:'))) throw new Error('temporary Chrome write failure');
    return localSet(value);
  };
  try {
    const answer = await toolTabsContext({ __sessionId: 'listing-write-failure' });
    assert.equal(answer.groupId, listing.groupId);
    assert.deepEqual(answer.tabs.map(tab => tab.tabId).sort((a, b) => a - b), [listing.tab.id, listingOpened].sort((a, b) => a - b),
      'tabs_context_mcp answers when recording the page-opened tab fails');
  } finally { chrome.storage.local.set = localSet; }

  // A reap that exhausted its retries is tried again later, but only once the
  // broker is known to announce returning sessions: otherwise a reconnected idle
  // session could be reaped by a late retry.
  const warn = console.warn;
  let exhausted = 0;
  console.warn = message => { if (/Session cleanup failed/.test(String(message))) exhausted++; else warn(message); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition, message) => {
    for (let i = 0; i < 100 && !condition(); i++) await sleep(50);
    assert(condition(), message);
  };
  const exhaust = async (module, session) => {
    const before = exhausted;
    chrome.tabs.remove = async () => { throw new Error('temporary close failure'); };
    try { module.scheduleSessionReap(session); await until(() => exhausted > before, 'the reap exhausts its retries'); }
    finally { chrome.tabs.remove = remove; }
  };
  let worker = helpers;
  // A fresh worker keeps only what session storage holds. The retry itself is what a
  // session-closed frame starts; a worker start starts none.
  const restart = async tag => { worker = await import(`${bundle}?worker-${tag}`); await sleep(50); };
  const sessionClosed = async () => { await worker.retryFailedReaps(); await sleep(100); };
  try {
    const unannounced = await createMcpGroup('unannounced-session');
    await exhaust(worker, 'unannounced-session');
    await restart('without-open'); await sessionClosed();
    assert(tabs.has(unannounced.tab.id), 'without a session-open frame no persisted retry runs');
    sessionStorage.reapRetry = { sessionOpenSeen: false, sessions: [{ sessionId: 'unannounced-session', failedAt: Date.now() }] };
    await restart('seeded-without-open'); await sessionClosed();
    assert(tabs.has(unannounced.tab.id), 'a persisted retry stays unused until a session-open frame was seen');
    delete sessionStorage.reapRetry;

    await worker.noteSessionOpen('another-session');
    const lost = await createMcpGroup('lost-session');
    await exhaust(worker, 'lost-session');
    assert(tabs.has(lost.tab.id));
    await restart('after-open');
    assert(tabs.has(lost.tab.id), 'a worker restart alone retries nothing');
    await sessionClosed();
    await until(() => !tabs.has(lost.tab.id), 'a reap that failed three times succeeds at the next session-closed frame, also after a worker restart');
    assert.equal(storage.mcpGroups['lost-session'], undefined);
    assert.deepEqual(sessionStorage.reapRetry.sessions, [], 'a completed retry is forgotten');

    const returning = await createMcpGroup('returning-later');
    await exhaust(worker, 'returning-later');
    await worker.noteSessionOpen('returning-later');
    await restart('returned'); await sessionClosed();
    assert(tabs.has(returning.tab.id), 'a session-open frame for that session cancels its persisted retry');
    const calling = await createMcpGroup('calling-later');
    await exhaust(worker, 'calling-later');
    worker.cancelSessionReap('calling-later'); await sleep(50);
    await restart('called'); await sessionClosed();
    assert(tabs.has(calling.tab.id), 'a tool call from that session cancels its persisted retry');

    // A new broker connection has announced nothing yet, and an older broker never will.
    const reconnected = await createMcpGroup('reconnected-broker');
    await exhaust(worker, 'reconnected-broker');
    await worker.noteBrokerConnected();
    await sessionClosed();
    assert(tabs.has(reconnected.tab.id), 'a new broker connection that announced nothing retries no cleanup');
    assert.deepEqual(sessionStorage.reapRetry.sessions.map(entry => entry.sessionId), ['reconnected-broker'], 'the cleanup stays recorded for a connection that announces sessions');
    await worker.noteSessionOpen('someone-else');
    await sessionClosed();
    await until(() => !tabs.has(reconnected.tab.id), 'once the connection announces a session, the next session-closed frame retries the cleanup');

    // A cleanup that gave up is retried for ten minutes from that moment, never
    // later: by then the user may have started using the leftover window.
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const expired = await createMcpGroup('expired-failure');
      await exhaust(worker, 'expired-failure');
      clock += 60_000;
      const young = await createMcpGroup('young-failure');
      await exhaust(worker, 'young-failure');
      clock += 9 * 60_000 + 1; // the first gave up 10 min + 1 ms ago, the second 9 min + 1 ms ago
      sessionStorage.reapRetry.sessions.push('earlier-shape', { sessionId: 'without-time' });
      await sessionClosed();
      await until(() => !tabs.has(young.tab.id), 'a cleanup that gave up less than ten minutes ago is retried');
      await sleep(200);
      assert(tabs.has(expired.tab.id), 'a cleanup that gave up more than ten minutes ago is not retried');
      assert.equal(storage.mcpGroups['expired-failure'], expired.groupId, 'the expired cleanup keeps its mapping');
      assert(!JSON.stringify(sessionStorage.reapRetry.sessions).includes('expired-failure'), 'the expired entry is dropped from the retry state');
      assert.deepEqual(sessionStorage.reapRetry.sessions, [], 'entries in another shape are dropped, the retried one is forgotten');
    } finally { Date.now = realNow; }
  } finally { console.warn = warn; }
  console.log('Group reuse: transient storage/group/list/target errors retain ownership, block duplicate windows and recover the original; confirmed absence can recreate; page-opened tabs are recorded before a context answer or a close, and a failed recording still gets a context answer; exhausted reaps retry only at a session-closed frame on a connection that announced a session, and for ten minutes at most');
} finally { rmSync(directory, { recursive: true, force: true }); stopWatchdog(); }
