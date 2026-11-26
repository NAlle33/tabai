import { ASSISTANT_FILE_TEXT } from '../../shared/assistant-files';
import { assistantPageAddress, assistantPageIsMail, assistantShareablePage, type AssistantSharedPage } from '../../shared/assistant-page';

/**
 * "Den här sidan": the user shares the page in the panel window's active tab with
 * the chat. This is the panel's own action after the user's tap, never an agent
 * path: no agent tool reaches this module, and before the tap the panel knows only
 * the tab's address and title from chrome.tabs.
 */
export interface AssistantActivePage { tabId: number; windowId: number; address: string; label: string; mail: boolean }
type PageRead = AssistantSharedPage & { contentType: string; editable?: boolean; typed?: boolean };
/** One read waits at most this long; a hung page never holds Dela for other tabs. */
export const ASSISTANT_PAGE_READ_MS = 15_000;

/**
 * Runs once in the tab's main frame, in the extension's isolated world, after the
 * user's tap. Serialized with func.toString(): only its own parameter and page
 * globals, so every helper lives inside it.
 *
 * Only text a sighted user can see is taken: text nodes walked one by one, through
 * open shadow roots, with a line break at block boundaries. Text is left out when
 * its parent does not pass checkVisibility (display, visibility, opacity,
 * content-visibility), when an ancestor is aria-hidden, inert or a clipping box of
 * at most 1 px (sr-only, clip, height:0 with overflow:hidden), when the text itself
 * measures at most 1 px or has font-size 0 or a transparent colour, and when it
 * lies entirely outside the page or its scroll container (left:-10000px). Form
 * controls are never walked, so typed values, passwords and select choices stay.
 *
 * Text the user types elsewhere stays too: a subtree that is editable (contenteditable,
 * editability inherited from an ancestor, or designMode) or has the role textbox,
 * searchbox or combobox never joins the page text, also while it has focus. A
 * selection the user made inside one is deliberate and is read, as the selection
 * only. A page that is editable as a whole therefore has no page text, and says so;
 * `typed` says that a visible editor holds text the page text leaves out, so a page
 * whose only text is in editors is not reported as empty.
 * An editor that draws its text in ordinary elements behind a hidden textarea
 * (several code editors do) is not recognised by this rule.
 */
