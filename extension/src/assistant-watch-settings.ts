import { node } from './module-views';
import { button, details, section, sourceLink, timestamp, type AssistantAction } from './assistant-controls';
import { chatModelSelect } from './assistant-chat-settings';
import { assistantChatModelLabel, assistantWatchDefaultModel, type AssistantChatView } from '../../shared/assistant-chat';
import { ASSISTANT_WATCH_CAPACITY_WARNING, ASSISTANT_WATCH_FAILURE_LIMIT, assistantRoutineRunsPerDay, assistantScheduleCapacityWarning, assistantWatchHistory, assistantWatchTrend, type AssistantWatchCadence, type AssistantWatchHistoryEntry, type AssistantWatchView } from '../../shared/assistant-services';

/** The schedule in the user's words, as on the watch card. */
export function assistantWatchSchedule(cadence: AssistantWatchCadence) {
  return 'time' in cadence ? `Varje dag kl. ${cadence.time}` : cadence.hours === 1 ? 'Varje timme' : `Var ${cadence.hours}:e timme`;
}
/** What every unattended run costs on the chosen model. */
export function assistantWatchCost(model: string) {
  const backend = model.split(':')[0];
  if (backend === 'local') return 'Körs på den här datorn utan kostnad.';
  if (backend === 'berget') return 'Varje körning kostar pengar hos Berget, som debiterar varje anrop.';
  return `Varje körning drar användning av ditt ${backend === 'claude' ? 'Claude' : 'Codex'}-abonnemang.`;
}

