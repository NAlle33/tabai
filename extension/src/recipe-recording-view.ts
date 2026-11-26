import { node } from './panel-views';
import type { PanelCommand } from '../../shared/control-panel';
import type { RecordingDraft, RecordingSave, RecordingStatus, RecordingStep } from '../../shared/recipe-recording';
import { expectationSchema, type Action } from '../../shared/workflow-schema';

type Request = <T = unknown>(command: PanelCommand) => Promise<T>;
type Tab = { tabId: number; title?: string; url?: string };
let sequence = 0;
function field(labelText: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  const wrapper = node('div', '', 'field');
  const label = node('label', labelText);
  control.id = `recording-field-${++sequence}`;
  label.htmlFor = control.id;
  wrapper.append(label, control);
  return wrapper;
}
function input(value = '', maxLength = 2000) {
  const element = node('input');
  element.type = 'text';
  element.value = value;
  element.maxLength = maxLength;
  return element;
}
function select(entries: Array<[string, string]>, value = '') {
  const element = node('select');
  element.append(...entries.map(([key, label]) => new Option(label, key)));
  element.value = value;
  return element;
}
function button(label: string, run: () => void) {
  const element = node('button', label);
  element.type = 'button';
  element.onclick = run;
  return element;
}
function statusMessage(status: RecordingStatus, connected: boolean): string {
  if (!connected) return 'Välj en ansluten session för att spela in.';
  switch (status.state) {
    case 'recording': return `Spelar in: ${status.steps} steg. Låt agenten utföra arbetsflödet och stoppa sedan inspelningen.`;
    case 'stopping': return 'Väntar på det pågående steget. Inga nya steg tas med.';
    case 'blocked': return status.issue ?? 'Inspelningen kan inte sparas. Kontrollera sidan innan du börjar om.';
    case 'review': return `${status.steps} steg att granska. Varje steg behöver en resultatkontroll innan receptet sparas.`;
    case 'saving': return 'Sparar receptet…';
    case 'saved': return `Receptet ${status.savedName} är sparat. Det startas först när du väljer att köra det.`;
    default: return 'Redo. Öppna en Tabai-flik i sessionen och välj den här.';
  }
}
function expectationKind(expect: Action['expect']): string {
  if (expect?.url !== undefined) return 'url';
  if (expect?.text !== undefined) return 'text';
  if (expect?.selector !== undefined) return 'selector';
  if (expect?.fieldValue) return 'fieldValue';
  return '';
}
function checkGuidance(source: RecordingStep['checkSource']): string {
  if (source === 'required') return 'Välj ett resultat som visar att steget lyckades, till exempel en kvittens eller en ändrad sida.';
  if (source === 'suggested') return 'Föreslagen kontroll. Ett fältvärde eller en adress bevisar inte att tjänsten har sparat eller godkänt något; välj ett tydligare resultat om det behövs.';
  return 'Steget har en deklarerad kontroll. Granska att den fortfarande beskriver rätt resultat.';
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Polling updates status only. Detailed draft values are fetched on the user's
 * review action; an old session's response can never replace the current form. */
export function createRecipeRecordingView(request: Request, saved: () => Promise<void>) {
  const element = node('section', '', 'recipe-recording');
  element.setAttribute('aria-label', 'Spela in ett arbetsflöde');
  const statusText = node('p', '', 'notice');
  statusText.setAttribute('role', 'status');
  const error = node('p', '', 'notice error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const tabs = node('select');
  tabs.name = 'recording-tab';
  const start = button('Börja spela in', () => void act('start'));
  const stop = button('Stoppa och granska', () => void act('stop'));
  const review = button('Granska inspelningen', () => void act('review'));
  const discard = button('Kasta inspelningen', () => void act('discard'));
  const actions = node('div', '', 'recording-actions');
  actions.append(start, stop, review, discard);
  const editor = node('div');
  element.append(node('h3', 'Spara ett arbetsflöde'), node('p', 'Spela in Tabais steg medan agenten arbetar i en vald flik. Stoppa, granska och spara som ett återanvändbart recept.', 'muted'),
    node('p', 'Inspelningen kan innehålla adresser och inmatad text. Lösenords- och kodfält får parametrar utan sparade värden. Utkastet försvinner om MCP-sessionen stängs.', 'muted'),
    field('Flik att spela in', tabs), actions, statusText, error, editor);
  let sessionId = '', generation = 0, connected = false, busy = false, sessionBusy = false;
  let status: RecordingStatus = { state: 'idle', steps: 0, pending: 0, revision: 0 };
  let draft: RecordingDraft | undefined;

  function controls() {
    const idle = status.state === 'idle' || status.state === 'saved';
    start.hidden = !idle; start.disabled = busy || !connected || sessionBusy || !tabs.value || !!status.pending;
    tabs.disabled = busy || !idle || !connected;
    stop.hidden = status.state !== 'recording'; stop.disabled = busy || !connected;
    review.hidden = status.state !== 'review'; review.disabled = busy || !connected || !status.steps;
    discard.hidden = idle; discard.disabled = busy || !connected || status.state === 'saving';
    statusText.textContent = statusMessage(status, connected);
    editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => {
      control.disabled = busy || !connected || status.state !== 'review' || control.dataset.locked === 'true';
    });
  }
  function update(nextSession: string, online: boolean, next: RecordingStatus | undefined, available: Tab[], working: boolean, snapshotEpoch?: number) {
    const changedSession = nextSession !== sessionId;
    if (changedSession) {
      generation++; sessionId = nextSession; busy = false; draft = undefined; editor.replaceChildren(); error.hidden = true;
    }
    connected = online && !!next; sessionBusy = working;
    // A poll can have received its snapshot before an action, then wait on tabs.
    // Keep its original ticket when the host re-renders that cached snapshot.
    if (changedSession || snapshotEpoch === undefined || snapshotEpoch === generation)
      status = next ?? { state: 'idle', steps: 0, pending: 0, revision: 0 };
    const chosen = tabs.value, key = JSON.stringify(available);
    if (tabs.dataset.key !== key) {
      tabs.dataset.key = key; tabs.replaceChildren(...available.map(tab => new Option(tab.title || tab.url || `Flik ${tab.tabId}`, String(tab.tabId))));
      if (available.some(tab => String(tab.tabId) === chosen)) tabs.value = chosen;
    }
    if (draft && status.recordingId !== draft.recordingId) { draft = undefined; editor.replaceChildren(); }
    controls();
  }
  async function act(action: 'start' | 'stop' | 'review' | 'discard') {
    if (busy || !connected) return;
    const at = ++generation, id = status.recordingId;
    busy = true; error.hidden = true; controls();
    try {
      if (action === 'start') {
        const result = await request<RecordingStatus>({ action: 'recording-start', sessionId, tabId: Number(tabs.value) });
        if (at !== generation) return;
        status = result;
      } else if (action === 'discard' && id) {
        const result = await request<RecordingStatus>({ action: 'recording-discard', sessionId, recordingId: id });
        if (at !== generation) return;
        status = result;
        draft = undefined;
        editor.replaceChildren();
      } else {
        const result = await request<RecordingDraft>(action === 'stop' && id
          ? { action: 'recording-stop', sessionId, recordingId: id }
          : { action: 'recording-draft', sessionId });
        if (at !== generation) return;
        status = result;
        if (result.state === 'review') { draft = result; renderDraft(result); }
      }
    } catch (failure) {
      if (at === generation) {
        error.textContent = errorMessage(failure);
        error.hidden = false;
      }
    } finally {
      if (at === generation) {
        generation++;
        busy = false;
        controls();
      }
    }
  }
  function renderDraft(recording: RecordingDraft) {
    const form = node('form'); form.className = 'recording-review'; form.setAttribute('aria-label', 'Granska inspelat recept');
    const name = input('', 120); name.name = 'recording-name'; name.required = true;
    const description = node('textarea'); description.rows = 2; description.maxLength = 2000; description.name = 'recording-description';
    form.append(field('Namn på nytt recept', name), field('Beskrivning (valfri)', description));
    const readers = recording.entries.map((step, index) => {
      const rendered = reviewStep(step, index); form.append(rendered.element); return rendered.read;
    });
    const save = node('button', 'Spara granskat recept', 'primary'); save.type = 'submit'; form.append(save);
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || !connected || !form.reportValidity()) return;
      const at = ++generation;
      let payload: RecordingSave;
      try {
        payload = {
          recordingId: recording.recordingId!,
          revision: recording.revision,
          name: name.value.trim(),
          ...(description.value.trim() ? { description: description.value.trim() } : {}),
          steps: readers.map(read => read()),
        };
      } catch (failure) {
        error.textContent = errorMessage(failure);
        error.hidden = false;
        return;
      }
      busy = true; error.hidden = true; controls();
      try {
        const result = await request<{ name: string }>({ action: 'recording-save', sessionId, review: payload });
        if (at !== generation || draft !== recording) return;
        status = { ...status, state: 'saved', savedName: result.name };
        draft = undefined;
        editor.replaceChildren();
        await saved();
      } catch (failure) {
        if (at === generation) {
          error.textContent = errorMessage(failure);
          error.hidden = false;
        }
      } finally {
        if (at === generation) {
          generation++;
          busy = false;
          controls();
        }
      }
    };
    editor.replaceChildren(form);
  }
  tabs.onchange = controls;
  controls();
  return { element, update, snapshotEpoch: () => generation };
}