function readSharedPage(limit: number) {
  const skipped = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION|OPTGROUP|DATALIST|INPUT|IFRAME|FRAME|OBJECT|EMBED|CANVAS|VIDEO|AUDIO|HEAD|TITLE|DESC|META|LINK)$/;
  const typing = (element: Element) => (element instanceof HTMLElement && element.isContentEditable) || /(^|\s)(textbox|searchbox|combobox)(\s|$)/i.test(element.getAttribute('role') ?? '');
  const styles = new Map<Element, CSSStyleDeclaration>(), concealedBy = new Map<Element, boolean>(), shown = new Map<Element, boolean>();
  const scrollers = new Map<Element, Element | null>(), placed = new Map<Element, boolean>();
  const style = (element: Element) => { let value = styles.get(element); if (!value) { value = getComputedStyle(element); styles.set(element, value); } return value; };
  const up = (element: Element): Element | null => element.parentElement ?? (element.parentNode instanceof ShadowRoot ? element.parentNode.host : null);
  const clear = (value: string) => value === 'transparent' || /^rgba\(.*,\s*0(?:\.0*)?\)$/.test(value) || /\/\s*0(?:\.0*)?%?\s*\)$/.test(value);
  // aria-hidden, inert, or a clipping box of at most 1 px, on the element or any ancestor across shadow roots.
  const concealed = (element: Element | null): boolean => {
    if (!element) return false;
    const known = concealedBy.get(element); if (known !== undefined) return known;
    let result = element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert');
    if (!result) {
      const css = style(element), box = element.getBoundingClientRect();
      const clips = css.overflowX !== 'visible' || css.overflowY !== 'visible' || css.clipPath !== 'none' || (!!css.clip && css.clip !== 'auto');
      result = clips && css.display !== 'contents' && (box.width <= 1 || box.height <= 1);
    }
    result ||= concealed(up(element));
    concealedBy.set(element, result); return result;
  };
  // Not contentVisibilityAuto: such sections are only deferred for speed and show when scrolled to.
  const visibleBox = (element: Element) => {
    let value = shown.get(element);
    if (value === undefined) { value = element.checkVisibility({ opacityProperty: true, visibilityProperty: true }); shown.set(element, value); }
    return value;
  };
  // The nearest ancestor the user can scroll (or that clips), below the page itself.
  const scroller = (element: Element | null): Element | null => {
    if (!element || element === document.body || element === document.documentElement) return null;
    if (scrollers.has(element)) return scrollers.get(element)!;
    const css = style(element), value = css.overflowX !== 'visible' || css.overflowY !== 'visible' ? element : scroller(up(element));
    scrollers.set(element, value); return value;
  };
  // Entirely outside the scroll area of its container, or of the page: nobody can scroll there.
  // A right-to-left area scrolls from its right edge, so its area starts left of zero.
  const outside = (area: Element, left: number, top: number, box: DOMRect) => {
    const start = style(area).direction === 'rtl' ? area.clientWidth - area.scrollWidth : 0;
    return left + box.width <= start || left >= start + area.scrollWidth || top + box.height <= 0 || top >= area.scrollHeight;
  };
  const away = (box: DOMRect, from: Element | null): boolean => {
    const frame = scroller(from);
    if (!frame) return outside(document.scrollingElement ?? document.documentElement, box.left + scrollX, box.top + scrollY, box);
    const rect = frame.getBoundingClientRect();
    if (outside(frame, box.left - rect.left - frame.clientLeft + frame.scrollLeft, box.top - rect.top - frame.clientTop + frame.scrollTop, box)) return true;
    let known = placed.get(frame);
    if (known === undefined) { known = away(rect, up(frame)); placed.set(frame, known); }
    return known;
  };
  const measure = document.createRange();
  const visible = (node: Text, parent: Element, css: CSSStyleDeclaration) => {
    if (concealed(parent) || !visibleBox(parent) || parseFloat(css.fontSize) === 0) return false;
    // checkVisibility judges the parent's own box; text directly inside a closed details
    // or a content-visibility:hidden box is not rendered, although measuring it lays it out.
    if (css.getPropertyValue('content-visibility') === 'hidden' || parent instanceof HTMLDetailsElement && !parent.open) return false;
    if (clear(css.color) && clear(css.getPropertyValue('-webkit-text-fill-color') || css.color) && css.backgroundClip !== 'text' && css.getPropertyValue('-webkit-background-clip') !== 'text') return false;
    measure.selectNodeContents(node);
    const box = measure.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && !away(box, parent);
  };

  // A selection is the user's choice on the page, never a form field. Chrome reports a
  // selection inside a text field as a collapsed selection of the document whose
  // toString() still returns the field's text: so only a selection that is not
  // collapsed is taken, and never one whose anchor or focus lies in a field or
  // while a field has focus.
  let focused: Element | null = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  const selection = window.getSelection();
  const field = (target: Node | null | undefined) => !!(target instanceof Element ? target : target?.parentElement)?.closest('input, textarea, select');
  const inField = !!focused?.matches('input, textarea, select') || field(selection?.anchorNode) || field(selection?.focusNode);
  const ranges: Range[] = [];
  if (selection && !selection.isCollapsed && !inField) for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index));

  type Out = { text: string; gap: string };
  const page: Out = { text: '', gap: '' }, chosen: Out = { text: '', gap: '' };
  const put = (out: Out, value: string, keep: boolean) => {
    // Collapsed white space never starts a line or doubles a space.
    if (!keep && (out.gap || !out.text || /\s$/.test(out.text))) value = value.replace(/^ /, '');
    if (!value) return;
    if (out.gap && out.text) out.text += out.gap;
    out.gap = ''; out.text += value;
  };
  const gap = (separator: string, outs: Out[]) => {
    for (const out of outs) { out.text = out.text.replace(/ +$/, ''); if (separator === '\n' || !out.gap) out.gap = separator; }
  };
  const flow = (value: string, whiteSpace: string) => whiteSpace === 'pre-line' ? value.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n')
    : /^(pre|pre-wrap|break-spaces)$/.test(whiteSpace) ? value : value.replace(/[ \t\n\r\f]+/g, ' ');
  const text = (node: Text, typed: boolean) => {
    const parent = node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
    if (!parent || !node.data) return;
    const css = style(parent), keep = /^(pre|pre-wrap|break-spaces)$/.test(css.whiteSpace), value = flow(node.data, css.whiteSpace);
    // White space alone shows nothing and only separates words.
    if (value.trim() && !visible(node, parent, css)) return;
    if (!typed) put(page, value, keep);
    for (const range of ranges) if (range.intersectsNode(node)) {
      const start = node === range.startContainer ? range.startOffset : 0, end = node === range.endContainer ? range.endOffset : node.data.length;
      put(chosen, flow(node.data.slice(start, end), css.whiteSpace), keep);
    }
  };
  // Whether a visible editor holds text that the page text leaves out.
  let leftOut = false;
  // `typed`: inside text the user types, which only a selection reaches into.
  const walk = (node: Node, typed = false) => {
    if (page.text.length > limit) return;
    if (node.nodeType === Node.TEXT_NODE) { text(node as Text, typed); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (skipped.test(element.tagName.toUpperCase())) return;
    const inside = typed || typing(element);
    if (inside && !typed && !leftOut && !!element.textContent?.trim() && visibleBox(element)) leftOut = true;
    if (inside && !ranges.some(range => range.intersectsNode(element))) return;
    const css = style(element);
    if (css.display === 'none') return;
    const outs = inside ? [chosen] : [page, chosen];
    if (element.tagName === 'BR') { gap('\n', outs); return; }
    const separator = css.display === 'table-cell' ? '\t' : /^(inline|contents|ruby)/.test(css.display) ? '' : '\n';
    if (separator) gap(separator, outs);
    const assigned = element instanceof HTMLSlotElement ? element.assignedNodes({ flatten: true }) : [];
    for (const child of element.shadowRoot ? element.shadowRoot.childNodes : assigned.length ? assigned : element.childNodes) walk(child, inside);
    if (separator) gap(separator, outs);
  };
  if (document.body) walk(document.body);
  const all = page.text.replace(/ +$/, ''), picked = chosen.text.replace(/ +$/, '');
  return { title: document.title.slice(0, 500), url: location.href, contentType: document.contentType, selection: picked.slice(0, limit), text: all.slice(0, limit), truncated: all.length > limit, editable: !!document.body && typing(document.body), typed: leftOut };
}

