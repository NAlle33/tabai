import type { AssistantWorkspace } from '../../shared/assistant';
import type { AssistantCase, AssistantCaseLink } from '../../shared/assistant-cases';
import type { PersonalModule } from '../../shared/personal-modules';
import { node } from './module-views';
import { button, details, field, senderLookup, sourceLink, timestamp, type AssistantAction } from './assistant-controls';
import { assistantWebEnabled } from '../../shared/assistant-web';
import { assistantMailStatus } from './assistant-mail-status';

const statusLabels = { open: 'Pågår', waiting: 'Väntar', completed: 'Avklarat' };
let sequence = 0;

export class AssistantCasePanel {
  readonly element = node('section', '', 'assistant-case-center');
  private namespace = `case-${++sequence}`;
  private workspace?: AssistantWorkspace;
  private modules: PersonalModule[] = [];
  private modulesKey = '';
  private moduleOpenErrors = new Map<string, string>();
  private moduleOpening = new Set<string>();
  private list = node('div', '', 'assistant-case-list');
  private editor = node('section', '', 'assistant-case-editor');
  private editorHeading = node('h4', 'Nytt ärende');
  private form = node('form');
  private title = field('Ärendets namn', 'case-title', '', false, this.namespace);
  private description = field('Beskrivning (valfritt)', 'case-description', '', true, this.namespace);
  private nextAction = field('Nästa steg (valfritt)', 'case-next-action', '', true, this.namespace);
  private waitingFor = field('Väntar på (valfritt)', 'case-waiting-for', '', false, this.namespace);
  private deadline = field('Senast klart (valfritt)', 'case-deadline', '', false, this.namespace);
  private status = node('select');
  private message = node('p', '', 'muted assistant-case-message');
  private links = node('div', '', 'assistant-case-links');
  private linkEditor = details('Koppla något till ärendet', `assistant-case-link-editor-${this.namespace}`);
  private linkKind = node('select');
  private linkSource = node('select');
  private linkUrl = field('Webbadress', 'case-link-url', '', false, this.namespace);
  private linkLabel = field('Länkens namn (valfritt)', 'case-link-label', '', false, this.namespace);
  private linkMessage = node('p', '', 'muted');
  private linkSourceLabel = node('label', '', 'field');
  private linkForm = node('form');
  private sourceSearch = field('Sök', 'case-source-search', '', false, this.namespace);
  private search = field('Sök på den här sidan', 'case-search', '', false, this.namespace);
  private filter = node('select');
  private page = node('div', '', 'assistant-case-pagination');
  private selected?: AssistantCase;
  private creating = false;
  private dirty = false;
  private version = 0;
  private busy = false;
  private deleting = false;
  private deleteConfirm = node('div', '', 'assistant-case-delete-confirm');
  private save = node('button', 'Spara ärende');
  constructor(private act: AssistantAction, private flushDrafts: () => Promise<boolean>, private openModule: (id: string, runId?: string) => void | string | Promise<void | string>, private chatContext: (id: string, revision: number) => void = () => {}, private lookupSender: (item: { id: string; revision: number }) => void = () => {}) {
    this.element.dataset.section = 'cases';
    // The Ärenden page in Mejl names this panel in the header; it needs no heading of its own.
    this.element.append(node('p', 'Samla det som hör ihop: nästa steg, mejl, möten och länkar. Du väljer själv vad som kopplas.', 'muted assistant-case-intro'));
    const create = button('Nytt ärende', () => this.startCreate(), 'primary'); create.dataset.caseCreate = 'true';
    const filters = node('div', '', 'assistant-case-filters'); this.search.input.type = 'search';
    const filterLabel = node('label', '', 'field'); this.filter.name = 'case-filter'; this.filter.append(new Option('Alla statusar', ''), ...Object.entries(statusLabels).map(([value, label]) => new Option(label, value))); filterLabel.append(node('span', 'Status på sidan'), this.filter);
    this.search.input.oninput = () => this.renderList(); this.filter.onchange = () => this.renderList();
    filters.append(this.search.wrapper, filterLabel); this.element.append(create, filters, this.list, this.page, this.editor);
    this.editor.hidden = true;
    this.title.input.required = true; this.title.input.maxLength = 200; this.description.input.maxLength = 2000; this.nextAction.input.maxLength = 1000; this.waitingFor.input.maxLength = 300; this.deadline.input.type = 'date';
    const statusLabel = node('label', '', 'field'); this.status.name = 'case-status'; this.status.append(...Object.entries(statusLabels).map(([value, label]) => new Option(label, value))); statusLabel.append(node('span', 'Ärendets status'), this.status);
    const context = node('fieldset'); context.append(node('legend', 'Sammanhang'), this.title.wrapper, this.description.wrapper);
    const next = node('fieldset'); next.append(node('legend', 'Vägen framåt'), this.nextAction.wrapper, this.waitingFor.wrapper, this.deadline.wrapper, statusLabel);
    this.save.type = 'submit'; this.save.className = 'primary'; this.save.dataset.caseSave = 'true';
    const actions = node('div', '', 'assistant-actions'); actions.append(this.save, button('Avbryt ändringar', () => { const current = this.latestSelected(); if (current) this.fill(current); else this.closeEditor(); }));
    this.message.setAttribute('role', 'status'); this.form.append(context, next, this.message, actions); this.form.oninput = () => { this.dirty = true; this.version++; this.message.textContent = 'Osparade ändringar. Texten finns kvar när panelen uppdateras.'; this.showConflict(); };
    this.form.onchange = this.form.oninput; this.form.onsubmit = event => { event.preventDefault(); void this.saveCase(); };
    this.buildLinkEditor();
    const remove = button('Ta bort ärende', () => { this.deleting = true; this.renderDelete(); }); remove.dataset.caseDelete = 'true';
    this.editor.append(this.editorHeading, this.form, this.links, this.linkEditor, remove, this.deleteConfirm);
  }
  setModules(modules: PersonalModule[]) {
    const available = modules.filter(module => !module.view?.assistant), key = JSON.stringify(available);
    if (key === this.modulesKey) return;
    this.modulesKey = key; this.modules = available; this.renderSources(); this.renderLinks(); this.setBusy(this.busy);
  }
  update(workspace: AssistantWorkspace) {
    this.workspace = workspace;
    const current = workspace.cases?.find(record => record.id === this.selected?.id);
    if (current && !this.dirty) this.fill(current);
    this.showConflict();
    this.renderList(); this.renderLinks(); this.renderSources(); this.setBusy(this.busy);
  }
  setBusy(busy: boolean) {
    this.busy = busy;
    this.element.querySelectorAll<HTMLButtonElement>('button').forEach(control => { control.disabled = busy || control.dataset.blocked === 'true'; });
  }
  private startCreate() {
    if (this.dirty) { this.message.textContent = 'Spara eller avbryt dina ändringar innan du öppnar ett annat ärende.'; this.editor.scrollIntoView({ block: 'nearest' }); return; }
    this.selected = undefined; this.creating = true; this.fill(); this.title.input.focus();
  }
  open(id: string) {
    const record = this.workspace?.cases?.find(entry => entry.id === id);
    if (record) this.select(record);
  }
  private select(record: AssistantCase) {
    if (this.dirty) { this.message.textContent = 'Spara eller avbryt dina ändringar innan du öppnar ett ärende.'; this.editor.scrollIntoView({ block: 'nearest' }); return; }
    this.creating = false; this.fill(record); this.title.input.focus({ preventScroll: true }); this.editor.scrollIntoView({ block: 'nearest' });
  }
  private fill(record?: AssistantCase) {
    // The edit base must remain independent of later workspace snapshots.
    this.selected = record ? structuredClone(record) : undefined; this.dirty = false; this.deleting = false; this.editor.hidden = false; this.editor.dataset.caseEditor = record?.id || 'new';
    this.element.querySelector<HTMLElement>('[data-case-create]')!.classList.remove('primary');
    this.title.input.value = record?.title || ''; this.description.input.value = record?.description || ''; this.nextAction.input.value = record?.nextAction || ''; this.waitingFor.input.value = record?.waitingFor || ''; this.deadline.input.value = record?.deadline || ''; this.status.value = record?.status || 'open';
    this.editorHeading.textContent = record ? 'Redigera ärende' : 'Nytt ärende'; this.message.textContent = ''; this.linkMessage.textContent = '';
    this.linkEditor.hidden = !record; this.editor.querySelector<HTMLElement>('[data-case-delete]')!.hidden = !record;
    this.renderLinks(); this.renderDelete(); this.renderSources();
  }
  private latestSelected() { return this.workspace?.cases?.find(record => record.id === this.selected?.id) || this.selected; }
  private showConflict() {
    const current = this.latestSelected();
    if (!this.dirty || !this.selected || !current || current.revision === this.selected.revision) return false;
    this.message.textContent = 'Ärendet har ändrats sedan du började redigera. Din text finns kvar. Välj Avbryt ändringar för att läsa den senaste versionen innan du sparar igen.';
    return true;
  }
  private matchesFields(record: AssistantCase, values: Record<string, string>) {
    return (['title', 'description', 'status', 'nextAction', 'waitingFor', 'deadline'] as const).every(key => (record[key] || '') === values[key]);
  }
  private closeEditor() { this.editor.hidden = true; this.selected = undefined; this.creating = false; this.dirty = false; this.element.querySelector<HTMLElement>('[data-case-create]')!.classList.add('primary'); }
  private async saveCase() {
    if (this.busy || !this.form.reportValidity()) return;
    if (!await this.flushDrafts()) { this.message.textContent = 'Spara svarsförslaget i Mejl först. Ärendetexten finns kvar.'; return; }
    const version = this.version, previousIds = new Set(this.workspace?.cases?.map(record => record.id)), base = this.selected, creating = this.creating;
    if (!creating && !base) { this.message.textContent = 'Öppna det sparade ärendet innan du sparar fler ändringar. Din text finns kvar.'; return; }
    const input = { action: creating ? 'case-create' : 'case-update', title: this.title.input.value.trim(), description: this.description.input.value, nextAction: this.nextAction.input.value, waitingFor: this.waitingFor.input.value, deadline: this.deadline.input.value, status: this.status.value, ...(base ? { caseId: base.id, revision: String(base.revision) } : {}) };
    this.message.textContent = 'Sparar ärendet…'; this.setBusy(true);
    const ok = await this.act('correct', input); this.setBusy(false);
    if (!ok) { if (!this.showConflict()) this.message.textContent = 'Ärendet kunde inte sparas. Dina ändringar finns kvar. Försök spara igen.'; return; }
    const candidates = this.workspace?.cases?.filter(record => !previousIds.has(record.id) && record.revision === 0 && this.matchesFields(record, input)) || [];
    const latest = creating ? candidates.length === 1 ? candidates[0] : undefined : this.workspace?.cases?.find(record => record.id === base?.id);
    // Later typing can rebase only onto this acknowledged write, never a newer poll.
    const revision = base ? base.revision + Number(!this.matchesFields(base, input)) : 0;
    const saved: AssistantCase | undefined = base ? { ...structuredClone(base), title: input.title, description: input.description, nextAction: input.nextAction, waitingFor: input.waitingFor, deadline: input.deadline || undefined, status: input.status as AssistantCase['status'], revision } : latest;
    this.creating = false;
    if (version === this.version) { if (latest || saved) this.fill(latest || saved); else this.closeEditor(); this.message.textContent = 'Ärendet är sparat.'; }
    else {
      this.selected = saved ? structuredClone(saved) : undefined;
      this.message.textContent = saved ? 'Ärendet sparades. Dina senaste ändringar är fortfarande osparade.' : 'Ärendet sparades men kunde inte identifieras säkert. Öppna det sparade ärendet innan du sparar fler ändringar. Din senaste text finns kvar.';
      this.showConflict();
    }
    this.renderList();
  }
  private renderList() {
    if (!this.workspace) { this.list.replaceChildren(node('p', 'Hämtar ärenden…', 'muted')); return; }
    const all = this.workspace.cases || [], query = this.search.input.value.trim().toLocaleLowerCase('sv-SE');
    const records = all.filter(record => (!this.filter.value || record.status === this.filter.value) && (!query || [record.title, record.description, record.nextAction, record.waitingFor].join(' ').toLocaleLowerCase('sv-SE').includes(query)));
    this.list.replaceChildren();
    if (!records.length) this.list.append(node('p', all.length ? 'Inga ärenden på den här sidan matchar sökningen och statusen.' : 'Inga ärenden ännu. Skapa ett ärende och koppla det som hör dit.', 'assistant-empty'));
    for (const record of records) {
      const row = node('article', '', 'assistant-case'); row.dataset.caseId = record.id;
      row.append(node('p', statusLabels[record.status], 'assistant-case-status'), node('h4', record.title));
      if (record.description) row.append(node('p', record.description, 'module-summary'));
      const next = node('dl', '', 'assistant-case-next'); next.append(node('dt', 'Nästa steg'), node('dd', record.nextAction || 'Inget nästa steg sparat'), node('dt', 'Väntar på'), node('dd', record.waitingFor || 'Ingen angiven'));
      if (record.deadline) next.append(node('dt', 'Senast klart'), node('dd', record.deadline)); row.append(next);
      row.append(node('p', `${record.links.length} ${record.links.length === 1 ? 'koppling' : 'kopplingar'}`, 'muted'), timestamp(record.updatedAt, this.workspace.settings.timezone), button('Öppna ärende', () => this.select(record)), button('Chatta om detta', () => this.chatContext(record.id, record.revision)));
      this.list.append(row);
    }
    this.page.replaceChildren(); const page = this.workspace.casePage;
    if (page) {
      this.page.dataset.casePage = String(page.offset);
      this.page.append(node('p', `Visar ${all.length ? page.offset + 1 : 0}–${all.length ? Math.min(page.total, page.offset + all.length) : 0} av ${page.total} sparade ärenden`, 'muted'), node('p', 'Sökning och status gäller bara ärendena på den här sidan.', 'muted'));
      const actions = node('div', '', 'assistant-actions');
      for (const [label, offset, blocked, direction] of [['Föregående ärendesida', Math.max(0, page.offset - 10), page.offset === 0, 'previous'], ['Nästa ärendesida', page.nextOffset || 0, page.nextOffset === undefined, 'next']] as const) {
        const control = button(label, () => { void this.changePage(offset); }); control.dataset.blocked = String(blocked); control.dataset.casePageAction = direction; actions.append(control);
      }
      this.page.append(actions);
    }
    this.setBusy(this.busy);
  }
  private async changePage(offset: number) { if (await this.flushDrafts()) await this.act('history', { caseOffset: String(offset) }); }
  private renderDelete() {
    this.deleteConfirm.replaceChildren(); if (!this.deleting || !this.selected) return;
    this.deleteConfirm.append(node('p', `Ta bort ”${this.selected.title}”? Ärendet och kopplingarna tas bort. Mejl, möten och länkar finns kvar.`));
    const actions = node('div', '', 'assistant-actions'); actions.append(button('Behåll ärendet', () => { this.deleting = false; this.renderDelete(); }), button('Ja, ta bort ärendet', async () => {
      const record = this.selected; if (!record || !await this.flushDrafts()) return;
      this.setBusy(true); const ok = await this.act('correct', { action: 'case-delete', caseId: record.id, revision: String(record.revision) }); this.setBusy(false);
      if (ok) this.closeEditor(); else this.message.textContent = 'Ärendet kunde inte tas bort. Dina ändringar finns kvar.';
    })); this.deleteConfirm.append(actions);
  }
  private buildLinkEditor() {
    const kindLabel = node('label', '', 'field'); this.linkKind.name = 'case-link-kind'; this.linkKind.append(new Option('Ett mejl från Mejl', 'item'), new Option('En körning i ett lokalt verktyg', 'module'), new Option('En webbadress', 'url')); kindLabel.append(node('span', 'Vad vill du koppla?'), this.linkKind);
    this.linkSource.name = 'case-link-source'; this.linkSourceLabel.append(node('span', 'Välj'), this.linkSource); this.linkUrl.input.type = 'url'; this.linkLabel.input.maxLength = 300;
    this.sourceSearch.input.type = 'search'; this.sourceSearch.input.oninput = () => this.renderSources();
    this.linkKind.onchange = () => { this.sourceSearch.input.value = ''; this.renderSources(); };
    const submit = node('button', 'Koppla'); submit.type = 'submit'; submit.dataset.caseLink = 'true';
    this.linkMessage.setAttribute('role', 'status');
    this.linkForm.append(node('p', 'Koppla bara sådant du vet hör till ärendet. Du kan välja från alla konton. Tabai kopplar aldrig något på egen hand.', 'muted'), kindLabel, this.sourceSearch.wrapper, this.linkSourceLabel, this.linkUrl.wrapper, this.linkLabel.wrapper, this.linkMessage, submit);
    this.linkForm.onsubmit = event => { event.preventDefault(); void this.addLink(); }; this.linkEditor.append(this.linkForm);
  }
  private renderSources() {
    const kind = this.linkKind.value, previous = this.linkSource.value, query = this.sourceSearch.input.value.trim().toLocaleLowerCase('sv-SE');
    this.linkSource.replaceChildren(new Option('Välj…', ''));
    if (kind === 'item') for (const item of this.workspace?.items || []) {
      const account = this.workspace?.settings.accounts.find(account => account.id === item.accountId), label = `${item.title} · ${account?.label || item.accountId} · ${assistantMailStatus(item, this.workspace!.settings.timezone).label}`;
      if (!query || label.toLocaleLowerCase('sv-SE').includes(query)) this.linkSource.append(new Option(label, JSON.stringify({ kind: 'item', itemId: item.id })));
    }
    if (kind === 'module') for (const module of this.modules) {
      const runs = new Map<string, string>();
      if (module.view?.run) runs.set(module.view.run.id, module.view.run.title || module.view.title);
      for (const run of module.view?.history || []) if (run.id) runs.set(run.id, run.label);
      for (const [runId, label] of runs) {
        const caption = `${module.view?.title || module.id} · ${label}`;
        if (!query || caption.toLocaleLowerCase('sv-SE').includes(query)) this.linkSource.append(new Option(caption, JSON.stringify({ kind: 'module', moduleId: module.id, runId, label })));
      }
    }
    if ([...this.linkSource.options].some(option => option.value === previous)) this.linkSource.value = previous;
    const url = kind === 'url'; this.linkSourceLabel.hidden = url; this.sourceSearch.wrapper.hidden = url; this.linkUrl.wrapper.hidden = !url; this.linkLabel.wrapper.hidden = !url;
    this.linkUrl.input.required = url; this.linkSource.required = !url;
  }
  private async addLink() {
    const record = this.latestSelected(); if (this.busy || !record || !this.linkForm.reportValidity()) return;
    let link: AssistantCaseLink;
    if (this.linkKind.value === 'url') {
      try {
        const url = new URL(this.linkUrl.input.value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe');
        link = { kind: 'url', url: url.href, label: this.linkLabel.input.value.trim() };
      } catch { this.linkMessage.textContent = 'Ange en fullständig http- eller https-adress utan inloggningsuppgifter.'; return; }
    } else {
      try { link = JSON.parse(this.linkSource.value) as AssistantCaseLink; } catch { this.linkMessage.textContent = 'Välj något i listan.'; return; }
    }
    this.linkMessage.textContent = 'Kopplar…'; this.setBusy(true);
    const ok = await this.act('correct', { action: 'case-link', caseId: record.id, revision: String(record.revision), link: JSON.stringify(link) }); this.setBusy(false);
    this.linkMessage.textContent = ok ? 'Kopplingen är sparad.' : 'Kopplingen kunde inte sparas. Ditt val finns kvar.';
    if (ok) { this.linkUrl.input.value = ''; this.linkLabel.input.value = ''; this.linkSource.value = ''; }
  }
  private renderLinks() {
    this.links.replaceChildren(); const record = this.latestSelected(); if (!record) return;
    this.links.append(node('h5', 'Kopplat till ärendet'));
    if (!record.links.length) this.links.append(node('p', 'Inget är kopplat ännu. Välj Koppla något till ärendet.', 'muted'));
    for (const [index, link] of record.links.entries()) {
      const row = node('article', '', 'assistant-case-link'); row.dataset.caseLinkIndex = String(index); row.dataset.linkKind = link.kind;
      if (link.kind === 'item') this.renderItemLink(row, link);
      if (link.kind === 'module') {
        const module = this.modules.find(module => module.id === link.moduleId), unavailable = !module?.view || !!module.error;
        const current = module?.view?.run?.id === link.runId ? module.view.run : undefined, key = JSON.stringify([link.moduleId, link.runId]);
        row.dataset.moduleLinkId = link.moduleId; row.dataset.moduleRunId = link.runId; row.dataset.moduleSourceState = unavailable ? 'unavailable' : 'available';
        row.append(node('h6', link.label || 'Sparad modulkörning'), node('p', module?.view?.title || link.moduleId, 'muted'));
        if (unavailable) row.append(node('p', 'Modulen är inte tillgänglig. Kontrollera anslutningen eller installationen och uppdatera panelen.', 'muted'));
        else if (current) row.append(node('p', current.message, 'module-summary'));
        else row.append(node('p', 'Körningen visas inte i modulens aktuella vy. Öppna den exakta sparade referensen för att hämta dess läge.', 'muted'));
        const open = button(this.moduleOpening.has(key) ? 'Öppnar modulkörningen…' : 'Öppna modulkörningen', async () => {
          if (unavailable || this.moduleOpening.has(key)) return;
          this.moduleOpening.add(key); open.dataset.blocked = 'true'; open.disabled = true;
          try {
            const error = await this.openModule(link.moduleId, link.runId);
            if (error) this.moduleOpenErrors.set(key, error); else this.moduleOpenErrors.delete(key);
          } catch (error) { this.moduleOpenErrors.set(key, String(error)); }
          finally { this.moduleOpening.delete(key); this.renderLinks(); this.setBusy(this.busy); }
        });
        open.dataset.blocked = String(unavailable || this.moduleOpening.has(key)); open.disabled = open.dataset.blocked === 'true'; row.append(open);
        const error = this.moduleOpenErrors.get(key);
        if (error) { const feedback = node('p', error, 'module-error assistant-case-source-error'); feedback.setAttribute('role', 'alert'); row.append(feedback); }
      }
      if (link.kind === 'url') row.append(sourceLink(link.label || link.url, link.url), node('p', 'Ärendets status ändrar du själv.', 'muted'));
      const unlink = button('Ta bort koppling', async () => {
        const current = this.latestSelected(); if (!current) return; this.setBusy(true);
        const ok = await this.act('correct', { action: 'case-unlink', caseId: current.id, revision: String(current.revision), link: JSON.stringify(link) }); this.setBusy(false);
        if (!ok) this.message.textContent = 'Kopplingen kunde inte tas bort. Försök igen.';
      }); unlink.className = 'quiet'; row.append(unlink); this.links.append(row);
    }
  }
  private renderItemLink(row: HTMLElement, link: Extract<AssistantCaseLink, { kind: 'item' }>) {
    const item = this.workspace?.items.find(item => item.id === link.itemId) || this.workspace?.caseItems?.find(item => item.id === link.itemId);
    if (!item) { row.append(node('h6', 'Sparat mejl'), node('p', 'Mejlet är inte inläst här. Öppna det i Chrome för att se originalet.', 'muted'), button('Öppna mejlet i Chrome', () => { void this.act('open', { itemId: link.itemId }); })); return; }
    const account = this.workspace?.settings.accounts.find(account => account.id === item.accountId);
    row.dataset.linkedItemId = item.id; row.dataset.linkedItemStatus = item.status;
    row.append(node('h6', item.title), node('p', account?.label || item.accountId, 'muted'), node('p', assistantMailStatus(item, this.workspace!.settings.timezone).label, item.status === 'uncertain' ? 'notice error' : 'assistant-case-item-status'));
    if (item.status === 'uncertain') row.append(node('p', 'Kontrollera Skickat i kontot. Tabai skickar inte svaret igen.', 'muted'));
    row.append(sourceLink('Öppna originalet', item.sourceUrl));
    // Only a point loaded in Mejl carries the sender and revision a lookup needs.
    const loaded = this.workspace?.items.find(entry => entry.id === item.id);
    row.append(senderLookup(loaded?.recipient || loaded?.sender, !!loaded, !assistantWebEnabled(this.workspace?.settings.web), () => { if (loaded) this.lookupSender({ id: loaded.id, revision: loaded.revision }); }));
  }
}
