import { node } from './module-views';
import { button, field, section, timestamp, type AssistantAction } from './assistant-controls';
import { assistantChatModelLabel, type AssistantChatView } from '../../shared/assistant-chat';
import { assistantWatchCost } from './assistant-watch-settings';
import {
  ASSISTANT_WATCH_FAILURE_LIMIT, assistantRoutineRunsPerDay, assistantRoutineScheduleText, assistantRoutineTaskLabels, assistantScheduleCapacityWarning,
  type AssistantRoutineDefinition, type AssistantRoutineSchedule, type AssistantRoutineTask, type AssistantRoutineView,
} from '../../shared/assistant-services';
import type { AssistantWorkspace } from '../../shared/assistant';

const DAYS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
const DAY_NAMES = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
let sequence = 0;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A time and the weekday toggles of a schedule. No chosen day means every day,
 * which the hint under the toggles says.
 */
function scheduleEditor(namespace: string, schedule: AssistantRoutineSchedule, changed: () => void) {
  const wrapper = node('div', '', 'assistant-routine-schedule');
  const time = field('Tid', `${namespace}-time`, schedule.time, false, namespace);
  time.input.type = 'time'; time.input.required = true; time.input.step = '60'; time.input.defaultValue = schedule.time; time.input.dataset.routineTime = 'true';
  const days = node('fieldset', '', 'assistant-routine-days');
  const toggles = node('div', '', 'assistant-routine-day-toggles');
  const chosen = new Set(schedule.days?.length && schedule.days.length < 7 ? schedule.days : []);
  days.append(node('legend', 'Dagar'), toggles, node('p', 'Välj inga dagar för varje dag.', 'muted'));
  const inputs = DAYS.map((label, index) => {
    const option = node('label', '', 'assistant-routine-day'), input = node('input');
    input.type = 'checkbox'; input.name = `${namespace}-day`; input.value = String(index + 1); input.checked = input.defaultChecked = chosen.has(index + 1);
    input.setAttribute('aria-label', capitalized(DAY_NAMES[index])); input.dataset.routineDay = String(index + 1);
    option.append(input, node('span', label, '')); toggles.append(option);
    return input;
  });
  wrapper.append(time.wrapper, days);
  wrapper.addEventListener('input', changed); wrapper.addEventListener('change', changed);
  return {
    element: wrapper, time: time.input,
    read(): AssistantRoutineSchedule {
      const picked = inputs.filter(input => input.checked).map(input => Number(input.value));
      return { time: time.input.value, ...(picked.length && picked.length < 7 ? { days: picked } : {}) };
    },
  };
}

/**
 * Inställningar → Rutiner: the routines with Kör nu, Pausa, Ändra tid and Ta
 * bort, a form for a new one, and the setting for their notices. Drafts in the
 * form and in an open time editor survive the panel's polling.
 */