function reviewStep(step: RecordingStep, index: number) {
  const element = node('fieldset', '', 'recording-step');
  element.dataset.recordingStep = String(index + 1);
  element.append(node('legend', `${index + 1}. ${step.title}`));
  let readTarget: (() => Action['target']) | undefined;
  if (step.action.target) {
    const target = step.action.target;
    const mode = select([['selector', 'CSS-väljare'], ['role', 'Roll och namn']], 'selector' in target ? 'selector' : 'role');
    const selector = input('selector' in target ? target.selector : '');
    const role = input('role' in target ? target.role : '', 100);
    const name = input('name' in target ? target.name : '', 500);
    const selectorField = field('Elementets CSS-väljare', selector);
    const roleField = field('Elementets roll', role);
    const nameField = field('Elementets namn', name);
    const update = () => {
      selectorField.hidden = mode.value !== 'selector';
      roleField.hidden = nameField.hidden = mode.value !== 'role';
      selector.required = mode.value === 'selector';
      role.required = mode.value === 'role';
    };
    mode.onchange = update;
    update();
    element.append(field('Hitta elementet med', mode), selectorField, roleField, nameField);
    readTarget = () => mode.value === 'selector' ? { selector: selector.value.trim() } : { role: role.value.trim(), name: name.value };
  }
  const parameter = node('input'); parameter.type = 'checkbox'; parameter.name = `recording-parameter-${index}`;
  const parameterName = input(step.input?.parameterName, 120); parameterName.pattern = '[A-Za-z][A-Za-z0-9_-]*';
  parameterName.name = `recording-parameter-name-${index}`;
  const parameterField = field('Parameterns namn', parameterName);
  if (step.input) {
    parameter.checked = step.input.key === 'value';
    if (step.input.sensitive) {
      parameter.checked = true;
      parameter.disabled = true;
      parameter.dataset.locked = 'true';
    }
    const label = node('label', '', 'checkpoint-option');
    label.append(parameter, document.createTextNode('Fråga efter värdet när receptet körs'));
    const value = step.action.args?.[step.input.key];
    element.append(node('p', step.input.sensitive ? 'Känsligt fält. Värdet har inte sparats och måste anges vid körningen.' : `Inspelat värde: ${String(value).slice(0, 2000)}`, 'recording-value'), label, parameterField);
    const update = () => {
      parameterField.hidden = !parameter.checked;
      parameterName.required = parameter.checked;
    };
    parameter.onchange = update;
    update();
  }
  const expect = step.action.expect;
  const kind = select([['', 'Välj resultatkontroll'], ['url', 'Sidans adress'], ['text', 'Text visas'], ['selector', 'Elementets synlighet'], ['fieldValue', 'Fältets värde']],
    expectationKind(expect));
  kind.required = true;
  kind.name = `recording-expect-kind-${index}`;
  const match = input(expect?.url ?? expect?.text ?? expect?.selector ?? expect?.fieldValue?.selector ?? '');
  match.name = `recording-expect-match-${index}`;
  const matchField = field('Adress, text eller CSS-väljare', match);
  const state = select([['visible', 'Synligt'], ['hidden', 'Dolt'], ['attached', 'Finns'], ['detached', 'Borttaget']], expect?.state ?? 'visible');
  const stateField = field('Elementets tillstånd', state);
  const fieldValue = input(typeof expect?.fieldValue?.value === 'object' ? '' : String(expect?.fieldValue?.value ?? ''));
  const valueField = field('Förväntat fältvärde', fieldValue);
  const bindCheck = node('input');
  bindCheck.type = 'checkbox';
  bindCheck.checked = !!step.input && (step.input.sensitive || JSON.stringify(expect?.fieldValue?.value) === JSON.stringify(step.action.args?.[step.input.key]));
  if (step.input?.sensitive) {
    bindCheck.checked = true;
    bindCheck.dataset.locked = 'true';
  }
  const bindingNote = node('label', '', 'checkpoint-option');
  bindingNote.append(bindCheck, document.createTextNode('Använd inmatningens parameter i kontrollen'));
  const updateCheck = () => {
    matchField.hidden = !kind.value; match.required = !!kind.value; stateField.hidden = kind.value !== 'selector';
    const canBind = kind.value === 'fieldValue' && !!step.input && parameter.checked;
    valueField.hidden = kind.value !== 'fieldValue' || canBind && bindCheck.checked; bindingNote.hidden = !canBind;
  };
  kind.onchange = updateCheck;
  bindCheck.onchange = updateCheck;
  parameter.addEventListener('change', updateCheck);
  updateCheck();
  element.append(node('p', checkGuidance(step.checkSource), 'muted'), field('Så kontrolleras resultatet', kind), matchField, stateField, valueField, bindingNote);
  return { element, read: (): RecordingSave['steps'][number] => {
    const condition: Record<string, unknown> = { timeoutMs: expect?.timeoutMs ?? 10000,
      ...(expect?.stableForMs !== undefined ? { stableForMs: expect.stableForMs } : {}) };
    if (kind.value === 'selector') { condition.selector = match.value.trim(); condition.state = state.value; }
    else if (kind.value === 'fieldValue') {
      let value: unknown = fieldValue.value;
      if (step.input && parameter.checked && bindCheck.checked) value = { $param: parameterName.value.trim() };
      else if (step.input?.type === 'boolean') { if (!['true', 'false'].includes(fieldValue.value)) throw new Error('Ange true eller false för kryssrutans kontroll.'); value = fieldValue.value === 'true'; }
      else if (step.input?.type === 'number') { value = Number(fieldValue.value); if (!Number.isFinite(value)) throw new Error('Ange ett tal för fältets kontroll.'); }
      condition.fieldValue = { selector: match.value.trim(), value };
    } else if (['url', 'text'].includes(kind.value)) condition[kind.value] = match.value.trim();
    else throw new Error('Varje steg behöver en resultatkontroll.');
    return { id: step.id, ...(readTarget ? { target: readTarget() } : {}), expect: expectationSchema.parse(condition),
      ...(step.input ? { parameter: { enabled: parameter.checked, name: parameterName.value.trim() } } : {}) };
  } };
}
