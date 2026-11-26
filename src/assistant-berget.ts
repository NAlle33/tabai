import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import * as z from 'zod';
import { atomicPrivateFile, isMissing, privateDirectory, readPrivateFile } from './private-storage';
import { AssistantBudget, ASSISTANT_PRICE_MAX_AGE_MS } from './assistant-budget';
import { assistantPartialReply, type AssistantProviderProgress } from './assistant-provider-progress';
import type { AssistantBudgetPrice } from '../shared/assistant-services';
import { assistantBergetModelSchema, type AssistantBergetModel } from '../shared/assistant-berget';

export class BergetError extends Error {
  constructor(
    readonly code: 'key' | 'auth' | 'limit' | 'unavailable' | 'model' | 'protocol' | 'context' | 'cancelled' | 'too-large',
    message: string,
  ) {
    super(message);
  }
}

const keySchema = z.string().trim().min(16).max(4096).regex(/^[\x21-\x7e]+$/);

/** The key never enters workspace JSON, model context, command arguments or views. */
export class AssistantBergetKey {
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, 'berget-api-key');
  }

  read(): string | undefined {
    try {
      return keySchema.parse(readPrivateFile(this.file, 4097).toString('utf8'));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new BergetError('key', 'Berget-nyckeln kan inte läsas säkert. Spara den på nytt i inställningarna.');
    }
  }

  get configured(): boolean {
    return this.read() !== undefined;
  }

  save(value: string): void {
    const parsed = keySchema.safeParse(value);
    if (!parsed.success) throw new BergetError('key', 'Kontrollera Berget-nyckeln. Den får inte innehålla blanksteg eller radbrytningar.');
    privateDirectory(this.directory);
    atomicPrivateFile(this.file, parsed.data + '\n');
  }
  remove(): void {
    // Validate the existing file before unlinking; never follow a link.
    if (!this.read()) return;
    try {
      unlinkSync(this.file);
    } catch (error) {
      if (!isMissing(error)) throw new BergetError('key', 'Berget-nyckeln kunde inte tas bort.');
    }
  }
}

export type BergetToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type BergetMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: BergetToolCall[]; tool_call_id?: string };
export type BergetTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
const callSchema = z.object({ id: z.string().min(1).max(200), type: z.literal('function'), function: z.object({ name: z.string().max(100), arguments: z.string().max(128_000) }) });
const replySchema = z.object({
  choices: z.array(z.object({ finish_reason: z.string().nullish(), message: z.object({ content: z.string().max(100_000).nullable().optional(), tool_calls: z.array(callSchema).max(8).optional() }) })).min(1).max(1),
  usage: z.object({ prompt_tokens: z.number().nonnegative().optional(), completion_tokens: z.number().nonnegative().optional() }).optional(),
});
const MAX_BYTES = 2 * 1024 * 1024;
const API = 'https://api.berget.ai/v1';
type ModelAvailability = { active: boolean; tools: boolean; up: boolean; streaming: boolean; price?: AssistantBudgetPrice };

