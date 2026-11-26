import { OLLAMA_ORIGIN, AssistantLocalError, assistantLocalModel, assistantLocalModels, verifyAssistantLocalRuntime, type AssistantChatOutput, type AssistantChatRequest, type AssistantLocalVerification } from "./assistant-local-models";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
/** AbortSignal.any needs Node 20.3+; combine manually where it is missing. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
const PATHS = new Set(["/api/version", "/api/tags", "/api/show", "/api/pull", "/api/chat", "/api/ps", "/api/generate"]);

export interface NdjsonLimits { maxBytes: number; maxLineBytes: number; maxLines: number }
/**
 * Parse newline-delimited JSON across arbitrary chunk and UTF-8 boundaries.
 * Oversized streams, broken lines and a trailing partial record fail closed.
 */
export async function* readNdjson(body: ReadableStream<Uint8Array>, limits: NdjsonLimits, idle?: { ms: number; onIdle(): void }, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  // Cancel the body ourselves: a stalled stream must not outlive its request.
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let pending = "", bytes = 0, lines = 0;
  const parse = (line: string) => {
    if (++lines > limits.maxLines) throw new AssistantLocalError("too-large", "Svaret från Ollama innehöll för många rader.");
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new AssistantLocalError("protocol", "Ollama gav ett ogiltigt strömmat svar."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantLocalError("protocol", "Ollama gav ett oväntat strömmat svar.");
    return value as Record<string, unknown>;
  };
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Prompt evaluation streams nothing; the idle limit starts with the first chunk.
      if (idle && bytes > 0) timer = setTimeout(idle.onIdle, idle.ms);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } finally { clearTimeout(timer); }
      if (signal?.aborted) throw new AssistantLocalError("aborted", "Begäran avbröts.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limits.maxBytes) throw new AssistantLocalError("too-large", "Svaret från Ollama är för stort.");
      let text: string;
      try { text = decoder.decode(chunk.value, { stream: true }); } catch { throw new AssistantLocalError("protocol", "Ollama gav ogiltig UTF-8."); }
      pending += text;
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
        if (Buffer.byteLength(line) > limits.maxLineBytes) throw new AssistantLocalError("too-large", "En rad i Ollamas svar är för stor.");
        if (line) yield parse(line);
      }
      if (Buffer.byteLength(pending) > limits.maxLineBytes) throw new AssistantLocalError("too-large", "En rad i Ollamas svar är för stor.");
    }
    try { pending += decoder.decode(); } catch { throw new AssistantLocalError("protocol", "Ollama gav ogiltig UTF-8."); }
    // A record without its newline is a truncated stream, not a final answer.
    if (pending.trim()) throw new AssistantLocalError("protocol", "Ollamas svar avbröts mitt i ett meddelande.");
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { await reader.cancel(); } catch { /* The request is already closed. */ }
  }
}

export interface PullProgress { status: string; digest?: string; total?: number; completed?: number }
export interface ChatMetrics { promptTokens?: number; outputTokens?: number; totalMs?: number; loadMs?: number; promptMs?: number; evalMs?: number; doneReason?: string; firstChunkMs?: number }
export interface ChatResult extends AssistantChatOutput { metrics: ChatMetrics; raw: Record<string, unknown>[] }

const ms = (ns: unknown) => typeof ns === "number" ? Math.round(ns / 1e6) : undefined;
const errorCode = (message: string, status?: number) => /memory|out of memory|oom|insufficient/i.test(message) ? "oom" as const
  : /context (?:length|size|window)|available context|too long/i.test(message) ? "context" as const
  : status === 404 || /model .{0,200}not found|try pulling/i.test(message) ? "missing-model" as const
  : /json.?schema|grammar|format/i.test(message) ? "protocol" as const : "http" as const;

/** A minimal client bound to Ollama's loopback API: no redirects, credentials or other hosts. */
export class OllamaClient {
  private fetch: Fetch;
  constructor(options: { fetch?: Fetch } = {}) { this.fetch = options.fetch ?? ((input, init) => fetch(input, init)); }

