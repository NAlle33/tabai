// Watches: their schedule (daily or every few hours, one run for missed slots,
// no replay after a restart), their own model and executor, the card, the
// "Bevakningar" conversation, notices, and a pause while web access is off.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantWatches, assistantRunFailure, assistantWatchDue, assistantWatchHistory, assistantWatchNextRun, assistantWatchOutcome, assistantWatchOverCapacity, assistantWatchRecord, assistantWatchRunsPerDay, assistantWatchScheduleText, assistantWatchSetEnabled, assistantWatchTrend, ASSISTANT_CONNECTED_MS, ASSISTANT_WATCH_CAPACITY_WARNING, ASSISTANT_WATCH_CHECK_MS, ASSISTANT_WATCH_UNREAD, ASSISTANT_WATCH_WEB_OFF } from '../dist/assistant-watches.mjs';
import { AssistantController } from '../dist/assistant-controller.mjs';
import { watchdog } from './watchdog.mjs';

// Many scheduled controller runs and restarts run about 8 s.
const stopWatchdog = watchdog(async () => { for (const controller of controllers) await controller.close().catch(() => {}); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }, 90_000);
const tz = 'Europe/Stockholm', dirs = [], controllers = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tabai-watches-')); dirs.push(dir); return dir; };
const watch = (cadence, extra = {}) => ({ id: randomUUID(), title: 'Elpris', target: { url: 'https://elpriset.example/' }, condition: 'Under 1 kr/kWh', cadence, enabled: true, createdAt: '2026-11-02T13:00:00.000Z', ...extra });
const at = value => new Date(value);
try {
  // Daily: the next local time after creation, once per missed stretch.
  const daily = watch({ time: '08:00' });
  assert.equal(assistantWatchDue(daily, at('2026-11-02T13:05:00Z'), tz), false, 'created after today\'s time');
  assert.equal(assistantWatchNextRun(daily, at('2026-11-02T13:05:00Z'), tz), '2026-11-03T07:00:00.000Z', '08:00 in Stockholm is 07:00Z in winter');
  assert.equal(assistantWatchDue(daily, at('2026-11-03T06:59:00Z'), tz), false);
  assert.equal(assistantWatchDue(daily, at('2026-11-03T07:00:00Z'), tz), true);
  const ran = { ...daily, lastRunAt: '2026-11-03T07:02:00.000Z' };
  assert.equal(assistantWatchDue(ran, at('2026-11-03T12:00:00Z'), tz), false);
  assert.equal(assistantWatchNextRun(ran, at('2026-11-03T12:00:00Z'), tz), '2026-11-04T07:00:00.000Z');
  assert.equal(assistantWatchDue(ran, at('2026-11-07T10:00:00Z'), tz), true, 'a computer that slept runs the missed watch');
  assert.equal(assistantWatchDue({ ...ran, lastRunAt: '2026-11-07T10:00:00.000Z' }, at('2026-11-07T10:05:00Z'), tz), false, 'four missed days are one run, not four');
  // Daylight saving: the same local time in summer, and a skipped minute after the gap.
  assert.equal(assistantWatchNextRun(watch({ time: '08:00' }, { createdAt: '2026-03-28T12:00:00.000Z' }), at('2026-03-28T12:00:00Z'), tz), '2026-03-29T06:00:00.000Z');
  assert.equal(assistantWatchNextRun(watch({ time: '02:30' }, { createdAt: '2026-03-28T12:00:00.000Z' }), at('2026-03-28T12:00:00Z'), tz), '2026-03-29T01:30:00.000Z', '02:30 does not exist; 03:30 CEST follows the gap');
  assert.equal(assistantWatchNextRun(watch({ time: '02:30' }, { createdAt: '2026-10-24T12:00:00.000Z' }), at('2026-10-24T12:00:00Z'), tz), '2026-10-25T00:30:00.000Z', 'a repeated 02:30 runs at its first occurrence');
  // Every few hours: the first check runs a new watch; then every N hours.
  const hourly = watch({ hours: 3 });
  assert.equal(assistantWatchDue(hourly, at('2026-11-02T13:01:00Z'), tz), true);
  const later = { ...hourly, lastRunAt: '2026-11-02T13:01:00.000Z' };
  assert.equal(assistantWatchDue(later, at('2026-11-02T16:00:59Z'), tz), false);
  assert.equal(assistantWatchDue(later, at('2026-11-02T16:01:00Z'), tz), true);
  assert.equal(assistantWatchNextRun(later, at('2026-11-02T14:00:00Z'), tz), '2026-11-02T16:01:00.000Z');
  assert.equal(assistantWatchDue({ ...hourly, enabled: false }, at('2026-11-02T13:01:00Z'), tz), false, 'a paused watch never runs');
  assert.equal(assistantWatchNextRun({ ...hourly, enabled: false }, at('2026-11-02T13:01:00Z'), tz), undefined);
  assert.deepEqual([{ time: '07:30' }, { hours: 1 }, { hours: 3 }, { hours: 6 }, { hours: 12 }].map(assistantWatchRunsPerDay), [1, 24, 8, 4, 2]);
  assert.equal(assistantWatchScheduleText({ hours: 1 }), 'varje timme, 24 körningar per dygn.');
  assert.equal(assistantWatchScheduleText({ time: '07:30' }), 'varje dag kl. 07:30, 1 körning per dygn.');
  // Capacity: one start per five-minute check is twelve runs an hour, summed over the enabled watches.
  assert.equal(ASSISTANT_WATCH_CHECK_MS, 5 * 60_000);
  assert.equal(assistantWatchOverCapacity(Array(12).fill(24)), false, 'twelve hourly watches fill the schedule exactly');
  assert.equal(assistantWatchOverCapacity([...Array(12).fill(24), 1]), true, 'one more daily run is more than twelve an hour');
  assert.equal(assistantWatchOverCapacity([...Array(11).fill(24), 8, 4, 1]), false, 'eleven hourly, one three-hourly, one six-hourly and one daily: about 11.5 an hour');
  assert.equal(assistantWatchOverCapacity(Array(20).fill(8)), false, 'twenty three-hourly watches need under seven runs an hour');
  // The count of failed runs: only `run` counts, a success clears it, the third pauses an enabled watch.
  {
    const counted = watch({ hours: 1 }), result = (status, failure) => ({ changed: false, summary: 'x', at: '2026-11-03T10:00:00.000Z', status, ...(failure ? { failure } : {}) });
    assert.equal(assistantWatchRecord(counted, result('failed', 'run')), false); assert.equal(counted.failedRuns, 1);
    for (const failure of ['interrupted', 'disconnected', 'unavailable', 'stopped', undefined]) assert.equal(assistantWatchRecord(counted, result('failed', failure)), false);
    assert.equal(counted.failedRuns, 1, 'Tabai\'s own trouble neither adds nor clears'); assert.equal(counted.lastResult.status, 'failed');
    assert.equal(assistantWatchRecord(counted, result('ok')), false); assert.equal(counted.failedRuns, undefined, 'a successful run clears the count');
    assistantWatchRecord(counted, result('failed', 'run')); assistantWatchRecord(counted, result('failed', 'run'));
    assert.equal(assistantWatchRecord(counted, result('failed', 'run')), true, 'the third in a row pauses');
    assert.deepEqual([counted.enabled, counted.pausedAfterFailures, counted.failedRuns], [false, true, 3]);
    assert.equal(assistantWatchRecord(counted, result('failed', 'run')), false, 'a paused watch is not paused again'); assert.equal(counted.failedRuns, 3);
    assistantWatchSetEnabled(counted, true);
    assert.deepEqual([counted.enabled, counted.pausedAfterFailures, counted.failedRuns], [true, undefined, undefined], 'turning it on starts over');
  }

  // The private store: twenty at most, public addresses only, interrupted runs reported.
  {
    const dir = fresh(), store = new AssistantWatches(dir), now = at('2026-11-02T13:00:00Z');
    const intent = (title, target = { url: 'https://elpriset.example/' }, cadence = { hours: 6 }) => ({ kind: 'watch', title, target, condition: 'Något nytt', cadence });
    await assert.rejects(store.create(intent('Mejl', { url: 'https://mail.google.com/mail/u/0/' }), undefined, now), /Mejl och kalender/);
    await assert.rejects(store.create(intent('Router', { url: 'http://192.168.1.1/' }), undefined, now), /lokala nätverket/);
    const first = await store.create(intent('Elpris'), randomUUID(), now);
    assert.equal(first.enabled, true); assert.equal(first.createdAt, now.toISOString());
    for (let index = 1; index < 20; index++) await store.create(intent(`Sök ${index}`, { query: `elpris ${index}` }, { time: '08:00' }), undefined, now);
    await assert.rejects(store.create(intent('För många'), undefined, now), /högst 20/);
    assert.equal(new AssistantWatches(dir).list.length, 20, 'the watches are saved');
    assert.equal(store.due(at('2026-11-02T13:01:00Z'), tz)?.id, first.id, 'the only due watch');
    await store.update(first.id, entry => { entry.lastRunAt = '2026-11-02T13:01:00.000Z'; });
    await new AssistantWatches(dir).recover(at('2026-11-02T13:10:00Z'));
    const recovered = new AssistantWatches(dir).find(first.id);
    assert.equal(recovered.lastResult.status, 'failed'); assert.match(recovered.lastResult.summary, /avbröts[\s\S]*körs inte om/);
    assert.equal(assistantWatchDue(recovered, at('2026-11-02T13:15:00Z'), tz), false, 'an interrupted run is never repeated');
    const view = store.view(at('2026-11-02T13:15:00Z'), tz, first.id, ASSISTANT_WATCH_WEB_OFF);
    assert.equal(view[0].running, true); assert.equal(view[0].paused, ASSISTANT_WATCH_WEB_OFF); assert.equal(view[0].nextRunAt, undefined);
    await store.remove(first.id);
    assert.equal(store.list.length, 19);
  }

  // The controller: cards, scheduling through its existing timer, its own executor and model.
  const dir = fresh();
  let clock = at('2026-11-02T13:00:00.000Z');
  const notices = [];
  const chatExecutor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
  const watchExecutor = { starts: [], stops: 0, revoked: 0, fail: undefined,
    async start(context, callbacks) { if (this.fail) throw new Error(this.fail); this.starts.push({ context, callbacks }); }, async stop() { this.stops++; }, async close() {}, async revokeWeb() { this.revoked++; } };
  const workflow = { async start() { throw new Error('no mail tasks here'); }, async stop() {}, async close() {}, async open() {} };
  const create = () => { const controller = new AssistantController(process.cwd(), dir, workflow, { chatExecutor, watchExecutor, clock: () => clock, awakeMs: 0, notice: notice => notices.push(notice) }); controllers.push(controller); return controller; };
  let controller = create();
  const request = (operation, input = {}) => controller.request(operation, input);
  const settings = async extra => { const current = (await request('status')).assistant; return request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, ...extra }) }); };
  const tick = () => request('status', { scheduler: 'true', browserConnected: 'true' });
  const turn = async () => { await request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Bevaka elpriset åt mig' }); return chatExecutor.starts.at(-1).callbacks; };
  const watchIntent = (title, cadence, target = { url: 'https://elpriset.example/' }) => ({ kind: 'watch', title, target, condition: 'Spotpriset under 1 kr/kWh', cadence });

  let view = (await request('status')).chat;
  assert.equal(view.watchModel, 'local:qwen3.5:4b-q4_K_M', 'watches default to the free local model');
  assert.deepEqual(view.watches, []);
  assert.equal((await request('status')).assistant.settings.watchAgent, undefined, 'old settings stay without the field');
  // Web off: no watch card.
  let callbacks = await turn();
  await assert.rejects(callbacks.chatPropose(watchIntent('Elpris', { time: '08:00' })), /Söka och läsa/);
  await callbacks.chatReply('Webben är avstängd.');
  // Explicit: a new workspace takes the machine's time zone, and CI runs in UTC.
  await settings({ web: { level: 'read', login: false }, timezone: 'Europe/Stockholm' });
  // The card names the model, the runs per day and what each run costs.
  callbacks = await turn();
  const local = await callbacks.chatPropose(watchIntent('Elpris', { time: '08:00' }));
  await callbacks.chatReply('Ett kort väntar.');
  let card = (await request('status')).chat.messages.find(entry => entry.card?.id === local.cardId).card;
  assert.equal(card.title, 'Bevaka: Elpris');
  assert.match(card.detail, /Sida: https:\/\/elpriset\.example\/[\s\S]*Villkor: Spotpriset[\s\S]*varje dag kl\. 08:00, 1 körning per dygn[\s\S]*Modell: Lokal · Qwen3\.5 4B\. Körs på den här datorn utan kostnad/);
  await request('correct', { action: 'watch-model', model: 'codex:gpt-6.1-terra' });
  assert.equal((await request('status')).chat.watchModel, 'codex:gpt-6.1-terra');
  callbacks = await turn();
  const cloud = await callbacks.chatPropose(watchIntent('Laddbox', { hours: 3 }, { query: 'laddbox pris' }));
  await callbacks.chatReply('Ett kort till.');
  card = (await request('status')).chat.messages.find(entry => entry.card?.id === cloud.cardId).card;
  assert.match(card.detail, /Sökning: ”laddbox pris”[\s\S]*var 3:e timme, 8 körningar per dygn[\s\S]*Codex · [^\n]*\. Varje körning drar användning av ditt Codex-abonnemang/);
  await request('correct', { action: 'watch-model', model: 'berget:zai-org/GLM-5.3-Flash' });
  callbacks = await turn();
  const paid = await callbacks.chatPropose(watchIntent('Annat', { hours: 12 }));
  await callbacks.chatReply('Ett tredje.');
  assert.match((await request('status')).chat.messages.find(entry => entry.card?.id === paid.cardId).card.detail, /2 körningar per dygn[\s\S]*Berget · [^\n]*\. Varje körning kostar pengar hos Berget/);
  await request('correct', { action: 'chat-dismiss', cardId: paid.cardId });
  // A stale panel without the field keeps the saved choice.
  const current = (await request('status')).assistant;
  const { watchAgent: _saved, ...stale } = current.settings;
  await request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify(stale) });
  assert.equal((await request('status')).chat.watchModel, 'berget:zai-org/GLM-5.3-Flash', 'a panel from before watches keeps the watch model');
  await request('correct', { action: 'watch-model', model: 'local:qwen3.5:4b-q4_K_M' });
  await request('correct', { action: 'chat-model', model: 'claude:claude-opus-5-5' });
  // Confirming the cards saves the watches; the conversation is their origin.
  const origin = (await request('status')).chat.id;
  await request('correct', { action: 'chat-confirm', cardId: local.cardId });
  await request('correct', { action: 'chat-confirm', cardId: cloud.cardId });
  view = (await request('status')).chat;
  assert.deepEqual(view.watches.map(entry => entry.title), ['Elpris', 'Laddbox']);
  const [elpris, laddbox] = view.watches;
  assert.equal(elpris.createdFrom, origin); assert.equal(elpris.runsPerDay, 1); assert.equal(elpris.nextRunAt, '2026-11-03T07:00:00.000Z'); assert.equal(elpris.running, false);
  assert.equal(laddbox.runsPerDay, 8); assert.equal(laddbox.nextRunAt, clock.toISOString(), 'a new three-hourly watch is due now');
  assert.match(view.messages.at(-1).text, /Bevakningen ”Laddbox” är sparad och körs var 3:e timme/);

  // The existing timer: one due watch per five-minute check, on the watch's own model and executor.
  clock = at('2026-11-02T13:05:00.000Z');
  await tick();
  assert.equal(watchExecutor.starts.length, 1);
  let started = watchExecutor.starts[0];
  assert.equal(started.context.watch.title, 'Laddbox'); assert.deepEqual(started.context.watch.target, { query: 'laddbox pris' });
  assert.deepEqual(started.context.settings.accounts, []); assert.deepEqual(started.context.items, []); assert.equal(started.context.chat, undefined);
  assert.equal(started.context.settings.agent.backend, 'local', 'never the chat model'); assert.equal(started.context.settings.agent.local.model, 'qwen3.5:4b-q4_K_M');
  assert.equal((await request('status')).chat.watches.find(entry => entry.title === 'Laddbox').running, true);
  clock = at('2026-11-02T13:06:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 1, 'no second start within five minutes or while one runs');
  await assert.rejects(request('correct', { action: 'watch-run', watchId: elpris.id }), /körs redan/);
  // A result: saved on the watch, posted in "Bevakningar" without changing the selection, and a notice.
  const selected = (await request('status')).chat.id, noticesBefore = notices.length;
  await started.callbacks.watchReport({ changed: true, summary: 'Laddboxen kostar nu 4 990 kr enligt https://shop.example/laddbox', activity: ['Sökte med DuckDuckGo: laddbox pris'] });
  view = (await request('status')).chat;
  assert.equal(view.id, selected, 'a background result never selects its conversation');
  const result = view.watches.find(entry => entry.title === 'Laddbox').lastResult;
  assert.equal(result.changed, true); assert.equal(result.status, 'ok'); assert.match(result.summary, /4 990 kr/);
  assert.equal(notices.length, noticesBefore + 1); assert.equal(notices.at(-1).count, 1, 'the result is one more thing to look at'); assert.equal(notices.at(-1).desktop, true, 'watches tell the user by default'); assert.equal(notices.at(-1).kind, 'watch');
  await request('correct', { action: 'watch-notify', enabled: 'false' });
  assert.equal((await request('status')).chat.watchNotifications, false);
  await request('correct', { action: 'chat-select', conversationId: view.watchConversationId });
  view = (await request('status')).chat;
  assert.equal(view.title, 'Bevakningar');
  assert.equal(view.messages.at(-1).text, 'Bevakning: Laddbox\nStatus: Ändring\nLaddboxen kostar nu 4 990 kr enligt https://shop.example/laddbox');
  assert.equal(view.messages.at(-1).role, 'assistant', 'a model summary of web pages is never system text');
  assert.deepEqual(view.messages.at(-1).webActivity, ['Sökte med DuckDuckGo: laddbox pris'], 'the web lines Tabai registered travel as a typed list');
  await request('correct', { action: 'chat-select', conversationId: selected });
  // The next check: nothing is due before its time.
  clock = at('2026-11-02T13:12:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 1);
  // The morning: the most overdue first, the other at a later check; a failure is reported once.
  await settings({ morning: { enabled: false, time: '08:00', notifications: true } });
  clock = at('2026-11-03T07:00:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 2); started = watchExecutor.starts[1];
  assert.equal(started.context.watch.title, 'Elpris');
  await started.callbacks.exit('Den valda lokala modellen är inte hämtad. Hämta den under Inställningar och fortsätt sedan.');
  view = (await request('status')).chat;
  assert.match(view.watches.find(entry => entry.title === 'Elpris').lastResult.summary, /lokala modellen är inte hämtad/);
  assert.equal(view.watches.find(entry => entry.title === 'Elpris').lastResult.status, 'failed');
  await started.callbacks.watchReport({ changed: true, summary: 'sent', activity: [] });
  assert.equal((await request('status')).chat.watches.find(entry => entry.title === 'Elpris').lastResult.status, 'failed', 'a late report from an ended run changes nothing');
  clock = at('2026-11-03T07:06:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 3); started = watchExecutor.starts[2];
  assert.equal(started.context.watch.title, 'Laddbox');
  assert.equal(started.context.watch.previous.summary, result.summary, 'the previous result is the model\'s comparison');
  await started.callbacks.watchReport({ changed: true, summary: 'Ny sänkning till 4 490 kr.', activity: [] });
  assert.equal(notices.at(-1).desktop, false, 'the watch setting turns desktop notices off');
  await request('correct', { action: 'watch-notify', enabled: 'true' });
  // A restart: the morning's runs are not replayed; an unfinished run is reported, never rerun.
  clock = at('2026-11-03T10:07:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 4, 'the three-hourly watch is due again');
  await controller.close();
  clock = at('2026-11-03T10:10:00.000Z');
  controller = create(); await tick();
  assert.equal(watchExecutor.starts.length, 4, 'nothing reruns after a restart');
  view = (await request('status')).chat;
  assert.match(view.watches.find(entry => entry.title === 'Laddbox').lastResult.summary, /avbröts när Tabai stängdes/);
  assert.equal(view.watches.find(entry => entry.title === 'Elpris').nextRunAt, '2026-11-04T07:00:00.000Z');
  // Manual run, pause, resume and delete.
  await request('correct', { action: 'watch-run', watchId: elpris.id });
  assert.equal(watchExecutor.starts.length, 5);
  await watchExecutor.starts[4].callbacks.watchReport({ changed: false, summary: 'Fortfarande över 1 kr.', activity: [] });
  await request('correct', { action: 'watch-pause', watchId: laddbox.id });
  view = (await request('status')).chat;
  assert.equal(view.watches.find(entry => entry.id === laddbox.id).enabled, false); assert.equal(view.watches.find(entry => entry.id === laddbox.id).nextRunAt, undefined);
  clock = at('2026-11-03T20:00:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 5, 'a paused watch is not started');
  await request('correct', { action: 'watch-pause', watchId: laddbox.id, paused: 'false' });
  assert.equal((await request('status')).chat.watches.find(entry => entry.id === laddbox.id).enabled, true);
  // Web off: watches pause with a plain message; a running one stops and says why.
  await request('correct', { action: 'watch-run', watchId: laddbox.id });
  assert.equal(watchExecutor.starts.length, 6);
  await settings({ web: { level: 'off', login: false } });
  assert.equal(watchExecutor.stops, 1); assert(watchExecutor.revoked >= 1, 'a changed web setting ends the watch executor\'s web access');
  view = (await request('status')).chat;
  assert.match(view.watches.find(entry => entry.id === laddbox.id).lastResult.summary, /stängdes av under körningen/);
  assert(view.watches.every(entry => entry.paused === 'Webbåtkomsten är avstängd' && entry.nextRunAt === undefined));
  await watchExecutor.starts[5].callbacks.watchReport({ changed: true, summary: 'för sent', activity: [] });
  assert.match((await request('status')).chat.watches.find(entry => entry.id === laddbox.id).lastResult.summary, /stängdes av/, 'the stopped run cannot report afterwards');
  clock = at('2026-11-04T09:00:00.000Z'); await tick();
  assert.equal(watchExecutor.starts.length, 6, 'nothing runs while web access is off');
  await assert.rejects(request('correct', { action: 'watch-run', watchId: elpris.id }), /Webbåtkomsten är avstängd/);
  callbacks = await turn();
  await assert.rejects(callbacks.chatPropose(watchIntent('Ny', { hours: 6 })), /Söka och läsa/);
  assert((await callbacks.chatConfig()).watches.every(entry => entry.status === 'paused-web-off' && entry.nextRun === undefined), 'chat_config says that web access holds the watches');
  await callbacks.chatReply('Avstängt.');
  // A failed start is reported on the watch, and the next run can start.
  await settings({ web: { level: 'read', login: false } });
  watchExecutor.fail = 'Anslut Berget med din API-nyckel i inställningarna först.';
  await assert.rejects(request('correct', { action: 'watch-run', watchId: elpris.id }), /Anslut Berget/);
  assert.match((await request('status')).chat.watches.find(entry => entry.id === elpris.id).lastResult.summary, /Anslut Berget/);
  watchExecutor.fail = undefined;
  await request('correct', { action: 'watch-run', watchId: elpris.id });
  assert.equal(watchExecutor.starts.length, 7);
  await request('correct', { action: 'watch-delete', watchId: elpris.id });
  assert.equal(watchExecutor.stops, 2, 'deleting a running watch stops it');
  assert.deepEqual((await request('status')).chat.watches.map(entry => entry.id), [laddbox.id]);
  await assert.rejects(request('correct', { action: 'watch-run', watchId: elpris.id }), /finns inte längre/);

  // chat_config: the watches as the list shows them, in local time, with watchId as their only identity.
  callbacks = await turn();
  let config = await callbacks.chatConfig();
  assert.deepEqual(config.watches.map(entry => Object.keys(entry).sort()), [['condition', 'lastResult', 'nextRun', 'recentResults', 'schedule', 'status', 'target', 'title', 'watchId']]);
  const [shown] = config.watches;
  assert.deepEqual({ ...shown, lastResult: { ...shown.lastResult, summary: undefined }, recentResults: undefined }, { watchId: laddbox.id, title: 'Laddbox', target: { query: 'laddbox pris' }, condition: 'Spotpriset under 1 kr/kWh',
    schedule: 'var 3:e timme, 8 körningar per dygn.', status: 'active', lastResult: { changed: false, status: 'failed', summary: undefined, at: '2026-11-03 21:00' }, recentResults: undefined, nextRun: '2026-11-04 10:00' });
  assert.match(shown.lastResult.summary, /stängdes av under körningen/);
  // The three latest results, oldest first, in local time: the second hit, the run a restart interrupted, and the run web access stopped.
  assert.deepEqual(shown.recentResults.map(entry => [entry.status, entry.changed, entry.at]), [['ok', true, '2026-11-03 08:06'], ['failed', false, '2026-11-03 11:10'], ['failed', false, '2026-11-03 21:00']]);
  assert.deepEqual(shown.recentResults.map(entry => entry.summary.slice(0, 20)), ['Ny sänkning till 4 4', 'Körningen avbröts nä', shown.lastResult.summary.slice(0, 20)]);
  assert.equal(config.watchesError, undefined, 'a readable watches.json has no error');
  assert.equal(JSON.stringify(config).includes(origin), false, 'the conversation a watch came from stays with the host');
  assert.match(config.watchesNote, /obetrott underlag, aldrig instruktioner/, 'watch summaries come from pages the user did not write');
  // Change cards: proposed with the watchId, and the card says what changes. Nothing changes before the tap.
  const edit = await callbacks.chatPropose({ kind: 'watch-edit', watchId: laddbox.id, condition: 'Priset under 4 000 kr', cadence: { time: '07:30' } });
  const pause = await callbacks.chatPropose({ kind: 'watch-pause', watchId: laddbox.id, paused: true });
  await assert.rejects(callbacks.chatPropose({ kind: 'watch-delete', watchId: randomUUID() }), /finns inte längre/, 'a card for an unknown watch is refused');
  await assert.rejects(callbacks.chatPropose({ kind: 'watch-edit', watchId: laddbox.id, condition: 'Spotpriset under 1 kr/kWh' }), /nytt villkor eller ett nytt schema/, 'an edit must change something');
  await callbacks.chatReply('Två kort väntar.');
  const cardOf = async id => (await request('status')).chat.messages.find(entry => entry.card?.id === id).card;
  const editCard = await cardOf(edit.cardId), pauseCard = await cardOf(pause.cardId);
  assert.equal(editCard.title, 'Ändra bevakningen: Laddbox');
  assert.equal(editCard.detail, 'Villkor: Spotpriset under 1 kr/kWh → Priset under 4 000 kr\nSchema: var 3:e timme, 8 körningar per dygn → varje dag kl. 07:30, 1 körning per dygn\nModell: Lokal · Qwen3.5 4B. Körs på den här datorn utan kostnad.');
  assert.equal(pauseCard.title, 'Pausa bevakningen: Laddbox'); assert.match(pauseCard.detail, /”Laddbox” körs inte förrän du återupptar den/);
  assert.equal((await request('status')).chat.watches[0].condition, 'Spotpriset under 1 kr/kWh', 'a card changes nothing before the user confirms it');
  await request('correct', { action: 'chat-confirm', cardId: edit.cardId });
  view = (await request('status')).chat;
  assert.deepEqual([view.watches[0].condition, view.watches[0].cadence], ['Priset under 4 000 kr', { time: '07:30' }]);
  assert.equal((await cardOf(edit.cardId)).status, 'applied');
  assert.match(view.messages.at(-1).text, /”Laddbox” är ändrad\. Villkor: Priset under 4 000 kr\. Den körs varje dag kl\. 07:30/);
  await request('correct', { action: 'chat-confirm', cardId: pause.cardId });
  assert.equal((await request('status')).chat.watches[0].enabled, false);
  callbacks = await turn();
  config = await callbacks.chatConfig();
  assert.equal(config.watches[0].status, 'paused'); assert.equal(config.watches[0].nextRun, undefined);
  const resume = await callbacks.chatPropose({ kind: 'watch-pause', watchId: laddbox.id, paused: false });
  const remove = await callbacks.chatPropose({ kind: 'watch-delete', watchId: laddbox.id });
  await callbacks.chatReply('Två kort till.');
  // Resuming starts runs again, so the card says what they run on and cost, like a schedule change.
  assert.deepEqual([(await cardOf(resume.cardId)).title, (await cardOf(resume.cardId)).detail], ['Återuppta bevakningen: Laddbox', 'Bevakningen ”Laddbox” körs igen: varje dag kl. 07:30, 1 körning per dygn.\nModell: Lokal · Qwen3.5 4B. Körs på den här datorn utan kostnad.']);
  assert.deepEqual([(await cardOf(remove.cardId)).title, (await cardOf(remove.cardId)).detail], ['Ta bort bevakningen: Laddbox', 'Bevakningen ”Laddbox” tas bort och körs inte mer. Tidigare resultat finns kvar i samtalet Bevakningar.']);
  await request('correct', { action: 'chat-confirm', cardId: remove.cardId });
  assert.deepEqual((await request('status')).chat.watches, []);
  // The watch is gone: its remaining card is refused by the host and closed as failed with the reason, never left waiting.
  await assert.rejects(request('correct', { action: 'chat-confirm', cardId: resume.cardId }), /finns inte längre/);
  const closed = await cardOf(resume.cardId);
  assert.equal(closed.status, 'failed'); assert.match(closed.error, /Bevakningen finns inte längre/);
  await assert.rejects(request('correct', { action: 'chat-confirm', cardId: resume.cardId }), /redan hanterat/, 'a closed card cannot be confirmed again');
  assert.deepEqual((await request('status')).chat.watches, []);
  // An unreadable watches.json: chat_config says so instead of listing none.
  await controller.close();
  writeFileSync(join(dir, 'watches.json'), '{ inte json');
  controller = create();
  callbacks = await turn();
  config = await callbacks.chatConfig();
  assert.deepEqual(config.watches, []); assert.match(config.watchesError, /Bevakningarna kunde inte läsas/);
  assert.match((await request('status')).chat.watchesError, /Bevakningarna kunde inte läsas/);
  await callbacks.chatReply('Kunde inte läsas.');
  await controller.close();

  // Automatic pause through the controller: counted failures, Tabai's own trouble, the pause itself, and starting over.
  {
    const pauseDir = fresh(), pauseNotices = [];
    let now = at('2026-11-05T09:00:00.000Z');
    const runs = { starts: [], fail: undefined, async start(context, callbacks) { if (this.fail) throw new Error(this.fail); this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const saved = await new AssistantWatches(pauseDir).create({ kind: 'watch', title: 'Lagerstatus', target: { url: 'https://lager.example/' }, condition: 'Varan finns i lager', cadence: { hours: 1 } }, undefined, now);
    const open = () => { const host = new AssistantController(process.cwd(), pauseDir, workflow, { chatExecutor, watchExecutor: runs, clock: () => now, awakeMs: 0, notice: notice => pauseNotices.push(notice) }); controllers.push(host); return host; };
    let host = open();
    const ask = (operation, input = {}) => host.request(operation, input);
    const current = (await ask('status')).assistant;
    await ask('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, web: { level: 'read', login: false }, timezone: tz }) });
    const run = async () => { await ask('correct', { action: 'watch-run', watchId: saved.id }); return runs.starts.at(-1).callbacks; };
    const shown = async () => (await ask('status')).chat.watches[0];
    const later = minutes => { now = new Date(now.getTime() + minutes * 60_000); };
    // 1. Counted: the model ran and ended without a report, or reported that it could not read the source.
    await (await run()).exit('Den lokala modellen avslutade utan ett verifierat resultat.', 'run');
    assert.equal((await shown()).failedRuns, 1, 'a run without a report counts');
    later(1); await (await run()).watchReport({ changed: false, summary: 'Sidan svarade med ”Sidan finns inte”.', activity: ['Läste https://lager.example/'], failure: 'run' });
    let seen = await shown();
    assert.equal(seen.failedRuns, 2, 'an unreadable source counts');
    assert.deepEqual([seen.lastResult.status, seen.lastResult.failure, seen.lastResult.changed, seen.lastResult.summary], ['failed', 'run', false, 'Sidan svarade med ”Sidan finns inte”.']);
    // 2. Not counted, and not cleared: a lost browser connection, a model backend that could not run, a failed start, and a run Tabai's restart interrupted.
    later(1); await (await run()).exit('Webbläsaranslutningen svarade inte. Försök läsa sidan igen.', 'disconnected');
    later(1); await (await run()).watchReport({ changed: false, summary: 'Tillägget var inte anslutet.', activity: [], failure: 'disconnected' });
    later(1); await (await run()).exit('Ollama svarar inte på den här datorn. Starta Ollama-appen och fortsätt uppdraget.', 'unavailable');
    for (const missing of ['Codex kunde inte startas. Installera Codex och kör codex login.', 'Claude Code behöver loggas in igen. Kör claude, logga in och fortsätt sedan.', 'Anslut Berget med din API-nyckel i inställningarna först.']) {
      runs.fail = missing; later(1);
      await assert.rejects(ask('correct', { action: 'watch-run', watchId: saved.id }), error => error.message === missing);
    }
    runs.fail = undefined;
    seen = await shown();
    assert.equal(seen.failedRuns, 2, 'none of these count toward the pause'); assert.equal(seen.enabled, true);
    assert.deepEqual([seen.lastResult.status, seen.lastResult.failure], ['failed', 'unavailable'], 'a failed start still shows as a failed run');
    later(1); await run();
    await host.close();
    later(1); host = open(); await ask('status');
    seen = await shown();
    assert.deepEqual([seen.failedRuns, seen.lastResult.failure], [2, 'interrupted'], 'an interrupted run neither counts nor clears'); assert.match(seen.lastResult.summary, /avbröts när Tabai stängdes/);
    // 3. The third counted failure in a row pauses the watch: in the list, in chat_config, in Bevakningar and in a notice without page text.
    const noticed = pauseNotices.length;
    later(1); await (await run()).exit('Uppdragets tidsgräns nåddes. Rapporterad kontotäckning finns kvar; kör uppdraget igen för ett komplett resultat.', 'run');
    seen = await shown();
    assert.deepEqual([seen.enabled, seen.pausedAfterFailures, seen.nextRunAt], [false, true, undefined], 'paused by Tabai, with no next run');
    assert.equal(pauseNotices.length, noticed + 1, 'one notice for the pause');
    const pausedNotice = pauseNotices.at(-1);
    assert.deepEqual(Object.keys(pausedNotice).sort(), ['count', 'critical', 'desktop', 'id', 'kind', 'watchEvent'], 'counts and a fixed kind only');
    assert.deepEqual([pausedNotice.kind, pausedNotice.watchEvent, pausedNotice.desktop], ['watch', 'paused', true]);
    assert.equal(JSON.stringify(pausedNotice).includes('Lagerstatus'), false, 'no watch or page text in the notice');
    let view = (await ask('correct', { action: 'chat-select', conversationId: (await ask('status')).chat.watchConversationId })).chat;
    assert.match(view.messages.at(-2).text, /^Bevakning: Lagerstatus\nStatus: Kunde inte köras\nUppdragets tidsgräns nåddes/);
    assert.deepEqual([view.messages.at(-1).role, view.messages.at(-1).text], ['system', 'Bevakningen ”Lagerstatus” pausades efter 3 misslyckade körningar i rad. Slå på den igen i listan Bevakningar när sidan går att läsa.']);
    await ask('correct', { action: 'chat-new' });
    await ask('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Hur går bevakningen?' });
    const chatTurn = chatExecutor.starts.at(-1).callbacks;
    assert.equal((await chatTurn.chatConfig()).watches[0].status, 'paused-after-failures', 'chat_config says Tabai paused it');
    await chatTurn.chatReply('Den är pausad.');
    later(120); await ask('status', { scheduler: 'true', browserConnected: 'true' });
    const startsWhilePaused = runs.starts.length;
    later(120); await ask('status', { scheduler: 'true', browserConnected: 'true' });
    assert.equal(runs.starts.length, startsWhilePaused, 'a paused watch is not scheduled');
    // 4. Turning it on again starts the count over; a successful run, scheduled or manual, clears it as well.
    await ask('correct', { action: 'watch-pause', watchId: saved.id, paused: 'false' });
    seen = await shown();
    assert.deepEqual([seen.enabled, seen.pausedAfterFailures, seen.failedRuns], [true, undefined, undefined], 'resuming starts the count over');
    later(1); await (await run()).exit('Den lokala modellen fastnade i samma steg.', 'run');
    later(1); await (await run()).exit('Den lokala modellen fastnade i samma steg.', 'run');
    assert.equal((await shown()).failedRuns, 2);
    later(61); await ask('status', { scheduler: 'true', browserConnected: 'true' });
    assert.equal(runs.starts.at(-1).context.watch.id, saved.id, 'the scheduled run starts');
    await runs.starts.at(-1).callbacks.watchReport({ changed: false, summary: 'Slut i lager.', activity: [] });
    assert.equal((await shown()).failedRuns, undefined, 'a successful scheduled run clears the count');
    later(1); await (await run()).exit('Den lokala modellen slutade svara.', 'run');
    later(1); await (await run()).exit('Den lokala modellen slutade svara.', 'run');
    later(1); await (await run()).watchReport({ changed: true, summary: 'Finns i lager igen enligt https://lager.example/.', activity: [] });
    seen = await shown();
    assert.deepEqual([seen.failedRuns, seen.enabled], [undefined, true], 'a successful manual run clears the count');
    // With watch notices off the pause is still posted and counted, without a desktop notice; the chat card resumes it.
    await ask('correct', { action: 'watch-notify', enabled: 'false' });
    for (let index = 0; index < 3; index++) { later(1); await (await run()).exit('Den lokala modellen slutade svara.', 'run'); }
    assert.deepEqual([pauseNotices.at(-1).watchEvent, pauseNotices.at(-1).desktop], ['paused', false]);
    assert.equal((await shown()).pausedAfterFailures, true);
    await ask('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Starta bevakningen igen' });
    const resumeTurn = chatExecutor.starts.at(-1).callbacks;
    const resume = await resumeTurn.chatPropose({ kind: 'watch-pause', watchId: saved.id, paused: false });
    await resumeTurn.chatReply('Ett kort väntar.');
    await ask('correct', { action: 'chat-confirm', cardId: resume.cardId });
    seen = await shown();
    assert.deepEqual([seen.enabled, seen.pausedAfterFailures, seen.failedRuns], [true, undefined, undefined], 'the resume card starts the count over too');
    // The user changes the web setting during a run and web stays on: the run ends as stopped, which never counts.
    later(1); await (await run()).exit('Den lokala modellen slutade svara.', 'run');
    later(1); const changed = await run();
    const before = await ask('status');
    await ask('correct', { action: 'settings', revision: String(before.assistant.revision), settings: JSON.stringify({ ...before.assistant.settings, web: { level: 'act', login: false } }) });
    seen = await shown();
    assert.deepEqual([seen.running, seen.lastResult.status, seen.lastResult.failure, seen.failedRuns], [false, 'failed', 'stopped', 1], 'a read-to-act change ends the run as stopped');
    await changed.exit('Webbläsaråtkomsten har avslutats.', 'run');
    seen = await shown();
    assert.deepEqual([seen.lastResult.failure, seen.failedRuns, seen.enabled], ['stopped', 1, true], 'the run cut off by the change cannot report a counted failure afterwards');
    await host.close();
  }

  // Capacity: a new watch's card warns when the enabled watches would need more than twelve runs an hour.
  {
    const capacityDir = fresh(), store = new AssistantWatches(capacityDir), now = at('2026-11-05T09:00:00.000Z');
    const hourly = title => ({ kind: 'watch', title, target: { query: `pris ${title}` }, condition: 'Lägre pris', cadence: { hours: 1 } });
    for (let index = 0; index < 11; index++) await store.create(hourly(`Vara ${index}`), undefined, now);
    const paused = await store.create(hourly('Pausad'), undefined, now);
    await store.update(paused.id, entry => assistantWatchSetEnabled(entry, false));
    const host = new AssistantController(process.cwd(), capacityDir, workflow, { chatExecutor, watchExecutor, clock: () => now, awakeMs: 0 }); controllers.push(host);
    const current = (await host.request('status', {})).assistant;
    await host.request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, web: { level: 'read', login: false }, timezone: tz }) });
    const propose = async intent => {
      await host.request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Bevaka något mer' });
      const turnCallbacks = chatExecutor.starts.at(-1).callbacks, card = await turnCallbacks.chatPropose(intent);
      await turnCallbacks.chatReply('Ett kort väntar.');
      return (await host.request('status', {})).chat.messages.find(entry => entry.card?.id === card.cardId).card;
    };
    const fits = await propose(hourly('Tolfte'));
    assert.equal(fits.warning, undefined, 'eleven enabled hourly watches and a twelfth fit; the paused one does not count');
    await host.request('correct', { action: 'chat-confirm', cardId: fits.id });
    const over = await propose({ ...hourly('Daglig'), cadence: { time: '07:00' } });
    assert.equal(over.warning, ASSISTANT_WATCH_CAPACITY_WARNING, 'twelve hourly watches and one more run need more than twelve an hour');
    assert.match(over.warning, /fler än 12 körningar i timmen[\s\S]*högst en bevakning var femte minut/);
    assert.match(over.detail, /^Sökning: ”pris Daglig”/, 'the card still says what it watches');
    assert.equal((await host.request('status', {})).chat.watches.filter(entry => entry.enabled).length, 12);
    await host.close();
  }
  // History: the ten latest results with a 300-character summary, a file from before the history, a value and the trend.
  {
    const historyDir = fresh();
    const older = watch({ time: '23:59' }, { lastRunAt: '2026-11-03T09:00:00.000Z', lastResult: { changed: false, summary: 'Äldre resultat: 164 öre/kWh.', at: '2026-11-03T09:01:00.000Z', status: 'ok' } });
    writeFileSync(join(historyDir, 'watches.json'), JSON.stringify({ state: { version: 1, watches: [older] } }), { mode: 0o600 });
    const store = new AssistantWatches(historyDir);
    assert.equal(store.unavailable, undefined, 'a watches.json from before the history loads as before');
    assert.equal(store.find(older.id).history, undefined);
    assert.deepEqual(assistantWatchHistory(store.find(older.id)), [older.lastResult], 'its last result is its history');
    await store.update(older.id, entry => { assistantWatchRecord(entry, { changed: true, summary: 'x'.repeat(400), at: '2026-11-03T10:01:00.000Z', status: 'ok', value: { amount: 120, unit: 'öre/kWh' } }); });
    let saved = new AssistantWatches(historyDir).find(older.id);
    assert.deepEqual(saved.history.map(entry => entry.summary.length), [older.lastResult.summary.length, 300], 'the older result starts the history; a summary there is at most 300 characters');
    assert.equal(saved.lastResult.summary.length, 400, 'lastResult stays whole for compatibility'); assert.deepEqual(saved.lastResult.value, { amount: 120, unit: 'öre/kWh' });
    for (let index = 0; index < 12; index++) {
      const failed = index % 4 === 3;
      await store.update(older.id, entry => { assistantWatchRecord(entry, { changed: false, summary: `Körning ${index}`, at: new Date(Date.parse('2026-11-03T11:00:00.000Z') + index * 3_600_000).toISOString(), status: failed ? 'failed' : 'ok', ...(failed ? { failure: 'run' } : { value: { amount: 50 - index, unit: 'öre/kWh' } }) }); });
    }
    saved = new AssistantWatches(historyDir).find(older.id);
    assert.deepEqual(saved.history.map(entry => entry.summary), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(index => `Körning ${index}`), 'ten at most, the newest last');
    assert.deepEqual(saved.history.filter(entry => entry.status === 'failed').map(entry => entry.summary), ['Körning 3', 'Körning 7', 'Körning 11'], '"Kunde inte köras" is part of the history');
    assert.equal(saved.history.at(-1).value, undefined, 'a failed run has no value');
    const point = (amount, unit = 'öre/kWh', status = 'ok') => ({ changed: false, summary: 's', at: '2026-11-03T10:00:00.000Z', status, ...(amount === undefined ? {} : { value: { amount, unit } }) });
    assert.deepEqual(assistantWatchTrend([point(164), point(120), point(48)]), { text: '164 → 120 → 48 öre/kWh ↓', direction: 'down' });
    assert.deepEqual(assistantWatchTrend([point(48), point(52.5)]), { text: '48 → 52,5 öre/kWh ↑', direction: 'up' });
    assert.deepEqual(assistantWatchTrend([point(48), point(48)]), { text: '48 → 48 öre/kWh (oförändrat)', direction: 'same' });
    assert.deepEqual(assistantWatchTrend([point(48)]), { text: '48 öre/kWh', direction: 'none' });
    assert.deepEqual(assistantWatchTrend([point(164), point(undefined, undefined, 'failed'), point(48)]), { text: '164 → 48 öre/kWh ↓', direction: 'down' }, 'a failed run is no point in the trend');
    assert.deepEqual(assistantWatchTrend([point(5, 'kr'), point(164), point(120)]), { text: '164 → 120 öre/kWh ↓', direction: 'down' }, 'only the latest unit');
    assert.equal(assistantWatchTrend([1, 2, 3, 4, 5, 6, 7].map(amount => point(amount))).text, '3 → 4 → 5 → 6 → 7 öre/kWh ↑', 'the five latest values');
    assert.match(assistantWatchTrend([point(4990, 'kr')]).text, /^4\s990 kr$/u, 'Swedish number format');
    assert.equal(assistantWatchTrend([point(undefined), point(undefined)]), undefined, 'no values: the list shows the summaries instead');
    assert.equal(assistantWatchTrend(saved.history).text, '45 → 44 → 42 → 41 → 40 öre/kWh ↓', 'the history\'s own trend skips its failed runs');
  }

  // A tool timeout counts while the browser is still connected; a run that read nothing counts whatever the model said.
  {
    assert.equal(ASSISTANT_CONNECTED_MS, 75_000, 'two 30-second broker pulses and a margin');
    assert.equal(assistantRunFailure('run', true, true), 'run'); assert.equal(assistantRunFailure('run', true, false), 'disconnected');
    assert.equal(assistantRunFailure('run', undefined, false), 'run', 'a run that failed on its own counts without a timeout'); assert.equal(assistantRunFailure('unavailable', true, true), 'unavailable');
    const url = { url: 'https://hang.example/' }, query = { query: 'elpris idag' };
    assert.deepEqual(assistantWatchOutcome({ changed: true, summary: 'Ändrat.', web: { succeeded: ['web_open'] } }, url, true), { changed: true, summary: 'Ändrat.', status: 'ok' });
    assert.deepEqual(assistantWatchOutcome({ changed: true, summary: 'Påhittat.', web: { succeeded: ['web_search', 'web_scroll'] } }, url, true), { changed: false, summary: ASSISTANT_WATCH_UNREAD, status: 'failed', failure: 'run' }, 'a search alone reads no page address');
    assert.equal(assistantWatchOutcome({ changed: false, summary: 'Inga nya träffar.', web: { succeeded: ['web_search'] } }, query, true).status, 'ok', 'a search target is read by its search');
    assert.deepEqual(assistantWatchOutcome({ changed: false, summary: 'x', web: { succeeded: [], timedOut: true } }, url, true), { changed: false, summary: `${ASSISTANT_WATCH_UNREAD} Sidan svarade inte i tid.`, status: 'failed', failure: 'run' });
    assert.equal(assistantWatchOutcome({ changed: false, summary: 'x', web: { succeeded: [], timedOut: true } }, url, false).failure, 'disconnected');
    assert.equal(assistantWatchOutcome({ changed: false, summary: 'x', web: { succeeded: [], disconnected: true, timedOut: true } }, url, true).failure, 'disconnected', 'SESSION_BUSY, QUEUE_FULL and lost connections never count');
    assert.deepEqual(assistantWatchOutcome({ changed: false, summary: 'Sidan saknas.', failure: 'run', web: { succeeded: ['web_open'] } }, url, true), { changed: false, summary: 'Sidan saknas.', status: 'failed', failure: 'run' }, 'readable=false keeps the model\'s explanation');
    assert.deepEqual(assistantWatchOutcome({ changed: true, summary: 'Från en äldre executor.' }, url, false), { changed: true, summary: 'Från en äldre executor.', status: 'ok' }, 'a report without web facts is taken as it is');
    assert.deepEqual(assistantWatchOutcome({ changed: false, summary: 'Läst.', value: { amount: 48, unit: 'öre/kWh' }, web: { succeeded: ['web_read'] } }, url, true).value, { amount: 48, unit: 'öre/kWh' });

    const timeoutDir = fresh(), timeoutNotices = [];
    let now = at('2026-11-05T09:00:00.000Z');
    const runs = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const saved = await new AssistantWatches(timeoutDir).create({ kind: 'watch', title: 'Hänger', target: url, condition: 'Priset under 1 kr/kWh', cadence: { time: '23:59' } }, undefined, now);
    const host = new AssistantController(process.cwd(), timeoutDir, workflow, { chatExecutor, watchExecutor: runs, clock: () => now, awakeMs: 0, notice: notice => timeoutNotices.push(notice) }); controllers.push(host);
    const ask = (operation, input = {}) => host.request(operation, input);
    const current = (await ask('status')).assistant;
    await ask('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, web: { level: 'read', login: false }, timezone: tz }) });
    const later = minutes => { now = new Date(now.getTime() + minutes * 60_000); };
    const pulse = (connected = true) => ask('status', { scheduler: 'true', browserConnected: String(connected) });
    const run = async () => { await ask('correct', { action: 'watch-run', watchId: saved.id }); return runs.starts.at(-1).callbacks; };
    const shown = async () => (await ask('status')).chat.watches[0];
    // 1. A page that hangs while the browser stays connected: each timed-out run counts, and the third in a row pauses the watch.
    later(1); await pulse(); await (await run()).exit('Uppdragets tidsgräns nåddes.', 'run', { timedOut: true });
    assert.deepEqual([(await shown()).failedRuns, (await shown()).lastResult.failure], [1, 'run']);
    later(1); await pulse(); await (await run()).watchReport({ changed: false, summary: 'Sidan svarade inte.', activity: [], failure: 'run', web: { succeeded: [], timedOut: true } });
    later(1); await pulse(); await (await run()).watchReport({ changed: false, summary: 'Inget att läsa.', activity: [], web: { succeeded: [], timedOut: true } });
    let seen = await shown();
    assert.deepEqual([seen.enabled, seen.pausedAfterFailures, seen.failedRuns], [false, true, 3], 'a hanging page pauses its watch after three runs');
    assert.match(seen.lastResult.summary, /inget anrop till sidan[\s\S]*Sidan svarade inte i tid/);
    assert.deepEqual([timeoutNotices.at(-1).kind, timeoutNotices.at(-1).watchEvent], ['watch', 'paused']);
    // 2. A real disconnect: no pulse for longer than two pulses, or a pulse that found no browser, and the same timeout never counts.
    await ask('correct', { action: 'watch-pause', watchId: saved.id, paused: 'false' });
    later(1); await pulse(); later(2); await (await run()).exit('Uppdragets tidsgräns nåddes.', 'run', { timedOut: true });
    seen = await shown();
    assert.deepEqual([seen.failedRuns, seen.lastResult.failure], [undefined, 'disconnected'], 'a timeout after the browser went away is the lost connection\'s');
    later(1); await pulse(false); await (await run()).watchReport({ changed: false, summary: 'x', activity: [], failure: 'run', web: { succeeded: [], timedOut: true } });
    assert.deepEqual([(await shown()).failedRuns, (await shown()).lastResult.failure], [undefined, 'disconnected']);
    // 3. SESSION_BUSY and QUEUE_FULL: the executor marks the run disconnected, and it never counts, connected or not.
    later(1); await pulse(); await (await run()).watchReport({ changed: false, summary: 'Upptagen.', activity: [], web: { succeeded: [], disconnected: true } });
    assert.deepEqual([(await shown()).failedRuns, (await shown()).lastResult.failure], [undefined, 'disconnected']);
    // 4. A report whose run read nothing counts, even when readable is missing and the model claims a change; no hit notice.
    const noticed = timeoutNotices.length;
    later(1); await pulse(); await (await run()).watchReport({ changed: true, summary: 'Priset är nu 48 öre/kWh.', activity: [], value: { amount: 48, unit: 'öre/kWh' }, web: { succeeded: [] } });
    seen = await shown();
    assert.deepEqual([seen.failedRuns, seen.lastResult.status, seen.lastResult.changed, seen.lastResult.summary, seen.lastResult.value], [1, 'failed', false, ASSISTANT_WATCH_UNREAD, undefined]);
    assert.equal(timeoutNotices.length, noticed, 'an unread run is no hit');
    // 5. A normal successful run still clears the count, and its value is kept.
    later(1); await (await run()).watchReport({ changed: false, summary: 'Priset är 48 öre/kWh enligt https://hang.example/.', activity: ['Öppnade https://hang.example/'], value: { amount: 48, unit: 'öre/kWh' }, web: { succeeded: ['web_open'] } });
    seen = await shown();
    assert.deepEqual([seen.failedRuns, seen.lastResult.status, seen.lastResult.value, seen.history.at(-1).value], [undefined, 'ok', { amount: 48, unit: 'öre/kWh' }, { amount: 48, unit: 'öre/kWh' }]);
    const log = (await ask('correct', { action: 'chat-select', conversationId: (await ask('status')).chat.watchConversationId })).chat;
    assert.match(log.messages.at(-1).text, /^Bevakning: Hänger\nStatus: Ingen ändring\nPriset är 48 öre\/kWh[^\n]*\nVärde: 48 öre\/kWh$/, 'the value is shown in Bevakningar');
    assert.equal(seen.history.length, 8, 'every run is in the history');
    await host.close();
  }

  // The broker's real timeline: a pulse every 30 s, also without the browser, and one at once when the
  // extension's connection closes. A call dropped with the connection times out 30–35 s after it was sent,
  // usually before the next timer pulse; a timeout counts only if the browser stayed connected the whole run.
  {
    const lostDir = fresh();
    let now = at('2026-11-05T09:00:00.000Z');
    const runs = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const watch = await new AssistantWatches(lostDir).create({ kind: 'watch', title: 'Laddkabel', target: { url: 'https://shop.example/kabel' }, condition: 'Under 400 kr', cadence: { time: '23:59' } }, undefined, now);
    // A chat executor whose start can be held, to keep the controller queue busy; an Ollama that records every question.
    const busy = { gate: undefined, async start() { if (this.gate) await this.gate; }, async stop() {}, async close() {}, async revokeWeb() {} };
    const asked = [], tick = () => new Promise(resolve => setTimeout(resolve, 20));
    const ollama = new Proxy({}, { get: (_, name) => name === 'then' ? undefined : async () => { asked.push(String(name)); throw new Error('Ollama körs inte i testet.'); } });
    const host = new AssistantController(process.cwd(), lostDir, workflow, { chatExecutor: busy, watchExecutor: runs, clock: () => now, awakeMs: 0, notice: () => {}, ollama }); controllers.push(host);
    const ask = (operation, input = {}) => host.request(operation, input);
    const current = (await ask('status')).assistant;
    await ask('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, agent: { backend: 'local', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, local: { model: 'qwen3.5:4b-q4_K_M' } }, web: { level: 'read', login: false }, timezone: tz }) });
    // While Chrome is closed the broker pulses on, and such a pulse only records the loss: the local model's
    // Ollama is not asked, though a status with the browser would ask it.
    await tick();
    assert.deepEqual(asked, [], 'nothing has asked Ollama yet');
    await ask('status', { scheduler: 'true', browserConnected: 'false' }); await tick();
    assert.deepEqual(asked, [], 'a pulse without the browser asks Ollama nothing');
    await ask('status', { scheduler: 'true', browserConnected: 'true' }); await tick();
    assert.ok(asked.length > 0, 'a pulse with the browser checks the local model as before');
    const seconds = value => { now = new Date(now.getTime() + value * 1000); };
    const pulse = (connected = true) => ask('status', { scheduler: 'true', browserConnected: String(connected) });
    const run = async () => { await ask('correct', { action: 'watch-run', watchId: watch.id }); return runs.starts.at(-1).callbacks; };
    const result = async () => { const shown = (await ask('status')).chat.watches[0]; return [shown.failedRuns, shown.lastResult.failure]; };
    const timedOut = callbacks => callbacks.exit('Uppdragets tidsgräns nåddes.', 'run', { timedOut: true });
    // An extension reload while a page loads: the closed connection's pulse, the new connection's three seconds
    // later, then the dropped call's TIMEOUT 25 s on, before the next timer pulse. The reload is the cause.
    await pulse(); seconds(1); let callbacks = await run();
    seconds(5); await pulse(false); seconds(3); await pulse(); seconds(25); await timedOut(callbacks);
    assert.deepEqual(await result(), [undefined, 'disconnected'], 'a timeout after the connection was lost and came back is the lost connection\'s');
    // Chrome closes during a run: pulses without the browser, then the run reports the page as unreadable after a timeout.
    seconds(60); await pulse(); callbacks = await run();
    seconds(10); await pulse(false); seconds(20); await pulse(false); seconds(5);
    await callbacks.watchReport({ changed: false, summary: 'Sidan svarade inte.', activity: [], failure: 'run', web: { succeeded: [], timedOut: true } });
    assert.deepEqual(await result(), [undefined, 'disconnected'], 'a pulse without the browser during the run');
    // No pulse for longer than the window during the run (a sleeping computer or a restarted broker): the next pulse vouches only from then on.
    seconds(60); await pulse(); callbacks = await run();
    seconds(90); await pulse(); seconds(5); await timedOut(callbacks);
    assert.deepEqual(await result(), [undefined, 'disconnected'], 'a gap in the pulses during the run');
    // A run started before the browser came back: the pulse that found it again is after the start.
    seconds(60); await pulse(false); callbacks = await run();
    seconds(10); await pulse(); seconds(25); await timedOut(callbacks);
    assert.deepEqual(await result(), [undefined, 'disconnected'], 'a run that started while the browser was away');
    // A busy controller queue: the closed connection's pulse waits behind other work, and the dropped call's
    // timeout comes in before that pulse is handled. The run is judged in the queue, after the pulse.
    seconds(60); await pulse(); callbacks = await run();
    let release; busy.gate = new Promise(resolve => { release = resolve; });
    const holding = ask('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Hej' });
    await tick();
    seconds(5); const lost = pulse(false);
    seconds(25); const reported = timedOut(callbacks);
    busy.gate = undefined; release();
    await Promise.all([holding, lost, reported]);
    assert.deepEqual(await result(), [undefined, 'disconnected'], 'a loss queued before the report is the lost connection\'s, even behind a busy queue');
    // Pulses every 30 s through the whole run: a page that hangs is the run's own failure and counts.
    seconds(60); await pulse(); callbacks = await run();
    seconds(30); await pulse(); seconds(5); await timedOut(callbacks);
    assert.deepEqual(await result(), [1, 'run'], 'connected from start to report: the timeout counts');
    // A run that starts at the pulse that found the browser again (as a scheduled start does) is vouched for from its start.
    seconds(60); await pulse(false); seconds(30); await pulse(); callbacks = await run();
    seconds(30); await pulse(); seconds(5); await timedOut(callbacks);
    assert.deepEqual(await result(), [2, 'run'], 'connected from the start that the pulse allowed');
    await host.close();
  }
  console.log('assistant-watches: daily and hourly schedules with DST, one run per missed stretch, no replay after restart, own model and executor, cards with model and cost, Bevakningar results, notices, pause while web is off, chat_config watches and pause/edit/delete cards that the host checks, automatic pause after three counted failures (never for Tabai\'s own trouble) with notice and reset, the capacity warning, a ten-result history with values and trend, older files, and timeouts and unread runs that count only while the browser is connected passed');
} finally {
  for (const controller of controllers) await controller.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
