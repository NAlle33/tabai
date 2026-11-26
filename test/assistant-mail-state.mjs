// Mail state: an uncertain send the user resolves after checking Sent, later mail in its
// thread, automatic acknowledgements that are never repeated, answers that are kept only
// together with their follow-up, saving that does not depend on the chat's size, the
// attention badge after a snooze and the cleanup of private scan journals.
// Every section runs on its own and reports its own failure.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantController } from '../dist/assistant-controller.mjs';
import { watchdog } from './watchdog.mjs';

// Many controller sections with restarts run about 9 s.
const stopWatchdog = watchdog(async () => {
  await Promise.all(controllers.map(controller => controller.close().catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const dir of new Set(dirs)) rmSync(dir, { recursive: true, force: true });
}, 120_000);
const root = process.cwd(), dirs = [], controllers = [], failures = [];
const terminalCallbacks = callbacks => ({ ...callbacks,
  async finish(result) { await callbacks.finish(result); await callbacks.settled?.(); },
  async help(help) { await callbacks.help(help); await callbacks.settled?.(); },
  async exit(...args) { await callbacks.exit(...args); await callbacks.settled?.(); },
});
function create(dir, effects = {}) {
  dir ??= mkdtempSync(join(tmpdir(), 'tabai-mail-state-')); dirs.push(dir);
  const executor = {
    starts: [],
    async start(context, callbacks) { callbacks = terminalCallbacks(callbacks); this.starts.push({ context, callbacks }); this.context = context; this.callbacks = callbacks; this.onStart?.(context, callbacks); },
    async stop() {}, async close() {}, async open() {},
  };
  const notices = [];
  const controller = new AssistantController(root, dir, executor, { notice: notice => notices.push(notice), ...effects }); controllers.push(controller);
  return { controller, executor, dir, notices, request: (op, input = {}) => controller.request(op, input) };
}
const gmail = { id: 'gmail-test', label: 'Testkonto', provider: 'gmail', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/?authuser=owner%40example.test', enabled: true };
const outlook = { id: 'outlook-test', label: 'Andra kontot', provider: 'outlook', email: 'owner2@example.test', url: 'https://outlook.live.com/mail/0/', enabled: true };
const zoho = { id: 'zoho-test', label: 'Tredje kontot', provider: 'zoho', email: 'third@example.test', url: 'https://mail.zoho.eu/zm/', enabled: true };
const finding = (overrides = {}) => ({
  accountId: gmail.id, threadId: 'gmail:thread-123', kind: 'reply', title: 'Beslut om möte',
  summary: 'Ett besked behövs.', reason: 'Avsändaren ber om ett svar.', priority: 1,
  sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/abcdef1234567890', recipient: 'sender@example.test',
  draft: 'Tack! Jag återkommer med besked.', sources: [{ observationId: 'read-1', quote: 'Kan du ge besked om mötet?' }], ...overrides,
});
const coverage = (accountId = gmail.id) => [{ accountId, status: 'checked', message: 'Kontrollerat.' }];
async function configure(app, accounts = [gmail], extra = {}) {
  const current = (await app.request('status')).assistant;
  return app.request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, accounts, ...extra }) });
}
/** One finished check: every account step reports its own findings and full coverage. */
async function scan(app, findings = [finding()]) {
  await app.request('start', { task: 'check-mail' });
  for (let count = 0; count < 12; count++) {
    const accountId = app.executor.context.run.accountId ?? app.executor.context.run.coverage[0].accountId;
    await app.executor.callbacks.finish({ summary: 'Granska resultatet.', findings: findings.filter(item => item.accountId === accountId), coverage: coverage(accountId) });
    if ((await app.request('status')).assistant.current.status !== 'running') break;
  }
  return (await app.request('status')).assistant;
}
const stored = app => JSON.parse(readFileSync(join(app.dir, 'workspace.json'), 'utf8')).state;
const settle = async app => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await app.request('status'); } };
const sendStarts = app => app.executor.starts.filter(start => start.context.run.task === 'send').length;
/**
 * Resolves with the callbacks of the next send run; an automatic acknowledgement starts from a
 * timer. The deadline only keeps a missing send from hanging the suite; it times nothing.
 */
const nextSend = app => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error('no send started')), 15_000);
  app.executor.onStart = (context, callbacks) => { if (context.run.task === 'send') { clearTimeout(deadline); app.executor.onStart = undefined; resolve(callbacks); } };
});
const resolve = (app, item, outcome, revision = item.revision) => app.request('correct', { action: 'resolve-uncertain', itemId: item.id, revision: String(revision), outcome });
async function uncertain(app, findings = [finding({ messageId: 'gmail:message:1' })], body = 'Godkänt svar.') {
  const item = (await scan(app, findings)).items.find(entry => entry.threadId === findings[0].threadId);
  await app.request('correct', { action: 'send', itemId: item.id, revision: String(item.revision), recipient: item.recipient, body });
  const callbacks = app.executor.callbacks;
  await callbacks.sendIntent(); await callbacks.exit('Bekräftelsen uteblev.');
  const locked = (await app.request('status')).assistant.items.find(entry => entry.id === item.id);
  assert.equal(locked.status, 'uncertain');
  return { item: locked, callbacks };
}
async function section(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.error(`not ok - ${name}\n${error?.stack ?? error}`); }
}

