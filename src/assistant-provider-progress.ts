/** Decode only the visible text field of a known chat_reply tool's arguments. */
export function assistantPartialReply(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 128_000) return undefined;
  const start = /^\s*\{\s*"text"\s*:\s*"/.exec(raw);
  if (!start) return undefined;
  let text = '';
  for (let index = start[0].length; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"') return text.slice(0, 16000);
    if (char === '\\') {
      const escaped = raw[++index]; if (escaped === undefined) break;
      if (escaped === 'u') {
        const hex = raw.slice(index + 1, index + 5); if (!/^[\da-f]{4}$/i.test(hex)) break;
        text += String.fromCharCode(parseInt(hex, 16)); index += 4;
      } else if ('"\\/bfnrt'.includes(escaped)) text += JSON.parse(`"\\${escaped}"`);
      else return undefined;
    } else { if (char.charCodeAt(0) < 32) return undefined; text += char; }
    if (text.length > 16000) return undefined;
  }
  // Do not publish an incomplete UTF-16 surrogate pair.
  return text.replace(/[\uD800-\uDBFF]$/, '');
}
/** The constrained intent grammar emits these fields in order; other orders wait for complete JSON. */
export function assistantIntentPartialReply(raw: string): string | undefined {
  if (raw.length > 128_000) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value?.action === 'respond' && value.tool === '__none__' && typeof value.text === 'string' && value.text.length <= 16000) return value.text;
    if (value?.action === 'call' && value.tool === 'chat_reply') return assistantPartialReply(JSON.stringify(value.arguments));
  } catch { /* A known reply may still be arriving. */ }
  const call = /^\s*\{\s*"action"\s*:\s*"call"\s*,\s*"tool"\s*:\s*"chat_reply"\s*,\s*"arguments"\s*:\s*/.exec(raw);
  if (call) return assistantPartialReply(raw.slice(call[0].length));
  const response = /^\s*\{\s*"action"\s*:\s*"respond"\s*,\s*"tool"\s*:\s*"__none__"\s*,\s*"arguments"\s*:\s*\{\s*\}\s*,\s*"text"\s*:\s*/.exec(raw);
  if (response) return assistantPartialReply('{"text":' + raw.slice(response[0].length));
  return undefined;
}
export type AssistantProviderProgress = { partial?: string; status?: string; usage?: { inputTokens: number; outputTokens: number; costEur?: number } };
const tokens = (input: unknown, output: unknown) => Number.isSafeInteger(input) && (input as number) >= 0 && Number.isSafeInteger(output) && (output as number) >= 0
  ? { inputTokens: input as number, outputTokens: output as number } : undefined;
/** Reasoning/text blocks and arbitrary tool arguments are never displayed. */
export class AssistantCliProgress {
  private blocks = new Map<number, { name: string; args: string }>();
  private seen = new Map<string, { inputTokens: number; outputTokens: number }>();
  private codexTurn = false;
  consume(provider: 'claude' | 'codex', event: any): AssistantProviderProgress {
    if (!event || typeof event !== 'object') return {};
    if (provider === 'codex') {
      if (event.type === 'turn.started') { this.codexTurn = true; return { status: 'Modellen behandlar meddelandet.' }; }
      if (event.type === 'turn.completed') { const active = this.codexTurn; this.codexTurn = false; return active ? { usage: tokens(event.usage?.input_tokens, event.usage?.output_tokens) } : {}; }
      const item = event.item;
      if (item?.type !== 'mcp_tool_call' || item.server !== 'tabai_assistant') return {};
      const tool = item.tool ?? item.name;
      if (tool === 'chat_reply' && event.type === 'item.completed') return { partial: assistantPartialReply(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)) };
      return event.type === 'item.started' ? { status: 'Modellen begär ett chattverktyg.' } : {};
    }
    const stream = event.type === 'stream_event' ? event.event : undefined;
    if (stream && (!Number.isSafeInteger(stream.index) || stream.index < 0 || stream.index > 7)) return {};
    if (stream?.type === 'content_block_start' && stream.content_block?.type === 'tool_use') {
      this.blocks.set(stream.index, { name: stream.content_block.name, args: '' });
      return { status: 'Modellen förbereder ett verktygsanrop.' };
    }
    if (stream?.type === 'content_block_delta' && stream.delta?.type === 'input_json_delta') {
      const block = this.blocks.get(stream.index);
      if (!block || block.args.length > 128_000 || typeof stream.delta.partial_json !== 'string') return {};
      block.args += stream.delta.partial_json;
      return block.name === 'mcp__tabai_assistant__chat_reply' ? { partial: assistantPartialReply(block.args) } : {};
    }
    if (stream?.type === 'content_block_stop') this.blocks.delete(stream.index);
    if (event.type === 'assistant' && typeof event.message?.id === 'string' && event.message.id.length <= 200 && this.seen.size < 1000) {
      const usage = event.message.usage, counts = [usage?.input_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0];
      if (!counts.every(count => Number.isSafeInteger(count) && count >= 0)) return {};
      const actual = tokens(counts.reduce((sum, count) => sum + count, 0), usage?.output_tokens);
      if (!actual) return {};
      const previous = this.seen.get(event.message.id) ?? { inputTokens: 0, outputTokens: 0 };
      const current = { inputTokens: Math.max(actual.inputTokens, previous.inputTokens), outputTokens: Math.max(actual.outputTokens, previous.outputTokens) };
      this.seen.set(event.message.id, current);
      if (current.inputTokens === previous.inputTokens && current.outputTokens === previous.outputTokens) return {};
      return { usage: { inputTokens: current.inputTokens - previous.inputTokens, outputTokens: current.outputTokens - previous.outputTokens } };
    }
    return {};
  }
}
