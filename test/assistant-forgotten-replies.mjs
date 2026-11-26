import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { attachFixtureMailbox, fixtureTime } from './helpers/fixture-mailbox.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
// The mail check must catch mail that was opened but never answered, not only
// unread mail. These checks run the host's real browser reading, evidence and
// coverage rules against a local fixture mailbox; no real mailbox is read.
const { HOUR, DAY } = fixtureTime;
const dir = mkdtempSync(join(tmpdir(), 'tabai-forgotten-replies-'));
try {
  await build({ entryPoints: ['src/assistant-browser.ts', 'src/assistant-agent.ts', 'src/assistant-controller.ts'], outdir: dir, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const browserModule = await import(pathToFileURL(join(dir, 'assistant-browser.mjs')).href);
  const { AssistantBrowser, assistantInboxRow, assistantInboxGap, assistantRowReviewed, ASSISTANT_INBOX_LIMIT } = browserModule;
  const { AssistantExecutor } = await import(pathToFileURL(join(dir, 'assistant-agent.mjs')).href);
  const { AssistantController } = await import(pathToFileURL(join(dir, 'assistant-controller.mjs')).href);
  const owner = 'owner@example.test';
  const account = { id: 'fixture-gmail', provider: 'gmail', label: 'Testkonto', email: owner, url: 'https://mail.google.com/mail/u/0/', enabled: true };
  const now = Date.now();
  {
    const row = { key: 'gmail:attachment', version: 'gmail:message:two', native: true, at: new Date(now - DAY).toISOString() };
    const review = { accountId: account.id, threadId: row.key, messageId: 'gmail:message:one', outcome: 'attachment-review', reviewedAt: new Date(now).toISOString(), rows: [{ key: row.key, version: 'gmail:message:one' }] };
    assert.equal(assistantRowReviewed(row, [review]), false, 'an attachment flag never covers a different native version merely because its date is older');
    assert.equal(assistantRowReviewed({ ...row, version: 'gmail:message:one' }, [review]), true);
    const fallback = { ...row, version: 'row:fingerprint', native: false, order: 0, firstUnread: false };
    const flagged = { ...review, rows: [{ key: fallback.key, version: fallback.version }] };
    assert.equal(assistantRowReviewed(fallback, [flagged]), false, 'a fingerprint cannot reuse an old unread-attachment outcome across checks');
    const options = { now, lookbackDays: 7, scanStartedAt: new Date(now - 1000).toISOString() };
    assert.equal(assistantInboxGap([fallback], [flagged], options).due.length, 0, 'the current scan retains its own explicit manual-review outcome');
    assert.equal(assistantInboxGap([fallback], [flagged], { ...options, now: now + 10000 }).due.length, 0, 'resume keeps the original scan boundary');
    assert.equal(assistantInboxGap([fallback], [flagged], { ...options, scanStartedAt: new Date(now + 1000).toISOString() }).due.length, 1, 'the next check opens the same fingerprint to inspect its fresh native detail version');
    assert.equal(assistantRowReviewed({ ...fallback, at: new Date(now + 1000).toISOString() }, [flagged], options.scanStartedAt), false);
    assert.equal(assistantRowReviewed({ ...fallback, at: 'invalid' }, [flagged], options.scanStartedAt), false);
  }

  // Rows: the provider's ids when rendered, otherwise a fingerprint that ignores dates and read state.
  {
    const native = assistantInboxRow('gmail', { ref: 'ref_20', thread: 'aa01', last: 'f1', unread: false, at: '2026-11-03T08:20:00.000Z', text: 'Erik Flytta mötet? 09:20' }, Date.parse('2026-11-03T09:00:00.000Z'));
    assert.deepEqual(native, { key: 'gmail:aa01', version: 'gmail:message:f1', native: true, unread: false, at: '2026-11-03T08:20:00.000Z', ref: 'ref_20' });
    const plain = text => assistantInboxRow('outlook', { ref: null, text });
    const today = plain('Oläst Erik Lund Flytta mötet? Hej! Kan vi ses på torsdag? 09:20');
    assert.equal(today.native, false); assert.equal(today.key, today.version); assert.equal(today.unread, undefined, 'an absent read state stays absent');
    assert.equal(plain('Erik Lund Flytta mötet? Hej! Kan vi ses på torsdag? tis 3 nov.').key, today.key, 'the date shown and the unread marker do not change the row');
    assert.notEqual(plain('Erik Lund Flytta mötet? Svar: torsdag passar inte 10:02').key, today.key, 'a new latest message changes the row');
    assert.equal(assistantInboxRow('gmail', { thread: 'bad id with spaces', last: null, text: '' }), undefined);
    assert.equal(assistantInboxRow('gmail', { thread: 'x1', at: new Date(now + 3 * DAY).toISOString(), text: 'Framtid' }).at, undefined, 'a date in the future is not trusted');

    const row = (key, version, at, extra = {}) => ({ key, version, native: version.includes(':message:'), at: at && new Date(at).toISOString(), firstUnread: false, tabId: 1, order: 0, ...extra });
    const review = (overrides = {}) => ({ accountId: account.id, threadId: 'gmail:x', messageId: 'gmail:message:m1', outcome: 'no-action', reviewedAt: new Date(now - HOUR).toISOString(), rows: [], ...overrides });
    assert(assistantRowReviewed(row('gmail:a', 'gmail:message:m1', now - DAY), [review()]), 'the reviewed message is the row\'s latest');
    assert(!assistantRowReviewed(row('gmail:a', 'gmail:message:m2', now - DAY), [review()]), 'a newer message needs a new outcome');
    assert(assistantRowReviewed(row('row:k', 'row:k', now - DAY), [review({ rows: [{ key: 'row:k', version: 'row:k' }] })]));
    assert(assistantRowReviewed(row('outlook:c1', 'row:v2', now - DAY), [review({ threadId: 'outlook:c1' })]), 'a review newer than the row\'s latest message covers it');
    assert(!assistantRowReviewed(row('outlook:c1', 'row:v2', now - 30_000), [review({ threadId: 'outlook:c1', reviewedAt: new Date(now - 60_000).toISOString() })]), 'a review from before the latest message does not');

    const many = Array.from({ length: 40 }, (_, index) => row(`gmail:t${index}`, `gmail:message:m${index}`, now - index * HOUR, { order: index }));
    let gap = assistantInboxGap([...many, row('gmail:old', 'gmail:message:old', now - 10 * DAY), row('row:u', 'row:u', undefined, { firstUnread: undefined })], [], { now, lookbackDays: 7, scanStartedAt: new Date(now - HOUR).toISOString() });
    assert.equal(gap.due.length, 40, 'only rows inside lookbackDays are due'); assert.equal(gap.due[0].key, 'gmail:t0', 'newest first');
    assert.deepEqual([gap.undated, gap.unknownRead, gap.limitReached], [1, 1, false]);
    const handled = many.slice(0, ASSISTANT_INBOX_LIMIT).map((entry, index) => review({ threadId: entry.key, messageId: entry.version, reviewedAt: new Date(now - 1000 + index).toISOString() }));
    gap = assistantInboxGap(many, handled, { now, lookbackDays: 7, scanStartedAt: new Date(now - HOUR).toISOString() });
    assert.deepEqual([gap.due.length, gap.handled, gap.limitReached], [10, 30, true], 'after 30 outcomes in one check the rest wait for the next');
  }

  const mailbox = () => [
    { id: 'FMfcgzFRESHREAD01', legacy: 'aa01', subject: 'Flytta mötet?', at: now - 2 * HOUR, unread: false, messages: [{ id: 'f1', from: 'erik@kund.example.test', body: 'Hej! Kan vi flytta mötet till torsdag?' }] },
    { id: 'FMfcgzREPLIED0003', legacy: 'cc03', subject: 'Lunch', at: now - 5 * HOUR, unread: false, messages: [{ id: 'r1', from: 'anna@example.test', body: 'Kan du komma på lunch på fredag?' }, { id: 'r2', from: owner, body: 'Ja, gärna! Vi ses.' }] },
    { id: 'FMfcgzQUIETNEWS04', legacy: 'dd04', subject: 'Veckobrev', at: now - 3 * DAY, unread: false, messages: [{ id: 'q1', from: 'nyhetsbrev@butik.example.test', body: 'Veckans erbjudanden från butiken.' }] },
    { id: 'FMfcgzOLDERREAD02', legacy: 'bb02', subject: 'Offert', at: now - 4 * DAY, unread: false, messages: [{ id: 'o1', from: 'lisa@byra.example.test', body: 'Hej! Kan du skicka offerten senast fredag?' }] },
    { id: 'FMfcgzANCIENT0005', legacy: 'ee05', subject: 'Gammalt', at: now - 30 * DAY, unread: false, messages: [{ id: 'x1', from: 'gammal@example.test', body: 'Ett gammalt mejl.' }] },
  ];
  /** One check run: the host's executor dispatching a scripted model's tool calls against the fixture mailbox. */
  const check = (threads = mailbox(), { reviews = [], resumedFrom, rows, lookbackDays = 7 } = {}) => {
    const executor = new AssistantExecutor(resolve('.'), dir), browser = new AssistantBrowser(dir, dir), saved = { checkpoints: [], finish: undefined, updates: [] };
    const box = attachFixtureMailbox(browser, account, threads, rows ? { rows } : {});
    const stamp = new Date(now).toISOString();
    const context = { run: { id: 'fixture-run', task: 'check-mail', label: 'Kolla mejl', status: 'running', message: '', summary: '', startedAt: stamp, updatedAt: stamp, scanStartedAt: stamp, coverage: [{ accountId: account.id, status: 'pending', message: '' }], checkpoints: [], ...(resumedFrom ? { resumedFrom } : {}) },
      settings: { accounts: [account], lookbackDays, followupDays: 7, timezone: 'Europe/Stockholm', tone: 'Saklig', autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: '' },
      lastChecks: { [`check-mail:${account.id}`]: new Date(now - DAY).toISOString() }, items: [], answers: [], reviews };
    const callbacks = { checkpoint: async (entry, result, review) => { saved.checkpoints.push({ entry, findings: result.findings, review }); }, finish: async result => { saved.finish = result; },
      update: async (message, coverage) => { saved.updates.push(coverage); }, activity: async () => {}, question: async () => {}, help: async () => {},
      sendIntent: async () => { throw new Error('the fixture never sends'); }, sent: async () => { throw new Error('the fixture never sends'); }, exit: async () => {} };
    const execution = { context, callbacks, browser, terminal: false, stopped: false, sockets: new Set(), queue: Promise.resolve(), calls: 0 };
    const call = (tool, args = {}) => executor.dispatch(execution, tool, args);
    const thread = id => threads.find(entry => entry.id === id);
    const inbox = () => call('browser_open', { accountId: account.id, url: box.url(null, 'inbox') });
    const open = async entry => { await call('browser_click', { tabId: box.tabId, ref: box.ref(entry) }); return call('browser_read', { tabId: box.tabId }); };
    const reply = (read, entry, quote) => ({ accountId: account.id, threadId: read.sourceId, messageId: read.messageId, kind: 'reply', title: `Svara: ${entry.subject}`, summary: 'Avsändaren väntar på svar.', reason: 'En fråga är obesvarad.', priority: 2, sourceUrl: read.url, recipient: entry.messages[0].from, draft: 'Hej! Jag återkommer.', sources: [{ observationId: read.observationId, quote }] });
    const save = (read, outcome, findings = []) => call('workflow_checkpoint', { checkpoint: { accountId: account.id, threadId: read.sourceId, messageId: read.messageId, sourceUrl: read.url, outcome }, findings });
    const finish = (status = 'checked') => call('workflow_finish', { result: { summary: 'Kontrollen är klar.', findings: [], coverage: [{ accountId: account.id, status, message: 'Kontrollerat.' }] } });
    // An explicitly empty search proves a folder was read, as the coverage rule accepts.
    const sent = () => call('browser_open', { accountId: account.id, url: box.search('in:sent newer_than:1h') });
    const emptyInbox = () => call('browser_open', { accountId: account.id, url: box.search('in:inbox newer_than:1h') });
    return { box, call, thread, inbox, open, reply, save, finish, sent, emptyInbox, saved, context, close: async () => { await browser.close(); await executor.close(); } };
  };

  // The navigation and search shown by the fixture must work through the real read-only guards.
  {
    const navigation = check();
    await navigation.call('workflow_context'); await navigation.inbox();
    await navigation.call('browser_click', { tabId: navigation.box.tabId, ref: 'ref_3' });
    assert.deepEqual((await navigation.call('browser_read', { tabId: navigation.box.tabId })).areas, ['sent']);
    await navigation.call('browser_click', { tabId: navigation.box.tabId, ref: 'ref_2' });
    assert.deepEqual((await navigation.call('browser_read', { tabId: navigation.box.tabId })).areas, ['inbox']);
    await navigation.call('browser_search', { tabId: navigation.box.tabId, ref: 'ref_1', query: 'in:sent newer_than:1h' });
    const empty = await navigation.call('browser_read', { tabId: navigation.box.tabId });
    assert.equal(empty.view, 'empty'); assert.deepEqual(empty.areas, ['sent']);
    await navigation.close();
  }

  // First check: every mail inside lookbackDays without an outcome must get one, opened or not.
  const first = check();
  await first.call('workflow_context');
  let list = await first.call('browser_open', { accountId: account.id });
  assert.equal(list.inboxRows, undefined, 'the raw row count never reaches the model');
  assert.deepEqual([list.inbox.remaining, list.inbox.open.length, list.inbox.reviewed], [4, 4, 0], 'four mails inside seven days have no outcome; the 30-day-old one is outside the period');
  assert.match(list.inbox.note, /även mejl som redan är öppnade/);
  // Case 1: read mail newer than the last check, without a reply, gives a reply card.
  const fresh = first.thread('FMfcgzFRESHREAD01'), freshRead = await first.open(fresh);
  let saved = await first.save(freshRead, 'needs-action', [first.reply(freshRead, fresh, 'Kan vi flytta mötet till torsdag?')]);
  assert.equal(saved.inbox.remaining, 3, 'the saved thread covers its row');
  let record = first.saved.checkpoints.at(-1);
  assert.equal(record.findings[0].kind, 'reply');
  assert.equal(record.review.opened, true, 'the row was already read when the list first showed it');
  assert.deepEqual(record.review.review.rows, [{ key: 'gmail:aa01', version: 'gmail:message:f1' }]);
  // Case 3: your own reply is the latest message: already-replied, and no reply card.
  await first.inbox();
  const replied = first.thread('FMfcgzREPLIED0003'), repliedRead = await first.open(replied);
  await assert.rejects(first.save(repliedRead, 'needs-action', [first.reply(repliedRead, replied, 'Kan du komma på lunch på fredag?')]), /ditt eget svar/);
  await assert.rejects(first.save(repliedRead, 'already-replied', [{ ...first.reply(repliedRead, replied, 'Ja, gärna! Vi ses.'), kind: 'information', recipient: undefined, draft: undefined }]), /redan är besvarad.*fynd/, 'already-replied never creates an information card either');
  await first.save(repliedRead, 'already-replied');
  assert.deepEqual(first.saved.checkpoints.at(-1).findings, []);
  // Case 2: a read mail older than the last check, inside lookbackDays, never reviewed, is required.
  await first.sent();
  await assert.rejects(first.finish(), /2 mejl i inkorgen inom 7 dagar saknar ett utfall/, 'the account is not checked while older opened mail lacks an outcome');
  list = await first.inbox();
  const older = first.thread('FMfcgzOLDERREAD02'), quiet = first.thread('FMfcgzQUIETNEWS04');
  assert.deepEqual(list.inbox.open, [first.box.ref(quiet), first.box.ref(older)], 'the host names the remaining rows, newest first');
  const olderRead = await first.open(older);
  await first.save(olderRead, 'needs-action', [first.reply(olderRead, older, 'Kan du skicka offerten senast fredag?')]);
  assert.equal(first.saved.checkpoints.at(-1).review.opened, true);
  await first.inbox();
  const quietRead = await first.open(quiet);
  saved = await first.save(quietRead, 'no-action');
  assert.equal(saved.inbox.remaining, 0);
  await first.sent();
  await first.finish();
  assert.equal(first.saved.finish.coverage[0].status, 'checked');
  assert.equal(first.saved.finish.coverage[0].message, 'Kontrollerat.', 'nothing could not be determined');
  const reviews = first.saved.checkpoints.map(entry => entry.review.review);
  await first.close();
  {
    // Already replied is a fact the host checks: here the latest message is Erik's.
    const wrong = check();
    await wrong.call('workflow_context'); await wrong.call('browser_open', { accountId: account.id });
    const read = await wrong.open(wrong.thread('FMfcgzFRESHREAD01'));
    await assert.rejects(wrong.save(read, 'already-replied'), /senaste meddelandet är skickat från kontots egen adress/);
    await wrong.close();
  }
  {
    // The owner's message shown last proves a reply only in a complete thread in its real order:
    // an unordered thread or one with a collapsed message is not closed as answered.
    for (const [label, change, refusal] of [
      ['an unordered thread', thread => { thread.chronological = false; }, /^Error: Utfallet already-replied kräver en komplett, ordnad tråd/],
      ['a thread with a collapsed message', thread => { thread.messages[0].complete = false; }, /^Error: Läs hela den aktuella tråden innan den markeras bedömd\.$/],
    ]) {
      const threads = mailbox(), replied = threads.find(entry => entry.id === 'FMfcgzREPLIED0003');
      change(replied);
      const run = check(threads);
      await run.call('workflow_context'); await run.call('browser_open', { accountId: account.id });
      const read = await run.open(replied);
      assert.equal(read.latestSender, owner, `${label}: the owner's message is shown last`);
      await assert.rejects(run.save(read, 'already-replied'), refusal, label);
      assert.equal(run.saved.checkpoints.length, 0, `${label}: nothing is saved as answered`);
      await run.close();
    }
    // Each condition of the evidence on its own.
    const { assistantOwnLatest } = browserModule;
    const proven = { historyComplete: true, truncated: false, chronological: true, latestSender: 'Owner@Example.test' };
    assert.equal(assistantOwnLatest(proven, account), true, 'a complete, ordered thread with the owner last');
    const unproven = { 'no read': undefined, unordered: { ...proven, chronological: false }, 'order unknown': { ...proven, chronological: undefined }, incomplete: { ...proven, historyComplete: false },
      'completeness unknown': { ...proven, historyComplete: undefined }, truncated: { ...proven, truncated: true }, 'another sender last': { ...proven, latestSender: 'erik@kund.example.test' } };
    assert.deepEqual(Object.entries(unproven).map(([label, observation]) => [label, assistantOwnLatest(observation, account)]), Object.keys(unproven).map(label => [label, false]));
  }

  // Case 4: a thread reviewed as no-action, with no new message, is not required again.
  {
    const next = check(mailbox(), { reviews });
    await next.call('workflow_context');
    const again = await next.call('browser_open', { accountId: account.id });
    assert.deepEqual([again.inbox.remaining, again.inbox.reviewed], [0, 4], 'every unchanged mail already has an outcome');
    await next.emptyInbox(); await next.sent();
    await next.finish();
    assert.equal(next.saved.finish.coverage[0].status, 'checked', 'the next check is complete without reading them again');
    await next.close();
    // A new message in the quiet thread makes it due again.
    const threads = mailbox(), changed = threads.find(entry => entry.id === 'FMfcgzQUIETNEWS04');
    // It arrives after the first check's review, as later mail does.
    changed.messages.push({ id: 'q2', from: 'nyhetsbrev@butik.example.test', body: 'Sista chansen!' }); changed.at = Date.now() + 5 * 60_000; changed.unread = true;
    const later = check(threads, { reviews });
    await later.call('workflow_context');
    const due = await later.call('browser_open', { accountId: account.id });
    assert.deepEqual([due.inbox.remaining, due.inbox.open], [1, [later.box.ref(changed)]]);
    const read = await later.open(changed);
    await later.save(read, 'no-action');
    assert.equal(later.saved.checkpoints.at(-1).review.opened, false, 'unread mail is not counted as opened, even though reading it marks it read');
    await later.close();
  }

  // Rows without native ids are bound by the click that opened them, and stay covered.
  {
    const plainRows = native => ({ ref: native.ref, at: native.at, unread: native.unread, text: native.text });
    const plain = check(mailbox(), { rows: plainRows });
    await plain.call('workflow_context'); await plain.call('browser_open', { accountId: account.id });
    const read = await plain.open(plain.thread('FMfcgzQUIETNEWS04'));
    await plain.save(read, 'no-action');
    const bound = plain.saved.checkpoints.at(-1).review.review;
    assert.equal(bound.rows.length, 1); assert.match(bound.rows[0].key, /^row:[0-9a-f]{64}$/);
    await plain.close();
    const next = check(mailbox(), { rows: plainRows, reviews: [bound] });
    await next.call('workflow_context');
    assert.equal((await next.call('browser_open', { accountId: account.id })).inbox.remaining, 3, 'the reviewed plain row is covered in the next check');
    await next.close();
  }

  // Honest gaps: no read state, no dates, the 30-mail limit, an unread inbox list, a resumed check.
  {
    const unknown = check(mailbox(), { rows: native => ({ ...native, unread: undefined }) });
    await unknown.call('workflow_context'); await unknown.call('browser_open', { accountId: account.id });
    const read = await unknown.open(unknown.thread('FMfcgzOLDERREAD02'));
    await unknown.save(read, 'needs-action', [unknown.reply(read, unknown.thread('FMfcgzOLDERREAD02'), 'Kan du skicka offerten senast fredag?')]);
    assert.equal(unknown.saved.checkpoints.at(-1).review.opened, undefined, 'without read state in the list the host does not guess');
    await unknown.finish('partial');
    assert.match(unknown.saved.finish.coverage[0].message, /3 mejl i inkorgen hann inte kontrolleras\. Inkorgen visar inte vilka mejl du har öppnat/);
    await unknown.close();

    const undated = check(mailbox(), { rows: native => ({ ...native, at: undefined }) });
    await undated.call('workflow_context');
    const shown = await undated.call('browser_open', { accountId: account.id });
    assert.deepEqual([shown.inbox.remaining, shown.inbox.undated], [0, 5]);
    await undated.emptyInbox(); await undated.sent(); await undated.finish();
    assert.equal(undated.saved.finish.coverage[0].status, 'checked');
    assert.match(undated.saved.finish.coverage[0].message, /5 mejl i inkorgen saknar ett läsbart datum/);
    await undated.close();

    const unlisted = check();
    await unlisted.call('workflow_context');
    await unlisted.call('browser_open', { accountId: account.id, url: unlisted.box.url(unlisted.thread('FMfcgzQUIETNEWS04'), 'inbox') });
    await unlisted.save(await unlisted.call('browser_read', { tabId: unlisted.box.tabId }), 'no-action');
    await unlisted.sent();
    await assert.rejects(unlisted.finish(), /Läs inkorgens lista/);
    await unlisted.close();

    const resumed = check(mailbox(), { resumedFrom: 'earlier-run' });
    await resumed.call('workflow_context'); await resumed.call('browser_open', { accountId: account.id });
    const again = await resumed.open(resumed.thread('FMfcgzFRESHREAD01'));
    await resumed.save(again, 'needs-action', [resumed.reply(again, resumed.thread('FMfcgzFRESHREAD01'), 'Kan vi flytta mötet till torsdag?')]);
    assert.equal(resumed.saved.checkpoints.at(-1).review.opened, undefined, 'a resumed check may have opened the mail itself');
    await resumed.close();

    const crowded = Array.from({ length: 35 }, (_, index) => ({ id: `FMfcgzCROWDED${String(index).padStart(4, '0')}`, legacy: `ff${index}`, subject: `Ärende ${index}`, at: now - (index + 1) * HOUR, unread: true, messages: [{ id: `c${index}`, from: `avsandare${index}@example.test`, body: `Information nummer ${index}.` }] }));
    const busy = check(crowded);
    await busy.call('workflow_context'); await busy.call('browser_open', { accountId: account.id });
    for (const entry of crowded.slice(0, 30)) { const read = await busy.open(entry); await busy.save(read, 'no-action'); await busy.inbox(); }
    const status = await busy.call('browser_read', { tabId: busy.box.tabId });
    assert.deepEqual([status.inbox.remaining, status.inbox.limitReached, status.inbox.open], [5, true, []]);
    assert.match(status.inbox.note, /Gränsen på 30 mejl/);
    await busy.sent();
    await busy.finish();
    assert.equal(busy.saved.finish.coverage[0].status, 'partial');
    assert.match(busy.saved.finish.coverage[0].message, /5 äldre mejl hann inte kontrolleras\./);
    await busy.close();
  }

  // The controller keeps reviews across checks and counts opened mail still without a reply.
  {
    const appDir = mkdtempSync(join(dir, 'controller-'));
    const executor = { starts: [], async start(context, callbacks) { this.starts.push(context); this.context = context; this.callbacks = callbacks; }, async stop() {}, async close() {}, async open() {} };
    const app = new AssistantController(resolve('.'), appDir, executor);
    try {
      const view = async () => (await app.request('status', {})).assistant;
      const current = await view();
      await app.request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, accounts: [account] }) });
      await app.request('start', { task: 'check-mail' });
      assert.deepEqual(executor.context.reviews, []);
      const finding = (threadId, messageId, title) => ({ accountId: account.id, threadId, messageId, kind: 'reply', title, summary: 'Ett svar behövs.', reason: 'Frågan är obesvarad.', priority: 2,
        sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${threadId.slice(6)}`, recipient: 'erik@kund.example.test', draft: 'Hej! Jag återkommer.', sources: [{ observationId: 'o1', quote: 'Kan vi ses?' }] });
      const review = (threadId, messageId, outcome = 'needs-action') => ({ accountId: account.id, threadId, messageId, outcome, reviewedAt: new Date().toISOString(), rows: [{ key: threadId, version: messageId }] });
      const checkpoint = (threadId, messageId, outcome = 'needs-action') => ({ accountId: account.id, threadId, messageId, sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${threadId.slice(6)}`, outcome, reviewedAt: new Date().toISOString() });
      const result = findings => ({ summary: '', findings, coverage: [] });
      await executor.callbacks.checkpoint(checkpoint('gmail:FMfcgzOPENED0001', 'gmail:message:a1'), result([finding('gmail:FMfcgzOPENED0001', 'gmail:message:a1', 'Opened')]), { review: review('gmail:FMfcgzOPENED0001', 'gmail:message:a1'), opened: true });
      await executor.callbacks.checkpoint(checkpoint('gmail:FMfcgzUNREAD00002', 'gmail:message:b1'), result([finding('gmail:FMfcgzUNREAD00002', 'gmail:message:b1', 'Unread')]), { review: review('gmail:FMfcgzUNREAD00002', 'gmail:message:b1'), opened: false });
      await executor.callbacks.checkpoint(checkpoint('gmail:FMfcgzQUIETMAIL03', 'gmail:message:c1', 'no-action'), result([]), { review: review('gmail:FMfcgzQUIETMAIL03', 'gmail:message:c1', 'no-action') });
      await executor.callbacks.finish({ summary: 'Klart.', findings: [], coverage: [{ accountId: account.id, status: 'checked', message: 'Kontrollerat.' }] });
      let state = await view();
      const itemId = threadId => createHash('sha256').update(`${account.id}\0${threadId}\0reply`).digest('hex');
      assert.equal(state.items.find(item => item.id === itemId('gmail:FMfcgzOPENED0001')).opened, true);
      assert.equal(state.items.find(item => item.id === itemId('gmail:FMfcgzUNREAD00002')).opened, undefined);
      assert.equal(state.openedUnanswered, 1, 'one reply card is for mail that was opened without a reply');
      await app.request('start', { task: 'check-mail' });
      assert.deepEqual(executor.context.reviews.map(entry => [entry.threadId, entry.outcome]).sort(), [['gmail:FMfcgzOPENED0001', 'needs-action'], ['gmail:FMfcgzQUIETMAIL03', 'no-action'], ['gmail:FMfcgzUNREAD00002', 'needs-action']], 'the next check receives the earlier reviews');
      // The same message again keeps the flag; it is never set for a card Tabai already had for that message.
      await executor.callbacks.checkpoint(checkpoint('gmail:FMfcgzOPENED0001', 'gmail:message:a1'), result([finding('gmail:FMfcgzOPENED0001', 'gmail:message:a1', 'Opened again')]), { review: review('gmail:FMfcgzOPENED0001', 'gmail:message:a1') });
      await executor.callbacks.checkpoint(checkpoint('gmail:FMfcgzUNREAD00002', 'gmail:message:b1'), result([finding('gmail:FMfcgzUNREAD00002', 'gmail:message:b1', 'Unread again')]), { review: review('gmail:FMfcgzUNREAD00002', 'gmail:message:b1'), opened: true });
      await executor.callbacks.finish({ summary: 'Klart.', findings: [], coverage: [{ accountId: account.id, status: 'checked', message: 'Kontrollerat.' }] });
      state = await view();
      assert.equal(state.items.find(item => item.id === itemId('gmail:FMfcgzOPENED0001')).opened, true);
      assert.equal(state.items.find(item => item.id === itemId('gmail:FMfcgzUNREAD00002')).opened, undefined);
      assert.equal(state.openedUnanswered, 1);
      const item = state.items.find(entry => entry.id === itemId('gmail:FMfcgzOPENED0001'));
      await app.request('correct', { action: 'dismiss', itemId: item.id, revision: String(item.revision) });
      assert.equal((await view()).openedUnanswered, undefined, 'a done mail no longer counts');
    } finally { await app.close(); }
  }
  console.log('Forgotten replies: opened mail inside lookbackDays must get an outcome; replies, earlier reviews, limits and unknown read state are host-checked');
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