/** The list of watches with Kör nu, Pausa/Återuppta and Ta bort: its own view, opened from the conversation list or the settings. */
export class AssistantWatchList {
  readonly element = node('div', '', 'assistant-watch-overview');
  private intro = section('Bevakningar', 'watches', 'Be om en bevakning i chatten, till exempel ”Bevaka priset på laddboxen på example.se varje morgon”. Agenten föreslår ett kort som du godkänner. En bevakning läser bara offentliga sidor i ett eget inkognitofönster och kan inte klicka, fylla i eller logga in. Bevakningar kräver att webbåtkomsten i chatten är på, minst Söka och läsa.');
  private webNotice = node('div', '', 'notice assistant-watch-web');
  private capacity = node('p', ASSISTANT_WATCH_CAPACITY_WARNING, 'notice assistant-watch-capacity');
  private error = node('p', '', 'module-error');
  private list = node('div', '', 'assistant-watch-list');
  private results = button('Visa resultaten i samtalet Bevakningar', () => void this.showResults());
  private view?: AssistantChatView;
  private webOff = true;
  private timezone = 'Europe/Stockholm';
  private key = '';
  constructor(private act: AssistantAction, private openWeb: () => void, private showChat: () => Promise<boolean>) {
    this.error.setAttribute('role', 'alert');
    this.webNotice.append(node('p', 'Webbåtkomsten i chatten är avstängd. Bevakningarna är pausade och kan inte köras förrän du slår på Söka och läsa.'), button('Öppna Webbåtkomst', () => this.openWeb()));
    this.intro.append(this.webNotice, this.capacity, this.error, this.list, this.results);
    this.element.append(this.intro);
  }
  update(view: AssistantChatView | undefined, webOff: boolean, timezone: string) {
    this.view = view; this.webOff = webOff; this.timezone = timezone;
    this.webNotice.hidden = !webOff;
    this.error.textContent = view?.watchesError ?? ''; this.error.hidden = !this.error.textContent;
    this.results.hidden = !view?.watchConversationId;
    const routines = (view?.routines ?? []).filter(routine => routine.enabled).map(routine => assistantRoutineRunsPerDay(routine.schedule));
    const key = JSON.stringify([view?.watches, webOff, timezone, routines]);
    if (key === this.key) return; this.key = key;
    this.list.replaceChildren();
    const watches = view?.watches ?? [];
    // Routines share the schedule, so the warning counts them too.
    const warning = assistantScheduleCapacityWarning(watches.filter(watch => watch.enabled).map(watch => watch.runsPerDay), routines);
    this.capacity.textContent = warning ?? ASSISTANT_WATCH_CAPACITY_WARNING; this.capacity.hidden = !warning;
    if (!watches.length) this.list.append(node('p', 'Inga bevakningar ännu. Be om en i chatten när webbåtkomsten är på.', 'assistant-empty'));
    const running = watches.some(watch => watch.running);
    for (const watch of watches) this.list.append(this.renderWatch(watch, running));
  }
  private renderWatch(watch: AssistantWatchView, anyRunning: boolean) {
    const row = node('article', '', 'assistant-watch'); row.dataset.watchId = watch.id;
    const failures = !watch.enabled && !!watch.pausedAfterFailures;
    const state = watch.running ? 'Körs nu…' : watch.paused ? watch.paused : watch.enabled ? 'Aktiv' : failures ? 'Pausad efter misslyckanden' : 'Pausad';
    row.dataset.state = watch.running ? 'running' : watch.paused ? 'blocked' : watch.enabled ? 'active' : failures ? 'paused-failures' : 'paused';
    const head = node('div', '', 'assistant-watch-head'); head.append(node('h4', watch.title), node('span', state, 'assistant-watch-state'));
    const target = node('p', '', 'assistant-watch-target');
    if ('url' in watch.target) { target.append(node('span', 'Sida: ')); target.append(sourceLink(watch.target.url, watch.target.url)); }
    else target.textContent = `Sökning: ”${watch.target.query}”`;
    const schedule = node('p', `${assistantWatchSchedule(watch.cadence)} · ${watch.runsPerDay} ${watch.runsPerDay === 1 ? 'körning' : 'körningar'} per dygn`, 'muted');
    if (watch.nextRunAt && watch.enabled && !watch.paused) { schedule.append(document.createTextNode(' · Nästa: ')); schedule.append(timestamp(watch.nextRunAt, this.timezone)); }
    row.append(head, target, node('p', `Villkor: ${watch.condition}`, 'assistant-watch-condition'), schedule);
    if (failures) row.append(node('p', `Tabai pausade bevakningen efter ${ASSISTANT_WATCH_FAILURE_LIMIT} misslyckade körningar i rad. Återuppta den när sidan går att läsa igen.`, 'notice assistant-watch-failures'));
    if (watch.lastResult) {
      const result = node('div', '', `assistant-watch-result assistant-watch-${watch.lastResult.status === 'failed' ? 'failed' : watch.lastResult.changed ? 'changed' : 'unchanged'}`);
      const when = node('p', `${watch.lastResult.status === 'failed' ? 'Kunde inte köras' : watch.lastResult.changed ? 'Ändring' : 'Ingen ändring'} · `, 'assistant-watch-outcome');
      when.append(timestamp(watch.lastResult.at, this.timezone));
      result.append(when, node('p', watch.lastResult.summary, 'module-summary')); row.append(result);
    } else row.append(node('p', 'Inte körd ännu.', 'muted'));
    row.append(...this.renderHistory(watch));
    const actions = node('div', '', 'assistant-actions');
    const run = button('Kör nu', () => void this.act('correct', { action: 'watch-run', watchId: watch.id }));
    run.dataset.watchAction = 'run'; run.dataset.blocked = String(this.webOff || !!watch.paused || anyRunning);
    if (this.webOff) run.title = 'Slå på webbåtkomsten för att köra bevakningen.'; else if (anyRunning) run.title = 'En bevakning körs redan.';
    const pause = button(watch.enabled ? 'Pausa' : 'Återuppta', () => void this.act('correct', { action: 'watch-pause', watchId: watch.id, paused: String(watch.enabled) }));
    pause.dataset.watchAction = 'pause';
    const remove = button('Ta bort', async () => { if (window.confirm(`Ta bort bevakningen ”${watch.title}”? Tidigare resultat finns kvar i samtalet Bevakningar.`)) await this.act('correct', { action: 'watch-delete', watchId: watch.id }); }, 'assistant-danger');
    remove.dataset.watchAction = 'delete';
    actions.append(run, pause, remove); row.append(actions);
    return row;
  }
  /**
   * The trend: with values, the latest numbers and the last step's direction;
   * otherwise the three latest summaries, folded away.
   */
  private renderHistory(watch: AssistantWatchView): HTMLElement[] {
    const history = assistantWatchHistory(watch), trend = assistantWatchTrend(history);
    if (trend) {
      const line = node('p', '', 'assistant-watch-trend'); line.dataset.direction = trend.direction;
      const spoken = { down: 'det senaste värdet är lägre', up: 'det senaste värdet är högre', same: 'det senaste värdet är oförändrat', none: '' }[trend.direction];
      line.append(node('span', 'Trend', 'assistant-watch-trend-label'), node('span', trend.text, 'assistant-watch-trend-values'));
      if (spoken) line.append(node('span', `, ${spoken}`, 'visually-hidden'));
      return [line];
    }
    if (history.length < 2) return [];
    const recent = history.slice(-3).reverse(), folded = details(`Senaste resultaten (${recent.length})`, `watch-history-${watch.id}`);
    folded.classList.add('assistant-watch-history');
    const list = node('ol', '', 'assistant-watch-history-list');
    for (const entry of recent) list.append(this.historyEntry(entry));
    folded.append(list);
    return [folded];
  }
  private historyEntry(entry: AssistantWatchHistoryEntry) {
    const item = node('li', '', `assistant-watch-history-entry assistant-watch-${entry.status === 'failed' ? 'failed' : entry.changed ? 'changed' : 'unchanged'}`);
    const when = node('p', `${entry.status === 'failed' ? 'Kunde inte köras' : entry.changed ? 'Ändring' : 'Ingen ändring'} · `, 'assistant-watch-outcome');
    when.append(timestamp(entry.at, this.timezone));
    item.append(when, node('p', entry.summary, 'module-summary'));
    return item;
  }
  private async showResults() {
    const id = this.view?.watchConversationId; if (!id) return;
    if (await this.act('correct', { action: 'chat-select', conversationId: id })) await this.showChat();
  }
}

