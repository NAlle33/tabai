import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AssistantController, assistantInboxStatus, assistantReminderAt, validateAssistantAccount } from '../dist/assistant-controller.mjs';
import { PersonalModules } from '../dist/personal-modules.mjs';
import { watchdog } from './watchdog.mjs';

// Controller restarts and real module processes run about 15 s.
const stopWatchdog = watchdog(async () => {
  modules.forEach(host => host.close());
  await Promise.all(controllers.map(controller => controller.close()));
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const dir of new Set(dirs)) rmSync(dir, { recursive: true, force: true });
}, 180_000);
const root = process.cwd(), dirs = [], controllers = [], modules = [];
const savedRun = app => JSON.parse(readFileSync(join(app.dir, 'workspace.json'), 'utf8')).state.workspace.current;
const terminalCallbacks = callbacks => ({ ...callbacks,
  async finish(result) { await callbacks.finish(result); await callbacks.settled?.(); },
  async help(help) { await callbacks.help(help); await callbacks.settled?.(); },
  async exit(...args) { await callbacks.exit(...args); await callbacks.settled?.(); },
});
function create(dir) {
  dir ??= mkdtempSync(join(tmpdir(), 'tabai-assistant-controller-')); dirs.push(dir);
  const executor = {
    starts: [], stopped: 0,
    async start(context, callbacks) { callbacks = terminalCallbacks(callbacks); this.starts.push({ context, callbacks }); this.context = context; this.callbacks = callbacks; this.onStart?.(context); },
    async stop() { this.stopped++; }, async close() {}, async open(account, url, windowId) { this.opened = { account, url, windowId }; },
    async showHelp(help, account, windowId) { this.shownHelp = { help, account, windowId }; return help; },
    async preflightHelp(help) { (this.preflights ??= []).push(help); if (this.helpReady === false) throw new Error('Mappvyn är inte redo.'); },
  };
  const controller = new AssistantController(root, dir, executor); controllers.push(controller);
  return { controller, executor, dir, request: (op, input = {}) => controller.request(op, input) };
}
const gmail = { id: 'gmail-test', label: 'Testkonto', provider: 'gmail', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/?authuser=owner%40example.test', enabled: true };
const outlook = { id: 'outlook-test', label: 'Andra kontot', provider: 'outlook', email: 'owner2@example.test', url: 'https://outlook.live.com/mail/0/', enabled: true };
const finding = (overrides = {}) => ({
  accountId: gmail.id, threadId: 'gmail:thread-123', kind: 'reply', title: 'Beslut om möte',
  summary: 'Ett besked behövs.', reason: 'Avsändaren ber om ett svar.', priority: 1,
  sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/abcdef1234567890', recipient: 'sender@example.test',
  draft: 'Tack! Jag återkommer med besked.', sources: [{ observationId: 'read-1', quote: 'Kan du ge besked om mötet?' }], ...overrides,
});
const coverage = (status = 'checked') => [{ accountId: gmail.id, status, message: status === 'checked' ? 'Kontrollerat.' : 'Logga in.' }];
async function configure(app, accounts = [gmail], extra = {}) {
  const current = (await app.request('status')).assistant;
  return app.request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, accounts, ...extra }) });
}
async function scan(app, findings = [finding()], covers = coverage()) {
  await app.request('start', { task: 'check-mail' });
  for (let count = 0; count < 12; count++) {
    const accountId = app.executor.context.run.accountId;
    await app.executor.callbacks.finish({ summary: 'Granska resultatet.', findings: accountId ? findings.filter(item => item.accountId === accountId) : findings,
      coverage: accountId ? covers.filter(item => item.accountId === accountId).length ? covers.filter(item => item.accountId === accountId) : [{ accountId, status: 'partial', message: 'Kontot saknar en avslutad kontroll.' }] : covers });
    if ((await app.request('status')).assistant.current.status !== 'running') break;
  }
  return (await app.request('status')).assistant;
}
try {
  {
    const app = create(); await configure(app);
    await app.request('start', { task: 'check-mail' });
    const originalBoundary = app.executor.context.run.scanStartedAt;
    const entry = { accountId: gmail.id, threadId: 'gmail:attachment-fixture', messageId: 'gmail:message:attachment-one', sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/attachment-fixture', reviewedAt: new Date().toISOString(), outcome: 'attachment-review' };
    const item = finding({ threadId: entry.threadId, messageId: entry.messageId, sourceUrl: entry.sourceUrl, kind: 'action', unreadAttachment: true, title: 'Granska mejl med oläst bilaga', summary: 'Bilagans innehåll är inte läst.', draft: undefined, recipient: undefined });
    const review = { accountId: entry.accountId, threadId: entry.threadId, messageId: entry.messageId, reviewedAt: entry.reviewedAt, outcome: entry.outcome, rows: [{ key: entry.threadId, version: entry.messageId }] };
    await app.executor.callbacks.checkpoint(entry, { summary: '', coverage: [], findings: [item] }, { review });
    await app.executor.callbacks.finish({ summary: 'Bilagan är flaggad; andra mejl återstår.', coverage: coverage('partial'), findings: [] });
    await app.controller.close();
    const recovered = create(app.dir);
    let view = (await recovered.request('status')).assistant;
    assert.equal(savedRun(recovered).checkpoints[0].outcome, 'attachment-review');
    assert.equal(view.items.find(item => item.threadId === entry.threadId).unreadAttachment, true);
    await recovered.request('resume');
    assert.equal(recovered.executor.context.run.scanStartedAt, originalBoundary, 'restart/resume retains the original logical scan boundary');
    assert(recovered.executor.context.reviews.some(review => review.outcome === 'attachment-review'), 'the explicit row outcome survives restart');
    await recovered.executor.callbacks.finish({ summary: 'Nästa genomgång.', coverage: coverage(), findings: [] });
    view = (await recovered.request('status')).assistant;
    assert.equal(view.items.find(item => item.threadId === entry.threadId).status, 'open', 'a later successful traversal never resolves the unread attachment');
    assert.equal(assistantInboxStatus(view.items.find(item => item.threadId === entry.threadId)), 'needs-you');
    view = await scan(recovered, []);
    assert.equal(view.items.find(item => item.threadId === entry.threadId).status, 'open', 'a fresh check also retains the unresolved unread action');
  }
  const zoho = { id: 'zoho-test', label: 'Tredje kontot', provider: 'zoho', email: 'third@example.test', url: 'https://mail.zoho.eu/zm/', enabled: true };
  const queued = create(); await configure(queued, [zoho, gmail, outlook]);
  await queued.request('start', { task: 'check-mail', windowId: '81' });
  assert.deepEqual(queued.executor.context.settings.accounts.map(account => account.id), [zoho.id]);
  const queuedStart = structuredClone(queued.executor.context.run), blockedCallbacks = queued.executor.callbacks;
  const blockedHelp = { accountId: zoho.id, code: 'browser', message: 'Visa den blockerade mappen.', sourceUrl: 'https://mail.zoho.eu/zm/#mail/folder/10000001', tabId: 17 };
  await blockedCallbacks.help(blockedHelp);
  assert.deepEqual(queued.executor.context.settings.accounts.map(account => account.id), [gmail.id], 'one blocked account cannot stop the readable accounts');
  assert.equal((await queued.request('status')).assistant.current.status, 'running');
  await blockedCallbacks.update('För sent.', { accountId: zoho.id, status: 'checked', message: 'Felaktigt.' });
  assert.equal((await queued.request('status')).assistant.current.coverage[0].status, 'partial', 'late callbacks cannot rewrite a completed account step');
  await queued.executor.callbacks.finish({ summary: 'Första läsbara kontot klart.', findings: [], coverage: coverage() });
  assert.deepEqual(queued.executor.context.settings.accounts.map(account => account.id), [outlook.id]);
  const savedCheckpoint = { accountId: outlook.id, threadId: 'saved-thread', messageId: 'saved-message', sourceUrl: 'https://outlook.live.com/mail/0/inbox/id/test', reviewedAt: new Date().toISOString(), outcome: 'no-action' };
  await queued.executor.callbacks.checkpoint(savedCheckpoint, { summary: '', findings: [], coverage: [] });
  await queued.executor.callbacks.finish({ summary: 'Andra läsbara kontot klart.', findings: [], coverage: [{ accountId: outlook.id, status: 'checked', message: 'Klart.' }] });
  let queuedView = (await queued.request('status')).assistant;
  assert.equal(queuedView.current.status, 'waiting');
  assert.deepEqual(queuedView.current.coverage.map(entry => entry.status), ['partial', 'checked', 'checked']);
  assert.deepEqual(queuedView.current.helps, [blockedHelp]);
  await queued.request('open', { helpAccountId: zoho.id, windowId: '81' });
  assert.deepEqual(queued.executor.shownHelp.help, blockedHelp, 'help opens its exact target, not the last Outlook tab');
  queued.executor.helpReady = false;
  const queuedStarts = queued.executor.starts.length;
  await queued.request('resume', { runId: queuedView.current.id, helpAccountId: zoho.id });
  assert.equal(queued.executor.starts.length, queuedStarts, 'failed help preflight starts no model');
  assert.equal((await queued.request('status')).assistant.current.status, 'waiting');
  queued.executor.helpReady = true;
  await queued.request('resume', { runId: queuedView.current.id, helpAccountId: zoho.id });
  assert.deepEqual(queued.executor.context.settings.accounts.map(account => account.id), [zoho.id]);
  queuedView = (await queued.request('status')).assistant;
  assert.equal(queuedView.current.scanStartedAt, queuedStart.scanStartedAt);
  assert.equal(queuedView.current.scanKey, queuedStart.scanKey);
  assert.deepEqual(savedRun(queued).checkpoints, [savedCheckpoint], 'resuming Zoho retains the completed Outlook assessment');
  assert.equal(queuedView.current.accountProgress.find(entry => entry.accountId === outlook.id).reviewedThreads, 1, 'public progress counts durable checkpoints without exposing their private source identities');
  await queued.executor.callbacks.finish({ summary: 'Sista kontot klart.', findings: [], coverage: [{ accountId: zoho.id, status: 'checked', message: 'Klart.' }] });
  assert((await queued.request('status')).assistant.current.coverage.every(entry => entry.status === 'checked'));
  const interruptedQueue = create(); await configure(interruptedQueue, [zoho, gmail, outlook]);
  await interruptedQueue.request('start', { task: 'check-mail' });
  const interruptedCallbacks = interruptedQueue.executor.callbacks;
  await assert.rejects(interruptedCallbacks.update('Fel konto.', { accountId: gmail.id, status: 'checked', message: 'Fel.' }), /annat kontosteg/);
  await interruptedQueue.request('stop');
  await interruptedCallbacks.finish({ summary: 'För sent.', findings: [], coverage: [{ accountId: zoho.id, status: 'checked', message: 'För sent.' }] });
  assert.equal(interruptedQueue.executor.starts.length, 1, 'stop fences both a terminal callback and its queue advance');
  const multipleHelp = create(); await configure(multipleHelp, [zoho, gmail, outlook]);
  await multipleHelp.request('start', { task: 'check-mail' });
  await multipleHelp.executor.callbacks.help(blockedHelp);
  const gmailHelp = { accountId: gmail.id, code: 'expand-thread', message: 'Öppna äldre meddelanden.', sourceUrl: finding().sourceUrl, tabId: 18 };
  await multipleHelp.executor.callbacks.help(gmailHelp);
  await multipleHelp.executor.callbacks.finish({ summary: 'Outlook klart.', findings: [], coverage: [{ accountId: outlook.id, status: 'checked', message: 'Klart.' }] });
  const multiRun = (await multipleHelp.request('status')).assistant.current;
  await multipleHelp.request('resume', { runId: multiRun.id, helpAccountId: gmail.id });
  assert.deepEqual(multipleHelp.executor.context.settings.accounts.map(account => account.id), [gmail.id], 'only the selected repaired account is resumed');
  assert.equal((await multipleHelp.request('status')).assistant.current.coverage[0].status, 'partial', 'another blocked account keeps its real coverage instead of reverting to pending');
  await multipleHelp.executor.callbacks.finish({ summary: 'Gmail klart.', findings: [], coverage: coverage() });
  const remainingHelp = (await multipleHelp.request('status')).assistant.current;
  assert.equal(remainingHelp.status, 'waiting'); assert.equal(remainingHelp.help.accountId, zoho.id); assert.equal(remainingHelp.helps.length, 1);
  await multipleHelp.request('resume', { runId: remainingHelp.id, helpAccountId: zoho.id });
  assert.equal(multipleHelp.executor.context.run.scanId, multiRun.scanId, 'the scan identity survives more than one help continuation');
  await multipleHelp.executor.callbacks.finish({ summary: 'Zoho klart.', findings: [], coverage: [{ accountId: zoho.id, status: 'checked', message: 'Klart.' }] });
  assert((await multipleHelp.request('status')).assistant.current.coverage.every(entry => entry.status === 'checked'));
  const archivedHelp = create(); await configure(archivedHelp);
  await archivedHelp.request('start', { task: 'check-mail' });
  await archivedHelp.executor.callbacks.help(gmailHelp);
  const archivedId = (await archivedHelp.request('status')).assistant.current.id;
  await archivedHelp.request('start', { task: 'custom', instructions: 'En annan syntetisk kontroll.' });
  await archivedHelp.executor.callbacks.finish({ summary: 'Klart.', findings: [], coverage: coverage() });
  archivedHelp.executor.helpReady = false;
  await archivedHelp.request('resume', { runId: archivedId });
  assert.equal((await archivedHelp.request('status')).assistant.current.id, archivedId, 'failed archived preflight selects the full saved run so its help remains actionable');
  await archivedHelp.request('open', { helpAccountId: gmail.id });
  assert.equal(archivedHelp.executor.shownHelp.help.tabId, gmailHelp.tabId);
  archivedHelp.executor.helpReady = true;
  await archivedHelp.request('resume', { runId: archivedId });
  assert.equal(archivedHelp.executor.context.run.resumedFrom, archivedId);
  await archivedHelp.request('stop');

  const effectsRun = create(); await configure(effectsRun, [gmail], { web: { fullAccess: true, level: 'off', login: false } });
  await effectsRun.request('start', { task: 'custom', instructions: 'Utför ett syntetiskt steg och läs sedan resultatet.' });
  const effectId = effectsRun.executor.context.run.id, effectFile = join(effectsRun.dir, 'workspace.json');
  assert.equal(effectsRun.executor.context.run.externalEffect, 'none');
  const saveEffect = effectsRun.controller.store.save.bind(effectsRun.controller.store);
  effectsRun.controller.store.save = async () => { throw new Error('fixture persist failure'); };
  await assert.rejects(effectsRun.executor.callbacks.externalEffect(), /persist failure/);
  assert.equal(JSON.parse(readFileSync(effectFile, 'utf8')).state.workspace.current.externalEffect, 'none', 'failed marking rolls back the durable scan');
  effectsRun.controller.store.save = saveEffect;
  await effectsRun.executor.callbacks.externalEffect();
  assert.equal(JSON.parse(readFileSync(effectFile, 'utf8')).state.workspace.current.externalEffect, 'possible');
  assert.equal((await effectsRun.request('status')).assistant.current.canContinue, false);
  await effectsRun.executor.callbacks.question('Vilket syntetiskt steg följer?', gmail.id);
  const effectQuestion = (await effectsRun.request('status')).assistant.current.questionId;
  await assert.rejects(effectsRun.request('reply', { questionId: effectQuestion, answer: 'Läs bara.' }), /tidigare steg/);
  assert.equal(effectsRun.executor.starts.length, 1, 'a question cannot replay a possibly completed external step');
  await effectsRun.request('stop');
  await assert.rejects(effectsRun.request('resume', { runId: effectId, model: 'codex:gpt-6.1-sol' }), /tidigare steg/);
  await assert.rejects(effectsRun.request('resume'), /tidigare steg/);
  await effectsRun.controller.close();
  const effectRestart = create(effectsRun.dir);
  await assert.rejects(effectRestart.request('resume', { runId: effectId, model: 'codex:gpt-6.1-sol' }), /tidigare steg/);
  assert.equal(effectRestart.executor.starts.length, 0, 'restart preserves the no-replay fence');
  await effectRestart.controller.close();
  const legacyEffect = JSON.parse(readFileSync(effectFile, 'utf8'));
  delete legacyEffect.state.workspace.current.externalEffect; delete legacyEffect.state.workspace.current.canContinue;
  writeFileSync(effectFile, JSON.stringify(legacyEffect));
  const legacyEffectRestart = create(effectsRun.dir);
  await assert.rejects(legacyEffectRestart.request('resume', { runId: effectId, model: 'codex:gpt-6.1-sol' }), /äldre kontrollen/);
  assert.equal(legacyEffectRestart.executor.starts.length, 0);
  await legacyEffectRestart.request('resume');
  assert.equal(legacyEffectRestart.executor.starts.length, 1, 'ordinary legacy read-resume retains its existing contract');
  assert.equal(legacyEffectRestart.executor.context.run.externalEffect, undefined, 'legacy unknown effects never become a trusted read-only marker');
  await legacyEffectRestart.request('stop');

  // Explicit model continuation retains the scan journal, account coverage and defaults.
  const handoff = create(); await configure(handoff, [gmail, outlook]);
  await handoff.request('start', { task: 'check-mail', windowId: '81' });
  const beforeHandoff = handoff.executor.context;
  const checkpoint = { accountId: gmail.id, threadId: 'checkpoint-thread', messageId: 'checkpoint-message', sourceUrl: finding().sourceUrl, reviewedAt: new Date().toISOString(), outcome: 'no-action' };
  await handoff.executor.callbacks.checkpoint(checkpoint, { summary: '', findings: [], coverage: [] });
  await handoff.executor.callbacks.update('Första kontot klart.', { accountId: gmail.id, status: 'checked', message: 'Kontrollerat.' });
  await handoff.request('stop');
  const pausedHandoff = (await handoff.request('status')).assistant.current;
  const originalSettings = JSON.parse(JSON.stringify((await handoff.request('status')).assistant.settings));
  await assert.rejects(handoff.request('resume', { runId: 'stale', model: 'claude:claude-sonnet-5-5' }));
  await handoff.request('resume', { runId: pausedHandoff.id, model: 'claude:claude-sonnet-5-5', windowId: '82' });
  const nextHandoff = handoff.executor.context;
  assert.equal(nextHandoff.settings.agent.backend, 'claude'); assert.equal(nextHandoff.windowId, 82);
  assert.equal(nextHandoff.run.resumedFrom, beforeHandoff.run.id);
  assert.equal(nextHandoff.run.scanStartedAt, beforeHandoff.run.scanStartedAt);
  assert.deepEqual(savedRun(handoff).checkpoints, [checkpoint]);
  assert.deepEqual(nextHandoff.run.checkpoints, [], 'the worker sees only its own account checkpoints');
  assert.deepEqual(nextHandoff.settings.accounts.map(account => account.id), [outlook.id]);
  assert.deepEqual(JSON.parse(JSON.stringify((await handoff.request('status')).assistant.settings)), originalSettings);
  await handoff.executor.callbacks.question('Vilken dag gäller det?', outlook.id);
  const questionHandoff = (await handoff.request('status')).assistant.current;
  await handoff.request('reply', { questionId: questionHandoff.questionId, answer: 'På fredag.', windowId: '84' });
  assert.equal(handoff.executor.context.settings.agent.backend, 'claude', 'answering a continuation question retains its selected provider');
  assert.equal(handoff.executor.context.settings.agent.claude.model, 'claude-sonnet-5-5');
  assert.equal(handoff.executor.context.windowId, 84);
  assert.equal(handoff.executor.context.run.scanStartedAt, beforeHandoff.run.scanStartedAt, 'a follow-up answer retains the original scan boundary');
  assert.deepEqual(savedRun(handoff).checkpoints, [checkpoint], 'a follow-up answer retains reviewed thread checkpoints');
  assert.deepEqual((await handoff.request('status')).assistant.current.coverage.map(entry => [entry.accountId, entry.status]), [[gmail.id, 'checked'], [outlook.id, 'checking']], 'the question account does not narrow away completed coverage');
  assert.deepEqual(handoff.executor.context.settings.accounts.map(account => account.id), [outlook.id], 'already checked accounts stay excluded from executor work');
  assert.equal(handoff.executor.context.answers.at(-1).answer, 'På fredag.');

  assert.deepEqual(JSON.parse(JSON.stringify((await handoff.request('status')).assistant.settings)), originalSettings);

  await assert.rejects(handoff.request('resume', { runId: pausedHandoff.id, model: 'codex:gpt-6.1-sol' }));
  await handoff.request('stop'); await handoff.controller.close();
  const handoffRestart = create(handoff.dir); await handoffRestart.request('resume');
  assert.equal(handoffRestart.executor.context.settings.agent.backend, 'claude', 'the explicit choice survives restart');
  await handoffRestart.request('stop');

  // All saved sources share local search, including archives and records outside the current page.
  const searchable = create(); await configure(searchable);
  const foundMail = await scan(searchable, Array.from({ length: 15 }, (_, index) => finding({ threadId: `search-${index}`, title: `Mejl ${index}`, summary: index === 0 ? 'Orkidé beslutsunderlag' : 'Annat underlag' })));
  await searchable.controller.close();
  const conv = randomUUID(), msg = randomUUID(), sentId = randomUUID(), draftId = randomUUID(), approvalId = randomUUID(), caseId = randomUUID();
  const at = '2026-10-30T08:00:00.000Z', attachmentText = 'x'.repeat(8000) + ' Orkidé bilagebevis';
  const file = (id, source) => ({ id, name: `${id}.txt`, kind: 'text', size: attachmentText.length, received: attachmentText.length, status: 'ready', textChars: attachmentText.length, ...(source ? { source } : {}) });
  const conversation = { id: conv, title: 'Orkidé reseplan', createdAt: at, updatedAt: at, messages: [{ id: msg, role: 'user', text: 'Orkidé chattbevis', createdAt: at, status: 'complete', files: [file(sentId), file(approvalId, 'approval')] }] };
  writeFileSync(join(searchable.dir, 'chat.json'), JSON.stringify({ chat: { version: 2, selected: conv, conversations: [conversation], memories: [] } }));
  mkdirSync(join(searchable.dir, 'attachments'), { recursive: true });
  writeFileSync(join(searchable.dir, 'attachments', 'files.json'), JSON.stringify({ state: { version: 1, files: [file(sentId), file(draftId), file(approvalId, 'approval')].map(file => ({ ...file, conversationId: conv, createdAt: at })) } }));
  for (const id of [sentId, draftId, approvalId]) writeFileSync(join(searchable.dir, 'attachments', `${id}.text`), attachmentText);
  mkdirSync(join(searchable.dir, 'archive'), { recursive: true });
  const archived = { ...finding({ title: 'Orkidé äldre besked' }), id: 'archived-search', revision: 0, status: 'dismissed', updatedAt: at };
  writeFileSync(join(searchable.dir, 'archive', 'archived-search.json'), JSON.stringify({ item: archived }));
  const stateFile = join(searchable.dir, 'workspace.json'), storedSearch = JSON.parse(readFileSync(stateFile, 'utf8'));
  storedSearch.state.workspace.cases = [...Array.from({ length: 11 }, (_, index) => ({ id: randomUUID(), title: `Ärende ${index}`, revision: 0, status: 'open', description: '', nextAction: '', waitingFor: '', links: [], createdAt: at, updatedAt: at })), { id: caseId, title: 'Orkidé ärende', revision: 0, status: 'open', description: 'Lokal sammanställning', nextAction: '', waitingFor: '', links: [], createdAt: at, updatedAt: at }];
  writeFileSync(stateFile, JSON.stringify(storedSearch));
  const watchIds = [randomUUID(), randomUUID()];
  writeFileSync(join(searchable.dir, 'watches.json'), JSON.stringify({ state: { version: 1, watches: watchIds.map((id, index) => ({ id, title: `Sparad bevakning ${index}`, target: { url: 'https://example.test/' }, condition: 'Ny uppgift', cadence: { hours: 6 }, enabled: true, createdAt: at })) } }));
  const searchApp = create(searchable.dir);
  await searchApp.request('correct', { action: 'chat-send', conversationId: conv, messageId: randomUUID(), message: 'Vilka bevakningar har jag?' });
  const watchListSnapshot = (await searchApp.request('status')).chat.messages.at(-1).lists[0];
  assert.deepEqual(watchListSnapshot.rows.map(row => row.id), watchIds);
  await searchApp.request('correct', { action: 'watch-pause', watchId: watchIds[0], paused: 'true', listRevision: watchListSnapshot.revision });
  await assert.rejects(searchApp.request('correct', { action: 'watch-pause', watchId: watchIds[1], paused: 'true', listRevision: watchListSnapshot.revision }), /Listan har ändrats/);
  assert.equal((await searchApp.request('status')).chat.watches.find(watch => watch.id === watchIds[1]).enabled, true);

  await searchApp.request('history', { offset: '10' });
  assert.ok(!(await searchApp.request('status')).assistant.items.some(item => item.id === foundMail.items[0].id));
  let searchView = (await searchApp.request('correct', { action: 'assistant-search', query: 'Orkidé' })).chat.search;
  assert.deepEqual(new Set(searchView.results.map(result => result.kind)), new Set(['chat', 'mail', 'case', 'attachment']));
  assert.ok(searchView.results.some(result => result.id === foundMail.items[0].id), 'search includes off-page items');
  assert.deepEqual(searchView.results.filter(result => result.kind === 'attachment').map(result => result.id), [sentId], 'drafts and approval images stay out');
  assert.equal(searchView.results.find(result => result.id === archived.id).date, at);
  assert.equal(searchView.results.find(result => result.id === archived.id).title, archived.title);
  assert.equal(searchApp.executor.starts.length, 0, 'search never starts a model');
  await searchApp.request('correct', { action: 'assistant-search-open', kind: 'case', id: caseId });
  assert.equal((await searchApp.request('status')).assistant.cases[0].id, caseId, 'opening an off-page case makes the exact case available to the editor');
  await searchApp.request('correct', { action: 'assistant-search-open', kind: 'mail', id: archived.id, windowId: '83' });
  assert.equal(searchApp.executor.opened.url, archived.sourceUrl); assert.equal(searchApp.executor.opened.windowId, 83);
  assert.ok(!(await searchApp.request('status')).assistant.items.some(item => item.id === archived.id), 'opening does not restore an archive');
  await searchApp.request('correct', { action: 'assistant-search-open', kind: 'attachment', id: sentId, conversationId: conv });
  assert.equal((await searchApp.request('status')).chat.focusMessageId, msg);
  await assert.rejects(searchApp.request('correct', { action: 'assistant-search-open', kind: 'mail', id: '../workspace' }));
  writeFileSync(join(searchable.dir, 'archive', 'broken-search.json'), '{invalid json');
  searchView = (await searchApp.request('correct', { action: 'assistant-search', query: 'Orkidé' })).chat.search;
  assert.ok(searchView.warnings.length, 'unreadable archives make incompleteness visible');
  await searchApp.request('correct', { action: 'chat-delete', conversationId: conv });
  await assert.rejects(searchApp.request('correct', { action: 'assistant-search-open', kind: 'attachment', id: sentId, conversationId: conv }));
  searchView = (await searchApp.request('correct', { action: 'assistant-search', query: 'bilagebevis' })).chat.search;
  assert.equal(searchView.results.length, 0, 'removed conversations and files are no longer searchable');

  const pagedSearch = create(); await pagedSearch.request('status'); await pagedSearch.controller.close();
  const savedConversations = Array.from({ length: 6 }, (_, index) => ({ id: randomUUID(), title: `Källor ${index}`, createdAt: at, updatedAt: at,
    messages: Array.from({ length: 100 }, () => ({ id: randomUUID(), role: 'user', text: 'Lokalt underlag', status: 'complete', createdAt: at })) }));
  writeFileSync(join(pagedSearch.dir, 'chat.json'), JSON.stringify({ chat: { version: 2, selected: savedConversations[0].id, conversations: savedConversations, memories: [] } }));
  const pagedSearchRestart = create(pagedSearch.dir);
  const partialSearch = (await pagedSearchRestart.request('correct', { action: 'assistant-search', query: 'saknat-sökord' })).chat.search;
  assert.ok(partialSearch.nextOffset > 0, 'a large corpus exposes an honest continuation cursor');
  await pagedSearchRestart.request('correct', { action: 'chat-new', title: 'Ny sparad källa' });
  await assert.rejects(pagedSearchRestart.request('correct', { action: 'assistant-search', query: partialSearch.query, offset: String(partialSearch.nextOffset) }), /källor har ändrats/, 'source changes cannot silently skip results between search parts');
  const brokenIndex = create(); await brokenIndex.request('status'); await brokenIndex.controller.close();
  mkdirSync(join(brokenIndex.dir, 'attachments'), { recursive: true });
  writeFileSync(join(brokenIndex.dir, 'attachments', 'files.json'), '{broken');
  const brokenIndexRestart = create(brokenIndex.dir);
  assert.ok((await brokenIndexRestart.request('correct', { action: 'assistant-search', query: 'underlag' })).chat.search.warnings.some(warning => warning.includes('Bilagornas index')), 'an unreadable attachment index is an incomplete search');

  const anchored = create(); await configure(anchored);
  await anchored.request('start', { task: 'check-mail', windowId: '42' });
  assert.equal(anchored.executor.context.windowId, 42, 'panel window reaches fresh execution');
  await anchored.request('stop');
  await anchored.request('resume', { windowId: '43' });
  assert.equal(anchored.executor.context.windowId, 43, 'resume uses the invoking panel window');
  await anchored.request('stop');
  await anchored.request('open', { accountId: gmail.id, windowId: '42' });
  assert.equal(anchored.executor.opened.windowId, 42);
  await assert.rejects(anchored.request('start', { task: 'check-mail', windowId: '-2' }));
  const app = create();
  assert.deepEqual((await app.request('status')).assistant.settings.accounts, []);
  await assert.rejects(() => app.request('start', { task: 'check-mail' }), /aktivt mejlkonto/);
  assert.throws(() => validateAssistantAccount({ ...gmail, url: 'https://mail.google.com.attacker.test/' }), /webbadress/);
  assert.throws(() => validateAssistantAccount({ ...gmail, url: 'https://user:password@mail.google.com/' }), /webbadress/);
  assert.throws(() => validateAssistantAccount({ ...gmail, provider: 'zoho' }), /webbadress/);
  await configure(app, [gmail, outlook]);
  let view = (await app.request('status')).assistant;
  await assert.rejects(() => app.request('correct', { action: 'settings', revision: '0', settings: JSON.stringify(view.settings) }), /ändrats/);
  await app.request('start', { task: 'check-mail' });
  await assert.rejects(() => app.request('start', { task: 'my-day' }), /arbetar redan/);
  const oldCallbacks = app.executor.callbacks;
  await oldCallbacks.finish({ summary: 'Första kontot klart.', findings: [finding()], coverage: coverage() });
  await app.executor.callbacks.finish({ summary: 'Ett konto behöver inloggning.', findings: [], coverage: [{ accountId: outlook.id, status: 'login', message: 'Logga in.' }] });
  view = (await app.request('status')).assistant;
  assert.equal(view.current.coverage[1].status, 'login');
  assert.ok(view.lastChecks[`check-mail:${gmail.id}`]);
  assert.equal(view.lastChecks[`check-mail:${outlook.id}`], undefined);
  const cursor = view.lastChecks[`check-mail:${gmail.id}`];
  let item = view.items[0];
  await app.request('correct', { action: 'draft', itemId: item.id, revision: String(item.revision), body: '  Mitt eget svar.\n' });
  await assert.rejects(() => app.request('correct', { action: 'dismiss', itemId: item.id, revision: String(item.revision) }), /ändrats/);
  view = await scan(app, [finding({ draft: 'Nytt agentförslag.' })], coverage('partial'));
  assert.equal(view.items.length, 1, 'same thread merges into existing item');
  assert.equal(view.items[0].draft, '  Mitt eget svar.\n', 'user edit survives rescans');
  assert.equal(view.lastChecks[`check-mail:${gmail.id}`], cursor, 'partial scan cannot advance cursor');
  item = view.items[0];
  const until = new Date(Date.now() + 86400000).toISOString();
  await app.request('correct', { action: 'snooze', itemId: item.id, revision: String(item.revision), until });
  view = await scan(app);
  assert.equal(view.items[0].status, 'snoozed');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * 86400000;
    assert.equal((await app.request('status')).assistant.items[0].status, 'open', 'snooze expires on status without rescanning');
  } finally { Date.now = realNow; }
  view = (await app.request('status')).assistant;
  item = view.items[0];
  await app.request('correct', { action: 'dismiss', itemId: item.id, revision: String(item.revision) });
  view = await scan(app);
  assert.equal(view.items[0].status, 'dismissed', 'unchanged dismissed item stays dismissed');
  view = await scan(app, [finding({ sources: [{ observationId: 'read-new', quote: 'Ny fråga efter förra beslutet.' }] })]);
  assert.equal(view.items[0].status, 'open', 'new source content in a thread can need a new reply');
  item = view.items[0];
  await app.request('correct', { action: 'send', itemId: item.id, revision: String(item.revision), recipient: item.recipient, body: '  Godkänt exakt.\n', windowId: '42' });
  assert.equal(app.executor.context.windowId, 42, 'approved sends keep the invoking panel window');
  assert.equal(app.executor.context.approval.body, '  Godkänt exakt.\n');
  const sendCallbacks = app.executor.callbacks;
  await sendCallbacks.sendIntent();
  await assert.rejects(() => sendCallbacks.sendIntent(), /redan använts/);
  await sendCallbacks.exit('Bekräftelsen uteblev.');
  view = (await app.request('status')).assistant;
  assert.equal(view.items[0].status, 'uncertain');
  await assert.rejects(() => app.request('correct', { action: 'send', itemId: item.id, revision: String(view.items[0].revision), recipient: item.recipient, body: 'Igen' }), /låst/);
  await assert.rejects(() => app.request('correct', { action: 'reopen', itemId: item.id, revision: String(view.items[0].revision) }), /låst/, 'an uncertain send never reopens');
  await assert.rejects(() => app.request('correct', { action: 'dismiss-many', items: JSON.stringify([{ id: item.id, revision: view.items[0].revision }]) }), /låst/, 'an uncertain send is never marked done in bulk');
  assert.equal((await app.request('status')).assistant.items[0].status, 'uncertain');
  const persisted = JSON.parse(readFileSync(join(app.dir, 'workspace.json'), 'utf8')).state;
  assert.ok(persisted.sendAttempt.dispatchedAt, 'dispatch marker persisted before browser click');
  assert.equal(persisted.sendAttempt.approval.body, '  Godkänt exakt.\n');
  assert.ok(readFileSync(join(app.dir, 'workspace.json.bak')).length);

  const stopped = create(); await configure(stopped); await scan(stopped);
  item = (await stopped.request('status')).assistant.items[0];
  await stopped.request('correct', { action: 'send', itemId: item.id, revision: String(item.revision), recipient: item.recipient, body: 'Godkänt.' });
  const cancelled = stopped.executor.callbacks;
  await stopped.request('stop');
  await assert.rejects(() => cancelled.sendIntent(), /stoppats/);
  assert.equal(stopped.executor.stopped, 1);

  const restart = create(); await configure(restart); await scan(restart);
  item = (await restart.request('status')).assistant.items[0];
  await restart.request('correct', { action: 'send', itemId: item.id, revision: String(item.revision), recipient: item.recipient, body: 'Godkänt.' });
  await restart.executor.callbacks.sendIntent(); await restart.controller.close();
  const reloaded = create(restart.dir), restored = (await reloaded.request('status')).assistant;
  assert.equal(restored.current.status, 'paused'); assert.equal(restored.items[0].status, 'uncertain');
  await assert.rejects(() => reloaded.request('resume'), /upprepas inte/);

  {
    // The sender on the card is part of what is approved, in both directions.
    const alias = 'alias@example.test', aliased = create(); await configure(aliased);
    const card = (await scan(aliased, [finding({ replyFrom: alias })])).items[0];
    assert.equal(card.replyFrom, alias);
    const approve = sender => aliased.request('correct', { action: 'send', itemId: card.id, revision: String(card.revision), recipient: card.recipient, body: 'Godkänt.', ...(sender ? { sender } : {}) });
    await assert.rejects(approve(), /Avsändaren/, 'an approval that did not carry the address sends nothing');
    await assert.rejects(approve('annan@example.test'), /Avsändaren/, 'nor one that carried another');
    await approve(alias);
    assert.equal(aliased.executor.context.approval.sender, alias);
    const plain = create(); await configure(plain);
    const ordinary = (await scan(plain)).items[0];
    await assert.rejects(plain.request('correct', { action: 'send', itemId: ordinary.id, revision: String(ordinary.revision), recipient: ordinary.recipient, body: 'Godkänt.', sender: alias }), /Avsändaren/, 'a card that names no sender cannot gain one');
  }
  {
    // The card changed between the approval and the send: the intent is refused with its own
    // message, nothing is dispatched and the user's change stays.
    for (const [change, edit, status] of [
      ['an edited draft', item => ({ action: 'draft', itemId: item.id, revision: String(item.revision), body: 'Ett ändrat svar.' }), 'open'],
      ['a dismissal', item => ({ action: 'dismiss', itemId: item.id, revision: String(item.revision) }), 'dismissed'],
      ['a snooze', item => ({ action: 'snooze', itemId: item.id, revision: String(item.revision), until: new Date(Date.now() + 86_400_000).toISOString() }), 'snoozed'],
    ]) {
      const app = create(); await configure(app); await scan(app);
      const card = (await app.request('status')).assistant.items[0];
      await app.request('correct', { action: 'send', itemId: card.id, revision: String(card.revision), recipient: card.recipient, body: 'Godkänt.' });
      const send = app.executor.callbacks;
      await app.request('correct', edit((await app.request('status')).assistant.items[0]));
      await assert.rejects(send.sendIntent(), /^Error: Godkännandet har ändrats\. Inget mejl skickades\.$/, `${change} after the approval refuses the intent`);
      assert.equal((await app.request('status')).assistant.items[0].status, status, `${change}: the card keeps the change and is not sending`);
      assert.equal(JSON.parse(readFileSync(join(app.dir, 'workspace.json'), 'utf8')).state.sendAttempt.dispatchedAt, undefined, `${change}: no dispatch is recorded`);
    }
  }
  {
    // Stop after the intent was saved: the reply may already be on its way, so the card turns
    // uncertain, a later receipt cannot complete it and the send is never resumed.
    const app = create(); await configure(app); await scan(app);
    const card = (await app.request('status')).assistant.items[0];
    await app.request('correct', { action: 'send', itemId: card.id, revision: String(card.revision), recipient: card.recipient, body: 'Godkänt.' });
    const send = app.executor.callbacks;
    await send.sendIntent();
    assert.equal((await app.request('status')).assistant.items[0].status, 'sending');
    await app.request('stop');
    const stoppedView = (await app.request('status')).assistant;
    assert.deepEqual([stoppedView.current.status, stoppedView.items[0].status], ['paused', 'uncertain'], 'stop turns a send in flight into an uncertain one');
    await assert.rejects(send.sent('Tjänsten visar Meddelandet har skickats.'), /stoppats/, 'a receipt after the stop is not accepted');
    assert.equal((await app.request('status')).assistant.items[0].status, 'uncertain');
    await assert.rejects(app.request('resume'), /upprepas inte/, 'the stopped send is never resumed');
  }
  {
    // Every precondition of an approval refuses with its own message and changes nothing: no run
    // starts, the card keeps its revision and draft, and no send attempt is recorded.
    const rule = { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' };
    const app = create(); await configure(app, [gmail, outlook], rule);
    await scan(app, [finding(), finding({ threadId: 'gmail:no-recipient', recipient: undefined }), finding({ threadId: 'gmail:asking', question: 'Vilken dag passar dig?' }),
      finding({ threadId: 'gmail:information', kind: 'information', priority: 3 }), finding({ threadId: 'gmail:followup', kind: 'followup' }),
      finding({ threadId: 'gmail:stranger', recipient: 'stranger@example.test' }), finding({ accountId: outlook.id, threadId: 'outlook:thread-1', sourceUrl: 'https://outlook.live.com/mail/0/inbox/id/AQMkADAwATM0MDAAMS1hMjE2' })]);
    const card = threadId => app.controller.view().assistant.items.find(item => item.threadId === threadId);
    const attempt = () => JSON.stringify(JSON.parse(readFileSync(join(app.dir, 'workspace.json'), 'utf8')).state.sendAttempt ?? null);
    const refused = 'refused, nothing changed';
    // The body's own parse refuses it, not a later schema of the stored card.
    const bodyRefused = code => error => error.name === 'ZodError' && error.issues.every(issue => issue.path.length === 0) && error.issues.some(issue => issue.code === code);
    const check = async (label, threadId, changes, expected) => {
      const before = card(threadId), starts = app.executor.starts.length, recorded = attempt();
      const error = await app.request('correct', { action: 'send', itemId: before.id, revision: String(before.revision), recipient: before.recipient ?? '', body: 'Godkänt.', ...changes }).then(() => undefined, caught => caught);
      const after = card(threadId);
      const unchanged = app.executor.starts.length === starts && after.revision === before.revision && after.draft === before.draft && attempt() === recorded;
      // A send that wrongly started is stopped, so the next case meets only its own precondition.
      if (app.controller.view().assistant.current?.status === 'running') await app.request('stop');
      const matches = !!error && (typeof expected === 'function' ? expected(error) : expected.test(error.message));
      return [label, matches && unchanged ? refused : `${error?.message ?? 'accepted'}; unchanged: ${unchanged}`];
    };
    const cases = [
      ['a stale revision', 'gmail:thread-123', { revision: String(card('gmail:thread-123').revision - 1) }, /^Punkten har ändrats\./],
      ['another recipient', 'gmail:thread-123', { recipient: 'annan@example.test' }, /^Mottagaren måste stämma/],
      ['a card without a verified recipient', 'gmail:no-recipient', { recipient: 'sender@example.test' }, /^Mottagaren måste stämma/],
      ['an open question', 'gmail:asking', {}, /^Besvara den saknade uppgiften/],
      ['a card that is not a reply', 'gmail:information', {}, /^Punkten har inget godkänt mejlsvar/],
      ['an empty body', 'gmail:thread-123', { body: '' }, bodyRefused('too_small')],
      ['a body of blanks only', 'gmail:thread-123', { body: ' \n\t ' }, bodyRefused('custom')],
      ['a body over 12000 characters', 'gmail:thread-123', { body: 'x'.repeat(12001) }, bodyRefused('too_big')],
      ['an automatic send to a recipient outside the rule', 'gmail:stranger', { body: 'Mottaget.', automatic: 'true' }, /^Regeln för automatiska bekräftelser/],
      ['an automatic send with another text', 'gmail:thread-123', { body: 'En annan text.', automatic: 'true' }, /^Regeln för automatiska bekräftelser/],
      ['an automatic send of a reminder', 'gmail:followup', { body: 'Mottaget.', automatic: 'true' }, /^Regeln för automatiska bekräftelser/],
    ];
    const outcomes = [];
    for (const entry of cases) outcomes.push(await check(...entry));
    await configure(app, [gmail, outlook], { autoAcknowledgements: false });
    outcomes.push(await check('an automatic send with the rule turned off', 'gmail:thread-123', { body: 'Mottaget.', automatic: 'true' }, /^Regeln för automatiska bekräftelser/));
    await configure(app, [gmail, { ...outlook, enabled: false }]);
    outcomes.push(await check('a card of a disabled account', 'outlook:thread-1', {}, /^Kontot saknas eller är avstängt/));
    await configure(app, [gmail]);
    outcomes.push(await check('a card of a removed account', 'outlook:thread-1', {}, /^Kontot saknas eller är avstängt/));
    await app.request('start', { task: 'my-day' });
    const running = app.controller.view().assistant.current.id;
    outcomes.push(await check('a run in progress', 'gmail:thread-123', {}, /^Assistenten arbetar redan/));
    assert.equal(app.controller.view().assistant.current.id, running, 'the run in progress is the same run');
    assert.deepEqual(outcomes, outcomes.map(([label]) => [label, refused]));
    await app.request('stop');
  }
  const success = create(); await configure(success); await scan(success);
  item = (await success.request('status')).assistant.items[0];
  await success.request('correct', { action: 'send', itemId: item.id, revision: String(item.revision), recipient: item.recipient, body: 'Godkänt.' });
  await success.executor.callbacks.sendIntent(); await success.executor.callbacks.sent('Tjänsten visar Meddelandet har skickats.');
  assert.equal((await success.request('status')).assistant.items[0].status, 'sent');
  const sentItem = (await success.request('status')).assistant.items[0];
  await assert.rejects(() => success.request('correct', { action: 'reopen', itemId: sentItem.id, revision: String(sentItem.revision) }), /låst/, 'a sent reply never reopens');
  await success.request('start', { task: 'prepare-meeting' });
  await success.executor.callbacks.question('Vilket möte vill du förbereda?', gmail.id);
  view = (await success.request('status')).assistant;
  await assert.rejects(() => success.request('reply', { questionId: 'old-question', answer: 'Det första.' }), /Frågan har ändrats/);
  await success.request('reply', { questionId: view.current.questionId, answer: 'Nästa möte i kalendern.', windowId: '43' });
  assert.equal(success.executor.context.windowId, 43, 'answering a question starts in the replying panel window');
  assert.equal(success.executor.context.answers.at(-1).answer, 'Nästa möte i kalendern.');
  await success.request('stop');
  await success.request('start', { task: 'my-day' });
  assert.equal(success.executor.context.answers.length, 0, 'answers from unrelated tasks are not reused');
  await success.request('stop');
  await success.request('correct', { action: 'save-shortcut', label: 'Min kontroll', instructions: 'Läs dagens öppna frågor.' });
  view = (await success.request('status')).assistant;
  await success.request('start', { task: 'custom', shortcutId: view.shortcuts[0].id });
  assert.equal(success.executor.context.run.instructions, 'Läs dagens öppna frågor.');

  const identity = create(); await configure(identity);
  await configure(identity, []);
  await assert.rejects(() => configure(identity, [{ ...gmail, email: 'different@example.test' }]), /identitet har redan använts/);

  const scope = create(); await configure(scope, [gmail, outlook]);
  view = await scan(scope, [finding({ question: 'Vilken tid passar dig?' })]); item = view.items[0];
  await scope.request('reply', { itemId: item.id, revision: String(item.revision), answer: 'Klockan 14.' });
  assert.deepEqual(scope.executor.context.settings.accounts.map(account => account.id), [gmail.id]);
  assert.equal(scope.executor.context.run.threadId, item.threadId);
  assert.equal(scope.executor.context.answers[0].answer, 'Klockan 14.');

  const capacity = create(); await configure(capacity);
  const batch = (offset, count) => Array.from({ length: count }, (_, index) => finding({ threadId: `gmail:thread-${offset + index}`, messageId: `gmail:message-${offset + index}` }));
  await scan(capacity, batch(0, 60)); await scan(capacity, batch(60, 40));
  view = await scan(capacity, batch(100, 1));
  assert.equal(view.items.length, 100); assert.equal(view.current.coverage[0].status, 'partial', 'active overflow is visible and does not evict existing work');
  item = view.items[0]; await capacity.request('correct', { action: 'dismiss', itemId: item.id, revision: String(item.revision) });
  view = await scan(capacity, batch(100, 1)); assert.equal(view.items.length, 100); assert.ok(view.items.some(entry => entry.threadId === 'gmail:thread-100'));
  assert.equal(JSON.parse(readFileSync(join(capacity.dir, 'archive', `${item.id}.json`), 'utf8')).item.status, 'dismissed');
  view = await scan(capacity, [finding({ threadId: item.threadId, messageId: item.messageId })]);
  assert.ok(!view.items.some(entry => entry.id === item.id), 'archived dismissed evidence does not resurface');
  const repeated = create(); await configure(repeated); view = await scan(repeated, [finding({ messageId: 'message-1' })]); item = view.items[0];
  await repeated.request('correct', { action: 'dismiss', itemId: item.id, revision: String(item.revision) });
  view = await scan(repeated, [finding({ messageId: 'message-2' })]);
  assert.equal(view.items[0].status, 'open', 'identical text in a later message can still require a response');

  const bounded = create(); await configure(bounded);
  const large = Array.from({ length: 60 }, (_, index) => finding({ threadId: `large-thread-${index}`, summary: '中'.repeat(4000), reason: '文'.repeat(2000), draft: '字'.repeat(12000),
    sources: Array.from({ length: 6 }, (_, source) => ({ observationId: `large-${index}-${source}`, quote: '語'.repeat(1000) })) }));
  view = await scan(bounded, large);
  assert.equal(view.itemPage.total, 60);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 1_500_000, 'worst-case Unicode view stays below the panel transport ceiling');
  assert.ok(view.items.length < 60);
  const next = view.itemPage.nextOffset;
  view = (await bounded.request('history', { offset: String(next) })).assistant;
  assert.equal(view.itemPage.offset, next);
  assert.equal(JSON.parse(readFileSync(join(bounded.dir, 'workspace.json'), 'utf8')).state.workspace.items.length, 60, 'view pagination never deletes private records');
  const savedCursor = view.lastChecks[`check-mail:${gmail.id}`];
  const secondLarge = large.slice(0, 40).map((item, index) => ({ ...item, threadId: `large-second-${index}` }));
  view = await scan(bounded, secondLarge);
  const boundedBytes = readFileSync(join(bounded.dir, 'workspace.json'));
  assert.ok(boundedBytes.length < 7_000_000, 'a second maximal Unicode batch stays below the private-store ceiling');
  const retained = JSON.parse(boundedBytes).state.workspace.items;
  assert.ok(retained.length >= 60 && retained.length < 100);
  assert.equal(view.current.coverage[0].status, 'partial');
  assert.equal(view.lastChecks[`check-mail:${gmail.id}`], savedCursor, 'byte-limited ingestion preserves successful cursor');
  assert.equal((await bounded.request('status')).assistant.current.status, 'review', 'workspace remains usable after a byte-limited batch');

  const automatic = create();
  await configure(automatic, [gmail], { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' });
  const autoStarted = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Automatic acknowledgement did not start')), 2000);
    automatic.executor.onStart = context => { if (context.run.task === 'send') { clearTimeout(deadline); resolve(context); } };
  });
  // Every card carries its message identity: an automatic send without one could only be refused.
  await scan(automatic, [finding({ messageId: 'gmail:message:ack', draft: 'Mottaget.' })]);
  assert.equal((await autoStarted).approval.body, 'Mottaget.', 'explicit acknowledgement rule approves only its fixed text');
  const generated = create();
  await configure(generated, [gmail], { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' });
  await scan(generated, [finding({ messageId: 'gmail:message:generated', draft: 'Jag lovar att leverera imorgon.' })]);
  await new Promise(resolve => setTimeout(resolve, 0)); await generated.request('status');
  assert.equal(generated.executor.starts.length, 1, 'arbitrary generated replies never qualify for automatic sending');
  const disabled = create();
  await configure(disabled, [gmail], { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' });
  await scan(disabled, [finding({ messageId: 'gmail:message:disabled', draft: 'Mottaget.' })]);
  await configure(disabled, [gmail], { autoAcknowledgements: false });
  await new Promise(resolve => setTimeout(resolve, 0)); await disabled.request('status');
  assert.equal(disabled.executor.starts.length, 1, 'disabling a queued acknowledgement revokes its rule before send start');

  // Local inference settings: earlier workspaces load and round-trip unchanged,
  // both backends' choices survive switching, and runtime jobs never hold the queue.
  {
    const { OllamaClient } = await import('../dist/assistant-ollama.mjs');
    // The panel transport schema is authoritative for what the view may carry.
    const schemaDir = mkdtempSync(join(tmpdir(), 'tabai-module-schema-')); dirs.push(schemaDir);
    await (await import('esbuild')).build({ entryPoints: { schema: 'shared/personal-modules.ts', 'chat-schema': 'shared/assistant-chat.ts' }, outdir: schemaDir, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { moduleViewSchema } = await import(pathToFileURL(join(schemaDir, 'schema.mjs')).href);
    const qwen = 'qwen3.5:4b-q4_K_M';
    const digests = { [qwen]: 'd8b0f5e9760cd1682034f292d7ef72ec46f432149be0df7574bf2d6e92e38c04' };
    const fake = { version: '99.0.0', pulled: new Set([qwen]), loaded: new Set(), pulls: [], chats: 0, protocol: true, unloads: [] };
    const encoder = new TextEncoder();
    const ndjson = (events, hold) => new ReadableStream({ async start(controller) { for (const event of events) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); if (hold) await hold; else controller.close(); } });
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const ollama = new OllamaClient({ fetch: async (url, init) => {
      const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
      if (path === '/api/version') return json({ version: fake.version });
      if (path === '/api/tags') return json({ models: [...fake.pulled].map(name => ({ name, model: name, digest: digests[name] })) });
      if (path === '/api/ps') return json({ models: [...fake.loaded].map(name => ({ name, size_vram: 1_500_000_000 })) });
      if (path === '/api/show') return json({ details: { family: 'qwen35', quantization_level: 'Q4_K_M' } });
      if (path === '/api/generate') { fake.unloads.push(body); fake.loaded.delete(body.model); return json({ done: true, done_reason: 'unload' }); }
      if (path === '/api/pull') {
        let release; const hold = new Promise(resolve => { release = resolve; });
        const pull = { model: body.model, signal: init.signal, aborted: false, succeeded: false, finish: () => { fake.pulled.add(body.model); pull.succeeded = true; release(); } };
        init.signal.addEventListener('abort', () => { pull.aborted = true; release(); });
        fake.pulls.push(pull);
        return new Response(new ReadableStream({ async start(controller) {
          for (const event of [{ status: 'pulling manifest' }, { status: 'pulling abc', total: 1000, completed: 250 }]) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          await hold;
          if (pull.succeeded) controller.enqueue(encoder.encode(JSON.stringify({ status: 'success' }) + '\n'));
          controller.close();
        } }));
      }
      if (path === '/api/chat') {
        fake.chats++;
        const last = body.messages.at(-1);
        const toolResult = last.role === 'tool' ? JSON.parse(last.content)
          : last.content.startsWith('TOOL_RESULT ') ? JSON.parse(JSON.parse(last.content.slice('TOOL_RESULT '.length)).result) : undefined;
        const intent = toolResult ? { action: 'respond', tool: '__none__', arguments: {}, text: `Ordern är ${toolResult.status}.` }
          : { action: 'call', tool: 'lookup_order', arguments: { orderId: last.content.match(/[A-Z]{2}-\d{4}/)?.[0] }, text: '' };
        const reply = !fake.protocol ? { message: { content: 'Jag vet inte.' } }
          : body.format ? { message: { content: JSON.stringify(intent) } }
          : last.role === 'tool' ? { message: { content: `Ordern är ${JSON.parse(last.content).status}.` } }
          : { message: { content: '', tool_calls: [{ function: { name: 'lookup_order', arguments: { orderId: body.messages.at(-1).content.match(/[A-Z]{2}-\d{4}/)[0] } } }] } };
        return new Response(ndjson([reply, { done: true, done_reason: 'stop' }]));
      }
      return new Response('', { status: 404 });
    } });
    const localApp = (dir, executor, chatExecutor) => {
      dir ??= mkdtempSync(join(tmpdir(), 'tabai-assistant-local-')); dirs.push(dir);
      executor ??= { starts: [], async start(context, callbacks) { this.starts.push(context); this.context = context; this.callbacks = terminalCallbacks(callbacks); if (this.fail) throw new Error('spawn failed'); }, async stop() {}, async close() {}, async open() {} };
      const controller = new AssistantController(root, dir, executor, { ollama, ...(chatExecutor ? { chatExecutor } : {}) }); controllers.push(controller);
      return { controller, executor, dir, request: (op, input = {}) => controller.request(op, input) };
    };
    const until = async (check, label) => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`timed out: ${label}`); };
    const file = dir => join(dir, 'workspace.json');

    const continuationChat = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {} };
    const unavailable = localApp(undefined, undefined, continuationChat); await configure(unavailable);
    const unavailableConversation = (await unavailable.request('status')).chat.id;
    await unavailable.request('correct', { action: 'chat-send', conversationId: unavailableConversation, messageId: randomUUID(), message: 'Förklara dagens plan.' });
    await continuationChat.starts[0].callbacks.chatReply('Ett svar att förbättra.');
    const beforeUnavailable = (await unavailable.request('status')).chat;
    fake.pulled.delete(qwen);
    await assert.rejects(unavailable.request('correct', { action: 'chat-continue', conversationId: unavailableConversation, replyId: beforeUnavailable.messages.at(-1).id, messageId: randomUUID(), model: `local:${qwen}` }), /lokala modellen/);
    assert.equal(continuationChat.starts.length, 1, 'missing local model creates no continuation worker');
    assert.deepEqual((await unavailable.request('status')).chat.messages, beforeUnavailable.messages, 'missing local model reserves no chat attempt');
    await unavailable.request('start', { task: 'check-mail' }); await unavailable.request('stop');
    const beforeUnavailableRun = (await unavailable.request('status')).assistant.current, beforeStarts = unavailable.executor.starts.length;
    await assert.rejects(unavailable.request('resume', { runId: beforeUnavailableRun.id, model: `local:${qwen}` }), /lokala modellen/);
    assert.equal(unavailable.executor.starts.length, beforeStarts, 'missing local model creates no mail worker');
    assert.equal((await unavailable.request('status')).assistant.current.id, beforeUnavailableRun.id, 'failed preflight retains the original scan');
    fake.pulled.add(qwen);
    await assert.rejects(unavailable.request('resume', { runId: beforeUnavailableRun.id, model: `local:${qwen}` }), /självtest/, 'an untested fresh runtime is rejected before dispatch');

    // Legacy shapes: absent agent and the strict Codex-only object load and round-trip byte-identically.
    for (const legacy of [undefined, { model: 'gpt-6.1-sol', reasoningEffort: 'high' }]) {
      const first = localApp(); await configure(first, [gmail, outlook]); await scan(first);
      await first.controller.close();
      const stored = JSON.parse(readFileSync(file(first.dir), 'utf8'));
      if (legacy) stored.state.workspace.settings.agent = legacy; else delete stored.state.workspace.settings.agent;
      stored.state.workspace.items[0].status = 'uncertain';
      writeFileSync(file(first.dir), JSON.stringify(stored, null, 2));
      const before = structuredClone(stored.state);
      const reopened = localApp(first.dir);
      const view = await reopened.request('status');
      assert.deepEqual(view.assistant.settings.agent, legacy, 'legacy agent settings are read exactly as stored');
      moduleViewSchema.parse(view);
      await reopened.request('correct', { action: 'save-shortcut', label: 'Prov', instructions: 'Läs bara.' });
      const after = JSON.parse(readFileSync(file(first.dir), 'utf8')).state;
      for (const key of ['answers', 'accountBindings', 'sendAttempt']) assert.deepEqual(after[key], before[key], `${key} survive the round-trip`);
      for (const key of ['settings', 'items', 'history', 'lastChecks', 'current']) assert.deepEqual(after.workspace[key], before.workspace[key], `workspace ${key} survive the round-trip`);
      assert.equal(JSON.stringify(after.workspace.settings.agent), JSON.stringify(legacy), 'legacy agent bytes are not rewritten');
      await reopened.request('start', { task: 'my-day' });
      assert.deepEqual(reopened.executor.starts.at(-1).settings.agent, legacy, 'execution receives the same legacy choice (Codex)');
    }

    // Persisted selections migrate before strict workspace validation, with original bytes backed up on save.
    const { assistantChatModelSchema, assistantChatAgent, assistantChatModel } = await import(pathToFileURL(join(schemaDir, 'chat-schema.mjs')).href);
    for (const oldModel of ['qwen3.5:2b-q4_K_M', 'qwen3.5:9b-q4_K_M']) {
      const original = localApp(); await configure(original, [gmail]); await original.controller.close();
      const stored = JSON.parse(readFileSync(file(original.dir), 'utf8'));
      const oldAgent = { backend: 'local', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, local: { model: oldModel } };
      for (const role of ['agent', 'chatAgent', 'watchAgent']) stored.state.workspace.settings[role] = structuredClone(oldAgent);
      const originalBytes = JSON.stringify(stored, null, 2); writeFileSync(file(original.dir), originalBytes);
      const migrated = localApp(original.dir), view = await migrated.request('status');
      for (const role of ['agent', 'chatAgent', 'watchAgent']) {
        assert.equal(view.assistant.settings[role].local.model, qwen, `${role} reads ${oldModel} as 4B`);
        assert.deepEqual(view.assistant.settings[role].codex, oldAgent.codex, 'other provider choices survive');
      }
      moduleViewSchema.parse(view);
      assert.equal(readFileSync(file(original.dir), 'utf8'), originalBytes, 'reading never rewrites the existing store');
      assert.equal(assistantChatModelSchema.parse(`local:${oldModel}`), `local:${qwen}`);
      assert.equal(assistantChatAgent(`local:${oldModel}`).local.model, qwen, 'saved model-selection IDs apply as 4B');
      const unloadsBefore = fake.unloads.length;
      await assert.rejects(migrated.request('correct', { action: 'local-unload', model: oldModel }), 'stale model actions cannot target 4B through the settings migration');
      assert.equal(fake.unloads.length, unloadsBefore);
      await migrated.request('correct', { action: 'save-shortcut', label: 'Migreringsprov', instructions: 'Läs bara.' });
      assert.equal(readFileSync(`${file(original.dir)}.bak`, 'utf8'), originalBytes, 'the next save backs up the original legacy selections');
      const saved = JSON.parse(readFileSync(file(original.dir), 'utf8')).state.workspace.settings;
      for (const role of ['agent', 'chatAgent', 'watchAgent']) assert.equal(saved[role].local.model, qwen);
    }

    // Switching backends keeps both choices; the snapshot taken at run start decides.
    const switching = localApp(); await configure(switching, [gmail]);
    const localChoice = { backend: 'local', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, local: { model: qwen } };
    await configure(switching, [gmail], { agent: localChoice });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, localChoice);
    await configure(switching, [gmail], { agent: { ...localChoice, backend: 'codex' } });
    await configure(switching, [gmail], { agent: localChoice });
    await configure(switching, [gmail], { agent: { backend: 'codex', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, local: { model: qwen } } });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, 'Codex with the default local model keeps the rollback-readable shape');
    await configure(switching, [gmail], { agent: localChoice });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, localChoice, 'a double switch loses neither choice');
    await configure(switching, [gmail], { agent: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' } });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, { ...localChoice, codex: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' } }, 'a stale pre-local panel cannot switch local back to Codex');
    // Claude is a third choice; every choice survives switching, and a panel from
    // before the Claude backend cannot drop a saved Claude choice.
    const claudeChoice = { backend: 'claude', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, claude: { model: 'claude-sonnet-5-5', effort: 'high' }, local: { model: qwen } };
    await configure(switching, [gmail], { agent: claudeChoice });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, claudeChoice);
    await configure(switching, [gmail], { agent: { ...localChoice } });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, { ...localChoice, claude: claudeChoice.claude }, 'a pre-Claude panel keeps the saved Claude choice');
    await configure(switching, [gmail], { agent: { ...claudeChoice, backend: 'codex', local: { model: qwen } } });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, { ...claudeChoice, backend: 'codex', local: { model: qwen } }, 'a non-default Claude choice is kept, so the earlier Codex-only shape is not used');
    await configure(switching, [gmail], { agent: { backend: 'codex', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, claude: { model: 'claude-opus-5-5', effort: 'medium' }, local: { model: qwen } } });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, 'Codex with default local and Claude choices keeps the rollback-readable shape');
    await configure(switching, [gmail], { agent: { ...localChoice, claude: { model: 'claude-opus-5-5', effort: 'medium' } } });
    assert.deepEqual((await switching.request('status')).assistant.settings.agent, localChoice, 'an unchosen default Claude choice is not stored, so a pre-Claude build can read the workspace');
    await assert.rejects(configure(switching, [gmail], { agent: { ...claudeChoice, claude: { model: 'claude-3-opus', effort: 'high' } } }), 'arbitrary Claude models are refused');
    await assert.rejects(configure(switching, [gmail], { agent: { ...claudeChoice, claude: { model: 'claude-opus-5-5', effort: 'high', apiKey: 'x' } } }), 'no API key can be stored');
    await configure(switching, [gmail], { agent: localChoice });
    await assert.rejects(configure(switching, [gmail], { agent: { ...localChoice, local: { model: 'llama3:latest' } } }), 'arbitrary model names are refused');
    await assert.rejects(configure(switching, [gmail], { agent: { ...localChoice, local: { model: qwen, url: 'http://example.test' } } }), 'no endpoint can be configured');
    await switching.request('start', { task: 'check-mail' });
    const started = switching.executor.starts.at(-1);
    assert.equal(started.settings.agent.backend, 'local'); assert.deepEqual(started.localVerifications, []);
    await switching.request('stop');
    switching.executor.fail = true;
    await switching.request('start', { task: 'check-mail' });
    assert.match((await switching.request('status')).assistant.current.message, /lokala agenten kunde inte startas/, 'start failures name the selected backend');
    switching.executor.fail = false;
    // A stopped scan resumes across a backend switch without losing its origin.
    await switching.request('start', { task: 'follow-ups' });
    const scanStart = (await switching.request('status')).assistant.current.scanStartedAt;
    await switching.request('stop');
    await configure(switching, [gmail], { agent: { ...localChoice, backend: 'codex' } });
    await switching.request('resume');
    assert.equal(switching.executor.starts.at(-1).run.scanStartedAt, scanStart, 'continuation keeps its original scan start');
    assert.equal(assistantChatModel(switching.executor.starts.at(-1).settings.agent), 'codex:gpt-6.1-sol', 'the compact Codex setting still selects the requested backend and model');

    // Runtime jobs: pull returns an operation at once, cancel reaches the open request.
    const runtime = localApp();
    let view = await runtime.request('correct', { action: 'local-refresh' });
    view = await until(async () => { const next = await runtime.request('status'); return next.localRuntime.checkedAt && next; }, 'status refresh');
    assert.equal(view.localRuntime.reachable, true); assert.equal(view.localRuntime.version, '99.0.0');
    assert.deepEqual(view.localRuntime.models.map(model => model.state), ['untested'], 'an untested runtime release is not ready');
    const oldVerification = { model: 'qwen3.5:9b-q4_K_M', digest: 'a'.repeat(64), ollamaVersion: '99.0.0', profile: 'intent', verifiedAt: '2026-01-01T00:00:00.000Z' };
    const oldStore = JSON.stringify({ verifications: [oldVerification] });
    writeFileSync(join(runtime.dir, 'local-models.json'), oldStore);
    const legacyRuntime = localApp(runtime.dir);
    await legacyRuntime.request('correct', { action: 'local-refresh' });
    const oldView = await until(async () => { const next = await legacyRuntime.request('status'); return next.localRuntime.checkedAt && !next.localRuntime.checking && next; }, 'legacy verification refresh');
    assert.equal(oldView.localRuntime.models[0].verifiedAt, undefined, 'a retired model self-test never becomes a 4B self-test');
    assert.equal(oldView.localRuntime.models[0].state, 'untested');
    assert.equal(readFileSync(join(runtime.dir, 'local-models.json'), 'utf8'), oldStore, 'reading preserves the old verification file');
    await legacyRuntime.controller.close();
    rmSync(join(runtime.dir, 'local-models.json'));
    view = await runtime.request('correct', { action: 'local-pull', model: qwen });
    const operation = view.localRuntime.operation;
    assert.equal(operation.kind, 'pull'); assert.equal(operation.status, 'running', 'the panel call returns while the stream is still open');
    view = await until(async () => { const next = await runtime.request('status'); return next.localRuntime.operation.total === 1000 && next; }, 'pull progress');
    assert.equal(view.localRuntime.operation.completed, 250);
    await assert.rejects(runtime.request('correct', { action: 'local-pull', model: qwen }), /pågående/, 'one runtime job at a time');
    await assert.rejects(runtime.request('correct', { action: 'local-cancel', operationId: '00000000-0000-4000-8000-000000000000' }), /avslutad/);
    await runtime.request('correct', { action: 'local-cancel', operationId: operation.id });
    assert.equal(fake.pulls.at(-1).aborted, true, 'cancel aborts the in-flight pull request');
    view = await until(async () => { const next = await runtime.request('status'); return next.localRuntime.operation.status === 'aborted' && next; }, 'aborted pull');
    assert.match(view.localRuntime.operation.message, /återuppta/);
    await assert.rejects(runtime.request('correct', { action: 'local-pull', model: 'llama3' }), 'pull accepts only catalog models');
    // A resumed pull completes; the status is re-derived from Ollama.
    await runtime.request('correct', { action: 'local-pull', model: qwen });
    await until(() => fake.pulls.length === 2, 'second pull'); fake.pulls.at(-1).finish();
    view = await until(async () => { const next = await runtime.request('status'); return next.localRuntime.operation.status === 'done' && !next.localRuntime.checking && next.localRuntime.models[0].state !== 'missing' && next; }, 'completed pull');
    assert.equal(view.localRuntime.models[0].state, 'untested');
    // A failing self-test records nothing; a passing one admits this exact version.
    fake.protocol = false;
    await runtime.request('correct', { action: 'local-selftest', model: qwen });
    view = await until(async () => { const next = await runtime.request('status'); return ['done', 'failed'].includes(next.localRuntime.operation.status) && next; }, 'failed self-test');
    assert.equal(view.localRuntime.operation.status, 'failed'); assert.match(view.localRuntime.operation.message, /misslyckades i runda 1/);
    const verificationFile = join(runtime.dir, 'local-models.json');
    assert.throws(() => readFileSync(verificationFile), /ENOENT/, 'a failed self-test records nothing');
    fake.protocol = true; const chatsBefore = fake.chats;
    await runtime.request('correct', { action: 'local-selftest', model: qwen });
    view = await until(async () => { const next = await runtime.request('status'); return next.localRuntime.operation.status === 'done' && !next.localRuntime.checking && next.localRuntime.models[0].state === 'ready' && next; }, 'passed self-test');
    assert.equal(fake.chats - chatsBefore, 6, 'three rounds of call plus answer');
    assert(view.localRuntime.models[0].verifiedAt);
    const verifications = JSON.parse(readFileSync(verificationFile, 'utf8')).verifications;
    assert.equal(JSON.parse(readFileSync(file(runtime.dir), 'utf8')).state.localVerifications, undefined, 'verifications stay outside workspace.json so an older build still reads it');
    assert.deepEqual(verifications.map(entry => [entry.model, entry.digest, entry.ollamaVersion, entry.profile]), [[qwen, digests[qwen], '99.0.0', 'intent']]);
    moduleViewSchema.parse(view);
    // Explicit unload only; it targets the chosen model with keep_alive 0.
    fake.loaded.add(qwen);
    await runtime.request('correct', { action: 'local-unload', model: qwen });
    await until(async () => (await runtime.request('status')).localRuntime.operation.status === 'done', 'unload');
    assert.deepEqual(fake.unloads.at(-1), { model: qwen, keep_alive: 0, stream: false });
    // Runs receive the persisted verification; restart re-derives status with no stale job.
    await configure(runtime, [gmail], { agent: { backend: 'local', codex: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' }, local: { model: qwen } } });
    await runtime.request('start', { task: 'check-mail' });
    assert.equal(runtime.executor.starts.at(-1).localVerifications[0].ollamaVersion, '99.0.0');
    await assert.rejects(runtime.request('correct', { action: 'local-selftest', model: qwen }), /Vänta tills det lokala uppdraget/);
    await assert.rejects(runtime.request('correct', { action: 'local-pull', model: qwen }), /används av det pågående uppdraget/, 'the running model is never re-pulled mid-run');
    await runtime.request('stop');
    await runtime.controller.close();
    writeFileSync(verificationFile, JSON.stringify({ verifications: [oldVerification, ...verifications] }));
    const restarted = localApp(runtime.dir);
    view = await restarted.request('status');
    assert.equal(view.localRuntime.operation, undefined, 'job status is transient');
    view = await until(async () => { const next = await restarted.request('status'); return next.localRuntime.checkedAt && !next.localRuntime.checking && next; }, 'restart refresh');
    assert.equal(view.localRuntime.models[0].state, 'ready', 'the persisted self-test still admits the same version after restart');
    assert.equal(view.localRuntime.models[0].verifiedAt, verifications[0].verifiedAt, 'a mixed legacy store retains the real 4B verification');
    assert.equal(JSON.stringify(view).includes('Ordern är'), false, 'no model text reaches the panel view');
    const readyStarts = restarted.executor.starts.length, protocolCalls = fake.chats;
    await restarted.request('resume', { runId: view.assistant.current.id, model: `local:${qwen}` });
    assert.equal(restarted.executor.starts.length, readyStarts + 1, 'fresh verified local readiness admits one explicit continuation');
    assert.equal(restarted.executor.starts.at(-1).settings.agent.backend, 'local');
    assert.equal(fake.chats, protocolCalls, 'readiness metadata never runs inference or another self-test');
    await restarted.request('stop');

  }

  // Mejl's inbox: the chat's numbers after a check, Klar för alla (atomic) and Ångra (reopen).
  {
    const inbox = create(); await configure(inbox);
    const info = thread => finding({ threadId: thread, kind: 'information', title: `Nyhetsbrev ${thread}`, draft: undefined, recipient: undefined, priority: 3, sources: [{ observationId: `read-${thread}`, quote: `Nyhetsbrev ${thread}.` }] });
    const findings = [finding({ title: 'Svar föreslaget' }), finding({ threadId: 'gmail:question', kind: 'decision', title: 'Behöver ditt svar', draft: undefined, question: 'Vilken dag gäller det?' }), info('gmail:info-1'), info('gmail:info-2'), info('gmail:info-3')];
    const conversationId = (await inbox.request('status')).chat.id;
    await inbox.request('correct', { action: 'chat-task', task: 'check-mail', conversationId, messageId: randomUUID() });
    const running = (await inbox.request('status')).chat.messages.find(message => message.task);
    assert.equal(running.task.counts, undefined, 'a running check records no numbers');
    await inbox.executor.callbacks.finish({ summary: 'Fem mejl gicks igenom.', findings, coverage: coverage() });
    let full = await inbox.request('status');
    assert.deepEqual(full.chat.messages.find(message => message.task).task.counts, { replies: 1, needsYou: 1, info: 3 }, 'the finished task carries Mejl\'s numbers as a typed field');
    view = full.assistant;
    const infos = view.items.filter(entry => entry.kind === 'information'), reply = view.items.find(entry => entry.kind === 'reply');
    const batch = entries => JSON.stringify(entries.map(({ id, revision }) => ({ id, revision })));
    const unchanged = async () => {
      const current = (await inbox.request('status')).assistant;
      return infos.every(entry => { const saved = current.items.find(item => item.id === entry.id); return saved.status === 'open' && saved.revision === entry.revision; });
    };
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: batch([...infos, { ...reply, revision: reply.revision + 1 }]) }), /Inget markerades/);
    assert.ok(await unchanged(), 'one stale revision rejects the whole call and changes nothing');
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: batch([...infos, { id: 'saknas', revision: 0 }]) }), /Inget markerades/);
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: batch([infos[0], infos[0]]) }), /två gånger/);
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: 'inte json' }), /fel format/);
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: '[]' }), /fel format/);
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ id: `id-${index}`, revision: 0 }))) }), /fel format/, 'at most 100 items per call');
    assert.ok(await unchanged());
    const store = inbox.controller.store, save = store.save.bind(store);
    store.save = async () => { throw new Error('fixture write failure'); };
    await assert.rejects(inbox.request('correct', { action: 'dismiss-many', items: batch(infos) }), /fixture write failure/);
    store.save = save;
    assert.ok(await unchanged(), 'a failed save rolls back every item in the batch');
    let saves = 0;
    store.save = async (...args) => { saves++; return save(...args); };
    await inbox.request('correct', { action: 'dismiss-many', items: batch(infos) });
    store.save = save;
    assert.equal(saves, 1, 'the whole batch is one save');
    view = (await inbox.request('status')).assistant;
    for (const entry of infos) {
      const saved = view.items.find(item => item.id === entry.id);
      assert.equal(saved.status, 'dismissed'); assert.equal(saved.revision, entry.revision + 1);
    }
    assert.equal(JSON.parse(readFileSync(join(inbox.dir, 'workspace.json'), 'utf8')).state.workspace.items.filter(item => item.status === 'dismissed').length, 3);
    assert.equal(view.items.find(item => item.id === reply.id).status, 'open', 'items outside the batch are untouched');
    // Ångra: a dismissed item opens again at its current revision only.
    const done = view.items.find(item => item.id === infos[0].id);
    await assert.rejects(inbox.request('correct', { action: 'reopen', itemId: done.id, revision: String(done.revision - 1) }), /ändrats/, 'an older revision is refused');
    await inbox.request('correct', { action: 'reopen', itemId: done.id, revision: String(done.revision) });
    view = (await inbox.request('status')).assistant;
    const reopened = view.items.find(item => item.id === done.id);
    assert.equal(reopened.status, 'open'); assert.equal(reopened.revision, done.revision + 1);
    await assert.rejects(inbox.request('correct', { action: 'reopen', itemId: reopened.id, revision: String(reopened.revision) }), /markerat som klart/, 'an open item cannot be reopened');
    await inbox.request('correct', { action: 'feedback', kind: 'no-reply', itemId: reply.id, revision: String(reply.revision) });
    let noReply = (await inbox.request('status')).assistant.items.find(item => item.id === reply.id);
    assert.equal(noReply.status, 'dismissed'); assert.equal(noReply.feedback, 'no-reply');
    await inbox.request('correct', { action: 'reopen', itemId: noReply.id, revision: String(noReply.revision) });
    noReply = (await inbox.request('status')).assistant.items.find(item => item.id === reply.id);
    assert.equal(noReply.status, 'open'); assert.equal(noReply.feedback, undefined, 'Ångra after Inget svar behövs takes the mark back');
    await inbox.request('correct', { action: 'snooze', itemId: noReply.id, revision: String(noReply.revision), until: new Date(Date.now() + 86400000).toISOString() });
    const snoozed = (await inbox.request('status')).assistant.items.find(item => item.id === reply.id);
    await assert.rejects(inbox.request('correct', { action: 'reopen', itemId: snoozed.id, revision: String(snoozed.revision) }), /markerat som klart/, 'a snoozed item is not undone by reopen');
    full = await inbox.request('status');
    assert.deepEqual(full.chat.messages.find(message => message.task).task.counts, { replies: 1, needsYou: 1, info: 3 }, 'the recorded numbers stay a record of that check');
  }
  // The chat's numbers are written as a run becomes review and count only the mail that run found
  // or changed; Klar för alla marks open mail only; information from a prioritized sender needs the user.
  {
    assert.equal(assistantInboxStatus({ status: 'open', kind: 'information', priority: 1 }), 'needs-you', 'information from a prioritized sender is counted like the badge counts it');
    assert.equal(assistantInboxStatus({ status: 'open', kind: 'information', priority: 3 }), 'info');
    const app = create(); await configure(app);
    const info = (thread, priority = 3) => finding({ threadId: thread, kind: 'information', title: `Info ${thread}`, draft: undefined, recipient: undefined, priority, sources: [{ observationId: `read-${thread}`, quote: `Info ${thread}.` }] });
    const message = id => app.controller.view().chat.messages.find(entry => entry.task?.id === id);
    // Mail from an earlier check stays open in Mejl but is not the next run's.
    await app.request('start', { task: 'check-mail' });
    await app.executor.callbacks.finish({ summary: 'En tidigare kontroll.', findings: [finding({ threadId: 'gmail:old-reply', title: 'Äldre svar' }), info('gmail:old-info')], coverage: coverage() });
    const conversationId = (await app.request('status')).chat.id;
    await app.request('correct', { action: 'chat-task', task: 'check-mail', conversationId, messageId: randomUUID() });
    const run = app.controller.view().assistant.current;
    const newInfo = info('gmail:new-info');
    await app.executor.callbacks.checkpoint({ accountId: gmail.id, threadId: newInfo.threadId, messageId: 'message-new-info', sourceUrl: newInfo.sourceUrl, reviewedAt: new Date().toISOString(), outcome: 'needs-action' }, { summary: '', findings: [newInfo], coverage: [] });
    await app.executor.callbacks.finish({ summary: 'Två nya mejl.', findings: [finding({ threadId: 'gmail:new-reply', title: 'Nytt svar' })], coverage: coverage() });
    assert.deepEqual(message(run.id).task.counts, { replies: 1, needsYou: 0, info: 1 }, 'written as the run becomes review, before any poll, from its own mail across checkpoints');
    const reply = app.controller.view().assistant.items.find(item => item.title === 'Nytt svar');
    await app.request('correct', { action: 'dismiss', itemId: reply.id, revision: String(reply.revision) });
    await app.request('status');
    assert.deepEqual(message(run.id).task.counts, { replies: 1, needsYou: 0, info: 1 }, 'the first poll after review never recounts');
    assert.equal(message(run.id).task.status, 'review');
    // Mail-reading tasks always record numbers; prepare-meeting and custom only when they found mail.
    const record = async (task, findings) => {
      await app.request('start', { task, instructions: task === 'custom' ? 'Sammanfatta testmejlen.' : '' });
      const current = app.controller.view().assistant.current;
      await app.controller.chat.recordTask(conversationId, randomUUID(), { id: current.id, label: current.label });
      await app.executor.callbacks.finish({ summary: `${task} är klar.`, findings, coverage: coverage() });
      await app.request('status');
      return message(current.id).task;
    };
    assert.equal((await record('prepare-meeting', [])).counts, undefined, 'a meeting preparation without mail has no numbers');
    assert.equal((await record('custom', [])).counts, undefined, 'a custom task without mail has no numbers');
    assert.deepEqual((await record('custom', [info('gmail:custom-info')])).counts, { replies: 0, needsYou: 0, info: 1 }, 'a custom task that found mail counts that mail');
    assert.deepEqual((await record('my-day', [])).counts, { replies: 0, needsYou: 0, info: 0 }, 'a mail-reading task records numbers even when it found nothing new');
    assert.deepEqual((await record('follow-ups', [info('gmail:vip-info', 1)])).counts, { replies: 0, needsYou: 1, info: 0 }, 'prioritized information counts as needing the user');
    // Klar för alla: a snoozed or already done mail at its current revision refuses the whole batch.
    let items = app.controller.view().assistant.items;
    const oldInfo = items.find(item => item.title === 'Info gmail:old-info'), customInfo = items.find(item => item.title === 'Info gmail:custom-info');
    await app.request('correct', { action: 'snooze', itemId: customInfo.id, revision: String(customInfo.revision), until: new Date(Date.now() + 86_400_000).toISOString() });
    items = app.controller.view().assistant.items;
    const batch = entries => JSON.stringify(entries.map(({ id, revision }) => ({ id, revision })));
    for (const closed of [items.find(item => item.id === customInfo.id), items.find(item => item.id === reply.id)]) {
      await assert.rejects(app.request('correct', { action: 'dismiss-many', items: batch([items.find(item => item.id === oldInfo.id), closed]) }), /inte längre öppet/, `${closed.status} mail is not marked done`);
    }
    items = app.controller.view().assistant.items;
    assert.deepEqual([oldInfo.id, customInfo.id, reply.id].map(id => items.find(item => item.id === id).status), ['open', 'snoozed', 'dismissed'], 'nothing in a refused batch changed');
  }
  // Påminn: 08.00 in the user's time zone, on either side of a daylight saving change.
  assert.equal(assistantReminderAt(new Date('2026-10-24T10:00:00Z'), 'Europe/Stockholm', 'next-week'), '2026-10-26T07:00:00.000Z', 'Saturday before DST ends → Monday 08.00 CET');
  assert.equal(assistantReminderAt(new Date('2026-11-02T06:00:00Z'), 'Europe/Stockholm', 'next-week'), '2026-11-09T07:00:00.000Z', 'Monday → Monday next week');
  assert.equal(assistantReminderAt(new Date('2026-11-08T22:30:00Z'), 'Europe/Stockholm', 'next-week'), '2026-11-09T07:00:00.000Z', 'Sunday 23.30 → the next day, Monday');
  assert.equal(assistantReminderAt(new Date('2026-11-01T23:30:00Z'), 'Europe/Stockholm', 'next-week'), '2026-11-09T07:00:00.000Z', 'Monday 00.30 local, Sunday in UTC → Monday next week');
  assert.equal(assistantReminderAt(new Date('2026-03-28T12:00:00Z'), 'Europe/Stockholm', 'tomorrow'), '2026-03-29T06:00:00.000Z', 'tomorrow 08.00 CEST after DST starts');
  assert.equal(assistantReminderAt(new Date('2026-11-02T23:30:00Z'), 'Europe/Stockholm', 'tomorrow'), '2026-11-04T07:00:00.000Z', 'after local midnight, tomorrow is the next local day');
  assert.equal(assistantReminderAt(new Date('2026-11-02T12:00:00Z'), 'America/New_York', 'next-week'), '2026-11-09T13:00:00.000Z');

  const builtinDir = mkdtempSync(join(tmpdir(), 'tabai-assistant-module-')); dirs.push(builtinDir);
  const host = new PersonalModules(builtinDir, [{ id: 'daily-assistant', command: process.execPath, args: [join(root, 'dist/assistant.js'), root], cwd: root }]); modules.push(host);
  const list = await host.list();
  assert.equal(list[0].id, 'daily-assistant'); assert.equal(list[0].view.assistant.settings.accounts.length, 0);
  assert.equal((await host.request('daily-assistant', 'status', {})).assistant.items.length, 0);
  {
    // A quiet upload chunk goes through the host's queue and the broker's view check, and is
    // answered with the smallest valid view; a chunk from an older panel still gets the full one.
    const conversationId = (await host.request('daily-assistant', 'status', {})).chat.id, fileId = randomUUID();
    const bytes = Buffer.from('Syntetisk bilaga i två delar.\n'.repeat(3000));
    const chunk = offset => ({ action: 'chat-file-chunk', conversationId, fileId, offset: String(offset), fileChunk: bytes.subarray(offset, offset + 48 * 1024).toString('base64') });
    await host.request('daily-assistant', 'correct', { action: 'chat-file-start', conversationId, fileId, name: 'tyst-bilaga.txt', size: String(bytes.length) });
    const small = await host.request('daily-assistant', 'correct', { ...chunk(0), quiet: 'true' });
    assert.deepEqual(Object.keys(small).sort(), ['description', 'fields', 'startLabel', 'title'], 'no workspace, chat or lists');
    assert.ok(Buffer.byteLength(JSON.stringify(small)) < 300, 'the answer to a quiet chunk stays small');
    const full = await host.request('daily-assistant', 'correct', chunk(48 * 1024));
    assert.ok(full.assistant && full.chat, 'an older panel gets the full view it draws');
    assert.equal(full.chat.fileDrafts.find(file => file.id === fileId).received, bytes.length, 'both chunks were stored in order');
    await assert.rejects(host.request('daily-assistant', 'correct', { ...chunk(0), quiet: 'true' }), /./, 'a refused chunk is still reported');
    await host.request('daily-assistant', 'correct', { action: 'chat-file-remove', conversationId, fileId });
  }
  const brokenDir = mkdtempSync(join(tmpdir(), 'tabai-assistant-broken-')); dirs.push(brokenDir);
  writeFileSync(join(brokenDir, 'personal-modules.json'), '{broken');
  const independent = new PersonalModules(brokenDir, [{ id: 'daily-assistant', command: process.execPath, args: [join(root, 'dist/assistant.js'), root], cwd: root }]); modules.push(independent);
  const independentList = await independent.list();
  assert.ok(independentList.find(module => module.id === 'daily-assistant').view.assistant);
  assert.ok(independentList.find(module => module.id === 'personal-module-registry').error);
  {
    // The Claude CLI finds its login in the macOS keychain by user name, so a module needs these; anything else stays out.
    const envDir = mkdtempSync(join(tmpdir(), 'tabai-module-env-')); dirs.push(envDir);
    const report = join(envDir, 'env.json'), script = join(envDir, 'report-env.cjs');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.env)); process.exit(0);`);
    const names = ['USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'], saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, { USER: 'module-user', LOGNAME: 'module-logname', CLAUDE_CONFIG_DIR: '/tmp/module-claude', ANTHROPIC_API_KEY: 'not-for-modules' });
    try {
      const reporter = new PersonalModules(envDir, [{ id: 'env-report', command: process.execPath, args: [script], cwd: envDir }]); modules.push(reporter);
      await reporter.request('env-report', 'status', {}).catch(() => {});
      for (let wait = 0; wait < 100 && !existsSync(report); wait++) await new Promise(resolve => setTimeout(resolve, 50));
      const seen = JSON.parse(readFileSync(report, 'utf8'));
      assert.deepEqual([seen.USER, seen.LOGNAME, seen.CLAUDE_CONFIG_DIR], ['module-user', 'module-logname', '/tmp/module-claude']);
      assert.equal(seen.ANTHROPIC_API_KEY, undefined, 'the allow-list still decides what a module receives');
    } finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
  }
  console.log('assistant-controller: durable settings/drafts, partial cursors, dedup/new evidence, stale revisions/questions, approvals, cancellation, uncertain restart, shortcuts, local settings migration and runtime jobs and real module process passed');
} finally {
  modules.forEach(host => host.close());
  await Promise.all(controllers.map(controller => controller.close()));
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const dir of new Set(dirs)) rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
