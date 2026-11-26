import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const compiled = await build({ entryPoints: ['src/assistant-berget.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20' });
const { AssistantBergetKey, BergetClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const budgetBundle = await build({ entryPoints: ['src/assistant-budget.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20' });
const { AssistantBudget } = await import(`data:text/javascript;base64,${Buffer.from(budgetBundle.outputFiles[0].text).toString('base64')}`);
const model = 'zai-org/GLM-5.3-Flash';
const fakeKey = 'fixture-credential-only-not-a-real-key';
const dir = mkdtempSync(join(tmpdir(), 'tabai-berget-'));
const signal = new AbortController().signal;
const metadata = (changes = {}) => ({ id: model, lifecycle_status: 'active', lifecycle_state: 'stable', capabilities: { function_calling: true }, status: { up: true }, ...changes });
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const answer = { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'workflow_context', arguments: '{}' } }] } }] };

try {
  const store = new AssistantBergetKey(dir);
  assert.equal(store.configured, false);
  store.save(fakeKey); assert.equal(store.read(), fakeKey);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'berget-api-key')).mode & 0o777, 0o600);
  assert.throws(() => store.save(fakeKey + '\nInjected: header'), /blanksteg|radbrytningar/);
  assert.equal(store.read(), fakeKey, 'invalid replacement preserves the configured key');
  store.save(fakeKey + '-rotated'); assert.equal(store.read(), fakeKey + '-rotated');
  store.remove(); assert.equal(store.configured, false);
  if (process.platform !== 'win32') {
    const outside = join(dir, 'outside'); new AssistantBergetKey(outside).save(fakeKey);
    symlinkSync(join(outside, 'berget-api-key'), join(dir, 'berget-api-key'));
    assert.throws(() => store.read(), /säkert/);
    assert.equal(readFileSync(join(outside, 'berget-api-key'), 'utf8').trim(), fakeKey);
    rmSync(join(dir, 'berget-api-key'));
  }

  const calls = [];
  const client = new BergetClient(fakeKey, async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
    return url.endsWith('/models/') ? json({ data: [metadata()] }) : json(answer);
  });
  const reply = await client.complete(model, [{ role: 'user', content: 'Hej' }], [], signal);
  assert.equal(reply.message.tool_calls[0].function.name, 'workflow_context');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url), ['https://api.berget.ai/v1/models/', 'https://api.berget.ai/v1/chat/completions']);
  assert.equal(JSON.stringify(JSON.parse(calls[1].options.body)).includes(fakeKey), false, 'key is only an HTTP credential, never model input');
  await client.complete(model, [{ role: 'user', content: 'Igen' }], [], signal);
  assert.equal(calls.filter(call => call.url.endsWith('/models/')).length, 1, 'bounded catalog caching');

  for (const status of ['deprecated', 'preview', 'upgrading']) {
    let requests = 0;
    const retired = new BergetClient(fakeKey, async () => { requests++; return json({ data: [metadata({ lifecycle_status: status })] }); });
    await assert.rejects(retired.complete(model, [], [], signal), /inte längre aktiv/);
    assert.equal(requests, 1, 'lifecycle refusal happens before inference');
  }
  for (const code of [401, 402, 403, 429, 503]) {
    let requests = 0;
    const failed = new BergetClient(fakeKey, async () => { requests++; return new Response(fakeKey, { status: code }); });
    await assert.rejects(failed.complete(model, [], [], signal), error => !error.message.includes(fakeKey));
    assert.equal(requests, 1, 'an error is never automatically retried');
  }
  const invalid = new BergetClient(fakeKey, async url => url.endsWith('/models/') ? json({ data: [metadata()] }) : new Response(fakeKey));
  await assert.rejects(invalid.complete(model, [], [], signal), error => /ogiltigt/.test(error.message) && !error.message.includes(fakeKey));
  const pricing = { currency: 'EUR', input: 1, output: 2, unit: '€ / M Token' };
  const priced = changes => metadata({ pricing, capabilities: { function_calling: true, streaming: true }, ...changes });
  const budget = new AssistantBudget(join(dir, 'budget'));
  let paid = 0;
  const paidClient = new BergetClient(fakeKey, async (url) => {
    if (url.endsWith('/models/')) return json({ data: [priced()] });
    paid++; assert.equal(budget.view().entries.at(-1).status, 'reserved', 'reservation is durable before HTTP dispatch');
    return json({ ...answer, usage: { prompt_tokens: 100, completion_tokens: 20 } });
  }, { budget, runId: 'fixture-settlement' });
  const settled = await paidClient.complete(model, [], [], signal);
  assert.equal(settled.costEur, 0.00014); assert.equal(budget.view().settledEur, 0.00014);
  await budget.configure(0);
  await assert.rejects(paidClient.complete(model, [], [], signal), /månadsbudgeten/);
  assert.equal(paid, 1, 'budget rejection happens before another paid dispatch');
  await budget.configure(undefined);
  for (const changes of [{ pricing: undefined }, { pricing: { ...pricing, currency: 'USD' } }, { pricing: { ...pricing, unit: 'tokens' } }, { pricing: { ...pricing, input: -1 } }]) {
    let dispatches = 0;
    const missingPrice = new BergetClient(fakeKey, async () => { dispatches++; return json({ data: [priced(changes)] }); }, { budget, runId: 'invalid-price' });
    await assert.rejects(missingPrice.complete(model, [], [], signal), /EUR-pris/); assert.equal(dispatches, 1);
  }
  // Progress without streaming: the reply is read whole, and its usage settles the reservation and reaches the caller.
  const unstreamedEvents = [], unstreamedBodies = [];
  const unstreamed = new BergetClient(fakeKey, async (url, options) => {
    if (url.endsWith('/models/')) return json({ data: [priced()] });
    unstreamedBodies.push(JSON.parse(options.body));
    return json({ ...answer, usage: { prompt_tokens: 100, completion_tokens: 20 } });
  }, { budget, runId: 'fixture-unstreamed' });
  const whole = await unstreamed.complete(model, [], [], signal, 1000, event => unstreamedEvents.push(event)).catch(error => error);
  assert.deepEqual(unstreamedBodies.map(body => body.stream), [false], 'reporting progress alone never streams');
  assert.equal(whole.costEur, 0.00014); assert.equal(budget.view().entries.at(-1).status, 'settled');
  assert.deepEqual(unstreamedEvents, [{ status: 'Berget behandlar begäran.' }, { usage: { inputTokens: 100, outputTokens: 20, costEur: 0.00014 } }]);
  const frame = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  const terminal = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
  const frames = [frame({ reasoning_content: 'PRIVATE_REASONING', tool_calls: [{ index: 0, id: 'reply-1', type: 'function', function: { name: 'chat_reply', arguments: '{"text":"Hej' } }] }), frame({ tool_calls: [{ index: 0, function: { arguments: '\\nVärlden"}' } }] }), terminal];
  const stream = parts => new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const events = [];
  const streaming = new BergetClient(fakeKey, async (url, options) => {
    if (url.endsWith('/models/')) return json({ data: [priced()] });
    assert.equal(JSON.parse(options.body).stream, true);
    assert.equal(budget.view().entries.at(-1).status, 'reserved');
    return stream(frames);
  }, { budget, runId: 'fixture-stream' });
  const streamed = await streaming.complete(model, [], [], signal, 1000, event => events.push(event), true);
  assert.deepEqual(events.filter(event => event.partial !== undefined).map(event => event.partial), ['Hej', 'Hej\nVärlden']);
  assert.equal(streamed.message.tool_calls[0].function.arguments, '{"text":"Hej\\nVärlden"}');
  assert.equal(streamed.usage, undefined); assert.equal(budget.view().entries.at(-1).status, 'uncertain');
  assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'), false);
  const before = budget.view().uncertainEur;
  const truncated = new BergetClient(fakeKey, async url => url.endsWith('/models/') ? json({ data: [priced()] }) : stream(frames.slice(0, 1)), { budget, runId: 'fixture-truncated' });
  await assert.rejects(truncated.complete(model, [], [], signal, 1000, () => {}, true), /slutstatus/);
  assert(budget.view().uncertainEur > before, 'an interrupted stream retains the entire reservation');
  const aborted = new AbortController();
  const stopped = new BergetClient(fakeKey, async url => url.endsWith('/models/') ? json({ data: [priced()] }) : stream(frames), { budget, runId: 'fixture-abort' });
  let partials = 0;
  await assert.rejects(stopped.complete(model, [], [], aborted.signal, 1000, event => { if (event.partial !== undefined) { partials++; aborted.abort(); } }, true), /stoppades/);
  assert.equal(partials, 1, 'no preview after stop');
  assert.equal(budget.view().entries.at(-1).status, 'uncertain');
  const wrongModel = new BergetClient(fakeKey, async url => url.endsWith('/models/') ? json({ data: [priced()] }) : stream([`data: ${JSON.stringify({ model: 'another-model', choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`, terminal]), { budget, runId: 'wrong-model' });
  await assert.rejects(wrongModel.complete(model, [], [], signal, 1000, () => {}, true), /annan modell/);
  assert.equal(budget.view().entries.at(-1).status, 'uncertain');
  console.log('Berget: private key lifecycle, link refusal, exact endpoint, tool response, model lifecycle, redacted errors and no retries passed');
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
