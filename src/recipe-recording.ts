import { createHash, randomUUID } from 'node:crypto';
import { SECRET_PARAMETER_PREFIX, bindParameters, expectationSchema, isSecretParameter, parametersSchema, recipeSchema, type Action, type Parameters, type Recipe } from '../shared/workflow-schema';
import { RECORDING_MAX_STEPS, recordingSaveSchema, type RecordingDraft, type RecordingSave, type RecordingStatus, type RecordingStep, type RecordingStore, type RecordingTarget } from '../shared/recipe-recording';

type Call = (tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
type State = RecordingDraft & { receipt?: string };
const pointer = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'scroll_to']);
const reads = new Set(['read_page', 'find', 'get_page_text', 'read_page_diff', 'resolve_target', 'extract_table', 'screenshot_marked', 'screenshot', 'get_accessibility_tree', 'read_console_messages', 'read_network_requests', 'health', 'tabs_context_mcp']);
const safeArgs: Record<string, string[]> = {
  navigate: ['url', 'waitUntil'], tab_reload: ['waitUntil'], form_input: ['value'], select_option: ['value'],
  computer: ['action', 'pointerMode', 'allowFocus', 'modifiers'],
};
const temporaryTarget = /data-ccmcp-ref|ref_\d{50}/;
const copy = <T>(value: T): T => structuredClone(value);
const noop = async (_success: boolean) => {};

function hasTemporaryTarget(value: unknown): boolean {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return temporaryTarget.test(serialized);
}
function portableTarget(target: Action['target']): boolean {
  return !!target && (target.frameId === undefined || target.frameId === 0)
    && !hasTemporaryTarget(target);
}
function safeUrl(value: unknown): value is string {
  if (value === 'about:blank') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => /token|password|secret|authorization|api.?key|code/i.test(key))
      && !/token|password|secret|authorization|api.?key/i.test(url.hash);
  } catch { return false; }
}
function declarative(expect: unknown): Action['expect'] {
  const value = expectationSchema.parse(expect);
  if (value.predicate !== undefined || (value.frameId !== undefined && value.frameId !== 0))
    throw new Error('Välj en deklarativ kontroll utan tillfälligt ram-ID.');
  if (value.url !== undefined && !safeUrl(value.url)) throw new Error('Kontrollens adress får inte innehålla inloggningsuppgifter eller token.');
  if (hasTemporaryTarget(value.selector ?? value.fieldValue?.selector ?? ''))
    throw new Error('Kontrollen behöver en återanvändbar CSS-väljare utan tillfälliga referenser.');
  return value;
}

/** Opt-in process/session-local drafts. No page results or raw errors enter the
 * draft, ordinary history or logs. Browser dispatch always stays with its caller. */
export class RecipeRecording {
  private current?: State;
  private active = 0;
  private inFlight = 0;
  private activityRevision = 0;
  constructor(private call: Call, private store: RecordingStore) {}

  status(): RecordingStatus {
    if (!this.current) return { state: 'idle', revision: 0, steps: 0, pending: this.active };
    const { entries: _entries, receipt: _receipt, ...status } = this.current;
    return copy({ ...status, steps: this.current.entries.length });
  }
  draft(): RecordingDraft { return { ...this.status(), entries: copy(this.current?.entries ?? []) }; }

  async start(tabId: number): Promise<RecordingStatus> {
    if (this.active || this.inFlight || this.current && this.current.state !== 'saved') throw new Error('Avsluta eller kasta den befintliga inspelningen först.');
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('Välj en aktuell Tabai-flik.');
    const previous = this.current;
    const activityRevision = this.activityRevision;
    const context = await this.call('tabs_context_mcp', {}) as { tabs?: Array<{ tabId: number }> };
    if (!context.tabs?.some(tab => tab.tabId === tabId)) throw new Error('Fliken tillhör inte den valda sessionen.');
    if (this.current !== previous || this.active || this.inFlight || this.activityRevision !== activityRevision) throw new Error('Sessionen ändrades medan inspelningen startade. Vänta tills den är ledig och försök igen.');
    this.current = { recordingId: randomUUID(), state: 'recording', revision: 1, tabId, entries: [], steps: 0, pending: 0 };
    return this.status();
  }
  stop(recordingId: string): RecordingDraft {
    const state = this.require(recordingId);
    if (state.state === 'recording') {
      state.state = state.pending ? 'stopping' : 'review';
      state.revision++;
    }
    return this.draft();
  }
  discard(recordingId: string): RecordingStatus {
    const state = this.require(recordingId);
    if (state.state === 'saving') throw new Error('Vänta tills sparningen har avslutats.');
    this.current = undefined;
    return this.status();
  }
  private require(id: string): State {
    if (!this.current || this.current.recordingId !== id) throw new Error('Inspelningen har ändrats eller finns inte längre.');
    return this.current;
  }
  private block(state: State, issue: string) {
    if (this.current !== state || state.state === 'saved') return;
    state.state = 'blocked'; state.issue = issue; state.revision++;
  }

