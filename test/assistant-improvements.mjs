import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(async () => { for (const app of apps) await app.controller.close(); rmSync(dir, { recursive: true, force: true }); });
const dir = mkdtempSync(join(tmpdir(), 'tabai-assistant-improvements-')), apps = [];
try {
  await build({ entryPoints: ['src/assistant-controller.ts', 'src/assistant-browser.ts', 'src/assistant-schedule.ts'], outdir: dir, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { AssistantController } = await import(pathToFileURL(join(dir, 'assistant-controller.mjs')));
  const { validateAssistantResolutions } = await import(pathToFileURL(join(dir, 'assistant-browser.mjs')));
  const { nextAssistantMorning } = await import(pathToFileURL(join(dir, 'assistant-schedule.mjs')));
  const a = { id: 'personal', provider: 'gmail', label: 'Testkonto', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true };
  const b = { ...a, id: 'work', email: 'work@example.test' };
  const sourceUrl = a.url + '#inbox/abcdefghijklmnop', threadId = 'gmail:abcdefghijklmnop';
  const finding = { accountId: a.id, threadId, messageId: 'gmail:message:one', kind: 'reply', title: 'Ett testbesked', summary: 'Ett besked behövs.', reason: 'Avsändaren ber om svar.', priority: 2, sourceUrl, recipient: 'sender@example.test', draft: 'Jag återkommer.', sources: [{ observationId: 'original', quote: 'Kan du ge ett besked?' }] };
  const checkpoint = { accountId: a.id, threadId, messageId: finding.messageId, sourceUrl, reviewedAt: new Date().toISOString(), outcome: 'needs-action' };
  const covers = [{ accountId: a.id, status: 'checked', message: 'Genomgånget.' }, { accountId: b.id, status: 'partial', message: 'En tråd återstår.' }];
  let clock = new Date('2026-11-01T06:30:00.000Z');
  const terminalCallbacks = callbacks => ({ ...callbacks,
    async finish(result) { await callbacks.finish(result); await callbacks.settled?.(); },
    async help(help) { await callbacks.help(help); await callbacks.settled?.(); },
    async exit(...args) { await callbacks.exit(...args); await callbacks.settled?.(); },
  });
  function create(path = join(dir, `state-${apps.length}`), awakeMs = 0) {
    const notices = [], executor = { starts: [], helpReady: false,
      async start(context, callbacks) { callbacks = terminalCallbacks(callbacks); this.context = context; this.callbacks = callbacks; this.starts.push(context); }, async close() {}, async stop() {}, async open() {}, async showWork() { this.shown = true; },
      async showHelp(help, account) { assert.equal(account.id, help.accountId); this.openedHelp = structuredClone(help); this.helpReady = true; return help; },
      async preflightHelp(help) {
        if (!this.helpReady || this.openedHelp?.accountId !== help.accountId || this.openedHelp?.sourceUrl !== help.sourceUrl) throw new Error('Öppna den exakta blockerade fliken först.');
        this.preflight = structuredClone(help);
      } };
    const controller = new AssistantController(process.cwd(), path, executor, { clock: () => clock, awakeMs, notice: notice => notices.push(notice) });
    const app = { controller, executor, path, notices, request: (operation, input = {}) => controller.request(operation, input) }; apps.push(app); return app;
  }
  async function settings(app, change = {}) {
    const w = (await app.request('status')).assistant;
    return app.request('correct', { action: 'settings', revision: String(w.revision), settings: JSON.stringify({ ...w.settings, accounts: [a, b], timezone: 'Europe/Stockholm', ...change }) });
  }
  async function finishScan(app, summary, findings = [], resolutions = []) {
    for (let count = 0; count < 2; count++) {
      const active = app.executor.context.settings.accounts.filter(account => account.enabled);
      assert.equal(active.length, 1, 'each mail executor context contains exactly one active account');
      const accountId = app.executor.context.run.accountId ?? active[0].id;
      const result = { summary, findings: findings.filter(entry => entry.accountId === accountId), coverage: covers.filter(entry => entry.accountId === accountId) };
      const accountResolutions = resolutions.filter(entry => entry.accountId === accountId);
      if (accountResolutions.length) result.resolutions = accountResolutions;
      await app.executor.callbacks.finish(result);
      if ((await app.request('status')).assistant.current.status !== 'running') break;
    }
  }
  const app = create(); await settings(app);
  await app.request('start', { task: 'check-mail', windowId: '42' });
  const boundary = app.executor.context.run.scanStartedAt;
  await app.executor.callbacks.checkpoint(checkpoint, { summary: '', findings: [finding], coverage: [] });
  let w = (await app.request('status')).assistant;
  assert.equal(w.items.length, 1, 'a checkpoint stores the finding before final completion');
  assert.equal(w.current.activity.reviewedThreads, 1);
  await app.executor.callbacks.update('Nästa konto återstår.', covers[0]);
  await app.executor.callbacks.finish({ summary: 'Första kontot klart.', findings: [], coverage: [covers[0]] });
  assert.deepEqual(app.executor.context.settings.accounts.map(account => account.id), [b.id]);
  const blockedHelp = { accountId: b.id, code: 'expand-thread', message: 'Öppna det äldre meddelandet och fortsätt.', sourceUrl: `${b.url}#inbox/blocked-test-thread`, tabId: 17 };
  const helpTarget = ({ accountId, code, sourceUrl, tabId }) => ({ accountId, code, sourceUrl, tabId });
  await app.executor.callbacks.help(blockedHelp);
  await app.request('open', { helpAccountId: b.id, windowId: '42' }); assert.deepEqual(helpTarget(app.executor.openedHelp), helpTarget(blockedHelp));
  await app.controller.close();
  const continued = create(app.path);
  await continued.request('resume', { windowId: '43' });
  const waiting = (await continued.request('status')).assistant.current;
  assert.equal(waiting.status, 'waiting', 'restart remains waiting until the exact help target is opened again');
  assert.equal(waiting.help.message, 'Öppna den exakta blockerade fliken först.');
  assert.equal(continued.executor.starts.length, 0, 'failed help preflight starts no account worker');
  await continued.request('open', { helpAccountId: b.id, windowId: '43' });
  assert.deepEqual(helpTarget(continued.executor.openedHelp), helpTarget(blockedHelp), 'restart opens the saved account and exact source target');
  await continued.request('resume', { windowId: '43' });
  assert.deepEqual(helpTarget(continued.executor.preflight), helpTarget(blockedHelp), 'the exact repaired help target is preflighted before worker start');
  assert.equal(continued.executor.starts.length, 1);
  assert.deepEqual(continued.executor.context.settings.accounts.map(account => account.id), [b.id], 'checked accounts are excluded from continuation');
  assert.equal((await continued.request('status')).assistant.current.accountProgress.find(entry => entry.accountId === a.id).reviewedThreads, 1, 'public progress retains the completed-account checkpoint without exposing its source identity');
  assert.equal(continued.executor.context.run.checkpoints.length, 0, 'the account worker receives only its own checkpoints');
  assert.equal(continued.executor.context.run.scanStartedAt, boundary, 'continuation retains the original scan boundary');
  await continued.executor.callbacks.finish({ summary: 'Återstående konto klart.', findings: [], coverage: [covers[1]] });
  w = (await continued.request('status')).assistant;
  assert.equal(w.current.coverage[0].status, 'checked');
  assert.equal(w.lastChecks['check-mail:personal'], boundary);
  assert.equal(w.current.coverage[1].status, 'partial');
  const unfinishedId = w.current.id;
  await continued.request('start', { task: 'follow-ups' });
  await continued.request('stop');
  await continued.request('resume', { runId: unfinishedId, windowId: '43' });
  assert.equal(continued.executor.context.run.task, 'check-mail', 'starting another task does not destroy the unfinished scan');
  assert.equal((await continued.request('status')).assistant.current.accountProgress.find(entry => entry.accountId === a.id).reviewedThreads, 1, 'archived continuation retains the durable checkpoint count');
  assert.equal(continued.executor.context.run.checkpoints.length, 0, 'archived continuation still isolates the account worker journal');
  await continued.executor.callbacks.finish({ summary: 'Återstående del sparad.', findings: [], coverage: [covers[1]] });
  w = (await continued.request('status')).assistant;
  let item = w.items[0];
  await continued.request('correct', { action: 'feedback', kind: 'prioritize-sender', itemId: item.id, revision: String(item.revision) });
  w = (await continued.request('status')).assistant;
  assert.deepEqual(w.settings.preferences.senderRules, [{ accountId: a.id, email: finding.recipient, priority: 'high' }]);
  assert.equal(w.items[0].priority, 1);
  await continued.request('correct', { action: 'feedback', kind: 'shorter', itemId: item.id, revision: String(w.items[0].revision) });
  w = (await continued.request('status')).assistant; assert.equal(w.settings.preferences.shortReplies, true);
  await settings(continued, { preferences: { shortReplies: false, senderRules: [] } });
  w = (await continued.request('status')).assistant; assert.deepEqual(w.settings.preferences.senderRules, []);
  await continued.request('correct', { action: 'feedback', kind: 'no-reply', itemId: item.id, revision: String(w.items[0].revision) });
  w = (await continued.request('status')).assistant; assert.equal(w.items[0].feedback, 'no-reply'); assert.equal(w.items[0].status, 'dismissed');

  const resolved = create(); await settings(resolved, { morning: { enabled: false, time: '08:00', notifications: true } });
  await resolved.request('start', { task: 'check-mail' });
  await finishScan(resolved, 'Ett svar behövs.', [finding]);
  w = (await resolved.request('status')).assistant; item = w.items[0];
  assert.equal(resolved.notices.filter(notice => notice.desktop).length, 1);
  await resolved.request('start', { task: 'check-mail' });
  await finishScan(resolved, 'Samma underlag.', [finding]);
  assert.equal(resolved.notices.filter(notice => notice.desktop).length, 1, 'unchanged attention never sends another alert');
  w = (await resolved.request('status')).assistant; item = w.items[0];
  const observation = { accountId: a.id, email: a.email, url: sourceUrl, sourceId: threadId, messageId: 'gmail:message:two', messageIds: [finding.messageId, 'gmail:message:two'], latestSender: a.email, chronological: true, historyComplete: true, text: 'Mitt senare skickade svar: Jag bekräftar mötet.' };
  const resolution = { itemId: item.id, revision: item.revision, accountId: a.id, threadId, messageId: observation.messageId, sourceUrl, reason: 'Du har redan svarat i tråden.', sources: [{ observationId: 'latest', quote: 'Jag bekräftar mötet.' }] };
  validateAssistantResolutions([resolution], [item], [a], new Map([['latest', observation]]));
  for (const changes of [{ latestSender: 'someone@example.test' }, { chronological: false }, { historyComplete: false }, { messageIds: [observation.messageId, finding.messageId] }, { messageIds: [observation.messageId] }]) {
    assert.throws(() => validateAssistantResolutions([resolution], [item], [a], new Map([['latest', { ...observation, ...changes }]])));
  }
  await resolved.request('start', { task: 'check-mail' });
  await finishScan(resolved, 'Redan besvarat.', [], [resolution]);
  w = (await resolved.request('status')).assistant;
  assert.equal(w.items[0].status, 'resolved'); assert.equal(w.items[0].draft, finding.draft, 'closure preserves the earlier proposal for inspection');
  assert.equal(w.attention.count, 0);

  const scheduled = create(); await settings(scheduled, { morning: { enabled: true, time: '08:00', notifications: false } });
  w = (await scheduled.request('status')).assistant;
  assert.equal(w.schedule.nextRunAt, '2026-11-01T07:00:00.000Z');
  clock = new Date('2026-11-01T07:01:00.000Z');
  await scheduled.request('status', { scheduler: 'true', browserConnected: 'false' }); assert.equal(scheduled.executor.starts.length, 0);
  await scheduled.request('status', { scheduler: 'true', browserConnected: 'true' }); assert.equal(scheduled.executor.starts.length, 1);
  assert.equal(scheduled.executor.context.run.scheduled, true); assert.equal(scheduled.executor.context.run.task, 'my-day');
  await scheduled.request('stop'); await scheduled.controller.close();
  const restarted = create(scheduled.path);
  await restarted.request('status', { scheduler: 'true', browserConnected: 'true' }); assert.equal(restarted.executor.starts.length, 0, 'a restart does not repeat the reserved morning run');
  await settings(restarted, { morning: { enabled: false, time: '08:00', notifications: false } });
  clock = new Date('2026-11-02T08:00:00.000Z');
  await restarted.request('status', { scheduler: 'true', browserConnected: 'true' }); assert.equal(restarted.executor.starts.length, 0);

  // A sleeping Mac wakes briefly for maintenance and the broker pulses then too.
  // Replays the wakes that failed real runs, with the production wait in force.
  const sleeping = create(join(dir, 'state-sleeping'), null);
  clock = new Date('2026-11-03T06:00:00.000Z');
  await settings(sleeping, { morning: { enabled: true, time: '08:00', notifications: false } });
  const pulseAt = async (start, seconds, connected = true) => { clock = new Date(Date.parse(start) + seconds * 1000); await sleeping.request('status', { scheduler: 'true', browserConnected: String(connected) }); return sleeping.executor.starts.length; };
  for (const seconds of [0, 30]) assert.equal(await pulseAt('2026-11-03T07:05:53.000Z', seconds), 0, 'a run is not started in a maintenance wake, though it is due');
  for (const seconds of [0, 30, 60, 90]) assert.equal(await pulseAt('2026-11-03T08:06:46.000Z', seconds), 0, 'nor in the longest maintenance wake measured');
  assert.equal(await pulseAt('2026-11-03T08:06:46.000Z', 170), 0, 'a pulse after a gap starts a new count, however many came before it');
  assert.equal(await pulseAt('2026-11-03T08:06:46.000Z', 260), 0);
  assert.equal(await pulseAt('2026-11-03T08:06:46.000Z', 340), 0, 'pulses that each follow a gap never add up');
  for (const seconds of [0, 30, 60, 90, 120, 150]) assert.equal(await pulseAt('2026-11-03T09:18:45.000Z', seconds, ![60, 90].includes(seconds)), 0, 'still waiting within three minutes of the real wake; pulses without the browser still show the computer awake');
  assert.equal(await pulseAt('2026-11-03T09:18:45.000Z', 180), 1, 'the run that was due starts once the computer has stayed awake, later the same day');
  assert.equal(sleeping.executor.context.run.scheduled, true);
  await sleeping.request('stop');
  assert.equal(await pulseAt('2026-11-03T09:18:45.000Z', 210), 1, 'and only once, also when it no longer runs');
  await sleeping.controller.close();

  // A clock set back must not hold the schedule shut until it has caught up.
  const reset = create(join(dir, 'state-clock-back'), null);
  clock = new Date('2026-11-04T06:00:00.000Z');
  await settings(reset, { morning: { enabled: true, time: '08:00', notifications: false } });
  const resetPulse = async seconds => { clock = new Date(Date.parse('2026-11-04T09:00:00.000Z') + seconds * 1000); await reset.request('status', { scheduler: 'true', browserConnected: 'true' }); return reset.executor.starts.length; };
  for (const seconds of [0, 30]) assert.equal(await resetPulse(seconds), 0);
  for (const seconds of [-1800, -1770, -1740, -1710, -1680, -1650]) assert.equal(await resetPulse(seconds), 0, 'the count starts over at the new time');
  assert.equal(await resetPulse(-1620), 1, 'and opens three minutes later, not when the clock has caught up');
  await reset.request('stop'); await reset.controller.close();

  // Sleep during a check of several accounts: Tabai reports the end as lost contact, so no further account starts in what may be a brief wake, and the run can be continued.
  const interrupted = create(); clock = new Date('2026-11-05T12:00:00.000Z'); await settings(interrupted);
  await interrupted.request('start', { task: 'check-mail' });
  await interrupted.executor.callbacks.exit('Datorn gick i viloläge och körningen avbröts. Det som hann sparas finns kvar.', 'disconnected');
  let stopped = (await interrupted.request('status')).assistant.current;
  assert.equal(interrupted.executor.starts.length, 1, 'no further account starts');
  assert.deepEqual([stopped.status, stopped.message], ['failed', 'Datorn gick i viloläge och körningen avbröts. Det som hann sparas finns kvar.']);
  assert.deepEqual([stopped.coverage[0].status, stopped.coverage[0].message], ['failed', 'Datorn gick i viloläge och körningen avbröts. Det som hann sparas finns kvar.']);
  await interrupted.request('resume');
  assert.equal(interrupted.executor.starts.length, 2, 'the interrupted run can be continued');
  await interrupted.request('stop'); await interrupted.controller.close();
  const effect = create(); await settings(effect);
  await effect.request('start', { task: 'check-mail' });
  await effect.executor.callbacks.externalEffect();
  await effect.executor.callbacks.exit('Datorn gick i viloläge och körningen avbröts. Det som hann sparas finns kvar.', 'disconnected');
  stopped = (await effect.request('status')).assistant.current;
  assert.equal(stopped.status, 'failed');
  await assert.rejects(effect.request('resume'), /Ett tidigare steg kan redan ha utförts/, 'never continued after a possible external effect');
  assert.equal(effect.executor.starts.length, 1);
  await effect.controller.close();
  clock = new Date('2026-11-02T08:00:00.000Z');
  const base = (await restarted.request('status')).assistant.settings;
  assert.equal(nextAssistantMorning(new Date('2026-03-28T23:59:00Z'), { ...base, morning: { enabled: true, time: '02:30', notifications: false } }), '2026-03-30T00:30:00.000Z', 'a nonexistent DST minute is skipped');
  assert.equal(nextAssistantMorning(new Date('2026-10-25T00:35:00Z'), { ...base, morning: { enabled: true, time: '02:30', notifications: false } }, '2026-10-25'), '2026-10-26T01:30:00.000Z', 'the repeated DST hour cannot run twice on a reserved day');
  console.log('Assistant improvements: durable thread/findings continuation, scoped preferences, verified closure, attention deduplication and timezone/restart scheduling passed');
} finally {
  for (const app of apps) await app.controller.close();
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
