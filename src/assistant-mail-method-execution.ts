import type { AssistantAccount, AssistantCoverage } from '../shared/assistant';
import { compileAssistantMailMethod, type AssistantMailMethodDefinition, type AssistantMailMethodReport,
  type AssistantMailMethodSelection, type AssistantMailMethodStep } from '../shared/assistant-mail-methods';

export interface MailMethodBrowser {
  open(account: AssistantAccount, url?: string): Promise<unknown>;
  mailboxFolder(account: AssistantAccount, area: 'inbox' | 'sent'): Promise<Record<string, unknown>>;
  methodFolders(account: AssistantAccount): Promise<{ id: string; url: string }[]>;
  verifyMethodFolder(account: AssistantAccount, id: string): Promise<void>;
}
const value = (input: unknown): Record<string, unknown> => input && typeof input === 'object' ? input as Record<string, unknown> : {};
function verified(input: unknown, account: AssistantAccount, area?: 'inbox' | 'sent'): Record<string, unknown> {
  const result = value(input);
  if (result.accountId !== account.id || !Number.isInteger(result.tabId) || Number(result.tabId) <= 0
    || result.code || result.loginRequired || result.status === 'failed' || result.status === 'login'
    || !['list', 'empty', 'detail'].includes(String(result.view))
    || area && (!['list', 'empty'].includes(String(result.view)) || !Array.isArray(result.areas) || !result.areas.includes(area))) {
    throw new Error('Det inlärda steget kunde inte verifiera rätt konto och mejlvy. Fortsätt med vanliga läsverktyg eller be om hjälp.');
  }
  return result;
}

/** A method-local evidence epoch: earlier browser coverage never satisfies these checks. */
export async function runAssistantMailMethod(browser: MailMethodBrowser, account: AssistantAccount, definition: AssistantMailMethodDefinition): Promise<{ result: Record<string, unknown>; folders: number }> {
  let result: Record<string, unknown> = {}, folders = 0;
  for (const step of definition.steps) {
    if (step === 'verify-account') result = verified(await browser.open(account), account);
    else if (step === 'read-sent') result = verified(await browser.mailboxFolder(account, 'sent'), account, 'sent');
    else if (step === 'return-inbox') result = verified(await browser.mailboxFolder(account, 'inbox'), account, 'inbox');
    else {
      result = verified(await browser.mailboxFolder(account, 'inbox'), account, 'inbox');
      const inventory = await browser.methodFolders(account);
      if (inventory.length > 100) throw new Error('För många inkommande mappar för att verifiera metoden i en körning.');
      const visited = new Set<string>();
      for (const folder of inventory) {
        result = verified(await browser.open(account, folder.url), account);
        if (!['list', 'empty'].includes(String(result.view))) throw new Error('Mappens lista kunde inte verifieras.');
        await browser.verifyMethodFolder(account, folder.id);
        visited.add(folder.id);
      }
      const after = await browser.methodFolders(account);
      if (after.length !== inventory.length || after.some(folder => !visited.has(folder.id))) throw new Error('Mapparna ändrades under metodtestet. Den tidigare metoden behålls.');
      folders = Math.max(1, visited.size);
    }
  }
  return { result, folders };
}

type Trace = { order: AssistantMailMethodStep[]; calls: number; ms: number; expanded: boolean;
  used?: string; folders: number; preparationValid: boolean; failed: boolean };