  /** Called once per logical action, never for its internal resolve/wait probes.
   * All failures here affect the recording only, never the action's response. */
  async before(action: Action): Promise<(success: boolean) => Promise<void>> {
    const args = action.args ?? {};
    if (reads.has(action.tool) || action.tool === 'computer' && ['screenshot', 'wait'].includes(String(args.action))) return noop;
    // Track logical mutations even before opt-in: a start's ownership lookup
    // must not race an action that would otherwise fall outside the draft.
    this.inFlight++; this.activityRevision++;
    let finish: (success: boolean) => Promise<void>;
    try {
      finish = await this.observe(action);
    } catch (error) {
      this.inFlight--;
      throw error;
    }
    let finished = false;
    return async success => {
      if (finished) return;
      finished = true;
      try {
        await finish(success);
      } finally {
        this.inFlight--;
      }
    };
  }

  private async observe(action: Action): Promise<(success: boolean) => Promise<void>> {
    const state = this.current, args = action.args ?? {};
    if (!state || state.state !== 'recording' || args.tabId !== state.tabId) return noop;
    if (action.tool === 'wait_for') return this.observeWait(state, args);
    if (!safeArgs[action.tool] || action.tool === 'computer' && !pointer.has(String(args.action))) {
      this.block(state, `Steget ${action.tool} kan inte spelas in säkert. Starta en ny inspelning med navigation, fältinmatning, val och referensbaserade klick.`);
      return noop;
    }
    if (state.pending) {
      this.block(state, 'Samtidiga handlingar saknar säker ordning. Starta en ny inspelning med ett steg i taget.');
      return noop;
    }
    if (action.tool === 'computer' && args.pointerMode !== 'browser' && !args.documentId) {
      this.block(state, 'Pekarsteget saknar dokumentbindning. Använd resolve_target med documentId eller ett arbetsflödessteg med target när du spelar in.'); return noop;
    }
    if (state.entries.length >= RECORDING_MAX_STEPS) {
      this.block(state, 'Inspelningen nådde gränsen på 50 steg. Dela upp arbetsflödet.');
      return noop;
    }
    state.pending++; this.active++;
    let step: RecordingStep | undefined;
    try { step = await this.prepare(action, state); }
    catch { this.block(state, 'Stegets mål eller indata kunde inte fångas säkert. Handlingen har inte upprepats av inspelaren.'); }
    let finished = false;
    return async success => {
      if (finished) return;
      finished = true;
      try {
        if (this.current !== state) return;
        if (!success) {
          this.block(state, 'Ett steg misslyckades eller fick oklart utfall. Inspelningen kan inte sparas; kontrollera sidan innan ett nytt försök.');
          return;
        }
        if (!step || state.state === 'blocked') return;
        if (step.input?.key === 'value' && !step.input.sensitive) {
          // A page can replace or reclassify a field during its input event.
          // Retain a literal only while the same ref still has the same safe description.
          const after = await this.describe(action, state);
          if (after.sensitive || JSON.stringify(after.target) !== JSON.stringify(step.action.target)) {
            this.block(state, 'Fältets identitet eller känslighet ändrades under inmatningen. Värdet sparas inte.');
            return;
          }
        }
        if (!step.action.expect && ['navigate', 'tab_reload'].includes(action.tool)) {
          const context = await this.call('tabs_context_mcp', {}, 2000) as { tabs?: Array<{ tabId: number; url?: string }> };
          const url = context.tabs?.find(tab => tab.tabId === state.tabId)?.url;
          if (safeUrl(url)) {
            step.action.expect = { url };
            step.checkSource = 'suggested';
          }
        }
        if (this.current !== state || this.status().state === 'blocked') return;
        if (Buffer.byteLength(JSON.stringify([...state.entries, step])) > 256 * 1024) {
          this.block(state, 'Inspelningen innehåller för mycket text. Dela upp arbetsflödet.');
          return;
        }
        state.entries.push(step);
        state.steps = state.entries.length;
        state.revision++;
      } catch { this.block(state, 'Efterkontrollen kunde inte läsas. Kontrollera sidan; inspelaren upprepar ingen handling.'); }
      finally {
        state.pending--; this.active--;
        if (this.current === state && state.state === 'stopping' && !state.pending) { state.state = 'review'; state.revision++; }
      }
    };
  }

