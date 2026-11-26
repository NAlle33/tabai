import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog();
const eventHandlers = new Map(), timers = new Map();
const owns = new Map([[1, 'first'], [2, 'first']]);
const replies = [];
let capture, ownership, onRelease;
// The worker's in-memory attachment set, and the attachments Chrome actually
// holds for this extension (they survive a worker restart; the set does not).
let attachedTabs = new Set(), chromeAttachments = new Set();
let targets = [];
const released = [], attempted = [];
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
globalThis.setInterval = callback => { const id = {}; timers.set(id, callback); return id; };
globalThis.clearInterval = id => timers.delete(id);
globalThis.chrome = {
  runtime: {}, tabs: { onRemoved: { addListener() {} }, async get(id) { return { id, groupId: owns.get(id) === 'first' ? 7 : 8 }; } },
  debugger: { onDetach: { addListener() {} }, sendCommand(_target, method, params, callback) { assert.equal(method, 'Page.handleJavaScriptDialog'); replies.push(params); callback(); },
    async getTargets() { return targets; } },
};
const notAttached = tabId => new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
globalThis.captureFixture = {
  onCdpEvent: (event, callback) => eventHandlers.set(event, callback),
  cdpSend: async (tabId, method) => method === 'Page.captureScreenshot' ? capture(tabId) : {},
  sessionOf: args => args.__sessionId,
  assertTabInGroup: async (sessionId, tabId) => {
    await ownership?.();
    if (owns.get(tabId) !== sessionId) throw new Error('TAB_NOT_IN_GROUP');
    return chrome.tabs.get(tabId);
  },
  isOwnedTab: async (sessionId, tabId) => {
    await ownership?.();
    return owns.get(tabId) === sessionId;
  },
  isTabInMappedGroup: async tabId => owns.has(tabId),
  attachedTabIds: () => [...attachedTabs],
  // Release primitives never attach: Chrome refuses a command or a detach
  // without this extension's own attachment.
  sendIfAttached: async (tabId, method) => {
    attempted.push({ tabId, method });
    if (!chromeAttachments.has(tabId)) throw notAttached(tabId);
    released.push({ tabId, method }); onRelease?.(tabId, method);
  },
  detachTab: async tabId => {
    attachedTabs.delete(tabId);
    attempted.push({ tabId, method: 'detach' });
    if (!chromeAttachments.delete(tabId)) throw notAttached(tabId);
    released.push({ tabId, method: 'detach' });
  },
};
const compiled = await build({ stdin: { contents: "export * from './extension/src/dialog-controller'; export * from './extension/src/gif-recorder';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'chrome-boundary', setup(builder) {
  builder.onResolve({ filter: /^\.\/(cdp|tab-group-helpers)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const {onCdpEvent,cdpSend,attachedTabIds,sendIfAttached,detachTab,sessionOf,assertTabInGroup,isOwnedTab,isTabInMappedGroup}=globalThis.captureFixture;' }));
} }] });
const capturedModule = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const { toolDialog, reapDialogState, toolGifCreator, reapGifState } = capturedModule;
const tick = () => new Promise(resolve => setImmediate(resolve));
const dialog = () => eventHandlers.get('Page.javascriptDialogOpening')(1, { type: 'confirm', message: 'private', url: 'https://example.test' });
const args = { tabId: 1, __sessionId: 'first' };
try {
  await toolDialog({ ...args, action: 'arm', behavior: 'accept' });
  dialog(); await tick(); assert.equal(replies.at(-1).accept, true);
  owns.set(1, 'second'); dialog(); await tick();
  assert.equal(replies.at(-1).accept, false, 'leaving ownership revokes accept');
  assert.equal((await toolDialog({ ...args, __sessionId: 'second', action: 'get' })).count, 0, 'a new owner never sees another session\'s dialog text');
  owns.set(1, 'first'); await toolDialog({ ...args, action: 'arm', behavior: 'accept' });
  let release;
  ownership = () => new Promise(resolve => { release = resolve; });
  dialog(); await tick();
  reapDialogState('first'); ownership = undefined; release(); await tick();
  assert.equal(replies.at(-1).accept, false, 'session cleanup revokes an in-flight ownership check');
  await toolDialog({ ...args, action: 'arm', behavior: 'accept' });
  ownership = () => new Promise(resolve => { release = resolve; });
  dialog(); await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(replies.at(-1).accept, false, 'an unavailable ownership probe dismisses within a bounded deadline');
  const count = replies.length; ownership = undefined; release(); await tick(); assert.equal(replies.length, count, 'late proof never dispatches again');

  let captures = 0, releaseFrame;
  capture = async () => { captures++; return captures === 2 ? new Promise(resolve => { releaseFrame = resolve; }) : { data: 'new-frame' }; };
  await toolGifCreator({ ...args, action: 'start_recording' });
  [...timers.values()][0](); await tick();
  await toolGifCreator({ ...args, tabId: 2, action: 'start_recording' });
  releaseFrame({ data: 'old-tab-frame' }); await tick();
  assert.equal((await toolGifCreator({ ...args, tabId: 2, action: 'stop_recording' })).frames, 2, 'late frames do not contaminate a replacement recording');
  assert.equal(timers.size, 0);
  // Concurrent starts must not install an orphan timer after the old initial frame returns.
  capture = async tabId => tabId === 1 ? new Promise(resolve => { releaseFrame = resolve; }) : { data: 'new-frame' };
  const old = toolGifCreator({ ...args, action: 'start_recording' }); await tick();
  await toolGifCreator({ ...args, tabId: 2, action: 'start_recording' });
  releaseFrame({ data: 'old-frame' }); await old;
  assert.equal(timers.size, 1);
  reapGifState('first'); assert.equal(timers.size, 0);
  captures = 0; capture = async () => { captures++; return { data: 'owned-frame' }; };
  await toolGifCreator({ ...args, action: 'start_recording' });
  ownership = async () => { throw new Error('identity unavailable'); };
  [...timers.values()][0](); await tick();
  assert.equal(captures, 1, 'unavailable ownership cannot dispatch another screenshot');
  ownership = undefined; reapGifState('first');

  // A tab that left every mapped group is the user's again: its dialogs are no
  // longer answered, emulation is cleared and the debugger detaches. A tab that
  // moved into another session's group keeps the shared attachment.
  owns.set(1, 'first'); owns.set(2, 'first');
  await toolDialog({ ...args, action: 'arm', behavior: 'accept' });
  owns.delete(1); owns.set(2, 'second');
  attachedTabs = new Set([1, 2]); chromeAttachments = new Set([1, 2]);
  await capturedModule.releaseUnownedTabs();
  assert.deepEqual(released.filter(entry => entry.tabId === 1).map(entry => entry.method),
    ['Page.disable', 'Emulation.clearDeviceMetricsOverride', 'detach']);
  assert.deepEqual(released.filter(entry => entry.tabId === 2), [], 'another session\'s tab keeps its attachment');
  owns.set(1, 'first'); dialog(); await tick();
  assert.equal(replies.at(-1).accept, false, 'a released tab\'s accept arm does not survive its return');
  // Ownership is checked again right before each release step.
  released.length = 0; attachedTabs = new Set([3]); chromeAttachments = new Set([3]);
  onRelease = (tabId, method) => { if (tabId === 3 && method === 'Page.disable') owns.set(3, 'second'); };
  await capturedModule.releaseUnownedTabs();
  assert.deepEqual(released.map(entry => entry.method), ['Page.disable'], 'a tab claimed mid-release keeps its attachment');
  onRelease = undefined;

  // The extension's attachment survives a worker restart, the in-memory set does
  // not: a tab Chrome reports as attached gets the same release steps and
  // re-checks. DevTools or another extension may hold that attachment instead;
  // its "not attached" refusals are ignored.
  released.length = 0; attempted.length = 0;
  attachedTabs = new Set(); chromeAttachments = new Set([4, 5]);
  owns.delete(4); owns.set(5, 'second'); owns.delete(6); owns.delete(9);
  targets = [
    { type: 'page', tabId: 4, attached: true, id: 'target-4' },
    { type: 'page', tabId: 5, attached: true, id: 'target-5' },
    { type: 'page', tabId: 6, attached: true, id: 'target-6' },
    { type: 'page', tabId: 9, attached: false, id: 'target-9' },
    { type: 'service_worker', attached: true, id: 'target-worker' },
  ];
  await capturedModule.releaseUnownedTabs();
  const steps = tabId => attempted.filter(entry => entry.tabId === tabId).map(entry => entry.method);
  const releaseSteps = ['Page.disable', 'Emulation.clearDeviceMetricsOverride', 'detach'];
  assert.deepEqual(released.filter(entry => entry.tabId === 4).map(entry => entry.method), releaseSteps,
    'an attachment from before a worker restart is released when its tab is in no mapped group');
  assert.deepEqual(steps(5), [], 'an attached tab in a mapped group gets no release step');
  assert.deepEqual(steps(6), releaseSteps, 'a foreign attachment gets every step; its refusals are ignored');
  assert.deepEqual(steps(9), [], 'a target that is not attached gets nothing');
  // An unreadable target list leaves the in-memory set.
  attempted.length = 0; attachedTabs = new Set([7]); chromeAttachments = new Set([7]);
  chrome.debugger.getTargets = async () => { throw new Error('targets unavailable'); };
  await capturedModule.releaseUnownedTabs();
  assert.deepEqual(steps(7), releaseSteps, 'a failed target read still releases the known attachments');
  targets = [];
  chrome.debugger.getTargets = async () => targets;
} finally {
  reapGifState('first'); reapDialogState('first');
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
  delete globalThis.captureFixture; delete globalThis.chrome;
}

