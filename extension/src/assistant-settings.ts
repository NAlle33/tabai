import type { AssistantAccount, AssistantSettings } from '../../shared/assistant';
import { node } from './module-views';
import { button, details, field, section, sourceLink } from './assistant-controls';
import { renderAccountTest } from './assistant-account-tests';
import { assistantBergetDefaults, assistantBergetModelIds, assistantBergetModelInfo, type AssistantBergetModel } from '../../shared/assistant-berget';
import { assistantWebDefaults, type AssistantWebLevel, type AssistantWebTasks } from '../../shared/assistant-web';
import { assistantAgentConfig, assistantClaudeModelIds, assistantClaudeModelInfo, assistantLocalModelIds, assistantLocalModelInfo, OLLAMA_DOWNLOAD_URL, type AssistantAccountTest, type AssistantClaudeSettings, type AssistantLocalModelId, type AssistantLocalRuntime } from '../../shared/assistant-diagnostics';

const providers = { gmail: 'Gmail', outlook: 'Outlook', zoho: 'Zoho' };
const defaultUrls = { gmail: 'https://mail.google.com/mail/u/', outlook: 'https://outlook.office.com/mail/', zoho: 'https://mail.zoho.com/' };
const accountUrl = (provider: AssistantAccount['provider'], email: string) => provider === 'gmail' && email ? `${defaultUrls.gmail}?authuser=${encodeURIComponent(email)}` : defaultUrls[provider];
type SenderRule = { accountId: string; email: string; priority: 'high' | 'normal' };
const defaultPreferences: { shortReplies: boolean; senderRules: SenderRule[] } = { shortReplies: false, senderRules: [] };
const defaultMorning = { enabled: false, time: '08:00', notifications: false };
let accountSequence = 0;
let settingsSequence = 0;
const gigabytes = (bytes: number) => `${(bytes / 1e9).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} GB`;
const modelStates = { unknown: 'Status okänd', missing: 'Inte hämtad', ready: 'Hämtad och kontrollerad', mismatch: 'Annan variant än den provade', untested: 'Ny Ollama-version – kör självtestet' };
const operationLabels = { pull: 'Hämtning', selftest: 'Självtest', unload: 'Urladdning' };
export type AssistantLocalCommand = (action: 'local-refresh' | 'local-pull' | 'local-cancel' | 'local-selftest' | 'local-unload', input?: Record<string, string>) => void;
/** Each settings page that edits part of the stored settings object. */
export type AssistantSettingsPart = 'general' | 'accounts' | 'agent' | 'web';
const parts: Record<AssistantSettingsPart, { fields: (keyof AssistantSettings)[]; save: string }> = {
  general: { fields: ['timezone'], save: 'Spara tidszon' },
  accounts: { fields: ['accounts', 'learnMail', 'lookbackDays', 'followupDays', 'tone', 'preferences', 'morning', 'autoAcknowledgements', 'acknowledgementRecipients', 'acknowledgementBody'], save: 'Spara mejlkonton' },
  agent: { fields: ['agent'], save: 'Spara uppdragsmodell' },
  web: { fields: ['web'], save: 'Spara webbåtkomst' },
};
/**
 * One settings page. `key` is the stored slice the conflict check compares with, and stays while
 * the page is dirty. `drawn` holds the stored values the form was drawn from and `initial` what
 * the form read right after, so a save can tell what the user changed from what changed elsewhere.
 * `sent` is what the form read for the last acknowledged save that the user kept typing through;
 * from then on a field the user changed is one that differs from it.
 */
type Part = { form: HTMLFormElement; content: HTMLElement; status: HTMLElement; submit: HTMLButtonElement; conflict: HTMLElement; dirty: boolean; conflicted: boolean; saving: boolean; version: number; key: string; initial?: Partial<AssistantSettings>; drawn?: Partial<AssistantSettings>; sent?: Partial<AssistantSettings> };
/** JSON with sorted object keys, so the same stored values compare equal however they were written. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The stored settings, edited on separate pages. A page sends the whole settings object
 * as the controller expects, but only its own fields come from the form: every other
 * field is the last saved value, so unsaved edits on another page are never sent and
 * never overwritten by a re-render. A dirty page keeps the stored values it started
 * from; when the stored values for that page change meanwhile (a sender rule added from
 * Mejl, say), the page shows a conflict and saves nothing until the user reads the new
 * values in or saves their own changes over them, which leaves the new values in every
 * field the user did not change.
 */
