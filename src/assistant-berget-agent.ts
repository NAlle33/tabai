import type { AssistantProviderProgress } from './assistant-provider-progress';
import { ASSISTANT_CHAT_REPLY_LIMIT, assistantChatReplyTooLong, assistantToolSchemas, type AssistantToolName } from './assistant-tools';
import { inlineSchemaRefs } from './assistant-local-models';
import { AssistantLoopGuard } from './assistant-loop-guard';
import { assistantBergetModelInfo, type AssistantBergetModel } from '../shared/assistant-berget';
import { BergetError, type BergetClient, type BergetMessage } from './assistant-berget';

export type BergetWorker = {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<{ isError?: boolean; content?: { type: string; text?: string }[] }>;
};
/** `read`: a result that carries an observation. `readKey`: its full message identity, when it has one. */
type Entry = { message: BergetMessage; read?: boolean; readKey?: string };
const MAX_TURNS = 100;
const MAX_TOOL_CALLS = 4;
const MAX_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
const OMITTED_PAGE = '[Äldre navigeringsvy utelämnad; läs sidan igen för aktuella referenser.]';

/** A chat answer longer than chat_reply accepts is reported as too large, never as a broken run, whichever way the model gave it. */
const CHAT_REPLY_LIMIT = ASSISTANT_CHAT_REPLY_LIMIT;
function assertChatReplyFits(text: unknown): void {
  if (typeof text === 'string' && assistantChatReplyTooLong(text))
    throw new BergetError('too-large', `Modellens svar blev för långt för chatten (högst ${CHAT_REPLY_LIMIT} tecken). Inget svar sparades; be om ett kortare svar.`);
}

const readKey = (value: Record<string, unknown>, thread = 'sourceId') =>
  typeof value.accountId === 'string' && typeof value[thread] === 'string' && typeof value.messageId === 'string'
    ? JSON.stringify([value.accountId, value[thread], value.messageId]) : undefined;

