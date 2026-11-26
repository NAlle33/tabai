import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const dir = mkdtempSync(join(tmpdir(), 'tabai-assistant-account-test-'));
try {
  const compiled = await build({ entryPoints: ['src/assistant-account-test.ts'], outfile: join(dir, 'account-test.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent', metafile: true });
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => path.includes('assistant-browser') || path.includes('@modelcontextprotocol')), false, 'the deterministic runner has no browser/SDK runtime dependency');
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { initialAssistantAccountTest: initial, runAssistantAccountTest: run } = await import(pathToFileURL(join(dir, 'account-test.mjs')));
  const fixedTime = '2026-11-01T09:00:00.000Z';
  const account = { id: 'test-account', provider: 'gmail', label: 'PRIVATE-ACCOUNT-LABEL', email: 'private-address@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true };
  const details = { tabId: 17, accountId: account.id, status: 'ready', view: 'detail', areas: ['inbox'], historyComplete: true, truncated: false, sourceId: 'PRIVATE-SOURCE-ID', messageId: 'PRIVATE-MESSAGE-ID', text: 'PRIVATE-BODY-TEXT', page: { text: 'PRIVATE-SUBJECT-TEXT private-address@example.test' } };
  const folder = area => ({ tabId: 17, accountId: account.id, status: 'ready', view: 'list', areas: [area], text: 'PRIVATE-LIST-TEXT' });
  class AssistantBrowserError extends Error {
    constructor(status, code) { super('PRIVATE-ERROR-TEXT private-address@example.test'); this.name = 'AssistantBrowserError'; this.status = status; this.code = code; }
  }
  function fixture(options = {}) {
    const calls = [], reports = [], readErrors = [...(options.readErrors ?? [])];
    const browser = {
      async open(value) { calls.push(['open', value.id]); if (options.openError) throw options.openError; return options.opened ?? folder('inbox'); },
      async mailboxFolder(value, area) { calls.push(['folder', area]); if (options[`${area}Error`]) throw options[`${area}Error`]; return options[area] ?? folder(area); },
      async firstMessageRef(tabId) { calls.push(['first-ref', tabId]); if (options.refError) throw options.refError; return Object.hasOwn(options, 'ref') ? options.ref : 'ref_17'; },
      async action(name, args) { calls.push([name, structuredClone(args)]); if (options[`${name}Error`]) throw options[`${name}Error`]; return name === 'browser_expand_thread' ? options.expanded ?? details : undefined; },
      async read(tabId) { calls.push(['read', tabId]); if (readErrors.length) throw readErrors.shift(); return options.detail ?? details; },
    };
    return { browser, calls, reports, execute: (onProgress = value => { reports.push(value); }) => run(browser, account, initial(account.id, fixedTime), onProgress) };
  }
  const count = (test, operation) => test.calls.filter(call => call[0] === operation).length;
  const states = result => result.steps.map(step => step.status);
  const start = initial(account.id, fixedTime);
  assert.match(start.id, /^[0-9a-f-]{36}$/);
  assert.equal(start.startedAt, fixedTime);
  assert.equal(start.updatedAt, fixedTime);
  assert.equal(start.status, 'running');
  assert.deepEqual(start.steps.map(step => step.key), ['identity', 'inbox', 'thread', 'sent']);
  assert.deepEqual(states(start), ['pending', 'pending', 'pending', 'pending']);
  assert.throws(() => initial('../account', fixedTime), /giltigt sparat konto/);
  assert.throws(() => initial(account.id, 'not-a-date'), /giltig starttid/);

  const complete = fixture();
  const before = structuredClone(start);
  let result = await run(complete.browser, account, start, report => complete.reports.push(report));
  assert.equal(result.id, start.id);
  assert.equal(result.startedAt, start.startedAt);
  assert.deepEqual(start, before, 'the initial report is never mutated');
  assert.equal(result.status, 'passed');
  assert.deepEqual(states(result), ['passed', 'passed', 'passed', 'passed']);
  assert.equal(result.tabId, 17);
  assert.deepEqual(complete.calls.map(call => call[0] === 'folder' ? `${call[0]}:${call[1]}` : call[0]), ['open', 'folder:inbox', 'first-ref', 'browser_click', 'read', 'folder:sent']);
  for (const key of ['identity', 'inbox', 'thread', 'sent']) {
    const running = complete.reports.findIndex(report => report.steps.find(step => step.key === key).status === 'running');
    const passed = complete.reports.findIndex(report => report.steps.find(step => step.key === key).status === 'passed');
    assert.ok(running >= 0 && passed > running, `${key} is reported running before its result`);
  }
  assert.ok(complete.reports[0].steps[0].status === 'running' && complete.reports[0].steps[1].status === 'pending', 'earlier progress snapshots stay immutable');
  assert.equal(complete.reports.at(-1).status, 'passed');
  for (const marker of ['PRIVATE-', account.email, account.label]) assert.equal(JSON.stringify([result, complete.reports]).includes(marker), false, 'reports retain only non-content capability metadata');

  for (const options of [
    { opened: { ...folder('inbox'), status: 'login', code: 'account-mismatch', message: 'PRIVATE-ERROR-TEXT' } },
    { openError: new AssistantBrowserError('login', 'account-mismatch') },
    { opened: { ...folder('inbox'), accountId: 'other-account' } },
    { opened: { ...folder('inbox'), status: 'unsupported', code: 'identity-unavailable' } },
  ]) {
    const mismatch = fixture(options); result = await mismatch.execute();
    assert.equal(result.status, 'failed');
    assert.deepEqual(states(result), ['failed', 'skipped', 'skipped', 'skipped']);
    assert.equal(mismatch.calls.length, 1, 'unverified identity blocks all later mailbox and thread operations');
  }
  const unknownLayout = fixture({ opened: { ...folder('inbox'), status: 'unsupported', view: 'unsupported' }, inbox: { ...folder('inbox'), status: 'unsupported', view: 'unsupported' }, sent: { ...folder('sent'), status: 'unsupported', view: 'unsupported' } });
  result = await unknownLayout.execute();
  assert.equal(result.status, 'partial');
  assert.deepEqual(states(result), ['passed', 'failed', 'skipped', 'failed'], 'unsupported layout without an identity code does not erase verified account identity');
  assert.equal(count(unknownLayout, 'folder'), 2, 'Sent is independently tested after Inbox fails');

  const empty = fixture({ inbox: { ...folder('inbox'), view: 'empty' }, sent: { ...folder('sent'), view: 'empty' } });
  result = await empty.execute();
  assert.equal(result.status, 'partial');
  assert.deepEqual(states(result), ['passed', 'passed', 'skipped', 'passed']);
  assert.match(result.steps[2].message, /tom/);
  assert.equal(count(empty, 'first-ref'), 0);
  assert.equal(count(empty, 'browser_click'), 0);
  const wrongSent = fixture({ sent: { ...folder('sent'), areas: ['inbox'] } });
  result = await wrongSent.execute();
  assert.equal(result.status, 'partial');
  assert.equal(result.steps[3].status, 'failed', 'a list does not prove the Sent folder unless its native area matches');
  const unsupportedSent = fixture({ sent: { ...folder('sent'), status: 'unsupported' } });
  result = await unsupportedSent.execute();
  assert.equal(result.steps[3].status, 'failed', 'an explicitly unsupported status cannot become a readable folder');

  for (const options of [
    { ref: undefined }, { ref: 'untrusted-subject-link' },
    { detail: { ...details, view: 'list' } },
    { detail: { ...details, messageId: undefined } },
    { detail: { ...details, sourceId: '' } },
    { detail: { ...details, historyComplete: false }, expanded: { ...details, historyComplete: false } },
    { detail: { ...details, truncated: true }, expanded: { ...details, truncated: true } },
  ]) {
    const incomplete = fixture(options); result = await incomplete.execute();
    assert.equal(result.status, 'partial');
    assert.equal(result.steps[2].status, 'failed');
    assert.equal(result.steps[3].status, 'passed', 'Sent remains independent after a thread failure');
    assert.equal(incomplete.calls.at(-1)[1], 'sent');
  }
  const expanded = fixture({ detail: { ...details, historyComplete: false } });
  result = await expanded.execute();
  assert.equal(result.status, 'passed');
  assert.equal(count(expanded, 'browser_expand_thread'), 1);
  assert.equal(count(expanded, 'browser_click'), 1);
  const changedAccount = fixture({ detail: { ...details, accountId: 'other-account', historyComplete: false } });
  result = await changedAccount.execute();
  assert.equal(result.steps[2].code, 'account-mismatch');
  assert.equal(count(changedAccount, 'browser_expand_thread'), 0, 'a mismatched reading cannot authorize expansion');
  const ambiguousClick = fixture({ browser_clickError: new AssistantBrowserError('failed', 'transport') });
  result = await ambiguousClick.execute();
  assert.equal(result.steps[2].status, 'failed');
  assert.equal(result.steps[2].code, 'transport');
  assert.equal(count(ambiguousClick, 'browser_click'), 1, 'an ambiguous click is never retried');
  assert.equal(count(ambiguousClick, 'read'), 0);
  assert.equal(result.steps[3].status, 'passed');
  const navigation = fixture({ readErrors: [new AssistantBrowserError('failed', 'navigation-changed')] });
  result = await navigation.execute();
  assert.equal(result.status, 'passed');
  assert.equal(count(navigation, 'read'), 2, 'one fresh read may settle a known navigation change');
  assert.equal(count(navigation, 'browser_click'), 1);
  const persistentNavigation = fixture({ readErrors: [new AssistantBrowserError('failed', 'navigation-changed'), new AssistantBrowserError('failed', 'navigation-changed')] });
  result = await persistentNavigation.execute();
  assert.equal(result.steps[2].status, 'failed');
  assert.equal(count(persistentNavigation, 'read'), 2, 'a changing page does not create a read loop');

  const persistenceError = new Error('fixture persistence failure');
  const beforeOpen = fixture();
  await assert.rejects(beforeOpen.execute(() => { throw persistenceError; }), error => error === persistenceError);
  assert.equal(beforeOpen.calls.length, 0, 'a failed progress save stops before the first browser operation');
  const beforeThread = fixture();
  await assert.rejects(beforeThread.execute(report => { if (report.steps[2].status === 'running') throw persistenceError; }), error => error === persistenceError);
  assert.equal(count(beforeThread, 'first-ref'), 0);
  assert.equal(beforeThread.calls.at(-1)[1], 'inbox', 'a failed progress save stops all later I/O, including Sent');
  const failedResultSave = fixture({ browser_clickError: new AssistantBrowserError('failed', 'transport') });
  await assert.rejects(failedResultSave.execute(report => { if (report.steps[2].status === 'failed') throw persistenceError; }), error => error === persistenceError);
  assert.equal(count(failedResultSave, 'folder'), 1, 'a failed error-result save also prevents independent Sent I/O');
  const mutatedProgress = fixture();
  result = await mutatedProgress.execute(report => { report.accountId = 'mutated'; report.steps[0].status = 'failed'; });
  assert.equal(result.accountId, account.id);
  assert.equal(result.status, 'passed', 'callbacks receive clones and cannot corrupt runner state');
  const invalidErrorCode = fixture({ openError: new AssistantBrowserError('failed', 'private-address@example.test') });
  result = await invalidErrorCode.execute();
  assert.equal(result.steps[0].code, 'browser-error');
  assert.equal(JSON.stringify(result).includes('private-address'), false);
  await assert.rejects(run(fixture().browser, account, { ...start, accountId: 'other-account' }, () => {}), /valda kontot/);
  assert.ok(complete.calls.every(call => !/send|fill|search/.test(call[0])), 'the runner performs only native reading/navigation actions');
  console.log('Assistant account test: deterministic identity/inbox/thread/Sent checks, independent failures, read bounds, content-free reports and persistence-first progress passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