/** Inställningar → Bevakningar: the model watches run with and their notices, with a way to the list. */
export class AssistantWatchSettings {
  readonly element = node('div', '', 'assistant-watch-settings');
  private overview = section('Dina bevakningar', 'watch-overview', 'Listan med dina bevakningar finns också överst i samtalslistan.');
  private count = node('p', '', 'assistant-watch-count');
  private model = section('Modell för bevakningar', 'watch-model', 'Bevakningar körs automatiskt medan du inte tittar. Lokal Qwen 3.5 4B är förvald och körs på datorn utan kostnad. Modellen gäller bara bevakningar, aldrig chatten.');
  private modelSelect = chatModelSelect('watch-model');
  private cost = node('p', '', 'assistant-watch-cost');
  private status = node('p', '', 'muted');
  private notify = node('input');
  private permission = node('div', '', 'notice assistant-watch-permission');
  private view?: AssistantChatView;
  private saving = false;
  constructor(private act: AssistantAction, openList: () => void) {
    this.status.setAttribute('role', 'status');
    this.overview.append(this.count, button('Visa bevakningarna', openList, 'assistant-watch-open'));
    const label = node('label', '', 'field'); label.append(node('span', 'Modell'), this.modelSelect);
    this.modelSelect.onchange = () => void this.saveModel();
    this.notify.type = 'checkbox'; this.notify.name = 'watch-notify';
    const notifyLabel = node('label', '', 'checkpoint-option'); notifyLabel.append(this.notify, document.createTextNode('Avisera mig när en bevakning slår till'));
    this.notify.onchange = () => void this.saveNotify();
    // On by default, but Chrome only shows notices it was allowed to: ask on the user's click.
    this.permission.append(node('p', 'Chrome har inte gett Tabai lov att visa aviseringar. Träffar syns då bara i samtalet Bevakningar.'), button('Tillåt aviseringar i Chrome', () => void this.requestPermission()));
    this.permission.hidden = true;
    this.model.append(label, this.cost, notifyLabel, this.permission, node('p', 'Aviseringen säger bara att en bevakning har slagit till; resultatet finns i samtalet Bevakningar.', 'muted'), this.status);
    this.element.append(this.overview, this.model);
  }
  update(view: AssistantChatView | undefined) {
    this.view = view;
    const model = view?.watchModel ?? assistantWatchDefaultModel;
    if (!this.saving) { this.modelSelect.value = model; this.notify.checked = view?.watchNotifications !== false; }
    this.notify.disabled = this.saving || !view;
    void this.checkPermission();
    this.renderCost(this.modelSelect.value);
    const watches = view?.watches ?? [], active = watches.filter(watch => watch.enabled).length;
    this.count.textContent = watches.length ? `${watches.length} ${watches.length === 1 ? 'bevakning' : 'bevakningar'}, ${active} ${active === 1 ? 'aktiv' : 'aktiva'}.` : 'Inga bevakningar ännu.';
    this.modelSelect.disabled = this.saving || !view;
  }
  private renderCost(model: string) {
    const watches = this.view?.watches?.filter(watch => watch.enabled) ?? [];
    const runs = watches.reduce((total, watch) => total + watch.runsPerDay, 0), cloud = !model.startsWith('local:');
    this.cost.textContent = `${assistantChatModelLabel(model)}. ${assistantWatchCost(model)}${runs ? ` Dina aktiva bevakningar körs ${runs} ${runs === 1 ? 'gång' : 'gånger'} per dygn.` : ''}`;
    this.cost.className = cloud ? 'notice assistant-watch-cost' : 'muted assistant-watch-cost';
    this.cost.dataset.cloud = String(cloud);
  }
  private async saveModel() {
    if (this.saving) return;
    const model = this.modelSelect.value; this.saving = true; this.renderCost(model); this.modelSelect.disabled = this.notify.disabled = true;
    const ok = await this.act('correct', { action: 'watch-model', model });
    this.saving = false; this.status.textContent = ok ? 'Modellen för bevakningar är sparad. Den gäller från nästa körning.' : 'Modellen kunde inte sparas.';
    this.update(this.view);
  }
  /** Asking Chrome happens on the user's own click; a refusal keeps the setting off. */
  private async saveNotify() {
    if (this.saving) return;
    this.saving = true; this.notify.disabled = this.modelSelect.disabled = true;
    this.status.textContent = '';
    let enabled = this.notify.checked;
    if (enabled && typeof chrome !== 'undefined' && chrome.permissions?.request) {
      try { if (!await chrome.permissions.contains({ permissions: ['notifications'] })) enabled = await chrome.permissions.request({ permissions: ['notifications'] }); }
      catch { enabled = false; }
      if (!enabled) { this.notify.checked = false; this.status.textContent = 'Chrome tillät inte aviseringar. Bevakningarnas resultat finns fortfarande i samtalet Bevakningar.'; }
    }
    try {
      const ok = await this.act('correct', { action: 'watch-notify', enabled: String(enabled) });
      if (!ok) { this.notify.checked = this.view?.watchNotifications !== false; this.status.textContent = 'Aviseringsinställningen kunde inte sparas. Försök igen.'; }
      else { this.notify.checked = enabled; if (enabled) this.status.textContent = 'Aviseringar för bevakningar är på.'; else if (!this.status.textContent) this.status.textContent = 'Aviseringar för bevakningar är av.'; }
    } finally { this.saving = false; this.notify.disabled = this.modelSelect.disabled = !this.view; }
  }
  private async checkPermission() {
    let missing = false;
    if (this.notify.checked && typeof chrome !== 'undefined' && chrome.permissions?.contains) {
      try { missing = !await chrome.permissions.contains({ permissions: ['notifications'] }); } catch { missing = false; }
    }
    this.permission.hidden = !missing;
  }
  private async requestPermission() {
    let granted = false;
    try { granted = await chrome.permissions.request({ permissions: ['notifications'] }); } catch { granted = false; }
    this.permission.hidden = granted;
    this.status.textContent = granted ? 'Chrome visar nu aviseringar när en bevakning slår till.' : 'Chrome tillät inte aviseringar. Träffarna finns i samtalet Bevakningar.';
  }
}
