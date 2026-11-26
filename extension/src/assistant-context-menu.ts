import { node } from './module-views';
import { section } from './assistant-controls';

/**
 * "Fråga Tabai" in Chrome's context menu and the Dela shortcut. The service worker
 * only opens the panel inside the user's gesture and leaves the panel a request; the
 * panel itself reads the page with Dela's own rules. Nothing here reads a page.
 */

/** Where the service worker leaves the panel what the user chose. */
export const ASSISTANT_PANEL_REQUEST_KEY = 'tabaiPanelRequest';
/** The manifest command that shares the active tab, like Dela. */
export const ASSISTANT_SHARE_COMMAND = 'share-page';
/** A request older than this is never acted on: the user has moved on. */
export const ASSISTANT_PANEL_REQUEST_MS = 60_000;
/** The context menu, on ordinary web pages only. */
export const ASSISTANT_MENU_ITEMS = [
  { id: 'tabai-ask-selection', kind: 'selection', title: 'Fråga Tabai om ”%s”', contexts: ['selection'] },
  { id: 'tabai-share-page', kind: 'page', title: 'Dela sidan med Tabai', contexts: ['page'] },
  { id: 'tabai-ask-link', kind: 'link', title: 'Fråga Tabai om länken', contexts: ['link'] },
] as const;
const PAGES = ['http://*/*', 'https://*/*'];
export const ASSISTANT_PANEL_CLOSED = 'Tabai kunde inte öppna panelen i det fönstret. Öppna Tabai i ett vanligt Chrome-fönster och försök igen.';
export const ASSISTANT_PANEL_NO_PAGE = 'Tabai fick ingen sida att arbeta med. Försök igen på en vanlig webbsida.';

export type AssistantPanelRequestKind = typeof ASSISTANT_MENU_ITEMS[number]['kind'];
export type AssistantPanelRequest =
  | { id: string; at: number; kind: AssistantPanelRequestKind; windowId: number; tabId: number; url: string }
  | { id: string; at: number; kind: 'failed'; message: string };

// ---- Service worker --------------------------------------------------------

let clicking = false;
let syncing: Promise<void> = Promise.resolve();

/**
 * Opens the panel inside the user's gesture, before anything is awaited, and then
 * leaves it the request. When no panel can open, the request says why instead, so
 * the panel explains it the next time it is opened.
 */
export function assistantPanelRequest(kind: AssistantPanelRequestKind, tab: chrome.tabs.Tab | undefined, url: string | undefined): Promise<void> {
  const id = crypto.randomUUID(), at = Date.now(), windowId = tab?.windowId;
  let opened: Promise<unknown>;
  try { opened = windowId !== undefined && windowId >= 0 ? chrome.sidePanel.open({ windowId }) : Promise.reject(new Error('No window')); }
  catch (error) { opened = Promise.reject(error); }
  return opened.then((): AssistantPanelRequest => tab?.id !== undefined && url ? { id, at, kind, windowId: windowId!, tabId: tab.id, url } : { id, at, kind: 'failed', message: ASSISTANT_PANEL_NO_PAGE },
    (): AssistantPanelRequest => ({ id, at, kind: 'failed', message: ASSISTANT_PANEL_CLOSED }))
    .then(request => chrome.storage.session.set({ [ASSISTANT_PANEL_REQUEST_KEY]: request })).catch(() => {});
}
/** One click in the menu: the selection and the page carry the page's address, the link its own. */
export function assistantMenuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> | undefined {
  const item = ASSISTANT_MENU_ITEMS.find(entry => entry.id === info.menuItemId);
  if (!item) return undefined;
  return assistantPanelRequest(item.kind, tab, item.kind === 'link' ? info.linkUrl : info.pageUrl ?? tab?.url);
}
/**
 * Chrome wakes a stopped worker for the click, and delivers it only to a listener
 * registered synchronously at the worker's start; a sync adds it later when the
 * permission is granted while the worker runs.
 */
