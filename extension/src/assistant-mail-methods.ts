import type { AssistantWorkspace } from '../../shared/assistant';
import { assistantMailMethodDefinitionSchema, assistantMailMethodStepLabels, type AssistantMailMethodDefinition, type AssistantMailMethodRequest, type AssistantMailMethodView } from '../../shared/assistant-mail-methods';
import { node } from './module-views';
import { button } from './assistant-controls';

type Editor = { root: HTMLElement; status: HTMLElement; form: HTMLElement; revision: number; remote: AssistantMailMethodView;
  draft: AssistantMailMethodDefinition; dirty: boolean; version: number; pending: boolean; enabled: boolean; key: string };
const initial = (): AssistantMailMethodDefinition => ({ steps: ['verify-account', 'read-incoming', 'read-sent', 'return-inbox'], expandThreads: false });
const definition = (view: AssistantMailMethodView) => structuredClone(view.candidate?.definition ?? view.active?.definition ?? initial());

/** Runtime method updates never replace a dirty editor or the account settings form. */
export class AssistantMailMethodsPanel {
  readonly element = node('section', '', 'assistant-mail-methods');
  private editors = new Map<string, Editor>();
  private error = node('p', '', 'assistant-error');
  private blocked = false;
  constructor(private request: (request: AssistantMailMethodRequest) => Promise<boolean>) {
    this.element.setAttribute('aria-label', 'Inlärda mejlmetoder');
    this.error.setAttribute('role', 'status');
    this.element.append(node('h3', 'Inlärda mejlmetoder'), node('p', 'Kör en vanlig mejlkontroll och lär in hur kontot förbereds. En ändrad metod provas innan den ersätter den fungerande.', 'muted'), this.error);
  }
  sync(workspace: AssistantWorkspace, dirtyAccounts: boolean): void {
    this.blocked = dirtyAccounts || workspace.current?.status === 'running';
    this.error.textContent = workspace.mailMethodsError ?? (dirtyAccounts ? 'Spara kontoinställningarna innan du kör eller ändrar en metod.' : '');
    for (const [id, editor] of this.editors) if (!workspace.settings.accounts.some(account => account.id === id)) { editor.root.remove(); this.editors.delete(id); }
    for (const account of workspace.settings.accounts) {
      const view = workspace.mailMethods?.find(entry => entry.accountId === account.id);
      if (!view) continue;
      let editor = this.editors.get(account.id);
      if (!editor) {
        const root = node('section', '', 'assistant-mail-method'), status = node('p', '', 'muted'), form = node('div');
        root.dataset.mailMethod = account.id; status.setAttribute('role', 'status'); root.append(node('h4', account.label), status, form); this.element.append(root);
        editor = { root, status, form, revision: view.revision, remote: view, draft: definition(view), dirty: false, version: 0, pending: false, enabled: account.enabled, key: '' };
        this.editors.set(account.id, editor);
      }
      editor.root.querySelector('h4')!.textContent = account.label;
      editor.remote = view;
      editor.enabled = account.enabled;
      if (!editor.dirty && !editor.pending) { editor.revision = view.revision; editor.draft = definition(view); }
      const last = view.history[0];
      const state = view.candidate ? 'Ändring väntar på verifierad kontroll. Den fungerande metoden behålls.' : view.active ? 'Verifierad metod finns.' : 'Ingen verifierad metod ännu.';
      const conflict = editor.dirty && editor.revision !== view.revision ? ' Metoden har ändrats sedan du började redigera. Ditt utkast finns kvar. Läs in den sparade versionen för att fortsätta.' : '';
      editor.status.textContent = state + conflict + (last ? ` Senaste förberedelse: ${last.preparationCalls} verktygsanrop, ${(last.preparationMs / 1000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} s; ${last.folders} mappar och ${last.reviewedThreads} bedömda trådar. ${last.status === 'verified' ? 'Verifierad.' : 'Inte verifierad: ' + last.status + '.'}` : '');
      const key = JSON.stringify({ revision: editor.revision, remote: view.revision, blocked: this.blocked, enabled: account.enabled, pending: editor.pending });
      if (key !== editor.key) { editor.key = key; this.render(account.id, editor, account.enabled); }
    }
  }
  private render(id: string, editor: Editor, enabled: boolean): void {
    const order = node('select'); order.setAttribute('aria-label', 'Ordning på mejlvyer'); order.dataset.methodOrder = id;
    order.append(new Option('Inkommande före Skickat', 'incoming'), new Option('Skickat före inkommande', 'sent')); order.value = editor.draft.steps[1] === 'read-sent' ? 'sent' : 'incoming';
    const expandLabel = node('label', '', 'checkpoint-option'), expand = node('input'); expand.type = 'checkbox'; expand.checked = editor.draft.expandThreads;
    expandLabel.append(expand, document.createTextNode('Fäll ut ofullständig trådhistorik vid läsning'));
    const mark = () => { editor.dirty = true; editor.version++; };
    order.onchange = () => { editor.draft.steps = order.value === 'sent' ? ['verify-account', 'read-sent', 'read-incoming', 'return-inbox'] : initial().steps; mark(); };
    expand.onchange = () => { editor.draft.expandThreads = expand.checked; mark(); };
    const actions = node('div', '', 'assistant-actions');
    const run = button('Kör nu och lär in', () => void this.perform(editor, { action: 'learn', accountId: id }));
    const test = button('Prova sparad ändring', () => void this.perform(editor, { action: 'test', accountId: id }));
    const save = button('Spara metodändring', () => { const parsed = assistantMailMethodDefinitionSchema.safeParse(editor.draft); if (parsed.success) void this.perform(editor, { action: 'save', accountId: id, revision: editor.revision, definition: parsed.data }); });
    save.disabled = this.blocked || editor.pending || editor.revision !== editor.remote.revision;
    const reload = button('Läs in sparad version', () => { editor.dirty = false; editor.revision = editor.remote.revision; editor.draft = definition(editor.remote); editor.key = ''; this.render(id, editor, enabled); });
    const forget = button('Glöm metoden', () => void this.perform(editor, { action: 'forget', accountId: id, revision: editor.revision }));
    for (const control of [run, test]) control.disabled = this.blocked || editor.pending || !enabled;
    forget.disabled = this.blocked || editor.pending || editor.revision !== editor.remote.revision;
    order.disabled = expand.disabled = this.blocked || editor.pending;
    actions.append(run, save); if (editor.remote.candidate) actions.append(test); actions.append(reload, forget);
    const steps = node('ol'); for (const step of editor.draft.steps) steps.append(node('li', assistantMailMethodStepLabels[step]));
    for (const control of [run, test, save, forget, reload]) control.dataset.blocked = String(control.disabled);
    const history = node('p', editor.remote.history.length > 1 ? `Föregående förberedelse: ${editor.remote.history[1].preparationCalls} verktygsanrop. Olika körningar kan innehålla olika mycket mejl; någon jämförbar tids- eller kostnadsbesparing är inte fastställd.` : 'Tids- och kostnadsbesparing är ännu inte fastställd.', 'muted');
    editor.form.replaceChildren(steps, order, expandLabel, actions, history);
  }
  private async perform(editor: Editor, request: AssistantMailMethodRequest): Promise<void> {
    if (this.blocked || editor.pending) return;
    const version = editor.version; editor.pending = true;
    this.render(editor.remote.accountId, editor, editor.enabled);
    try {
      if (await this.request(request)) {
        if ((request.action === 'save' || request.action === 'forget') && editor.version === version) { editor.dirty = false; editor.revision = editor.remote.revision; editor.draft = definition(editor.remote); }
      } else editor.status.textContent = 'Ändringen kunde inte genomföras. Ditt utkast finns kvar; läs felmeddelandet och försök igen.';
    } finally {
      editor.pending = false;
      if (!editor.dirty) { editor.revision = editor.remote.revision; editor.draft = definition(editor.remote); }
      editor.key = ''; this.render(editor.remote.accountId, editor, editor.enabled);
    }
  }
}