  private async describe(action: Action, state: State): Promise<RecordingTarget> {
    const args = action.args ?? {};
    if (typeof args.ref !== 'string' || args.coordinate !== undefined || args.start_coordinate !== undefined) throw new Error('Unbound target');
    const result = await this.call('resolve_target', { tabId: state.tabId, describeRef: args.ref,
      ...(args.documentId ? { documentId: args.documentId } : {}) }, 2500) as { recordingTarget?: RecordingTarget };
    if (!result.recordingTarget || !portableTarget(result.recordingTarget.target)) throw new Error('No portable target');
    return result.recordingTarget;
  }

  private async prepare(action: Action, state: State): Promise<RecordingStep> {
    const args = action.args ?? {}, index = state.entries.length + 1;
    const retained: Record<string, unknown> = {};
    let descriptor: RecordingTarget | undefined;
    if (['form_input', 'select_option', 'computer'].includes(action.tool)) descriptor = await this.describe(action, state);
    for (const key of safeArgs[action.tool]) if (args[key] !== undefined) retained[key] = copy(args[key]);
    // Do not retain a raw secret even temporarily in the draft's input or check.
    const key = action.tool === 'navigate' ? 'url' : ['form_input', 'select_option'].includes(action.tool) ? 'value' : undefined;
    const sensitive = descriptor?.sensitive === true;
    const parameterName = `${sensitive ? SECRET_PARAMETER_PREFIX : ''}${key ?? 'value'}_${index}`;
    if (key && sensitive) retained[key] = { $param: parameterName };
    if (action.tool === 'navigate') {
      if (typeof args.url !== 'string' || ['back', 'forward'].includes(args.url)) throw new Error('Non-portable navigation');
      const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
      if (!safeUrl(url)) throw new Error('Sensitive or unsupported URL');
      retained.url = new URL(url).href;
    }
    const recorded: Action = { tool: action.tool, args: retained, ...(descriptor?.target ? { target: descriptor.target } : {}) };
    const declared = action.expect ?? args.expect;
    let checkSource: RecordingStep['checkSource'] = 'required';
    if (declared !== undefined) {
      const check = declarative(declared)!;
      if (sensitive) {
        if (!check.fieldValue || check.fieldValue.selector !== descriptor?.fieldSelector) throw new Error('Secret check must bind the field');
        check.fieldValue.value = { $param: parameterName };
      }
      recorded.expect = copy(check);
      checkSource = 'declared';
    } else if (key === 'value' && descriptor?.fieldSelector && descriptor.fieldType !== 'selection'
      && (descriptor.fieldType !== 'boolean' || typeof args.value === 'boolean')) {
      recorded.expect = { fieldValue: { selector: descriptor.fieldSelector, value: copy(retained.value) as string | number | boolean | { $param: string } } };
      checkSource = 'suggested';
    }
    if (key && !['string', 'number', 'boolean'].includes(typeof args[key])) throw new Error('Unsupported field value');
    let title = action.tool === 'navigate' ? 'Öppna sida' : 'Ladda om sida';
    if (descriptor) title = `${action.tool === 'computer' ? 'Peka på' : 'Fyll i'} ${descriptor.name || descriptor.role}`.slice(0, 200);
    return { id: randomUUID(), title,
      action: recorded, checkSource,
      ...(key ? { input: { key, type: typeof args[key] as 'string' | 'number' | 'boolean', sensitive, parameterName } } : {}) };
  }