export class AssistantRoutineSettings {
  readonly element = node('div', '', 'assistant-routine-settings');
  private namespace = `routine-${++sequence}`;
  private overview = section('Dina rutiner', 'routines', 'En rutin ställer en fråga i chatten eller startar ett uppdrag vid en tid du väljer. Chattens svar hamnar i samtalet Rutiner och ett uppdrag visas i Mejl. En rutin läser högst på webben och godkänner aldrig något själv: kort som den föreslår väntar på dig. Du kan också be om en rutin i chatten, till exempel ”Varje fredag kl. 16 vill jag ha en sammanfattning av veckans mejl”.');
  private capacity = node('p', '', 'notice assistant-routine-capacity');
  private error = node('p', '', 'module-error');
  private list = node('div', '', 'assistant-routine-list');
  private results = button('Visa svaren i samtalet Rutiner', () => void this.showResults());
  private create = button('Ny rutin', () => this.openForm(), 'primary assistant-routine-new');
  private form = node('form', '', 'assistant-routine-form');
  private formTitle!: HTMLInputElement;
  private formPrompt!: HTMLTextAreaElement;
  private formTask = node('select');
  private formKind: HTMLInputElement[] = [];
  private formSchedule!: ReturnType<typeof scheduleEditor>;
  private formNote = node('p', '', 'muted assistant-routine-note');
  private formStatus = node('p', '', 'muted');
  private notify = node('input');
  private permission = node('div', '', 'notice assistant-routine-permission');
  private notifyStatus = node('p', '', 'muted');
  private view?: AssistantChatView;
  private workspace?: AssistantWorkspace;
  private key = '';
  private saving = false;
  private notifySaving = false;
  private formVersion = 0;
  /** The routine whose time is being changed, with the draft the user has typed. */
  private editing?: { id: string; schedule: AssistantRoutineSchedule };
  constructor(private act: AssistantAction, private showChat: () => Promise<boolean>) {
    this.error.setAttribute('role', 'alert'); this.formStatus.setAttribute('role', 'status'); this.notifyStatus.setAttribute('role', 'status');
    this.capacity.hidden = true;
    this.buildForm();
    const head = node('div', '', 'assistant-actions assistant-routine-tools'); head.append(this.create, this.results);
    this.overview.append(this.capacity, this.error, head, this.form, this.list);
    const notices = section('Aviseringar', 'routine-notices', 'Aviseringen säger bara att rutinen är klar och vad den heter. Svaret finns i samtalet Rutiner och ett uppdrag i Mejl.');
    this.notify.type = 'checkbox'; this.notify.name = 'routine-notify';
    const notifyLabel = node('label', '', 'checkpoint-option'); notifyLabel.append(this.notify, document.createTextNode('Avisera mig när en rutin är klar'));
    this.notify.onchange = () => void this.saveNotify();
    this.permission.append(node('p', 'Chrome har inte gett Tabai lov att visa aviseringar. Rutinernas svar syns då bara i samtalet Rutiner.'), button('Tillåt aviseringar i Chrome', () => void this.requestPermission()));
    this.permission.hidden = true;
    notices.append(notifyLabel, this.permission, this.notifyStatus);
    this.element.append(this.overview, notices);
  }
  private buildForm() {
    this.form.hidden = true; this.form.setAttribute('aria-label', 'Ny rutin');
    const title = field('Namn', `${this.namespace}-title`, '', false, this.namespace); title.input.maxLength = 120; title.input.required = true; this.formTitle = title.input;
    const kind = node('fieldset', '', 'assistant-routine-kind'); kind.append(node('legend', 'Vad ska rutinen göra?'));
    for (const [value, label] of [['chat', 'Ställa en fråga i chatten'], ['task', 'Starta ett uppdrag']] as const) {
      const option = node('label', '', 'assistant-routine-kind-option'), input = node('input');
      input.type = 'radio'; input.name = `${this.namespace}-kind`; input.value = value; input.checked = input.defaultChecked = value === 'chat';
      option.append(input, document.createTextNode(label)); kind.append(option); this.formKind.push(input);
    }
    const prompt = field('Fråga', `${this.namespace}-prompt`, '', true, this.namespace); prompt.input.maxLength = 2000; prompt.input.rows = 3;
    prompt.input.placeholder = 'Till exempel: Sammanfatta veckans viktigaste nyheter om elpriset.'; this.formPrompt = prompt.input;
    prompt.wrapper.dataset.routineField = 'prompt';
    const task = node('div', '', 'field'), taskLabel = node('label', 'Uppdrag'); this.formTask.id = `assistant-${this.namespace}-task`; this.formTask.name = 'routine-task'; taskLabel.htmlFor = this.formTask.id;
    task.append(taskLabel, this.formTask); task.dataset.routineField = 'task';
    this.formSchedule = scheduleEditor(`${this.namespace}-new`, { time: '08:00' }, () => this.renderNote());
    const save = node('button', 'Spara rutinen', 'primary'); save.type = 'submit';
    const actions = node('div', '', 'assistant-actions'); actions.append(save, button('Avbryt', () => this.closeForm()));
    this.form.append(node('h4', 'Ny rutin'), title.wrapper, kind, prompt.wrapper, task, this.formSchedule.element, this.formNote, actions, this.formStatus);
    this.form.onchange = this.form.oninput = () => { this.formVersion++; this.renderNote(); };
    this.form.onsubmit = event => { event.preventDefault(); void this.saveRoutine(); };
  }
  update(view: AssistantChatView | undefined, workspace: AssistantWorkspace) {
    this.view = view; this.workspace = workspace;
    this.error.textContent = view?.routinesError ?? ''; this.error.hidden = !this.error.textContent;
    this.results.hidden = !view?.routineConversationId;
    if (!this.notifySaving) this.notify.checked = view?.routineNotifications !== false;
    this.notify.disabled = this.notifySaving || !view;
    void this.checkPermission();
    this.renderTasks();
    this.renderNote();
    const routines = view?.routines ?? [];
    const warning = assistantScheduleCapacityWarning((view?.watches ?? []).filter(watch => watch.enabled).map(watch => watch.runsPerDay), routines.filter(routine => routine.enabled).map(routine => assistantRoutineRunsPerDay(routine.schedule)));
    this.capacity.textContent = warning ?? ''; this.capacity.hidden = !warning;
    const key = JSON.stringify([routines, workspace.settings.timezone, this.editing?.id]);
    if (key === this.key) return; this.key = key;
    if (this.editing && !routines.some(routine => routine.id === this.editing!.id)) this.editing = undefined;
    this.list.replaceChildren();
    if (!routines.length) this.list.append(node('p', 'Inga rutiner ännu. Lägg till en med Ny rutin eller be om en i chatten.', 'assistant-empty'));
    const running = routines.some(routine => routine.running);
    for (const routine of routines) this.list.append(this.renderRoutine(routine, running));
  }
  /** The tasks a routine can start: the four built in, then the user's own shortcuts. */
  private renderTasks() {
    const shortcuts = this.workspace?.shortcuts ?? [], key = JSON.stringify(shortcuts.map(shortcut => [shortcut.id, shortcut.label]));
    if (this.formTask.dataset.key === key) return;
    const selected = this.formTask.value; this.formTask.dataset.key = key; this.formTask.replaceChildren();
    for (const [task, label] of Object.entries(assistantRoutineTaskLabels)) this.formTask.append(new Option(label, task));
    if (shortcuts.length) {
      const group = node('optgroup'); group.label = 'Dina snabbknappar';
      for (const shortcut of shortcuts) group.append(new Option(shortcut.label, `shortcut:${shortcut.id}`));
      this.formTask.append(group);
    }
    if ([...this.formTask.options].some(option => option.value === selected)) this.formTask.value = selected;
  }
  private kind(): 'chat' | 'task' { return this.formKind.find(input => input.checked)?.value === 'task' ? 'task' : 'chat'; }
  /** What the new routine runs on, and that a task needs an active mail account. */
  private renderNote() {
    const chat = this.kind() === 'chat';
    this.form.querySelector<HTMLElement>('[data-routine-field="prompt"]')!.hidden = !chat;
    this.form.querySelector<HTMLElement>('[data-routine-field="task"]')!.hidden = chat;
    this.formPrompt.required = chat;
    const model = chat ? this.view?.model : this.view?.taskModel ?? this.view?.model;
    const accounts = this.workspace?.settings.accounts.some(account => account.enabled);
    this.formNote.textContent = chat
      ? `Svarar med chattmodellen${model ? `, ${assistantChatModelLabel(model)}` : ''}. ${model ? assistantWatchCost(model) : ''} Läser högst på webben, och bara när webbåtkomsten är på.`.replace(/\s+/g, ' ').trim()
      : `Startar uppdraget med uppdragsmodellen${model ? `, ${assistantChatModelLabel(model)}` : ''}, och med uppdragens egna regler för mejl och webb.${accounts ? '' : ' Lägg först till ett aktivt mejlkonto under Mejlkonton.'}`;
    this.formNote.className = chat || accounts ? 'muted assistant-routine-note' : 'notice assistant-routine-note';
  }
  private openForm() {
    this.form.hidden = false; this.create.hidden = true; this.formStatus.textContent = '';
    this.formTitle.focus();
  }
  private closeForm() {
    this.formVersion++; this.form.reset(); this.form.hidden = true; this.create.hidden = false; this.renderNote();
    this.create.focus();
  }
  private async saveRoutine() {
    if (this.saving || !this.form.reportValidity()) return;
    const schedule = this.formSchedule.read(), title = this.formTitle.value.trim();
    const [task, shortcutId] = this.formTask.value.startsWith('shortcut:') ? ['shortcut', this.formTask.value.slice('shortcut:'.length)] : [this.formTask.value];
    const routine: AssistantRoutineDefinition = this.kind() === 'chat' ? { kind: 'chat', title, prompt: this.formPrompt.value.trim(), schedule }
      : { kind: 'task', title, task: task as AssistantRoutineTask, ...(shortcutId ? { shortcutId } : {}), schedule };
    const version = this.formVersion;
    this.saving = true; this.formStatus.textContent = 'Sparar rutinen…';
    const ok = await this.act('correct', { action: 'routine-create', routine: JSON.stringify(routine) });
    this.saving = false;
    if (ok && version === this.formVersion) { this.closeForm(); this.formStatus.textContent = ''; }
    else if (ok) this.formStatus.textContent = 'Rutinen sparades. Dina senaste ändringar är fortfarande osparade.';
    else this.formStatus.textContent = 'Rutinen kunde inte sparas. Det du skrev finns kvar.';
  }
  private renderRoutine(routine: AssistantRoutineView, anyRunning: boolean) {
    const timezone = this.workspace?.settings.timezone ?? 'Europe/Stockholm';
    const row = node('article', '', 'assistant-routine'); row.dataset.routineId = routine.id;
    const failures = !routine.enabled && !!routine.pausedAfterFailures;
    const state = routine.running ? 'Körs nu…' : routine.enabled ? 'Aktiv' : failures ? 'Pausad efter misslyckanden' : 'Pausad';
    row.dataset.state = routine.running ? 'running' : routine.enabled ? 'active' : failures ? 'paused-failures' : 'paused';
    const head = node('div', '', 'assistant-routine-head'); head.append(node('h4', routine.title), node('span', state, 'assistant-routine-state'));
    const what = routine.kind === 'chat' ? node('p', `Fråga: ${routine.prompt}`, 'assistant-routine-what') : node('p', `Uppdrag: ${routine.label ?? assistantRoutineTaskLabels[routine.task as Exclude<AssistantRoutineTask, 'shortcut'>] ?? routine.task}`, 'assistant-routine-what');
    what.dataset.kind = routine.kind;
    const schedule = node('p', capitalized(assistantRoutineScheduleText(routine.schedule)), 'muted assistant-routine-when');
    if (routine.nextRunAt && routine.enabled) { schedule.append(document.createTextNode(' · Nästa: ')); schedule.append(timestamp(routine.nextRunAt, timezone)); }
    row.append(head, what, schedule);
    if (failures) row.append(node('p', `Tabai pausade rutinen efter ${ASSISTANT_WATCH_FAILURE_LIMIT} misslyckade körningar i rad. Återuppta den när det som stoppade den är åtgärdat.`, 'notice assistant-routine-failures'));
    if (routine.lastResult) {
      const result = node('div', '', `assistant-routine-result assistant-routine-${routine.lastResult.status}`);
      const when = node('p', `${routine.lastResult.status === 'failed' ? 'Kunde inte köras' : 'Klar'} · `, 'assistant-routine-outcome');
      when.append(timestamp(routine.lastResult.at, timezone));
      result.append(when, node('p', routine.lastResult.summary, 'module-summary')); row.append(result);
    } else row.append(node('p', 'Inte körd ännu.', 'muted'));
    const actions = node('div', '', 'assistant-actions');
    const run = button('Kör nu', () => void this.act('correct', { action: 'routine-run', routineId: routine.id }));
    run.dataset.routineAction = 'run'; run.dataset.blocked = String(anyRunning);
    if (anyRunning) run.title = 'En rutin körs redan.';
    const pause = button(routine.enabled ? 'Pausa' : 'Återuppta', () => void this.act('correct', { action: 'routine-pause', routineId: routine.id, paused: String(routine.enabled) }));
    pause.dataset.routineAction = 'pause';
    const edit = button('Ändra tid', () => this.edit(routine)); edit.dataset.routineAction = 'schedule';
    edit.setAttribute('aria-expanded', String(this.editing?.id === routine.id));
    const remove = button('Ta bort', async () => { if (window.confirm(`Ta bort rutinen ”${routine.title}”? Tidigare svar finns kvar i samtalet Rutiner.`)) await this.act('correct', { action: 'routine-delete', routineId: routine.id }); }, 'assistant-danger');
    remove.dataset.routineAction = 'delete';
    actions.append(run, pause, edit, remove); row.append(actions);
    if (this.editing?.id === routine.id) row.append(this.renderEditor(routine));
    return row;
  }
  private edit(routine: AssistantRoutineView) {
    this.editing = this.editing?.id === routine.id ? undefined : { id: routine.id, schedule: structuredClone(routine.schedule) };
    this.key = ''; if (this.view && this.workspace) this.update(this.view, this.workspace);
    this.list.querySelector<HTMLInputElement>(`[data-routine-id="${routine.id}"] [data-routine-time]`)?.focus();
  }
  /** The time editor keeps its draft in this.editing, so a poll that redraws the list does not lose it. */
  private renderEditor(routine: AssistantRoutineView) {
    const form = node('form', '', 'assistant-routine-editor'); form.setAttribute('aria-label', `Ändra tid för ${routine.title}`);
    const editor = scheduleEditor(`${this.namespace}-${routine.id}`, this.editing!.schedule, () => { if (this.editing?.id === routine.id) this.editing.schedule = editor.read(); });
    const save = node('button', 'Spara tiden', 'primary'); save.type = 'submit';
    const status = node('p', '', 'muted'); status.setAttribute('role', 'status');
    const actions = node('div', '', 'assistant-actions'); actions.append(save, button('Avbryt', () => this.edit(routine)));
    form.append(editor.element, actions, status);
    form.onsubmit = async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const editing = this.editing, schedule = editor.read(); status.textContent = 'Sparar tiden…';
      const ok = await this.act('correct', { action: 'routine-schedule', routineId: routine.id, schedule: JSON.stringify(schedule) });
      if (ok && this.editing === editing && JSON.stringify(editing?.schedule) === JSON.stringify(schedule)) { this.editing = undefined; this.key = ''; if (this.view && this.workspace) this.update(this.view, this.workspace); this.list.querySelector<HTMLButtonElement>(`[data-routine-id="${routine.id}"] [data-routine-action="schedule"]`)?.focus(); }
      else status.textContent = ok ? 'Tiden sparades. Dina senaste ändringar är fortfarande osparade.' : 'Tiden kunde inte sparas.';
    };
    return form;
  }
  private async showResults() {
    const id = this.view?.routineConversationId; if (!id) return;
    if (await this.act('correct', { action: 'chat-select', conversationId: id })) await this.showChat();
  }
  /** Asking Chrome happens on the user's own click; a refusal keeps the setting off. */
  private async saveNotify() {
    if (this.notifySaving) return;
    this.notifySaving = true; this.notify.disabled = true;
    let enabled = this.notify.checked;
    this.notifyStatus.textContent = '';
    if (enabled && typeof chrome !== 'undefined' && chrome.permissions?.request) {
      try { if (!await chrome.permissions.contains({ permissions: ['notifications'] })) enabled = await chrome.permissions.request({ permissions: ['notifications'] }); }
      catch { enabled = false; }
      if (!enabled) { this.notify.checked = false; this.notifyStatus.textContent = 'Chrome tillät inte aviseringar. Rutinernas svar finns fortfarande i samtalet Rutiner.'; }
    }
    try {
      const ok = await this.act('correct', { action: 'routine-notify', enabled: String(enabled) });
      if (!ok) { this.notify.checked = this.view?.routineNotifications !== false; this.notifyStatus.textContent = 'Aviseringsinställningen kunde inte sparas. Försök igen.'; }
      else { this.notify.checked = enabled; if (enabled) this.notifyStatus.textContent = 'Aviseringar för rutiner är på.'; else if (!this.notifyStatus.textContent) this.notifyStatus.textContent = 'Aviseringar för rutiner är av.'; }
    } finally { this.notifySaving = false; this.notify.disabled = !this.view; }
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
    this.notifyStatus.textContent = granted ? 'Chrome visar nu aviseringar när en rutin är klar.' : 'Chrome tillät inte aviseringar. Svaren finns i samtalet Rutiner.';
  }
}
