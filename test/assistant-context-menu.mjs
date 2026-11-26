// "Fråga Tabai" in Chrome's context menu and the Dela shortcut, against a fake chrome:
// the menu exists only with its optional permission, every entry opens the panel
// inside the user's gesture before anything is awaited, the request carries no page
// text, a window without a panel gets a request that says why, and the topmost chat
// in the panel takes each request for its own window once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { watchdog } from './watchdog.mjs';

const stop = watchdog();
const events = () => { const listeners = []; return { listeners, addListener: listener => listeners.push(listener), removeListener: listener => listeners.splice(listeners.indexOf(listener), 1) }; };
const store = {}, opened = [], order = [];
let open = () => Promise.resolve();
globalThis.chrome = {
  sidePanel: { open: options => { order.push('open'); opened.push(options); return open(); } },
  storage: {
    session: { set: async value => { order.push('set'); Object.assign(store, structuredClone(value)); }, get: async key => ({ [key]: structuredClone(store[key]) }), remove: async key => { delete store[key]; } },
    onChanged: events(),
  },
  commands: { onCommand: events() },
  permissions: { onAdded: events(), onRemoved: events() },
  runtime: { onInstalled: events(), lastError: undefined },
  windows: { getCurrent: async () => ({ id: 3 }) },
};
const { ASSISTANT_MENU_ITEMS, ASSISTANT_PANEL_CLOSED, ASSISTANT_PANEL_NO_PAGE, ASSISTANT_PANEL_REQUEST_KEY, ASSISTANT_PANEL_REQUEST_MS, ASSISTANT_SHARE_COMMAND,
  assistantMenuClicked, assistantPanelRequestFor, registerAssistantEntryPoints, watchAssistantPanelRequests } = await import('../dist/assistant-context-menu.mjs');
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const tab = { id: 7, windowId: 3, url: 'https://shop.example/order?id=4711', active: true };
const last = () => store[ASSISTANT_PANEL_REQUEST_KEY];

// The shortcut is declared, and the menu's permission is optional: no reinstall, no new required permission.
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
assert.deepEqual(manifest.commands, { [ASSISTANT_SHARE_COMMAND]: { suggested_key: { default: 'Alt+Shift+D' }, description: 'Dela sidan med Tabai' } });
assert.ok(manifest.optional_permissions.includes('contextMenus') && !manifest.permissions.includes('contextMenus'));

