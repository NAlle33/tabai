import { modelContinuation, setContinuationBusy } from './assistant-model-continuation';
import { node } from './module-views';
import { button, field, icon, iconButton, popover, type AssistantAction, type IconName } from './assistant-controls';
import { ASSISTANT_WEB_ACTIVITY_HEADING, assistantChatModels, type AssistantChatView, type AssistantChatMessage } from '../../shared/assistant-chat';
import { assistantCompareAmount, assistantCompareTotal, type AssistantChatCompare } from '../../shared/assistant-chat';
import { AssistantChatSettings, assistantBackends, assistantEuros as euros, assistantModelName, assistantPrivacy } from './assistant-chat-settings';
import { AssistantChatFiles, renderChatFile } from './assistant-chat-files';
import { AssistantActiveTab, assistantReadPage, type AssistantActivePage } from './assistant-page-share';
import { assistantLinkQuestion, assistantPageAddress, assistantPageFile, assistantPageIsMail, assistantSelectionFile, assistantShareablePage } from '../../shared/assistant-page';
import { watchAssistantPanelRequests, type AssistantPanelRequest } from './assistant-context-menu';
import type { AssistantWatchView } from '../../shared/assistant-services';
import { AssistantApprovalPreviews, type AssistantPreviewFetch } from './assistant-approval-preview';