// The real release primitives reach an attachment this worker never made and
// never attach: Chrome itself refuses a tab without this extension's attachment.
{
  const calls = [];
  const refuse = tabId => { if (tabId !== 4) throw notAttached(tabId); };
  globalThis.chrome = {
    runtime: {}, tabs: { onRemoved: { addListener() {} } },
    debugger: {
      onDetach: { addListener() {} }, onEvent: { addListener() {} },
      attach: (_target, _version, done) => { calls.push('attach'); done(); },
      sendCommand: async ({ tabId }, method) => { calls.push(`${method}:${tabId}`); refuse(tabId); return {}; },
      detach: async ({ tabId }) => { calls.push(`detach:${tabId}`); refuse(tabId); },
    },
  };
  try {
    const cdp = await import('../dist/cdp.mjs');
    await cdp.sendIfAttached(4, 'Page.disable');
    await cdp.detachTab(4);
    await assert.rejects(cdp.sendIfAttached(6, 'Page.disable'), /not attached/);
    await assert.rejects(cdp.detachTab(6), /not attached/);
    assert.deepEqual(calls, ['Page.disable:4', 'detach:4', 'Page.disable:6', 'detach:6'],
      'release primitives act on an earlier attachment and never attach');
    assert.deepEqual(cdp.attachedTabIds(), []);
  } finally { delete globalThis.chrome; }
}
stopWatchdog();
console.log('Session capture lifecycle: revoked/late dialog authorization, private buffers, recording generations and release on ownership loss (also of attachments from before a worker restart) passed');