/** A single serial tool loop. Only the existing authenticated worker can act. */
export async function runBergetAgent(options: {
  client: Pick<BergetClient, 'complete'>; worker: BergetWorker; model: AssistantBergetModel;
  prompt: string; signal: AbortSignal; deadlineAt: number; chat?: boolean; watch?: boolean;
  /** Ask Berget for an event stream; only a chat turn's reply preview needs one. */
  stream?: boolean; progress?: (event: AssistantProviderProgress) => void;
}): Promise<void> {
  const listed = await options.worker.listTools();
  if (!listed.tools.length || listed.tools.length > 32 || listed.tools.some(tool => !Object.hasOwn(assistantToolSchemas, tool.name)))
    throw new BergetError('protocol', 'Assistentens verktygskatalog kunde inte verifieras.');
  const tools = listed.tools.map(tool => ({ type: 'function' as const, function: {
    name: tool.name, description: tool.description ?? '', parameters: inlineSchemaRefs(tool.inputSchema),
  } }));
  const allowed = new Set(listed.tools.map(tool => tool.name));
  const entries: Entry[] = [{ message: { role: 'system', content: options.prompt } }];
  if (options.chat) {
    if (!allowed.has('workflow_context')) throw new BergetError('protocol', 'Chattens kontextverktyg saknas.');
    const context = await options.worker.callTool({ name: 'workflow_context', arguments: {} });
    if (context.isError) throw new BergetError('protocol', 'Samtalskontexten kunde inte läsas.');
    const text = (context.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    entries.push({ message: { role: 'user', content: `CONTEXT_FROM_HOST ${text}` } });
  }
  const checkpointed = new Set<string>();
  const ids = new Set<string>();
  let prose = 0;
  const guard = new AssistantLoopGuard(() => new BergetError('protocol', 'Modellen fastnade i samma steg utan att komma vidare. Sparade bedömningar finns kvar.'));
  const terminal = new Set(options.chat ? ['chat_reply'] : options.watch ? ['watch_report'] : ['workflow_finish', 'workflow_question', 'workflow_help', 'browser_send_approved']);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (options.signal.aborted) throw new BergetError('cancelled', 'Berget-uppdraget stoppades.');
    const remaining = options.deadlineAt - Date.now();
    if (remaining <= 0) throw new BergetError('unavailable', 'Berget-uppdragets tidsgräns nåddes. Sparade kontrollpunkter finns kvar.');
    // Every page read but the latest gives up its navigation view, list reads included;
    // its evidence text stays. Only evidence the host has durably saved, known by its full
    // message identity, becomes a stub. Unreviewed evidence is never silently truncated.
    const reads = entries.filter(entry => entry.read);
    for (const entry of reads.slice(0, -1)) {
      try {
        const value = JSON.parse(entry.message.content!);
        if (value.page !== undefined) value.page = OMITTED_PAGE;
        if (entry.readKey && checkpointed.has(entry.readKey)) entry.message.content = JSON.stringify({ observationId: value.observationId, sourceId: value.sourceId, messageId: value.messageId, accountId: value.accountId, savedCheckpoint: true });
        else entry.message.content = JSON.stringify(value);
      } catch { /* Non-JSON tool results remain intact. */ }
    }
    const messages = entries.map(entry => entry.message);
    if (Buffer.byteLength(JSON.stringify([messages, tools])) > assistantBergetModelInfo[options.model].contextBytes)
      throw new BergetError('context', 'Underlaget ryms inte i den valda modellens arbetsbudget. Sparade bedömningar finns kvar; välj en modell med större budget eller avgränsa uppdraget.');
    const { message } = await options.client.complete(options.model, messages, tools, options.signal, Math.min(90_000, remaining), options.progress, options.stream);
    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      if (options.chat && message.content?.trim() && allowed.has('chat_reply')) {
        assertChatReplyFits(message.content);
        const args = assistantToolSchemas.chat_reply.parse({ text: message.content });
        const result = await options.worker.callTool({ name: 'chat_reply', arguments: args });
        if (result.isError) throw new BergetError('protocol', 'Chattsvaret kunde inte sparas.');
        return;
      }
      if (++prose > 2) throw new BergetError('protocol', 'Berget-modellen avslutade utan att spara ett verifierat resultat.');
      entries.push({ message: { role: 'assistant', content: message.content ?? '' } }, { message: { role: 'user', content: 'Använd de tillgängliga verktygen och avsluta med ett sparat resultat. Ett textsvar är inte ett utfört uppdrag.' } });
      continue;
    }
    if (calls.length > MAX_TOOL_CALLS) throw new BergetError('protocol', 'Modellen begärde för många samtidiga åtgärder. Inga i gruppen kördes.');
    // Validate the entire proposed group before its first dispatch.
    const parsed = calls.map(call => {
      if (ids.has(call.id) || !allowed.has(call.function.name)) throw new BergetError('protocol', 'Modellen begärde ett okänt eller upprepat verktygsanrop.');
      ids.add(call.id);
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { throw new BergetError('protocol', 'Modellens verktygsargument var ogiltiga.'); }
      const tool = call.function.name as AssistantToolName;
      if (tool === 'chat_reply' && args !== null && typeof args === 'object' && 'text' in args) assertChatReplyFits(args.text);
      const result = assistantToolSchemas[tool].safeParse(args);
      if (!result.success) throw new BergetError('protocol', 'Modellens verktygsargument följde inte verktygets schema.');
      return { call, tool, args: result.data as Record<string, unknown> };
    });
    if (parsed.some((entry, index) => terminal.has(entry.tool) && index !== parsed.length - 1))
      throw new BergetError('protocol', 'Modellen lade en åtgärd efter ett avslut. Inga i gruppen kördes.');
    entries.push({ message: { role: 'assistant', content: message.content ?? null, tool_calls: calls } });
    for (const entry of parsed) {
      // Scrolling always acknowledges the same way, so a scroll counts only toward the cap on
      // identical calls in a row; reads after it show whether the page moved.
      const key = JSON.stringify([entry.tool, entry.args]), guarded = entry.tool !== 'browser_scroll';
      guard.before(key);
      if (options.signal.aborted || Date.now() >= options.deadlineAt) throw new BergetError('cancelled', 'Uppdraget stoppades före nästa åtgärd.');
      const result = await options.worker.callTool({ name: entry.tool, arguments: entry.args });
      const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
      if (Buffer.byteLength(text) > MAX_TOOL_RESULT_BYTES) throw new BergetError('context', 'Assistentens verktygssvar blev för stort.');
      const next: Entry = { message: { role: 'tool', tool_call_id: entry.call.id, content: text } };
      if (!result.isError) {
        // Any result that carries an observation (open, read or expand, list or thread) is a page read.
        try {
          const value = JSON.parse(text);
          if (value && typeof value === 'object' && typeof value.observationId === 'string') { next.read = true; next.readKey = readKey(value); }
        } catch { /* Non-JSON results are never reads. */ }
        if (entry.tool === 'workflow_checkpoint' && entry.args.checkpoint && typeof entry.args.checkpoint === 'object') {
          const key = readKey(entry.args.checkpoint as Record<string, unknown>, 'threadId');
          if (key) checkpointed.add(key);
        }
        if (terminal.has(entry.tool)) return;
      }
      if (guarded) guard.after(key, text);
      entries.push(next);
    }
  }
  throw new BergetError('protocol', 'Berget-uppdragets steggräns nåddes. Sparade bedömningar finns kvar.');
}
