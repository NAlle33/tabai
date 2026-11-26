import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod';
import { assistantBudgetPriceSchema, assistantBudgetViewSchema, type AssistantBudgetPrice, type AssistantBudgetView } from '../shared/assistant-services';
import { atomicPrivateFile, isMissing, privateDirectory, readPrivateFile, withStoreLock } from './private-storage';

export const ASSISTANT_PRICE_MAX_AGE_MS = 15 * 60_000;
const entrySchema = assistantBudgetViewSchema.shape.entries.element.extend({ price: assistantBudgetPriceSchema, period: z.string(), ownerPid: z.number().int().positive() });
const ledgerSchema = z.object({ version: z.literal(1), limitEur: z.number().finite().nonnegative().optional(), entries: z.array(entrySchema).max(100_000), message: z.string().max(1000).default('') }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
/** The UTC calendar month as `YYYY-MM`, `offset` months from now. */
const period = (offset = 0) => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7); };
const cost = (input: number, output: number, price: AssistantBudgetPrice) => (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000;
const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };

/** Admission estimates bound new calls, not the provider's final invoice. */
export class AssistantBudget {
  private file: string;
  constructor(private dataDir: string) { this.file = join(dataDir, 'assistant-budget.json'); }
  private read(): Ledger {
    try { return ledgerSchema.parse(JSON.parse(readPrivateFile(this.file, 8 * 1024 * 1024).toString('utf8'))); }
    catch (error) { if (isMissing(error)) return { version: 1, entries: [], message: '' }; throw new Error('Budgetloggen kan inte läsas säkert. Nya betalda anrop stoppas.'); }
  }
  private write(ledger: Ledger): void {
    const bytes = JSON.stringify(ledgerSchema.parse(ledger));
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('Budgetloggen är full. Nya betalda anrop stoppas tills loggen har granskats.');
    atomicPrivateFile(this.file, bytes);
  }
  private async change<T>(operation: (ledger: Ledger) => T): Promise<T> {
    privateDirectory(this.dataDir);
    return withStoreLock(this.file, () => {
      const ledger = this.read();
      // Only the current month counts toward the limit. Older closed periods go here, under the
      // lock, so the ledger stays far below its size cap; the previous month is kept.
      const kept = period(-1);
      ledger.entries = ledger.entries.filter(entry => entry.period >= kept);
      for (const entry of ledger.entries) if (entry.status === 'reserved' && dead(entry.ownerPid)) entry.status = 'uncertain';
      const result = operation(ledger); this.write(ledger); return result;
    });
  }
  view(): AssistantBudgetView {
    const ledger = this.read(), month = period();
    const entries = ledger.entries.filter(entry => entry.period === month);
    let settledEur = 0, reservedEur = 0, uncertainEur = 0, inputTokens = 0, outputTokens = 0;
    const prices = new Map<string, AssistantBudgetPrice>();
    for (const entry of entries) {
      if (entry.status === 'settled') { settledEur += entry.costEur!; inputTokens += entry.inputTokens!; outputTokens += entry.outputTokens!; }
      else if (entry.status === 'uncertain' || dead(entry.ownerPid)) uncertainEur += entry.reservedEur;
      else reservedEur += entry.reservedEur;
      prices.set(entry.price.model, entry.price);
    }
    return assistantBudgetViewSchema.parse({ period: month, currency: 'EUR', limitEur: ledger.limitEur, settledEur, reservedEur, uncertainEur, inputTokens, outputTokens,
      prices: [...prices.values()].slice(-10), message: ledger.message || 'Perioden följer kalendermånad i UTC. Reservationer är försiktiga uppskattningar. Okänd förbrukning behåller hela reservationen; gränsen styr nya anrop, inte leverantörens faktura.',
      entries: entries.slice(-50).map(({ price: _price, period: _period, ownerPid, ...entry }) => ({ ...entry, status: entry.status === 'reserved' && dead(ownerPid) ? 'uncertain' : entry.status })) });
  }
  async configure(limitEur: number | undefined): Promise<void> {
    if (limitEur !== undefined && (!Number.isFinite(limitEur) || limitEur < 0)) throw new Error('Budgetgränsen måste vara ett positivt EUR-belopp eller noll.');
    await this.change(ledger => { ledger.limitEur = limitEur; ledger.message = ''; });
  }
  async reserve(model: string, runId: string, inputBytes: number, outputTokens: number, price: AssistantBudgetPrice): Promise<string> {
    assistantBudgetPriceSchema.parse(price);
    const age = Date.now() - Date.parse(price.checkedAt);
    if (price.model !== model || age < 0 || age > ASSISTANT_PRICE_MAX_AGE_MS || !Number.isFinite(price.inputPerMillion) || !Number.isFinite(price.outputPerMillion) || !Number.isSafeInteger(inputBytes) || inputBytes < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 1)
      throw new Error('Ett aktuellt verifierat Berget-pris och en begränsad begäran krävs före anrop.');
    // One token per UTF-8 byte plus framing overhead is intentionally conservative.
    const reservedEur = cost(inputBytes + 4096, outputTokens, price), id = randomUUID();
    if (!Number.isFinite(reservedEur)) throw new Error('Budgetreservationen kunde inte beräknas säkert.');
    let blocked = false;
    await this.change(ledger => {
      const used = ledger.entries.filter(entry => entry.period === period()).reduce((sum, entry) => sum + (entry.status === 'settled' ? entry.costEur! : entry.reservedEur), 0);
      if (ledger.limitEur !== undefined && used + reservedEur > ledger.limitEur) { ledger.message = 'Berget-anropet stoppades: månadsgränsen räcker inte för nästa reservation.'; blocked = true; return; }
      ledger.entries.push({ id, model, runId: runId.slice(0, 100), createdAt: new Date().toISOString(), status: 'reserved', reservedEur, price, period: period(), ownerPid: process.pid });
      ledger.message = '';
    });
    if (blocked) throw new Error('Berget-anropet stoppades av månadsbudgeten. Ändra gränsen i inställningarna för att tillåta fler anrop.');
    return id;
  }
  async settle(id: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): Promise<number | undefined> {
    return this.change(ledger => {
      const entry = ledger.entries.find(entry => entry.id === id);
      if (!entry || entry.status !== 'reserved') throw new Error('Budgetreservationen saknas eller är redan avstämd.');
      if (!Number.isSafeInteger(usage?.prompt_tokens) || !Number.isSafeInteger(usage?.completion_tokens) || usage!.prompt_tokens! < 0 || usage!.completion_tokens! < 0) { entry.status = 'uncertain'; return undefined; }
      entry.status = 'settled'; entry.inputTokens = usage!.prompt_tokens!; entry.outputTokens = usage!.completion_tokens!;
      entry.costEur = cost(entry.inputTokens, entry.outputTokens, entry.price); return entry.costEur;
    });
  }
}