function listenToMenu() {
  if (clicking || !chrome.contextMenus?.onClicked) return;
  clicking = true;
  chrome.contextMenus.onClicked.addListener((info, tab) => void assistantMenuClicked(info, tab));
}
/** The menu exists exactly while its optional permission is granted; each sync recreates it once. */
function syncMenu(): Promise<void> {
  syncing = syncing.then(async () => {
    listenToMenu();
    if (!chrome.contextMenus) return;
    await chrome.contextMenus.removeAll();
    for (const item of ASSISTANT_MENU_ITEMS)
      chrome.contextMenus.create({ id: item.id, title: item.title, contexts: [...item.contexts], documentUrlPatterns: PAGES }, () => void chrome.runtime.lastError);
  }).catch(() => {});
  return syncing;
}
/** Registers the shortcut and, while the permission is granted, the menu. Called once, synchronously, at the worker's start. */
export function registerAssistantEntryPoints(): void {
  listenToMenu();
  chrome.commands?.onCommand.addListener((command, tab) => { if (command === ASSISTANT_SHARE_COMMAND) void assistantPanelRequest('page', tab, tab?.url); });
  chrome.permissions?.onAdded?.addListener(change => { if (change.permissions?.includes('contextMenus')) void syncMenu(); });
  chrome.runtime.onInstalled.addListener(() => void syncMenu());
  void syncMenu();
}

// ---- Panel -------------------------------------------------------------------

/** A stored request for this panel's window that has not expired, or undefined. */
export function assistantPanelRequestFor(value: unknown, windowId: number | undefined, now = Date.now()): AssistantPanelRequest | undefined {
  const request = value as Partial<Record<string, unknown>> | undefined;
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/.test(request.id) || typeof request.at !== 'number' || now - request.at > ASSISTANT_PANEL_REQUEST_MS || request.at > now + 5_000) return undefined;
  if (request.kind === 'failed') return typeof request.message === 'string' ? { id: request.id, at: request.at, kind: 'failed', message: request.message.slice(0, 300) } : undefined;
  if (windowId === undefined || !ASSISTANT_MENU_ITEMS.some(item => item.kind === request.kind) || request.windowId !== windowId || !Number.isInteger(request.tabId) || typeof request.url !== 'string' || request.url.length > 8192) return undefined;
  return { id: request.id, at: request.at, kind: request.kind as AssistantPanelRequestKind, windowId, tabId: request.tabId as number, url: request.url };
}

type Taker = { element: HTMLElement; take: (request: AssistantPanelRequest) => void };
const takers = new Set<Taker>();
const taken = new Set<string>();
let panelWindow: number | undefined, watching = false, queue: Promise<void> = Promise.resolve();

/** The topmost assistant chat in this panel takes each request for this window, once. */
async function takeRequest() {
  if (panelWindow === undefined) return;
  const taker = [...takers].filter(entry => entry.element.isConnected)
    .sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)[0];
  if (!taker) return;
  const request = assistantPanelRequestFor((await chrome.storage.session.get(ASSISTANT_PANEL_REQUEST_KEY))[ASSISTANT_PANEL_REQUEST_KEY], panelWindow);
  if (!request || taken.has(request.id)) return;
  taken.add(request.id);
  // Removed only while it is still this request: a newer one written meanwhile stays for its panel.
  const current = (await chrome.storage.session.get(ASSISTANT_PANEL_REQUEST_KEY))[ASSISTANT_PANEL_REQUEST_KEY] as { id?: string } | undefined;
  if (current?.id === request.id) await chrome.storage.session.remove(ASSISTANT_PANEL_REQUEST_KEY);
  taker.take(request);
}
const nextRequest = () => { queue = queue.then(takeRequest).catch(() => {}); return queue; };
/** Starts taking requests for one chat; returns the function that stops it. */
export function watchAssistantPanelRequests(element: HTMLElement, take: (request: AssistantPanelRequest) => void): () => void {
  const taker = { element, take };
  takers.add(taker);
  if (!watching && typeof chrome !== 'undefined' && chrome.storage?.session && chrome.windows?.getCurrent) {
    watching = true;
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes[ASSISTANT_PANEL_REQUEST_KEY]?.newValue) void nextRequest(); });
    void chrome.windows.getCurrent().then(window => { panelWindow = window.id; void nextRequest(); }).catch(() => {});
  } else void nextRequest();
  return () => { takers.delete(taker); };
}