export class AssistantMailMethodLearning {
  private traces = new Map<string, Trace>();
  private effect = false;
  constructor(private accounts: AssistantAccount[], readonly selections: AssistantMailMethodSelection[]) {}
  private trace(id: string): Trace {
    let trace = this.traces.get(id);
    if (!trace) { trace = { order: [], calls: 0, ms: 0, expanded: false, folders: 0, preparationValid: false, failed: false }; this.traces.set(id, trace); }
    return trace;
  }
  disable(): void { this.effect = true; }
  selection(id: string): AssistantMailMethodSelection | undefined { return this.selections.find(entry => entry.accountId === id); }
  expandOnRead(id: string): boolean { return !this.effect && (this.traces.get(id)?.failed ? this.selection(id)?.active : this.selection(id)?.method)?.definition.expandThreads === true; }
  observe(tool: string, input: unknown, elapsedMs: number): void {
    if (this.effect) return;
    const result = value(input), account = this.accounts.find(account => account.id === result.accountId);
    if (!account || result.code || result.loginRequired || result.status === 'failed' || result.status === 'login') return;
    const trace = this.trace(account.id);
    if (tool === 'browser_expand_thread' && result.view === 'detail' && result.historyComplete === true && result.truncated === false) trace.expanded = true;
    if (!['browser_open', 'browser_read'].includes(tool) || !['list', 'empty'].includes(String(result.view))) return;
    const areas = Array.isArray(result.areas) ? result.areas : [];
    if (areas.includes('inbox')) trace.order.push('read-incoming');
    else if (areas.includes('sent')) trace.order.push('read-sent');
    else return;
    trace.calls++; trace.ms += Math.max(0, elapsedMs);
  }
  async run(browser: MailMethodBrowser, account: AssistantAccount): Promise<Record<string, unknown>> {
    if (this.effect) throw new Error('Inlärda mejlmetoder används inte efter ett externt steg.');
    const method = this.selection(account.id)?.method;
    if (!method) throw new Error('Det finns ingen inlärd metod för kontot ännu. Gör en vanlig mejlkontroll först.');
    const trace = this.trace(account.id), started = Date.now(); trace.used = method.id; trace.calls++;
    try {
      const prepared = await runAssistantMailMethod(browser, account, method.definition);
      trace.preparationValid = true; trace.folders = prepared.folders;
      return { ...prepared.result, mailMethod: { id: method.id, prepared: true, folders: prepared.folders,
        note: 'Förberedelsen är verifierad. Läs och bedöm fortfarande färska fullständiga trådar och spara kontrollpunkter; mapplistor är inte full mejltäckning.' } };
    } catch (error) {
      trace.failed = true;
      const active = this.selection(account.id)?.active;
      if (!active || active.id === method.id) throw error;
      const fallback = await runAssistantMailMethod(browser, account, active.definition);
      trace.folders = fallback.folders;
      return { ...fallback.result, mailMethod: { id: active.id, prepared: true, candidateFailed: true,
        note: 'Ändringen kunde inte verifieras. Den tidigare fungerande metoden användes. Läs och bedöm fortfarande färska fullständiga trådar.' } };
    }
    finally { trace.ms += Math.max(0, Date.now() - started); }
  }
  async reports(browser: MailMethodBrowser, coverage: AssistantCoverage[], reviewedThreads: (id: string) => number,
    usage?: { inputTokens: number; outputTokens: number; costEur?: number }): Promise<AssistantMailMethodReport[]> {
    const reports: AssistantMailMethodReport[] = [];
    for (const selection of this.selections) {
      const account = this.accounts.find(account => account.id === selection.accountId), trace = this.traces.get(selection.accountId);
      if (!account || !trace) continue;
      const definition = selection.method?.definition ?? (trace.used ? undefined : compileAssistantMailMethod(trace.order, trace.expanded));
      if (!definition) continue;
      const checked = coverage.find(item => item.accountId === account.id)?.status === 'checked';
      let valid = trace.preparationValid, folders = trace.folders;
      if (!this.effect && !valid && !trace.failed && checked) {
        try { const trial = await runAssistantMailMethod(browser, account, definition); valid = true; folders = trial.folders; }
        catch { valid = false; }
      }
      const expansion = !definition.expandThreads || trace.expanded || selection.active?.definition.expandThreads === true;
      const reason = this.effect ? 'effect' as const : !checked ? 'coverage' as const
        : !valid || trace.failed ? 'preparation' as const : !expansion ? 'expansion-not-observed' as const : undefined;
      reports.push({ accountId: account.id, fingerprint: selection.fingerprint, revision: selection.revision, definition,
        ...(selection.method ? { usedId: selection.method.id } : {}), validated: !reason,
        measurement: { at: new Date().toISOString(), status: !reason ? 'verified' : reason === 'expansion-not-observed' ? 'waiting' : checked ? 'failed' : 'partial',
          mode: trace.used ? 'method' : 'learning', preparationCalls: trace.calls, preparationMs: Math.min(1_000_000, trace.ms),
          folders, reviewedThreads: reviewedThreads(account.id), ...(reason ? { reason } : {}), ...(usage ?? {}) } });
    }
    return reports;
  }
}
