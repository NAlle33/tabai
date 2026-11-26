import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(directory, { recursive: true, force: true }));
const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export * from './shared/assistant-mail-methods.ts';
  export * from './src/assistant-mail-methods.ts';
  export * from './src/assistant-mail-method-execution.ts';
` }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { AssistantMailMethods, AssistantMailMethodLearning, compileAssistantMailMethod, runAssistantMailMethod } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const directory = mkdtempSync(join(tmpdir(), 'tabai-mail-methods-'));
const account = { id: 'demo', provider: 'zoho', email: 'demo@example.test', label: 'Demo', url: 'https://mail.zoho.eu/zm/', enabled: true };
const accounts = [account];
const checked = [{ accountId: account.id, status: 'checked', message: 'Verified' }];
function browserFixture() {
  let sequence = 0, folder = 'inbox';
  const calls = [];
  const snapshot = area => ({ accountId: account.id, tabId: 1, view: 'list', areas: area === 'custom' ? [] : [area],
    text: 'private-fixture-mail-body', ref: `ref_${++sequence}`, inboxRows: 1 });
  return { calls,
    async open(_account, url) { calls.push(url ? `folder:${url}` : 'verify'); folder = url ?? 'inbox'; return snapshot(folder === 'custom' ? 'custom' : folder === 'sent' ? 'sent' : 'inbox'); },
    async mailboxFolder(_account, area) { calls.push(area); folder = area; return snapshot(area); },
    async methodFolders() { return [{ id: 'inbox', url: 'inbox' }, { id: 'custom', url: 'custom' }]; },
    async verifyMethodFolder(_account, id) { assert.equal(folder, id); },
  };
}
try {
  const store = new AssistantMailMethods(directory), selection = store.select(account);
  const learning = new AssistantMailMethodLearning(accounts, [selection]);
  learning.observe('browser_open', { accountId: 'demo', view: 'list', areas: ['sent'] }, 3);
  learning.observe('browser_read', { accountId: 'demo', view: 'list', areas: ['inbox'] }, 5);
  learning.observe('browser_read', { accountId: 'demo', view: 'list', areas: ['inbox'] }, 2);
  const reports = await learning.reports(browserFixture(), checked, () => 2);
  assert.equal(reports[0].validated, true);
  assert.deepEqual(reports[0].definition.steps, ['verify-account', 'read-sent', 'read-incoming', 'return-inbox']);
  await store.observe(accounts, account, reports[0]);
  const active = store.views(accounts)[0].active;
  assert(active?.verifiedAt);
  assert.equal(new AssistantMailMethods(directory).select(account).method.id, active.id, 'a restart reuses the verified method');
  const privateBytes = readFileSync(join(directory, 'mail-methods.json'), 'utf8');
  assert.doesNotMatch(privateBytes, /private-fixture-mail-body|demo@example\.test|https:|ref_\d/);
  const alternate = compileAssistantMailMethod(['read-incoming', 'read-sent'], true);
  assert.notDeepEqual(alternate.steps, active.definition.steps);
  const first = browserFixture(), second = browserFixture();
  await runAssistantMailMethod(first, account, active.definition);
  await runAssistantMailMethod(second, account, alternate);
  assert.notDeepEqual(first.calls, second.calls, 'different observed baselines produce different executable traces');

  const revision = store.views(accounts)[0].revision;
  const changes = await Promise.allSettled([
    store.edit(accounts, account, revision, { ...alternate, expandThreads: false }),
    new AssistantMailMethods(directory).edit(accounts, account, revision, alternate),
  ]);
  assert.equal(changes.filter(change => change.status === 'fulfilled').length, 1, 'same-revision concurrent writers have one winner');
  let view = store.views(accounts)[0];
  assert.equal(view.active.id, active.id);
  assert(view.candidate);
  const partial = { ...reports[0], revision: view.revision, usedId: view.candidate.id, definition: view.candidate.definition,
    validated: false, measurement: { ...reports[0].measurement, status: 'partial', reason: 'coverage' } };
  await store.observe(accounts, account, partial);
  assert.equal(store.views(accounts)[0].active.id, active.id, 'a partial trial retains the working version');
  const selected = store.select(account);
  const reuse = new AssistantMailMethodLearning(accounts, [selected]), runtime = browserFixture();
  const prepared = await reuse.run(runtime, account);
  assert.equal(prepared.areas[0], 'inbox');
  assert.equal(runtime.calls.at(-1), 'inbox', 'only the final current inbox refs are returned');
  const completed = await reuse.reports(runtime, checked, () => 3);
  assert.equal(completed[0].measurement.preparationCalls, 1);
  assert.equal(completed[0].validated, true);
  await store.observe(accounts, account, completed[0]);
  view = store.views(accounts)[0];
  assert.equal(view.active.id, selected.method.id);
  assert.equal(view.candidate, undefined);
  await assert.rejects(store.observe(accounts, account, reports[0]), /ändrats/);
  assert.equal(store.views(accounts)[0].active.id, selected.method.id);
  const changed = { ...account, url: 'https://mail.zoho.eu/zm/changed' };
  assert.equal(store.select(changed).method, undefined, 'a changed account binding cannot reuse old methods');

  const broken = browserFixture();
  broken.open = async (_account, url) => url === 'custom'
    ? { accountId: account.id, tabId: 1, status: 'failed', code: 'folder-loading' }
    : { accountId: account.id, tabId: 1, view: 'list', areas: ['inbox'] };
  // Even if the ordinary browser says all folders were read, this trial must read its own folders.
  broken.pendingMailFolders = () => [];
  await assert.rejects(runAssistantMailMethod(broken, account, alternate), /kunde inte verifiera/);
  const wrong = browserFixture(); wrong.open = async () => ({ accountId: 'different', tabId: 1, view: 'list', areas: ['inbox'] });
  await assert.rejects(runAssistantMailMethod(wrong, account, alternate), /kunde inte verifiera/);
  const disabled = new AssistantMailMethodLearning(accounts, [store.select(account)]);
  disabled.disable();
  await assert.rejects(disabled.run(browserFixture(), account), /externt steg/);
  const fallbackSelection = store.select(account);
  fallbackSelection.method = { ...fallbackSelection.active, id: '11111111-1111-4111-8111-111111111111' };
  const fallback = new AssistantMailMethodLearning(accounts, [fallbackSelection]), fallbackBrowser = browserFixture();
  const open = fallbackBrowser.open; let attempts = 0;
  fallbackBrowser.open = async (...args) => ++attempts === 1 ? { accountId: account.id, status: 'failed', code: 'temporary' } : open(...args);
  const recovered = await fallback.run(fallbackBrowser, account);
  assert.equal(recovered.mailMethod.id, fallbackSelection.active.id, 'failed candidate executes actual active fallback');
  assert.equal(recovered.mailMethod.candidateFailed, true);
  assert.equal((await fallback.reports(fallbackBrowser, checked, () => 1))[0].validated, false, 'fallback success cannot promote failed candidate');
  await store.edit(accounts, account, store.views(accounts)[0].revision, alternate);
  const pending = store.views(accounts)[0].candidate.id;
  let baseline = store.select(account, true);
  await store.observe(accounts, account, { accountId: account.id, fingerprint: baseline.fingerprint, revision: baseline.revision,
    definition: alternate, validated: false, measurement: { at: new Date().toISOString(), status: 'partial', mode: 'learning', preparationCalls: 1, preparationMs: 1, folders: 1, reviewedThreads: 0 } });
  assert.equal(store.views(accounts)[0].candidate.id, pending, 'incomplete relearning retains the pending edit');
  baseline = store.select(account, true);
  const freshLearning = new AssistantMailMethodLearning(accounts, [baseline]);
  freshLearning.observe('browser_open', { accountId: account.id, view: 'list', areas: ['inbox'] }, 1);
  freshLearning.observe('browser_read', { accountId: account.id, view: 'list', areas: ['sent'] }, 1);
  await store.observe(accounts, account, (await freshLearning.reports(browserFixture(), checked, () => 1))[0]);
  assert.equal(store.views(accounts)[0].candidate, undefined, 'explicit successful relearning replaces the prior pending edit');
  assert.notEqual(store.views(accounts)[0].active.id, fallbackSelection.active.id);
  const bytes = readFileSync(join(directory, 'mail-methods.json'));
  await assert.rejects(store.edit(accounts, account, view.revision, { steps: ['read-incoming'], expandThreads: false }));
  assert.deepEqual(readFileSync(join(directory, 'mail-methods.json')), bytes);
  writeFileSync(join(directory, 'mail-methods.json'), '{invalid');
  assert.throws(() => store.views(accounts), /invalid JSON/);
  await assert.rejects(store.edit(accounts, account, 0, alternate), /invalid JSON/);
  assert.equal(readFileSync(join(directory, 'mail-methods.json'), 'utf8'), '{invalid');
  console.log('Mail methods: actual learned order, guarded replay, isolated folder validation, privacy, revision races, retained fallback and restart passed');
} finally { rmSync(directory, { recursive: true, force: true }); stopWatchdog(); }
