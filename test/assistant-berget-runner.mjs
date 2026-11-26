import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBergetRunner, bergetRunnerStatus } from '../dist/assistant-berget-runner.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
// The runner's own composition of client, budget and agent, with a fake fetch and a fake worker:
// no network, no saved key, no model and no tool reaches anything real.
const model = 'zai-org/GLM-5.3-Flash', key = 'fixture-credential-only-not-a-real-key';
const dir = mkdtempSync(join(tmpdir(), 'tabai-berget-runner-'));
const catalog = { data: [{ id: model, lifecycle_status: 'active', lifecycle_state: 'stable', status: { up: true }, capabilities: { function_calling: true, streaming: true }, pricing: { currency: 'EUR', unit: '€ / M Token', input: 1, output: 2 } }] };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const sse = frames => new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
const toolCall = (name, args) => ({ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const entries = runId => JSON.parse(readFileSync(join(dir, 'assistant-budget.json'), 'utf8')).entries.filter(entry => entry.runId === runId);
const worker = names => {
  const calls = [];
  return { calls, async listTools() { return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) }; },
    async callTool(request) { calls.push(request.name); return { content: [{ type: 'text', text: JSON.stringify({ saved: true }) }] }; } };
};
async function run(mode, runId, names, respond) {
  const posts = [], events = [], tools = worker(names);
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url === 'https://api.berget.ai/v1/models/') return json(catalog);
    assert.equal(url, 'https://api.berget.ai/v1/chat/completions');
    posts.push(JSON.parse(init.body));
    return respond();
  };
  let error;
  try {
    await runBergetRunner({ key, fetcher, config: { model, deadlineAt: Date.now() + 60_000, dataDir: dir, runId }, mode, prompt: 'Syntetisk uppgift',
      worker: tools, signal: new AbortController().signal, progress: event => events.push(event) });
  } catch (caught) { error = caught; }
  return { posts, events, error, tools };
}

try {
  // Tasks, routines and watches show no preview: they call without streaming, and the usage Berget reports settles the reservation.
  for (const [mode, runId, names, reply] of [
    [false, 'task', ['workflow_context', 'workflow_question'], toolCall('workflow_question', { question: 'Vilket konto gäller det?' })],
    ['routine', 'routine', ['workflow_context', 'chat_reply'], toolCall('chat_reply', { text: 'Veckan är sammanfattad.' })],
    ['watch', 'watch', ['workflow_context', 'watch_report'], toolCall('watch_report', { changed: false, summary: 'Priset är oförändrat.' })],
  ]) {
    const result = await run(mode, runId, names, () => json({ model, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [reply] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    assert.equal(result.error, undefined, `${runId}: ${result.error?.message}`);
    assert.deepEqual(result.posts.map(body => body.stream), [false], `${runId} calls Berget without streaming`);
    assert.deepEqual(entries(runId).map(entry => entry.status), ['settled'], `${runId}: verified usage settles the reservation`);
    assert.equal(entries(runId)[0].costEur, 0.00014);
    assert.deepEqual(result.events.filter(event => event.usage).map(event => event.usage), [{ inputTokens: 100, outputTokens: 20, costEur: 0.00014 }], `${runId}: the settled usage reaches the host`);
    assert.equal(result.tools.calls.at(-1), reply.function.name);
  }

  // A chat turn streams its reply preview; Berget documents no usage on a stream, so the turn keeps its whole reservation.
  const frame = delta => `data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  const chat = await run(true, 'chat', ['workflow_context', 'chat_reply'], () => sse([
    frame({ tool_calls: [{ index: 0, id: 'reply-1', type: 'function', function: { name: 'chat_reply', arguments: '{"text":"Hej' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: ' då"}' } }] }),
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
  ]));
  assert.equal(chat.error, undefined, chat.error?.message);
  assert.deepEqual(chat.posts.map(body => body.stream), [true], 'a chat turn streams');
  assert.deepEqual(entries('chat').map(entry => entry.status), ['uncertain'], 'a streamed chat turn keeps its reservation');
  assert(chat.events.some(event => event.partial === 'Hej då'), 'the preview reaches the host');
  assert.deepEqual(chat.tools.calls, ['workflow_context', 'chat_reply']);

  // An error on the paid call: one POST, the code the host maps, and an entry that keeps its reservation.
  for (const [status, code] of [[401, 'auth'], [402, 'limit'], [429, 'limit'], [503, 'unavailable']]) {
    const runId = `error-${status}`;
    const failed = await run(false, runId, ['workflow_context', 'workflow_question'], () => new Response('fixture error body', { status }));
    assert.equal(failed.posts.length, 1, `HTTP ${status}: one paid POST, never retried`);
    assert.deepEqual(bergetRunnerStatus(failed.error), { type: 'berget-status', message: failed.error.message, code }, `HTTP ${status} maps to ${code}`);
    assert.deepEqual(entries(runId).map(entry => entry.status), ['uncertain'], `HTTP ${status}: the reservation is kept as uncertain`);
  }
  assert.deepEqual(bergetRunnerStatus(new Error('internal detail')), { type: 'berget-status', message: 'Berget-agenten avbröts. Inga anrop upprepades automatiskt.' }, 'an unexpected error never reaches the host as text');
  console.log('Berget runner: unstreamed tasks, routines and watches settle; streamed chat stays uncertain; paid-call errors map once passed');
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
