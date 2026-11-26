import { modelContinuation, setContinuationBusy } from './assistant-model-continuation';
import { assistantChatModel, assistantChatModelLabel } from '../../shared/assistant-chat';
import { assistantInboxActive, assistantInboxStatus, assistantReminderAt, type AssistantItem, type AssistantWorkspace, type AssistantRun } from '../../shared/assistant';
import { assistantWebEnabled } from '../../shared/assistant-web';
import { node } from './module-views';
import { button, details, field, icon, iconButton, popover, senderLookup, sourceLink, timestamp, type AssistantAction } from './assistant-controls';
import { AssistantCasePanel } from './assistant-case-panel';
import type { ModuleView, PersonalModule } from '../../shared/personal-modules';
import {
  assistantInboxLabels as inboxLabels, assistantLocalDay as localDay, assistantMailCard, assistantMailStatus,
  assistantReplyKind as replyKind, assistantWhen as when, type AssistantMailCard as Card, type AssistantMailStatus as Status,
} from './assistant-mail-status';

export interface AssistantPendingModule { id: string; title: string; question?: string; message: string }
/** Mejl's own pages: the inbox, one mail, the checks with their history, and the cases. */
export type AssistantMailPage = 'inbox' | 'item' | 'runs' | 'cases';
type MailTab = 'todo' | 'done';
type Draft = { body: string; dirty: boolean; version: number; timer?: ReturnType<typeof setTimeout>; saving: boolean; message: string; failed: boolean };
type MailStart = NonNullable<ModuleView['mailStart']>;
type MailModule = { id: string; title: string; start?: MailStart; runs: NonNullable<ModuleView['mailRuns']> };
type MailLink = { module: MailModule; run: MailModule['runs'][number] } | { module: MailModule; start: MailStart; request: boolean };
const providerNames = { gmail: 'Gmail', outlook: 'Outlook', zoho: 'Zoho' } as const;
/** A word starting at a word boundary ("bokning" in "bokningen", not in "avbokning"); a word of three letters or fewer must also end at one ("dj" is not "Djurgården"). */
const wordIn = (text: string, word: string) => {
  const escaped = word.toLocaleLowerCase('sv-SE').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}${word.length <= 3 ? '(?![\\p{L}\\p{N}])' : ''}`, 'u').test(text);
};
/** One spelling of an address, so the mail's address and the one a module stored compare equal. */
const sameAddress = (value: string) => { try { return new URL(value).href; } catch { return value; } };
export interface AssistantMailHooks {
  /** With `start`, the module's start form is shown filled with these values; nothing starts. */
  openModule: (id: string, runId?: string, start?: Record<string, string>) => void | string | Promise<void | string>;
  /** Each leaves Mejl for a new conversation; the panel saves drafts first. */
  chatContext: (kind: 'item' | 'case', id: string, revision: number) => void;
  lookupSender: (itemId: string, revision: number) => void;
  openAccounts: () => void;
  /** The header's title and back button follow the page. */
  pageChanged: () => void;
}

const coverageLabels = { pending: 'Väntar', checking: 'Kollar', checked: 'Kollat', partial: 'Delvis kollat', login: 'Inloggning behövs', unsupported: 'Vyn stöds inte', failed: 'Kunde inte kollas' };
const stageLabels = { opening: 'öppnar kontot', reading: 'läser mejl', searching: 'söker i trådar', reviewing: 'går igenom', waiting: 'väntar på dig', complete: 'klar', error: 'kunde inte slutföra' };
const tabs: [MailTab, string][] = [['todo', 'Att göra'], ['done', 'Klart']];
const startTasks = [
  ['my-day', 'Min dag', 'Prioritera åtaganden, mejl och möten.'],
  ['prepare-meeting', 'Förbered möte', 'Samla det som behövs inför nästa möte.'],
  ['follow-ups', 'Följ upp', 'Skickade mejl som väntar på svar.'],
] as const;
/** One sentence per card about what the user does next. */
const sentences = {
  reply: 'Tabai har skrivit ett svar. Läs, ändra om du vill och skicka.',
  question: 'Tabai behöver veta en sak innan det går att svara.',
  uncertain: 'Det är oklart om svaret skickades. Kolla i kontot innan du gör något mer.',
  info: 'Bara för kännedom.',
  'needs-you': 'Läs mejlet och gör det som behövs. Tryck Klar när du är färdig.',
  rewriting: 'Tabai skriver ett nytt förslag med det du svarade.',
  self: (account: string) => `Tabai har inget förslag på svar. Svara själv i ${account}.`,
};
/** How an account that needs the user reads on its red row in the inbox. */
const gapLabels: Record<string, string> = { login: 'behöver loggas in', unsupported: 'visas i en vy som Tabai inte kan läsa', failed: 'kunde inte kollas', partial: 'kollades bara delvis' };
const reminders = [['tomorrow', 'I morgon'], ['next-week', 'Nästa vecka']] as const;
/** How long Ångra stays after Klar; hovering or focusing it pauses the time. */
const UNDO_MS = 6000;
const gaps = ['partial', 'failed', 'login', 'unsupported'];
const runHelps = (run?: AssistantRun) => run?.helps?.length ? run.helps : run?.help ? [run.help] : [];
let sequence = 0;

/** The name in "Namn <adress>", or the address when there is no name. */
function senderName(value?: string) {
  if (!value) return '';
  return value.replace(/<[^>]*>/g, '').replace(/["]/g, '').trim() || value.replace(/[<>]/g, '').trim();
}
function moment(value: string, timeZone: string) { const time = node('time', when(value, timeZone)); time.dateTime = value; return time; }
function menuItem(label: string, detail: string, action: () => void) {
  const control = button('', action, 'assistant-menu-item'), text = node('span', '', 'assistant-menu-text');
  text.append(node('span', label, 'assistant-menu-label')); if (detail) text.append(node('span', detail, 'muted'));
  control.append(text); return control;
}

/**
 * Mejl as an inbox: "Kollat …", a red row only for an account that needs the user, Kolla mina
 * mejl with ⋯ (other tasks, Ärenden and the checks), the tabs Att göra and Klart, and one mail at
 * a time. Each mail says in one sentence what to do and has one main button; Klar or Inget svar
 * behövs and Påminn mig sit below it, everything else under ⋯. Every action keeps the host's
 * contract, and a reply is sent only after Skicka in the card's own confirmation.
 */
export class AssistantMailView {
  readonly element = node('section', '', 'assistant-view assistant-view-mail');
  readonly cases: AssistantCasePanel;
  page: AssistantMailPage = 'inbox';
  private ns = `mail-${++sequence}`;
  private workspace?: AssistantWorkspace;
  private pending: AssistantPendingModule[] = [];
  private busy = false;
  private disposed = false;
  private tab: MailTab = 'todo';
  private account = '';
  private itemId?: string;
  private confirmAll = false;
  /**
   * The mail whose card asks "Skicka till …?", at the revision the user saw when they pressed
   * Skicka svaret. Nothing is sent before its Skicka, and a change to the mail closes the question.
   */
  private confirmSend?: { id: string; revision: number };
  /** Mail whose send is on its way; another Skicka for it is ignored. */
  private sending = new Set<string>();
  /** The mail whose quotes ("Det här läste Tabai") are shown, opened from ⋯. */
  private evidenceFor?: string;
  /** What opened Kontroller or Ärenden; focus goes back there on ←. */
  private opener?: HTMLElement;
  private listScroll = 0;
  private drafts = new Map<string, Draft>();
  private answers = new Map<string, string>();
  // Inbox
  private inbox = node('div', '', 'assistant-mail-inbox');
  private statusText = node('p', '', 'assistant-mail-status-text');
  private statusSentence = node('span', '', 'assistant-mail-status-sentence');
  private statusThreads = node('span', '', 'assistant-mail-status-threads');
  private statusActions = node('div', '', 'assistant-mail-status-actions');
  private statusKey = '';
  private alertRegion = node('div', '', 'assistant-mail-alert-region');
  private alerts = node('ul', '', 'assistant-mail-alerts');
  private alertsKey = '';
  private checkButton = button('Kolla mina mejl', () => void this.act('start', { task: 'check-mail' }), 'primary assistant-mail-check');
  private moreButton = iconButton('more', 'Fler val', () => {}, 'assistant-mail-more');
  private moreMenu = node('div', '', 'assistant-menu assistant-mail-menu');
  private morePopover: { close: () => void };
  private moreKey = '';
  private tablist = node('div', '', 'assistant-mail-tabs');
  private tabButtons = {} as Record<MailTab, HTMLButtonElement>;
  private panels = {} as Record<MailTab, HTMLElement>;
  private filterLabel = node('label', '', 'assistant-mail-filter');
  private filter = node('select');
  private filterKey = '';
  private pager = node('div', '', 'assistant-item-pagination');
  // One mail. The small buttons and their menus stay in place across renders, so a poll never
  // closes an open Påminn menu or takes focus from Klar.
  private detail = node('article', '', 'assistant-mail-detail');
  private detailMeta = node('div', '', 'assistant-mail-detail-meta');
  private detailMore = iconButton('more', 'Fler val för mejlet', () => {}, 'assistant-mail-more');
  private detailMenu = node('div', '', 'assistant-menu assistant-mail-menu');
  private detailPopover: { close: () => void };
  private detailMenuKey = '';
  private detailBody = node('div', '', 'assistant-mail-detail-body');
  private secondary = node('div', '', 'assistant-mail-secondary');
  private doneButton = button('Klar', () => {}, 'assistant-mail-small');
  private remindButton = button('', () => {}, 'assistant-mail-small assistant-mail-remind');
  private moduleStarts = node('span', '', 'assistant-mail-module-starts');
  private mailModules: MailModule[] = [];
  private mailModulesKey = '';
  private moduleStartsKey = '';
  /** Mail this panel marked Klar for a handled case, or tried to: an Ångra is never overridden. */
  private autoDone = new Set<string>();
  private autoMarking = false;
  private remindMenu = node('div', '', 'assistant-menu assistant-mail-menu assistant-mail-remind-menu');
  private remindPopover: { close: () => void };
  private remindKey = '';
  // Ärenden
  private casesPage = node('section', '', 'assistant-mail-cases');
  // Checks, shortcuts and history
  private runs = node('div', '', 'assistant-mail-runs');
  private progress = node('section', '', 'assistant-progress');
  private showWorkButton = button('Visa arbete', () => void this.act('open', { work: 'true' }));
  private shortcutRoot = details('Egna snabbknappar', 'assistant-shortcuts');
  private shortcutForm = node('form');
  private shortcutList = node('div');
  private shortcutId?: string;
  private shortcutStatus = node('p', '', 'muted');
  private shortcutLabel = field('Knappens namn', 'shortcut-label', '', false, this.ns);
  private shortcutInstructions = field('Vad ska Tabai göra?', 'shortcut-instructions', '', true, this.ns);
  private history = details('Tidigare kontroller', 'assistant-history');
  // Ångra and other short confirmations
  private toastRegion = node('div', '', 'assistant-mail-toast-region');
  private toastTimer?: ReturnType<typeof setTimeout>;
  private toastLeft = 0;
  private toastSince = 0;
  private toastHeld = { pointer: false, focus: false };

  constructor(private act: AssistantAction, private hooks: AssistantMailHooks) {
    this.cases = new AssistantCasePanel(act, () => this.flushDrafts(), hooks.openModule, (id, revision) => hooks.chatContext('case', id, revision), item => hooks.lookupSender(item.id, item.revision));
    this.element.setAttribute('aria-label', 'Mejl');
    this.morePopover = popover(this.moreButton, this.moreMenu);
    this.detailPopover = popover(this.detailMore, this.detailMenu, () => {
      const item = this.currentItem(); if (item) this.renderDetailMenu(item);
      // The menu helper focuses the first button; the first entry here is Öppna originalet, a link.
      queueMicrotask(() => this.detailMenu.querySelector<HTMLElement>('a[data-mail-action="original"]')?.focus({ preventScroll: true }));
    });
    // Opening Påminn mig re-checks the menu's key, so its times are right even when nothing else re-rendered since midnight.
    this.remindPopover = popover(this.remindButton, this.remindMenu, () => { const item = this.currentItem(); if (item) this.renderRemindMenu(item); });
    this.buildInbox(); this.buildDetail(); this.buildRuns(); this.buildCases(); this.buildToast();
    this.element.append(this.inbox, this.detail, this.runs, this.casesPage, this.toastRegion);
    this.element.addEventListener('keydown', event => this.onKey(event));
  }
  private currentItem() { return this.page === 'item' ? this.workspace?.items.find(entry => entry.id === this.itemId) : undefined; }

  private buildInbox() {
    const status = node('div', '', 'assistant-mail-status');
    // Only the sentence is live, and it is rebuilt only when its meaning changes. The thread count
    // changes on every poll, so it sits beside the sentence, outside the live region.
    this.statusSentence.setAttribute('aria-live', 'polite');
    this.statusText.append(this.statusSentence, this.statusThreads);
    status.append(this.statusText, this.statusActions);
    // An account that needs the user is read out when its row appears, as the status used to say
    // it. The live region is always there; only the list inside it comes and goes.
    this.alertRegion.setAttribute('aria-live', 'polite');
    this.alerts.setAttribute('aria-label', 'Konton som behöver dig'); this.alerts.hidden = true;
    this.alertRegion.append(this.alerts);
    const start = node('div', '', 'assistant-mail-start');
    this.checkButton.dataset.task = 'check-mail';
    this.moreMenu.setAttribute('aria-label', 'Fler val');
    start.append(this.checkButton, this.moreButton, this.moreMenu);
    this.tablist.setAttribute('role', 'tablist'); this.tablist.setAttribute('aria-label', 'Mejl');
    for (const [key, label] of tabs) {
      const tab = node('button', '', 'assistant-mail-tab'), panel = node('section', '', 'assistant-mail-panel');
      tab.type = 'button'; tab.id = `${this.ns}-tab-${key}`; tab.dataset.tab = key; tab.setAttribute('role', 'tab');
      panel.id = `${this.ns}-panel-${key}`; panel.dataset.panel = key; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
      tab.setAttribute('aria-controls', panel.id);
      tab.append(node('span', label, 'assistant-mail-tab-label'), node('span', '', 'assistant-mail-count'), node('span', '', 'visually-hidden'));
      tab.onclick = () => this.selectTab(key);
      this.tabButtons[key] = tab; this.panels[key] = panel; this.tablist.append(tab);
    }
    this.tablist.addEventListener('keydown', event => {
      const order = tabs.map(([key]) => key), index = order.indexOf(this.tab);
      const next = { ArrowRight: order[(index + 1) % order.length], ArrowLeft: order[(index + order.length - 1) % order.length], Home: order[0], End: order[order.length - 1] }[event.key];
      if (!next) return;
      event.preventDefault(); this.selectTab(next, true);
    });
    this.filter.name = 'mail-account';
    this.filter.onchange = () => { this.account = this.filter.value; this.confirmAll = false; this.render(); };
    this.filterLabel.append(node('span', 'Visa mejl från', 'visually-hidden'), this.filter);
    this.pager.dataset.section = 'pages';
    this.inbox.append(status, this.alertRegion, start, this.tablist, this.filterLabel, ...tabs.map(([key]) => this.panels[key]), this.pager);
    this.selectTab('todo');
  }
  private buildDetail() {
    this.detail.hidden = true; this.detail.setAttribute('aria-labelledby', `${this.ns}-detail-title`);
    this.detailMenu.setAttribute('aria-label', 'Fler val för mejlet');
    const bar = node('div', '', 'assistant-mail-detail-bar'); bar.append(this.detailMeta, this.detailMore, this.detailMenu);
    this.remindButton.append(node('span', 'Påminn mig'), icon('down')); this.remindButton.dataset.remind = 'true';
    this.remindMenu.setAttribute('aria-label', 'Påminn mig');
    this.secondary.append(this.doneButton, this.remindButton, this.moduleStarts, this.remindMenu);
    this.detail.append(bar, this.detailBody, this.secondary);
  }
  private buildCases() {
    // The page itself takes focus when it opens; the header already says Ärenden.
    this.casesPage.hidden = true; this.casesPage.tabIndex = -1; this.casesPage.setAttribute('aria-label', 'Ärenden');
    this.casesPage.append(this.cases.element);
  }
  private buildRuns() {
    this.runs.hidden = true;
    this.progress.dataset.section = 'run'; this.progress.setAttribute('aria-label', 'Kontrollens status');
    this.shortcutForm.append(this.shortcutLabel.wrapper, this.shortcutInstructions.wrapper, this.shortcutStatus);
    this.shortcutLabel.input.required = true; this.shortcutLabel.input.maxLength = 100; this.shortcutInstructions.input.required = true;
    const save = node('button', 'Spara snabbknapp'); save.type = 'submit'; this.shortcutForm.append(save);
    this.shortcutForm.onsubmit = async event => {
      event.preventDefault(); if (!this.shortcutForm.reportValidity()) return;
      const label = this.shortcutLabel.input.value, instructions = this.shortcutInstructions.input.value;
      const ok = await this.act('correct', { action: 'save-shortcut', label, instructions, ...(this.shortcutId ? { id: this.shortcutId } : {}) });
      this.shortcutStatus.textContent = ok ? 'Snabbknappen är sparad. Den finns under ⋯ bredvid Kolla mina mejl.' : 'Kunde inte spara. Dina ändringar finns kvar.';
      if (ok && this.shortcutLabel.input.value === label && this.shortcutInstructions.input.value === instructions) { this.shortcutForm.reset(); this.shortcutId = undefined; }
    };
    this.shortcutRoot.append(node('p', 'Spara ett uppdrag du ofta ger Tabai. Det hamnar under ⋯ bredvid Kolla mina mejl.', 'muted'), this.shortcutList, this.shortcutForm);
    this.runs.append(this.progress, this.shortcutRoot, this.history);
  }
  private buildToast() {
    this.toastRegion.setAttribute('role', 'status');
    const hold = (kind: 'pointer' | 'focus', held: boolean) => { this.toastHeld[kind] = held; if (held) this.pauseToast(); else this.resumeToast(); };
    this.toastRegion.addEventListener('pointerenter', () => hold('pointer', true));
    this.toastRegion.addEventListener('pointerleave', () => hold('pointer', false));
    this.toastRegion.addEventListener('focusin', () => hold('focus', true));
    this.toastRegion.addEventListener('focusout', event => { if (!this.toastRegion.contains(event.relatedTarget as Node | null)) hold('focus', false); });
  }

  // Panel interface
  update(workspace: AssistantWorkspace) { this.workspace = workspace; this.render(); this.markHandled(); }
  setPending(pending: AssistantPendingModule[]) { this.pending = pending; this.render(); }
  setBusy(busy: boolean) { this.busy = busy; this.applyBusy(); this.cases.setBusy(busy); }
  get heading() { return this.page === 'runs' ? 'Kontroller' : this.page === 'cases' ? 'Ärenden' : 'Mejl'; }
  /** The counter on the header's Mejl button: the host's attention count plus other agents' work. */
  badge() {
    const workspace = this.workspace; if (!workspace) return this.pending.length;
    const run = workspace.current, waitingOnUser = run?.status === 'waiting' && !!(run.question || run.help);
    const needs = workspace.items.filter(item => assistantInboxActive(item) && assistantInboxStatus(item) !== 'info').length;
    return (workspace.attention?.count ?? needs + Number(waitingOnUser)) + this.pending.length;
  }
  /** Opens Mejl on its list or on the checks; the panel saves drafts before calling this. */
  show(target: 'inbox' | 'run') {
    this.page = target === 'run' ? 'runs' : 'inbox';
    if (target === 'inbox') this.selectTab('todo');
    this.render();
  }
  /** Focus for a page reached from outside Mejl; false leaves it to the panel. */
  focusPage() {
    // Coming back to a mail from elsewhere never finds an old "Skicka till …?" still open.
    if (this.confirmSend && !this.sending.has(this.confirmSend.id)) { this.confirmSend = undefined; this.render(); }
    const target = this.page === 'item' ? this.detail.querySelector<HTMLElement>('.assistant-mail-detail-title') : this.page === 'runs' ? this.progress.querySelector<HTMLElement>('h3') : this.page === 'cases' ? this.casesPage : undefined;
    if (!target) return false;
    target.tabIndex = -1; target.focus({ preventScroll: true }); return true;
  }
  /** One step back inside Mejl; false on the list, where the panel returns to the chat. */
  async back(): Promise<boolean> {
    if (this.page === 'inbox') return false;
    if (!await this.flushDrafts()) return true;
    const from = this.page;
    this.leavePage(from === 'item' ? this.itemId : undefined);
    if (from === 'runs' || from === 'cases') this.focusOpener();
    return true;
  }
  async flushDrafts() {
    for (const [itemId, draft] of this.drafts) if (draft.dirty) {
      clearTimeout(draft.timer);
      if (!await this.saveDraft(itemId) || this.drafts.get(itemId)?.dirty) return false;
    }
    return true;
  }
  dispose() {
    this.disposed = true; clearTimeout(this.toastTimer);
    for (const draft of this.drafts.values()) clearTimeout(draft.timer);
  }

  // Rendering
  private render() {
    const workspace = this.workspace; if (!workspace || this.disposed) return;
    const focused = document.activeElement, focusId = this.element.contains(focused) ? focused?.id : undefined;
    const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] as const : undefined;
    const opened = new Set([...this.element.querySelectorAll<HTMLDetailsElement>('details[open][data-keep]')].map(entry => entry.dataset.keep));
    if (this.page === 'item' && !workspace.items.some(item => item.id === this.itemId)) { this.page = 'inbox'; this.itemId = undefined; this.confirmSend = undefined; this.hooks.pageChanged(); }
    this.inbox.hidden = this.page !== 'inbox'; this.detail.hidden = this.page !== 'item'; this.runs.hidden = this.page !== 'runs'; this.casesPage.hidden = this.page !== 'cases';
    this.placeToast();
    this.renderStatus(); this.renderAlerts(); this.renderStartMenu(); this.renderFilter();
    const visible = (item: AssistantItem) => !this.account || item.accountId === this.account;
    const active = workspace.items.filter(item => assistantInboxActive(item) && visible(item));
    const needs = active.filter(item => assistantInboxStatus(item) !== 'info'), info = active.filter(item => assistantInboxStatus(item) === 'info');
    this.renderTodo(needs, info);
    this.renderDone(workspace.items.filter(item => !assistantInboxActive(item) && visible(item)));
    this.renderTabs(needs.length + Number(workspace.current?.status === 'waiting' && !!workspace.current.question) + this.pending.length);
    this.renderPager();
    this.cases.update(workspace);
    const item = this.currentItem();
    if (item) this.renderDetail(item);
    this.renderProgress(); this.renderShortcuts(); this.renderHistory();
    this.element.querySelectorAll<HTMLDetailsElement>('details[data-keep]').forEach(entry => { if (opened.has(entry.dataset.keep)) entry.open = true; });
    if (focusId && !this.element.contains(document.activeElement)) {
      const replacement = this.element.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`);
      replacement?.focus({ preventScroll: true });
      if (selection && replacement instanceof HTMLTextAreaElement) replacement.setSelectionRange(...selection);
    }
    this.applyBusy();
  }
  private applyBusy() {
    for (const control of this.element.querySelectorAll<HTMLButtonElement>('button')) if (!control.closest('.assistant-case-center')) control.disabled = this.busy || control.dataset.blocked === 'true';
    if (this.continuationControl) setContinuationBusy(this.continuationControl.element, this.busy);
  }
  private renderStatus() {
    const { current: run, settings, lastChecks } = this.workspace!;
    const enabled = settings.accounts.some(account => account.enabled), zone = settings.timezone;
    const latest = Object.values(lastChecks).sort((first, second) => Date.parse(second) - Date.parse(first))[0];
    type Line = { text: string; at?: string; tone?: 'danger' | 'attention'; action?: 'setup' | 'stop' | 'resume' | 'why' };
    let line: Line;
    // Outside the live sentence and its key: a new count is shown, never read out on its own.
    this.statusThreads.textContent = enabled && run?.status === 'running' ? ` · ${run.activity?.reviewedThreads ?? 0} trådar bedömda och sparade` : '';
    if (!enabled) line = { text: 'Lägg till ett mejlkonto för att komma igång.', action: 'setup' };
    else if (!run) line = latest ? { text: 'Kollat', at: latest } : { text: 'Inte kollat ännu.' };
    else if (run.status === 'running') line = { text: run.task === 'check-mail' ? 'Kollar dina mejl…' : `${run.label} pågår…`, action: 'stop' };
    else if (run.externalEffect === 'possible') line = { text: 'Kontrollera vad som redan har utförts.', tone: 'attention', action: 'why' };
    else if (run.status === 'waiting') line = { text: run.question ? 'Tabai väntar på ditt svar.' : 'Tabai behöver din hjälp.', tone: 'attention', action: 'stop' };
    else if (run.status === 'paused') line = { text: 'Kontrollen är pausad.', action: run.task === 'send' ? undefined : 'resume' };
    else if (run.status === 'failed') line = { text: 'Kontrollen kunde inte slutföras.', tone: 'danger', action: 'why' };
    else if (run.task === 'send') line = latest ? { text: 'Kollat', at: latest } : { text: 'Svaret är skickat.' };
    else if (run.coverage.some(entry => entry.status !== 'checked')) line = { text: 'Kontrollen är delvis klar.', action: 'why' };
    // Every task except a send reads the mailboxes, so the row says when mail was last checked.
    // Accounts that need the user get their own red rows; coverage and history sit under ⋯.
    else line = { text: 'Kollat', at: run.updatedAt };
    // Replies still open for mail that had already been opened: the check's one extra fact.
    const opened = line.text === 'Kollat' || line.text === 'Kontrollen är delvis klar.' ? this.workspace!.openedUnanswered ?? 0 : 0;
    const key = JSON.stringify([line, line.at ? when(line.at, zone) : '', opened]);
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.statusSentence.replaceChildren(line.text);
    if (line.at) this.statusSentence.append(' ', moment(line.at, zone));
    if (opened) this.statusSentence.append(` · ${opened} mejl du öppnat men inte svarat på`);
    if (line.tone) this.statusText.dataset.tone = line.tone; else delete this.statusText.dataset.tone;
    this.statusActions.replaceChildren();
    if (line.action === 'setup') {
      const setup = node('div', '', 'assistant-setup'); setup.dataset.setup = 'accounts';
      setup.append(button('Lägg till ett mejlkonto', () => this.hooks.openAccounts(), 'quiet'));
      this.statusActions.append(setup);
    }
    if (line.action === 'stop') this.statusActions.append(button('Stoppa', () => void this.act('stop'), 'quiet'));
    if (line.action === 'resume') this.statusActions.append(button('Fortsätt', () => void this.act('resume'), 'quiet'));
    if (line.action === 'why') {
      const why = button('Visa varför', () => this.showRuns(false, why), 'quiet'); why.dataset.runDetails = 'true';
      this.statusActions.append(why);
    }
  }
  /**
   * One red row per account that needs the user, with Åtgärda. A login or another gap in the
   * coverage opens that account, as Öppna kontot does under Kontroller; a run waiting for the
   * user's help opens Kontroller, where the help and its buttons are.
   */
  private renderAlerts() {
    const { current: run, settings } = this.workspace!;
    const helps = runHelps(run);
    // Only saved accounts: one removed since the run cannot be opened, so it gets no row.
    const label = (id: string) => settings.accounts.find(account => account.id === id)?.label;
    const rows: { account: string; text: string; help: boolean; tone: 'danger' | 'warning'; open: boolean }[] = [];
    for (const help of helps) if (label(help.accountId)) rows.push({ account: help.accountId, text: `${label(help.accountId)} behöver din hjälp`, help: true, tone: 'danger', open: false });
    for (const entry of run?.coverage ?? []) {
      if (gaps.includes(entry.status) && label(entry.accountId) && !rows.some(row => row.account === entry.accountId)) rows.push({ account: entry.accountId, text: `${label(entry.accountId)} ${gapLabels[entry.status]}`, help: false, tone: entry.status === 'login' ? 'danger' : 'warning', open: entry.status === 'login' });
    }
    const key = JSON.stringify(rows);
    if (key === this.alertsKey) return;
    this.alertsKey = key; this.alerts.replaceChildren(); this.alerts.hidden = !rows.length;
    for (const row of rows) {
      const entry = node('li', '', 'assistant-mail-alert');
      const fix = button(row.tone === 'danger' ? 'Åtgärda' : 'Visa status', () => {
        if (row.open) void this.act('open', { accountId: row.account });
        else { this.helpAccount = row.help ? row.account : undefined; this.showRuns(false, fix); }
      }, 'assistant-mail-alert-action');
      entry.dataset.alertAccount = row.account;
      entry.dataset.tone = row.tone;
      fix.setAttribute('aria-label', `${row.tone === 'danger' ? 'Åtgärda' : 'Visa status'}: ${row.text}`); fix.dataset.alertAction = row.help ? 'help' : row.open ? 'open' : 'status';
      entry.append(node('span', row.text, 'assistant-mail-alert-text'), fix); this.alerts.append(entry);
    }
  }
  private renderStartMenu() {
    const { settings, shortcuts, current } = this.workspace!;
    const enabled = settings.accounts.some(account => account.enabled), working = current?.status === 'running' || current?.status === 'waiting';
    this.checkButton.dataset.blocked = String(!enabled || working);
    const key = JSON.stringify([enabled, working, shortcuts]);
    if (key === this.moreKey) return;
    this.moreKey = key; this.moreMenu.replaceChildren(node('p', 'Fler uppdrag', 'assistant-menu-title'));
    const start = (input: Record<string, string>) => { this.morePopover.close(); void this.act('start', input); };
    for (const [task, label, description] of startTasks) {
      const entry = menuItem(label, description, () => start({ task }));
      entry.dataset.task = task; entry.dataset.blocked = String(!enabled || working); this.moreMenu.append(entry);
    }
    if (shortcuts.length) this.moreMenu.append(node('p', 'Egna snabbknappar', 'assistant-menu-title assistant-menu-section'));
    for (const shortcut of shortcuts) {
      const entry = menuItem(shortcut.label, shortcut.instructions.length > 80 ? `${shortcut.instructions.slice(0, 79)}…` : shortcut.instructions, () => start({ task: 'custom', shortcutId: shortcut.id }));
      entry.dataset.shortcutId = shortcut.id; entry.dataset.blocked = String(!enabled || working); this.moreMenu.append(entry);
    }
    const manage = button(shortcuts.length ? 'Ändra egna snabbknappar' : 'Lägg till en egen snabbknapp', () => { this.morePopover.close(); this.showRuns(true, this.moreButton); }, 'assistant-menu-link');
    manage.dataset.manageShortcuts = 'true'; this.moreMenu.append(manage, node('hr'));
    const cases = menuItem('Ärenden', 'Samla det som hör ihop över flera mejl', () => { this.morePopover.close(); this.showCases(this.moreButton); });
    const checks = menuItem('Kontroller och konton', 'Senaste kontrollen, kontona och tidigare kontroller', () => { this.morePopover.close(); this.showRuns(false, this.moreButton); });
    cases.dataset.mailOpen = 'cases'; checks.dataset.mailOpen = 'details'; checks.dataset.mailDetails = 'true';
    this.moreMenu.append(cases, checks);
  }
  private renderFilter() {
    const accounts = this.workspace!.settings.accounts;
    if (!accounts.some(account => account.id === this.account)) this.account = '';
    this.filterLabel.hidden = accounts.length < 2;
    const key = JSON.stringify(accounts.map(account => [account.id, account.label]));
    if (key !== this.filterKey) {
      this.filterKey = key;
      this.filter.replaceChildren(new Option('Alla konton', ''), ...accounts.map(account => new Option(account.label, account.id)));
    }
    this.filter.value = this.account;
  }
  private renderTabs(todo: number) {
    for (const [key, label] of tabs) {
      const tab = this.tabButtons[key], count = key === 'todo' ? todo : 0;
      tab.querySelector('.assistant-mail-count')!.textContent = count ? String(count) : '';
      tab.querySelector('.visually-hidden')!.textContent = count ? `, ${count} väntar på dig` : '';
      tab.dataset.count = String(count); tab.title = count ? `${label}, ${count} väntar på dig` : label;
    }
  }
  private selectTab(key: MailTab, focus = false) {
    if (this.tab !== key) this.confirmAll = false;
    this.tab = key;
    for (const [entry] of tabs) {
      const selected = entry === key, tab = this.tabButtons[entry];
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; this.panels[entry].hidden = !selected;
    }
    if (this.workspace) { this.renderFilter(); this.renderPager(); }
    if (focus) this.tabButtons[key].focus();
  }
  private renderTodo(needs: AssistantItem[], info: AssistantItem[]) {
    const panel = this.panels.todo, run = this.workspace!.current;
    panel.replaceChildren();
    const waiting = run?.status === 'waiting' && !!run.question;
    if (waiting) panel.append(this.question(run.questionId || run.id, run.question!, { questionId: run.questionId || run.id }, 'Tabai behöver veta en sak för att fortsätta.'));
    const list = node('ul', '', 'assistant-mail-list'); list.setAttribute('aria-label', 'Behöver dig');
    for (const pending of this.pending.filter(entry => entry.question)) list.append(this.pendingRow(pending));
    for (const item of needs) list.append(this.row(item, true));
    for (const pending of this.pending.filter(entry => !entry.question)) list.append(this.pendingRow(pending));
    if (list.childElementCount) panel.append(list);
    if (info.length) panel.append(this.infoGroup(info));
    if (!list.childElementCount && !info.length && !waiting) {
      const empty = this.account ? 'Inget från det här kontot väntar på dig.'
        : run?.status === 'running' ? 'Tabai går igenom dina mejl. Det som behöver dig visas här efter hand.'
        : run?.status === 'failed' ? 'Kontrollen kunde inte slutföras, så listan kan sakna mejl.'
        : run?.status === 'paused' ? 'Kontrollen är pausad. Fortsätt när du vill.'
        : run ? 'Inget väntar på dig just nu.' : 'Inget väntar på dig. Tryck på Kolla mina mejl för att gå igenom dina konton.';
      panel.append(node('p', empty, 'assistant-empty assistant-mail-empty'));
    }
  }
  private infoGroup(info: AssistantItem[]) {
    const group = node('section', '', 'assistant-mail-group'), head = node('div', '', 'assistant-mail-group-head');
    group.dataset.group = 'info'; group.setAttribute('aria-labelledby', `${this.ns}-info-title`);
    const title = node('h3', 'För kännedom'); title.id = `${this.ns}-info-title`;
    title.append(node('span', ` · ${info.length}`, 'muted'));
    head.append(title);
    if (info.length > 1) {
      const all = button('Klar för alla', () => { this.confirmAll = true; this.render(); this.panels.todo.querySelector<HTMLElement>('[data-done-all-confirm]')?.focus(); }, 'quiet assistant-mail-all');
      all.dataset.doneAll = 'true'; all.setAttribute('aria-label', `Klar för alla ${info.length} mejl för kännedom`);
      head.append(all);
    } else this.confirmAll = false;
    group.append(head);
    if (this.confirmAll) {
      const confirm = node('div', '', 'assistant-mail-confirm'), actions = node('div', '', 'assistant-actions');
      confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', 'Bekräfta Klar för alla');
      const yes = button(`Ja, markera ${info.length} som klara`, () => void this.markAllDone(info), 'primary'); yes.dataset.doneAllConfirm = 'true';
      actions.append(button('Avbryt', () => this.cancelConfirm()), yes);
      confirm.append(node('p', `Markera ${info.length} mejl för kännedom som klara?`), actions);
      group.append(confirm);
    }
    const list = node('ul', '', 'assistant-mail-list'); list.setAttribute('aria-labelledby', title.id);
    for (const item of info) list.append(this.row(item, true));
    group.append(list); return group;
  }
  private cancelConfirm() { this.confirmAll = false; this.render(); this.panels.todo.querySelector<HTMLElement>('[data-done-all]')?.focus(); }
  private renderDone(items: AssistantItem[]) {
    const panel = this.panels.done; panel.replaceChildren();
    if (!items.length) { panel.append(node('p', 'Här hamnar mejl du är klar med, har skickat svar på eller vill bli påmind om.', 'assistant-empty assistant-mail-empty')); return; }
    const list = node('ul', '', 'assistant-mail-list'); list.setAttribute('aria-label', 'Klart');
    for (const item of items) list.append(this.row(item, false));
    panel.append(list);
  }
  private renderPager() {
    const page = this.workspace!.itemPage, items = this.workspace!.items;
    this.pager.replaceChildren(); this.pager.hidden = !page;
    if (!page) { delete this.pager.dataset.itemPage; return; }
    this.pager.dataset.itemPage = String(page.offset);
    this.pager.append(node('p', `Visar ${items.length ? page.offset + 1 : 0}–${items.length ? Math.min(page.total, page.offset + items.length) : 0} av ${page.total} sparade mejl`, 'muted'), node('p', 'Sidorna gäller både Att göra och Klart.', 'muted'));
    const actions = node('div', '', 'assistant-actions');
    const previous = button('Föregående', () => void this.changeItemPage(Math.max(0, page.offset - 10)));
    previous.dataset.blocked = String(page.offset === 0); previous.dataset.itemPageAction = 'previous';
    const next = button('Nästa', () => { if (page.nextOffset !== undefined) void this.changeItemPage(page.nextOffset); });
    next.dataset.blocked = String(page.nextOffset === undefined); next.dataset.itemPageAction = 'next';
    actions.append(previous, next); this.pager.append(actions);
  }
  private async changeItemPage(offset: number) {
    if (await this.flushDrafts()) await this.act('history', { offset: String(offset) });
  }
  private statusOf(item: AssistantItem) { return assistantMailStatus(item, this.workspace!.settings.timezone); }
  private chip(status: Status) { const chip = node('span', status.label, 'assistant-mail-chip'); chip.dataset.status = status.key; return chip; }
  private row(item: AssistantItem, active: boolean) {
    const accounts = this.workspace!.settings.accounts, account = accounts.find(entry => entry.id === item.accountId);
    const entry = node('li', '', 'assistant-mail-entry'), status = this.statusOf(item);
    entry.dataset.itemId = item.id; entry.dataset.status = status.key;
    const open = button('', () => void this.openItem(item.id), 'assistant-mail-row'); open.id = `${this.ns}-row-${item.id}`;
    const top = node('span', '', 'assistant-mail-row-top');
    top.append(node('span', senderName(item.sender) || account?.label || 'Okänd avsändare', 'assistant-mail-sender'), this.chip(status));
    open.append(top, node('span', item.title, 'assistant-mail-subject'));
    if (accounts.length > 1 && !this.account) open.append(node('span', account?.label || item.accountId, 'assistant-mail-account'));
    entry.append(open);
    if (active && status.key === 'info') {
      const done = button('Klar', () => void this.markDone(item), 'assistant-mail-done');
      done.dataset.markDone = item.id; done.setAttribute('aria-label', `Klar: ${item.title}`); entry.append(done);
    }
    return entry;
  }
  private pendingRow(pending: AssistantPendingModule) {
    const entry = node('li', '', 'assistant-mail-entry'); entry.dataset.pendingModule = pending.id;
    const open = button('', () => void this.hooks.openModule(pending.id), 'assistant-mail-row'), top = node('span', '', 'assistant-mail-row-top');
    top.append(node('span', 'Ett annat verktyg', 'assistant-mail-sender'), this.chip(pending.question ? { key: 'question', label: inboxLabels.question } : { key: 'needs-you', label: 'Klart att titta på' }));
    open.append(top, node('span', pending.title, 'assistant-mail-subject'), node('span', pending.question || pending.message, 'assistant-mail-note'));
    entry.append(open); return entry;
  }
  /** An answer form; on a mail its card already says why, so only the run's own question has an intro. */
  private question(key: string, caption: string, input: Record<string, string>, intro?: string) {
    const form = node('form', '', 'assistant-question'), answer = field(caption, `answer-${key}`, this.answers.get(key) || '', true, this.ns); form.dataset.questionKey = key;
    answer.input.name = 'answer'; answer.input.required = true; answer.input.maxLength = 4000; answer.input.oninput = () => this.answers.set(key, answer.input.value);
    const submit = node('button', 'Svara Tabai', 'primary'); submit.type = 'submit'; submit.id = `${this.ns}-answer-${key}`;
    if (intro) form.append(node('p', intro, 'muted'));
    form.append(answer.wrapper, submit);
    form.onsubmit = async event => { event.preventDefault(); if (form.reportValidity() && await this.act('reply', { ...input, answer: answer.input.value })) this.answers.delete(key); };
    return form;
  }

  // One mail
  private openItem(id: string) {
    this.listScroll = document.scrollingElement?.scrollTop ?? 0;
    if (this.itemId !== id) this.evidenceFor = undefined;
    this.itemId = id; this.page = 'item'; this.confirmSend = undefined; this.detailMenuKey = ''; this.remindKey = '';
    this.render(); this.hooks.pageChanged();
    this.element.scrollIntoView({ block: 'start' });
    this.focusPage();
  }
  /** Back to the list after leaving one mail, the checks or the cases, focus on the nearest row. */
  private leavePage(focusItem?: string) {
    const wasItem = this.page === 'item';
    this.page = 'inbox'; this.itemId = undefined; this.confirmSend = undefined; this.evidenceFor = undefined;
    this.detailPopover.close(); this.remindPopover.close();
    this.render(); this.hooks.pageChanged();
    if (wasItem && document.scrollingElement) document.scrollingElement.scrollTop = this.listScroll;
    if (focusItem !== undefined) this.focusRow(focusItem);
  }
  /** Focus back on what opened Kontroller or Ärenden, or on ⋯ when that is gone or was in a menu. */
  private focusOpener() {
    const opener = this.opener; this.opener = undefined;
    const usable = !!opener?.isConnected && !opener.closest('[hidden], [popover]') && opener.getClientRects().length > 0;
    (usable ? opener! : this.moreButton).focus({ preventScroll: true });
  }
  private focusRow(id?: string) {
    const row = id ? this.inbox.querySelector<HTMLElement>(`#${CSS.escape(`${this.ns}-row-${id}`)}`) : undefined;
    (row && !row.closest('[hidden]') ? row : this.tabButtons[this.tab]).focus({ preventScroll: !!row });
  }
  /** The row after this one in the open tab, or the one before when it was last. */
  private neighbour(id: string) {
    const rows = [...this.panels[this.tab].querySelectorAll<HTMLElement>('.assistant-mail-row')].map(row => row.id.slice(`${this.ns}-row-`.length));
    const index = rows.indexOf(id);
    return index < 0 ? undefined : rows[index + 1] ?? rows[index - 1];
  }
  private latest(item: AssistantItem) { return this.workspace!.items.find(entry => entry.id === item.id) ?? item; }
  private renderDetail(item: AssistantItem) {
    const { settings, current } = this.workspace!, status = this.statusOf(item), card = assistantMailCard(item);
    const accountLabel = settings.accounts.find(entry => entry.id === item.accountId)?.label || item.accountId;
    // A question about text or a recipient that has changed since is never left open; a send
    // already on its way finishes first.
    const asked = this.confirmSend?.id === item.id ? this.confirmSend : undefined;
    if (asked && !this.sending.has(item.id) && (card !== 'reply' || !item.recipient || item.revision !== asked.revision)) {
      this.confirmSend = undefined;
      if (card === 'reply') this.showToast('Mejlet ändrades. Läs svaret igen och tryck Skicka svaret.');
    }
    this.detail.dataset.itemId = item.id; this.detail.dataset.status = item.status; this.detail.dataset.card = card;
    this.detailMeta.replaceChildren(this.chip(status), node('span', accountLabel, 'muted'));
    const body = this.detailBody; body.replaceChildren();
    const title = node('h3', item.title, 'assistant-mail-detail-title'); title.id = `${this.ns}-detail-title`; title.tabIndex = -1;
    body.append(title);
    if (item.sender) body.append(node('p', `Från ${item.sender}`, 'muted assistant-mail-from'));
    if (item.summary) body.append(node('p', item.summary, 'module-summary'));
    body.append(node('p', item.reason, 'assistant-reason'));
    if (item.deadline) body.append(node('p', `Senast: ${item.deadline}`, 'assistant-deadline'));
    if (this.evidenceFor === item.id) {
      const evidence = node('section', '', 'assistant-mail-evidence'), heading = node('h4', 'Det här läste Tabai');
      heading.id = `${this.ns}-evidence`; heading.tabIndex = -1; evidence.setAttribute('aria-labelledby', heading.id); evidence.append(heading);
      for (const entry of item.sources) evidence.append(node('blockquote', entry.quote));
      body.append(evidence);
    }
    const task = this.renderTask(item, card, accountLabel, current?.status === 'running' || current?.status === 'waiting');
    this.renderModuleTask(task, item); body.append(task);
    this.renderSecondary(item, card);
    this.renderDetailMenu(item);
  }
  /** The card's sentence and its one main button, or the reply with its own confirmation. */
  private renderTask(item: AssistantItem, card: Card, accountLabel: string, running: boolean) {
    const task = node('section', '', 'assistant-mail-task'), sentence = node('p', '', 'assistant-mail-next');
    task.dataset.card = card; sentence.id = `${this.ns}-next`; sentence.tabIndex = -1;
    task.setAttribute('aria-labelledby', sentence.id); task.append(sentence);
    const say = (text: string, tone?: 'danger' | 'success') => { sentence.textContent = text; if (tone) sentence.dataset.tone = tone; };
    // A mail that is no longer open reports what happened to it.
    if (item.status !== 'open') sentence.setAttribute('role', 'status');
    // The id names the action, so focus kept across a poll never lands on a different one.
    const main = (label: string, action: () => void, kind: string) => {
      const control = button(label, action, 'primary assistant-mail-main'); control.id = `${this.ns}-main-${kind}`; control.dataset.main = kind;
      task.append(control); return control;
    };
    const openInAccount = () => { main(`Öppna i ${accountLabel}`, () => void this.act('open', { accountId: item.accountId, itemId: item.id }), 'open-account'); };
    const done = () => { main('Klar', () => void this.markDone(item), 'done').dataset.markDone = item.id; };
    switch (card) {
      case 'uncertain':
        say(sentences.uncertain, 'danger'); openInAccount();
        if (item.pendingFinding) { const later = node('p', 'Ett nytt meddelande har kommit i tråden. Det visas här när du har svarat på frågan nedan.'); later.dataset.pendingMessage = 'true'; task.append(later); }
        task.append(node('p', 'Tabai skickar inte svaret igen.', 'muted'));
        this.renderResolve(task, item); break;
      case 'sending': say('Svaret skickas nu.'); break;
      case 'sent': say('Svaret är skickat.', 'success'); if (item.sendReceipt) task.append(node('p', item.sendReceipt, 'muted')); break;
      case 'resolved': say(item.resolution?.reason || 'Redan besvarat, så inget svar behövs.', 'success'); break;
      case 'dismissed':
        say(item.feedback === 'no-reply' ? 'Du markerade att inget svar behövs.' : 'Du är klar med det här mejlet.');
        task.append(node('p', 'Vill du ha tillbaka det i Att göra? Välj Flytta tillbaka under ⋯.', 'muted')); break;
      case 'snoozed':
        say('Tabai påminner dig ');
        if (item.snoozedUntil) sentence.append(moment(item.snoozedUntil, this.workspace!.settings.timezone), '.'); else sentence.append('senare.');
        break;
      case 'question':
        say(sentences.question);
        task.append(this.question(item.id, item.question!, { itemId: item.id, revision: String(item.revision) }));
        task.querySelector<HTMLElement>('button[type="submit"]')!.dataset.main = 'answer'; break;
      case 'rewriting': say(sentences.rewriting); break;
      case 'reply': say(sentences.reply); this.renderCompose(task, item, running, true); break;
      case 'self': say(sentences.self(accountLabel)); openInAccount(); break;
      case 'info': say(sentences.info); done(); break;
      case 'needs-you': say(sentences['needs-you']); if (item.draft !== undefined) this.renderCompose(task, item, running, false); done(); break;
    }
    if (item.answer) sentence.after(node('p', `Du svarade: ${item.answer}`, 'muted'));
    return task;
  }
  /**
   * After checking Skickat in the account the user says what happened, at the revision the card
   * shows. Neither choice sends anything: a reply that did not go out needs Skicka again.
   */
  private renderResolve(task: HTMLElement, item: AssistantItem) {
    const question = node('p', 'Hittade du svaret i Skickat?'), choices = node('div', '', 'assistant-actions assistant-mail-resolve');
    question.id = `${this.ns}-resolve-question`; choices.setAttribute('role', 'group'); choices.setAttribute('aria-labelledby', question.id);
    for (const [outcome, label] of [['sent', 'Det skickades'], ['not-sent', 'Det skickades inte']] as const) {
      const control = button(label, () => void this.resolveUncertain(item, outcome)); control.id = `${this.ns}-resolve-${outcome}`; control.dataset.resolve = outcome;
      choices.append(control);
    }
    task.append(question, choices);
  }
  private async resolveUncertain(item: AssistantItem, outcome: 'sent' | 'not-sent') {
    if (!await this.act('correct', { action: 'resolve-uncertain', itemId: item.id, revision: String(item.revision), outcome })) return;
    this.showToast(outcome === 'sent' ? 'Svaret är markerat som skickat.' : 'Svaret är markerat som inte skickat. Inget skickas förrän du godkänner det igen.');
    this.render();
    if (this.page === 'item' && this.itemId === item.id) this.detail.querySelector<HTMLElement>('.assistant-mail-next')?.focus({ preventScroll: true });
  }
  /**
   * Below the main button: Klar, which is Inget svar behövs (the no-reply feedback) on a card
   * with Tabai's reply or a question about one, and Påminn mig. Klar is left out where the main
   * button is already Klar. A reply the user writes themselves keeps Klar for when it is done.
   */
  private renderSecondary(item: AssistantItem, card: Card) {
    const open = item.status === 'open';
    this.secondary.hidden = !open;
    delete this.doneButton.dataset.markDone; delete this.doneButton.dataset.feedback;
    if (!open) { this.remindPopover.close(); return; }
    this.renderModuleStarts(item);
    this.doneButton.hidden = card === 'info' || card === 'needs-you';
    if ((card === 'reply' || card === 'question' || card === 'rewriting') && replyKind(item) && !item.feedback) {
      this.doneButton.textContent = 'Inget svar behövs'; this.doneButton.dataset.feedback = 'no-reply';
      this.doneButton.onclick = () => void this.feedback(item, 'no-reply');
    } else {
      this.doneButton.textContent = 'Klar'; this.doneButton.dataset.markDone = item.id;
      this.doneButton.onclick = () => void this.markDone(item);
    }
    this.renderRemindMenu(item);
  }
  /** Local modules that start from a mail or list cases started from one. Only a change re-renders, so a poll keeps focus. */
  setModules(modules: PersonalModule[]) {
    const next = modules.flatMap(module => {
      const view = module.view;
      return view && !view.assistant && !module.error && (view.mailStart || view.mailRuns?.length) ? [{ id: module.id, title: view.title, start: view.mailStart, runs: view.mailRuns ?? [] }] : [];
    });
    const key = JSON.stringify(next);
    if (key === this.mailModulesKey) { this.markHandled(); return; }
    this.mailModulesKey = key; this.mailModules = next;
    if (this.page === 'item' && this.workspace) this.render();
    this.markHandled();
  }
  /** Per module: the case this mail started, or the start it offers (as the main action when the mail reads like the module's request). */
  private mailLinks(item: AssistantItem): MailLink[] {
    const account = this.workspace!.settings.accounts.find(entry => entry.id === item.accountId), address = sameAddress(item.sourceUrl);
    const text = `${item.title} ${item.summary}`.toLocaleLowerCase('sv-SE');
    return this.mailModules.flatMap((module): MailLink[] => {
      const run = module.runs.find(entry => sameAddress(entry.link) === address);
      if (run) return [{ module, run }];
      const start = module.start;
      if (!start || (start.providers && !(account && start.providers.includes(account.provider)))) return [];
      return [{ module, start, request: !!start.keywords?.some(word => wordIn(text, word)) }];
    });
  }
  /** The quiet start buttons; a linked case and a request's start are part of the task above. */
  private renderModuleStarts(item: AssistantItem) {
    const quiet = this.mailLinks(item).flatMap(link => 'start' in link && !link.request ? [link] : []);
    const key = JSON.stringify([quiet.map(link => link.module.id), this.mailModulesKey, item.id, item.revision]);
    if (key === this.moduleStartsKey) return;
    this.moduleStartsKey = key;
    this.moduleStarts.replaceChildren(...quiet.map(({ module, start }) => {
      const control = button(start.label, () => void this.startModule(module.id, start, item), 'assistant-mail-small'); control.dataset.mailStart = module.id;
      control.id = `${this.ns}-mail-start-${module.id}`; // a redraw puts focus back by id
      return control;
    }));
  }
  /** A linked case's state with Öppna ärendet, and the start as the main action on mail that reads like a request. */
  private renderModuleTask(task: HTMLElement, item: AssistantItem) {
    if (item.status !== 'open') return;
    for (const link of this.mailLinks(item)) {
      if ('run' in link) {
        const line = node('div', '', 'assistant-mail-module-run'); line.dataset.mailRun = link.run.runId;
        const open = button('Öppna ärendet', () => void this.openModuleRun(link.module.id, link.run.runId), 'quiet'); open.id = `${this.ns}-module-run-${link.module.id}`;
        line.append(node('p', `${link.module.title}: ${link.run.label}`, 'muted'), open); task.append(line);
      } else if (link.request) {
        const line = node('div', '', 'assistant-mail-module-request');
        const start = button(link.start.label, () => void this.startModule(link.module.id, link.start, item), 'primary assistant-mail-main');
        start.id = `${this.ns}-main-module-${link.module.id}`; start.dataset.main = 'module-start'; start.dataset.mailStart = link.module.id;
        line.append(node('p', 'Det här ser ut som en förfrågan.', 'muted'), start);
        // The request's start is the one main action; the card's own buttons stay, no longer primary.
        task.querySelectorAll<HTMLElement>('.assistant-mail-main.primary').forEach(control => control.classList.remove('primary'));
        task.querySelector('.assistant-mail-next')!.after(line);
      }
    }
  }
  private async openModuleRun(moduleId: string, runId: string) {
    if (!await this.flushDrafts()) return;
    const error = await this.hooks.openModule(moduleId, runId);
    if (typeof error === 'string') this.showToast(error);
  }
  /**
   * Marks one open mail Klar whose case the module calls handled, if the mail has not changed since:
   * Ångra changes it, so an undone Klar holds across reloads. One try per mail and panel.
   */
  private markHandled() {
    if (this.autoMarking || !this.workspace || !this.mailModules.some(module => module.runs.some(run => run.handled))) return;
    // Only where its Ångra can be seen, and never over another notice with its own Ångra.
    if (this.element.closest('[hidden]') || this.toastRegion.childElementCount) return;
    const handledSince = (entry: AssistantItem) => this.mailLinks(entry).some(link => 'run' in link && link.run.handled && !!link.run.handledAt && Date.parse(entry.updatedAt) < Date.parse(link.run.handledAt));
    const item = this.workspace.items.find(entry => entry.status === 'open' && !this.autoDone.has(entry.id) && handledSince(entry));
    if (!item) return;
    this.autoDone.add(item.id); this.autoMarking = true;
    // Saving a draft first changes the mail (a reply the user was still writing, say): the condition is
    // judged again on the mail after the flush, and Klar carries the revision it was judged on, so the
    // host refuses it if the mail changed in between.
    const revision = item.revision;
    void (async () => {
      try {
        if (!await this.flushDrafts()) return;
        const current = this.latest(item);
        if (current.revision !== revision || current.status !== 'open' || !handledSince(current)) return;
        if (await this.act('correct', { action: 'dismiss', itemId: item.id, revision: String(revision) })) this.offerUndo(item.id, `Klar, ärendet är avslutat: ${item.title}`);
      } finally { this.autoMarking = false; }
    })();
  }
  /**
   * Opens the module with its start form filled from this mail. The user starts it from the card.
   * Only what finds the mail goes in: a module may read the field as the owner's own request, so
   * the mail's content (or Tabai's summary of it) is never written there.
   */
  private async startModule(id: string, start: MailStart, item: AssistantItem) {
    if (!await this.flushDrafts()) return;
    const account = this.workspace!.settings.accounts.find(entry => entry.id === item.accountId);
    const values: Record<string, string> = { [start.mailField]: `Mejl från ${item.sender || 'okänd avsändare'}${account ? ` i ${account.label}` : ''}: ”${item.title}”`.slice(0, 4000) };
    if (start.accountField && account) values[start.accountField] = providerNames[account.provider];
    // The mail's own address tells the module where the mail is; fields it names are emptied.
    if (start.linkField) values[start.linkField] = item.sourceUrl;
    for (const name of start.clearFields ?? []) values[name] = '';
    const error = await this.hooks.openModule(id, undefined, values);
    if (typeof error === 'string') this.showToast(error);
  }
  private renderRemindMenu(item: AssistantItem) {
    const zone = this.workspace!.settings.timezone;
    // The local day is in the key: the times ("i morgon 08:00") change at midnight in the user's zone.
    const key = JSON.stringify([item.id, zone, localDay(new Date(), zone)]);
    if (key === this.remindKey) return;
    this.remindKey = key; this.remindMenu.replaceChildren(node('p', 'Påminn mig', 'assistant-menu-title'));
    for (const [at, label] of reminders) {
      const control = menuItem(label, when(assistantReminderAt(new Date(), zone, at), zone), () => { this.remindPopover.close(); void this.snooze(item, at); });
      control.dataset.mailAction = `snooze-${at}`; this.remindMenu.append(control);
    }
  }
  /** ⋯ on a mail: the original, Tabai's quotes, the sender, a chat, what Tabai learns, and Flytta tillbaka. */
  private renderDetailMenu(item: AssistantItem) {
    const { settings } = this.workspace!, webOff = !assistantWebEnabled(settings.web), showing = this.evidenceFor === item.id;
    const key = JSON.stringify([item.id, item.revision, item.status, item.draft !== undefined, item.feedback, item.sender, item.recipient, item.replyFrom, item.sourceUrl, webOff, showing]);
    if (key === this.detailMenuKey) return;
    this.detailMenuKey = key; this.detailMenu.replaceChildren();
    const close = (action: () => void) => () => { this.detailPopover.close(); action(); };
    const entry = (label: string, detail: string, action: () => void, data: Record<string, string>) => {
      const control = menuItem(label, detail, close(action)); Object.assign(control.dataset, data); this.detailMenu.append(control); return control;
    };
    const original = sourceLink('', item.sourceUrl);
    if (original instanceof HTMLAnchorElement) {
      const text = node('span', '', 'assistant-menu-text'); text.append(node('span', 'Öppna originalet', 'assistant-menu-label'), node('span', 'I en ny flik', 'muted'));
      original.className = 'assistant-menu-item'; original.dataset.mailAction = 'original'; original.append(text);
      original.addEventListener('click', () => this.detailPopover.close());
      this.detailMenu.append(original);
    }
    entry(showing ? 'Dölj vad Tabai läste' : 'Visa vad Tabai läste', 'Citaten Tabai byggde förslaget på', () => this.toggleEvidence(item.id), { mailAction: 'evidence' });
    const lookup = senderLookup(item.recipient || item.sender, true, webOff, close(() => this.hooks.lookupSender(item.id, this.latest(item).revision)));
    lookup.querySelector('button')!.className = 'assistant-menu-item';
    this.detailMenu.append(lookup);
    entry('Chatta om detta', 'Ett nytt samtal om just det här mejlet', () => this.hooks.chatContext('item', item.id, this.latest(item).revision), { mailAction: 'chat' });
    if (item.status === 'open' && !item.feedback && (replyKind(item) || item.draft !== undefined)) {
      this.detailMenu.append(node('p', 'Lär Tabai', 'assistant-menu-title assistant-menu-section'));
      entry('Kortare svar', 'Tabai skriver kortare svar framöver', () => void this.feedback(item, 'shorter'), { feedback: 'shorter' });
      if (item.sender) entry('Prioritera avsändaren', 'Mejl härifrån hamnar först', () => void this.feedback(item, 'prioritize-sender'), { feedback: 'prioritize-sender' });
    }
    // Klar and Inget svar behövs can be taken back after Ångra has gone, at the mail's current revision.
    if (item.status === 'dismissed') {
      this.detailMenu.append(node('hr'));
      entry('Flytta tillbaka', 'Mejlet hamnar i Att göra igen', () => void this.reopen(item.id, this.latest(item).revision), { mailAction: 'reopen' });
    }
  }
  private toggleEvidence(id: string) {
    this.evidenceFor = this.evidenceFor === id ? undefined : id;
    this.render();
    if (this.evidenceFor) this.detail.querySelector<HTMLElement>('.assistant-mail-evidence h4')?.focus();
  }
  /**
   * The reply as a small compose box: "Till: …" above the text. With send, "Skicka svaret" asks
   * "Skicka till …?" in the card, and only its Skicka sends: exactly the saved text to the sourced
   * recipient at the mail's current revision, as before. Both wait while an edit is being saved.
   */
  private renderCompose(task: HTMLElement, item: AssistantItem, running: boolean, sendable: boolean) {
    let draft = this.drafts.get(item.id);
    if (!draft) { draft = { body: item.draft || '', dirty: false, version: 0, saving: false, message: '', failed: false }; this.drafts.set(item.id, draft); }
    if (!draft.dirty && !draft.saving) draft.body = item.draft || '';
    const state = draft, box = node('div', '', 'assistant-mail-compose');
    const to = node('p', item.recipient ? `Till: ${item.recipient}` : sendable ? 'Till: mottagaren saknas i mejlet' : 'Tabais förslag', 'assistant-mail-to');
    const label = node('label', sendable ? 'Ditt svar' : 'Tabais förslag', 'visually-hidden'), editor = node('textarea');
    to.id = `${this.ns}-to`; editor.id = `assistant-${this.ns}-draft-${item.id}`; editor.name = 'body'; editor.maxLength = 12000; editor.value = state.body;
    label.htmlFor = editor.id; editor.setAttribute('aria-describedby', to.id);
    if (item.replyFrom) box.append(node('p', `Från: ${item.replyFrom}`, 'assistant-mail-to'));
    box.append(to, label, editor);
    const receipt = node('p', state.message, 'muted assistant-draft-status'); receipt.setAttribute('role', 'status');
    // Saving is automatic; the button is offered only to try again after a failed save.
    const save = button('Spara utkast', () => void this.saveDraft(item.id), 'quiet'); save.hidden = !state.failed;
    task.append(box, receipt, save);
    let sync = () => {};
    editor.oninput = () => {
      state.body = editor.value; state.dirty = true; state.failed = false; state.version++; state.message = 'Ändringar sparas…';
      receipt.textContent = state.message; save.hidden = true;
      clearTimeout(state.timer); state.timer = setTimeout(() => void this.saveDraft(item.id), 600);
      // Changed text closes "Skicka till …?": the question was about the text before the change.
      if (this.confirmSend?.id === item.id && !this.sending.has(item.id)) { this.confirmSend = undefined; this.render(); return; }
      sync();
    };
    if (!sendable) return;
    const accountOn = this.workspace!.settings.accounts.some(account => account.id === item.accountId && account.enabled);
    const status = node('p', '', 'muted assistant-approval-status'); status.id = `${this.ns}-approval-status`;
    // The same conditions as the host's send; while an edit is saving the text sent would not be the text shown.
    const blocked = () => !!item.question || !item.recipient || !accountOn || !replyKind(item) || !state.body.trim() || running || state.dirty || state.saving || state.failed;
    const reason = () => (state.dirty || state.saving) && !state.failed ? 'Sparar utkastet…'
      : state.failed ? ''
      : !item.recipient ? 'Mottagaren saknas i mejlet, så svaret kan inte skickas härifrån.'
      : !accountOn ? 'Kontot är avstängt. Slå på det under Inställningar → Mejlkonton.'
      : running ? 'Vänta tills Tabai är klar med kontrollen.'
      : !state.body.trim() ? 'Skriv ett svar först.' : '';
    let control: HTMLButtonElement;
    if (this.confirmSend?.id !== item.id) {
      control = button('Skicka svaret', () => {
        if (control.disabled) return;
        this.confirmSend = { id: item.id, revision: item.revision }; this.render();
        // Focus lands on Avbryt: a held or repeated Enter never reaches Skicka by itself.
        this.detail.querySelector<HTMLElement>('[data-send-cancel]')?.focus();
      }, 'primary assistant-mail-main');
      control.id = `${this.ns}-main-send`; control.dataset.main = 'send'; control.dataset.sendOpen = item.id; control.setAttribute('aria-describedby', status.id);
      task.append(control);
    } else {
      const confirm = node('div', '', 'assistant-mail-confirm assistant-mail-send-confirm'), question = node('p', item.replyFrom ? `Skicka från ${item.replyFrom} till ${item.recipient}?` : `Skicka till ${item.recipient}?`), actions = node('div', '', 'assistant-actions');
      question.id = `${this.ns}-send-question`; confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-labelledby', question.id);
      const cancel = button('Avbryt', () => this.cancelSend()); cancel.id = `${this.ns}-send-cancel`; cancel.dataset.sendCancel = item.id;
      control = button('Skicka', () => void this.send(item.id, control), 'primary'); control.id = `${this.ns}-send`; control.dataset.approve = item.id;
      control.setAttribute('aria-describedby', `${question.id} ${status.id}`);
      actions.append(cancel, control); confirm.append(question, actions); task.append(confirm);
    }
    task.append(status);
    sync = () => {
      status.textContent = reason(); status.hidden = !status.textContent;
      control.dataset.blocked = String(blocked()); control.disabled = this.busy || control.dataset.blocked === 'true';
    };
    sync();
  }
  private cancelSend() {
    this.confirmSend = undefined; this.render(); this.focusAfterConfirm();
  }
  /** Focus after the question closes: Skicka svaret, or the card's sentence when it cannot be pressed. */
  private focusAfterConfirm() {
    const open = this.detail.querySelector<HTMLButtonElement>('[data-send-open]');
    (open && !open.disabled ? open : this.detail.querySelector<HTMLElement>('.assistant-mail-next'))?.focus({ preventScroll: true });
  }
  /** Skicka in the card's confirmation: one send action, never a second one for the same mail. */
  private async send(itemId: string, control: HTMLButtonElement) {
    const state = this.drafts.get(itemId), current = this.workspace!.items.find(candidate => candidate.id === itemId);
    if (control.disabled || !state || !current || this.sending.has(itemId)) return;
    const approved = state.body; clearTimeout(state.timer);
    this.sending.add(itemId);
    let ok = false;
    try { ok = await this.act('correct', { action: 'send', itemId, revision: String(current.revision), body: approved, recipient: current.recipient || '', ...(current.replyFrom ? { sender: current.replyFrom } : {}) }); }
    finally { this.sending.delete(itemId); }
    if (this.confirmSend?.id === itemId) this.confirmSend = undefined;
    // The approved text is the mail's draft now. Text typed while the send was on its way is
    // never saved over it, and a draft left dirty would block every way out of the mail.
    if (ok) this.dropDraft(itemId, state.body !== approved ? 'Svaret är godkänt. Det du skrev efter godkännandet sparades inte.' : undefined);
    this.render();
    // After a send the card says what happened; after a refusal Skicka svaret is back.
    if (this.page === 'item' && this.itemId === itemId && !this.element.contains(document.activeElement)) {
      if (ok) this.detail.querySelector<HTMLElement>('.assistant-mail-next')?.focus({ preventScroll: true }); else this.focusAfterConfirm();
    }
  }
  /** Forgets a draft that can no longer be saved, saying so when unsaved text is lost. */
  private dropDraft(itemId: string, notice?: string) {
    const state = this.drafts.get(itemId); if (!state) return;
    clearTimeout(state.timer); this.drafts.delete(itemId);
    if (notice) this.showToast(notice);
  }
  private async saveDraft(itemId: string) {
    const state = this.drafts.get(itemId), item = this.workspace?.items.find(candidate => candidate.id === itemId);
    if (!state || !state.dirty || state.saving || this.disposed) return true;
    // A mail sent, done or gone meanwhile takes no draft; holding the text would block leaving it.
    if (item?.status !== 'open') { this.dropDraft(itemId, 'Mejlet är inte längre öppet, så ändringen i svaret sparades inte.'); return true; }
    if (this.busy) { state.timer = setTimeout(() => void this.saveDraft(itemId), 350); return false; }
    const version = state.version, body = state.body; state.saving = true; state.failed = false; state.message = 'Sparar utkast…';
    const ok = await this.act('correct', { action: 'draft', itemId, revision: String(item.revision), body }); state.saving = false;
    if (ok && version === state.version) { state.dirty = false; state.message = 'Utkastet är sparat.'; }
    else if (!ok) { state.failed = true; state.message = 'Utkastet kunde inte sparas. Texten finns kvar. Välj Spara utkast för att försöka igen.'; }
    if (ok && state.dirty) { state.message = 'Ändringar sparas…'; clearTimeout(state.timer); state.timer = setTimeout(() => void this.saveDraft(itemId), 350); }
    if (!this.disposed) this.render(); return ok;
  }

  // Actions on mail
  private async markDone(item: AssistantItem) {
    if (!await this.flushDrafts()) return;
    const next = this.neighbour(item.id);
    const ok = await this.act('correct', { action: 'dismiss', itemId: item.id, revision: String(this.latest(item).revision) });
    if (!ok) return;
    this.offerUndo(item.id, `Klar: ${item.title}`);
    this.afterRemoval(next);
  }
  private async markAllDone(info: AssistantItem[]) {
    this.confirmAll = false;
    const items = info.map(item => this.latest(item)).filter(item => item.status === 'open');
    const ok = await this.act('correct', { action: 'dismiss-many', items: JSON.stringify(items.map(({ id, revision }) => ({ id, revision }))) });
    if (!ok) { this.render(); return; }
    this.showToast(`${items.length} mejl för kännedom är markerade som klara.`);
    this.focusRow(this.panels.todo.querySelector<HTMLElement>('.assistant-mail-row')?.id.slice(`${this.ns}-row-`.length));
  }
  private async snooze(item: AssistantItem, at: 'tomorrow' | 'next-week') {
    if (!await this.flushDrafts()) return;
    const zone = this.workspace!.settings.timezone, until = assistantReminderAt(new Date(), zone, at);
    const next = this.neighbour(item.id);
    const ok = await this.act('correct', { action: 'snooze', itemId: item.id, revision: String(this.latest(item).revision), until });
    if (!ok) return;
    this.showToast(`Tabai påminner dig ${when(until, zone)}: ${item.title}`);
    this.afterRemoval(next);
  }
  private async feedback(item: AssistantItem, kind: 'no-reply' | 'prioritize-sender' | 'shorter') {
    if (!await this.flushDrafts()) return;
    const next = this.neighbour(item.id);
    const ok = await this.act('correct', { action: 'feedback', kind, itemId: item.id, revision: String(this.latest(item).revision) });
    if (!ok) return;
    if (kind === 'no-reply') { this.offerUndo(item.id, `Inget svar behövs: ${item.title}`); this.afterRemoval(next); return; }
    if (kind === 'shorter') {
      const preferences = this.workspace!.settings.preferences || { shortReplies: false, senderRules: [] };
      this.workspace!.settings.preferences = { ...preferences, shortReplies: true };
      this.showToast('Tabai skriver kortare svar framöver.');
    } else this.showToast('Mejl från avsändaren hamnar först framöver.');
  }
  /**
   * After Klar or Påminn the mail leaves Att göra: the list shows, with focus on the row that
   * followed it. The list behind the detail page stays rendered, so the neighbour is known first.
   */
  private afterRemoval(next?: string) {
    if (this.page === 'item') this.leavePage(next ?? '');
    else this.focusRow(next);
  }
  private offerUndo(id: string, text: string) {
    const saved = this.workspace!.items.find(entry => entry.id === id);
    if (saved?.status !== 'dismissed') { this.showToast(text); return; }
    const revision = saved.revision;
    this.showToast(text, () => { this.clearToast(); void this.reopen(id, revision); });
  }
  /**
   * Back to Att göra at the given revision only. A mail that changed since then is not reopened
   * blindly: the host refuses the older revision, and the user is told to look at it again.
   */
  private async reopen(id: string, revision: number) {
    const stale = 'Mejlet har ändrats sedan dess och flyttades inte tillbaka. Öppna det och titta igen.';
    const saved = this.workspace!.items.find(entry => entry.id === id);
    if (saved?.status !== 'dismissed' || saved.revision !== revision) { this.showToast(stale); return; }
    if (!await this.act('correct', { action: 'reopen', itemId: id, revision: String(revision) })) {
      this.showToast('Mejlet flyttades inte tillbaka. Det kan ha ändrats under tiden, så öppna det och försök igen.');
      return;
    }
    this.showToast('Mejlet är tillbaka i Att göra.');
    if (this.page === 'inbox') this.focusRow(id);
  }

  // Ångra and short confirmations
  private showToast(text: string, undo?: () => void) {
    this.clearToast();
    const toast = node('div', '', 'assistant-mail-toast');
    toast.append(node('span', text, 'assistant-mail-toast-text'));
    if (undo) { const control = button('Ångra', undo, 'assistant-mail-undo'); control.dataset.undo = 'true'; toast.append(control); }
    this.toastRegion.append(toast);
    this.toastLeft = UNDO_MS;
    this.resumeToast(); this.applyBusy();
  }
  private clearToast() { clearTimeout(this.toastTimer); this.toastTimer = undefined; this.toastRegion.replaceChildren(); this.toastHeld = { pointer: false, focus: false }; }
  /**
   * On the list, Ångra comes right after the open tab's rows, so Tab from the row that got focus
   * reaches it; on one mail or the checks it ends the page. Moving the region drops any hover or
   * focus it held, so its time runs again.
   */
  private placeToast() {
    const [parent, before] = this.page === 'inbox' ? [this.inbox, this.pager] : [this.element, null];
    if (this.toastRegion.parentElement === parent && this.toastRegion.nextSibling === before) return;
    parent.insertBefore(this.toastRegion, before);
    this.toastHeld = { pointer: false, focus: this.toastRegion.contains(document.activeElement) };
    this.resumeToast();
  }
  private pauseToast() {
    if (!this.toastTimer) return;
    clearTimeout(this.toastTimer); this.toastTimer = undefined; this.toastLeft -= Date.now() - this.toastSince;
  }
  private resumeToast() {
    if (this.toastTimer || !this.toastRegion.childElementCount || this.toastHeld.pointer || this.toastHeld.focus) return;
    this.toastSince = Date.now();
    this.toastTimer = setTimeout(() => this.clearToast(), Math.max(0, this.toastLeft));
  }

  // Checks, shortcuts and history
  private showRuns(shortcuts = false, opener?: HTMLElement) {
    this.opener = opener; this.page = 'runs'; this.render(); this.hooks.pageChanged();
    this.element.scrollIntoView({ block: 'start' });
    if (shortcuts) { this.shortcutRoot.open = true; this.shortcutRoot.scrollIntoView({ block: 'start' }); this.shortcutLabel.input.focus({ preventScroll: true }); }
    else this.focusPage();
  }
  /** Ärenden as its own page in Mejl, reached from ⋯ next to Kolla mina mejl. */
  openCase(id: string) { this.showCases(this.moreButton); this.cases.open(id); }
  private showCases(opener: HTMLElement) {
    this.opener = opener; this.page = 'cases'; this.render(); this.hooks.pageChanged();
    this.element.scrollIntoView({ block: 'start' });
    this.focusPage();
  }
  /** The current or latest check: one block with its status, coverage and every run action. */
  private progressKey = '';
  private helpAccount?: string;
  private continuationControl?: { id: string; element: HTMLDetailsElement };
  private renderProgress() {
    const { current: run, settings, lastChecks } = this.workspace!;
    const helps = runHelps(run);
    const key = JSON.stringify([run, settings.timezone, settings.accounts, lastChecks, this.helpAccount]);
    if (key === this.progressKey) return;
    this.progressKey = key; this.progress.replaceChildren();
    const active = run?.status === 'running' || run?.status === 'waiting';
    this.progress.append(node('h3', !run ? 'Ingen kontroll ännu' : active ? 'Pågående kontroll' : 'Senaste kontroll'));
    if (!run) this.progress.append(node('p', 'Ingen kontroll har körts ännu. Tryck på Kolla mina mejl i Mejl.', 'muted'));
    if (run) {
      const selectedHelp = helps.find(help => help.accountId === this.helpAccount) ?? run.help ?? helps[0];
      const block = node('div', '', `assistant-run assistant-overview-run assistant-run-${run.status}`); block.setAttribute('role', 'status');
      block.append(node('h4', run.label), node('p', run.status === 'waiting' && selectedHelp ? 'Kontrollen väntar på hjälp. Övriga kontons resultat är sparade.' : run.activity?.message || run.message, 'assistant-overview-message'), timestamp(run.updatedAt, settings.timezone));
      if (run.activity) {
        const progress = node('div', '', 'assistant-activity-progress'), stage = run.activity.stage;
        progress.append(node('p', `${run.activity.reviewedThreads} trådar bedömda och sparade${stage ? ` · ${stageLabels[stage]}` : ''}`, 'muted'));
        const totalAccounts = run.coverage.length, checkedAccounts = run.coverage.filter(item => item.status === 'checked').length;
        if (totalAccounts) { const meter = node('progress'); meter.max = totalAccounts; meter.value = checkedAccounts; meter.setAttribute('aria-label', 'Kontotäckning'); progress.append(meter); }
        block.append(progress);
      }
      if (run.summary) {
        if (run.summary.length > 500) { const summary = details('Sammanfattning', 'assistant-run-summary'); summary.append(node('p', run.summary, 'module-summary')); block.append(summary); }
        else block.append(node('p', run.summary, 'module-summary'));
      }
      const actions = node('div', '', 'assistant-actions');
      if (active) actions.append(button('Stoppa uppdraget', () => void this.act('stop')));
      if (run.status === 'paused' && run.task !== 'send' && run.externalEffect !== 'possible') actions.append(button('Fortsätt uppdraget', () => void this.act('resume'), 'primary'));
      const hasGaps = run.status === 'failed' || run.coverage.some(item => gaps.includes(item.status)) || !!run.help;
      if (!selectedHelp && run.externalEffect !== 'possible' && run.task !== 'send' && (run.status === 'review' || run.status === 'failed' || (run.status === 'waiting' && !!run.help)) && !run.question && hasGaps) {
        actions.append(button(run.status === 'waiting' && run.help ? 'Fortsätt efter hjälpen' : 'Fortsätt saknade delar', () => void this.act('resume'), 'primary'));
      }
      if (!selectedHelp || run.status === 'running') actions.append(this.showWorkButton); block.append(actions);
      if (run.model || run.agent) block.append(node('p', `Modell: ${assistantChatModelLabel(run.model ?? assistantChatModel(run.agent))}`, 'muted'));
      if (run.externalEffect === 'none' && run.status !== 'running' && run.task !== 'send' && (run.status === 'paused' || hasGaps) && !run.question) {
        const continuationId = `${run.id}:${selectedHelp?.accountId ?? ''}`;
        if (this.continuationControl?.id !== continuationId) this.continuationControl = { id: continuationId, element: modelContinuation(run.model ?? assistantChatModel(run.agent ?? settings.agent), this.busy, model => this.act('resume', { runId: run.id, model, ...(selectedHelp ? { helpAccountId: selectedHelp.accountId } : {}) })) };
        block.append(this.continuationControl.element);
      }
      if (run.externalEffect === 'possible') block.append(node('p', 'Ett tidigare steg kan redan ha utförts. Kontrollera utfallet innan du startar en ny kontroll.', 'notice'));
      if (selectedHelp) {
        const help = node('aside', '', 'assistant-help'); help.setAttribute('role', 'note'); help.dataset.helpAccount = selectedHelp.accountId;
        help.append(node('strong', `${settings.accounts.find(account => account.id === selectedHelp.accountId)?.label ?? 'Kontot'} behöver hjälp`), node('p', selectedHelp.message));
        const helpActions = node('div', '', 'assistant-actions');
        helpActions.append(button('Öppna den blockerade fliken', () => void this.act('open', { helpAccountId: selectedHelp.accountId })));
        if (run.status !== 'running' && run.externalEffect !== 'possible' && !run.question && run.task !== 'send') helpActions.append(button('Kontrollera och fortsätt', () => void this.act('resume', { runId: run.id, helpAccountId: selectedHelp.accountId }), 'primary'));
        help.append(helpActions); block.append(help);
      }
      if (run.status === 'failed') block.append(node('p', 'Uppdraget kunde inte slutföras. Kontrollera kontona innan du startar ett nytt uppdrag.', 'muted'));
      this.progress.append(block);
    }
    const coverage = node('div', '', 'assistant-coverage');
    for (const account of settings.accounts.filter(account => account.enabled)) {
      const record = run?.coverage.find(item => item.accountId === account.id), row = node('div', '', 'assistant-coverage-row'); row.dataset.accountId = account.id; row.dataset.coverage = record?.status || 'pending';
      const accountHelp = helps.some(help => help.accountId === account.id);
      const needsHelp = accountHelp || record?.status === 'login';
      row.dataset.tone = needsHelp ? 'danger' : record && gaps.includes(record.status) ? 'warning' : 'normal';
      row.append(node('h5', account.label), node('p', record ? coverageLabels[record.status] : 'Inte kollat i den här kontrollen', 'assistant-coverage-status'));
      if (record?.message && !accountHelp) row.append(node('p', record.message, 'muted'));
      const progress = run?.accountProgress?.find(entry => entry.accountId === account.id);
      if (progress) row.append(node('p', `${progress.reviewedThreads} trådar bedömda och sparade`, 'muted'));
      const cursors = Object.entries(lastChecks).filter(([key]) => key.endsWith(`:${account.id}`)).map(([, value]) => value);
      const checked = record?.checkedAt || (run ? lastChecks[`${run.task}:${account.id}`] : undefined) || cursors.sort((first, second) => Date.parse(second) - Date.parse(first))[0];
      if (checked) { const last = node('p', 'Senast kollat: ', 'muted'); last.append(timestamp(checked, settings.timezone)); row.append(last); }
      if (record && gaps.includes(record.status) && !accountHelp) {
        const link = sourceLink('Öppna kontot i en ny flik', account.url); link.classList.add('assistant-account-link');
        row.append(button('Öppna kontot', () => void this.act('open', { accountId: account.id })), link);
      }
      coverage.append(row);
    }
    if (coverage.childElementCount) {
      const accounts = settings.accounts.filter(account => account.enabled), checked = run?.coverage.filter(item => item.status === 'checked').length || 0;
      const remaining = accounts.length - checked, needHelp = accounts.filter(account => helps.some(help => help.accountId === account.id) || run?.coverage.some(entry => entry.accountId === account.id && entry.status === 'login')).length;
      const group = details(`${checked} av ${accounts.length} konton kollade${remaining ? ` · ${remaining} återstår` : ''}${needHelp ? ` · ${needHelp} behöver hjälp` : ''}`, 'assistant-coverage');
      group.append(coverage); this.progress.append(group);
    }
  }
  private renderShortcuts() {
    const { shortcuts } = this.workspace!; this.shortcutList.replaceChildren();
    if (!shortcuts.length) this.shortcutList.append(node('p', 'Inga egna snabbknappar ännu.', 'muted'));
    for (const shortcut of shortcuts) {
      const row = node('div', '', 'assistant-shortcut'); row.dataset.shortcutRow = shortcut.id;
      row.append(node('strong', shortcut.label), node('p', shortcut.instructions, 'muted'));
      const actions = node('div', '', 'assistant-actions');
      actions.append(button('Redigera', () => { this.shortcutId = shortcut.id; this.shortcutLabel.input.value = shortcut.label; this.shortcutInstructions.input.value = shortcut.instructions; this.shortcutLabel.input.focus(); }), button('Ta bort', () => void this.act('correct', { action: 'delete-shortcut', id: shortcut.id })));
      row.append(actions); this.shortcutList.append(row);
    }
  }
  private renderHistory() {
    const { history, settings, current } = this.workspace!, working = current?.status === 'running' || current?.status === 'waiting';
    this.history.replaceChildren(node('summary', 'Tidigare kontroller'));
    if (!history.length) this.history.append(node('p', 'Inga tidigare kontroller ännu.', 'muted'));
    for (const run of history) {
      const record = node('div', '', 'assistant-history-entry'); record.append(node('h4', run.label), node('p', run.summary || run.message, 'module-summary'), timestamp(run.updatedAt, settings.timezone));
      if (run.coverage.length) record.append(node('p', run.coverage.map(coverage => `${settings.accounts.find(account => account.id === coverage.accountId)?.label || coverage.accountId}: ${coverageLabels[coverage.status]}`).join(' · '), 'muted'));
      if (run.canContinue && run.task !== 'send') {
        const resume = button('Fortsätt den här kontrollen', async () => { if (await this.flushDrafts() && await this.act('resume', { runId: run.id })) this.show('run'); });
        resume.dataset.blocked = String(working); record.append(resume);
      }
      this.history.append(record);
    }
  }
  private onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    // An open menu closes itself on Escape; only a second Escape leaves the page.
    if (this.element.querySelector(':popover-open')) return;
    if (this.confirmAll && this.page === 'inbox') { event.preventDefault(); this.cancelConfirm(); return; }
    // Escape while writing a reply, an answer or a case stays on the page; it leaves from anywhere else.
    const writing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
    if (this.page !== 'inbox' && writing) return;
    // Escape in the send question is Avbryt: nothing is sent. Once Skicka is on its way it is
    // not taken back, so Escape then does nothing rather than look like a cancel.
    if (this.page === 'item' && this.confirmSend) { event.preventDefault(); if (!this.sending.has(this.confirmSend.id)) this.cancelSend(); return; }
    if (this.page !== 'inbox') { event.preventDefault(); void this.back(); }
  }
}