/** No redirects, automatic retries, alternate endpoints or model fallback. */
export class BergetClient {
  private catalog?: { at: number; models: Map<string, ModelAvailability> };

  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch, private readonly options?: { budget: AssistantBudget; runId: string }) {
    if (!keySchema.safeParse(key).success) throw new BergetError('key', 'Anslut Berget i inställningarna först.');
  }

  /** With `streamed`, the response is the requested event stream and its previews go there. */
  private async request(path: string, body: unknown, signal: AbortSignal, timeoutMs: number, streamed?: (event: AssistantProviderProgress) => void): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const active = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.fetcher(API + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: active,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new BergetError('auth', 'Berget avvisade nyckeln eller åtkomsten. Kontrollera nyckel och konto.');
        if (response.status === 402 || response.status === 429) throw new BergetError('limit', 'Berget har nått en kredit- eller användningsgräns. Kontrollera kontot innan du försöker igen.');
        throw new BergetError('unavailable', `Berget kunde inte slutföra anropet (HTTP ${response.status}). Inget anrop upprepades.`);
      }
      if (!response.body) throw new BergetError('protocol', 'Berget gav ett tomt svar.');
      if (streamed) return await readBergetStream(response, active, streamed, (body as { model?: string } | undefined)?.model);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BYTES) throw new BergetError('protocol', 'Bergets svar var för stort.');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new BergetError('protocol', 'Berget gav ett ogiltigt svar.');
      }
    } catch (error) {
      if (signal.aborted) throw new BergetError('cancelled', 'Berget-anropet stoppades.');
      if (timeout.aborted) throw new BergetError('unavailable', 'Berget svarade inte inom tidsgränsen. Anropet upprepades inte.');
      if (error instanceof BergetError) throw error;
      throw new BergetError('unavailable', timeout.aborted ? 'Berget svarade inte inom tidsgränsen. Anropet upprepades inte.' : 'Kunde inte ansluta till Berget. Anropet upprepades inte.');
    }
  }
  async verify(model: AssistantBergetModel, signal: AbortSignal): Promise<void> {
    assistantBergetModelSchema.parse(model);
    if (!this.catalog || Date.now() - this.catalog.at > ASSISTANT_PRICE_MAX_AGE_MS) {
      const result = await this.request('/models/', undefined, signal, 15_000) as { data?: unknown };
      if (!Array.isArray(result?.data) || result.data.length > 1000) throw new BergetError('protocol', 'Bergets modellkatalog kunde inte tolkas.');
      const models = new Map<string, ModelAvailability>();
      for (const row of result.data) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
        models.set(row.id, {
          active: row.lifecycle_status === 'active' && row.lifecycle_state === 'stable' && !row.end_of_life,
          tools: row.capabilities?.function_calling === true,
          up: row.status?.up === true,
          streaming: row.capabilities?.streaming === true,
          ...(row.pricing?.currency === 'EUR' && row.pricing?.unit === '€ / M Token' && Number.isFinite(row.pricing?.input) && row.pricing.input >= 0 && Number.isFinite(row.pricing?.output) && row.pricing.output >= 0
            ? { price: { model: row.id, currency: 'EUR' as const, inputPerMillion: row.pricing.input, outputPerMillion: row.pricing.output, checkedAt: new Date().toISOString(), source: 'https://api.berget.ai/v1/models/' as const } } : {}),
        });
      }
      this.catalog = { at: Date.now(), models };
    }
    const selected = this.catalog.models.get(model);
    if (!selected?.active || !selected.tools) throw new BergetError('model', 'Den valda Berget-modellen är inte längre aktiv med verktygsstöd. Välj en annan modell; inget reservval gjordes.');
    if (!selected.up) throw new BergetError('unavailable', 'Den valda Berget-modellen är tillfälligt otillgänglig. Inget reservval gjordes.');
  }
  /**
   * One completion. `progress` hears status and verified usage; `stream` alone asks for an
   * event stream, whose reply previews also go to `progress`. Berget documents no usage on
   * a stream, so a streamed call keeps its whole reservation.
   */
  async complete(model: AssistantBergetModel, messages: BergetMessage[], tools: BergetTool[], signal: AbortSignal, timeoutMs = 90_000, progress?: (event: AssistantProviderProgress) => void, stream = false) {
    await this.verify(model, signal);
    const metadata = this.catalog!.models.get(model)!;
    if (stream && !metadata.streaming) throw new BergetError('model', 'Den valda modellen saknar verifierat streamingstöd. Inget reservval gjordes.');
    const body = { model, messages, tools, tool_choice: 'auto', stream, max_tokens: 4096 };
    let reservation: string | undefined, settled = false;
    if (this.options) {
      if (!metadata.price) throw new BergetError('model', 'Berget saknar ett verifierat aktuellt EUR-pris för modellen. Inget betalt anrop gjordes.');
      try { reservation = await this.options.budget.reserve(model, this.options.runId, Buffer.byteLength(JSON.stringify(body)), body.max_tokens, metadata.price); }
      catch (error) { throw new BergetError('limit', error instanceof Error ? error.message : 'Budgetreservationen kunde inte sparas. Inget betalt anrop gjordes.'); }
    }
    try {
      if (signal.aborted) throw new BergetError('cancelled', 'Berget-anropet stoppades.');
      progress?.({ status: 'Berget behandlar begäran.' });
      const raw = await this.request('/chat/completions', body, signal, timeoutMs, stream ? progress ?? (() => {}) : undefined);
      if (raw && typeof raw === 'object' && 'model' in raw && raw.model !== model) throw new BergetError('protocol', 'Berget svarade med en annan modell än den valda.');
      const parsed = replySchema.safeParse(raw);
      if (!parsed.success) throw new BergetError('protocol', 'Bergets svar följde inte det förväntade formatet.');
      // Streaming usage is not documented by Berget; keep the full reservation.
      const usage = stream ? undefined : parsed.data.usage;
      let costEur: number | undefined;
      if (reservation) { costEur = await this.options!.budget.settle(reservation, usage); settled = true; }
      if (usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens))
        progress?.({ usage: { inputTokens: usage.prompt_tokens!, outputTokens: usage.completion_tokens!, ...(costEur === undefined ? {} : { costEur }) } });
      if (parsed.data.choices[0].finish_reason === 'length') throw new BergetError('context', 'Modellens svar blev avbrutet av en gräns. Ingen ofullständig åtgärd kördes.');
      return { message: parsed.data.choices[0].message, usage, costEur };
    } finally {
      if (reservation && !settled) await this.options!.budget.settle(reservation);
    }
  }
}