  private async open(path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal; timeoutMs: number }): Promise<{ response: Response; signal: AbortSignal; timedOut(): boolean; close(): void }> {
    if (!PATHS.has(path)) throw new AssistantLocalError("protocol", "Ollama-anropet är inte tillåtet.");
    const url = new URL(path, OLLAMA_ORIGIN);
    if (url.origin !== OLLAMA_ORIGIN) throw new AssistantLocalError("protocol", "Endast lokal Ollama på 127.0.0.1 kan användas.");
    // A referenced timer: the deadline must fire even when nothing else keeps the process alive.
    const expiry = new AbortController(), deadline = expiry.signal;
    const timer = setTimeout(() => expiry.abort(), init.timeoutMs);
    const signal = init.signal ? anySignal([init.signal, deadline]) : deadline;
    const failure = (error: unknown): never => {
      clearTimeout(timer);
      if (error instanceof AssistantLocalError) throw error;
      if (init.signal?.aborted) throw new AssistantLocalError("aborted", "Avbrutet. Ollama kan fortfarande slutföra beräkningen i bakgrunden.");
      if (deadline.aborted) throw new AssistantLocalError("timeout", "Ollama svarade inte inom tidsgränsen.");
      throw new AssistantLocalError("unavailable", `Ollama svarar inte på ${OLLAMA_ORIGIN}. Starta Ollama-appen och försök igen.`);
    };
    let response: Response;
    try {
      response = await this.fetch(url.href, { method: init.method, headers: init.body === undefined ? undefined : { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "error", credentials: "omit", signal });
    } catch (error) { return failure(error); }
    if (response.url && new URL(response.url).origin !== OLLAMA_ORIGIN || response.redirected || response.type === "opaqueredirect")
      { clearTimeout(timer); throw new AssistantLocalError("protocol", "Ollama-svaret kom från en annan adress."); }
    if (!response.ok) {
      let message = `Ollama svarade med HTTP ${response.status}.`;
      try { const text = (await this.bounded(response, 64 * 1024)).trim(); const parsed = JSON.parse(text); if (typeof parsed?.error === "string") message = parsed.error.slice(0, 500); } catch { /* Status alone is reported. */ }
      clearTimeout(timer);
      throw new AssistantLocalError(errorCode(message, response.status), message, response.status);
    }
    return { response, signal, timedOut: () => deadline.aborted && !init.signal?.aborted, close: () => clearTimeout(timer) };
  }
  private async bounded(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader(), parts: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new AssistantLocalError("too-large", "Svaret från Ollama är för stort."); }
      parts.push(value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); }
    catch { throw new AssistantLocalError("protocol", "Ollama gav ogiltig UTF-8."); }
  }
  private async json(path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }): Promise<Record<string, unknown>> {
    const opened = await this.open(path, { ...init, timeoutMs: init.timeoutMs ?? 10_000 });
    let text: string;
    try { text = await this.bounded(opened.response, init.maxBytes ?? 1024 * 1024); }
    catch (error) {
      if (error instanceof AssistantLocalError) throw error;
      throw new AssistantLocalError(opened.timedOut() ? "timeout" : init.signal?.aborted ? "aborted" : "unavailable", "Ollama-svaret avbröts.");
    } finally { opened.close(); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new AssistantLocalError("protocol", "Ollama gav ett ogiltigt svar."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantLocalError("protocol", "Ollama gav ett oväntat svar.");
    if (typeof (value as { error?: unknown }).error === "string") { const message = String((value as { error: string }).error).slice(0, 500); throw new AssistantLocalError(errorCode(message), message); }
    return value as Record<string, unknown>;
  }

  async version(signal?: AbortSignal): Promise<string> {
    const value = await this.json("/api/version", { method: "GET", signal, timeoutMs: 3_000 });
    if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+[\w.+-]{0,40}$/.test(value.version)) throw new AssistantLocalError("protocol", "Ollama rapporterade en ogiltig version.");
    return value.version;
  }
  async tags(signal?: AbortSignal) { return await this.json("/api/tags", { method: "GET", signal, maxBytes: 4 * 1024 * 1024 }) as { models?: Record<string, any>[] }; }
  async ps(signal?: AbortSignal) { return await this.json("/api/ps", { method: "GET", signal }) as { models?: Record<string, any>[] }; }
  async show(model: string, signal?: AbortSignal) {
    assistantLocalModel(model);
    return await this.json("/api/show", { method: "POST", body: { model }, signal, maxBytes: 8 * 1024 * 1024 }) as Record<string, any>;
  }
  /** Unload is an explicit user choice: Ollama owns its cache and may serve other local clients. */
  async unload(model: string, signal?: AbortSignal): Promise<void> {
    assistantLocalModel(model);
    await this.json("/api/generate", { method: "POST", body: { model, keep_alive: 0, stream: false }, signal, timeoutMs: 30_000 });
  }

  /**
   * Aborting closes this request only. Ollama documents no server-side cancel,
   * so callers re-read `/api/tags` instead of promising the download stopped.
   */
  async pull(model: string, options: { signal?: AbortSignal; onProgress?(progress: PullProgress): void; timeoutMs?: number; idleMs?: number } = {}): Promise<void> {
    assistantLocalModel(model);
    const stall = new AbortController();
    const signal = options.signal ? anySignal([options.signal, stall.signal]) : stall.signal;
    const opened = await this.open("/api/pull", { method: "POST", body: { model, stream: true }, signal, timeoutMs: options.timeoutMs ?? 6 * 60 * 60_000 });
    let success = false, stalled = false;
    try {
      // A registry connection that stops sending progress is a stall, not a slow download.
      for await (const event of readNdjson(opened.response.body!, { maxBytes: 64 * 1024 * 1024, maxLineBytes: 16 * 1024, maxLines: 2_000_000 },
        { ms: options.idleMs ?? 180_000, onIdle: () => { stalled = true; stall.abort(); } }, opened.signal)) {
        if (typeof event.error === "string") throw new AssistantLocalError(errorCode(event.error), event.error.slice(0, 500));
        if (typeof event.status !== "string") throw new AssistantLocalError("protocol", "Ollama gav en ogiltig hämtningsstatus.");
        const progress: PullProgress = { status: event.status.slice(0, 200) };
        if (typeof event.digest === "string") progress.digest = event.digest.slice(0, 100);
        if (Number.isSafeInteger(event.total)) progress.total = event.total as number;
        if (Number.isSafeInteger(event.completed)) progress.completed = event.completed as number;
        if (progress.status === "success") success = true;
        options.onProgress?.(progress);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new AssistantLocalError("aborted", "Hämtningen avbröts av dig. Ollama kan ha sparat en del av filen; fortsätt hämtningen för att återuppta.");
      if (stalled) throw new AssistantLocalError("timeout", "Hämtningen står still. Försök igen; Ollama återupptar från det som redan hämtats.");
      if (opened.timedOut()) throw new AssistantLocalError("timeout", "Hämtningen tog för lång tid.");
      if (error instanceof AssistantLocalError) throw error;
      throw new AssistantLocalError("unavailable", "Anslutningen till Ollama bröts under hämtningen.");
    } finally { opened.close(); }
    if (!success) throw new AssistantLocalError("protocol", "Hämtningen avslutades utan bekräftelse från Ollama.");
  }

  /** Streams one bounded chat turn; partial output after abort is discarded. */
  async chat(request: AssistantChatRequest, options: { signal?: AbortSignal; timeoutMs?: number; idleMs?: number; maxContentChars?: number; keepRaw?: boolean; onProgress?(reply: AssistantChatOutput): void } = {}): Promise<ChatResult> {
    assistantLocalModel(request.model);
    if (request.tools && request.format) throw new AssistantLocalError("protocol", "Native- och intentprofilen kan inte kombineras.");
    const started = Date.now();
    const local = new AbortController();
    const signal = options.signal ? anySignal([options.signal, local.signal]) : local.signal;
    let idled = false;
    const opened = await this.open("/api/chat", { method: "POST", body: request, signal, timeoutMs: options.timeoutMs ?? 5 * 60_000 });
    const result: ChatResult = { content: "", thinking: "", toolCalls: [], metrics: {}, raw: [] };
    const maxContent = options.maxContentChars ?? 120_000;
    let done = false;
    try {
      for await (const event of readNdjson(opened.response.body!, { maxBytes: 16 * 1024 * 1024, maxLineBytes: 1024 * 1024, maxLines: 200_000 },
        { ms: options.idleMs ?? 180_000, onIdle: () => { idled = true; local.abort(); } }, opened.signal)) {
        result.metrics.firstChunkMs ??= Date.now() - started;
        if (options.keepRaw && result.raw.length < 4_000) result.raw.push(event);
        if (typeof event.error === "string") throw new AssistantLocalError(errorCode(event.error), event.error.slice(0, 500));
        if (done) throw new AssistantLocalError("protocol", "Ollama skickade data efter avslutat svar.");
        const message = event.message as { content?: unknown; thinking?: unknown; tool_calls?: unknown } | undefined;
        if (message) {
          if (typeof message.content === "string") result.content += message.content;
          if (typeof message.thinking === "string") result.thinking += message.thinking;
          if (Array.isArray(message.tool_calls)) result.toolCalls.push(...message.tool_calls);
          if (result.content.length + result.thinking.length > maxContent) throw new AssistantLocalError("too-large", "Modellens svar är för långt.");
          if (result.toolCalls.length > 16) throw new AssistantLocalError("protocol", "Modellen begärde för många verktygsanrop.");
        }
        if (!opened.signal.aborted && message) options.onProgress?.(result);
        if (event.done === true) {
          done = true;
          Object.assign(result.metrics, { promptTokens: event.prompt_eval_count, outputTokens: event.eval_count, totalMs: ms(event.total_duration),
            loadMs: ms(event.load_duration), promptMs: ms(event.prompt_eval_duration), evalMs: ms(event.eval_duration),
            doneReason: typeof event.done_reason === "string" ? event.done_reason.slice(0, 40) : undefined });
        }
      }
    } catch (error) {
      if (idled) throw new AssistantLocalError("no-output", "Modellen slutade svara. Försök igen eller välj en mindre modell.");
      if (options.signal?.aborted) throw new AssistantLocalError("aborted", "Avbrutet. Ollama kan fortfarande slutföra beräkningen i bakgrunden.");
      if (opened.timedOut()) throw new AssistantLocalError("timeout", "Modellen svarade inte inom tidsgränsen.");
      if (error instanceof AssistantLocalError) throw error;
      throw new AssistantLocalError("unavailable", "Anslutningen till Ollama bröts under svaret.");
    } finally { opened.close(); }
    if (!done) throw new AssistantLocalError("protocol", "Ollama avslutade svaret utan slutmarkering.");
    if (result.metrics.doneReason === "length") throw new AssistantLocalError("too-large", "Modellens svar nådde längdgränsen innan det blev klart.");
    return result;
  }
}

export type AssistantLocalModelState = "missing" | "ready" | "mismatch" | "untested";
export interface AssistantLocalStatus {
  reachable: boolean; version?: string; message?: string; checkedAt: string;
  models: { id: string; state: AssistantLocalModelState; loaded: boolean; vramBytes?: number; message?: string }[];
}
/**
 * Re-derive runtime state from Ollama itself. An interrupted download has no
 * manifest yet, so it is reported as not downloaded and resumes on next pull.
 */
export async function readAssistantLocalStatus(client: OllamaClient, verified: readonly AssistantLocalVerification[] = [], signal?: AbortSignal): Promise<AssistantLocalStatus> {
  const checkedAt = new Date().toISOString();
  let version: string;
  try { version = await client.version(signal); }
  catch (error) {
    return { reachable: false, checkedAt, message: error instanceof AssistantLocalError ? error.message : "Ollama kunde inte nås.",
      models: assistantLocalModels.map(model => ({ id: model.id, state: "missing", loaded: false })) };
  }
  const [tags, ps] = await Promise.all([client.tags(signal), client.ps(signal)]);
  const models: AssistantLocalStatus["models"] = [];
  for (const model of assistantLocalModels) {
    const running = (ps.models ?? []).find(entry => entry?.name === model.id || entry?.model === model.id);
    const loaded = !!running, vramBytes = Number.isSafeInteger(running?.size_vram) ? running!.size_vram as number : undefined;
    if (!(tags.models ?? []).some(entry => entry?.name === model.id || entry?.model === model.id)) { models.push({ id: model.id, state: "missing", loaded }); continue; }
    try {
      verifyAssistantLocalRuntime(model, version, tags, await client.show(model.id, signal), verified);
      models.push({ id: model.id, state: "ready", loaded, vramBytes });
    } catch (error) {
      if (!(error instanceof AssistantLocalError)) throw error;
      models.push({ id: model.id, state: error.code === "untested-version" ? "untested" : "mismatch", loaded, vramBytes, message: error.message });
    }
  }
  return { reachable: true, version, checkedAt, models };
}