/**
 * Reads the shared page on the user's tap: still the active tab in this window, and still an ordinary
 * page. `editable` marks a page that is editable as a whole: it has no page text, only a selection.
 * `typed` marks a page with text in an editor, which the page text leaves out.
 */
export async function assistantReadPage(page: AssistantActivePage, timeoutMs = ASSISTANT_PAGE_READ_MS): Promise<AssistantSharedPage & { editable?: true; typed?: true }> {
  const tab = await chrome.tabs.get(page.tabId).catch(() => undefined);
  if (!tab || !tab.active || tab.windowId !== page.windowId || !assistantShareablePage(tab.url)) throw new Error('Sidan har bytts eller stängts. Tryck Dela igen.');
  if (assistantPageIsMail(tab.url)) throw new Error('Mejlen hanteras i Mejl.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sidan svarade inte inom 15 sekunder. Ladda om sidan och tryck Dela igen.')), timeoutMs); });
  let results: chrome.scripting.InjectionResult<PageRead>[];
  try {
    // A page that never answers is left behind: its late result is never used. The isolated world
    // keeps the page's own scripts away from the functions the read relies on.
    results = await Promise.race([chrome.scripting.executeScript({ target: { tabId: page.tabId, frameIds: [0] }, world: 'ISOLATED', func: readSharedPage, args: [ASSISTANT_FILE_TEXT] })
      .catch(() => { throw new Error('Chrome lät inte Tabai läsa den här sidan. Kopiera texten och klistra in den i stället.'); }), late]);
  } finally { clearTimeout(timer); }
  const read = results[0]?.result;
  if (!read || typeof read.text !== 'string' || typeof read.selection !== 'string' || typeof read.url !== 'string') throw new Error('Sidan kunde inte läsas. Ladda om sidan och försök igen.');
  if (read.contentType === 'application/pdf') throw new Error('Det här är en PDF. Spara den och bifoga filen med + i stället.');
  // The document itself decides: a navigation since the tap may have left http(s) or the site the user saw.
  if (!assistantShareablePage(read.url)) throw new Error('Bara vanliga webbsidor kan delas, inte Chromes egna sidor, tilläggssidor eller lokala filer.');
  if (new URL(read.url).origin !== new URL(page.address).origin) throw new Error('Sidan har bytts till en annan webbplats. Tryck Dela igen.');
  // A page whose text is all in editors, without a selection, is the panel's to explain: it asks for a selection.
  const editable = read.editable === true, typed = read.typed === true;
  if (!read.text.trim() && !read.selection.trim() && !editable && !typed) throw new Error('Sidan visar ingen text som kan delas.');
  return { title: String(read.title ?? ''), url: read.url, selection: read.selection, text: read.text, truncated: !!read.truncated, ...(editable ? { editable: true as const } : {}), ...(typed ? { typed: true as const } : {}) };
}