let sequence = 0;
type ModuleQuestion = NonNullable<AssistantChatMessage['module']> & { conversationId: string };
export interface AssistantChatHooks {
  /** Shows Mejl: its list after a finished check, otherwise the task's check. */
  showMail: (target: 'inbox' | 'run') => void;
  /** Leaves another mode for the conversation; false when a draft could not be saved. */
  showChat: () => Promise<boolean>;
  showTools: () => void;
  openModule: (id: string, runId?: string) => void;
  beforeNavigate: () => Promise<boolean>;
  openSettings: (page: 'accounts' | 'models') => void;
  /** Opens the list of watches from the fixed row in the conversation list. */
  showWatches: () => void;
  showRoutines?: () => void;
  showCase?: (id: string) => void;
  /** Fetches a piece of an approval card's image; without it a card says that it has no image. */
  preview?: AssistantPreviewFetch;
  /**
   * Sends one step of an action the card already shows, such as a chunk of an upload, through the
   * host's queue without marking the card busy, redrawing the view or starting a poll. Without it
   * such steps go as ordinary actions.
   */
  quiet?: AssistantAction;
}
const taskLabels = { running: 'Arbetar', waiting: 'Väntar på dig', review: 'Klart', paused: 'Pausat', failed: 'Kunde inte slutföras' };
/** "2 svar att godkänna · 1 behöver ditt svar · 5 för kännedom", the same words as the rows in Mejl. */
function taskCounts(counts: NonNullable<NonNullable<AssistantChatMessage['task']>['counts']>) {
  const parts = [counts.replies ? `${counts.replies} svar att godkänna` : '', counts.needsYou ? `${counts.needsYou} behöver ditt svar` : '', counts.info ? `${counts.info} för kännedom` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Inget väntar på dig';
}
// Messages saved before web activity became a typed list carry it in their text.
const legacyWebActivity = `${ASSISTANT_WEB_ACTIVITY_HEADING}\n`;
/** "08.00": the next run in the user's time zone, as the row says it; a comparison card writes "08:00". */
function clock(value: string, timezone: string, separator = '.') {
  const format = (zone?: string) => Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  let parts: Record<string, string>;
  try { parts = format(timezone); } catch { parts = format(); }
  return `${parts.hour}${separator}${parts.minute}`;
}
/** "2 aktiva · nästa kl. 08.00", "Pausade" while nothing can run, or that none exist yet. */
export function assistantWatchSummary(watches: AssistantWatchView[], timezone: string) {
  if (!watches.length) return 'Inga ännu';
  const active = watches.filter(watch => watch.enabled && !watch.paused);
  if (!active.length) return 'Pausade';
  const next = active.map(watch => watch.nextRunAt).filter((value): value is string => !!value).sort()[0];
  return `${active.length} ${active.length === 1 ? 'aktiv' : 'aktiva'}${watches.some(watch => watch.running) ? ' · körs nu' : next ? ` · nästa kl. ${clock(next, timezone)}` : ''}`;
}
/** The newest result that found what its watch looks for. */
const latestHit = (watches: AssistantWatchView[]) => watches.map(watch => watch.lastResult?.status === 'ok' && watch.lastResult.changed ? watch.lastResult.at : '').sort().at(-1) || '';
function greeting() { const hour = new Date().getHours(); return hour >= 5 && hour < 10 ? 'God morgon' : hour >= 18 ? 'God kväll' : 'Hej'; }

export class AssistantChatPanel {
  readonly element = node('section', '', 'assistant-chat');
  readonly settings: AssistantChatSettings;
  private view?: AssistantChatView;
  private namespace = `chat-${++sequence}`;
  private thread = node('section', '', 'assistant-chat-thread');
  private empty = node('div', '', 'assistant-chat-empty');
  private emptyPrivacy = node('p', '', 'muted assistant-chat-privacy');
  private quick = node('div', '', 'assistant-quick');
  private quickHint = node('p', '', 'muted assistant-quick-hint');
  private log = node('div', '', 'assistant-chat-log');
  private logInner = node('div', '', 'assistant-chat-log-inner');
  private announcer = node('p', '', 'visually-hidden');
  private composer = node('form', '', 'assistant-chat-composer');
  private chips = node('div', '', 'assistant-chat-chips');
  private context = node('div', '', 'assistant-chat-context');
  private replyContext = node('div', '', 'assistant-chat-reply-context');
  private input = field('Ditt meddelande', 'chat-message', '', true, this.namespace);
  private status = node('p', '', 'muted assistant-chat-status');
  private send = node('button', '', 'primary assistant-send');
  private stop = button('', () => void this.act('correct', { action: 'chat-stop' }), 'assistant-stop');
  private plus = iconButton('plus', 'Bifoga filer eller öppna lokala verktyg', () => {}, 'assistant-plus');
  private plusMenu = node('div', '', 'assistant-menu assistant-plus-menu');
  private attach = button('', () => { this.plusPopover.close(); this.files.openPicker(); }, 'assistant-menu-item');
  private tools = button('', () => { this.plusPopover.close(); this.hooks.showTools(); }, 'assistant-menu-item');
  private plusPopover: { close: () => void };
  private modelButton = node('button', '', 'assistant-model-trigger');
  private modelLabel = node('span', '', 'assistant-model-name');
  private modelMenu = node('div', '', 'assistant-menu assistant-model-menu');
  private modelPopover: { close: () => void };
  private modelSaving = false;
  private clear = button('', () => void this.newConversation(), 'assistant-conversation-new');
  private conversations = node('div', '', 'assistant-conversation-list');
  private searchResults = node('section', '', 'assistant-local-search-results');
  private searchKey = '';
  private focusRequest?: string;
  private search = field('Sök sparat', 'conversation-search', '', false, this.namespace);
  private conversationContent = node('div', '', 'assistant-conversation-content');
  private sidebar = node('nav', '', 'assistant-conversation-sidebar');
  private drawer = node('dialog', '', 'assistant-conversation-drawer');
  private drawerReturn?: HTMLElement;
  private restoreDrawerFocus = true;
  private replyTarget?: ModuleQuestion;
  private replyContextKey = '';
  private drafts = new Map<string, string>();
  private scroll = new Map<string, number>();
  private messageNodes = new Map<string, { element: HTMLElement; key: string }>();
  private announced = new Set<string>();
  private conversationKey = '';
  private activeId?: string;
  private submitting = false;
  private hostBusy = false;
  private mailReady = true;
  private files: AssistantChatFiles;
  private activeTab: AssistantActiveTab;
  private share = node('div', '', 'assistant-page-share');
  private shareAddress = node('span', '', 'assistant-page-share-address');
  private shareButton = button('Dela', () => void this.sharePage(), 'quiet assistant-page-share-button');
  private shareMail = node('span', 'Mejlen hanteras i Mejl', 'muted assistant-page-share-mail');
  /** Tabs being read right now: one tab that hangs never holds Dela for the others. */
  private sharing = new Set<number>();
  private timezone = 'Europe/Stockholm';
  private watchEntry = button('', () => this.openWatches(), 'assistant-watch-entry');
  private watchDetail = node('span', '', 'assistant-watch-entry-detail');
  private watchMarker = node('span', '', 'assistant-watch-marker');
  /** The newest hit the user has seen in the list; kept in this panel's memory only. */
  private watchesSeenAt = '';
  private searchTimer?: ReturnType<typeof setTimeout>;
  /** The latest query whose pause in typing ended while the card was busy; it runs when the card is free. */
  private queuedSearch?: string;
  /** The status the view itself gives the line; an action's message stays until this changes. */
  private viewStatus?: string;
  /** The line shows a success message, which the next action lets go. */
  private success = false;
  private act: AssistantAction;
  private media = window.matchMedia('(min-width: 768px)');
  private previews: AssistantApprovalPreviews;
  private stopRequests: () => void;
  private onMedia = () => { if (this.media.matches && this.drawer.open && !this.element.closest('[hidden]')) this.drawer.close(); else this.placeConversations(); };
  constructor(act: AssistantAction, private hooks: AssistantChatHooks) {
    // A success message is about the action before it: the next action, also one on a file row, lets it go.
    this.act = (operation, input) => { if (this.success) { this.success = false; this.status.textContent = ''; } return act(operation, input); };
    this.settings = new AssistantChatSettings(act);
    this.files = new AssistantChatFiles(this.composer, this.act, () => this.controls(), hooks.quiet);
    this.activeTab = new AssistantActiveTab(() => this.renderShare());
    this.previews = new AssistantApprovalPreviews(hooks.preview);
    this.sidebar.setAttribute('aria-label', 'Dina samtal');
    this.drawer.setAttribute('aria-label', 'Dina samtal');
    const head = node('div', '', 'assistant-conversation-head'), close = iconButton('close', 'Stäng samtalslistan', () => this.drawer.close(), 'assistant-drawer-close');
    head.append(node('h3', 'Samtal'), close);
    this.clear.append(icon('compose'), node('span', 'Nytt samtal'));
    this.search.input.type = 'search'; this.search.input.maxLength = 200; this.search.input.placeholder = 'Sök chatt, mejl och bilagor'; this.searchResults.setAttribute('aria-label', 'Lokala sökträffar'); this.searchResults.setAttribute('aria-live', 'polite'); this.searchResults.hidden = true;
    this.search.wrapper.classList.add('assistant-conversation-search'); this.search.wrapper.querySelector('label')!.classList.add('visually-hidden');
    this.search.input.oninput = () => {
      clearTimeout(this.searchTimer); this.queuedSearch = undefined; const query = this.search.input.value.trim();
      this.searchResults.hidden = !query; this.searchResults.replaceChildren(node('p', query ? 'Söker i sparade uppgifter på den här datorn…' : '', 'muted')); this.searchKey = '';
      this.searchTimer = setTimeout(() => this.runSearch(query), 200);
    };
    const watchText = node('span', '', 'assistant-watch-entry-text'); watchText.append(node('span', 'Bevakningar', 'assistant-watch-entry-title'), this.watchDetail);
    this.watchMarker.append(node('span', 'Ny träff', 'visually-hidden')); this.watchMarker.hidden = true;
    this.watchEntry.append(icon('globe'), watchText, this.watchMarker); this.watchEntry.hidden = true;
    this.conversationContent.append(head, this.clear, this.search.wrapper, this.searchResults, this.watchEntry, this.conversations);
    this.media.addEventListener('change', this.onMedia); this.placeConversations();
    this.drawer.addEventListener('close', () => { this.placeConversations(); if (this.restoreDrawerFocus) this.drawerReturn?.focus({ preventScroll: true }); this.restoreDrawerFocus = true; });

    this.thread.setAttribute('aria-label', 'Samtal');
    this.empty.append(node('h3', '', 'assistant-chat-greeting'), this.quick, this.quickHint, this.emptyPrivacy);
    this.renderQuick();
    this.log.setAttribute('role', 'log'); this.log.setAttribute('aria-label', 'Samtal med Tabai'); this.log.setAttribute('aria-live', 'off'); this.log.tabIndex = 0;
    this.log.append(this.logInner);
    this.announcer.setAttribute('aria-live', 'polite');

    this.composer.setAttribute('aria-label', 'Skriv till Tabai');
    this.input.wrapper.classList.add('assistant-chat-input'); this.input.wrapper.querySelector('label')!.classList.add('visually-hidden');
    this.input.input.maxLength = 8000; this.input.input.rows = 1; this.input.input.placeholder = 'Fråga något eller beskriv vad du vill få gjort…';
    this.input.input.oninput = () => { if (this.activeId) this.drafts.set(this.activeId, this.input.input.value); this.grow(); this.controls(); };
    this.input.input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!this.send.disabled) this.composer.requestSubmit(); } };
    this.send.type = 'submit'; this.send.setAttribute('aria-label', 'Skicka'); this.send.title = 'Skicka (Enter)'; this.send.append(icon('send'), node('span', 'Skicka', 'visually-hidden'));
    this.stop.setAttribute('aria-label', 'Stoppa svar'); this.stop.title = 'Stoppa svar'; this.stop.append(icon('stop'), node('span', 'Stoppa svar', 'visually-hidden'));
    this.status.setAttribute('role', 'status');

    this.attach.append(icon('attach'), this.menuText('Bifoga filer', 'PDF, Word, text eller bilder · högst 5 filer, 10 MB per fil'));
    this.tools.append(icon('tools'), this.menuText('Lokala verktyg', 'Starta ett installerat verktyg eller granska en körning'));
    this.tools.hidden = true; this.plusMenu.setAttribute('aria-label', 'Lägg till');
    this.plusMenu.append(this.attach, this.tools);
    this.plusPopover = popover(this.plus, this.plusMenu, () => this.controls());
    this.modelButton.type = 'button'; this.modelButton.append(this.modelLabel, icon('down'));
    this.modelMenu.setAttribute('aria-label', 'Chattmodell');
    this.modelPopover = popover(this.modelButton, this.modelMenu);
    this.buildModelMenu();

    const toolbar = node('div', '', 'assistant-chat-toolbar'); toolbar.append(this.plus, this.modelButton, node('span', '', 'assistant-spacer'), this.stop, this.send);
    this.chips.append(this.context, this.replyContext);
    // Nothing is read from the page before the user taps Dela; until then only its address shows.
    const shareText = node('span', '', 'assistant-page-share-text'); shareText.append(node('span', 'Den här sidan', 'assistant-page-share-label'), this.shareAddress);
    this.share.append(icon('globe'), shareText, this.shareButton, this.shareMail); this.share.hidden = true;
    this.composer.append(this.share, this.chips, this.files.element, this.input.wrapper, toolbar, this.status);
    this.composer.onsubmit = event => { event.preventDefault(); void this.submit(); };
    this.thread.append(this.empty, this.log, this.announcer, this.composer, this.plusMenu, this.modelMenu);
    this.element.append(this.sidebar, this.thread, this.drawer, this.previews.dialog); this.controls();
    this.stopRequests = watchAssistantPanelRequests(this.element, request => void this.panelRequest(request));
  }
  /** The conversation's name for the panel header. */
  get title() { return this.view?.title || 'Nytt samtal'; }
  dispose() { clearTimeout(this.searchTimer); this.media.removeEventListener('change', this.onMedia); this.drawer.close(); this.files.dispose(); this.activeTab.dispose(); this.previews.dispose(); this.stopRequests(); }
  setTimezone(timezone: string) { this.timezone = timezone; }
  /** The list is open: every hit shown so far counts as seen. */
  watchesSeen() { const latest = latestHit(this.view?.watches ?? []); if (latest > this.watchesSeenAt) { this.watchesSeenAt = latest; this.renderWatchEntry(); } }
  private openWatches() { this.closeDrawerForChat(); this.hooks.showWatches(); }
  private renderWatchEntry() {
    const watches = this.view?.watches;
    this.watchEntry.hidden = !watches; if (!watches) return;
    // An unreadable watches.json lists none, which is not the same as having none.
    this.watchDetail.textContent = this.view?.watchesError ? 'Kunde inte läsas' : assistantWatchSummary(watches, this.timezone);
    const unseen = !this.view?.watchesError && latestHit(watches) > this.watchesSeenAt;
    this.watchMarker.hidden = !unseen; this.watchEntry.dataset.unseen = String(unseen);
  }
  private renderShare() {
    const page = this.activeTab.current, view = this.view;
    this.share.hidden = !page || !view || view.fileDrafts === undefined || !!view.unavailable || this.files.hasPage(page.address);
    if (!page) return;
    this.shareAddress.textContent = page.label; this.share.title = page.address;
    // Mail and calendar are read by Mejl under its own rules, never shared as a page.
    this.shareButton.hidden = page.mail; this.shareMail.hidden = !page.mail;
    this.shareButton.setAttribute('aria-label', `Dela sidan ${page.label} med chatten`);
    const blocked = this.files.blocked, reading = this.sharing.has(page.tabId);
    this.shareButton.textContent = reading ? 'Läser…' : 'Dela';
    this.block(this.shareButton, page.mail || reading || this.hostBusy || this.submitting || !!blocked);
    this.shareButton.title = blocked || 'Läser sidans titel, adress och den text som syns på sidan, och det du har markerat. Formulärfält, lösenord och dold text följer aldrig med. Inte heller text i redigerbara fält eller i rutor med rollen textbox, searchbox eller combobox, om du inte själv markerar den. En kodredigerare som visar texten i vanliga element bakom ett dolt textfält känns inte igen, och dess text följer med.';
  }
  /**
   * One read of the user's own tab per tap, then the chat's ordinary file upload;
   * nothing is retried. The page belongs to the conversation open at the tap: a read
   * that finishes after the user opened another conversation is dropped.
   */
  private async sharePage(page = this.activeTab.current, selection = false) {
    const conversationId = this.view?.id;
    if (!page || page.mail || !conversationId || this.sharing.has(page.tabId) || this.files.blocked || this.hostBusy) return;
    this.sharing.add(page.tabId); this.renderShare();
    try {
      const shared = await assistantReadPage(page);
      if (this.view?.id !== conversationId) { this.files.showError('Du bytte samtal medan sidan lästes, så den delades inte. Tryck Dela igen i det samtal där sidan ska finnas.'); return; }
      // Text the user types never joins the page text. With no page text left (the page is editable as a
      // whole, or its only text is in editors), only a selection the user made can follow.
      if (!shared.text.trim()) {
        if (!shared.selection.trim()) {
          this.say(shared.editable ? 'Hela sidan är ett redigerbart fält, så Tabai delar inte dess text. Markera det du vill dela och tryck Dela igen.'
            : 'Sidans text står i redigerbara fält, så Tabai delar den inte. Markera det du vill dela och tryck Dela igen.');
          return;
        }
        selection = true;
      }
      if (selection) {
        // Only the selection follows: the rest of the page's text was read with Dela's rules and stays here.
        const chosen = assistantSelectionFile(shared, this.timezone);
        if (!chosen) { this.files.showError('Ingen markerad text kunde läsas. Markera text på sidan, utanför formulärfält, och försök igen.'); return; }
        await this.files.addPage(new File([chosen.text], chosen.name, { type: 'text/plain' }), { url: chosen.address, truncated: chosen.truncated, selection: true });
        const attached = this.files.hasSelection(chosen.address);
        this.say(attached ? `${chosen.label} är bifogad. Skriv vad du vill veta och skicka.` : `${chosen.label} kunde inte bifogas. Se felet ovanför och försök igen.`, attached);
        return;
      }
      const file = assistantPageFile(shared, this.timezone);
      await this.files.addPage(new File([file.text], file.name, { type: 'text/plain' }), { url: file.address, truncated: file.truncated });
      // A share whose upload failed is shown as failed, never as attached.
      const attached = this.files.hasPage(file.address);
      this.say(attached ? `Sidan ${file.label} är bifogad. Skriv vad du vill veta och skicka.` : `Sidan ${file.label} kunde inte bifogas. Se felet ovanför och tryck Dela igen.`, attached);
    } catch (error) { this.files.showError(error instanceof Error ? error.message : 'Sidan kunde inte delas.'); }
    finally { this.sharing.delete(page.tabId); this.renderShare(); }
  }
  /**
   * What the user chose in Chrome's context menu or with the Dela shortcut. The page is
   * read with Dela's own rules, and every reason it cannot go ahead is said here.
   */
  private async panelRequest(request: AssistantPanelRequest) {
    if (!await this.hooks.showChat()) return;
    if (request.kind === 'failed') { this.files.showError(request.message); return; }
    if (request.kind === 'link') {
      const question = assistantLinkQuestion(request.url);
      if (!question) { this.files.showError('Bara länkar till vanliga webbsidor kan frågas om.'); return; }
      // An unsent draft stays: the question is added on a line of its own.
      const draft = this.input.input.value.replace(/\s+$/, '');
      this.fill(draft ? `${draft}\n${question}` : question); this.say('Frågan om länken står i rutan. Ingenting har hämtats; skicka när du vill.');
      return;
    }
    const address = assistantPageAddress(request.url), label = assistantShareablePage(request.url);
    if (!address || !label) { this.files.showError('Bara vanliga webbsidor kan delas, inte Chromes egna sidor, tilläggssidor eller lokala filer.'); return; }
    if (assistantPageIsMail(address)) { this.files.showError('Mejlen hanteras i Mejl.'); return; }
    const page: AssistantActivePage = { tabId: request.tabId, windowId: request.windowId, address, label, mail: false };
    const blocked = this.view?.unavailable || (this.hostBusy || this.submitting ? 'Tabai är upptagen. Vänta en stund och försök igen.' : '')
      || (this.sharing.has(page.tabId) ? 'Sidan läses redan.' : '') || this.files.blocked;
    if (blocked) { this.files.showError(blocked); return; }
    if (request.kind === 'page' && this.files.hasPage(address)) { this.say(`Sidan ${label} är redan bifogad.`); return; }
    await this.sharePage(page, request.kind === 'selection');
  }
  openConversations(returnFocus: HTMLElement) {
    this.drawerReturn = returnFocus;
    if (!this.drawer.open) { this.drawer.append(this.conversationContent); this.drawer.showModal(); }
    this.search.input.focus();
  }
  focusComposer() { this.input.input.focus({ preventScroll: true }); }
  /** Mail shortcuts need a saved account; without one they lead to the account settings. */
  setMailReady(ready: boolean) { if (ready !== this.mailReady) { this.mailReady = ready; this.renderQuick(); this.controls(); } }
  setToolsAvailable(available: boolean) { this.tools.hidden = !available; }
  private menuText(label: string, detail: string) { const text = node('span', '', 'assistant-menu-text'); text.append(node('span', label, 'assistant-menu-label'), node('span', detail, 'muted')); return text; }
  private placeConversations() { if (this.drawer.open) return; if (this.media.matches) this.sidebar.append(this.conversationContent); else this.drawer.append(this.conversationContent); }
  private closeDrawerForChat() { if (this.drawer.open) { this.restoreDrawerFocus = false; this.drawer.close(); } }
  private grow() { const input = this.input.input; input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, 192)}px`; }
  private block(control: HTMLButtonElement, blocked: boolean) { control.dataset.blocked = String(blocked); control.disabled = blocked; }
  setBusy(busy: boolean) {
    this.hostBusy = busy; this.files.setBusy(busy); this.controls();
    // A search kept while the card was busy goes out after the action that held it, in a task of its own.
    if (!busy && this.queuedSearch !== undefined) { const query = this.queuedSearch; this.queuedSearch = undefined; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.runSearch(query), 0); }
  }
  /** Runs a typed query, or keeps it (the latest only) while the card is busy and the host would refuse it. */
  private runSearch(query: string) {
    if (this.hostBusy) { this.queuedSearch = query; return; }
    void this.act('correct', { action: 'assistant-search', query });
  }
  private sendBlocked() { const missingKey = this.view?.model.startsWith('berget:') && !this.view.berget.configured; return !this.view || !!this.view.unavailable || !!missingKey || this.submitting || this.hostBusy || !!this.view.busy || this.caseTarget()?.messaging === 'busy'; }
  private controls() {
    this.logInner.querySelectorAll<HTMLDetailsElement>('.assistant-model-continuation').forEach(control => setContinuationBusy(control, this.hostBusy || this.submitting || !!this.view?.busy));
    const unavailable = !this.view || !!this.view.unavailable;
    this.block(this.send, this.sendBlocked() || this.files.pending || (!this.input.input.value.trim() && !this.files.hasFiles));
    this.send.hidden = !!this.view?.busy;
    this.block(this.stop, !this.view?.busy || this.submitting || this.hostBusy); this.stop.hidden = !this.view?.busy;
    this.block(this.clear, unavailable || this.submitting || this.hostBusy);
    this.block(this.attach, !!this.files.blocked); this.attach.title = this.files.blocked;
    this.block(this.modelButton, unavailable || this.modelSaving || this.hostBusy || !!this.view?.busy);
    this.modelMenu.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(radio => { radio.disabled = this.modelButton.disabled; });
    for (const control of this.quick.querySelectorAll<HTMLButtonElement>('button')) this.block(control, unavailable || (control.dataset.quick === 'task' && this.mailReady && (this.submitting || this.hostBusy)));
    this.conversations.querySelectorAll<HTMLButtonElement>('button').forEach(control => { control.disabled = this.submitting || this.hostBusy; });
    this.renderShare();
  }
  private renderQuick() {
    this.quick.replaceChildren();
    // The mail choices start the same task as Mejl's buttons, without a chat model turn.
    const choices: [IconName, string, string, 'task' | 'fill'][] = [['mail', 'Kolla mina mejl', 'check-mail', 'task'], ['task', 'Min dag', 'my-day', 'task'], ['compose', 'Förbered möte', 'Förbered mitt nästa möte: ', 'fill'], ['globe', 'Sök och sammanfatta', 'Sök på webben och sammanfatta: ', 'fill'], ['tag', 'Hitta billigast', 'Hitta billigast: ', 'fill']];
    for (const [name, label, value, kind] of choices) {
      const choice = button('', () => {
        if (kind === 'fill') { this.fill(value); return; }
        if (!this.mailReady) { this.hooks.openSettings('accounts'); return; }
        void this.startTask(value);
      });
      choice.dataset.quick = kind; if (kind === 'task') choice.dataset.quickTask = value; choice.append(icon(name), node('span', label));
      if (kind === 'task' && !this.mailReady) choice.title = 'Kräver ett mejlkonto';
      this.quick.append(choice);
    }
    this.quickHint.textContent = this.mailReady ? '' : 'Lägg till ett mejlkonto under Inställningar för att kolla mejl och din dag.';
  }
  private fill(text: string) {
    const input = this.input.input; input.value = text; if (this.activeId) this.drafts.set(this.activeId, text);
    this.grow(); this.controls(); input.focus(); input.setSelectionRange(text.length, text.length);
  }
  private buildModelMenu() {
    this.modelMenu.append(node('p', 'Chattmodell', 'assistant-menu-title'));
    for (const [backend, label, privacy] of assistantBackends) {
      const group = node('fieldset', '', 'assistant-model-group'); group.append(node('legend', label), node('p', privacy, 'muted'));
      for (const choice of assistantChatModels.filter(choice => choice.backend === backend)) {
        const option = node('label', '', 'assistant-model-option'), radio = node('input');
        radio.type = 'radio'; radio.name = `${this.namespace}-model`; radio.value = choice.id;
        radio.onchange = () => void this.chooseModel(choice.id);
        option.append(radio, node('span', assistantModelName(choice.id))); group.append(option);
      }
      this.modelMenu.append(group);
    }
    this.modelMenu.append(button('Modeller och anslutningar', () => { this.modelPopover.close(); this.hooks.openSettings('models'); }, 'assistant-menu-link'));
  }
  private async chooseModel(model: string) {
    if (!this.view || model === this.view.model) { this.modelPopover.close(); return; }
    this.modelSaving = true; this.controls();
    const ok = await this.act('correct', { action: 'chat-model', model });
    this.modelSaving = false; this.say(ok ? `Chattmodellen är ${assistantModelName(model)}. ${assistantPrivacy(model)}` : 'Modellvalet kunde inte sparas.', ok);
    this.modelPopover.close(); if (this.view) this.renderModel(this.view); this.controls();
  }
  private renderModel(view: AssistantChatView) {
    const name = assistantModelName(view.model), full = assistantChatModels.find(model => model.id === view.model)?.label || view.model;
    this.modelLabel.textContent = name; this.modelButton.setAttribute('aria-label', `Chattmodell: ${full}. Byt modell`); this.modelButton.title = assistantPrivacy(view.model);
    if (!this.modelSaving) this.modelMenu.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(radio => { radio.checked = radio.value === view.model; });
    this.emptyPrivacy.textContent = `${assistantPrivacy(view.model)} Utskick kräver ditt godkännande på svarskortet.`;
  }
  /** The status the view itself gives the line: why the chat is unavailable, what the run is doing, or nothing. */
  private ownStatus(view: AssistantChatView) { return view.unavailable || view.activity?.message || (view.busy ? 'Agenten arbetar. Du kan stoppa svaret.' : ''); }
  /**
   * An action's own message on the status line. A success stays until the view has a status of its own to
   * show, so "Meddelandet är skickat." never hides that the agent is working, or until the next action; the
   * poll that follows every action must not wipe it. Any other message stays until the view's own status
   * changes, so that poll does not wipe what failed either.
   */
  private say(text: string, succeeded = false) {
    this.status.textContent = text; this.success = succeeded;
    // After a success the line counts as holding no status of the view: any status of its own replaces it.
    this.viewStatus = !this.view ? undefined : succeeded ? '' : this.ownStatus(this.view);
  }
  update(view?: AssistantChatView) {
    this.view = view; this.settings.update(view); this.files.update(view);
    if (!view) { this.viewStatus = undefined; this.status.textContent = 'Chatten kräver en uppdaterad Tabai-server.'; this.empty.hidden = false; this.log.hidden = true; this.controls(); return; }
    const id = view.id;
    const changedConversation = id !== this.activeId;
    if (changedConversation) {
      if (this.activeId) { this.drafts.set(this.activeId, this.input.input.value); this.scroll.set(this.activeId, this.log.scrollTop); }
      this.activeId = id; this.input.input.value = this.drafts.get(id) || ''; this.grow(); this.replyTarget = undefined; this.renderReplyContext();
      this.messageNodes.clear(); this.logInner.replaceChildren(); this.log.scrollTop = this.scroll.get(id) || 0;
      this.announced = new Set(view.messages.filter(message => message.role === 'assistant' && message.status === 'complete').map(message => message.id));
    }
    this.renderModel(view);
    this.renderSearch(view);
    this.empty.querySelector('.assistant-chat-greeting')!.textContent = `${greeting()}! Vad vill du få gjort?`;
    this.context.replaceChildren();
    if (view.context) {
      const chip = node('div', '', 'assistant-context-chip'); chip.title = 'Samtalet gäller det här underlaget';
      chip.append(node('span', `${view.context.kind === 'item' ? 'Mejl' : 'Ärende'}: ${view.context.label}`), iconButton('close', 'Lämna sammanhanget och starta ett nytt samtal', () => void this.newConversation(), 'assistant-chip-close'));
      this.context.append(chip);
    }
    // The view's own status replaces an action's message when it changes or when the conversation does;
    // after a success, as soon as the view has one.
    const viewStatus = this.ownStatus(view);
    if (changedConversation || viewStatus !== this.viewStatus) { this.viewStatus = viewStatus; this.status.textContent = viewStatus; this.success = false; }
    this.renderConversations(view); this.renderWatchEntry(); this.renderMessages(view); this.renderReplyContext();
    if (changedConversation) this.log.scrollTop = this.scroll.get(id) ?? this.log.scrollHeight;
    this.controls();
  }
  private renderConversations(view: AssistantChatView) {
    const key = JSON.stringify([view.id, view.activeConversationId, view.conversations, view.query]); if (key === this.conversationKey) return; this.conversationKey = key;
    const records = view.conversations || [{ id: view.id, title: view.title || 'Samtal', updatedAt: '', count: view.messages.length, busy: view.busy }];
    this.conversations.replaceChildren();
    if (!records.length) this.conversations.append(node('p', view.query ? `Inga samtal matchar ”${view.query}”.` : 'Dina samtal visas här när du börjar chatta.', 'muted'));
    for (const record of records) {
      const row = node('article', '', 'assistant-conversation-row'); row.dataset.conversationId = record.id;
      const select = button('', async () => {
        if (!await this.hooks.beforeNavigate()) return;
        if (await this.act('correct', { action: 'chat-select', conversationId: record.id })) { this.closeDrawerForChat(); if (await this.hooks.showChat()) this.focusComposer(); }
      }, 'assistant-conversation-select');
      select.append(node('span', record.title, 'assistant-conversation-title')); select.title = record.title;
      if (record.busy) select.append(node('span', 'Arbetar', 'assistant-conversation-busy'));
      if (record.id === this.activeId) select.setAttribute('aria-current', 'page');
      const more = iconButton('more', `Fler val för ”${record.title}”`, () => {}, 'assistant-conversation-more');
      const menu = node('div', '', 'assistant-menu assistant-conversation-menu');
      menu.append(button('Byt namn', async () => { const title = window.prompt('Samtalets namn', record.title)?.trim(); if (title) await this.act('correct', { action: 'chat-rename', conversationId: record.id, title: title.slice(0, 120) }); }, 'assistant-menu-item'));
      menu.append(button('Rensa meddelanden', async () => {
        if (!window.confirm(`Rensa meddelandena i ”${record.title}”? Bifogade filer i samtalet, även kvitton, tas också bort. Samtalet och sparade uppdrag behålls.`)) return;
        // An older host ignores the id and clears the selected conversation: select this one first there.
        if (record.id !== this.view?.id && !this.view?.clearById && !await this.act('correct', { action: 'chat-select', conversationId: record.id })) return;
        await this.act('correct', { action: 'chat-clear', conversationId: record.id });
      }, 'assistant-menu-item'));
      menu.append(button('Radera samtal', async () => { if (window.confirm(`Radera samtalet ”${record.title}”? Meddelandena tas bort. Sparade mejl, ärenden och uppdrag finns kvar.`) && await this.hooks.beforeNavigate()) await this.act('correct', { action: 'chat-delete', conversationId: record.id }); }, 'assistant-menu-item assistant-menu-danger'));
      const controls = popover(more, menu);
      menu.querySelectorAll('button').forEach(item => item.addEventListener('click', () => controls.close()));
      row.append(select, more, menu); this.conversations.append(row);
    }
  }
  private renderMessages(view: AssistantChatView) {
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    this.empty.hidden = !!view.messages.length; this.log.hidden = !view.messages.length;
    if (!view.messages.length) { this.logInner.replaceChildren(); this.messageNodes.clear(); return; }
    const latestUser = view.messages.filter(entry => entry.role === 'user').at(-1)?.id;
    const continued = new Set(view.messages.map(entry => entry.continuation?.from).filter(Boolean));
    for (const message of view.messages) {
      const key = JSON.stringify([message, message.continuation ? [view.busy, latestUser, continued.has(message.id)] : false, view.focusMessageId === message.id ? view.focusAttachment : undefined]); let record = this.messageNodes.get(message.id);
      if (!record) { record = { element: node('article'), key: '' }; this.messageNodes.set(message.id, record); this.logInner.append(record.element); }
      if (record.key === key) continue;
      record.key = key; const card = record.element; card.className = `assistant-chat-message assistant-chat-${message.role}`; card.dataset.messageId = message.id;
      const choice = assistantChatModels.find(model => model.id === message.model);
      const author = message.role === 'user' ? 'Du' : message.role === 'system' ? 'Tabai' : choice?.label ?? message.model ?? 'Tabai';
      // Cards, tasks and web activity carry their own heading; a bare "Tabai" label adds nothing.
      const legacy = message.role === 'system' && message.text.startsWith(legacyWebActivity);
      const quiet = message.role === 'user' || (message.role === 'system' && (!!message.lists || !!message.card || !!message.task || !!message.module || !!message.compare || legacy || (!!message.webActivity && !message.text)));
      card.replaceChildren(node('p', author, `assistant-chat-author${quiet ? ' visually-hidden' : ''}`));
      if (legacy) this.renderWebActivity(card, message.text.slice(legacyWebActivity.length).split('\n').map(line => line.replace(/^•\s*/, '').trim()));
      else if (message.text || message.status === 'pending') card.append(node('p', message.text || 'Väntar på svar…', 'assistant-chat-text'));
      if (message.webActivity) this.renderWebActivity(card, message.webActivity);
      for (const file of message.files ?? []) {
        card.append(renderChatFile(file));
        if (view.focusMessageId === message.id && view.focusAttachment?.id === file.id) card.append(node('p', `Sökträff i ${file.name}: ${view.focusAttachment.snippet}`, 'notice assistant-attachment-search-hit'));
      }
      if (message.status === 'failed' || message.status === 'interrupted') card.dataset.failed = 'true'; else delete card.dataset.failed;
      if (message.status === 'interrupted') card.append(node('p', 'Svaret är stoppat.', 'muted'));
      if (message.card) this.renderIntent(card, message.card);
      for (const list of message.lists ?? []) this.renderSavedList(card, list);
      if (message.role === 'assistant' && message.status !== 'pending' && message.continuation?.effect === 'none' && message.continuation.userId === latestUser && !continued.has(message.id)) {
        card.append(modelContinuation(message.model ?? view.model, view.busy, model => this.act('correct', { action: 'chat-continue', conversationId: view.id, replyId: message.id, messageId: crypto.randomUUID(), model })));
      }
      if (message.compare) this.renderCompare(card, message.id, message.compare);
      if (message.module) this.renderModule(card, message.module);
      if (message.task) this.renderTask(card, message.task);
      if (message.usage) card.append(node('p', `${message.usage.inputTokens.toLocaleString('sv-SE')} in / ${message.usage.outputTokens.toLocaleString('sv-SE')} ut token${message.usage.costEur === undefined ? '' : ` · ${euros(message.usage.costEur)}`}`, 'muted assistant-chat-usage'));
      if (message.role === 'assistant' && message.status === 'complete' && !this.announced.has(message.id)) { this.announced.add(message.id); this.announcer.textContent = `Nytt svar från ${author}.`; }
    }
    // A module card moves down when its dialogue grows, so existing nodes follow the data's order.
    const ordered = view.messages.flatMap(message => this.messageNodes.get(message.id)?.element ?? []);
    if (ordered.some((element, index) => this.logInner.children[index] !== element)) this.logInner.append(...ordered);
    for (const [id, record] of this.messageNodes) if (!view.messages.some(message => message.id === id)) { record.element.remove(); this.messageNodes.delete(id); }
    if (nearBottom && !this.element.closest('[hidden]')) this.log.scrollTop = this.log.scrollHeight;
    if (view.focusMessageId && view.focusRequestId !== this.focusRequest) {
      const target = this.messageNodes.get(view.focusMessageId)?.element;
      if (target) { this.focusRequest = view.focusRequestId; target.tabIndex = -1; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
    }
  }
  private renderSearch(view: AssistantChatView) {
    const search = view.search, typed = this.search.input.value.trim();
    this.searchResults.hidden = !typed;
    this.conversations.hidden = !!typed;
    if (!search || search.query !== typed || !typed) return;
    const key = JSON.stringify(search); if (key === this.searchKey) return; this.searchKey = key;
    this.searchResults.replaceChildren(node('h3', `${search.results.length} lokala träffar`), node('p', 'Sökningen läser sparade uppgifter på datorn. Ingen modell eller molntjänst används.', 'muted'));
    if (!search.results.length) this.searchResults.append(node('p', search.nextOffset === undefined && !search.warnings.length ? 'Inga sparade uppgifter matchar sökningen.' : 'Inga träffar i den genomgångna delen.', 'muted'));
    const names = { chat: 'Chatt', mail: 'Mejl', case: 'Ärende', attachment: 'Bilaga' };
    for (const result of search.results) {
      const open = button('', async () => {
        if (!await this.hooks.beforeNavigate()) return;
        if (!await this.act('correct', { action: 'assistant-search-open', kind: result.kind, id: result.id, ...(result.conversationId ? { conversationId: result.conversationId } : {}) })) return;
        if (result.kind === 'case') this.hooks.showCase?.(result.id);
        else if (result.kind === 'chat' || result.kind === 'attachment') { this.closeDrawerForChat(); await this.hooks.showChat(); }
      }, 'assistant-local-search-result');
      open.dataset.searchKind = result.kind;
      open.append(node('strong', result.title), node('span', `${names[result.kind]} · ${new Date(result.date).toLocaleDateString('sv-SE')}`, 'muted'), node('span', result.snippet, 'assistant-search-snippet'));
      this.searchResults.append(open);
    }
    for (const warning of search.warnings) this.searchResults.append(node('p', warning, 'notice'));
    if (search.nextOffset !== undefined) this.searchResults.append(button('Sök vidare i fler sparade källor', () => void this.act('correct', { action: 'assistant-search', query: search.query, offset: String(search.nextOffset) }), 'quiet'));
  }
  private renderSavedList(target: HTMLElement, list: NonNullable<AssistantChatMessage['lists']>[number]) {
    const root = node('section', '', 'assistant-saved-list'); root.dataset.savedList = list.kind;
    const title = list.kind === 'watches' ? 'Bevakningar' : 'Rutiner';
    root.append(node('h3', `${title} · ${list.rows.length}`));
    if (list.error) root.append(node('p', list.error, 'module-error'));
    else if (!list.rows.length) root.append(node('p', `Du har inga sparade ${title.toLocaleLowerCase('sv-SE')} ännu.`, 'muted'));
    for (const row of list.rows) {
      const item = node('div', '', 'assistant-saved-list-row'); item.dataset.savedId = row.id;
      const content = node('div'); content.append(node('strong', row.title), node('p', `${row.status ?? (row.enabled ? 'Aktiv' : 'Pausad')} · ${row.detail}`, 'muted'));
      if (row.at) content.append(node('time', new Date(row.at).toLocaleString('sv-SE'), 'muted'));
      const actions = node('div', '', 'assistant-actions');
      actions.append(button('Öppna', () => list.kind === 'watches' ? this.hooks.showWatches() : this.hooks.showRoutines?.(), 'quiet'));
      const pause = button(row.enabled ? 'Pausa' : 'Återuppta', async () => {
        pause.disabled = true;
        try { await this.act('correct', { action: list.kind === 'watches' ? 'watch-pause' : 'routine-pause', [list.kind === 'watches' ? 'watchId' : 'routineId']: row.id, paused: String(row.enabled), listRevision: list.revision }); }
        finally { pause.disabled = !!list.error; }
      }, 'quiet'); pause.disabled = !!list.error;
      actions.append(pause); item.append(content, actions); root.append(item);
    }
    root.append(node('p', 'Listan och knapparnas status hämtas från dina sparade uppgifter.', 'muted'));
    target.append(root);
  }
  private renderWebActivity(target: HTMLElement, lines: string[]) {
    const steps = lines.filter(Boolean);
    const activity = node('details', '', 'assistant-chat-web-activity'), summary = node('summary'), list = node('ol');
    summary.append(icon('globe'), node('span', `Webbaktivitet · ${steps.length} steg`));
    for (const step of steps) list.append(node('li', step));
    activity.append(summary, list); target.append(activity);
  }
  private renderTask(target: HTMLElement, task: NonNullable<AssistantChatMessage['task']>) {
    const started = target.querySelector('.assistant-chat-text');
    if (started?.textContent === `Startat: ${task.label}`) started.remove();
    const row = node('div', '', 'assistant-chat-task'), text = node('p', '', 'assistant-chat-task-text');
    text.append(node('strong', task.label));
    const model = task.model ? assistantChatModels.find(choice => choice.id === task.model)?.label ?? task.model : '';
    const detail = [task.status ? taskLabels[task.status] : 'Startat', model].filter(Boolean).join(' · ');
    text.append(node('span', detail, 'muted'));
    // A finished check leads to the list; any other state to the check itself.
    const counts = task.status === 'review' ? task.counts : undefined;
    if (counts) { row.dataset.counts = 'true'; text.append(node('span', taskCounts(counts), 'assistant-chat-task-counts')); }
    const open = button('Visa i Mejl', () => this.hooks.showMail(counts ? 'inbox' : 'run'), 'quiet assistant-chat-task-open'); open.dataset.mailTarget = counts ? 'inbox' : 'run';
    row.append(icon('task'), text, open);
    target.append(row);
  }
  private renderIntent(target: HTMLElement, proposal: NonNullable<AssistantChatMessage['card']>) {
    const card = node('section', '', 'assistant-chat-proposal'); card.dataset.chatCardId = proposal.id;
    card.append(node('h3', proposal.title), node('p', proposal.detail, 'module-summary'), node('p', { pending: 'Väntar på ditt godkännande', applying: 'Verkställer…', applied: 'Genomfört', failed: 'Kunde inte genomföras', uncertain: 'Utfallet är osäkert – kontrollera innan du försöker igen', dismissed: 'Avvisat' }[proposal.status], 'assistant-card-status'));
    card.dataset.status = proposal.status;
    // The image of what would be clicked sits right under the title, before the card's facts.
    if (proposal.intent.kind === 'web-action') card.insertBefore(this.previews.render(proposal.intent), card.children[1]);
    if (proposal.warning) card.append(node('p', proposal.warning, 'notice assistant-card-warning'));
    if (proposal.error) card.append(node('p', proposal.error, 'module-error'));
    const web = proposal.intent.kind === 'web-action', watch = proposal.intent.kind === 'watch';
    if (web) card.dataset.webAction = 'true';
    if (watch) card.dataset.watchCard = 'true';
    if (proposal.intent.kind.startsWith('watch-')) card.dataset.watchChange = proposal.intent.kind;
    if (proposal.intent.kind.startsWith('routine-')) card.dataset.routineCard = proposal.intent.kind;
    // A routine card's button names what it does to the routine.
    const routine = proposal.intent.kind === 'routine-create' ? 'Spara rutinen' : proposal.intent.kind === 'routine-pause' ? proposal.intent.paused ? 'Pausa rutinen' : 'Återuppta rutinen'
      : proposal.intent.kind === 'routine-delete' ? 'Ta bort rutinen' : undefined;
    if (proposal.status === 'pending') {
      const actions = node('div', '', 'assistant-actions');
      // A web step is the user's own purchase or submission, and a watch runs on its own: the buttons say so.
      actions.append(button(routine ?? (web || watch ? 'Godkänn' : 'Godkänn ändringen'), () => void this.act('correct', { action: 'chat-confirm', cardId: proposal.id }), 'primary'), button(web ? 'Avböj' : watch || routine ? 'Avvisa' : 'Avvisa förslaget', () => void this.act('correct', { action: 'chat-dismiss', cardId: proposal.id })));
      if (web) actions.append(button('Visa sidan', () => void this.act('correct', { action: 'chat-web-show', cardId: proposal.id })));
      card.append(actions);
    } else if (web && proposal.status !== 'dismissed') {
      const actions = node('div', '', 'assistant-actions');
      actions.append(button('Visa sidan', () => void this.act('correct', { action: 'chat-web-show', cardId: proposal.id }))); card.append(actions);
    }
    target.append(card);
  }
  /**
   * "Hitta billigast": the shops cheapest first, as the host sorted them. Öppna opens a shop
   * in an ordinary tab of this window; Bevaka priset asks the host for the ordinary
   * new-watch card, which the user approves like any other.
   */
  private renderCompare(target: HTMLElement, messageId: string, compare: AssistantChatCompare) {
    const card = node('section', '', 'assistant-chat-compare'); card.dataset.compare = 'true';
    const head = node('div', '', 'assistant-compare-head'); head.append(icon('tag'), node('h3', `Prisjämförelse: ${compare.query}`));
    card.append(head, node('p', `Priser lästa kl. ${clock(compare.readAt, this.timezone, ':')}. Kontrollera i butiken innan du köper.`, 'muted assistant-compare-note'));
    const table = node('table', '', 'assistant-compare-table'), header = node('tr'), body = node('tbody'), actionsHeader = node('th');
    table.append(node('caption', 'Butikerna sorterade på pris plus frakt, billigast först', 'visually-hidden'));
    for (const label of ['Butik', 'Pris', 'Frakt', 'Summa']) { const cell = node('th', label); cell.scope = 'col'; header.append(cell); }
    actionsHeader.scope = 'col'; actionsHeader.append(node('span', 'Åtgärder', 'visually-hidden')); header.append(actionsHeader);
    const columns = node('thead'); columns.append(header);
    const lowest = Math.min(...compare.rows.map(row => assistantCompareTotal(row)));
    compare.rows.forEach((row, index) => {
      const line = node('tr'), shop = node('th'), name = node('span', '', 'assistant-compare-name'), money = (value: number) => assistantCompareAmount(value, row.currency);
      line.dataset.compareRow = String(index); shop.scope = 'row';
      name.append(node('span', row.shop, 'assistant-compare-shop'));
      if (assistantCompareTotal(row) === lowest) { line.dataset.cheapest = 'true'; name.append(node('span', 'Billigast', 'assistant-compare-badge')); }
      shop.append(name, node('span', row.product, 'assistant-compare-product'));
      const cell = (label: string, value: string, className: string) => { const entry = node('td', value, className); entry.dataset.label = label; return entry; };
      const actions = node('td', '', 'assistant-compare-actions'), group = node('div', '', 'assistant-compare-buttons');
      const open = button('Öppna', () => void this.openShop(row.url)); open.setAttribute('aria-label', `Öppna ${row.shop} i en ny flik`); open.title = row.url;
      const watch = button('Bevaka priset', () => void this.watchPrice(watch, messageId, index)); watch.setAttribute('aria-label', `Bevaka priset hos ${row.shop}`);
      group.append(open, watch); actions.append(group);
      line.append(shop, cell('Pris', money(row.price), 'assistant-compare-price'), cell('Frakt', row.shipping === undefined ? 'Okänd' : row.shipping === 0 ? 'Fri' : money(row.shipping), 'assistant-compare-shipping'),
        cell('Summa', money(assistantCompareTotal(row)), 'assistant-compare-total'), actions);
      body.append(line);
    });
    table.append(columns, body); card.append(table);
    if (compare.rows.some(row => row.shipping === undefined)) card.append(node('p', 'Okänd frakt: frakten stod inte på butikens sida som lästes, så summan är bara priset.', 'muted assistant-compare-footnote'));
    target.append(card);
  }
  /** A shop page in an ordinary tab, opened by the user's own tap; never one of Tabai's web tabs. */
  private async openShop(url: string) {
    let address: URL | undefined;
    try { address = new URL(url); } catch { address = undefined; }
    if (!address || !['http:', 'https:'].includes(address.protocol)) { this.say('Bara vanliga webbsidor kan öppnas.'); return; }
    try { await chrome.tabs.create({ url: address.href, active: true }); }
    catch { this.say('Butikens sida kunde inte öppnas. Försök igen.'); }
  }
  /** One request per tap; the host finds a card it already made for the row instead of making another. */
  private async watchPrice(control: HTMLButtonElement, messageId: string, row: number) {
    if (!this.activeId || control.disabled) return;
    control.disabled = true;
    const ok = await this.act('correct', { action: 'chat-compare-watch', conversationId: this.activeId, messageId, row: String(row) });
    control.disabled = false;
    this.say(ok ? 'Kortet för bevakningen finns längst ned i samtalet. Bevakningen startar först när du godkänner det.' : 'Bevakningen kunde inte föreslås. Se meddelandet ovan.', ok);
    if (ok) this.log.scrollTop = this.log.scrollHeight;
  }
  private renderModule(target: HTMLElement, module: NonNullable<AssistantChatMessage['module']>) {
    const card = node('section', '', 'assistant-chat-module-card'); card.dataset.chatModuleId = module.moduleId; card.dataset.runId = module.runId;
    card.append(node('h3', module.title), node('p', module.message, 'module-summary'));
    if (module.summary) card.append(node('p', module.summary, 'module-summary'));
    if (module.overview?.length) { const list = node('dl', '', 'review-overview'); for (const item of module.overview) { const row = node('div'); row.append(node('dt', item.label), node('dd', item.value), node('p', { confirmed: 'Bekräftat', missing: 'Saknas', conflict: 'Motstridigt' }[item.status], `review-status review-${item.status}`)); if (item.note) row.append(node('p', item.note, 'muted')); list.append(row); } card.append(list); }
    if (module.verification) { const verification = node('div', '', `review-verification review-${module.verification.state}`); verification.append(node('p', module.verification.message)); for (const issue of module.verification.issues) verification.append(node('p', issue, 'muted')); card.append(verification); }
    if (module.question && module.questionId) {
      card.append(node('p', module.question, 'assistant-module-question'));
      const question = { ...module, conversationId: this.activeId! };
      if (module.choices?.length) { const choices = node('div', '', 'module-choices'); for (const choice of module.choices) choices.append(button(choice.label, () => void this.replyModule(question, choice.value))); card.append(choices); }
      card.append(button('Svara i chatten', () => { this.replyTarget = question; this.renderReplyContext(); this.input.input.focus(); }));
    }
    const actions = node('div', '', 'assistant-actions');
    if (module.canOpen) actions.append(button(module.openLabel || 'Granska underlaget', () => this.hooks.openModule(module.moduleId, module.runId)));
    if (module.canResume) actions.append(button('Öppna för att fortsätta', () => this.hooks.openModule(module.moduleId, module.runId)));
    if (module.messaging) actions.append(button('Skriv till ärendet', () => { this.replyTarget = undefined; void this.setCaseTarget(module.moduleId, module.runId).then(() => this.input.input.focus()); }));
    card.append(actions); target.append(card);
  }
  /** The run the conversation writes to; the host keeps the choice, set only by an explicit press. */
  private caseTarget() {
    const target = this.view?.moduleTarget;
    if (!target || this.replyTarget) return undefined;
    return this.view!.messages.find(message => message.module?.moduleId === target.moduleId && message.module.runId === target.runId && message.module.messaging)?.module;
  }
  private async setCaseTarget(moduleId?: string, runId?: string) {
    if (!this.activeId) return;
    await this.act('correct', { action: 'chat-module-target', conversationId: this.activeId, ...(moduleId && runId ? { moduleId, runId } : {}) });
  }
  private renderReplyContext() {
    const target = this.caseTarget(), key = JSON.stringify([this.replyTarget?.runId, this.replyTarget?.questionId, target?.runId, target?.messaging, target?.title]);
    if (key === this.replyContextKey) return;
    this.replyContextKey = key;
    this.replyContext.replaceChildren();
    if (this.replyTarget) {
      const chip = node('div', '', 'assistant-context-chip assistant-reply-chip');
      chip.append(node('span', `Svar till ${this.replyTarget.title}: ${this.replyTarget.question}`), iconButton('close', 'Avbryt modulsvar', () => { this.replyTarget = undefined; this.renderReplyContext(); this.controls(); }, 'assistant-chip-close'));
      this.replyContext.append(chip);
    } else if (target) {
      const chip = node('div', '', 'assistant-context-chip assistant-reply-chip assistant-case-chip');
      chip.title = 'Det du skriver går direkt till ärendet, inte till Tabais chatt';
      chip.append(node('span', target.messaging === 'busy' ? `Ärendet arbetar: ${target.title}` : `Skriver till ärendet: ${target.title}`), iconButton('close', 'Lämna ärendet och skriv till Tabai', () => void this.setCaseTarget(), 'assistant-chip-close'));
      this.replyContext.append(chip);
    }
  }
  private async replyModule(target: ModuleQuestion, message: string) { return this.act('correct', { action: 'chat-module-reply', messageId: crypto.randomUUID(), conversationId: target.conversationId, moduleId: target.moduleId, runId: target.runId, questionId: target.questionId!, message }); }
  /** One chat-task per tap, with a fresh message ID; a lost reply is never retried. */
  private async startTask(task: string) {
    if (!this.activeId || this.submitting || this.hostBusy) return;
    this.submitting = true; this.controls();
    const ok = await this.act('correct', { action: 'chat-task', task, conversationId: this.activeId, messageId: crypto.randomUUID() });
    // A failed request may still have started the task (the host's message says so), so the line claims no cause.
    this.submitting = false; this.say(ok ? 'Uppdraget har startat. Följ det här eller i Mejl.' : 'Se meddelandet ovan.', ok); this.controls();
  }
  /** One chat-send per user action, with a fresh message ID; nothing is retried. */
  private async deliver(text: string, fileIds: string[]) {
    if (this.sendBlocked() || !this.activeId) return false;
    const id = this.activeId; this.submitting = true; this.controls();
    const ok = await this.act('correct', { action: 'chat-send', messageId: crypto.randomUUID(), message: text, conversationId: id, ...(fileIds.length ? { fileIds: JSON.stringify(fileIds) } : {}) });
    this.submitting = false; this.say(ok ? 'Meddelandet är skickat.' : 'Meddelandet kunde inte skickas. Texten finns kvar.', ok); this.controls();
    return ok;
  }
  private async submit() {
    if (this.send.disabled || !this.activeId) return;
    const text = this.input.input.value, id = this.activeId, target = this.replyTarget, caseTarget = this.caseTarget();
    if ((target || caseTarget) && this.files.hasFiles) { this.say('Skicka bilagorna i ett vanligt chattmeddelande. Modulsvar använder ditt exakta textsvar.'); return; }
    let ok: boolean;
    if (target) {
      this.submitting = true; this.controls(); ok = await this.replyModule(target, text); this.submitting = false;
      this.say(ok ? 'Meddelandet är skickat.' : 'Meddelandet kunde inte skickas. Texten finns kvar.', ok);
    } else if (caseTarget) {
      this.submitting = true; this.controls();
      // One send per user action with a fresh ID; a lost reply is never retried.
      ok = await this.act('correct', { action: 'chat-module-message', messageId: crypto.randomUUID(), conversationId: id, moduleId: caseTarget.moduleId, runId: caseTarget.runId, message: text });
      this.submitting = false;
      this.say(ok ? 'Meddelandet är skickat till ärendet.' : 'Meddelandet kunde inte bekräftas. Kontrollera ärendet innan du skickar igen. Texten finns kvar.', ok);
    } else ok = await this.deliver(text, this.files.ids);
    if (ok && this.activeId === id && this.input.input.value === text) { this.input.input.value = ''; this.grow(); this.drafts.delete(id); this.replyTarget = undefined; this.renderReplyContext(); }
    this.controls(); this.input.input.focus();
  }
  private async newConversation() {
    if (!await this.hooks.beforeNavigate()) return;
    if (await this.act('correct', { action: 'chat-new' })) { this.closeDrawerForChat(); this.say('Ett nytt samtal är klart. Tidigare samtal finns i listan.', true); if (await this.hooks.showChat()) this.focusComposer(); }
  }
}