try {
  await section('a later message in a thread whose send is uncertain is kept on the item, and "was sent" makes it the open item', async () => {
    const app = create(); await configure(app);
    let { item } = await uncertain(app);
    let view = await scan(app, [finding({ messageId: 'gmail:message:1' })]);
    assert.equal(view.items[0].pendingFinding, undefined, 'the same message read again is still ignored');
    assert.equal(view.items[0].revision, item.revision);
    view = await scan(app, [finding({ messageId: 'gmail:message:2', title: 'Ny fråga i tråden', question: 'Kan vi ses på torsdag?', draft: undefined, sources: [{ observationId: 'read-2', quote: 'Kan vi ses på torsdag?' }] })]);
    item = view.items[0];
    assert.equal(item.status, 'uncertain', 'the send stays locked');
    assert.deepEqual([item.pendingFinding?.messageId, item.pendingFinding?.question], ['gmail:message:2', 'Kan vi ses på torsdag?'], 'the later message is kept on the item');
    const starts = app.executor.starts.length;
    await assert.rejects(resolve(app, item, 'sent', item.revision - 1), /ändrats/, 'a stale revision is refused');
    await assert.rejects(resolve(app, item, 'kanske'), 'an unknown outcome is refused');
    assert.equal((await app.request('status')).assistant.items[0].status, 'uncertain');
    await resolve(app, item, 'sent');
    const open = (await app.request('status')).assistant.items[0];
    // A reply has been on its way out in this thread, so only the user's own approval sends in it again.
    assert.deepEqual([open.status, open.messageId, open.title, open.question, open.pendingFinding, open.sendLocked], ['open', 'gmail:message:2', 'Ny fråga i tråden', 'Kan vi ses på torsdag?', undefined, true]);
    assert.ok(open.revision > item.revision);
    await assert.rejects(resolve(app, open, 'not-sent'), /osäkert utskick/, 'an open item cannot be resolved');
    assert.equal(app.executor.starts.length, starts, 'resolving starts no run');
  });

  await section('"was sent" closes the item as sent; "was not sent" reopens it with its draft and a send needs a new approval', async () => {
    const sentApp = create(); await configure(sentApp);
    const { item: sentItem } = await uncertain(sentApp);
    const sentStarts = sentApp.executor.starts.length;
    await resolve(sentApp, sentItem, 'sent');
    const closed = (await sentApp.request('status')).assistant.items[0];
    assert.deepEqual([closed.status, closed.sendLocked], ['sent', true]);
    assert.ok(closed.sendReceipt);
    await assert.rejects(resolve(sentApp, closed, 'not-sent'), /osäkert utskick/, 'a sent item is never resolved again');
    assert.equal(sentApp.executor.starts.length, sentStarts);

    const app = create(); await configure(app);
    const { item, callbacks } = await uncertain(app, [finding({ messageId: 'gmail:message:1' }), finding({ threadId: 'gmail:other', messageId: 'gmail:message:9', title: 'Annat mejl' })]);
    const other = (await app.request('status')).assistant.items.find(entry => entry.threadId === 'gmail:other');
    await app.request('correct', { action: 'dismiss', itemId: other.id, revision: String(other.revision) });
    const dismissed = (await app.request('status')).assistant.items.find(entry => entry.id === other.id);
    const attempt = stored(app).sendAttempt, starts = app.executor.starts.length;
    await assert.rejects(resolve(app, dismissed, 'not-sent'), /osäkert utskick/, 'a dismissed item cannot be resolved');
    await resolve(app, item, 'not-sent');
    const reopened = (await app.request('status')).assistant.items.find(entry => entry.id === item.id);
    assert.deepEqual([reopened.status, reopened.draft, reopened.sendLocked, reopened.sendReceipt], ['open', 'Godkänt svar.', true, undefined]);
    assert.equal(app.executor.starts.length, starts, 'resolving starts no run');
    await assert.rejects(callbacks.sendIntent(), 'the earlier approval can never dispatch');
    assert.deepEqual(stored(app).sendAttempt, attempt, 'the earlier attempt is not touched');
    assert.equal((await app.request('status')).assistant.items.find(entry => entry.id === item.id).status, 'open');
    assert.equal(app.executor.starts.length, starts);
    // Only the user's own new approval on the card starts a send, with a fresh attempt.
    await app.request('correct', { action: 'send', itemId: reopened.id, revision: String(reopened.revision), recipient: reopened.recipient, body: reopened.draft });
    assert.equal(app.executor.starts.length, starts + 1);
    assert.equal(app.executor.context.approval.revision, reopened.revision + 1);
    assert.notEqual(stored(app).sendAttempt.id, attempt.id); assert.equal(stored(app).sendAttempt.dispatchedAt, undefined);
  });

  await section('"was not sent" with a later message turns that message into the open item', async () => {
    const app = create(); await configure(app);
    let { item } = await uncertain(app);
    item = (await scan(app, [finding({ messageId: 'gmail:message:2', draft: 'Nytt förslag.', sources: [{ observationId: 'read-2', quote: 'En ny fråga.' }] })])).items[0];
    const starts = app.executor.starts.length;
    await resolve(app, item, 'not-sent');
    const open = (await app.request('status')).assistant.items[0];
    assert.deepEqual([open.status, open.messageId, open.draft, open.pendingFinding, open.sendLocked], ['open', 'gmail:message:2', 'Nytt förslag.', undefined, true]);
    assert.equal(app.executor.starts.length, starts);
  });

  await section('a follow-up reminder for a thread whose send is uncertain is not kept as a new message; a reply and an information finding are', async () => {
    const app = create(); await configure(app);
    const { item } = await uncertain(app);
    // A reminder is about the account's own latest message, which may be the uncertain reply itself.
    let view = await scan(app, [finding({ kind: 'followup', messageId: 'gmail:message:2', title: 'Påminn om svaret', sources: [{ observationId: 'read-2', quote: 'Godkänt svar.' }] })]);
    let locked = view.items.find(entry => entry.id === item.id);
    assert.deepEqual([locked.status, locked.pendingFinding, locked.revision], ['uncertain', undefined, item.revision], 'the reminder leaves the item as it was');
    assert.equal(view.items.length, 1, 'and makes no item of its own');
    view = await scan(app, [
      finding({ messageId: 'gmail:message:3', title: 'Ny fråga i tråden', sources: [{ observationId: 'read-3', quote: 'En ny fråga.' }] }),
      finding({ kind: 'information', messageId: 'gmail:message:3', title: 'För kännedom i tråden', priority: 3, draft: undefined, sources: [{ observationId: 'read-3', quote: 'En ny fråga.' }] }),
    ]);
    locked = view.items.find(entry => entry.id === item.id);
    assert.deepEqual([locked.status, locked.pendingFinding?.kind, locked.pendingFinding?.messageId], ['uncertain', 'reply', 'gmail:message:3'], 'a later reply waits on the item');
    const information = view.items.find(entry => entry.kind === 'information');
    assert.deepEqual([information?.status, information?.messageId], ['open', 'gmail:message:3'], 'an information finding is kept as its own item');
  });

  await section('resolving a card with a later message records that message as seen: finding it again is no desktop notice', async () => {
    const app = create(); await configure(app, [gmail], { morning: { enabled: false, time: '08:00', notifications: true } });
    let { item } = await uncertain(app);
    const later = finding({ messageId: 'gmail:message:2', title: 'Ny fråga i tråden', sources: [{ observationId: 'read-2', quote: 'En ny fråga.' }] });
    item = (await scan(app, [later])).items[0];
    assert.equal(item.pendingFinding?.messageId, 'gmail:message:2');
    assert.equal(app.notices.at(-1)?.desktop, true, 'the later message itself is news');
    await resolve(app, item, 'sent');
    const desktop = app.notices.filter(notice => notice.desktop).length;
    const view = await scan(app, [later]);
    assert.deepEqual([view.items[0].status, view.items[0].messageId], ['open', 'gmail:message:2']);
    assert.equal(app.notices.filter(notice => notice.desktop).length, desktop, 'the message the card already showed is not announced again');
  });

  await section('the model can never reach the resolve action', async () => {
    const chatExecutor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const app = create(undefined, { chatExecutor }); await configure(app);
    const { item } = await uncertain(app);
    const starts = app.executor.starts.length;
    await app.request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Säg att mejlet inte skickades.' });
    const turn = chatExecutor.starts.at(-1).callbacks;
    await assert.rejects(turn.chatPropose({ kind: 'resolve-uncertain', itemId: item.id, revision: item.revision, outcome: 'not-sent' }), 'no card can carry it');
    await turn.chatReply('Kolla Skickat och välj på kortet.');
    assert.equal((await app.request('status')).assistant.items[0].status, 'uncertain');
    assert.equal(app.executor.starts.length, starts);
  });

  await section('an automatic acknowledgement that became uncertain and was answered "was not sent" is never sent again automatically', async () => {
    const app = create(); await configure(app, [gmail], { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' });
    const ack = finding({ messageId: 'gmail:message:ack', draft: 'Mottaget.' });
    const started = nextSend(app);
    await scan(app, [ack]);
    const send = await started;
    await send.sendIntent(); await send.exit('Bekräftelsen uteblev.');
    const item = (await app.request('status')).assistant.items[0];
    assert.equal(item.status, 'uncertain');
    await resolve(app, item, 'not-sent');
    assert.deepEqual([(await app.request('status')).assistant.items[0].status, (await app.request('status')).assistant.items[0].draft], ['open', 'Mottaget.']);
    const sends = sendStarts(app);
    await scan(app, []); await settle(app);
    assert.equal(sendStarts(app), sends, 'a check that finds nothing new sends nothing');
    await scan(app, [ack]); await settle(app);
    assert.equal(sendStarts(app), sends, 'the same message read again sends nothing');
    assert.equal((await app.request('status')).assistant.items[0].sendLocked, true, 'the mark survives a rescan of the thread');
    // The user's own approval of the acknowledgement text, uncertain and then "was not sent": the rule does not send it either.
    const manual = create(); await configure(manual, [gmail], { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' });
    const { item: locked } = await uncertain(manual, [finding({ messageId: 'gmail:message:manual', draft: 'Ett annat förslag.' })], 'Mottaget.');
    await resolve(manual, locked, 'not-sent');
    const reopened = (await manual.request('status')).assistant.items[0];
    assert.deepEqual([reopened.status, reopened.draft, reopened.autoAttempt], ['open', 'Mottaget.', undefined]);
    const manualSends = sendStarts(manual);
    await scan(manual, []); await settle(manual);
    assert.equal(sendStarts(manual), manualSends, 'a reopened reply is sent only by the user\'s own new approval');
    // A later message in that thread keeps the mark: the thread's reply never went out.
    await scan(manual, [finding({ messageId: 'gmail:message:later', draft: 'Mottaget.', sources: [{ observationId: 'read-2', quote: 'En ny fråga.' }] })]); await settle(manual);
    assert.equal(sendStarts(manual), manualSends, 'a later message after "was not sent" is the user\'s to send');
    assert.deepEqual([(await manual.request('status')).assistant.items[0].messageId, (await manual.request('status')).assistant.items[0].sendLocked], ['gmail:message:later', true]);
  });

  await section('after an automatic acknowledgement went out, every later card in its thread is sent only by the user\'s own approval', async () => {
    const rule = { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' };
    const acknowledged = async () => {
      const app = create(); await configure(app, [gmail], rule);
      const first = nextSend(app);
      await scan(app, [finding({ messageId: 'gmail:message:1', draft: 'Mottaget.' })]);
      const send = await first;
      await send.sendIntent(); await send.sent('Tjänsten visar Meddelandet har skickats.');
      assert.deepEqual([(await app.request('status')).assistant.items[0].status, sendStarts(app)], ['sent', 1]);
      return app;
    };
    // A different message identity does not prove a later inbound message: it can be the
    // account's own reply, sent from an alias or read through a provider view.
    const later = {
      'the same message read with other wording': finding({ messageId: 'gmail:message:1', draft: 'Mottaget.', sources: [{ observationId: 'read-2', quote: 'Kan du bekräfta att du har fått mejlet?' }] }),
      'a message without an identity': finding({ draft: 'Mottaget.', sources: [{ observationId: 'read-3', quote: 'Ett meddelande utan identitet.' }] }),
      'a later message with another message identity': finding({ messageId: 'gmail:message:2', draft: 'Mottaget.', sources: [{ observationId: 'read-4', quote: 'Tack, här kommer en fråga till.' }] }),
    };
    let last;
    for (const [label, message] of Object.entries(later)) {
      const app = await acknowledged();
      await scan(app, [message]); await settle(app);
      const card = (await app.request('status')).assistant.items[0];
      assert.deepEqual([card.status, card.sendLocked, sendStarts(app)], ['open', true, 1], `${label} reopens the card and starts no send`);
      last = { app, card };
    }
    // The user's own approval on that card still sends.
    const { app, card } = last;
    await app.request('correct', { action: 'send', itemId: card.id, revision: String(card.revision), recipient: card.recipient, body: card.draft });
    assert.deepEqual([sendStarts(app), app.executor.context.approval.itemId, app.executor.context.approval.revision], [2, card.id, card.revision + 1]);
    const send = app.executor.callbacks;
    await send.sendIntent(); await send.sent('Tjänsten visar Meddelandet har skickats.');
    assert.equal((await app.request('status')).assistant.items[0].status, 'sent');
  });

  await section('automatic acknowledgements: providers that cannot send are skipped, a failed attempt is not repeated, alias and outside recipients and an open question start nothing', async () => {
    const rule = { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' };
    const outlookApp = create(); await configure(outlookApp, [outlook], rule);
    await scan(outlookApp, [finding({ accountId: outlook.id, threadId: 'outlook:thread-1', messageId: 'outlook:message-1', sourceUrl: 'https://outlook.live.com/mail/0/inbox/id/abc', draft: 'Mottaget.' })]); await settle(outlookApp);
    assert.equal(sendStarts(outlookApp), 0, 'Outlook replies stop before Reply, so no automatic attempt starts');

    const zohoApp = create(); await configure(zohoApp, [zoho], rule);
    await scan(zohoApp, [finding({ accountId: zoho.id, threadId: 'zoho:thread-web', messageId: 'zoho:message:web', sourceUrl: 'https://mail.zoho.eu/zm/#mail/folder/inbox/p/1', draft: 'Mottaget.' })]); await settle(zohoApp);
    assert.equal(sendStarts(zohoApp), 0, 'a Zoho card its API cannot confirm is skipped');
    const zohoSend = nextSend(zohoApp);
    await scan(zohoApp, [finding({ accountId: zoho.id, threadId: 'zoho:1234', messageId: 'zoho:message:5678', sourceUrl: 'https://mail.zoho.eu/zm/#mail/folder/inbox/p/2', draft: 'Mottaget.' })]);
    await zohoSend;
    assert.equal(sendStarts(zohoApp), 1, 'a Zoho card its API can confirm is still eligible');

    const app = create(); await configure(app, [gmail], rule);
    const started = nextSend(app);
    await scan(app, [finding({ messageId: 'gmail:message:ack', draft: 'Mottaget.' })]);
    await (await started).exit('Svarsrutan kunde inte verifieras. Inget skickades.');
    const failed = (await app.request('status')).assistant.items[0];
    assert.equal(failed.status, 'open');
    await scan(app, []); await settle(app);
    assert.equal(sendStarts(app), 1, 'a failed automatic attempt is not repeated at the next check');
    await app.controller.close();
    const restarted = create(app.dir);
    await restarted.request('status');
    await scan(restarted, []); await settle(restarted);
    assert.equal(sendStarts(restarted), 0, 'nor after a restart');

    const alias = create(); await configure(alias, [gmail], rule);
    await scan(alias, [finding({ messageId: 'gmail:message:alias', draft: 'Mottaget.', replyFrom: 'alias@example.test' })]); await settle(alias);
    assert.equal(sendStarts(alias), 0, 'a card that sends from an alias is the user\'s decision');
    const outside = create(); await configure(outside, [gmail], rule);
    await scan(outside, [finding({ messageId: 'gmail:message:outside', draft: 'Mottaget.', recipient: 'stranger@example.test' })]); await settle(outside);
    assert.equal(sendStarts(outside), 0, 'a recipient outside the list is the user\'s decision');
    const asking = create(); await configure(asking, [gmail], rule);
    await scan(asking, [finding({ messageId: 'gmail:message:asking', draft: 'Mottaget.', question: 'Vilken dag passar dig?' })]); await settle(asking);
    assert.equal(sendStarts(asking), 0, 'a card with an open question is the user\'s to answer');
  });

  await section('a card without its message identity starts no automatic acknowledgement', async () => {
    const rule = { autoAcknowledgements: true, acknowledgementRecipients: ['sender@example.test'], acknowledgementBody: 'Mottaget.' };
    const app = create(); await configure(app, [gmail], rule);
    // The send refuses an approval without the message it answers, so an attempt could only fail.
    await scan(app, [finding({ draft: 'Mottaget.' })]); await settle(app);
    assert.deepEqual([(await app.request('status')).assistant.items[0].status, sendStarts(app)], ['open', 0]);
    const identified = create(); await configure(identified, [gmail], rule);
    const started = nextSend(identified);
    await scan(identified, [finding({ messageId: 'gmail:message:ack', draft: 'Mottaget.' })]);
    await started;
    assert.equal(sendStarts(identified), 1, 'the same card with its identity is still eligible');
  });

  await section('an answer is kept only together with its follow-up run', async () => {
    const app = create(); await configure(app, [gmail, outlook]);
    const item = (await scan(app, [finding({ question: 'Vilken tid passar dig?' })])).items[0];
    await app.request('start', { task: 'my-day' });
    const starts = app.executor.starts.length;
    await assert.rejects(app.request('reply', { itemId: item.id, revision: String(item.revision), answer: 'Klockan 14.' }), /arbetar redan/);
    const after = (await app.request('status')).assistant.items.find(entry => entry.id === item.id);
    assert.deepEqual([after.answer, after.question, after.revision], [undefined, 'Vilken tid passar dig?', item.revision], 'the card still asks the question');
    assert.equal(stored(app).answers.length, 0);
    assert.equal(app.executor.starts.length, starts);
    await app.request('stop');
    // The run's own question: with every account turned off the answer is refused before it is kept.
    await app.request('start', { task: 'prepare-meeting' });
    await app.executor.callbacks.question('Vilket möte gäller det?', gmail.id);
    const run = (await app.request('status')).assistant.current;
    await configure(app, []);
    await assert.rejects(app.request('reply', { questionId: run.questionId, answer: 'Det första.' }), /aktivt mejlkonto/);
    assert.equal(stored(app).answers.length, 0, 'the run question\'s answer is not kept either');
    const waiting = (await app.request('status')).assistant.current;
    assert.deepEqual([waiting.id, waiting.status, waiting.questionId], [run.id, 'waiting', run.questionId]);
  });

  await section('an answer to a check\'s own question is refused before it is kept when the check\'s scope changed while it waited', async () => {
    const app = create(); await configure(app);
    await app.request('start', { task: 'check-mail' });
    await app.executor.callbacks.question('Vilken period gäller det?', gmail.id);
    const run = (await app.request('status')).assistant.current, lookbackDays = (await app.request('status')).assistant.settings.lookbackDays;
    const starts = app.executor.starts.length;
    await configure(app, [gmail], { lookbackDays: lookbackDays + 7 });
    await assert.rejects(app.request('reply', { questionId: run.questionId, answer: 'Den senaste veckan.' }), /Konton eller kontrollens omfattning har ändrats/);
    assert.deepEqual(stored(app).answers, [], 'the answer is not kept');
    const waiting = (await app.request('status')).assistant.current;
    assert.deepEqual([waiting.id, waiting.status, waiting.questionId, waiting.question], [run.id, 'waiting', run.questionId, 'Vilken period gäller det?'], 'the check still asks its question');
    assert.equal(app.executor.starts.length, starts, 'no run starts');
    // With the scope the check started with, the same answer is kept and its follow-up runs.
    await configure(app, [gmail], { lookbackDays });
    await app.request('reply', { questionId: run.questionId, answer: 'Den senaste veckan.' });
    assert.deepEqual([stored(app).answers.length, app.executor.starts.length, app.executor.context.run.resumedFrom], [1, starts + 1, run.id]);
  });

  /**
   * A host whose workspace view is just under the panel limit, with a small conversation selected
   * and a long one the chat accepts beside it: selecting the long one makes the panel view too large.
   */
  async function largeConversationHost() {
    const wide = '語', at = '2026-11-20T08:00:00.000Z';
    const app = create(); await configure(app);
    await scan(app, [finding({ messageId: 'gmail:message:1' }), finding({ threadId: 'gmail:thread-checkpoint', messageId: 'gmail:message:2' })]);
    await app.controller.close();
    const file = join(app.dir, 'workspace.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    const workspace = saved.state.workspace;
    workspace.shortcuts = Array.from({ length: 24 }, (_, index) => ({ id: `shortcut-${index}`, label: wide.repeat(100), instructions: wide.repeat(12000) }));
    const run = index => ({ id: randomUUID(), task: 'check-mail', label: wide.repeat(200), status: 'review', message: wide.repeat(500), summary: wide.repeat(2000), startedAt: at, updatedAt: at, threadId: 'x'.repeat(500), model: 'm'.repeat(200),
      activity: { stage: 'complete', message: wide.repeat(1000), updatedAt: at, reviewedThreads: index },
      coverage: Array.from({ length: 12 }, (_, account) => ({ accountId: `account-${account}`, status: 'checked', message: wide.repeat(300) })), canContinue: false });
    // The two oldest runs are small: the runs this test starts push them out, so the view's size stays put.
    workspace.history = [...Array.from({ length: 18 }, (_, index) => run(index)), ...[0, 1].map(() => ({ ...run(0), label: 'Liten', message: '', summary: '', threadId: undefined, model: undefined, activity: undefined, coverage: [] }))];
    workspace.cases = Array.from({ length: 10 }, () => ({ id: randomUUID(), revision: 0, title: wide.repeat(200), description: wide.repeat(2000), status: 'open', nextAction: wide.repeat(1000), waitingFor: wide.repeat(300), links: [], createdAt: at, updatedAt: at }));
    workspace.settings.tone = wide.repeat(2000);
    workspace.settings.acknowledgementBody = wide.repeat(2000);
    workspace.settings.preferences = { shortReplies: false, senderRules: Array.from({ length: 100 }, (_, index) => ({ accountId: gmail.id, email: `${'a'.repeat(200)}${index}@example.test`, priority: 'normal' })) };
    writeFileSync(file, JSON.stringify(saved));
    const message = text => ({ id: randomUUID(), role: 'user', text, createdAt: at, status: 'complete' });
    const small = { id: randomUUID(), title: 'Kort samtal', createdAt: at, updatedAt: at, messages: [message('Hej.')] };
    const large = { id: randomUUID(), title: 'Långt samtal', createdAt: at, updatedAt: at, messages: [...Array.from({ length: 8 }, () => message(wide.repeat(16000))), message(wide.repeat(4000))] };
    assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 400_000, 'a conversation the chat itself accepts');
    writeFileSync(join(app.dir, 'chat.json'), JSON.stringify({ chat: { version: 2, selected: small.id, conversations: [small, large], memories: [] } }));

    const host = create(app.dir);
    const projection = Buffer.byteLength(JSON.stringify((await host.request('status')).assistant));
    assert.ok(projection < 1_800_000 && projection + 400_000 > 1_800_000, `the workspace's own view is under the panel limit, but not with the conversation (${projection} bytes)`);
    return { host, small, large, select: id => host.request('correct', { action: 'chat-select', conversationId: id }) };
  }

  await section('saving mail state does not depend on the size of the selected conversation', async () => {
    const { host, small, large, select } = await largeConversationHost();
    // A check, then the long conversation is selected while it runs.
    await host.request('start', { task: 'check-mail' });
    const check = host.executor.callbacks, runId = host.executor.context.run.id;
    await assert.rejects(select(large.id), /Panelens underlag är för stort/, 'the panel view keeps its own limit');
    const item = stored(host).workspace.items.find(entry => entry.threadId === 'gmail:thread-checkpoint');
    await check.checkpoint({ accountId: gmail.id, threadId: item.threadId, messageId: 'gmail:message:2', sourceUrl: item.sourceUrl, reviewedAt: new Date().toISOString(), outcome: 'no-action' }, { summary: '', findings: [], coverage: [] });
    assert.equal(stored(host).workspace.current.checkpoints.length, 1, 'checkpoint is saved');
    await check.exit('Agenten avslutades.');
    assert.deepEqual([stored(host).workspace.current.id, stored(host).workspace.current.status], [runId, 'failed'], 'exit is saved');
    // An approved send, then the long conversation is selected before it reports.
    await select(small.id);
    const reply = stored(host).workspace.items.find(entry => entry.threadId === 'gmail:thread-123');
    await host.request('correct', { action: 'send', itemId: reply.id, revision: String(reply.revision), recipient: reply.recipient, body: 'Godkänt.' });
    const send = host.executor.callbacks;
    await assert.rejects(select(large.id), /Panelens underlag är för stort/);
    await send.sendIntent();
    await send.sent('Tjänsten visar Meddelandet har skickats.');
    assert.equal(stored(host).workspace.items.find(entry => entry.id === reply.id).status, 'sent', 'sent is saved');
  });

  await section('an action requested while the panel view is too large claims no outcome; a view alone keeps its message', async () => {
    const { host, small, large, select } = await largeConversationHost();
    // The operation returned, but a start the executor refused returns too: the message neither says
    // the action was carried out nor invites a plain retry that could repeat it.
    const done = error => error.message === 'Begäran togs emot och kan redan vara utförd. Panelens underlag är för stort för att visas säkert, så resultatet visas först när ett mindre samtal är valt i chatten. Kontrollera resultatet innan du försöker igen.'
      && !/är utförd/.test(error.message) && !/försök igen/.test(error.message);
    // Selecting the long conversation is itself saved before the view is refused.
    await assert.rejects(select(large.id), done);
    await assert.rejects(host.request('status'), /försök igen\. Inga sparade uppgifter kastades bort\.$/, 'a poll carried out nothing');
    const item = stored(host).workspace.items.find(entry => entry.threadId === 'gmail:thread-checkpoint');
    await assert.rejects(host.request('correct', { action: 'dismiss', itemId: item.id, revision: String(item.revision) }), done);
    assert.equal(stored(host).workspace.items.find(entry => entry.id === item.id).status, 'dismissed', 'the action is saved');
    // With a smaller conversation selected the panel shows its view again.
    assert.ok((await select(small.id)).assistant);
    assert.ok((await host.request('status')).assistant);
  });

  await section('a workspace with 100 maximum-size items and 20 full history runs still saves', async () => {
    const at = '2026-11-20T08:00:00.000Z';
    const app = create(); await configure(app); await scan(app); await app.controller.close();
    const file = join(app.dir, 'workspace.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    const workspace = saved.state.workspace;
    workspace.items = Array.from({ length: 100 }, (_, index) => ({ ...finding({ threadId: `gmail:large-${index}`, messageId: `gmail:message:large-${index}`, title: 't'.repeat(300), summary: 's'.repeat(4000), reason: 'r'.repeat(2000), draft: 'd'.repeat(12000),
      question: 'q'.repeat(2000), sender: 'f'.repeat(300), deadline: 'e'.repeat(120), sources: Array.from({ length: 6 }, (_, source) => ({ observationId: `large-${index}-${source}`, quote: 'c'.repeat(1000) })) }),
      id: `large-${index}`, revision: 0, status: 'open', updatedAt: at, answer: 'a'.repeat(4000) }));
    workspace.history = Array.from({ length: 20 }, (_, index) => ({ id: randomUUID(), task: 'check-mail', label: 'l'.repeat(200), status: 'review', message: 'm'.repeat(500), summary: 's'.repeat(2000), startedAt: at, updatedAt: at,
      coverage: Array.from({ length: 12 }, (_, account) => ({ accountId: `account-${account}`, status: 'checked', message: 'c'.repeat(300) })), accountProgress: [{ accountId: gmail.id, reviewedThreads: index }], canContinue: false }));
    writeFileSync(file, JSON.stringify(saved));
    const host = create(app.dir);
    await host.request('correct', { action: 'save-shortcut', label: 'Prov', instructions: 'Läs bara.' });
    assert.equal(stored(host).workspace.shortcuts.length, 1);
    assert.equal(stored(host).workspace.items.length, 100);
  });

  await section('an expired snooze counts in the attention badge again', async () => {
    const app = create(); await configure(app);
    const item = (await scan(app)).items[0];
    await app.request('correct', { action: 'snooze', itemId: item.id, revision: String(item.revision), until: new Date(Date.now() + 86_400_000).toISOString() });
    const before = (await app.request('status')).assistant.attention.count;
    const realNow = Date.now;
    let view;
    try { Date.now = () => realNow() + 2 * 86_400_000; view = (await app.request('status')).assistant; } finally { Date.now = realNow; }
    assert.equal(view.items[0].status, 'open');
    assert.equal(view.attention.count, before + 1, 'the reopened mail is counted');
    assert.equal(app.notices.at(-1)?.count, before + 1, 'the badge hears about it');
  });

  await section('a scan journal is removed when its run leaves the history or its scan is fully checked', async () => {
    const journal = (app, id) => join(app.dir, 'scans', `${id}.json`);
    const app = create(); await configure(app, [gmail, outlook]);
    await app.request('start', { task: 'my-day' });
    const first = app.executor.context.run.id;
    await app.request('stop'); await app.request('start', { task: 'my-day' });
    assert.ok(existsSync(journal(app, first)), 'an unfinished run keeps its journal');
    for (let index = 0; index < 20; index++) { await app.request('stop'); await app.request('start', { task: 'my-day' }); }
    assert.ok(!(await app.request('status')).assistant.history.some(entry => entry.id === first));
    assert.ok(!existsSync(journal(app, first)), 'the journal leaves with its run');
    assert.ok(readdirSync(join(app.dir, 'scans')).filter(name => name.endsWith('.json')).length <= 20);
    await app.request('stop');

    const checked = create(); await configure(checked, [gmail, outlook]);
    await checked.request('start', { task: 'check-mail' });
    await checked.executor.callbacks.finish({ summary: 'Första kontot klart.', findings: [], coverage: coverage(gmail.id) });
    const partial = (await checked.request('status')).assistant.current.id;
    await checked.request('stop'); await checked.request('start', { task: 'my-day' }); await checked.request('stop');
    assert.ok(existsSync(journal(checked, partial)));
    await checked.request('resume', { runId: partial });
    await checked.executor.callbacks.finish({ summary: 'Andra kontot klart.', findings: [], coverage: coverage(outlook.id) });
    assert.ok((await checked.request('status')).assistant.current.coverage.every(entry => entry.status === 'checked'));
    assert.ok(!existsSync(journal(checked, partial)), 'a fully checked scan needs no journal');
  });

  await section('at start, journals no run refers to and old worker directories are removed', async () => {
    const app = create(); await configure(app, [gmail, outlook]);
    await app.request('start', { task: 'my-day' });
    const kept = app.executor.context.run.id;
    await app.request('stop'); await app.request('start', { task: 'my-day' }); await app.request('stop');
    await app.controller.close();
    const scans = join(app.dir, 'scans'), orphan = randomUUID();
    writeFileSync(join(scans, `${orphan}.json`), '{}'); writeFileSync(join(scans, `${orphan}.json.bak`), '{}');
    writeFileSync(join(scans, 'notes.txt'), 'not a journal');
    const old = join(app.dir, 'worker-0123456789abcdef'), recent = join(app.dir, 'worker-fedcba9876543210');
    mkdirSync(old); writeFileSync(join(old, 'config.toml'), ''); mkdirSync(recent);
    const hours = (Date.now() - 2 * 3_600_000) / 1000; utimesSync(old, hours, hours);
    const restarted = create(app.dir);
    await restarted.request('status');
    assert.ok(existsSync(join(scans, `${kept}.json`)), 'a journal the history refers to stays');
    assert.ok(!existsSync(join(scans, `${orphan}.json`)) && !existsSync(join(scans, `${orphan}.json.bak`)), 'an unreferenced journal is removed');
    assert.ok(existsSync(join(scans, 'notes.txt')), 'only journals are touched');
    assert.ok(!existsSync(old), 'a worker directory older than an hour is removed');
    assert.ok(existsSync(recent), 'a recent worker directory may belong to a running worker and stays');
  });

  if (failures.length) { console.error(`assistant-mail-state: ${failures.length} failed: ${failures.join('; ')}`); process.exitCode = 1; }
  else console.log('assistant-mail-state: uncertain sends resolved without a send, later mail kept, acknowledgements never repeated, answers with their follow-up, saving independent of the chat, snooze attention and journal cleanup passed');
} finally {
  await Promise.all(controllers.map(controller => controller.close().catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 150));
  for (const dir of new Set(dirs)) rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