/** Follows the active tab of the panel's own window by its address only; its content is never read here. */
export class AssistantActiveTab {
  current?: AssistantActivePage;
  private windowId?: number;
  private sequence = 0;
  private disposed = false;
  private readonly tabs = typeof chrome !== 'undefined' ? chrome.tabs : undefined;
  constructor(private changed: () => void) {
    if (!this.tabs?.onActivated || !chrome.windows?.getCurrent) return;
    this.tabs.onActivated.addListener(this.onActivated); this.tabs.onUpdated.addListener(this.onUpdated);
    this.tabs.onAttached.addListener(this.refresh); this.tabs.onDetached.addListener(this.refresh);
    void chrome.windows.getCurrent().then(window => { this.windowId = window.id; void this.refresh(); }).catch(() => { /* No window: nothing to offer. */ });
  }
  dispose() {
    this.disposed = true;
    if (!this.tabs?.onActivated) return;
    this.tabs.onActivated.removeListener(this.onActivated); this.tabs.onUpdated.removeListener(this.onUpdated);
    this.tabs.onAttached.removeListener(this.refresh); this.tabs.onDetached.removeListener(this.refresh);
  }
  private onActivated = (info: chrome.tabs.TabActiveInfo) => { if (info.windowId === this.windowId) void this.refresh(); };
  private onUpdated = (_tabId: number, change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
    if (tab.windowId === this.windowId && tab.active && (change.url !== undefined || change.title !== undefined || change.status !== undefined)) { this.sequence++; this.set(tab); }
  };
  // A later event wins over an older query that resolves after it.
  private refresh = async () => {
    if (this.windowId === undefined || this.disposed) return;
    const sequence = ++this.sequence;
    const [tab] = await this.tabs!.query({ active: true, windowId: this.windowId }).catch(() => [] as chrome.tabs.Tab[]);
    if (sequence === this.sequence) this.set(tab);
  };
  private set(tab: chrome.tabs.Tab | undefined) {
    if (this.disposed) return;
    const label = assistantShareablePage(tab?.url), address = tab?.url ? assistantPageAddress(tab.url) : undefined;
    const next = tab?.id !== undefined && label && address && this.windowId !== undefined ? { tabId: tab.id, windowId: this.windowId, address, label, mail: assistantPageIsMail(address) } : undefined;
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next; this.changed();
  }
}
