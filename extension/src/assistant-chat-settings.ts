import { node } from './module-views';
import { button, details, field, section, timestamp, type AssistantAction } from './assistant-controls';
import { assistantChatModels, type AssistantChatView } from '../../shared/assistant-chat';
import type { AssistantMemory } from '../../shared/assistant-services';

export const assistantBackends = [
  ['codex', 'Codex', 'Samtalet och valt underlag skickas till OpenAI via Codex.'],
  ['claude', 'Claude', 'Samtalet och valt underlag skickas till Anthropic via Claude Code.'],
  ['local', 'Lokalt på datorn', 'Lokal inferens med Ollama på datorn · experimentell. Ingen automatisk övergång till molnet.'],
  ['berget', 'Berget.ai', 'Samtalet och valt underlag skickas till Berget.ai. Kräver en API-nyckel och debiteras separat.'],
] as const;
/** Where a chat model sends the conversation, in the user's words. */
export function assistantPrivacy(model: string) {
  const backend = model.split(':')[0];
  return assistantBackends.find(([id]) => id === backend)?.[2] ?? 'Samtalet skickas till den valda modellen.';
}
export const assistantModelName = (model: string) => { const label = assistantChatModels.find(choice => choice.id === model)?.label ?? model; return label.split(' · ').at(-1) ?? label; };
export function chatModelSelect(name: string): HTMLSelectElement {
  const select = node('select'); select.name = name;
  for (const [backend, label] of assistantBackends) {
    const group = node('optgroup'); group.label = label;
    for (const choice of assistantChatModels.filter(choice => choice.backend === backend)) group.append(new Option(choice.label, choice.id));
    select.append(group);
  }
  return select;
}
export const assistantEuros = (value: number) => `${value > 0 && value < 0.000001 ? value.toLocaleString('sv-SE', { notation: 'scientific', maximumSignificantDigits: 4 }) : value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} EUR`;
let sequence = 0;
/** The chat services' own controls. Each section is placed on its own settings page. */
export class AssistantChatSettings {
  readonly chatModel = chatModelSelect('chat-model');
  private taskModel = chatModelSelect('task-model');
  private namespace = `chat-settings-${++sequence}`;
  private view?: AssistantChatView;
  readonly connections = section('Anslutningar', 'connections', 'Sparad betyder att inställningar finns. Tillgänglig visas först efter ett lyckat test. E-posttest använder senast sparade konton, läser underlag men skickar inget.');
  private connectionRows = node('div', '', 'assistant-rows');
  readonly models = section('Chatt och uppdrag', 'models', 'Chatt och uppdrag kan använda olika modeller. Valet sparas direkt.');
  private modelStatus = node('p', '', 'muted');
  readonly connection = section('Berget-nyckel', 'berget-key', 'Nyckeln sparas privat på datorn. Den visas aldrig igen och ingår inte i samtal eller utkast. Berget-anrop debiteras separat.');
  private key = field('Berget API-nyckel', 'berget-api-key', '', false, this.namespace);
  private keyStatus = node('p', '', 'muted');
  private keySave = node('button', 'Spara API-nyckel');
  private keyRemove = button('Ta bort sparad nyckel', () => void this.removeKey());
  private keySaving = false;
  private modelSaving = false;
  readonly budget = section('Berget · användning och budget', 'budget', 'Kostnaden för Codex- och Claude-abonnemang uppskattas inte här.');
  private budgetSummary = node('div', '', 'assistant-budget-summary');
  private budgetLimit = field('Budgetgräns per period (EUR)', 'berget-budget', '', false, this.namespace);
  private budgetStatus = node('p', '', 'muted');
  private budgetDirty = false;
  private budgetVersion = 0;
  private memoryVersion = 0;
  private keyVersion = 0;
  readonly memory = section('Sparade uppgifter', 'memories', 'Återanvändbara uppgifter för kommande uppdrag. Spara inga lösenord eller API-nycklar här.');
  private memories = node('div', '', 'assistant-rows');
  private memoryForm = node('form', '', 'assistant-memory-form');
  private memoryId?: string;
  private memoryLabel = field('Namn på uppgiften', 'memory-label', '', false, this.namespace);
  private memoryValue = field('Uppgift att komma ihåg', 'memory-value', '', true, this.namespace);
  private memoryScope = node('select');
  private memoryModule = field('Modul-ID', 'memory-module', '', false, this.namespace);
  private memoryStatus = node('p', '', 'muted');
  private connectionsKey = '';
  private memoryKey = '';
  private budgetKey = '';
  constructor(private act: AssistantAction) {
    for (const status of [this.keyStatus, this.budgetStatus, this.memoryStatus]) status.setAttribute('role', 'status');
    for (const [select, caption, role] of [[this.chatModel, 'Chattmodell', 'chat'], [this.taskModel, 'Modell för nya uppdrag', 'task']] as const) {
      const label = node('label', '', 'field'); label.append(node('span', caption), select); select.setAttribute('aria-label', caption); this.models.append(label);
      select.onchange = async () => {
        this.modelSaving = true; this.controls();
        const ok = await this.act('correct', { action: `${role}-model`, model: select.value });
        this.modelSaving = false; this.modelStatus.textContent = ok ? `${role === 'chat' ? 'Chattmodellen' : 'Uppdragsmodellen'} är sparad. Pågående arbete behåller sin modell.` : 'Modellvalet kunde inte sparas.';
        if (this.view) this.update(this.view); this.controls();
      };
    }
    this.modelStatus.setAttribute('role', 'status');
    this.models.append(this.modelStatus);
    this.connections.append(this.connectionRows);
    this.key.input.type = 'password'; this.key.input.autocomplete = 'off'; this.key.input.maxLength = 4096; this.key.input.spellcheck = false;
    this.key.input.oninput = () => { this.keyVersion++; this.controls(); }; this.keySave.type = 'submit'; this.keySave.className = 'primary';
    const keyForm = node('form'), keyActions = node('div', '', 'assistant-actions'); keyActions.append(this.keySave, this.keyRemove);
    keyForm.append(this.key.wrapper, keyActions, this.keyStatus); keyForm.onsubmit = event => { event.preventDefault(); void this.saveKey(); };
    this.connection.append(keyForm);
    this.budgetLimit.input.type = 'text'; this.budgetLimit.input.inputMode = 'decimal'; this.budgetLimit.input.placeholder = 'Ingen gräns'; this.budgetLimit.input.maxLength = 20;
    this.budgetLimit.input.oninput = () => { this.budgetDirty = true; this.budgetVersion++; };
    const budgetForm = node('form'), saveBudget = node('button', 'Spara budgetgräns', 'primary'); saveBudget.type = 'submit';
    budgetForm.append(this.budgetLimit.wrapper, node('p', 'Tomt fält tar bort gränsen. Reservationer och osäker förbrukning räknas innan nya Berget-anrop tillåts.', 'muted'), saveBudget, this.budgetStatus);
    budgetForm.onsubmit = async event => {
      event.preventDefault(); const limit = this.budgetLimit.input.value.trim().replace(',', '.');
      if (limit && !/^\d+(\.\d{1,6})?$/.test(limit)) { this.budgetStatus.textContent = 'Ange ett positivt belopp i EUR eller lämna tomt.'; return; }
      const version = this.budgetVersion;
      saveBudget.disabled = true; const ok = await this.act('correct', { action: 'berget-budget', limit }); saveBudget.disabled = false;
      if (ok && version === this.budgetVersion) this.budgetDirty = false;
      this.budgetStatus.textContent = ok ? version === this.budgetVersion ? 'Budgetgränsen är sparad.' : 'Budgetgränsen sparades. Dina senaste ändringar är fortfarande osparade.' : 'Budgetgränsen kunde inte sparas. Ditt belopp finns kvar.';
    };
    this.budget.append(this.budgetSummary, budgetForm);
    this.memoryLabel.input.required = true; this.memoryLabel.input.maxLength = 120; this.memoryValue.input.required = true; this.memoryValue.input.maxLength = 2000;
    const scope = node('label', '', 'field'); this.memoryScope.name = 'memory-scope'; this.memoryScope.append(new Option('Allmänt', 'general'), new Option('Mejl', 'mail'), new Option('En lokal modul', 'module')); scope.append(node('span', 'Används för'), this.memoryScope);
    this.memoryScope.onchange = () => { this.memoryModule.wrapper.hidden = this.memoryScope.value !== 'module'; this.memoryModule.input.required = this.memoryScope.value === 'module'; }; this.memoryScope.onchange(new Event('change'));
    const memorySave = node('button', 'Spara uppgift', 'primary'); memorySave.type = 'submit';
    const memoryActions = node('div', '', 'assistant-actions'); memoryActions.append(memorySave, button('Avbryt redigering', () => this.resetMemory()));
    this.memoryForm.append(node('h4', 'Ny uppgift'), this.memoryLabel.wrapper, this.memoryValue.wrapper, scope, this.memoryModule.wrapper, memoryActions, this.memoryStatus);
    this.memoryForm.addEventListener('input', () => this.memoryVersion++);
    this.memoryForm.addEventListener('change', () => this.memoryVersion++);
    this.memoryForm.onsubmit = async event => {
      event.preventDefault(); if (!this.memoryForm.reportValidity()) return;
      const input = { action: 'memory-save', label: this.memoryLabel.input.value, value: this.memoryValue.input.value, scope: this.memoryScope.value, ...(this.memoryId ? { id: this.memoryId } : {}), ...(this.memoryScope.value === 'module' ? { moduleId: this.memoryModule.input.value } : {}) };
      const version = this.memoryVersion;
      memorySave.disabled = true; const ok = await this.act('correct', input); memorySave.disabled = false;
      const unchanged = version === this.memoryVersion;
      if (ok && unchanged) this.resetMemory();
      this.memoryStatus.textContent = ok ? unchanged ? 'Uppgiften är sparad privat.' : 'Uppgiften sparades. Dina senaste ändringar är fortfarande osparade.' : 'Uppgiften kunde inte sparas. Texten finns kvar.';
    };
    this.memory.append(this.memories, this.memoryForm);
  }
  /** Unsent text a page would otherwise hide when the user leaves it. */
  dirty(page: 'models' | 'memory' | 'cost') {
    if (page === 'models') return !!this.key.input.value.trim();
    if (page === 'cost') return this.budgetDirty;
    return !!(this.memoryLabel.input.value.trim() || this.memoryValue.input.value.trim());
  }
  private controls() {
    this.chatModel.disabled = this.taskModel.disabled = this.modelSaving || this.keySaving || !!this.view?.busy;
    for (const [control, blocked] of [[this.keySave, this.keySaving || !!this.view?.busy || !this.key.input.value.trim()], [this.keyRemove, this.keySaving || !!this.view?.busy || !this.view?.berget.configured]] as const) { control.disabled = blocked; control.dataset.blocked = String(blocked); }
  }
  update(view?: AssistantChatView) {
    this.view = view; if (!view) return;
    if (!this.modelSaving) { this.chatModel.value = view.model; this.taskModel.value = view.taskModel || view.model; }
    if (!this.keySaving) this.keyStatus.textContent = view.berget.message;
    const connectionKey = JSON.stringify(view.connections);
    if (connectionKey !== this.connectionsKey) {
      this.connectionsKey = connectionKey; this.connectionRows.replaceChildren();
      if (!view.connections?.length) this.connectionRows.append(node('p', 'Ingen anslutningskontroll har hämtats. Kontonas lästest finns under Mejlkonton.', 'muted'));
      for (const connection of view.connections || []) {
        const row = node('article', '', 'assistant-connection-row'); row.dataset.connectionId = connection.id;
        const state = { unknown: 'Inte testad', checking: 'Testar…', ready: 'Tillgänglig', 'action-required': 'Åtgärd krävs' }[connection.state];
        row.dataset.state = connection.state;
        row.append(node('h4', connection.label), node('p', `${connection.configured ? 'Sparad' : 'Inte konfigurerad'} · ${state}`, 'assistant-connection-state'), node('p', connection.message, 'muted'));
        if (connection.testedAt) { const tested = node('p', 'Testad: ', 'muted'); tested.append(timestamp(connection.testedAt, 'Europe/Stockholm')); row.append(tested); }
        if (connection.id === 'berget') row.append(node('p', 'Kontrollerar bara modellkatalogen. En sparad API-nyckel verifieras inte av katalogtestet.', 'muted'));
        if (connection.model) row.append(node('p', connection.model, 'muted'));
        const mail = connection.id.startsWith('mail:');
        const test = button(connection.id === 'berget' ? 'Kontrollera modellkatalog' : mail ? 'Testa läsåtkomst' : 'Testa anslutning', () => void this.act('correct', mail ? { action: 'test-account', accountId: connection.id.slice(5) } : { action: 'connection-test', provider: connection.id }));
        test.dataset.blocked = String(connection.state === 'checking'); test.disabled = connection.state === 'checking'; row.append(test); this.connectionRows.append(row);
      }
    }
    const budgetKey = JSON.stringify([view.budget, view.budgetError]);
    if (budgetKey !== this.budgetKey) {
      this.budgetKey = budgetKey; this.budgetSummary.replaceChildren(); const budget = view.budget;
      if (view.budgetError) { const error = node('p', `Budgeten kan inte läsas: ${view.budgetError}`, 'module-error'); error.setAttribute('role', 'alert'); this.budgetSummary.append(error); }
      else if (!budget) this.budgetSummary.append(node('p', 'Ingen Berget-förbrukning har hämtats.', 'muted'));
      else {
        this.budgetSummary.append(node('p', `Period: ${budget.period}`, 'muted'), node('p', budget.message));
        const totals = node('dl', '', 'assistant-budget-totals');
        for (const [label, value] of [['Avräknat', assistantEuros(budget.settledEur)], ['Reserverat', assistantEuros(budget.reservedEur)], ['Osäkert', assistantEuros(budget.uncertainEur)], ['Indata / utdata', `${budget.inputTokens.toLocaleString('sv-SE')} / ${budget.outputTokens.toLocaleString('sv-SE')} token`]]) { const row = node('div'); row.append(node('dt', label), node('dd', value)); totals.append(row); }
        this.budgetSummary.append(totals);
        const prices = details('Prisunderlag och anrop', 'assistant-budget-prices');
        if (!budget.prices.length) prices.append(node('p', 'Verifierat prisunderlag saknas. Ingen kostnad fylls i på antagande.', 'muted'));
        for (const price of budget.prices) { const row = node('p', `${price.model}: ${assistantEuros(price.inputPerMillion)} in / ${assistantEuros(price.outputPerMillion)} ut per miljon token. `); const source = node('a', 'Prisunderlag'); source.href = price.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; row.append(source, document.createTextNode(' · '), timestamp(price.checkedAt, 'Europe/Stockholm')); prices.append(row); }
        for (const entry of budget.entries) { const row = node('p', `${entry.model} · ${{ reserved: 'reserverat', settled: 'avräknat', uncertain: 'osäkert' }[entry.status]} · ${entry.costEur === undefined ? `reservation ${assistantEuros(entry.reservedEur)}` : assistantEuros(entry.costEur)} · `, 'muted'); row.append(timestamp(entry.createdAt, 'Europe/Stockholm')); prices.append(row); }
        this.budgetSummary.append(prices);
        if (!this.budgetDirty) this.budgetLimit.input.value = budget.limitEur === undefined ? '' : String(budget.limitEur);
      }
    }
    this.budgetLimit.input.disabled = !!view.budgetError;
    const budgetSave = this.budget.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    budgetSave.dataset.blocked = String(!!view.budgetError); budgetSave.disabled = !!view.budgetError;
    const memoryKey = JSON.stringify(view.memories);
    if (memoryKey !== this.memoryKey) {
      this.memoryKey = memoryKey; this.memories.replaceChildren();
      if (!view.memories?.length) this.memories.append(node('p', 'Inga uppgifter sparade ännu.', 'muted'));
      for (const memory of view.memories || []) {
        const row = node('article', '', 'assistant-memory-row'); row.dataset.memoryId = memory.id;
        row.append(node('h4', memory.label), node('p', memory.value, 'module-summary'), node('p', memory.scope === 'general' ? 'Allmänt' : memory.scope === 'mail' ? 'Mejl' : `Modul: ${memory.moduleId}`, 'muted'));
        const actions = node('div', '', 'assistant-actions'); actions.append(button('Redigera uppgift', () => this.editMemory(memory)), button('Radera uppgift', async () => { if (window.confirm(`Radera den sparade uppgiften ”${memory.label}”?`)) await this.act('correct', { action: 'memory-delete', id: memory.id }); })); row.append(actions); this.memories.append(row);
      }
    }
    this.controls();
  }
  private editMemory(memory: AssistantMemory) { this.memoryVersion++; this.memoryId = memory.id; this.memoryLabel.input.value = memory.label; this.memoryValue.input.value = memory.value; this.memoryScope.value = memory.scope; this.memoryModule.input.value = memory.moduleId || ''; this.memoryScope.onchange?.(new Event('change')); this.memoryForm.querySelector('h4')!.textContent = 'Redigera uppgift'; this.memoryLabel.input.focus(); }
  private resetMemory() { this.memoryVersion++; this.memoryId = undefined; this.memoryForm.reset(); this.memoryScope.onchange?.(new Event('change')); this.memoryForm.querySelector('h4')!.textContent = 'Ny uppgift'; }
  private async saveKey() {
    if (!this.key.input.value.trim() || this.keySaving) return; this.keySaving = true; this.controls();
    const version = this.keyVersion;
    const ok = await this.act('correct', { action: 'berget-key', key: this.key.input.value });
    if (ok && version === this.keyVersion) this.key.input.value = '';
    this.keySaving = false; this.keyStatus.textContent = ok ? version === this.keyVersion ? 'Nyckeln är sparad privat. Inget betalt anrop har gjorts.' : 'Nyckeln sparades. Din senaste inmatning är fortfarande osparad.' : 'Nyckeln kunde inte sparas. Kontrollera uppgifterna.'; this.controls();
  }
  private async removeKey() { const version = this.keyVersion; this.keySaving = true; this.controls(); const ok = await this.act('correct', { action: 'berget-key-remove' }); this.keySaving = false; if (ok && version === this.keyVersion) this.key.input.value = ''; this.keyStatus.textContent = ok ? 'Den sparade Berget-nyckeln är borttagen.' : 'Nyckeln kunde inte tas bort.'; this.controls(); }
}
