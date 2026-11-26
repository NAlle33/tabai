import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

// Repeated controller restarts over large saved state run about 12 s.
const stopWatchdog = watchdog(async () => { for (const app of apps) await app.controller.close(); rmSync(dir, { recursive: true, force: true }); }, 120_000);
const dir = mkdtempSync(join(tmpdir(), 'tabai-assistant-workspace-features-')), apps = [];
try {
  await build({ stdin: { contents: 'export { AssistantController } from "./src/assistant-controller"; export { RecipeStore } from "./src/recipe-store"; export { assistantItemSchema, assistantWorkspaceSchema } from "./shared/assistant"; export { moduleViewSchema } from "./shared/personal-modules";', resolveDir: process.cwd(), sourcefile: 'assistant-workspace-test.ts' }, outfile: join(dir, 'controller.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { AssistantController, RecipeStore, assistantItemSchema, assistantWorkspaceSchema, moduleViewSchema } = await import(pathToFileURL(join(dir, 'controller.mjs')));
  const first = { id: 'first-test', provider: 'gmail', label: 'Första testkontot', email: 'first@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true };
  const second = { id: 'second-test', provider: 'outlook', label: 'Andra testkontot', email: 'second@example.test', url: 'https://outlook.live.com/mail/0/', enabled: true };
  const finding = (account, suffix, overrides = {}) => ({ accountId: account.id, threadId: `shared-thread-${suffix}`, messageId: `test-message-${suffix}`, kind: 'reply', title: 'Gemensamt testämne', summary: 'Ett testbesked behövs.', reason: 'Ett testmeddelande ber om svar.', priority: 2,
    sourceUrl: account.url + (account.provider === 'gmail' ? `#inbox/abcdefghijklmnop${suffix}` : `id/test-message-${suffix}`), recipient: 'sender@example.test', draft: 'Tack för ditt testmeddelande.', sources: [{ observationId: `observation-${suffix}`, quote: 'Kan du bekräfta testbeskedet?' }], ...overrides });
  const stored = app => JSON.parse(readFileSync(join(app.path, 'workspace.json'), 'utf8')).state;
  const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
  function deferred() { let resolvePromise; const promise = new Promise(resolve => { resolvePromise = resolve; }); return { promise, resolve: resolvePromise }; }
  const terminalCallbacks = callbacks => ({ ...callbacks,
    async finish(result) { await callbacks.finish(result); await callbacks.settled?.(); },
    async help(help) { await callbacks.help(help); await callbacks.settled?.(); },
    async exit(...args) { await callbacks.exit(...args); await callbacks.settled?.(); },
  });
  function create(path = join(dir, `state-${apps.length}`)) {
    const executor = {
      starts: [], tests: [], stopped: 0, shownTests: [],
      async start(context, callbacks) { callbacks = terminalCallbacks(callbacks); this.starts.push({ context, callbacks }); this.context = context; this.callbacks = callbacks; },
      async open(account, url, windowId) { this.opened = { account, url, windowId }; }, async showAccountTest(accountId) { this.shownTests.push(accountId); },
      testAccount(account, windowId, initial, progress) { const completion = deferred(); const test = { account, windowId, initial, progress, ...completion }; this.tests.push(test); return completion.promise; },
      async stop() { this.stopped++; },
      async close() { for (const test of this.tests) test.resolve({ ...test.initial, status: 'interrupted' }); },
    };
    const controller = new AssistantController(process.cwd(), path, executor);
    const app = { controller, executor, path, request: (operation, input = {}) => controller.request(operation, input) };
    apps.push(app); return app;
  }
  async function configure(app, accounts = [first, second], changes = {}) {
    const workspace = (await app.request('status')).assistant;
    return app.request('correct', { action: 'settings', revision: String(workspace.revision), settings: JSON.stringify({ ...workspace.settings, accounts, timezone: 'Europe/Stockholm', ...changes }) });
  }
  async function finishActiveAccount(app, findings, resolutions = []) {
    const activeAccounts = app.executor.context.settings.accounts.filter(account => account.enabled);
    assert.equal(activeAccounts.length, 1, 'each mail executor context contains exactly one active account');
    const accountId = app.executor.context.run.accountId ?? activeAccounts[0].id;
    const result = {
      summary: 'Syntetiskt testunderlag.',
      findings: findings.filter(entry => entry.accountId === accountId),
      coverage: [{ accountId, status: 'checked', message: 'Testunderlaget kontrollerat.' }],
    };
    const accountResolutions = resolutions.filter(entry => entry.accountId === accountId);
    if (accountResolutions.length) result.resolutions = accountResolutions;
    await app.executor.callbacks.finish(result);
  }
  async function scan(app, findings) {
    await app.request('start', { task: 'check-mail' });
    for (let count = 0; count < 12; count++) {
      await finishActiveAccount(app, findings);
      if ((await app.request('status')).assistant.current.status !== 'running') break;
    }
    return (await app.request('status')).assistant;
  }
  async function createCase(app, fields = {}) {
    await app.request('correct', { action: 'case-create', title: 'Ett samlat testärende', ...fields });
    return stored(app).workspace.cases.at(-1);
  }
  async function changeCase(app, caseId, fields) {
    const current = stored(app).workspace.cases.find(entry => entry.id === caseId);
    await app.request('correct', { action: 'case-update', caseId, revision: String(current.revision), ...fields });
    return stored(app).workspace.cases.find(entry => entry.id === caseId);
  }
  async function linkCase(app, caseId, link) { return changeCase(app, caseId, { action: 'case-link', link: JSON.stringify(link) }); }
  function report(test, statuses, status = 'running') {
    return { ...structuredClone(test.initial), updatedAt: new Date().toISOString(), status, tabId: 17,
      steps: test.initial.steps.map((step, index) => ({ key: step.key, status: statuses[index], message: 'Syntetisk teststatus.' })) };
  }
  async function finishTest(app, test, result) {
    await test.progress(result); test.resolve(result); await tick();
    return (await app.request('status')).assistant;
  }

  const cases = create(); await configure(cases);
  let workspace = await scan(cases, [finding(first, 'same'), finding(second, 'same')]);
  assert.equal(workspace.items.length, 2, 'equal subjects and provider-local thread identifiers remain distinct across accounts');
  const firstItem = workspace.items.find(item => item.accountId === first.id), secondItem = workspace.items.find(item => item.accountId === second.id);
  let entry = await createCase(cases, { title: 'Testfaktura och besked', status: 'waiting', nextAction: 'Kontrollera betalningen manuellt.', waitingFor: 'Ett bekräftat betalningsunderlag', deadline: '2026-12-15' });
  assert.deepEqual(entry.links, [], 'creating a case never guesses relationships from subjects');
  entry = await linkCase(cases, entry.id, { kind: 'item', itemId: firstItem.id });
  assert.deepEqual(entry.links, [{ kind: 'item', itemId: firstItem.id }], 'one selected account source does not implicitly link the other account');
  entry = await linkCase(cases, entry.id, { kind: 'item', itemId: secondItem.id });
  entry = await linkCase(cases, entry.id, { kind: 'module', moduleId: 'invoice-test', runId: 'invoice-run-test', label: 'Faktura skickad' });
  entry = await linkCase(cases, entry.id, { kind: 'url', url: 'https://billing.example.test/invoice/test', label: 'Fakturaunderlag' });
  const staleRevision = entry.revision - 1, committedCase = structuredClone(entry);
  await assert.rejects(cases.request('correct', { action: 'case-delete', caseId: entry.id, revision: String(staleRevision) }), /ändrats/);
  assert.deepEqual(stored(cases).workspace.cases[0], committedCase, 'a stale destructive write leaves the persisted case intact');
  for (const itemId of [firstItem.id, secondItem.id]) {
    const item = (await cases.request('status')).assistant.items.find(item => item.id === itemId);
    await cases.request('correct', { action: 'send', itemId: item.id, revision: String(item.revision), recipient: item.recipient, body: item.draft });
    await cases.executor.callbacks.sendIntent();
    await assert.rejects(changeCase(cases, entry.id, { status: 'completed' }), /pågående eller osäkert utskick/);
    await cases.executor.callbacks.sent('Syntetisk testbekräftelse.');
  }
  workspace = (await cases.request('status')).assistant;
  assert.deepEqual(workspace.caseItems.map(item => item.status), ['sent', 'sent']);
  assert.equal(workspace.cases[0].status, 'waiting', 'both sent messages preserve the user-controlled aggregate case status');
  assert.equal(workspace.cases[0].nextAction, 'Kontrollera betalningen manuellt.');
  assert.deepEqual(workspace.cases[0].links, committedCase.links, 'invoice references are not payment confirmations');
  assert.equal(Object.keys(workspace.cases[0]).some(key => /paid|payment|invoiceStatus/i.test(key)), false);
  const caseBeforeRestart = stored(cases).workspace.cases;
  await cases.controller.close();
  const reopenedCases = create(cases.path);
  workspace = (await reopenedCases.request('status')).assistant;
  assert.deepEqual(workspace.cases, caseBeforeRestart, 'case contents, explicit links, revisions and manual status survive restart');
  assert.deepEqual(workspace.caseItems.map(item => item.status), ['sent', 'sent']);

  const paged = create(); await configure(paged);
  workspace = await scan(paged, Array.from({ length: 25 }, (_, index) => finding(index % 2 ? first : second, `page-${index}`, { kind: index === 24 ? 'meeting' : 'reply' })));
  const linkedFirst = workspace.items[0], linkedLast = workspace.items.at(-1);
  const pagedCase = await createCase(paged, { title: 'Underlag från flera punktsidor' });
  await linkCase(paged, pagedCase.id, { kind: 'item', itemId: linkedFirst.id });
  await linkCase(paged, pagedCase.id, { kind: 'item', itemId: linkedLast.id });
  workspace = (await paged.request('history', { offset: '10' })).assistant;
  assert.equal(workspace.itemPage.offset, 10);
  assert.equal(workspace.items.some(item => item.id === linkedFirst.id || item.id === linkedLast.id), false);
  assert.deepEqual(new Set(workspace.caseItems.map(item => item.id)), new Set([linkedFirst.id, linkedLast.id]), 'case metadata includes linked items beyond the currently displayed item page');
  for (const item of workspace.caseItems) {
    assert.equal(item.status, 'open');
    assert.ok(item.sourceUrl);
    assert.equal(Object.hasOwn(item, 'draft'), false);
    assert.equal(Object.hasOwn(item, 'summary'), false);
    assert.equal(Object.hasOwn(item, 'sources'), false, 'compact link metadata does not copy full source evidence');
  }
  for (let index = 1; index < 10; index++) await createCase(paged, { title: `Sparat testärende ${index}` });
  workspace = (await paged.request('correct', { action: 'case-create', title: 'Det elfte ärendet ska synas direkt' })).assistant;
  const eleventh = stored(paged).workspace.cases.at(-1);
  assert.equal(workspace.casePage.total, 11);
  assert.ok(workspace.cases.some(entry => entry.id === eleventh.id), 'creating case eleven returns a page containing the new case immediately');
  assert.equal(workspace.cases.find(entry => entry.id === eleventh.id).title, 'Det elfte ärendet ska synas direkt');
  await createCase(paged, { title: 'Sparat testärende 12' });
  workspace = (await paged.request('history', { caseOffset: '0' })).assistant;
  assert.equal(workspace.cases.length, 10);
  assert.deepEqual(workspace.casePage, { offset: 0, total: 12, nextOffset: 10 });
  workspace = (await paged.request('history', { caseOffset: '10' })).assistant;
  assert.equal(workspace.cases.length, 2);
  assert.deepEqual(workspace.casePage, { offset: 10, total: 12 });
  assert.equal(workspace.itemPage.offset, 10, 'case navigation preserves independent item pagination');
  assert.equal(stored(paged).workspace.cases.length, 12, 'view pagination never truncates private case storage');
  const bulky = await createCase(paged, { title: 'Stort underlag' });
  const bulkyLink = index => ({ kind: 'url', url: `https://example.test/${index}/${'a'.repeat(1800)}`, label: '語'.repeat(300) });
  // Three near-limit cases exceed the case transport budget without filling private storage.
  for (const caseId of [bulky.id, (await createCase(paged, { title: 'Stort underlag två' })).id, (await createCase(paged, { title: 'Stort underlag tre' })).id]) {
    for (let index = 0; index < 45; index++) await linkCase(paged, caseId, bulkyLink(index));
  }
  workspace = (await paged.request('history', { caseOffset: '12', offset: '0' })).assistant;
  assert.ok(workspace.cases.length < 3, 'case pages shrink to respect the case byte budget');
  assert.ok(Buffer.byteLength(JSON.stringify(workspace.cases)) <= 250_000);
  assert.equal(stored(paged).workspace.cases.length, 15);

  const archival = create(); await configure(archival);
  workspace = await scan(archival, [finding(first, 'archive-dismissed'), finding(second, 'archive-resolved')]);
  const dismissed = workspace.items.find(item => item.accountId === first.id), resolved = workspace.items.find(item => item.accountId === second.id);
  const archivedCase = await createCase(archival, { title: 'Behåll underlag när färdiga punkter arkiveras' });
  await linkCase(archival, archivedCase.id, { kind: 'item', itemId: dismissed.id });
  await linkCase(archival, archivedCase.id, { kind: 'item', itemId: resolved.id });
  await archival.request('correct', { action: 'dismiss', itemId: dismissed.id, revision: String(dismissed.revision) });
  await archival.request('start', { task: 'check-mail' });
  const laterResolution = { itemId: resolved.id, revision: resolved.revision, accountId: resolved.accountId, threadId: resolved.threadId, messageId: 'later-archive-test-message', sourceUrl: resolved.sourceUrl,
    reason: 'Ett verifierat senare testsvar finns.', sources: [{ observationId: 'later-archive-observation', quote: 'Det senare testbeskedet är bekräftat.' }] };
  for (let count = 0; count < 2; count++) await finishActiveAccount(archival, [], [laterResolution]);
  // Normal upserts archive finished points only when active item capacity is reached.
  await scan(archival, Array.from({ length: 60 }, (_, index) => finding(first, `archive-fill-first-${index}`)));
  await scan(archival, Array.from({ length: 38 }, (_, index) => finding(second, `archive-fill-second-${index}`)));
  assert.equal(stored(archival).workspace.items.length, 100);
  await scan(archival, [finding(first, 'archive-replacement-one'), finding(second, 'archive-replacement-two')]);
  const expectedArchived = new Map([[dismissed.id, { item: dismissed, status: 'dismissed' }], [resolved.id, { item: resolved, status: 'resolved' }]]);
  async function verifyArchivedSources(app) {
    const current = (await app.request('status')).assistant;
    for (const [id, expected] of expectedArchived) {
      assert.equal(stored(app).workspace.items.some(item => item.id === id), false, 'normal capacity eviction moved the finished point out of active items');
      assert.equal(JSON.parse(readFileSync(join(app.path, 'archive', `${id}.json`), 'utf8')).item.status, expected.status);
      const metadata = current.caseItems.find(item => item.id === id);
      assert.ok(metadata, 'a case retains compact status metadata for an archived linked item');
      assert.equal(metadata.status, expected.status);
      assert.equal(metadata.accountId, expected.item.accountId);
      assert.equal(metadata.sourceUrl, expected.item.sourceUrl);
      assert.equal(Object.hasOwn(metadata, 'sources'), false);
      await app.request('open', { itemId: id, windowId: '42' });
      assert.equal(app.executor.opened.account.id, expected.item.accountId);
      assert.equal(app.executor.opened.url, expected.item.sourceUrl, 'opening an archived case link dispatches its original source');
      assert.equal(app.executor.opened.windowId, 42);
    }
    await assert.rejects(app.request('open', { itemId: '../workspace' }), /Underlaget finns inte/);
    assert.equal(stored(app).workspace.cases.find(entry => entry.id === archivedCase.id).links.length, 2);
  }
  await verifyArchivedSources(archival);
  await archival.controller.close();
  const restartedArchive = create(archival.path);
  await verifyArchivedSources(restartedArchive);

  const diagnostics = create(); await configure(diagnostics, [first, { ...second, enabled: false }]);
  workspace = await scan(diagnostics, [finding(first, 'self-test')]);
  const beforeTest = structuredClone({ lastChecks: workspace.lastChecks, current: workspace.current, history: workspace.history, items: workspace.items });
  const ordinaryStarts = diagnostics.executor.starts.length;
  workspace = (await diagnostics.request('correct', { action: 'test-account', accountId: second.id, windowId: '42' })).assistant;
  const test = diagnostics.executor.tests[0];
  assert.ok(test, 'the asynchronous account-test executor was dispatched');
  assert.equal(test.account.enabled, false, 'a saved disabled account can still be explicitly tested');
  assert.equal(test.windowId, 42);
  assert.equal(workspace.accountTests[0].status, 'running');
  assert.deepEqual(workspace.accountTests[0].steps.map(step => step.status), ['pending', 'pending', 'pending', 'pending']);
  assert.equal(stored(diagnostics).workspace.accountTests[0].id, test.initial.id, 'the initial test is persisted before executor work');
  const firstProgress = report(test, ['running', 'pending', 'pending', 'pending']);
  const secondProgress = report(test, ['passed', 'running', 'pending', 'pending']);
  await Promise.all([test.progress(firstProgress), test.progress(secondProgress)]);
  assert.deepEqual(stored(diagnostics).workspace.accountTests[0].steps.map(step => step.status), ['passed', 'running', 'pending', 'pending'], 'concurrent progress writes serialize in submission order');
  await assert.rejects(configure(diagnostics, [first, second]), /självtest/);
  await assert.rejects(diagnostics.request('start', { task: 'check-mail' }), /självtest/);
  await assert.rejects(diagnostics.request('correct', { action: 'test-account', accountId: first.id }), /pågående arbete/);
  const sendItem = (await diagnostics.request('status')).assistant.items[0];
  await assert.rejects(diagnostics.request('correct', { action: 'send', itemId: sendItem.id, revision: String(sendItem.revision), recipient: sendItem.recipient, body: 'Detta får inte godkännas under testet.' }), /självtest/);
  assert.equal(stored(diagnostics).sendAttempt, undefined, 'a blocked send never persists an approval');
  assert.deepEqual((await diagnostics.request('status')).assistant.items, beforeTest.items, 'a blocked send restores the original draft/revision');
  await diagnostics.request('open', { testAccountId: second.id });
  assert.deepEqual(diagnostics.executor.shownTests, [second.id]);

  const crashPath = join(dir, 'crash-copy'); mkdirSync(crashPath, { mode: 0o700 });
  writeFileSync(join(crashPath, 'workspace.json'), readFileSync(join(diagnostics.path, 'workspace.json')), { mode: 0o600 });
  const restartedTest = create(crashPath);
  const repaired = (await restartedTest.request('status')).assistant.accountTests[0];
  assert.equal(repaired.id, test.initial.id);
  assert.equal(repaired.status, 'interrupted');
  assert.deepEqual(repaired.steps.map(step => step.status), ['passed', 'skipped', 'skipped', 'skipped']);
  assert.equal(stored(restartedTest).workspace.accountTests[0].status, 'interrupted', 'restart repair is durably saved');
  assert.equal(restartedTest.executor.tests.length, 0, 'restart does not replay the interrupted test');

  const finished = report(test, ['passed', 'passed', 'passed', 'passed'], 'passed');
  workspace = await finishTest(diagnostics, test, finished);
  assert.equal(workspace.accountTests[0].status, 'passed');
  assert.deepEqual(workspace.lastChecks, beforeTest.lastChecks);
  assert.deepEqual(workspace.current, beforeTest.current, 'self-tests do not alter the current scan or its coverage');
  assert.deepEqual(workspace.history, beforeTest.history);
  assert.equal(diagnostics.executor.starts.length, ordinaryStarts, 'self-tests do not dispatch the model executor');
  assert.equal(stored(diagnostics).sendAttempt, undefined);

  await diagnostics.request('correct', { action: 'test-account', accountId: first.id });
  const stoppedTest = diagnostics.executor.tests.at(-1);
  await stoppedTest.progress(report(stoppedTest, ['passed', 'running', 'pending', 'pending']));
  await diagnostics.request('stop');
  let interrupted = (await diagnostics.request('status')).assistant.accountTests.find(entry => entry.id === stoppedTest.initial.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.steps.map(step => step.status), ['passed', 'skipped', 'skipped', 'skipped']);
  const interruptedSnapshot = structuredClone(interrupted);
  await stoppedTest.progress(report(stoppedTest, ['passed', 'passed', 'passed', 'passed'], 'passed'));
  interrupted = (await diagnostics.request('status')).assistant.accountTests.find(entry => entry.id === stoppedTest.initial.id);
  assert.deepEqual(interrupted, interruptedSnapshot, 'a late callback cannot overwrite the stopped test result');
  stoppedTest.resolve(report(stoppedTest, ['passed', 'passed', 'passed', 'passed'], 'passed')); await tick();
  assert.deepEqual(stored(diagnostics).workspace.accountTests.find(entry => entry.id === stoppedTest.initial.id), interruptedSnapshot, 'a late executor return cannot overwrite interruption');
  await diagnostics.request('correct', { action: 'test-account', accountId: first.id });
  const replacement = diagnostics.executor.tests.at(-1);
  await stoppedTest.progress(report(stoppedTest, ['passed', 'passed', 'passed', 'passed'], 'passed'));
  assert.equal((await diagnostics.request('status')).assistant.accountTests.find(entry => entry.accountId === first.id).id, replacement.initial.id, 'an old report cannot replace a newer test for the same account');
  await finishTest(diagnostics, replacement, report(replacement, ['passed', 'passed', 'passed', 'passed'], 'passed'));
  assert.ok(diagnostics.executor.stopped >= 1);

  const seedBase = structuredClone(stored(restartedArchive));
  delete seedBase.sendAttempt;
  delete seedBase.workspace.current;
  delete seedBase.workspace.accountTests;
  seedBase.workspace.items = []; seedBase.workspace.history = []; seedBase.workspace.cases = []; seedBase.workspace.shortcuts = []; seedBase.workspace.lastChecks = {};
  async function seed(path, state) {
    await new RecipeStore(join(path, 'workspace.json'), value => ({ ...value, workspace: assistantWorkspaceSchema.parse(value.workspace) })).save('state', state);
  }
  const seededItem = (id, status, account = first, overrides = {}) => assistantItemSchema.parse({ ...finding(account, id, overrides), id, revision: 1, status, updatedAt: new Date().toISOString() });
  const seededCase = (title, itemIds) => ({ id: randomUUID(), revision: 0, title, description: '', status: 'open', nextAction: '', waitingFor: '',
    links: itemIds.map(itemId => ({ kind: 'item', itemId })), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const transportPath = join(dir, 'transport-seed'), transportState = structuredClone(seedBase);
  const archivedPreviewItems = Array.from({ length: 100 }, (_, index) => seededItem(`archived-preview-${index}`, 'dismissed'));
  const activePreviewItem = seededItem('active-preview-item', 'open', second);
  transportState.workspace.items = [activePreviewItem];
  transportState.workspace.cases = [seededCase('Hundra äldre underlag', archivedPreviewItems.map(item => item.id)), seededCase('Ett nytt underlag', [activePreviewItem.id])];
  transportState.workspace.accountTests = [{ id: randomUUID(), accountId: first.id, status: 'passed', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    steps: ['identity', 'inbox', 'thread', 'sent'].map(key => ({ key, status: 'passed', message: '語'.repeat(2000) })) }];
  await seed(transportPath, transportState);
  for (const item of archivedPreviewItems) await new RecipeStore(join(transportPath, 'archive', `${item.id}.json`), value => assistantItemSchema.parse(value)).save('item', item);
  const transport = create(transportPath);
  const boundedView = await transport.request('status');
  assert.doesNotThrow(() => moduleViewSchema.parse(boundedView), 'the complete bounded view satisfies its transport schema');
  assert.equal(boundedView.assistant.caseItems.length, 100, 'previews remain bounded across active and archived linked sources');
  assert.equal(boundedView.assistant.caseItems.some(item => item.id === activePreviewItem.id), false, 'a source beyond the preview cap may omit preview metadata');
  assert.equal(stored(transport).workspace.cases.flatMap(entry => entry.links).length, 101, 'capping previews retains every private case link');
  await transport.request('open', { itemId: activePreviewItem.id, windowId: '42' });
  assert.equal(transport.executor.opened.url, activePreviewItem.sourceUrl, 'a source omitted from case previews remains openable through the controller');
  await transport.request('open', { itemId: archivedPreviewItems[99].id });
  assert.equal(transport.executor.opened.url, archivedPreviewItems[99].sourceUrl);
  assert.ok(boundedView.assistant.accountTests[0].steps.every(step => step.message.length === 300), 'diagnostic display text is clamped to 300 characters');
  assert.ok(stored(transport).workspace.accountTests[0].steps.every(step => step.message.length === 2000), 'display clamping preserves the full private diagnostic record');
  assert.ok(Buffer.byteLength(JSON.stringify(boundedView)) < 1_800_000);

  const capacityPath = join(dir, 'capacity-seed'), capacityState = structuredClone(seedBase);
  // Escaped characters are valid stored text; their JSON byte cost exceeds character count.
  const capacityItem = seededItem('capacity-item', 'open', first, { draft: '\u0000'.repeat(10500) });
  capacityState.workspace.items = [capacityItem];
  capacityState.workspace.cases = [seededCase('Behåll det sparade underlaget', [capacityItem.id])];
  capacityState.workspace.shortcuts = Array.from({ length: 24 }, (_, index) => ({ id: `capacity-shortcut-${index}`, label: `Testgenväg ${index}`, instructions: '\u0000'.repeat(12000) }));
  await seed(capacityPath, capacityState);
  const capacity = create(capacityPath);
  const capacityBefore = await capacity.request('status'), savedBefore = readFileSync(join(capacityPath, 'workspace.json'));
  assert.doesNotThrow(() => moduleViewSchema.parse(capacityBefore));
  const beforeBytes = Buffer.byteLength(JSON.stringify(capacityBefore));
  assert.ok(beforeBytes > 1_750_000 && beforeBytes < 1_800_000, 'fixture exercises a valid view close to the complete-frame capacity');
  await assert.rejects(capacity.request('correct', { action: 'draft', itemId: capacityItem.id, revision: String(capacityItem.revision), body: '\u0000'.repeat(12000) }), /Panelens underlag är för stort.*Inga sparade uppgifter kastades bort/);
  assert.equal(readFileSync(join(capacityPath, 'workspace.json')).equals(savedBefore), true, 'an oversized frame is rejected before replacement of committed private state');
  const capacityAfter = await capacity.request('status');
  assert.equal(isDeepStrictEqual(JSON.parse(JSON.stringify(capacityAfter)), JSON.parse(JSON.stringify(capacityBefore))), true, 'failed transport-capacity writes roll back the complete serialized view without losing records');
  assert.doesNotThrow(() => moduleViewSchema.parse(capacityAfter));
  assert.ok(Buffer.byteLength(JSON.stringify(capacityAfter)) < 1_800_000);
  console.log('Assistant workspace features: durable explicit cases, compact off-page metadata, bounded pages, independent status, persisted account tests, restart/stop repair and work/send exclusion passed');
} finally {
  for (const app of apps) await app.controller.close();
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
