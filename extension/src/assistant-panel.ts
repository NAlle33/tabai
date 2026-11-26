import type { AssistantWorkspace } from '../../shared/assistant';
import { node } from './module-views';
import { button, icon, iconButton, section, timestamp, type AssistantAction } from './assistant-controls';
import { AssistantWatchList, AssistantWatchSettings } from './assistant-watch-settings';
import { AssistantRoutineSettings } from './assistant-routine-settings';
import { AssistantProfileSettings } from './assistant-profile-settings';
import { assistantWebEnabled } from '../../shared/assistant-web';
import { AssistantSettingsForm, type AssistantSettingsPart } from './assistant-settings';
import { AssistantMailMethodsPanel } from './assistant-mail-methods';
import { AssistantChatPanel } from './assistant-chat-panel';
import type { AssistantPreviewFetch } from './assistant-approval-preview';
import { assistantContextMenuSetting } from './assistant-context-menu';
import type { AssistantChatView } from '../../shared/assistant-chat';
import { AssistantMailView, type AssistantPendingModule } from './assistant-mail-view';
import type { PersonalModule } from '../../shared/personal-modules';
import type { AssistantLocalRuntime } from '../../shared/assistant-diagnostics';
import { applyAppearance, readAppearance, saveAppearance, panelTextSize, type PanelAppearance } from './panel-appearance';

export type { AssistantPendingModule } from './assistant-mail-view';
type AssistantView = 'chat' | 'mail' | 'tools' | 'settings' | 'watches';
type SettingsPage = 'general' | 'models' | 'accounts' | 'web' | 'watches' | 'routines' | 'memory' | 'cost' | 'advanced';
const settingsPages: [SettingsPage, string, string][] = [
  ['general', 'Allmänt', 'Utseende, textstorlek och tidszon'],
  ['models', 'Modeller och anslutningar', 'Chatt- och uppdragsmodell, anslutningar, Berget-nyckel och lokala modeller'],
  ['accounts', 'Mejlkonton', 'Konton, självtest, svarston, prioriterade avsändare och morgonkontroll'],
  ['web', 'Webbåtkomst', 'Vad agenten får göra på webben'],
  ['watches', 'Bevakningar', 'Sidor och sökningar som kontrolleras automatiskt, och deras modell'],
  ['routines', 'Rutiner', 'Frågor och uppdrag som körs på bestämda tider, och deras aviseringar'],
  ['memory', 'Minne', 'Sparade uppgifter och Mina uppgifter för formulär'],
  ['cost', 'Kostnad', 'Berget-förbrukning och budget'],
  ['advanced', 'Avancerat', 'Sessioner, Pågår, Recept, Historik och diagnostik'],
];
const settingsParts: Partial<Record<SettingsPage, AssistantSettingsPart>> = { general: 'general', models: 'agent', accounts: 'accounts', web: 'web' };
const viewTitles = { mail: 'Mejl', tools: 'Lokala verktyg', settings: 'Inställningar', watches: 'Bevakningar' };
let panelSequence = 0;