// Without the permission there is no menu; the shortcut still works.
registerAssistantEntryPoints();
await settle();
assert.equal(chrome.commands.onCommand.listeners.length, 1);
const created = [];
chrome.contextMenus = { removeAll: async () => { created.length = 0; }, create: (item, done) => { created.push(item); done?.(); }, onClicked: events() };
chrome.permissions.onAdded.listeners.forEach(listener => listener({ permissions: ['notifications'] }));
await settle();
assert.equal(created.length, 0, 'another permission changes nothing');
chrome.permissions.onAdded.listeners.forEach(listener => listener({ permissions: ['contextMenus'] }));
await settle();
const items = [
  { id: 'tabai-ask-selection', title: 'Fråga Tabai om ”%s”', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'tabai-share-page', title: 'Dela sidan med Tabai', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
  { id: 'tabai-ask-link', title: 'Fråga Tabai om länken', contexts: ['link'], documentUrlPatterns: ['http://*/*', 'https://*/*'] },
];
assert.deepEqual(created, items, 'the three items, on ordinary web pages only');
chrome.permissions.onAdded.listeners.forEach(listener => listener({ permissions: ['contextMenus'] }));
chrome.runtime.onInstalled.listeners.forEach(listener => listener({ reason: 'update' }));
await settle();
assert.deepEqual(created, items, 'syncing again recreates the menu once, never twice');
assert.equal(chrome.contextMenus.onClicked.listeners.length, 1, 'one click listener');
assert.deepEqual(ASSISTANT_MENU_ITEMS.map(item => item.kind), ['selection', 'page', 'link']);

// Each choice opens the panel inside the gesture: the open call happens before the click handler returns.
const click = (info, target = tab) => { order.length = 0; const before = opened.length; chrome.contextMenus.onClicked.listeners[0](info, target); return opened.length - before; };
assert.equal(click({ menuItemId: 'tabai-ask-selection', pageUrl: tab.url, selectionText: 'Hemligt-Formularvarde-1234', editable: false }), 1, 'opened synchronously');
assert.deepEqual(opened.at(-1), { windowId: 3 });
await settle();
assert.deepEqual(order, ['open', 'set']);
assert.deepEqual((({ kind, windowId, tabId, url }) => ({ kind, windowId, tabId, url }))(last()), { kind: 'selection', windowId: 3, tabId: 7, url: tab.url });
assert.equal(JSON.stringify(last()).includes('Hemligt'), false, "Chrome's selection text never travels; the panel reads the selection with Dela's rules");
click({ menuItemId: 'tabai-ask-link', pageUrl: tab.url, linkUrl: 'https://other.example/produkt' }); await settle();
assert.deepEqual([last().kind, last().url], ['link', 'https://other.example/produkt'], 'the link item carries the link itself');
click({ menuItemId: 'tabai-share-page', pageUrl: tab.url }); await settle();
assert.deepEqual([last().kind, last().url], ['page', tab.url]);
const before = { ...last() };
assert.equal(click({ menuItemId: 'someone-else' }), 0, 'other items are not ours'); await settle();
assert.deepEqual(last(), before);

// The shortcut shares the active tab, like Dela.
order.length = 0;
chrome.commands.onCommand.listeners[0](ASSISTANT_SHARE_COMMAND, tab);
assert.equal(order[0], 'open', 'opened inside the shortcut');
await settle();
assert.deepEqual([last().kind, last().tabId, last().url], ['page', 7, tab.url]);
const count = opened.length;
chrome.commands.onCommand.listeners[0]('_execute_action', tab); await settle();
assert.equal(opened.length, count, 'other commands are not ours');

// Nothing happens silently: a window without a panel, or no page, leaves a request that says why.
open = () => Promise.reject(new Error('No active side panel for windowId: 3'));
click({ menuItemId: 'tabai-share-page', pageUrl: tab.url }); await settle();
assert.deepEqual([last().kind, last().message], ['failed', ASSISTANT_PANEL_CLOSED]);
chrome.sidePanel.open = () => { throw new Error('sidePanel.open may only be called in response to a user gesture'); };
click({ menuItemId: 'tabai-share-page', pageUrl: tab.url }); await settle();
assert.equal(last().message, ASSISTANT_PANEL_CLOSED, 'a synchronous refusal is caught too');
chrome.sidePanel.open = options => { order.push('open'); opened.push(options); return Promise.resolve(); };
await assistantMenuClicked({ menuItemId: 'tabai-share-page' }, { id: 7, windowId: 3 });
assert.deepEqual([last().kind, last().message], ['failed', ASSISTANT_PANEL_NO_PAGE], 'a tab without an address');
await assistantMenuClicked({ menuItemId: 'tabai-share-page', pageUrl: tab.url }, undefined);
assert.equal(last().message, ASSISTANT_PANEL_CLOSED, 'no tab, no window to open');

// The panel accepts only a fresh request for its own window; a failure is shown wherever the panel opens.
const now = Date.now(), id = crypto.randomUUID();
const request = { id, at: now, kind: 'selection', windowId: 3, tabId: 7, url: tab.url };
assert.deepEqual(assistantPanelRequestFor(request, 3, now), request);
assert.equal(assistantPanelRequestFor(request, 4, now), undefined, 'another window');
assert.equal(assistantPanelRequestFor(request, 3, now + ASSISTANT_PANEL_REQUEST_MS + 1), undefined, 'expired');
assert.equal(assistantPanelRequestFor({ ...request, at: now + 60_000 }, 3, now), undefined, 'from the future');
assert.equal(assistantPanelRequestFor({ ...request, kind: 'download' }, 3, now), undefined, 'an unknown kind');
assert.equal(assistantPanelRequestFor({ ...request, tabId: '7' }, 3, now), undefined, 'a malformed tab');
assert.equal(assistantPanelRequestFor({ ...request, id: 'x' }, 3, now), undefined, 'a malformed id');
assert.deepEqual(assistantPanelRequestFor({ id, at: now, kind: 'failed', message: 'Varför' }, 4, now), { id, at: now, kind: 'failed', message: 'Varför' });
for (const value of [undefined, null, 'x', 7, []]) assert.equal(assistantPanelRequestFor(value, 3, now), undefined);

// The topmost chat takes each request once; the request is removed after it is taken.
globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
const element = position => ({ position, isConnected: true, compareDocumentPosition(other) { return other.position > this.position ? 4 : 2; } });
const takenBy = [];
const lower = watchAssistantPanelRequests(element(2), value => takenBy.push(['lower', value.kind]));
const upper = watchAssistantPanelRequests(element(1), value => takenBy.push(['upper', value.kind]));
store[ASSISTANT_PANEL_REQUEST_KEY] = { ...request, id: crypto.randomUUID(), at: Date.now() };
chrome.storage.onChanged.listeners.forEach(listener => listener({ [ASSISTANT_PANEL_REQUEST_KEY]: { newValue: store[ASSISTANT_PANEL_REQUEST_KEY] } }, 'session'));
await settle();
assert.deepEqual(takenBy, [['upper', 'selection']], 'the topmost chat takes it');
assert.equal(last(), undefined, 'taken requests are removed');
store[ASSISTANT_PANEL_REQUEST_KEY] = { ...request, id: crypto.randomUUID(), at: Date.now(), windowId: 9 };
chrome.storage.onChanged.listeners.forEach(listener => listener({ [ASSISTANT_PANEL_REQUEST_KEY]: { newValue: store[ASSISTANT_PANEL_REQUEST_KEY] } }, 'session'));
await settle();
assert.equal(takenBy.length, 1, "another window's request stays for its own panel"); assert.equal(last().windowId, 9);
upper();
store[ASSISTANT_PANEL_REQUEST_KEY] = { ...request, id: crypto.randomUUID(), at: Date.now(), kind: 'link' };
chrome.storage.onChanged.listeners.forEach(listener => listener({ [ASSISTANT_PANEL_REQUEST_KEY]: { newValue: store[ASSISTANT_PANEL_REQUEST_KEY] } }, 'session'));
chrome.storage.onChanged.listeners.forEach(listener => listener({ [ASSISTANT_PANEL_REQUEST_KEY]: { newValue: store[ASSISTANT_PANEL_REQUEST_KEY] } }, 'session'));
await settle();
assert.deepEqual(takenBy.at(-1), ['lower', 'link'], 'with the upper chat gone, the next one takes it');
assert.equal(takenBy.length, 2, 'once, even when the change is reported twice');
lower();

// A worker that Chrome starts for a menu click, with the permission already granted: the click
// listener exists as soon as the module has registered its entry points, before anything is awaited.
{
  const woken = events();
  chrome.contextMenus = { removeAll: async () => {}, create: () => {}, onClicked: woken };
  const started = await import('../dist/assistant-context-menu.mjs?worker-start');
  started.registerAssistantEntryPoints();
  assert.equal(woken.listeners.length, 1, 'the click listener is registered synchronously');
  await settle();
  assert.equal(woken.listeners.length, 1, 'the sync that follows adds no second listener');
  order.length = 0;
  woken.listeners[0]({ menuItemId: 'tabai-share-page', pageUrl: tab.url }, tab);
  assert.equal(order[0], 'open', 'the waking click opens the panel');
  await settle();
}

// Settings → Allmänt follows the permission while its panel exists: a panel that is disposed
// and created again leaves no permission listener behind.
{
  const element = () => ({ dataset: {}, style: {}, children: [], append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {}, addEventListener() {} });
  globalThis.document = { createElement: element, createTextNode: text => ({ text }) };
  chrome.permissions.contains = async () => false;
  const { assistantContextMenuSetting } = await import('../dist/assistant-context-menu.mjs?setting');
  const listening = () => [chrome.permissions.onAdded.listeners.length, chrome.permissions.onRemoved.listeners.length];
  const before = listening();
  const first = assistantContextMenuSetting();
  assert.ok(first.element, 'the setting is drawn');
  assert.deepEqual(listening(), [before[0] + 1, before[1] + 1], 'one listener each while the setting is shown');
  first.stop();
  for (let round = 0; round < 3; round++) assistantContextMenuSetting().stop();
  assert.deepEqual(listening(), before, 'recreating the panel adds no listener');
  await settle();
  delete chrome.permissions.contains; delete globalThis.document;
}

delete globalThis.chrome; delete globalThis.Node;
console.log('assistant-context-menu: optional menu on web pages, a click listener registered synchronously at the worker\'s start, panel opened inside the gesture, no page text in the request, honest failures, Dela shortcut and one taker per request passed');
stop();
