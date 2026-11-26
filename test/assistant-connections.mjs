import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { watchdog } from './watchdog.mjs';
// Real CLI probe processes and their cancellation run about 11 s.
const stopWatchdog = watchdog(async () => {
  for (const child of owned) if (child.pid && alive(child.pid)) child.kill('SIGKILL');
  await Promise.all(owned.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once('close', resolve))));
  rmSync(dir, { recursive: true, force: true });
}, 120_000);
const dir = mkdtempSync(join(tmpdir(), 'tabai-connections-')), owned = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
try {
  const file = join(dir, 'test.mjs');
  await build({ stdin: { contents: "export { AssistantConnections } from './src/assistant-connections'; export { AssistantExecutor } from './src/assistant-agent'; export { OllamaClient } from './src/assistant-ollama'; export { assistantLocalModel } from './src/assistant-local-models'; export { AssistantBergetKey } from './src/assistant-berget'; export { AssistantBudget } from './src/assistant-budget';", resolveDir: process.cwd(), loader: 'ts' }, outfile: file, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { AssistantConnections, AssistantExecutor, OllamaClient, assistantLocalModel, AssistantBergetKey, AssistantBudget } = await import(pathToFileURL(file).href);
  const settings = { accounts: [], lookbackDays: 1, followupDays: 1, timezone: 'UTC', tone: '', autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: '' };
  const local = { reachable: false, checking: false, models: [] };
  let executorStarts = 0, inferenceRequests = 0, keyReads = 0, reserves = 0;
  AssistantExecutor.prototype.start = async () => { executorStarts++; throw Error('Connection tests cannot infer'); };
  OllamaClient.prototype.chat = async () => { inferenceRequests++; throw Error('Connection tests cannot generate text'); };
  const fixture = join(dir, 'auth-status-fixture.mjs'), log = join(dir, 'auth-processes.jsonl'), cliCalls = [];
  writeFileSync(fixture, [
    "import { appendFileSync } from 'node:fs';",
    "const [provider, mode, log] = process.argv.slice(2);",
    "appendFileSync(log, JSON.stringify({ pid: process.pid, provider, mode }) + '\\n');",
    "if (mode === 'hang') setInterval(() => {}, 1000);",
    "else if (mode === 'large') process.stdout.write('x'.repeat(40000));",
    "else if (provider === 'codex') { process.stderr.write(mode === 'valid' ? 'Logged in using ChatGPT\\n' : 'Not logged in\\nPRIVATE_AUTH_DIAGNOSTIC\\n'); if (mode === 'logged-out') process.exitCode = 1; }",
    "else { process.stdout.write(mode === 'malformed' ? 'PRIVATE_INVALID_AUTH_JSON' : JSON.stringify({ loggedIn: mode === 'valid', email: 'PRIVATE_AUTH_EMAIL', token: 'PRIVATE_AUTH_TOKEN' })); if (mode === 'logged-out') process.exitCode = 1; }",
  ].join('\n'), { mode: 0o600 });
  let cliMode = 'valid';
  const spawnFixture = (command, args, options) => {
    let provider;
    if (process.platform === 'win32') {
      assert.match(command, /cmd\.exe$/i); assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
      provider = args[3] === 'codex login status' ? 'codex' : 'claude';
      assert.equal(args[3], provider === 'codex' ? 'codex login status' : 'claude auth status --json');
    } else { provider = command; assert.deepEqual(args, provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']); }
    assert.equal(options.shell, false); assert.equal(options.stdio, 'pipe'); assert.equal(options.windowsHide, true);
    assert.equal(options.env.BERGET_API_KEY, undefined); assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    cliCalls.push({ provider, args });
    const child = spawn(process.execPath, [fixture, provider, cliMode, log], options); owned.push(child); return child;
  };
  const connections = new AssistantConnections('fixture-root', join(dir, 'private'), spawnFixture);
  assert.equal(connections.view(settings, local, [], false)[0].state, 'unknown');
  const codex = connections.test('codex', undefined, []);
  assert.equal(connections.busy, true); assert.equal(connections.view(settings, local, [], false)[0].state, 'checking');
  await assert.rejects(connections.test('claude', undefined, []), /pågår/); await codex;
  assert.equal(connections.view(settings, local, [], false)[0].state, 'ready');
  assert.match(connections.view(settings, local, [], false)[0].message, /CLI-inloggning har verifierats/);
  assert.match(connections.view(settings, local, [], false)[0].message, /inferensförmåga har inte testats/);
  assert.equal(connections.view({ ...settings, agent: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } }, local, [], false)[0].state, 'unknown');
  await connections.test('claude', undefined, []); assert.equal(connections.view(settings, local, [], false)[1].state, 'ready');
  for (const [provider, mode] of [['codex', 'logged-out'], ['codex', 'malformed'], ['claude', 'logged-out'], ['claude', 'malformed'], ['claude', 'large']]) {
    cliMode = mode; await connections.test(provider, undefined, []);
    assert.equal(connections.view(settings, local, [], false).find(row => row.id === provider).state, 'action-required');
  }
  assert(cliCalls.length >= 7);
  assert.equal(readFileSync(join(dir, 'private', 'assistant-connections.json'), 'utf8').includes('PRIVATE_'), false, 'auth JSON, email, token and raw diagnostics are not stored');
  const selected = assistantLocalModel('qwen3.5:4b-q4_K_M'), localCalls = [];
  let runtimeVersion = selected.testedOllama[0], digest = selected.digest;
  OllamaClient.prototype.version = async () => { localCalls.push('version'); return runtimeVersion; };
  OllamaClient.prototype.tags = async () => { localCalls.push('tags'); return { models: [{ name: selected.id, digest }] }; };
  OllamaClient.prototype.show = async model => { localCalls.push('show'); assert.equal(model, selected.id); return { details: { family: selected.family, quantization_level: selected.quantization } }; };
  await connections.test('local', undefined, []);
  const localReady = { reachable: true, checking: false, version: runtimeVersion, models: [{ id: selected.id, state: 'ready', loaded: false }] };
  assert.deepEqual(localCalls, ['version', 'tags', 'show']);
  assert.equal(connections.view(settings, localReady, [], false).find(row => row.id === 'local').state, 'ready');
  assert.match(connections.view(settings, localReady, [], false).find(row => row.id === 'local').message, /digest och befintlig verifiering/);
  assert.match(connections.view(settings, localReady, [], false).find(row => row.id === 'local').message, /inferensförmåga har inte testats/);
  assert.equal(connections.view(settings, { ...localReady, version: '99.1.0' }, [], false).find(row => row.id === 'local').state, 'unknown');
  digest = '0'.repeat(64); await connections.test('local', undefined, []); assert.equal(connections.view(settings, localReady, [], false).find(row => row.id === 'local').state, 'action-required');
  digest = selected.digest; runtimeVersion = '99.1.0'; await connections.test('local', undefined, []);
  assert.equal(connections.view(settings, { ...localReady, version: runtimeVersion }, [], false).find(row => row.id === 'local').state, 'action-required');
  await connections.test('local', undefined, [{ model: selected.id, digest, ollamaVersion: runtimeVersion, profile: selected.profile, verifiedAt: new Date().toISOString() }]);
  assert.equal(connections.view(settings, { ...localReady, version: runtimeVersion }, [], false).find(row => row.id === 'local').state, 'ready', 'only an existing matching protocol verification admits this runtime');
  await connections.close(); await assert.rejects(connections.test('codex', undefined, []), /stängts/);
  const stopping = new AssistantConnections('fixture-root', join(dir, 'stopping'), spawnFixture); cliMode = 'hang';
  const stopped = stopping.test('codex', undefined, []), hung = owned.at(-1), deadline = Date.now() + 2000;
  while ((!existsSync(log) || !readFileSync(log, 'utf8').includes(String(hung.pid))) && Date.now() < deadline) await delay(10);
  await stopping.close(); await stopped;
  assert.equal(alive(hung.pid), false, 'close waits for its owned CLI process to exit');
  assert.equal(stopping.view(settings, local, [], false)[0].state, 'action-required');
  {
    // The time limit, shortened here from the product's 15 s: a CLI that never answers is stopped,
    // the test ends as action required with the limit named, and the process is gone.
    const limited = new AssistantConnections('fixture-root', join(dir, 'limited'), spawnFixture, 300); cliMode = 'hang';
    const outcome = limited.test('codex', undefined, []), hanging = owned.at(-1);
    // A failure detector only: without a working limit the hanging CLI would keep the test waiting.
    const ended = await Promise.race([outcome.then(() => true), delay(10_000).then(() => false)]);
    if (!ended) { await limited.close(); await outcome; }
    assert.equal(ended, true, 'the time limit ends the test');
    const row = limited.view(settings, local, [], false).find(entry => entry.id === 'codex');
    assert.equal(row.state, 'action-required');
    assert.match(row.message, /^Anslutningstestet nådde tidsgränsen och stoppades\./);
    assert.equal(alive(hanging.pid), false, 'the CLI process is gone');
    await limited.close();
  }
  const corruptDir = join(dir, 'corrupt'); mkdirSync(corruptDir);
  const corruptFile = join(corruptDir, 'assistant-connections.json'), corruptBytes = 'PRIVATE_CORRUPT_HISTORY';
  writeFileSync(corruptFile, corruptBytes, { mode: 0o600 });
  const corrupt = new AssistantConnections('fixture-root', corruptDir, spawnFixture), priorCliCalls = cliCalls.length;
  assert(corrupt.view(settings, local, [], true).every(row => row.state === 'action-required'));
  assert.match(corrupt.view(settings, local, [], true)[0].message, /Nästa anslutningstest/);
  // The history is a status cache: an unreadable file is set aside, intact, and the next test starts it again.
  cliMode = 'valid'; await corrupt.test('codex', undefined, []);
  assert.equal(cliCalls.length, priorCliCalls + 1, 'an unreadable history does not block the test');
  const setAside = readdirSync(corruptDir).filter(name => name.startsWith('assistant-connections.json.') && name.endsWith('.unreadable'));
  assert.equal(setAside.length, 1, 'the unreadable file is set aside');
  assert.equal(readFileSync(join(corruptDir, setAside[0]), 'utf8'), corruptBytes, 'with its bytes intact');
  const recovered = corrupt.view(settings, local, [], true);
  assert.equal(recovered.find(row => row.id === 'codex').state, 'ready');
  assert.equal(recovered.find(row => row.id === 'claude').state, 'unknown', 'the history starts empty');
  await corrupt.close();
  const realFetch = globalThis.fetch;
  const model = 'zai-org/GLM-5.3-Flash', requests = [], bergetDir = join(dir, 'berget-private');
  const berget = new AssistantConnections('fixture-root', bergetDir, spawnFixture);
  const metadata = { id: model, lifecycle_status: 'active', lifecycle_state: 'stable', status: { up: true }, capabilities: { function_calling: true, streaming: true }, pricing: { currency: 'EUR', unit: '€ / M Token', input: 1, output: 2 } };
  let catalogue = [metadata];
  AssistantExecutor.prototype.start = async () => { executorStarts++; throw new Error('Berget must never infer in a connection test'); };
  AssistantBergetKey.prototype.read = () => { keyReads++; throw new Error('The public catalog must not read a saved key'); };
  AssistantBudget.prototype.reserve = async () => { reserves++; throw new Error('The catalog test must never reserve paid usage'); };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(url, 'https://api.berget.ai/v1/models/'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    assert.equal(new Headers(options.headers).has('authorization'), false, 'public metadata does not test or transmit the saved key');
    return new Response(JSON.stringify({ data: catalogue }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.equal(berget.view(settings, local, [], true).find(row => row.id === 'berget').state, 'unknown', 'a saved key is not a verified connection');
    const checking = berget.test('berget', undefined, []);
    assert.equal(berget.busy, true); assert.equal(berget.view(settings, local, [], true).find(row => row.id === 'berget').state, 'checking');
    await checking;
    const saved = berget.view(settings, local, [], true).find(row => row.id === 'berget');
    assert.equal(saved.configured, true); assert.equal(saved.state, 'unknown'); assert(saved.testedAt);
    assert.match(saved.message, /modellkatalog verifierades/); assert.match(saved.message, /Nyckel sparad men dess behörighet är inte testad/); assert.match(saved.message, /inferens har inte testats/);
    const unsaved = berget.view(settings, local, [], false).find(row => row.id === 'berget');
    assert.equal(unsaved.configured, false); assert.equal(unsaved.state, 'action-required'); assert.equal(unsaved.testedAt, saved.testedAt); assert.match(unsaved.message, /Ingen Berget-nyckel/);
    const changedModel = { ...settings, agent: { backend: 'berget', codex: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' }, local: { model: 'qwen3.5:4b-q4_K_M' }, berget: { model: 'google/gemma-4-31B-it' } } };
    assert.equal(berget.view(changedModel, local, [], true).find(row => row.id === 'berget').testedAt, undefined, 'catalog verification belongs to the exact selected model');
    for (const invalid of [
      [{ ...metadata, id: 'other-model' }], [metadata, metadata], [{ ...metadata, lifecycle_status: 'deprecated' }], [{ ...metadata, lifecycle_state: 'preview' }], [{ ...metadata, end_of_life: '2026-01-01' }],
      [{ ...metadata, status: { up: false } }], [{ ...metadata, capabilities: { function_calling: false, streaming: true } }], [{ ...metadata, capabilities: { function_calling: true, streaming: false } }],
      [{ ...metadata, pricing: undefined }], [{ ...metadata, pricing: { ...metadata.pricing, currency: 'USD' } }], [{ ...metadata, pricing: { ...metadata.pricing, unit: 'tokens' } }], [{ ...metadata, pricing: { ...metadata.pricing, input: -1 } }],
    ]) {
      catalogue = invalid; await berget.test('berget', undefined, []);
      assert.equal(berget.view(settings, local, [], true).find(row => row.id === 'berget').state, 'action-required', 'an unavailable or unpriced configured model cannot pass the catalog test');
    }
    assert.equal(executorStarts, 0); assert.equal(keyReads, 0); assert.equal(reserves, 0); assert.equal(existsSync(join(bergetDir, 'assistant-budget.json')), false);
    assert(requests.length > 1 && requests.every(request => request.options.method === 'GET'), 'no connection test can dispatch a paid POST');
    let cancelled = 0;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }));
    const pendingCatalog = berget.test('berget', undefined, []);
    await berget.close(); await pendingCatalog;
    assert.equal(cancelled, 1); assert.equal(berget.busy, false); assert.equal(berget.view(settings, local, [], true).find(row => row.id === 'berget').state, 'action-required');
  } finally { globalThis.fetch = realFetch; await berget.close(); }
  assert.equal(executorStarts, 0); assert.equal(inferenceRequests, 0); assert.equal(keyReads, 0); assert.equal(reserves, 0);
  assert.equal(owned.some(child => child.pid && alive(child.pid)), false);
  console.log('assistant-connections: read-only CLI auth, verified local metadata, public Berget catalog, no inference/reservation, redacted history and owned-process cancellation passed');
} finally {
  for (const child of owned) if (child.pid && alive(child.pid)) child.kill('SIGKILL');
  await Promise.all(owned.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once('close', resolve))));
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