export class AssistantPanel {
  private namespace = `panel-${++panelSequence}`;
  private workspace!: AssistantWorkspace;
  private localRuntime?: AssistantLocalRuntime;
  private root = node('div', '', 'assistant-workspace');
  private header = node('header', '', 'assistant-topbar');
  private title = node('h2', '', 'assistant-topbar-title');
  private menuToggle = iconButton('menu', 'Visa samtal', () => this.chat.openConversations(this.menuToggle), 'assistant-menu-toggle');
  private backButton = iconButton('back', 'Tillbaka', () => void this.back(), 'assistant-back');
  private mailButton = button('', () => this.setView(this.activeView === 'mail' ? 'chat' : 'mail'), 'assistant-mode assistant-mail-button');
  private mailBadge = node('span', '', 'assistant-badge');
  private settingsButton = iconButton('settings', 'Inställningar', () => this.setView(this.activeView === 'settings' ? 'chat' : 'settings'), 'assistant-mode assistant-settings-button');
  private alerts = node('div', '', 'assistant-alerts');
  private moduleSelect = node('select');
  private moduleHost = node('div', '', 'assistant-inline-module');
  private moduleElements = new Map<string, HTMLElement>();
  private mail: AssistantMailView;
  private toolsRoot = node('section', '', 'assistant-view assistant-view-tools');
  private settingsRoot = node('section', '', 'assistant-view assistant-view-settings');
  private settingsList = node('nav', '', 'assistant-settings-list');
  private pages = {} as Record<SettingsPage, HTMLElement>;
  private technicalHost = node('div', '', 'assistant-technical-host');
  private settings: AssistantSettingsForm;
  private mailMethods: AssistantMailMethodsPanel;
  private chat: AssistantChatPanel;
  private chatView?: AssistantChatView;
  private chatRoot = node('section', '', 'assistant-view assistant-view-chat');
  private watchSettings: AssistantWatchSettings;
  private watchList: AssistantWatchList;
  private watchesRoot = node('section', '', 'assistant-view assistant-view-watches');
  private routineSettings: AssistantRoutineSettings;
  /** Where Tillbaka leads from the list: the chat, or the settings page it was opened from. */
  private watchesFrom: 'chat' | 'settings' = 'chat';
  private profileSettings: AssistantProfileSettings;
  private busy = false;
  private pendingModules: AssistantPendingModule[] = [];
  private pendingModulesKey = '';
  private activeView: AssistantView = 'chat';
  private settingsPage: SettingsPage | 'list' = 'list';
  private appearance: PanelAppearance = readAppearance();
  private appearanceMode!: HTMLSelectElement;
  private appearanceAccent!: HTMLSelectElement;
  private appearanceSize!: HTMLInputElement;
  private appearanceSizeValue = node('output');
  private appearanceStatus = node('p', '', 'muted assistant-appearance-status');
  private scheduleStatus = node('p', '', 'muted assistant-schedule-status');
  private navigationTask?: Promise<boolean>;
  /** Removes the permission listeners of the switch on Allmänt when the panel goes. */
  private stopContextMenu: () => void = () => {};
  /** `quiet` sends one step of an action already shown, such as an upload chunk; see AssistantChatHooks. */
  constructor(container: HTMLElement, private act: AssistantAction, private openModule: (id: string, runId?: string, start?: Record<string, string>) => void | string | Promise<void | string> = () => {}, _storageNamespace = 'default', private activateModuleHost: () => void = () => {}, preview?: AssistantPreviewFetch, quiet?: AssistantAction) {
    this.chat = new AssistantChatPanel(this.act, {
      showMail: target => void this.showMail(target), showChat: () => this.changeView('chat'), showTools: () => this.setView('tools'),
      openModule: (id, runId) => { void this.openModule(id, runId); }, beforeNavigate: () => this.flushDrafts(), openSettings: page => this.setView('settings', page),
      showWatches: () => this.openWatches('chat'), showRoutines: () => this.setView('settings', 'routines'), showCase: id => { void this.changeView('mail').then(changed => { if (changed) this.mail.openCase(id); }); }, preview, quiet,
    });
    this.chatRoot.append(this.chat.element);
    this.settings = new AssistantSettingsForm(settings => this.act('correct', { action: 'settings', settings: JSON.stringify(settings), revision: String(this.workspace.revision) }), accountId => void this.act('open', { accountId }), accountId => void this.act('correct', { action: 'test-account', accountId }), accountId => void this.act('open', { testAccountId: accountId }), () => void this.act('stop', {}), (action, input) => void this.act('correct', { action, ...input }), () => { this.renderSettingsMarkers(); this.mailMethods?.sync(this.workspace, this.settings.dirty.includes('accounts')); });
    this.mailMethods = new AssistantMailMethodsPanel(method => this.act('correct', { action: 'mail-method', method: JSON.stringify(method) }));
    this.settings.sections.accounts.append(this.mailMethods.element);
    this.mail = new AssistantMailView(this.act, {
      openModule: this.openModule, chatContext: (kind, id, revision) => void this.chatContext(kind, id, revision),
      lookupSender: (itemId, revision) => void this.lookupSender(itemId, revision), openAccounts: () => this.setView('settings', 'accounts'), pageChanged: () => this.applyView(),
    });
    this.watchList = new AssistantWatchList(this.act, () => this.setView('settings', 'web'), () => this.changeView('chat'));
    this.watchSettings = new AssistantWatchSettings(this.act, () => this.openWatches('settings'));
    this.watchesRoot.setAttribute('aria-label', 'Bevakningar'); this.watchesRoot.append(this.watchList.element);
    this.routineSettings = new AssistantRoutineSettings(this.act, () => this.changeView('chat'));
    this.profileSettings = new AssistantProfileSettings(this.act, () => this.renderSettingsMarkers());
    applyAppearance(this.appearance);
    this.buildHeader();
    this.buildTools();
    this.buildSettings();
    // The module host owns its alert line and only writes text into it. It moves here so a
    // failed action stays visible above the full-height conversation.
    const feedback = container.parentElement?.querySelector<HTMLElement>(':scope > .module-error[role="alert"]');
    if (feedback) this.alerts.append(feedback);
    this.adoptTechnical(false);
    this.root.append(this.header, this.alerts, this.chatRoot, this.mail.element, this.toolsRoot, this.settingsRoot, this.watchesRoot); container.replaceChildren(this.root);
    this.applyView();
  }
  private buildHeader() {
    // A second assistant on the same page is a nested surface, not another page banner.
    if (!document.querySelector('.assistant-topbar[role="banner"]')) this.header.setAttribute('role', 'banner');
    const brand = node('img', '', 'assistant-topbar-mark'); brand.src = 'assets/tabai-mandala.png'; brand.alt = ''; brand.width = 128; brand.height = 128;
    this.mailButton.dataset.view = 'mail'; this.mailButton.append(icon('mail'), node('span', 'Mejl', 'assistant-mode-label'), this.mailBadge);
    this.settingsButton.dataset.view = 'settings';
    const modes = node('nav', '', 'assistant-modes'); modes.setAttribute('aria-label', 'Lägen'); modes.append(this.mailButton, this.settingsButton);
    this.menuToggle.setAttribute('aria-haspopup', 'dialog');
    this.header.append(this.menuToggle, this.backButton, brand, this.title, modes);
  }
  private buildTools() {
    this.toolsRoot.setAttribute('aria-label', 'Lokala verktyg');
    const label = node('label', '', 'field'); this.moduleSelect.name = 'inline-module'; label.append(node('span', 'Verktyg'), this.moduleSelect);
    this.moduleSelect.onchange = () => { const id = this.moduleSelect.value; if (id) void this.openModule(id); else void this.selectModule(''); };
    this.toolsRoot.append(node('p', 'Starta ett installerat verktyg eller granska en sparad körning. Verktygets egna kontroller och källor visas här.', 'muted'), label, this.moduleHost);
  }
  private buildSettings() {
    this.settingsRoot.setAttribute('aria-label', 'Inställningar');
    this.settingsList.setAttribute('aria-label', 'Inställningssidor');
    const list = node('ul');
    for (const [page, label, description] of settingsPages) {
      const item = node('li'), open = button('', () => this.setView('settings', page), 'assistant-settings-entry');
      open.dataset.settingsPage = page;
      const text = node('span', '', 'assistant-settings-entry-text'); text.append(node('strong', label), node('span', description, 'muted'));
      open.append(text, node('span', 'Osparat', 'assistant-settings-dirty'), icon('chevron')); item.append(open); list.append(item);
      const root = node('section', '', 'assistant-settings-page'); root.dataset.page = page; root.setAttribute('aria-label', label); this.pages[page] = root;
    }
    this.settingsList.append(list);
    const contextMenu = assistantContextMenuSetting(); this.stopContextMenu = contextMenu.stop;
    this.pages.general.append(this.buildAppearance(), this.settings.sections.general, contextMenu.element);
    this.pages.models.append(this.chat.settings.models, this.settings.sections.agent, this.chat.settings.connections, this.chat.settings.connection);
    this.pages.accounts.append(this.scheduleStatus, this.settings.sections.accounts);
    this.pages.web.append(this.settings.sections.web);
    this.pages.watches.append(this.watchSettings.element);
    this.pages.routines.append(this.routineSettings.element);
    this.pages.memory.append(this.chat.settings.memory, this.profileSettings.element);
    this.pages.cost.append(this.chat.settings.budget);
    this.pages.advanced.append(node('p', 'Utvecklarverktyg för anslutna agentsessioner. Panelen uppdateras själv; Uppdatera nu hämtar allt direkt.', 'muted'), this.technicalHost);
    this.settingsRoot.append(this.settingsList, ...Object.values(this.pages));
    this.settingsRoot.addEventListener('input', () => this.renderSettingsMarkers());
  }
  /** The control panel's developer tools live in the page; the open Advanced page holds them. */
  private adoptTechnical(force: boolean) {
    const controls = document.getElementById('technical-controls') as HTMLDetailsElement | null;
    if (!controls || (!force && controls.closest('.assistant-technical-host'))) return;
    this.technicalHost.append(controls); controls.open = true;
  }
  private renderSettingsMarkers() {
    const dirty = new Set(this.settings.dirty);
    for (const [page] of settingsPages) {
      const part = settingsParts[page], entry = this.settingsList.querySelector<HTMLElement>(`[data-settings-page="${page}"]`)!;
      const unsaved = (!!part && dirty.has(part)) || ((page === 'models' || page === 'memory' || page === 'cost') && this.chat.settings.dirty(page)) || (page === 'memory' && this.profileSettings.unsaved);
      entry.dataset.dirty = String(unsaved);
    }
  }
  private setView(view: AssistantView, page?: SettingsPage) { void this.changeView(view, page); }
  private openWatches(from: 'chat' | 'settings') { this.watchesFrom = from; this.setView('watches'); }
  private async back() {
    if (this.activeView === 'mail' && await this.mail.back()) return;
    if (this.activeView === 'watches' && this.watchesFrom === 'settings') { this.setView('settings', 'watches'); return; }
    if (this.activeView === 'settings' && this.settingsPage !== 'list') this.setView('settings'); else this.setView('chat');
  }
  private async changeView(view: AssistantView, page?: SettingsPage): Promise<boolean> {
    while (this.navigationTask) await this.navigationTask;
    const nextPage = view === 'settings' ? page ?? 'list' : this.settingsPage;
    if (view === this.activeView && nextPage === this.settingsPage) return true;
    const task = (async () => {
      if (!await this.flushDrafts()) return false;
      const fromPage = this.activeView === 'settings' ? this.settingsPage : undefined;
      this.activeView = view; this.settingsPage = nextPage;
      if (view === 'settings' && nextPage === 'advanced') this.adoptTechnical(true);
      this.applyView();
      if (this.root.getBoundingClientRect().top < 0 || view !== 'chat') this.root.scrollIntoView({ block: 'start' });
      if (view === 'chat') this.chat.focusComposer();
      else {
        // Returning to the settings list puts focus back on the page that was left.
        const entry = view === 'settings' && nextPage === 'list' && fromPage && fromPage !== 'list' ? this.settingsList.querySelector<HTMLElement>(`[data-settings-page="${fromPage}"]`) : undefined;
        if (entry) entry.focus({ preventScroll: true });
        else if (!(view === 'mail' && this.mail.focusPage())) { this.title.tabIndex = -1; this.title.focus({ preventScroll: true }); }
      }
      return true;
    })();
    this.navigationTask = task;
    try { return await task; } finally { if (this.navigationTask === task) this.navigationTask = undefined; }
  }
  private applyView() {
    const view = this.activeView;
    this.root.dataset.surface = view;
    this.chatRoot.hidden = view !== 'chat'; this.mail.element.hidden = view !== 'mail'; this.toolsRoot.hidden = view !== 'tools'; this.settingsRoot.hidden = view !== 'settings'; this.watchesRoot.hidden = view !== 'watches';
    // An open list has shown every hit so far; the marker in the conversation list goes away.
    if (view === 'watches') this.chat.watchesSeen();
    this.settingsList.hidden = this.settingsPage !== 'list';
    for (const [page, root] of Object.entries(this.pages)) root.hidden = page !== this.settingsPage;
    this.menuToggle.hidden = view !== 'chat'; this.backButton.hidden = view === 'chat';
    const back = (view === 'settings' && this.settingsPage !== 'list') || (view === 'watches' && this.watchesFrom === 'settings') ? 'Tillbaka till Inställningar' : view === 'mail' && this.mail.page !== 'inbox' ? 'Tillbaka till Mejl' : 'Tillbaka till chatten';
    this.backButton.setAttribute('aria-label', back); this.backButton.title = back;
    this.title.textContent = view === 'chat' ? this.chat.title : view === 'settings' && this.settingsPage !== 'list' ? settingsPages.find(([page]) => page === this.settingsPage)![1] : view === 'mail' ? this.mail.heading : viewTitles[view];
    for (const [control, mode] of [[this.mailButton, 'mail'], [this.settingsButton, 'settings']] as const) {
      if (view === mode) control.setAttribute('aria-current', 'page'); else control.removeAttribute('aria-current');
    }
    this.renderSettingsMarkers();
  }
  /** "Visa i Mejl" from the chat: the list after a finished check, otherwise the check itself. */
  private async showMail(target: 'inbox' | 'run') {
    if (!await this.flushDrafts()) return;
    this.mail.show(target);
    if (this.activeView === 'mail') { this.applyView(); this.root.scrollIntoView({ block: 'start' }); if (!this.mail.focusPage()) { this.title.tabIndex = -1; this.title.focus({ preventScroll: true }); } return; }
    await this.changeView('mail');
  }
  /** A new conversation that looks up the organization behind one mail item's sender. */
  private async lookupSender(itemId: string, revision: number) {
    if (!await this.flushDrafts()) return;
    if (await this.act('correct', { action: 'chat-sender-lookup', itemId, revision: String(revision) })) this.setView('chat');
  }
  /** Opens the conversation that follows a module run, creating it the first time. */
  async chatAboutModule(moduleId: string, runId: string) {
    if (!await this.flushDrafts()) return;
    if (await this.act('correct', { action: 'chat-module-link', moduleId, runId })) this.setView('chat');
  }
  private async chatContext(kind: 'item' | 'case', id: string, revision: number) {
    if (!await this.flushDrafts()) return;
    const current = kind === 'item' ? this.workspace.items.find(item => item.id === id) : this.workspace.cases?.find(record => record.id === id);
    if (await this.act('correct', { action: 'chat-context', kind, id, revision: String(current?.revision ?? revision) })) this.setView('chat');
  }
  attachModule(id: string, element: HTMLElement) { this.moduleElements.set(id, element); if (element.parentElement !== this.moduleHost) this.moduleHost.append(element); element.hidden = this.moduleSelect.value !== id; }
  detachModules() { this.moduleElements.clear(); this.moduleSelect.value = ''; }
  async selectModule(id: string): Promise<boolean> {
    if (!await this.changeView('tools')) return false;
    this.activateModuleHost();
    this.moduleSelect.value = id;
    for (const [key, element] of this.moduleElements) element.hidden = key !== id;
    return true;
  }
  private buildAppearance() {
    const appearance = section('Utseende', 'appearance', 'Tabai använder marinblå grund med himmelblå accent som standard. Valet sparas på den här datorn.');
    const modeLabel = node('label', '', 'field'), modeCaption = node('span', 'Visningsläge');
    this.appearanceMode = node('select'); this.appearanceMode.name = 'appearance-mode'; this.appearanceMode.append(new Option('Systemets läge', 'system'), new Option('Ljust', 'light'), new Option('Mörkt', 'dark')); this.appearanceMode.value = this.appearance.mode;
    modeLabel.append(modeCaption, this.appearanceMode);
    const accentLabel = node('label', '', 'field'), accentCaption = node('span', 'Accentfärg');
    this.appearanceAccent = node('select'); this.appearanceAccent.name = 'appearance-accent'; this.appearanceAccent.append(new Option('Himmelblå', 'sky'), new Option('Mint', 'mint'), new Option('Violett', 'violet'), new Option('Bärnsten', 'amber')); this.appearanceAccent.value = this.appearance.accent;
    accentLabel.append(accentCaption, this.appearanceAccent);
    const sizeLabel = node('label', '', 'field assistant-text-size');
    this.appearanceSize = node('input'); this.appearanceSize.type = 'range'; this.appearanceSize.name = 'panel-text-size';
    this.appearanceSize.min = '12'; this.appearanceSize.max = '20'; this.appearanceSize.step = '1';
    this.appearanceSize.setAttribute('aria-label', 'Textstorlek');
    this.appearanceSize.setAttribute('aria-valuetext', `${panelTextSize(this.appearance.textSize)} pixlar`);
    this.appearanceSize.value = String(panelTextSize(this.appearance.textSize)); this.appearanceSizeValue.textContent = `${this.appearanceSize.value} px`;
    const sizeRow = node('span', '', 'assistant-text-size-row'); sizeRow.append(this.appearanceSize, this.appearanceSizeValue);
    sizeLabel.append(node('span', 'Textstorlek'), sizeRow, node('span', 'Ändras direkt i hela panelen. Knapparnas klickytor behålls.', 'muted'));
    appearance.append(modeLabel, accentLabel, sizeLabel,
      button('Återställ textstorlek', () => { this.appearanceSize.value = '14'; this.updateAppearance({ textSize: 14 }); }), this.appearanceStatus);
    this.appearanceMode.addEventListener('change', () => this.updateAppearance({ mode: this.appearanceMode.value as PanelAppearance['mode'] }));
    this.appearanceAccent.addEventListener('change', () => this.updateAppearance({ accent: this.appearanceAccent.value as PanelAppearance['accent'] }));
    this.appearanceSize.addEventListener('input', () => this.updateAppearance({ textSize: Number(this.appearanceSize.value) }));
    return appearance;
  }
  private updateAppearance(change: Partial<PanelAppearance>) {
    this.appearance = { ...readAppearance(), ...change, theme: 'navy' };
    saveAppearance(this.appearance);
    this.appearanceSizeValue.textContent = `${panelTextSize(this.appearance.textSize)} px`;
    this.appearanceSize.setAttribute('aria-valuetext', `${panelTextSize(this.appearance.textSize)} pixlar`);
    this.appearanceStatus.textContent = 'Utseendet är sparat på den här datorn.';
  }
  dispose() {
    this.chat.dispose(); this.mail.dispose(); this.stopContextMenu();
    const controls = this.technicalHost.querySelector('#technical-controls');
    if (controls) document.getElementById('technical-home')?.append(controls);
  }
  flushDrafts() { return this.mail.flushDrafts(); }
  setPendingModules(pending: AssistantPendingModule[]) {
    const key = JSON.stringify(pending); if (key === this.pendingModulesKey) return;
    this.pendingModulesKey = key; this.pendingModules = pending; this.mail.setPending(pending); this.renderBadge();
  }
  setCaseModules(modules: PersonalModule[]) {
    this.mail.cases.setModules(modules); this.mail.setModules(modules);
    const available = modules.filter(module => !module.view?.assistant), selected = this.moduleSelect.value;
    const key = JSON.stringify(available.map(module => [module.id, module.view?.title]));
    if (this.moduleSelect.dataset.key !== key) {
      this.moduleSelect.dataset.key = key; this.moduleSelect.replaceChildren(new Option('Välj ett verktyg…', ''));
      for (const module of available) this.moduleSelect.append(new Option(module.view?.title || module.id, module.id));
      this.moduleSelect.value = selected;
    }
    this.chat.setToolsAvailable(available.length > 0);
    for (const [id, element] of this.moduleElements) { if (!available.some(module => module.id === id)) this.moduleElements.delete(id); else element.hidden = id !== this.moduleSelect.value; }
  }
  setBusy(busy: boolean) {
    this.busy = busy; this.root.setAttribute('aria-busy', String(busy));
    // Controls under another [data-module-id] (local tools, developer tools) have their own owner.
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach(control => { if (control.closest('[data-module-id]') === this.root.closest('[data-module-id]')) control.disabled = busy || control.dataset.blocked === 'true'; });
    this.mail.setBusy(busy); this.chat.setBusy(busy);
  }
  update(workspace: AssistantWorkspace, localRuntime?: AssistantLocalRuntime, chat?: AssistantChatView) {
    this.workspace = workspace;
    if (localRuntime !== undefined || arguments.length > 1) this.localRuntime = localRuntime;
    if (chat !== undefined || arguments.length > 2) this.chatView = chat;
    this.chat.setTimezone(workspace.settings.timezone);
    this.chat.update(this.chatView);
    const webOff = !assistantWebEnabled(workspace.settings.web);
    this.watchList.update(this.chatView, webOff, workspace.settings.timezone);
    this.watchSettings.update(this.chatView);
    this.routineSettings.update(this.chatView, workspace);
    this.profileSettings.update(this.chatView);
    const focus = this.root.contains(document.activeElement) && !document.activeElement?.closest('#technical-controls') ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : undefined;
    const focusedId = focus?.id, selection = focus instanceof HTMLTextAreaElement ? [focus.selectionStart, focus.selectionEnd] as const : undefined;
    const opened = new Set([...this.root.querySelectorAll<HTMLDetailsElement>('details[open][data-keep]')].map(detail => detail.dataset.keep));
    this.chat.setMailReady(workspace.settings.accounts.some(account => account.enabled));
    this.mail.update(workspace); this.renderBadge();
    this.settings.sync(workspace.settings);
    this.settings.syncTests(workspace.accountTests || [], workspace.settings.timezone);
    this.settings.syncLocal(this.localRuntime);
    this.mailMethods.sync(workspace, this.settings.dirty.includes('accounts'));
    this.renderScheduleStatus();
    this.root.querySelectorAll<HTMLDetailsElement>('details[data-keep]').forEach(detail => { if (opened.has(detail.dataset.keep)) detail.open = true; });
    if (focusedId) { const replacement = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(focusedId)}`); replacement?.focus({ preventScroll: true }); if (selection && replacement instanceof HTMLTextAreaElement) replacement.setSelectionRange(...selection); }
    this.setBusy(this.busy);
    this.applyView();
  }
  /** The counter matches the toolbar icon: the host's attention count plus other agents' waiting work. */
  private renderBadge() {
    const badge = this.mail.badge(), label = badge ? `Mejl, ${badge} väntar` : 'Mejl';
    this.mailBadge.textContent = badge > 99 ? '99+' : String(badge); this.mailBadge.hidden = !badge;
    this.mailButton.setAttribute('aria-label', label); this.mailButton.title = label;
  }
  private renderScheduleStatus() {
    const schedule = this.workspace.schedule;
    this.scheduleStatus.replaceChildren();
    if (!schedule?.nextRunAt && !schedule?.lastRunAt && !schedule?.message) return;
    if (schedule.message) this.scheduleStatus.append(node('span', schedule.message));
    if (schedule.nextRunAt) {
      if (schedule.message) this.scheduleStatus.append(document.createTextNode(' '));
      this.scheduleStatus.append(node('span', 'Nästa: '), timestamp(schedule.nextRunAt, this.workspace.settings.timezone));
    }
  }
}