  private async observeWait(state: State, args: Record<string, unknown>): Promise<(success: boolean) => Promise<void>> {
    // Explicit successful waits may strengthen the last recorded step. Do not
    // retain values from arbitrary fields or executable predicate source.
    if (args.predicate !== undefined) {
      this.block(state, 'En JavaScript-kontroll kan ändra sidan och kan inte spelas in. Använd en deklarativ resultatkontroll.');
      return noop;
    }
    if (state.pending) {
      this.block(state, 'Samtidiga handlingar och kontroller saknar säker ordning.');
      return noop;
    }
    let check: Action['expect'];
    if (args.fieldValue === undefined) {
      try { const { tabId: _tabId, ...condition } = args; check = declarative(condition); } catch { /* no portable check */ }
    }
    const last = state.entries.at(-1);
    state.pending++; this.active++;
    let finished = false;
    return async success => {
      if (finished) return;
      finished = true;
      state.pending--;
      this.active--;
      if (this.current !== state) return;
      if (!success) this.block(state, 'En resultatkontroll misslyckades. Kontrollera sidan; inspelningen kan inte sparas.');
      else if (state.state !== 'blocked' && last && check) {
        last.action.expect = check;
        last.checkSource = 'declared';
        state.revision++;
      }
      if (state.state === 'stopping' && !state.pending) state.state = 'review';
    };
  }

  async save(value: RecordingSave): Promise<{ name: string }> {
    const input = recordingSaveSchema.parse(value), state = this.require(input.recordingId);
    const receipt = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (state.state === 'saved' && state.receipt === receipt) return { name: state.savedName! };
    if (state.state !== 'review' || state.pending || state.revision !== input.revision) throw new Error('Stoppa inspelningen och hämta den senaste granskningen före sparning.');
    const recipe = reviewedRecipe(state.entries, input);
    state.state = 'saving';
    try {
      await this.store.update(input.name, current => {
        if (current !== undefined) throw new Error('Det finns redan ett recept med namnet. Välj ett nytt namn.');
        return recipe;
      });
      state.state = 'saved';
      state.savedName = input.name;
      state.receipt = receipt;
      state.revision++;
      // Release captured values once persistence has been acknowledged.
      state.entries = [];
      return { name: input.name };
    } catch (error) {
      state.state = 'review';
      throw error;
    }
  }
}

export function reviewedRecipe(entries: RecordingStep[], input: RecordingSave): Recipe {
  if (input.steps.length !== entries.length || !entries.length) throw new Error('Granska alla inspelade steg i deras ursprungliga ordning.');
  const parameters: Parameters = {}, samples: Record<string, string | number | boolean> = {};
  const actions = entries.map((entry, index) => {
    const review = input.steps[index];
    if (review.id !== entry.id) throw new Error('Stegen har ändrats. Hämta inspelningen igen.');
    const action = copy(entry.action);
    if (action.target) {
      if (!portableTarget(review.target)) throw new Error(`Steg ${index + 1} behöver ett återanvändbart mål.`);
      action.target = copy(review.target);
    } else if (review.target) throw new Error('Det här steget använder inget elementmål.');
    const expected = declarative(review.expect)!;
    action.expect = expected;
    if (entry.input) {
      const { key, type, sensitive } = entry.input, parameter = review.parameter;
      if (sensitive && !parameter?.enabled) throw new Error('Känsliga fält måste få sitt värde som parameter vid körningen.');
      // The prefix is what makes the start form mask the value later.
      if (sensitive && parameter && !isSecretParameter(parameter.name)) throw new Error(`Känsliga fält behåller prefixet ${SECRET_PARAMETER_PREFIX} i parameterns namn, så att värdet döljs när receptet körs.`);
      if (parameter?.enabled) {
        const definition = { type, required: true };
        parametersSchema.parse({ [parameter.name]: definition });
        if (parameters[parameter.name] && parameters[parameter.name].type !== type) throw new Error('En parameter kan bara ha en typ.');
        parameters[parameter.name] = definition;
        samples[parameter.name] = type === 'boolean' ? false : type === 'number' ? 1 : 'validation';
        const previous = action.args![key], binding = { $param: parameter.name };
        action.args![key] = binding;
        if (action.expect?.fieldValue && sensitive) action.expect.fieldValue.value = binding;
        if (key === 'url' && expected.url === previous) expected.url = `{{${parameter.name}}}`;
      }
    } else if (review.parameter) throw new Error('Steget har inget inmatningsvärde.');
    return action;
  });
  // Resolve placeholders for validation only; no browser call or store write.
  bindParameters(actions, parameters, samples);
  return recipeSchema.parse({ version: 2, actions, parameters, ...(input.description ? { description: input.description } : {}) });
}