/**
 * Settings → Allmänt: the menu is an optional permission, asked for on the user's own click, like
 * notifications. The switch follows permission changes while it is shown; `stop` removes those
 * listeners when its panel goes, so a panel created again never adds another pair.
 */
export function assistantContextMenuSetting(): { element: HTMLElement; stop: () => void } {
  const result = section('Högerklicksmenyn', 'context-menu', 'Fråga Tabai om markerad text, dela sidan eller fråga om en länk direkt från Chromes högerklicksmeny på webbsidor. Ingenting läses förrän du väljer något i menyn.');
  const label = node('label', '', 'checkpoint-option'), toggle = node('input'), status = node('p', '', 'muted assistant-context-menu-status'), shortcut = node('p', '', 'muted assistant-shortcut');
  toggle.type = 'checkbox'; toggle.name = 'context-menu';
  label.append(toggle, document.createTextNode('Visa Tabai i högerklicksmenyn'));
  status.setAttribute('role', 'status');
  result.append(label, status, shortcut);
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) {
    toggle.disabled = true; status.textContent = 'Högerklicksmenyn kräver Tabais tillägg i Chrome.'; return { element: result, stop: () => {} };
  }
  const permission = { permissions: ['contextMenus'] };
  const refresh = async () => { try { toggle.checked = await chrome.permissions.contains(permission); } catch { toggle.checked = false; } };
  toggle.addEventListener('change', () => void (async () => {
    // Chrome asks inside this click; a refusal leaves the menu off.
    const asked = toggle.checked ? chrome.permissions.request(permission) : undefined;
    toggle.disabled = true;
    try {
      if (asked) {
        const granted = await asked.catch(() => false);
        toggle.checked = granted;
        status.textContent = granted ? 'Tabai finns nu i högerklicksmenyn på webbsidor.' : 'Chrome tillät inte högerklicksmenyn. Inget har ändrats.';
      } else {
        try { await chrome.contextMenus?.removeAll(); } catch { /* The permission's removal takes the menu with it. */ }
        const removed = await chrome.permissions.remove(permission).catch(() => false);
        toggle.checked = !removed;
        status.textContent = removed ? 'Tabai visas inte längre i högerklicksmenyn.' : 'Högerklicksmenyn kunde inte stängas av. Försök igen.';
      }
    } finally { toggle.disabled = false; }
  })());
  // The typings give these two events addListener only; at runtime both are chrome.events.Event objects, with removeListener.
  const events = [chrome.permissions.onAdded, chrome.permissions.onRemoved].filter(Boolean).map(event => event as chrome.events.Event<() => void>);
  const changed = () => void refresh();
  for (const event of events) event.addListener(changed);
  void refresh();
  const key = node('kbd');
  void (chrome.commands?.getAll?.() ?? Promise.resolve([] as chrome.commands.Command[])).then(commands => {
    const assigned = commands.find(command => command.name === ASSISTANT_SHARE_COMMAND)?.shortcut;
    if (assigned) { key.textContent = assigned; shortcut.replaceChildren('Kortkommando för Dela: ', key, '. Det öppnar panelen och delar sidan du har framme.'); }
    else shortcut.textContent = 'Dela har inget kortkommando. Välj ett under chrome://extensions/shortcuts.';
  }).catch(() => { shortcut.textContent = ''; });
  return { element: result, stop: () => { for (const event of events) event.removeListener(changed); } };
}
