import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod';
import type { AssistantAccount } from '../shared/assistant';
import { assistantMailMethodDefinitionSchema, assistantMailMethodRecordSchema, assistantMailMethodReportSchema,
  type AssistantMailMethodDefinition, type AssistantMailMethodRecord, type AssistantMailMethodReport,
  type AssistantMailMethodSelection, type AssistantMailMethodView } from '../shared/assistant-mail-methods';
import { RecipeStore } from './recipe-store';

const stateSchema = z.object({ version: z.literal(1), records: z.array(assistantMailMethodRecordSchema).max(12) }).strict();
type State = z.infer<typeof stateSchema>;
const empty = (): State => ({ version: 1, records: [] });
export function assistantMailAccountFingerprint(account: AssistantAccount): string {
  return createHash('sha256').update(JSON.stringify({ id: account.id, provider: account.provider,
    email: account.email.trim().toLowerCase(), url: account.url })).digest('hex');
}
const stale = () => new Error('Metoden har ändrats. Ditt utkast finns kvar; läs in den senaste versionen innan du sparar.');

/** Private typed methods, never recorded browser arguments, snapshots or run instructions. */
export class AssistantMailMethods {
  private readonly store: RecipeStore<State>;
  constructor(dataDir: string) {
    this.store = new RecipeStore(join(dataDir, 'mail-methods.json'), value => stateSchema.parse(value));
  }
  private state(): State { return this.store.load().state ?? empty(); }
  private record(state: State, account: AssistantAccount): AssistantMailMethodRecord | undefined {
    const fingerprint = assistantMailAccountFingerprint(account);
    return state.records.find(record => record.accountId === account.id && record.fingerprint === fingerprint);
  }
  views(accounts: AssistantAccount[]): AssistantMailMethodView[] {
    const state = this.state();
    return accounts.map(account => {
      const { fingerprint: _fingerprint, ...view } = this.record(state, account)
        ?? { accountId: account.id, fingerprint: '', revision: 0, history: [] };
      return structuredClone(view);
    });
  }
  select(account: AssistantAccount, relearn = false): AssistantMailMethodSelection {
    const record = this.record(this.state(), account);
    const method = relearn ? undefined : record?.candidate ?? record?.active;
    return { accountId: account.id, fingerprint: assistantMailAccountFingerprint(account), revision: record?.revision ?? 0,
      ...(record?.active ? { active: structuredClone(record.active) } : {}),
      ...(method ? { method: structuredClone(method) } : {}) };
  }
  private async change(accounts: AssistantAccount[], account: AssistantAccount, revision: number,
    change: (record: AssistantMailMethodRecord) => void): Promise<void> {
    const fingerprint = assistantMailAccountFingerprint(account);
    await this.store.update('state', current => {
      const next = current ?? empty();
      // Removed/reconfigured accounts cannot keep an executable method or exhaust capacity.
      next.records = next.records.filter(record => accounts.some(entry => entry.id === record.accountId && assistantMailAccountFingerprint(entry) === record.fingerprint));
      let record = this.record(next, account);
      if ((record?.revision ?? 0) !== revision) throw stale();
      if (!record) { record = { accountId: account.id, fingerprint, revision: 0, history: [] }; next.records.push(record); }
      change(record); record.revision++;
      return next;
    });
  }
  async edit(accounts: AssistantAccount[], account: AssistantAccount, revision: number, input: AssistantMailMethodDefinition): Promise<void> {
    const definition = assistantMailMethodDefinitionSchema.parse(input);
    await this.change(accounts, account, revision, record => {
      record.candidate = { id: randomUUID(), definition, createdAt: new Date().toISOString() };
    });
  }
  async forget(accounts: AssistantAccount[], account: AssistantAccount, revision: number): Promise<void> {
    await this.change(accounts, account, revision, record => { delete record.active; delete record.candidate; record.history = []; });
  }
  /** The controller calls this only after its exact run/account result persisted. */
  async observe(accounts: AssistantAccount[], account: AssistantAccount, input: AssistantMailMethodReport): Promise<void> {
    const report = assistantMailMethodReportSchema.parse(input);
    if (report.accountId !== account.id || report.fingerprint !== assistantMailAccountFingerprint(account)) throw stale();
    await this.change(accounts, account, report.revision, record => {
      record.history = [report.measurement, ...record.history].slice(0, 8);
      if (!report.validated || report.measurement.status !== 'verified') return;
      if (report.usedId && report.usedId !== record.candidate?.id && report.usedId !== record.active?.id) throw stale();
      const selected = report.usedId ? [record.candidate, record.active].find(entry => entry?.id === report.usedId) : undefined;
      if (selected && JSON.stringify(selected.definition) !== JSON.stringify(report.definition)) throw stale();
      const version = selected ?? { id: randomUUID(), definition: report.definition, createdAt: report.measurement.at };
      record.active = { ...version, verifiedAt: report.measurement.at };
      if (!selected || record.candidate?.id === version.id) delete record.candidate;
    });
  }
}
