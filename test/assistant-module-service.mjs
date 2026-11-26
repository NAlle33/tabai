import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watchdog } from './watchdog.mjs';

// Real module processes and their shutdown waits run about 10 s.
const stopWatchdog = watchdog(async () => {
  for (const host of hosts) host.close();
  for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 120_000);
// Only synthetic registered children run here. The actual host transport and
// client correlation code remain intact across both directions of the pipe.
const dir = mkdtempSync(join(tmpdir(), 'tabai-assistant-module-service-'));
const hosts = [], logs = [], failures = [];
const children = new Map();
const observeChildren = host => {
  for (const process of host.processes.values()) {
    const child = process.child;
    if (child && !children.has(child)) children.set(child, new Promise(resolve => child.once('close', resolve)));
  }
};
const within = async (promise, milliseconds) => {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const check = async (name, operation) => {
  try { await operation(); }
  catch (error) { failures.push(new Error(name, { cause: error })); }
};
const events = file => {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

try {
  const compiled = await build({ stdin: { contents: "export { PersonalModules } from './src/personal-modules'; export { AssistantModuleClient } from './src/assistant-module-client';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  const { PersonalModules, AssistantModuleClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await build({ entryPoints: ['src/assistant-module-client.ts'], outfile: join(dir, 'module-client.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  const fixture = join(dir, 'fixture-module.mjs');
  writeFileSync(fixture, String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AssistantModuleClient } from './module-client.mjs';
const [role, log] = process.argv.slice(2);
const record = event => appendFileSync(log, JSON.stringify({ ...event, pid: process.pid, role }) + '\n');
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
record({ type: 'spawn' });
let run, starts = 0;
const raw = new Map();
const bridge = new AssistantModuleClient(send);
const view = () => ({ title: role === 'target' ? 'Fixture capability' : 'Fixture assistant', description: 'Synthetic declared capability', startLabel: 'Start fixture',
  fields: [{ name: 'subject', label: 'Subject', required: true, value: 'PRIVATE_DEFAULT_MARKER', placeholder: 'PRIVATE_PLACEHOLDER_MARKER', advanced: true }, { name: 'body', label: 'Body', multiline: true, value: 'PRIVATE_BODY_DEFAULT' }],
  history: [{ id: 'private-record', label: 'PRIVATE_RECORD_MARKER', detail: 'PRIVATE_DETAIL_MARKER' }],
  drafts: { start: { context: 'private-context', revision: 1, values: { subject: 'PRIVATE_DRAFT_MARKER' } } }, ...(run ? { run } : {}) });
const reply = (frame, ok, result) => send({ id: frame.id, ok, ...(ok ? { result } : { error: String(result) }) });
const serviceView = result => ({ title: 'Fixture assistant', description: 'Synthetic service result', startLabel: 'Start', fields: [], run: { id: 'bridge-response', status: 'review', message: JSON.stringify(result) } });
async function request(frame) {
  record({ type: 'request', operation: frame.operation, input: frame.input });
  // A slow module answers each request inside the broker's own limit.
  if (role === 'slow-target') await new Promise(resolve => setTimeout(resolve, 4500));
  if (role === 'target' || role === 'slow-target') {
    if (frame.operation === 'start') { starts++; run = { id: 'fixture-run-' + starts, title: frame.input.subject, status: 'waiting', question: 'Choose a fixture month', questionId: 'fixture-question-' + starts, message: 'Fixture waiting', summary: 'PRIVATE_SUMMARY_MARKER' }; }
    if (frame.operation === 'reply') { run = { ...run, status: 'review', message: 'Fixture answered', summary: frame.input.answer }; delete run.question; delete run.questionId; }
    if (frame.operation === 'stop') run = { ...run, status: 'paused' };
    if (frame.operation === 'select') run = { ...run, messaging: 'ready' };
    if (frame.operation === 'message') run = { ...run, status: 'running', messaging: 'busy', summary: frame.input.message };
    reply(frame, true, view()); return;
  }
  if (!frame.input.command) { reply(frame, true, view()); return; }
  if (frame.input.background === 'true') {
    // The assistant's own request outlives this panel reply; its outcome is logged.
    bridge.request(JSON.parse(frame.input.command)).then(
      result => record({ type: 'background-result', ok: true, runId: result?.run?.id }),
      error => record({ type: 'background-result', ok: false, error: error.message }));
    reply(frame, true, view()); return;
  }
  try {
    const command = JSON.parse(frame.input.command);
    let result;
    if (frame.input.raw === 'true') {
      result = await new Promise((resolve, reject) => {
        const id = frame.id + '-service'; raw.set(id, { resolve, reject });
        const packet = { type: 'assistant-service', id, command }; send(packet);
        if (frame.input.duplicate === 'true') send(packet);
      });
    } else result = await bridge.request(command);
    reply(frame, true, serviceView(result));
  } catch (error) { reply(frame, false, error.message); }
}
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'assistant-service-response') {
    record({ type: 'service-response', id: frame.id, ok: frame.ok });
    const pending = raw.get(frame.id);
    if (pending) { raw.delete(frame.id); if (frame.ok) pending.resolve(frame.result); else pending.reject(new Error(frame.error)); }
    else bridge.receive(frame);
    return;
  }
  void request(frame).catch(error => reply(frame, false, error.message));
});
input.on('close', () => { bridge.close(); process.exit(0); });
`, { mode: 0o600 });

  const registration = (id, role, log) => ({ id, command: process.execPath, args: [fixture, role, log], cwd: dir });
  const makeHost = (name, { builtin = true, forgedId, targetRole = 'target' } = {}) => {
    const root = join(dir, name); mkdirSync(root);
    const log = join(root, 'processes.jsonl'); logs.push(log);
    const installed = [registration('fixture-module', targetRole, log)];
    if (forgedId) installed.push(registration(forgedId, 'assistant', log));
    writeFileSync(join(root, 'personal-modules.json'), JSON.stringify(installed), { mode: 0o600 });
    const host = new PersonalModules(root, builtin ? [registration('daily-assistant', 'assistant', log)] : []);
    const request = host.request.bind(host);
    host.request = (...args) => {
      // Observe the actual spawned handles synchronously, including children
      // that fail and clear their TypeScript-private reference before teardown.
      try { return request(...args); } finally { observeChildren(host); }
    };
    hosts.push(host); return { host, log };
  };
  const invoke = async (host, command, extra = {}, id = 'daily-assistant') => {
    const result = await host.request(id, 'status', { command: JSON.stringify(command), ...extra });
    return JSON.parse(result.run.message);
  };
  const command = (operation, input = {}, moduleId = 'fixture-module') => ({ action: 'request', moduleId, operation, input });
  const normal = makeHost('trusted');

  await check('trusted reverse-RPC, private metadata, exact process reuse and reply guards', async () => {
    const direct = await normal.host.request('fixture-module', 'start', { subject: 'direct fixture' });
    const catalogue = await invoke(normal.host, { action: 'list' });
    assert.deepEqual(catalogue, [{ id: 'fixture-module', title: 'Fixture capability', description: 'Synthetic declared capability', fields: [{ name: 'subject', label: 'Subject', required: true }, { name: 'body', label: 'Body', multiline: true }] }]);
    assert.equal(JSON.stringify(catalogue).includes('PRIVATE_'), false, 'discovery exposes neither default values, placeholders, drafts nor records');
    assert.equal(catalogue.some(module => module.id === 'daily-assistant'), false, 'the assistant cannot discover itself as a private capability');
    const observed = await invoke(normal.host, command('status'));
    assert.deepEqual(observed.run, direct.run, 'the built-in assistant sees the existing host-owned run');
    const started = await invoke(normal.host, command('start', { subject: 'chat fixture', body: 'explicit synthetic input' }));
    assert.equal(started.run.id, 'fixture-run-2');
    assert.deepEqual((await normal.host.request('fixture-module', 'status', {})).run, started.run, 'the normal module surface sees the same reverse-RPC state');
    const before = events(normal.log).filter(event => event.role === 'target' && event.operation === 'reply').length;
    for (const invalid of [
      command('reply', { 'run-id': 'unrelated-run', 'question-id': started.run.questionId, answer: 'September' }),
      command('reply', { 'run-id': started.run.id, 'question-id': 'stale-question', answer: 'September' }),
      command('reply', { 'run-id': started.run.id, answer: 'September' }),
      command('stop', { 'run-id': 'unrelated-run' }),
      command('start', { subject: 'rejected', executable: '/forbidden' }), command('status', { 'run-id': started.run.id }),
    ]) await assert.rejects(invoke(normal.host, invalid), /Modulfunktionen/);
    await assert.rejects(invoke(normal.host, command('resume', { 'run-id': started.run.id })), /Invalid option: expected one of/, 'chat cannot resume an installed module');
    assert.equal(events(normal.log).filter(event => event.role === 'target' && event.operation === 'reply').length, before, 'run and question guard failures never reach the module mutation');
    const answered = await invoke(normal.host, command('reply', { 'run-id': started.run.id, 'question-id': started.run.questionId, answer: 'September' }));
    assert.equal(answered.run.status, 'review'); assert.equal(answered.run.summary, 'September');
    await assert.rejects(invoke(normal.host, command('reply', { 'run-id': started.run.id, 'question-id': started.run.questionId, answer: 'stale duplicate' })), /Modulfunktionen/);
    const priorStarts = events(normal.log).filter(event => event.role === 'target' && event.operation === 'start').length;
    const duplicate = await invoke(normal.host, command('start', { subject: 'one raw request' }), { raw: 'true', duplicate: 'true' });
    assert.equal(duplicate.run.id, 'fixture-run-3');
    assert.equal(events(normal.log).filter(event => event.role === 'target' && event.operation === 'start').length, priorStarts + 1, 'duplicate reverse-RPC frames execute a start once');
    const target = events(normal.log).filter(event => event.role === 'target');
    assert.equal(target.filter(event => event.type === 'spawn').length, 1, 'panel and assistant reuse exactly one child');
    assert.equal(new Set(target.map(event => event.pid)).size, 1, 'no replacement child or parallel module runtime was launched');
  });

  await check('a free-text message needs a module run that takes one, exact fields and a ready state', async () => {
    const started = await invoke(normal.host, command('start', { subject: 'messaging fixture' }));
    const message = { 'run-id': started.run.id, 'message-id': 'fixture-message', message: 'Varför?' };
    await assert.rejects(invoke(normal.host, command('message', message)), /Modulfunktionen/, 'a run without messaging refuses');
    const ready = await invoke(normal.host, command('select', { 'case-id': started.run.id }));
    assert.equal(ready.run.messaging, 'ready');
    await assert.rejects(invoke(normal.host, command('message', { ...message, 'run-id': 'unrelated-run' })), /Modulfunktionen/);
    await assert.rejects(invoke(normal.host, command('message', { ...message, approve: 'true' })), /Modulfunktionen/);
    const before = events(normal.log).filter(event => event.operation === 'message').length;
    assert.equal(before, 0, 'guard failures never reach the module');
    const sent = await invoke(normal.host, command('message', message));
    assert.equal(sent.run.summary, 'Varför?');
    await assert.rejects(invoke(normal.host, command('message', { ...message, 'message-id': 'second' })), /Modulfunktionen/, 'a busy run refuses another message');
  });

  await check('self, unknown capability and forbidden raw operations are rejected', async () => {
    for (const invalid of [command('status', {}, 'daily-assistant'), command('status', {}, 'unknown-module'), command('open'), command('draft'), command('correct'), command('execute'), { action: 'request', moduleId: 'fixture-module', operation: 'start', input: { subject: 'x' }, command: '/forbidden' }])
      await assert.rejects(invoke(normal.host, invalid, { raw: 'true' }), /Modulfunktionen/);
    assert.equal(events(normal.log).some(event => event.role === 'target' && ['open', 'draft', 'correct', 'execute'].includes(event.operation)), false);
  });

  await check('simultaneous panel and assistant requests launch one shared module process', async () => {
    const race = makeHost('launch-race');
    const [direct, assistant] = await Promise.all([race.host.request('fixture-module', 'status', {}), invoke(race.host, command('status'))]);
    assert.deepEqual(assistant, direct);
    const target = events(race.log).filter(event => event.role === 'target');
    assert.equal(target.filter(event => event.type === 'spawn').length, 1, 'concurrent callers cannot start competing module runtimes');
    assert.equal(new Set(target.map(event => event.pid)).size, 1);
  });

  await check('a module operation that needs its status read and its action, each within the broker limit, succeeds through the assistant', async () => {
    const slow = makeHost('slow-module', { targetRole: 'slow-target' });
    await slow.host.request('daily-assistant', 'status', { command: JSON.stringify(command('start', { subject: 'slow fixture' })), background: 'true' });
    const deadline = Date.now() + 30_000;
    let outcome;
    while (!(outcome = events(slow.log).find(event => event.type === 'background-result')) && Date.now() < deadline) await delay(100);
    assert.ok(outcome, 'the assistant request settled');
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.runId, 'fixture-run-1');
    assert.deepEqual(events(slow.log).filter(event => event.role === 'slow-target' && event.type === 'request').map(event => event.operation), ['status', 'start'],
      'the broker read the status once and started exactly once');
  });

  await check('an ordinary installed module cannot forge an assistant service frame', async () => {
    const forged = makeHost('forged-ordinary', { forgedId: 'impostor' });
    await assert.rejects(invoke(forged.host, { action: 'list' }, {}, 'impostor'), /avslutades|frånkopplad/);
    assert.equal(events(forged.log).some(event => event.role === 'target'), false, 'forged authority never launches the target module');
  });

  await check('a private registration named daily-assistant is not a trusted builtin', async () => {
    const forged = makeHost('forged-builtin-name', { builtin: false, forgedId: 'daily-assistant' });
    await assert.rejects(invoke(forged.host, { action: 'list' }), /avslutades|frånkopplad|Modulfunktionen/);
    assert.equal(events(forged.log).some(event => event.role === 'target'), false, 'a reserved spelling alone cannot grant reverse-RPC authority');
  });

  await check('client correlation ignores late and duplicate responses and closes pending requests', async () => {
    const sent = [], client = new AssistantModuleClient(frame => sent.push(frame));
    try {
      const first = client.request({ action: 'list' });
      assert.equal(client.receive({ type: 'unrelated', id: sent[0].id }), false);
      assert.equal(client.receive({ type: 'assistant-service-response', id: 'unknown-id', ok: true, result: 'forged' }), true);
      client.receive({ type: 'assistant-service-response', id: sent[0].id, ok: true, result: ['first-result'] });
      client.receive({ type: 'assistant-service-response', id: sent[0].id, ok: true, result: ['duplicate-result'] });
      assert.deepEqual(await first, ['first-result']);
      const second = client.request(command('status'));
      const rejected = assert.rejects(second, /stängdes/); client.close(); await rejected;
      client.receive({ type: 'assistant-service-response', id: sent[1].id, ok: true, result: 'late-after-close' });
      assert.equal(sent.length, 2, 'late replies never replay requests');
    } finally { client.close(); }
    const throwing = new AssistantModuleClient(() => { throw new Error('synthetic pipe failure'); });
    await assert.rejects(throwing.request({ action: 'list' }), /stängdes/); throwing.close();
  });

  await check('timed-out client replies cannot settle a newer request or trigger a replay', async () => {
    const sent = [], client = new AssistantModuleClient(frame => sent.push(frame));
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    let expire;
    try {
      globalThis.setTimeout = callback => { expire = callback; return { fixture: true }; };
      globalThis.clearTimeout = () => {};
      const pending = client.request({ action: 'list' });
      const rejected = assert.rejects(pending, /dröjde.*inget upprepades/);
      expire(); await rejected;
    } finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
    try {
      let resolved = false;
      const next = client.request(command('status')).then(value => { resolved = true; return value; });
      client.receive({ type: 'assistant-service-response', id: sent[0].id, ok: true, result: 'late-for-expired-request' });
      await Promise.resolve(); assert.equal(resolved, false);
      client.receive({ type: 'assistant-service-response', id: sent[1].id, ok: true, result: 'current-result' });
      assert.equal(await next, 'current-result'); assert.equal(sent.length, 2);
    } finally { client.close(); }
  });

  await check('a closed module client cannot dispatch a new request', async () => {
    const sent = [], client = new AssistantModuleClient(frame => sent.push(frame));
    client.close();
    let request;
    try { request = client.request({ action: 'list' }); }
    catch (error) { request = Promise.reject(error); }
    const rejected = assert.rejects(request, /stäng/); client.close(); await rejected;
    assert.equal(sent.length, 0, 'close revokes future sends as well as outstanding requests');
  });
} catch (error) { failures.push(error); }
finally {
  for (const host of hosts) { try { host.close(); } catch (error) { failures.push(error); } }
  const closed = Promise.all(children.values());
  if (!await within(closed, 5000)) {
    failures.push(new Error('Fixture child handles required emergency cleanup'));
    for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (!await within(closed, 3000)) failures.push(new Error('Fixture child handles did not close after termination'));
  }
  await check('fixture process and directory cleanup', async () => {
    const pids = [...new Set(logs.flatMap(file => events(file).filter(event => event.type === 'spawn').map(event => event.pid)))];
    const deadline = Date.now() + 5000;
    while (pids.some(alive) && Date.now() < deadline) await delay(20);
    const leftovers = pids.filter(alive);
    for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (leftovers.length) { await delay(50); failures.push(new Error('Fixture children required emergency cleanup: ' + leftovers.join(', '))); }
    assert.equal(pids.some(alive), false, 'all owned fixture children are reaped');
  });
  // Windows can briefly retain directory handles after process exit. Retry
  // only temporary filesystem cleanup, while preserving earlier test failures.
  await check('temporary fixture directory removal', () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  stopWatchdog();
}
if (failures.length) throw new AggregateError(failures, 'Assistant module service integration failed');
console.log('assistant-module-service: trusted reverse-RPC, metadata privacy, process reuse, at-most-once frames, authority/run/question guards and client shutdown passed');
