import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';
const stopWatchdog = watchdog();
const compiled = await build({ entryPoints: ['src/assistant-berget-agent.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20' });
const { runBergetAgent } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function fixture(names, replies) {
  const calls = []; let completions = 0;
  const worker = { async listTools() { return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) }; }, async callTool(input) { calls.push(input); return text({ saved: true }); } };
  const client = { async complete() { return { message: replies[completions++] ?? { tool_calls: [call('last', 'workflow_finish')] } }; } };
  return { options: { worker, client, model: 'zai-org/GLM-5.3-Flash', prompt: 'Synthetic task', signal: new AbortController().signal, deadlineAt: Date.now() + 10000 }, calls, count: () => completions };
}
{
  const f = fixture(['workflow_context', 'chat_reply'], [{ content: 'Hej! Hur kan jag hjälpa dig?' }]);
  await runBergetAgent({ ...f.options, chat: true });
  assert.deepEqual(f.calls, [{ name: 'workflow_context', arguments: {} }, { name: 'chat_reply', arguments: { text: 'Hej! Hur kan jag hjälpa dig?' } }]);
}
{
  // A watch run ends at watch_report; nothing after it is dispatched or inferred.
  const f = fixture(['workflow_context', 'web_open', 'watch_report'], [{ tool_calls: [call('ctx', 'workflow_context')] }, { tool_calls: [call('report', 'watch_report', { changed: false, summary: 'Priset är oförändrat 499 kr (https://example.com).' })] }]);
  await runBergetAgent({ ...f.options, watch: true });
  assert.deepEqual(f.calls.map(call => call.name), ['workflow_context', 'watch_report']); assert.equal(f.count(), 2, 'no inference after the report');
}
{
  const f = fixture(['workflow_context', 'chat_start_task'], [{ tool_calls: [call('first', 'chat_start_task', { task: 'check-mail' }), call('bad', 'untrusted_shell', {})] }]);
  await assert.rejects(runBergetAgent({ ...f.options, chat: true }), /okänt/); assert.equal(f.calls.filter(call => call.name !== 'workflow_context').length, 0, 'validate a whole group before any task starts');
}
{
  const f = fixture(['workflow_context', 'chat_reply', 'chat_start_task'], [{ tool_calls: [call('done', 'chat_reply', { text: 'Hej' }), call('late', 'chat_start_task', { task: 'check-mail' })] }]);
  await assert.rejects(runBergetAgent({ ...f.options, chat: true }), /efter ett avslut/); assert.equal(f.calls.filter(call => call.name !== 'workflow_context').length, 0);
}
{
  const f = fixture(['workflow_context'], [{ tool_calls: [call('first', 'workflow_context')] }]);
  f.options.worker.callTool = async input => { f.calls.push(input); throw Error('Ambiguous transport failure'); };
  await assert.rejects(runBergetAgent(f.options), /Ambiguous/); assert.equal(f.calls.length, 1); assert.equal(f.count(), 1, 'transport ambiguity never replays an action or an inference');
}
{
  const f = fixture(['workflow_context'], Array.from({ length: 5 }, (_, index) => ({ tool_calls: [call(`call-${index}`, 'workflow_context')] })));
  await assert.rejects(runBergetAgent(f.options), /samma steg/); assert.equal(f.calls.length, 3);
}
{
  const f = fixture(['browser_read'], [{ tool_calls: [call('read', 'browser_read', { tabId: 1 })] }]);
  f.options.worker.callTool = async input => { f.calls.push(input); return text({ accountId: 'fixture', sourceId: 'thread', messageId: 'one', text: 'x'.repeat(230000) }); };
  await assert.rejects(runBergetAgent(f.options), /arbetsbudget/); assert.equal(f.count(), 1, 'unreviewed evidence is not silently cut to fit');
}
{
  // Repeated inbox list reads carry an observation but no message identity: the older pages give way, the evidence text stays.
  const reads = 8, replies = [];
  for (let index = 0; index < reads; index++) replies.push({ tool_calls: [call(`click-${index}`, 'browser_click', { tabId: 1, ref: `ref_${index + 1}` })] }, { tool_calls: [call(`read-${index}`, 'browser_read', { tabId: 1 })] });
  replies.push({ content: 'Inkorgen är genomgången.' });
  const f = fixture(['workflow_context', 'browser_click', 'browser_read', 'chat_reply'], replies);
  let listed = 0;
  f.options.worker.callTool = async input => {
    f.calls.push(input);
    if (input.name !== 'browser_read') return text({ clicked: true });
    listed++;
    return text({ accountId: 'fixture', sourceId: '', observationId: `list-${listed}`, view: 'list', page: { ok: true, compact: true, elements: `[ref_${listed}] row "Rad ${listed}"\n`.repeat(2_000) }, text: `Inkorgslista ${listed}` });
  };
  const seen = [];
  f.options.client.complete = async (model, messages) => { seen.push(JSON.stringify(messages)); return { message: replies[seen.length - 1] }; };
  await runBergetAgent({ ...f.options, chat: true });
  assert.equal(listed, reads, 'every list read ran');
  assert(seen.every(snapshot => Buffer.byteLength(snapshot) < 220_000), 'repeated list reads stay under the context budget');
  const results = JSON.parse(seen.at(-1)).filter(message => message.role === 'tool' && message.content.includes('observationId')).map(message => JSON.parse(message.content));
  assert.equal(results.length, reads);
  assert(results.slice(0, -1).every(result => typeof result.page === 'string' && result.page.startsWith('[Äldre navigeringsvy')), 'the older pages are replaced');
  assert.equal(typeof results.at(-1).page, 'object', 'the latest page stays complete');
  assert.deepEqual(results.map(result => result.text), Array.from({ length: reads }, (_, index) => `Inkorgslista ${index + 1}`), 'evidence text is kept');
}
{
  // Two steps taking turns without progress are a loop as well, not only one step repeated.
  const alternating = Array.from({ length: 20 }, (_, index) => ({ tool_calls: [index % 2 ? call(`b-${index}`, 'browser_click', { tabId: 1, ref: 'ref_1' }) : call(`a-${index}`, 'browser_read', { tabId: 1 })] }));
  const f = fixture(['browser_read', 'browser_click'], alternating);
  await assert.rejects(runBergetAgent(f.options), /samma steg/);
  assert.equal(f.calls.length, 7, 'an A, B, A, B loop stops once the same step returned the same result four times');
}
{
  // Every mail read carries a fresh observationId and observationSeq; neither is new content, so
  // reading and expanding the same unchanged thread in turn is a loop as well.
  const alternating = Array.from({ length: 20 }, (_, index) => ({ tool_calls: [index % 2 ? call(`b-${index}`, 'browser_expand_thread', { tabId: 1 }) : call(`a-${index}`, 'browser_read', { tabId: 1 })] }));
  const f = fixture(['browser_read', 'browser_expand_thread'], alternating);
  let sequence = 0;
  f.options.worker.callTool = async input => {
    f.calls.push(input); sequence++;
    return text({ accountId: 'fixture', sourceId: 'gmail:T1', messageId: 'gmail:message:m1', observationId: `observation-${sequence}`, observationSeq: sequence, view: 'detail', text: 'Samma tråd.' });
  };
  await assert.rejects(runBergetAgent(f.options), /samma steg/);
  assert.equal(f.calls.length, 7, 'the read loop stops once the same read returned the same thread four times');
}
{
  // A scroll acknowledges the same way every time, so only its repetition shows a stall: the
  // fourth identical scroll in a row is stopped before it is dispatched.
  const f = fixture(['browser_scroll'], Array.from({ length: 6 }, (_, index) => ({ tool_calls: [call(`scroll-${index}`, 'browser_scroll', { tabId: 1, direction: 'down' })] })));
  await assert.rejects(runBergetAgent(f.options), /samma steg/);
  assert.equal(f.calls.length, 3, 'three identical scrolls in a row run, the fourth does not');
}
{
  // Scrolls between reads of a page that keeps moving never count as the same result.
  const replies = [];
  for (let index = 0; index < 6; index++) replies.push({ tool_calls: [call(`scroll-${index}`, 'browser_scroll', { tabId: 1, direction: 'down' })] }, { tool_calls: [call(`read-${index}`, 'browser_read', { tabId: 1 })] });
  replies.push({ content: 'Sidan är genomläst.' });
  const f = fixture(['workflow_context', 'browser_scroll', 'browser_read', 'chat_reply'], replies);
  let sequence = 0;
  f.options.worker.callTool = async input => {
    f.calls.push(input);
    if (input.name !== 'browser_read') return text({ saved: true });
    sequence++;
    return text({ accountId: 'fixture', sourceId: '', observationId: `observation-${sequence}`, observationSeq: sequence, view: 'list', text: `Inkorgen, del ${sequence}` });
  };
  await runBergetAgent({ ...f.options, chat: true });
  assert.equal(f.calls.filter(entry => entry.name === 'browser_scroll').length, 6, 'every scroll ran');
}
{
  // A read after a click that opens another thread returns a new page: progress, not a loop.
  const replies = [];
  for (let index = 0; index < 6; index++) replies.push({ tool_calls: [call(`click-${index}`, 'browser_click', { tabId: 1, ref: `ref_${index + 1}` })] }, { tool_calls: [call(`read-${index}`, 'browser_read', { tabId: 1 })] });
  replies.push({ content: 'Trådarna är lästa.' });
  const f = fixture(['workflow_context', 'browser_click', 'browser_read', 'chat_reply'], replies);
  let sequence = 0;
  f.options.worker.callTool = async input => {
    f.calls.push(input);
    if (input.name !== 'browser_read') return text({ clicked: true });
    sequence++;
    return text({ accountId: 'fixture', sourceId: `gmail:T${sequence}`, messageId: `gmail:message:m${sequence}`, observationId: `observation-${sequence}`, observationSeq: sequence, view: 'detail', text: `Tråd ${sequence}` });
  };
  await runBergetAgent({ ...f.options, chat: true });
  assert.equal(sequence, 6, 'every thread was read');
}
{
  // An unchanged inbox list read again between threads is navigation, not a loop: the thread
  // opened and read between two list reads is new each time. The list read, the way back and
  // their results are identical on every round.
  const replies = [];
  for (let index = 0; index < 6; index++) replies.push(
    { tool_calls: [call(`list-${index}`, 'browser_read', { tabId: 1 })] },
    { tool_calls: [call(`open-${index}`, 'browser_click', { tabId: 1, ref: `ref_${index + 1}` })] },
    { tool_calls: [call(`thread-${index}`, 'browser_read', { tabId: 1 })] },
    { tool_calls: [call(`back-${index}`, 'browser_click', { tabId: 1, ref: 'ref_99' })] });
  replies.push({ content: 'Trådarna är lästa.' });
  const f = fixture(['workflow_context', 'browser_click', 'browser_read', 'chat_reply'], replies);
  let sequence = 0, threads = 0, inList = true;
  f.options.worker.callTool = async input => {
    f.calls.push(input);
    if (input.name === 'browser_click') inList = input.arguments.ref === 'ref_99';
    if (input.name !== 'browser_read') return text({ clicked: true });
    sequence++;
    if (inList) return text({ accountId: 'fixture', sourceId: '', observationId: `observation-${sequence}`, observationSeq: sequence, view: 'list', text: 'Inkorgen, oförändrad' });
    threads++;
    return text({ accountId: 'fixture', sourceId: `gmail:T${threads}`, messageId: `gmail:message:m${threads}`, observationId: `observation-${sequence}`, observationSeq: sequence, view: 'detail', text: `Tråd ${threads}` });
  };
  await runBergetAgent({ ...f.options, chat: true });
  assert.equal(threads, 6, 'six threads were read with the same list between them');
}
{
  // Going round the same threads again is a loop: nothing between the repeats is new any more.
  const replies = [];
  for (let index = 0; index < 12; index++) replies.push(
    { tool_calls: [call(`list-${index}`, 'browser_read', { tabId: 1 })] },
    { tool_calls: [call(`open-${index}`, 'browser_click', { tabId: 1, ref: `ref_${index % 2 + 1}` })] },
    { tool_calls: [call(`thread-${index}`, 'browser_read', { tabId: 1 })] },
    { tool_calls: [call(`back-${index}`, 'browser_click', { tabId: 1, ref: 'ref_99' })] });
  const f = fixture(['browser_click', 'browser_read'], replies);
  let sequence = 0, thread = 0, inList = true;
  f.options.worker.callTool = async input => {
    f.calls.push(input);
    if (input.name === 'browser_click') { inList = input.arguments.ref === 'ref_99'; if (!inList) thread = Number(input.arguments.ref.slice(4)); }
    if (input.name !== 'browser_read') return text({ clicked: true });
    sequence++;
    return inList ? text({ accountId: 'fixture', sourceId: '', observationId: `observation-${sequence}`, observationSeq: sequence, view: 'list', text: 'Inkorgen, oförändrad' })
      : text({ accountId: 'fixture', sourceId: `gmail:T${thread}`, messageId: `gmail:message:m${thread}`, observationId: `observation-${sequence}`, observationSeq: sequence, view: 'detail', text: `Tråd ${thread}` });
  };
  await assert.rejects(runBergetAgent(f.options), /samma steg/);
  assert(f.calls.length < replies.length, `the run stopped after ${f.calls.length} of ${replies.length} calls`);
}
{
  // A final reply longer than chat_reply accepts is reported as too large, never as a generic failure.
  const f = fixture(['workflow_context', 'chat_reply'], [{ content: 'å'.repeat(17_000) }]);
  await assert.rejects(runBergetAgent({ ...f.options, chat: true }), error => error.code === 'too-large' && /för långt/.test(error.message));
  assert.deepEqual(f.calls.map(call => call.name), ['workflow_context'], 'nothing is saved');
}
{
  // The same for a chat_reply tool call, Berget's usual way to answer: too large, and nothing in its group runs.
  const f = fixture(['workflow_context', 'chat_start_task', 'chat_reply'], [{ tool_calls: [call('task', 'chat_start_task', { task: 'check-mail' }), call('reply', 'chat_reply', { text: 'å'.repeat(17_000) })] }]);
  let failure;
  await assert.rejects(runBergetAgent({ ...f.options, chat: true }), error => { failure = error; return true; });
  assert.equal(failure.code, 'too-large', `an over-long chat_reply call is too large, not ${failure.code}: ${failure.message}`);
  assert.match(failure.message, /Modellens svar blev för långt för chatten \(högst 16000 tecken\)\. Inget svar sparades; be om ett kortare svar\./);
  assert.deepEqual(f.calls.map(call => call.name), ['workflow_context'], 'nothing is saved and no task starts');
}
{
  // The limit counts UTF-16 units, as chat_reply does and as the host saves a reply: 8 000
  // characters outside the Basic Multilingual Plane are 16 000 units and are passed on whole.
  const fits = '😀'.repeat(8_000);
  const f = fixture(['workflow_context', 'chat_reply'], [{ content: fits }]);
  await runBergetAgent({ ...f.options, chat: true });
  assert.deepEqual(f.calls.at(-1), { name: 'chat_reply', arguments: { text: fits } }, 'a reply at the limit in units is saved whole');
  // One character more is 16 002 units: refused as too large, so the model can shorten it,
  // and never passed on to be saved cut at 16 000 units.
  const g = fixture(['workflow_context', 'chat_reply'], [{ tool_calls: [call('reply', 'chat_reply', { text: `${fits}😀` })] }]);
  await assert.rejects(runBergetAgent({ ...g.options, chat: true }), error => error.code === 'too-large', 'one character more is too large');
  assert.deepEqual(g.calls.map(call => call.name), ['workflow_context'], 'nothing of the over-long reply is saved');
}
stopWatchdog();
console.log('Berget agent: native chat reply, batch preflight, terminal ordering, no transport replay, loop and evidence budgets passed');