/** Bounded SSE assembly; tool previews never dispatch a tool. */
async function readBergetStream(response: Response, signal: AbortSignal, progress: (event: AssistantProviderProgress) => void, model?: string): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw new BergetError('protocol', 'Berget gav inte den begärda händelseströmmen.');
  const reader = response.body!.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', bytes = 0, content = '', finish: string | null = null, done = false;
  const calls = new Map<number, BergetToolCall>();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const event = (frame: string) => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (done) throw new BergetError('protocol', 'Berget skickade data efter avslutad ström.');
    if (data === '[DONE]') { done = true; return; }
    let value: any; try { value = JSON.parse(data); } catch { throw new BergetError('protocol', 'Berget gav en ogiltig streaminghändelse.'); }
    if (value?.model !== undefined && value.model !== model) throw new BergetError('protocol', 'Berget strömmade en annan modell än den valda.');
    if (value.error || !Array.isArray(value.choices) || value.choices.length > 1) throw new BergetError('protocol', 'Berget gav en oväntad streaminghändelse.');
    // A terminal usage-only chunk may exist but is deliberately not trusted.
    if (!value.choices.length) return;
    const choice = value.choices[0], delta = choice.delta;
    if (choice.index !== 0 || !delta || typeof delta !== 'object') throw new BergetError('protocol', 'Bergets streamingval kunde inte verifieras.');
    if (delta.role !== undefined && delta.role !== 'assistant') throw new BergetError('protocol', 'Berget gav en oväntad avsändarroll.');
    if (finish !== null) throw new BergetError('protocol', 'Berget skickade svarstext efter avslutat modellval.');
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw new BergetError('protocol', 'Berget gav ogiltig svarstext.');
      content += delta.content;
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 8) throw new BergetError('protocol', 'Berget gav ogiltiga verktygsdeltan.');
      for (const part of delta.tool_calls) {
        if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index > 7) throw new BergetError('protocol', 'Berget gav ogiltigt verktygsindex.');
        let call = calls.get(part.index);
        if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(part.index, call); }
        if (part.type !== undefined && part.type !== 'function') throw new BergetError('protocol', 'Berget gav okänd verktygstyp.');
        if (part.id !== undefined) { if (typeof part.id !== 'string' || call.id) throw new BergetError('protocol', 'Berget gav tvetydig verktygsidentitet.'); call.id = part.id; }
        if (part.function?.name !== undefined) { if (typeof part.function.name !== 'string') throw new BergetError('protocol', 'Berget gav ogiltigt verktygsnamn.'); call.function.name += part.function.name; }
        if (part.function?.arguments !== undefined) { if (typeof part.function.arguments !== 'string') throw new BergetError('protocol', 'Berget gav ogiltiga verktygsargument.'); call.function.arguments += part.function.arguments; }
        if (call.function.arguments.length > 128_000 || call.function.name.length > 100 || call.id.length > 200) throw new BergetError('protocol', 'Bergets verktygsanrop var för stort.');
        if (call.function.name === 'chat_reply') { const text = assistantPartialReply(call.function.arguments); if (text !== undefined && !signal.aborted) progress({ partial: text }); }
      }
    }
    if (content.length > 100_000) throw new BergetError('protocol', 'Bergets svar var för stort.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (typeof choice.finish_reason !== 'string') throw new BergetError('protocol', 'Berget gav ogiltig slutstatus.'); finish = choice.finish_reason; }
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new BergetError('cancelled', 'Berget-anropet stoppades.');
      if (next.done) break;
      bytes += next.value.byteLength; if (bytes > MAX_BYTES) throw new BergetError('protocol', 'Bergets ström var för stor.');
      pending += decoder.decode(next.value, { stream: true }); pending = pending.replace(/\r\n/g, '\n');
      let index: number; while ((index = pending.indexOf('\n\n')) >= 0) { event(pending.slice(0, index)); pending = pending.slice(index + 2); }
      if (pending.length > 256_000) throw new BergetError('protocol', 'Bergets streaminghändelse var för stor.');
    }
    pending += decoder.decode();
    if (pending.trim()) event(pending);
    if (!done || finish === null) throw new BergetError('protocol', 'Bergets ström avslutades utan verifierad slutstatus.');
    const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([index], position) => index !== position)) throw new BergetError('protocol', 'Bergets verktygsgrupp var ofullständig.');
    return { choices: [{ finish_reason: finish, message: { content, ...(ordered.length ? { tool_calls: ordered.map(([, call]) => call) } : {}) } }] };
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