export class AssistantSettingsForm {
  private namespace = `settings-${++settingsSequence}`;
  /** Mount points for the settings pages, in page order. */
  readonly sections: Record<AssistantSettingsPart, HTMLElement>;
  private parts = {} as Record<AssistantSettingsPart, Part>;
  private saved?: AssistantSettings;
  private accounts = node('div', '', 'assistant-accounts');
  private tests: AssistantAccountTest[] = [];
  private timezone = 'Europe/Stockholm';
  private localRoot = node('section', '', 'assistant-local-runtime');
  private runtime?: AssistantLocalRuntime;
  private runtimeKey = '';
  private agentDetails = details('Fler val för uppdragsmodellen', 'assistant-agent-model');
  constructor(private save: (settings: AssistantSettings) => Promise<boolean>, private open: (accountId: string) => void, private test: (accountId: string) => void = () => {}, private openTest: (accountId: string) => void = () => {}, private stopTest: () => void = () => {}, private local: AssistantLocalCommand = () => {}, private changed: () => void = () => {}) {
    this.localRoot.setAttribute('aria-label', 'Lokala modeller');
    for (const key of Object.keys(parts) as AssistantSettingsPart[]) {
      const form = node('form', '', 'assistant-settings-form'), content = node('div', '', 'assistant-settings-content'), status = node('p', '', 'muted assistant-settings-status'), submit = node('button', parts[key].save, 'primary');
      const bar = node('div', '', 'assistant-settings-save'); status.setAttribute('role', 'status'); submit.type = 'submit'; bar.append(status, submit);
      const conflict = node('div', '', 'notice assistant-settings-conflict'), choices = node('div', '', 'assistant-actions');
      conflict.dataset.settingsConflict = key; conflict.hidden = true; conflict.setAttribute('role', 'status');
      choices.append(button('Läs in de nya värdena', () => this.readIn(key)), button('Spara mina ändringar', () => void this.submit(key, true)));
      conflict.append(node('p', 'Inställningarna på sidan har ändrats sedan du började, till exempel från Mejl. Dina ändringar finns kvar men är inte sparade.'),
        node('p', 'Spara mina ändringar sparar det du har ändrat över de nya värdena. Det du inte har ändrat får de nya värdena.', 'muted'), choices);
      form.dataset.settingsPart = key; form.append(content, conflict, bar);
      form.oninput = () => this.markDirty(key); form.onchange = form.oninput;
      form.onsubmit = event => { event.preventDefault(); void this.submit(key); };
      this.parts[key] = { form, content, status, submit, conflict, dirty: false, conflicted: false, saving: false, version: 0, key: '' };
    }
    // Only a user opening the section refreshes; re-renders keep the same element open.
    this.agentDetails.querySelector('summary')!.addEventListener('click', () => { if (!this.agentDetails.open) this.local('local-refresh'); });
    this.agentDetails.append(this.parts.agent.form);
    this.sections = { general: section('Tidszon', 'timezone', 'Används för tider i panelen och för morgonkontrollen.'), accounts: node('div', '', 'assistant-settings-accounts'), agent: this.agentDetails, web: node('div', '', 'assistant-settings-web') };
    this.sections.general.append(this.parts.general.form); this.sections.accounts.append(this.parts.accounts.form); this.sections.web.append(this.parts.web.form);
  }
  /** Pages with edits that have not been saved yet. */
  get dirty(): AssistantSettingsPart[] { return (Object.keys(this.parts) as AssistantSettingsPart[]).filter(key => this.parts[key].dirty); }
  private markDirty(key: AssistantSettingsPart) {
    const part = this.parts[key]; part.dirty = true; part.version++; part.status.textContent = 'Du har osparade ändringar.'; part.form.dataset.dirty = 'true';
    if (key === 'accounts') this.syncTests(this.tests, this.timezone);
    this.changed();
  }
  private clean(key: AssistantSettingsPart) { const part = this.parts[key]; part.dirty = false; delete part.form.dataset.dirty; this.setConflict(key, false); }
  private setConflict(key: AssistantSettingsPart, conflicted: boolean) { const part = this.parts[key]; part.conflicted = conflicted; part.conflict.hidden = !conflicted; }
  /** The stored values a page shows, in a form that compares equal however they were written. */
  private slice(key: AssistantSettingsPart, settings: AssistantSettings) { return canonical(parts[key].fields.map(name => settings[name] ?? null)); }
  /** Reads the stored values into a page with a conflict; the unsaved changes on that page go. */
  private readIn(key: AssistantSettingsPart) {
    const part = this.parts[key];
    if (!this.saved || part.saving) return;
    this.clean(key); part.key = ''; this.sync(this.saved);
    part.status.textContent = 'De nya värdena är inlästa. Dina osparade ändringar på sidan är borttagna.';
    part.content.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
    this.changed();
  }
  syncTests(results: AssistantAccountTest[], timezone: string) {
    this.tests = results; this.timezone = timezone;
    const dirty = this.parts.accounts.dirty;
    for (const row of this.accounts.querySelectorAll<HTMLElement>('[data-account]')) {
      const id = row.dataset.account!, result = results.find(test => test.accountId === id);
      const host = row.querySelector<HTMLElement>('[data-account-test]');
      const testKey = JSON.stringify({ result, timezone });
      if (host && host.dataset.testKey !== testKey) { renderAccountTest(host, result, timezone, () => this.openTest(id), this.stopTest); host.dataset.testKey = testKey; }
      const control = row.querySelector<HTMLButtonElement>('[data-test-account]');
      if (control) {
        control.dataset.blocked = String(dirty || row.dataset.saved !== 'true' || result?.status === 'running');
        control.disabled = control.dataset.blocked === 'true';
        control.textContent = result?.status === 'running' ? 'Testar läsåtkomst…' : 'Testa läsåtkomst';
      }
      const help = row.querySelector<HTMLElement>('.assistant-test-save-help');
      if (help) help.textContent = dirty || row.dataset.saved !== 'true' ? 'Spara ändringarna innan du testar. Testet använder det sparade kontot.' : 'Testet läser fyra delar och skickar inget. Det går också att testa ett konto som inte tas med i kontroller.';
    }
  }
  sync(settings: AssistantSettings) {
    this.saved = settings;
    for (const key of Object.keys(parts) as AssistantSettingsPart[]) {
      const part = this.parts[key], slice = this.slice(key, settings);
      // A dirty page keeps the values it started from. While its own save is on the way the
      // acknowledged view is no conflict; the save itself settles the page afterwards.
      if (part.dirty) { if (!part.saving) this.setConflict(key, slice !== part.key); continue; }
      if (part.key === slice) continue;
      part.key = slice; this.render(key, settings);
    }
  }
  private render(key: AssistantSettingsPart, settings: AssistantSettings) {
    const content = this.parts[key].content; content.replaceChildren();
    if (key === 'general') this.renderGeneral(content, settings);
    if (key === 'accounts') this.renderAccounts(content, settings);
    if (key === 'agent') this.renderAgent(content, settings);
    if (key === 'web') this.renderWeb(content, settings);
    const initial = this.read(key), part = this.parts[key];
    part.initial = typeof initial === 'string' ? undefined : initial;
    part.drawn = structuredClone(Object.fromEntries(parts[key].fields.map(name => [name, settings[name]]))) as Partial<AssistantSettings>;
    part.sent = undefined;
  }
  private renderGeneral(content: HTMLElement, settings: AssistantSettings) {
    const timezone = field('Tidszon', 'timezone', settings.timezone, false, this.namespace); timezone.input.required = true; timezone.input.spellcheck = false;
    content.append(timezone.wrapper, node('p', 'Till exempel Europe/Stockholm.', 'muted'));
  }
  private renderAccounts(content: HTMLElement, settings: AssistantSettings) {
    const learning = node('label', '', 'checkpoint-option'), learn = node('input');
    learn.type = 'checkbox'; learn.name = 'learnMail'; learn.checked = settings.learnMail === true;
    learning.append(learn, document.createTextNode('Lär in och återanvänd verifierade mejlmetoder'));
    content.append(learning, node('p', 'Gäller manuella och schemalagda mejlkontroller. Varje nytt mejl bedöms på nytt. Inlärningen sparar förberedelsesteg och mätningar utan mejlinnehåll.', 'muted'));
    this.accounts.replaceChildren();
    for (const account of settings.accounts) this.addAccount(account, true);
    const list = section('Konton', 'accounts', 'Lägg till de konton assistenten ska läsa. Du loggar själv in i webbläsaren.');
    list.append(this.accounts, button('Lägg till konto', () => {
      if (this.accounts.childElementCount >= 12) { this.parts.accounts.status.textContent = 'Du kan spara högst 12 konton.'; return; }
      this.addAccount({ id: `konto-${Date.now().toString(36)}-${++accountSequence}`, provider: 'gmail', label: '', email: '', url: defaultUrls.gmail, enabled: true });
      this.markDirty('accounts');
      this.accounts.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus();
    }));
    const range = section('Vad som kontrolleras', 'range', 'Följande kontroller fortsätter från senast lyckade kontroll per konto.');
    for (const [name, label, value] of [['lookbackDays', 'Första kontrollen: dagar bakåt', settings.lookbackDays], ['followupDays', 'Följ upp efter antal dagar', settings.followupDays]] as const) {
      const control = field(label, name, String(value), false, this.namespace); control.input.type = 'number'; control.input.min = '1'; control.input.max = '90'; control.input.required = true; control.input.inputMode = 'numeric'; range.append(control.wrapper);
    }
    const style = section('Svarston', 'tone');
    const tone = field('Så vill jag att mina svar låter', 'tone', settings.tone, true, this.namespace); tone.input.maxLength = 2000;
    style.append(tone.wrapper);
    const rawSenderRules = settings.preferences?.senderRules ?? defaultPreferences.senderRules;
    const preferences: { shortReplies: boolean; senderRules: SenderRule[] } = {
      shortReplies: settings.preferences?.shortReplies ?? defaultPreferences.shortReplies,
      senderRules: rawSenderRules.flatMap(rule => rule.accountId && rule.email ? [{ accountId: rule.accountId, email: rule.email, priority: rule.priority || 'normal' }] : []),
    };
    const feedback = section('Svar och prioritering', 'senders', 'Du kan också ge feedback direkt på ett svarsförslag. Prioriterade avsändare används när nya mejl rangordnas.');
    const shortReplies = node('label', '', 'checkpoint-option'), shortRepliesInput = node('input');
    shortRepliesInput.type = 'checkbox'; shortRepliesInput.name = 'shortReplies'; shortRepliesInput.checked = preferences.shortReplies;
    shortReplies.append(shortRepliesInput, document.createTextNode('Föreslå kortare svar som standard'));
    const senderRules = node('div', '', 'assistant-sender-rules');
    for (const rule of preferences.senderRules) this.addSenderRule(senderRules, settings, rule);
    const addSender = button('Lägg till prioriterad avsändare', () => { this.addSenderRule(senderRules, settings); this.markDirty('accounts'); senderRules.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus(); });
    feedback.append(shortReplies, senderRules, addSender);
    const morning = settings.morning || defaultMorning;
    const schedule = details('Morgonkontroll och aviseringar', 'assistant-morning');
    const scheduleLabel = node('label', '', 'checkpoint-option'), scheduleEnabled = node('input');
    scheduleEnabled.type = 'checkbox'; scheduleEnabled.name = 'morningEnabled'; scheduleEnabled.checked = morning.enabled;
    scheduleLabel.append(scheduleEnabled, document.createTextNode('Gör en morgonkontroll automatiskt'));
    const scheduleTaskLabel = node('label', '', 'field'), scheduleTask = node('select'); scheduleTask.name = 'morningTask'; scheduleTask.append(new Option('Kolla mina mejl', 'check-mail'), new Option('Min dag', 'my-day')); scheduleTask.value = settings.morning?.task || 'my-day'; scheduleTaskLabel.append(node('span', 'Dagligt uppdrag'), scheduleTask);
    const scheduleTime = field('Tid', 'morningTime', morning.time, false, this.namespace); scheduleTime.input.type = 'time'; scheduleTime.input.required = true;
    const notificationLabel = node('label', '', 'checkpoint-option'), notifications = node('input');
    notifications.type = 'checkbox'; notifications.name = 'morningNotifications'; notifications.checked = morning.notifications;
    notificationLabel.append(notifications, document.createTextNode('Visa avisering när kontrollen behöver min uppmärksamhet'));
    notifications.addEventListener('change', async () => {
      if (!notifications.checked || typeof chrome === 'undefined' || !chrome.permissions?.request) return;
      try {
        const granted = await chrome.permissions.request({ permissions: ['notifications'] });
        if (!granted) { notifications.checked = false; this.parts.accounts.status.textContent = 'Chrome nekade aviseringar. Spara morgonkontrollen utan aviseringar.'; }
      } catch { notifications.checked = false; this.parts.accounts.status.textContent = 'Aviseringar kunde inte aktiveras. Spara morgonkontrollen utan aviseringar.'; }
    });
    const scheduleHelp = node('p', 'Kontrollen körs bara när ett aktivt konto finns. Aviseringar kräver separat tillåtelse i Chrome.', 'muted');
    schedule.append(scheduleLabel, scheduleTaskLabel, scheduleTime.wrapper, notificationLabel, scheduleHelp);
    const automatic = details('Automatiska mottagningsbekräftelser', 'assistant-auto');
    const label = node('label', '', 'checkpoint-option'), enabled = node('input'); enabled.type = 'checkbox'; enabled.name = 'autoAcknowledgements'; enabled.checked = settings.autoAcknowledgements;
    label.append(enabled, document.createTextNode('Tillåt automatiska mottagningsbekräftelser'));
    const recipients = field('Exakta e-postadresser, en per rad', 'acknowledgementRecipients', settings.acknowledgementRecipients.join('\n'), true, this.namespace);
    const body = field('Fast bekräftelsetext', 'acknowledgementBody', settings.acknowledgementBody, true, this.namespace); body.input.maxLength = 2000;
    automatic.append(label, node('p', 'När detta är på skickas den fasta texten automatiskt, bara som en mottagningsbekräftelse till en exakt adress i listan. Övriga svar behöver ditt godkännande.', 'muted'), recipients.wrapper, body.wrapper);
    content.append(list, range, style, feedback, schedule, automatic);
    this.syncTests(this.tests, settings.timezone);
  }
  private renderAgent(content: HTMLElement, settings: AssistantSettings) {
    const config = assistantAgentConfig(settings.agent);
    const backendLabel = node('label', '', 'field'), backend = node('select'); backend.name = 'agentBackend';
    backend.append(new Option('Codex (moln, OpenAI)', 'codex'), new Option('Claude (moln, Anthropic)', 'claude'), new Option('Lokal inferens på den här datorn (Ollama, experimentell)', 'local'), new Option('Berget.ai (moln)', 'berget'));
    backend.value = config.backend; backendLabel.append(node('span', 'Nya uppdrag körs med'), backend);
    const codex = node('div', '', 'assistant-agent-codex');
    const modelLabel = node('label', '', 'field'), model = node('select'); model.name = 'agentModel';
    model.append(new Option('GPT-6.1 Terra · rekommenderad', 'gpt-6.1-terra'), new Option('GPT-6.1 Sol', 'gpt-6.1-sol'));
    model.value = config.codex.model; modelLabel.append(node('span', 'Modell'), model);
    const effortLabel = node('label', '', 'field'), effort = node('select'); effort.name = 'agentReasoningEffort';
    effort.append(new Option('Medel · rekommenderad', 'medium'), new Option('Hög', 'high'));
    effort.value = config.codex.reasoningEffort; effortLabel.append(node('span', 'Resonemang'), effort);
    codex.append(node('p', 'Codex körs i molnet: uppdraget och det underlag assistenten läser skickas till OpenAI Codex. Terra med medelhögt resonemang är standard.', 'muted'), modelLabel, effortLabel);
    const claude = node('div', '', 'assistant-agent-claude');
    const claudeModelLabel = node('label', '', 'field'), claudeModel = node('select'); claudeModel.name = 'claudeModel';
    for (const id of assistantClaudeModelIds) claudeModel.append(new Option(`${assistantClaudeModelInfo[id].label} · ${assistantClaudeModelInfo[id].role}`, id));
    claudeModel.value = config.claude.model; claudeModelLabel.append(node('span', 'Modell'), claudeModel);
    const claudeEffortLabel = node('label', '', 'field'), claudeEffort = node('select'); claudeEffort.name = 'claudeEffort';
    claudeEffort.append(new Option('Medel · rekommenderad', 'medium'), new Option('Hög', 'high'));
    claudeEffort.value = config.claude.effort; claudeEffortLabel.append(node('span', 'Ansträngning'), claudeEffort);
    claude.append(node('p', 'Claude körs i molnet: uppdraget och det underlag assistenten läser skickas till Anthropic via Claude Code på den här datorn, med din egen inloggning. Tabai sparar ingen API-nyckel. Opus 5.5 med medelhög ansträngning är standard.', 'muted'), claudeModelLabel, claudeEffortLabel);
    const berget = node('div', '', 'assistant-agent-berget');
    const bergetLabel = node('label', '', 'field'), bergetModel = node('select'); bergetModel.name = 'bergetModel';
    for (const id of assistantBergetModelIds) { const info = assistantBergetModelInfo[id]; bergetModel.append(new Option(`${info.label} · ${info.role}`, id)); }
    bergetModel.value = (config.berget ?? assistantBergetDefaults).model; bergetLabel.append(node('span', 'Berget-modell'), bergetModel);
    berget.append(node('p', 'Samtalet och underlag du ber agenten läsa skickas till Berget.ai. Anrop debiteras separat av Berget och ingår inte i Codex eller Claude. Modellvalen är kandidater; uppdragskvaliteten är inte verifierad på dina mejl.', 'muted'), bergetLabel, node('p', 'Spara uppdragsmodellen. Lägg sedan till nyckeln under Berget-nyckel på den här sidan. Nyckeln sparas privat utanför Git och inte här i arbetsytan.', 'muted'));
    const local = node('div', '', 'assistant-agent-local');
    const localLabel = node('label', '', 'field'), localModel = node('select'); localModel.name = 'localModel';
    for (const id of assistantLocalModelIds) { const info = assistantLocalModelInfo[id]; localModel.append(new Option(`${info.label} · ${info.role} · ${info.size}`, id)); }
    localModel.value = config.local.model; localLabel.append(node('span', 'Lokal modell'), localModel);
    local.append(node('p', 'Lokal inferens: uppdraget och läst mejltext skickas bara till Ollama på 127.0.0.1 på den här datorn, inte till någon molnmodell. Webbläsaren är fortfarande online för att läsa dina konton, och modeller hämtas över internet. Om den lokala modellen inte fungerar stoppar uppdraget med ett fel – Tabai byter aldrig själv till Codex.', 'muted'), node('p', 'Experimentellt: den lokala modellen kan missa eller feltolka mejl. Granska svarsförslag och täckning innan du använder resultatet. Värden stoppar påhittade källor och otillåtna handlingar, men inte en felbedömning av ett mejl.', 'module-error'), localLabel);
    const showBackend = () => { codex.hidden = backend.value !== 'codex'; claude.hidden = backend.value !== 'claude'; local.hidden = backend.value !== 'local'; berget.hidden = backend.value !== 'berget'; };
    backend.addEventListener('change', () => { showBackend(); if (backend.value === 'local') this.local('local-refresh'); });
    showBackend();
    content.append(node('p', 'Valet gäller från nästa uppdrag. Alla lägens inställningar sparas, så du kan byta tillbaka utan att förlora något.', 'muted'), backendLabel, codex, claude, local, berget, this.localRoot);
    this.runtimeKey = ''; this.syncLocal(this.runtime);
  }
  private renderWeb(content: HTMLElement, settings: AssistantSettings) {
    const webAccess = settings.web ?? assistantWebDefaults;
    const fullLabel = node('label', '', 'checkpoint-option'), fullAccess = node('input');
    fullAccess.type = 'checkbox'; fullAccess.name = 'webFullAccess'; fullAccess.checked = webAccess.fullAccess === true;
    fullLabel.append(fullAccess, document.createTextNode('Full Tabai-åtkomst för agenter'));
    const fullDescription = node('p', 'Ger alla modeller hela Tabais webbläsarverktyg i egna arbetsflikar: JavaScript, cookies, lagring, filer, nedladdningar, skärmbilder och recept. Gäller även uppdrag, bevakningar och rutiner. Agenten kan använda dina inloggningar och utföra beställda köp, utskick och raderingar utan panelens extra godkännandekort. Ger ingen terminal eller fri filåtkomst. Bildtolkning beror på modellanslutningen.', 'module-error');
    const web = section('Guidad webbåtkomst i chatten', 'web-chat', 'Gäller alla modellval: Codex, Claude, Berget och lokal. Alla får samma webbverktyg genom Tabai, och ingen modell använder egna webbverktyg.');
    web.classList.add('assistant-web-access');
    const webLevelLabel = node('label', '', 'field'), webLevel = node('select'); webLevel.name = 'webLevel';
    webLevel.append(new Option('Av', 'off'), new Option('Söka och läsa', 'read'), new Option('Agera med godkännande', 'act'));
    webLevel.value = webAccess.level; webLevelLabel.append(node('span', 'Vad agenten får göra på webben'), webLevel);
    const webLoginLabel = node('label', '', 'checkpoint-option'), webLogin = node('input');
    webLogin.type = 'checkbox'; webLogin.name = 'webLogin'; webLogin.checked = webAccess.login;
    webLoginLabel.append(webLogin, document.createTextNode('Får logga in och använda sidor där jag är inloggad'));
    const incognito = node('p', '', 'muted assistant-web-incognito');
    const showLogin = async () => {
      webLevel.disabled = fullAccess.checked; webLogin.disabled = fullAccess.checked || webLevel.value === 'off';
      webTasks.disabled = fullAccess.checked;
      fullDescription.hidden = !fullAccess.checked;
      if (fullAccess.checked) { incognito.textContent = 'Fullåtkomsten använder egna flikar i din vanliga Chrome-profil. De guidade inställningarna sparas till när du stänger av fullåtkomsten.'; return; }
      if (webLogin.checked) { incognito.textContent = 'Agenten kan använda dina inloggningar i Chrome. Lösenordet fyller du alltid i själv när agenten ber om det.'; return; }
      let allowed = false;
      try { allowed = typeof chrome !== 'undefined' && !!chrome.extension?.isAllowedIncognitoAccess && await chrome.extension.isAllowedIncognitoAccess(); } catch { allowed = false; }
      incognito.textContent = allowed ? 'Utan inloggning öppnas sidorna i ett eget inkognitofönster, utan inloggningarna i dina vanliga Chrome-fönster.'
        : 'Utan inloggning behöver Tabai få öppna ett inkognitofönster: slå på ”Tillåt i inkognito” för Tabai i chrome://extensions. Annars öppnas sidorna i vanliga Chrome, där dina befintliga inloggningar syns.';
    };
    webLevel.addEventListener('change', () => void showLogin()); webLogin.addEventListener('change', () => void showLogin());
    fullAccess.addEventListener('change', () => void showLogin());
    web.append(webLevelLabel,
      node('p', 'Söka och läsa: agenten söker, läser sidor och sammanställer med källor. Agera med godkännande: agenten kan även klicka och fylla i formulär. Före köp, betalning, beställning, skicka, boka eller signera visar den ett kort i chatten, och bara ditt Godkänn utför steget. Lösenord, kortuppgifter och BankID fyller du alltid i själv.', 'muted'),
      webLoginLabel, incognito,
      node('p', 'Tabai känner igen slutgiltiga steg med en tumregel och kan missa en ovanlig knapp. Webbsidor och mejl kan försöka lura agenten, till exempel att lägga mejltext i en sökning. Varje sida agenten öppnar och varje fält den fyller i visas i chatten. Välj den lägsta nivå som räcker.', 'module-error'));
    const tasks = section('Webbåtkomst i mejluppdrag', 'web-tasks');
    const webTasksLabel = node('label', '', 'field'), webTasks = node('select'); webTasks.name = 'webTasks';
    webTasks.append(new Option('Av', 'off'), new Option('Söka och läsa i uppdrag jag startar', 'manual'), new Option('Söka och läsa även i automatiska kontroller', 'all'));
    webTasks.value = webAccess.tasks ?? 'off'; webTasksLabel.append(node('span', 'I mejluppdrag'), webTasks);
    tasks.append(webTasksLabel,
      node('p', 'Mejluppdrag klickar och fyller aldrig i något på webben. De söker och läser offentliga uppgifter, till exempel om ett företag som har skrivit, i ett eget inkognitofönster utan dina inloggningar, och öppnar bara sidor från sina egna sökningar – aldrig länkar från mejl. Utan ”Tillåt i inkognito” för Tabai stoppar uppdraget webbstegen. Automatiska kontroller körs medan du inte tittar, så välj dem bara om du behöver det. Besökta sidor står i uppdragets resultat.', 'muted'));
    const full = section('Agenternas webbläsaråtkomst', 'web-full');
    full.append(fullLabel, fullDescription);
    content.append(full, web, tasks);
    void showLogin();
  }
  /** Reads one page's own fields, or returns why they cannot be saved. */
  private read(key: AssistantSettingsPart): Partial<AssistantSettings> | string {
    const form = this.parts[key].form, data = new FormData(form);
    const value = (name: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!.value;
    if (key === 'general') {
      const timezone = String(data.get('timezone')).trim();
      try { new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }); } catch { return 'Ange en giltig tidszon, till exempel Europe/Stockholm.'; }
      return { timezone };
    }
    if (key === 'web') return { web: { level: value('webLevel') as AssistantWebLevel, login: form.querySelector<HTMLInputElement>('[name="webLogin"]')!.checked, tasks: value('webTasks') as AssistantWebTasks, fullAccess: form.querySelector<HTMLInputElement>('[name="webFullAccess"]')!.checked } };
    if (key === 'agent') return { agent: { backend: value('agentBackend') as 'codex' | 'claude' | 'local' | 'berget', codex: { model: value('agentModel') as 'gpt-6.1-terra' | 'gpt-6.1-sol', reasoningEffort: value('agentReasoningEffort') as 'medium' | 'high' }, claude: { model: value('claudeModel') as AssistantClaudeSettings['model'], effort: value('claudeEffort') as AssistantClaudeSettings['effort'] }, local: { model: value('localModel') as AssistantLocalModelId }, berget: { model: value('bergetModel') as AssistantBergetModel } } };
    const accounts = [...this.accounts.querySelectorAll<HTMLElement>('[data-account]')].map(row => ({
      id: row.dataset.account!, provider: row.querySelector<HTMLSelectElement>('[name="provider"]')!.value as AssistantAccount['provider'],
      label: row.querySelector<HTMLInputElement>('[name="label"]')!.value.trim(), email: row.querySelector<HTMLInputElement>('[name="email"]')!.value.trim(),
      url: row.querySelector<HTMLInputElement>('[name="url"]')!.value.trim(), enabled: row.querySelector<HTMLInputElement>('[name="enabled"]')!.checked,
    }));
    const rules = [...form.querySelectorAll<HTMLElement>('[data-sender-rule]')].map(row => ({
      accountId: row.querySelector<HTMLSelectElement>('[name="sender-account"]')!.value,
      email: row.querySelector<HTMLInputElement>('[name="sender-email"]')!.value.trim(),
      priority: row.querySelector<HTMLSelectElement>('[name="sender-priority"]')!.value as 'high' | 'normal',
    })).filter(rule => rule.email);
    const settings = { accounts, learnMail: data.has('learnMail'), lookbackDays: Number(data.get('lookbackDays')), followupDays: Number(data.get('followupDays')), tone: String(data.get('tone')), autoAcknowledgements: data.has('autoAcknowledgements'), acknowledgementRecipients: String(data.get('acknowledgementRecipients')).split(/[\n,;]/).map(item => item.trim()).filter(Boolean), acknowledgementBody: String(data.get('acknowledgementBody')), preferences: { shortReplies: data.has('shortReplies'), senderRules: rules }, morning: { task: value('morningTask') as 'check-mail' | 'my-day', enabled: data.has('morningEnabled'), time: String(data.get('morningTime') || '08:00'), notifications: data.has('morningNotifications') } };
    if (settings.autoAcknowledgements && (!settings.acknowledgementRecipients.length || !settings.acknowledgementBody.trim())) return 'Automatiska bekräftelser behöver både exakta mottagare och en fast text.';
    const email = document.createElement('input'); email.type = 'email';
    if (settings.acknowledgementRecipients.length > 30 || settings.acknowledgementRecipients.some(item => { email.value = item; return !email.checkValidity(); })) return 'Ange högst 30 fullständiga e-postadresser för bekräftelser.';
    return settings;
  }
  /**
   * A page's own fields as they are saved. Each comes from the form, as the page shows it, except
   * a field that changed elsewhere since the page was drawn: untouched on the page, it keeps its
   * stored value; changed on both sides, an object field brings only the members the user changed
   * over the stored object when both have the same members, so a sender rule added from Mejl
   * survives a change to Kortare svar. What the user changed is judged against the form's reading
   * at the last acknowledged save the user typed through, or else against its reading when drawn:
   * a field typed back to its first value after a save is the user's change, not an untouched one.
   * Without a reading taken when the page was drawn, the form decides every field.
   */
  private changes(key: AssistantSettingsPart, own: Partial<AssistantSettings>, saved: AssistantSettings): Partial<AssistantSettings> {
    const { initial, drawn, sent } = this.parts[key];
    if (!initial || !drawn) return own;
    // Field by field: every value below comes from the page's own readings or the stored settings.
    const mine = own as Record<string, unknown>, before = (sent ?? initial) as Record<string, unknown>, then = drawn as Record<string, unknown>, stored = saved as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(mine)) {
      const start = before[name], current = stored[name];
      const changedHere = canonical(value) !== canonical(start), changedElsewhere = canonical(current ?? null) !== canonical(then[name] ?? null);
      if (!changedElsewhere) { result[name] = value; continue; }
      if (!changedHere) continue;
      result[name] = plain(value) && plain(start) && plain(current) && canonical(Object.keys(value).sort()) === canonical(Object.keys(current).sort())
        ? { ...current, ...Object.fromEntries(Object.entries(value).filter(([member, entry]) => canonical(entry) !== canonical(start[member]))) } : value;
    }
    return result as Partial<AssistantSettings>;
  }
  /** Saves a page; with a conflict only after the user chose to save their own changes over the new values. */
  private async submit(key: AssistantSettingsPart, overwrite = false) {
    const part = this.parts[key];
    if (!this.saved || part.saving) return;
    if (part.conflicted && !overwrite) {
      part.status.textContent = 'Välj först om du vill läsa in de nya värdena eller spara dina ändringar över dem.';
      part.conflict.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); return;
    }
    if (!part.form.reportValidity()) return;
    const own = this.read(key);
    if (typeof own === 'string') { part.status.textContent = own; return; }
    const settings: AssistantSettings = { ...structuredClone(this.saved), ...this.changes(key, own, this.saved) };
    part.status.textContent = 'Sparar inställningar…';
    const version = part.version;
    part.saving = true;
    let saved = false;
    try { saved = await this.save(settings); } finally { part.saving = false; }
    if (saved) {
      // The acknowledged view has already replaced the saved base; re-render from it.
      if (version === part.version) { this.clean(key); part.key = ''; this.sync(this.saved ?? settings); part.status.textContent = 'Inställningarna är sparade.'; }
      else {
        // Later typing is checked for conflicts against this acknowledged write, never a newer view. The
        // form's untouched fields still show what it was drawn from, so `drawn` stays: a value kept from
        // elsewhere in this save is kept again by the next one unless the user changes it. What the user
        // changes from now on is any difference from what the form held for this save, so typing a field
        // back to its first value while the save was on its way is saved by the next one.
        part.sent = own;
        part.key = this.slice(key, this.saved ?? settings); this.setConflict(key, false);
        part.status.textContent = 'Inställningarna sparades. Dina senaste ändringar är fortfarande osparade.';
      }
    } else {
      part.status.textContent = 'Inställningarna kunde inte sparas. Dina ändringar finns kvar.';
      // Views that arrived during the save were not judged; judge the page now.
      if (this.saved) this.sync(this.saved);
    }
    this.changed();
  }
  /** Runtime status re-renders on every poll without touching unsaved form fields. */
  syncLocal(runtime?: AssistantLocalRuntime) {
    this.runtime = runtime;
    const key = JSON.stringify(runtime ?? null); if (key === this.runtimeKey) return; this.runtimeKey = key;
    const focused = this.localRoot.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.localFocus : undefined;
    this.localRoot.replaceChildren(node('h4', 'Lokala modeller'));
    const operation = runtime?.operation, busy = operation?.status === 'running' || operation?.status === 'aborting';
    const status = node('p', '', 'assistant-local-status'); status.setAttribute('role', 'status');
    if (!runtime || !runtime.checkedAt) status.textContent = runtime?.checking ? 'Kontrollerar Ollama…' : 'Ollamas status är inte kontrollerad ännu.';
    else if (!runtime.reachable) status.textContent = runtime.message || 'Ollama hittades inte på den här datorn.';
    else status.textContent = `Ollama ${runtime.version ?? ''} körs lokalt på 127.0.0.1.`;
    const refresh = button(runtime?.checking ? 'Kontrollerar…' : 'Kontrollera igen', () => this.local('local-refresh'), 'quiet'); refresh.dataset.localFocus = 'refresh';
    refresh.dataset.blocked = String(!!runtime?.checking); refresh.disabled = !!runtime?.checking;
    this.localRoot.append(status, refresh);
    if (runtime?.checkedAt && !runtime.reachable) {
      const install = node('p', 'Installera Ollama från den officiella webbplatsen och starta appen. Tabai startar, stänger eller uppdaterar aldrig Ollama själv.', 'muted');
      this.localRoot.append(install, sourceLink('Ladda ned Ollama (ollama.com)', OLLAMA_DOWNLOAD_URL));
    }
    if (operation) {
      const progress = node('div', '', 'assistant-local-operation'); progress.dataset.localOperation = operation.status;
      const info = assistantLocalModelInfo[operation.model];
      progress.append(node('p', `${operationLabels[operation.kind]} · ${info.label}: ${operation.message}`, operation.status === 'failed' ? 'module-error' : 'muted'));
      if (operation.total) {
        const bar = node('progress'); bar.max = operation.total; bar.value = Math.min(operation.completed ?? 0, operation.total);
        bar.setAttribute('aria-label', `${operationLabels[operation.kind]} ${info.label}`);
        progress.append(bar, node('span', operation.kind === 'pull' ? `${gigabytes(operation.completed ?? 0)} av ${gigabytes(operation.total)}` : `${operation.completed ?? 0} av ${operation.total}`, 'muted'));
      }
      if (operation.status === 'running') {
        const cancel = button('Avbryt', () => this.local('local-cancel', { operationId: operation.id }), 'quiet'); cancel.dataset.localCancel = operation.id; cancel.dataset.localFocus = 'cancel';
        progress.append(cancel);
        if (operation.kind === 'pull') progress.append(node('p', 'Avbryt stänger Tabais hämtning. Ollama kan ha sparat en del av filen och återupptar vid nästa hämtning.', 'muted'));
      }
      this.localRoot.append(progress);
    }
    const list = node('div', '', 'assistant-local-models');
    for (const id of assistantLocalModelIds) {
      const info = assistantLocalModelInfo[id], model = runtime?.models.find(entry => entry.id === id);
      const row = node('article', '', 'assistant-local-model'); row.dataset.localModel = id; row.dataset.state = model?.state ?? 'unknown';
      row.append(node('h5', `${info.label} · ${info.role}`), node('p', `${modelStates[model?.state ?? 'unknown']}${model?.verifiedAt ? ' · självtest godkänt' : ''}${model?.loaded ? ` · laddad i minnet${model.vramBytes ? ` (${gigabytes(model.vramBytes)})` : ''}` : ''} · ${info.size}`, 'muted'));
      if (info.notice && !model?.verifiedAt) row.append(node('p', info.notice, 'module-error'));
      if (model?.message && model.state !== 'ready') row.append(node('p', model.message, 'muted'));
      const licence = node('p', 'Licens: ', 'muted'); licence.append(sourceLink(info.license.name, info.license.url)); if (info.license.note) licence.append(document.createTextNode(` ${info.license.note}`));
      row.append(licence);
      const actions = node('div', '', 'assistant-actions'), offline = !runtime?.reachable;
      const add = (label: string, action: 'local-pull' | 'local-selftest' | 'local-unload', key: string) => {
        const control = button(label, () => this.local(action, { model: id })); control.dataset.localAction = key; control.dataset.localFocus = `${key}:${id}`;
        control.dataset.blocked = String(busy || offline); control.disabled = busy || offline; actions.append(control);
      };
      if (!model || model.state === 'missing' || model.state === 'mismatch' || model.state === 'unknown') add(model?.state === 'mismatch' ? 'Hämta igen' : 'Hämta modellen', 'local-pull', 'pull');
      if (model && (model.state === 'ready' || model.state === 'untested')) add('Kör självtest', 'local-selftest', 'selftest');
      if (model?.loaded) add('Ladda ur från minnet', 'local-unload', 'unload');
      row.append(actions); list.append(row);
    }
    this.localRoot.append(list, node('p', 'Självtestet använder ett ofarligt testverktyg och inget privat innehåll. Det krävs efter varje ny Ollama-version. Urladdning frigör minne; modellfilerna ligger kvar tills du själv tar bort dem i Ollama.', 'muted'));
    if (focused) this.localRoot.querySelector<HTMLElement>(`[data-local-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  private addAccount(account: AssistantAccount, saved = false) {
    const row = node('fieldset', '', 'assistant-account'); row.dataset.account = account.id; row.dataset.saved = String(saved);
    row.append(node('legend', account.label || 'Nytt konto'));
    const wrapper = node('div', '', 'field'), label = node('label', 'E-posttjänst'), provider = node('select');
    provider.name = 'provider'; provider.id = `assistant-${this.namespace}-provider-${account.id}`; label.htmlFor = provider.id;
    provider.disabled = saved;
    for (const [value, text] of Object.entries(providers)) provider.append(new Option(text, value)); provider.value = account.provider; wrapper.append(label, provider); row.append(wrapper);
    for (const [name, caption, value] of [['label', 'Kontonamn', account.label], ['email', 'E-postadress', account.email], ['url', 'Kontots webbadress', account.url]]) {
      const control = field(caption, `${name}-${account.id}`, value, false, this.namespace); control.input.name = name; control.input.required = true;
      if (name === 'email') { control.input.type = 'email'; control.input.readOnly = saved; control.input.maxLength = 254; }
      if (name === 'label') control.input.maxLength = 120;
      if (name === 'url') control.input.type = 'url'; row.append(control.wrapper);
    }
    const emailInput = row.querySelector<HTMLInputElement>('[name="email"]')!, urlInput = row.querySelector<HTMLInputElement>('[name="url"]')!;
    let previousEmail = emailInput.value.trim();
    emailInput.addEventListener('input', () => {
      const service = provider.value as AssistantAccount['provider'];
      if (urlInput.value === accountUrl(service, previousEmail)) urlInput.value = accountUrl(service, emailInput.value.trim());
      previousEmail = emailInput.value.trim();
    });
    provider.onchange = () => { urlInput.value = accountUrl(provider.value as AssistantAccount['provider'], emailInput.value.trim()); };
    const enabledLabel = node('label', '', 'checkpoint-option'), enabled = node('input'); enabled.type = 'checkbox'; enabled.name = 'enabled'; enabled.checked = account.enabled;
    enabledLabel.append(enabled, document.createTextNode('Ta med i kontroller')); row.append(enabledLabel);
    const actions = node('div', '', 'assistant-actions'), open = button('Öppna kontot', () => this.open(account.id)); open.dataset.blocked = String(!saved); open.disabled = !saved;
    const test = button('Testa läsåtkomst', () => { if (!this.parts.accounts.dirty && saved) this.test(account.id); }); test.dataset.testAccount = account.id; test.dataset.blocked = String(!saved); test.disabled = !saved;
    actions.append(open, test, button('Ta bort konto', () => { row.remove(); this.markDirty('accounts'); }));
    if (saved) { const link = sourceLink('Öppna sparat konto i en ny flik', account.url); link.classList.add('assistant-account-link'); row.append(link); }
    const testResult = node('section', '', 'assistant-account-test'); testResult.dataset.accountTest = account.id; testResult.setAttribute('aria-label', 'Kontots lästest');
    row.append(actions, node('p', '', 'muted assistant-test-save-help'), testResult, node('p', saved ? 'Lägg till ett nytt konto om tjänst eller e-postadress ändras.' : 'Spara kontot först. Därefter kan du öppna det och logga in.', 'muted')); this.accounts.append(row);
  }
  private addSenderRule(container: HTMLElement, settings: AssistantSettings, rule?: SenderRule) {
    const row = node('div', '', 'assistant-sender-rule'); row.dataset.senderRule = 'true';
    const accountLabel = node('label', '', 'field'), accountCaption = node('span', 'Konto');
    const account = node('select'); account.name = 'sender-account';
    for (const item of settings.accounts) account.append(new Option(item.label || item.email, item.id)); account.value = rule?.accountId || settings.accounts[0]?.id || ''; accountLabel.append(accountCaption, account);
    const emailLabel = node('label', '', 'field'), emailCaption = node('span', 'Avsändarens e-post');
    const email = node('input'); email.type = 'email'; email.name = 'sender-email'; email.required = true; email.placeholder = 'avsändare@exempel.se'; email.value = rule?.email || ''; email.maxLength = 254; emailLabel.append(emailCaption, email);
    const priorityLabel = node('label', '', 'field'), priorityCaption = node('span', 'Prioritet');
    const priority = node('select'); priority.name = 'sender-priority'; priority.append(new Option('Hög', 'high'), new Option('Normal', 'normal')); priority.value = rule?.priority || 'high'; priorityLabel.append(priorityCaption, priority);
    const remove = button('Ta bort', () => { row.remove(); this.markDirty('accounts'); }); remove.className = 'quiet';
    row.append(accountLabel, emailLabel, priorityLabel, remove); container.append(row);
  }
}
