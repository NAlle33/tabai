// Routines: their schedule (weekdays, a missed run at most once and only the same
// local day, daylight saving), the store and its counted failures, the schedule they
// share with watches, chat routines that read at most and never act, task routines
// started like the morning check, cards and chat_config, notices, the panel's actions
// and the routine worker mode.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AssistantRoutines, assistantRoutineDue, assistantRoutineNextRun, assistantRoutineRecord, assistantRoutineScheduleText, assistantRoutineSetEnabled, assistantRoutineWebLevel, assistantScheduleCapacityWarning, validateAssistantRoutine, ASSISTANT_SCHEDULE_CAPACITY_WARNING } from '../dist/assistant-routines.mjs';
import { AssistantWatches, ASSISTANT_WATCH_CAPACITY_WARNING } from '../dist/assistant-watches.mjs';
import { AssistantController } from '../dist/assistant-controller.mjs';
import { AssistantExecutor, assistantClaudeArgs, assistantCodexArgs, assistantRoutinePrompt } from '../dist/assistant-agent.mjs';
import { assistantWorkerToolNames } from '../dist/assistant-tools.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(async () => { for (const controller of controllers) await controller.close().catch(() => {}); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tz = 'Europe/Stockholm', dirs = [], controllers = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tabai-routines-')); dirs.push(dir); return dir; };
const at = value => new Date(value);
const routine = (schedule, extra = {}) => ({ id: randomUUID(), kind: 'chat', title: 'Veckan', prompt: 'Sammanfatta veckans nyheter om elpriset.', schedule, enabled: true, createdAt: '2026-11-02T08:00:00.000Z', ...extra });
const account = { id: 'mail-1', provider: 'gmail', label: 'Test', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true };
try {
  // The schedule: 2026-11-06 is a Friday; 16:00 in Stockholm is 15:00Z in winter.
  {
    const friday = routine({ time: '16:00', days: [5] });
    assert.equal(assistantRoutineNextRun(friday, at('2026-11-02T09:00:00Z'), tz), '2026-11-06T15:00:00.000Z', 'the next Friday');
    assert.equal(assistantRoutineDue(friday, at('2026-11-05T15:00:00Z'), tz), false, 'not on a Thursday');
    assert.equal(assistantRoutineDue(friday, at('2026-11-06T14:59:00Z'), tz), false);
    assert.equal(assistantRoutineDue(friday, at('2026-11-06T15:00:00Z'), tz), true);
    assert.equal(assistantRoutineDue(friday, at('2026-11-06T20:30:00Z'), tz), true, 'a missed run is made later the same day');
    const ran = { ...friday, lastRunAt: '2026-11-06T20:30:00.000Z' };
    assert.equal(assistantRoutineDue(ran, at('2026-11-06T21:00:00Z'), tz), false, 'at most once');
    assert.equal(assistantRoutineNextRun(ran, at('2026-11-06T21:00:00Z'), tz), '2026-11-13T15:00:00.000Z');
    assert.equal(assistantRoutineDue(friday, at('2026-11-07T08:00:00Z'), tz), false, 'a Friday the computer slept through is never caught up on Saturday');
    assert.equal(assistantRoutineNextRun(friday, at('2026-11-07T08:00:00Z'), tz), '2026-11-13T15:00:00.000Z');
    const late = routine({ time: '23:30', days: [5] });
    assert.equal(assistantRoutineDue(late, at('2026-11-06T22:45:00Z'), tz), true);
    assert.equal(assistantRoutineDue(late, at('2026-11-06T23:10:00Z'), tz), false, 'the same day is the local day: it is already 00:10 on Saturday in Stockholm, 40 minutes late');
    // 23:58 with the checks at 23:56 and 00:01: the run may still start up to 30 minutes after its time, past midnight, once.
    const nearMidnight = routine({ time: '23:58', days: [5] });
    assert.equal(assistantRoutineDue(nearMidnight, at('2026-11-06T22:56:00Z'), tz), false, '23:56 on Friday is before its time');
    assert.equal(assistantRoutineDue(nearMidnight, at('2026-11-06T23:01:00Z'), tz), true, '00:01 on Saturday still runs Friday\'s 23:58');
    assert.equal(assistantRoutineNextRun(nearMidnight, at('2026-11-06T23:01:00Z'), tz), '2026-11-06T23:01:00.000Z');
    assert.equal(assistantRoutineDue(nearMidnight, at('2026-11-06T23:28:00Z'), tz), true, 'until 00:28');
    assert.equal(assistantRoutineDue(nearMidnight, at('2026-11-06T23:29:00Z'), tz), false, 'not 31 minutes late');
    const ranAfterMidnight = { ...nearMidnight, lastRunAt: '2026-11-06T23:01:00.000Z' };
    assert.equal(assistantRoutineDue(ranAfterMidnight, at('2026-11-06T23:06:00Z'), tz), false, 'at most once');
    assert.equal(assistantRoutineNextRun(ranAfterMidnight, at('2026-11-06T23:06:00Z'), tz), '2026-11-13T22:58:00.000Z');
    assert.equal(assistantRoutineDue({ ...nearMidnight, lastRunAt: '2026-11-06T22:58:30.000Z' }, at('2026-11-06T23:01:00Z'), tz), false, 'a run on time is not repeated after midnight');
    const everyDay = routine({ time: '23:58' });
    assert.equal(assistantRoutineDue({ ...everyDay, lastRunAt: '2026-11-06T23:01:00.000Z' }, at('2026-11-07T22:58:00Z'), tz), true, 'a daily routine run after midnight still runs at its own time that evening');
    const daily = routine({ time: '08:00' }, { createdAt: '2026-11-03T09:00:00.000Z' });
    assert.equal(assistantRoutineDue(daily, at('2026-11-03T09:30:00Z'), tz), false, 'a routine created after today\'s time waits for tomorrow');
    assert.equal(assistantRoutineNextRun(daily, at('2026-11-03T09:30:00Z'), tz), '2026-11-04T07:00:00.000Z');
    assert.equal(assistantRoutineNextRun(routine({ time: '07:30', days: [1, 2, 3, 4, 5] }, { createdAt: '2026-11-06T12:00:00.000Z' }), at('2026-11-06T12:00:00Z'), tz), '2026-11-09T06:30:00.000Z', 'weekdays skip the weekend');
    assert.equal(assistantRoutineDue({ ...friday, enabled: false }, at('2026-11-06T15:00:00Z'), tz), false); assert.equal(assistantRoutineNextRun({ ...friday, enabled: false }, at('2026-11-06T15:00:00Z'), tz), undefined);
    // Daylight saving: 2026-03-29 and 2026-10-25 are Sundays.
    const spring = routine({ time: '02:30', days: [7] }, { createdAt: '2026-03-28T12:00:00.000Z' });
    assert.equal(assistantRoutineNextRun(spring, at('2026-03-28T12:00:00Z'), tz), '2026-03-29T01:30:00.000Z', '02:30 does not exist; 03:30 CEST follows the gap');
    assert.equal(assistantRoutineDue(spring, at('2026-03-29T01:30:00Z'), tz), true);
    assert.equal(assistantRoutineNextRun(routine({ time: '08:00' }, { createdAt: '2026-03-28T12:00:00.000Z' }), at('2026-03-28T12:00:00Z'), tz), '2026-03-29T06:00:00.000Z', '08:00 in summer time');
    const autumn = routine({ time: '02:30', days: [7] }, { createdAt: '2026-10-24T12:00:00.000Z' });
    assert.equal(assistantRoutineNextRun(autumn, at('2026-10-24T12:00:00Z'), tz), '2026-10-25T00:30:00.000Z', 'a repeated 02:30 runs at its first occurrence');
    assert.equal(assistantRoutineDue(autumn, at('2026-10-25T00:30:00Z'), tz), true);
    assert.equal(assistantRoutineDue({ ...autumn, lastRunAt: '2026-10-25T00:31:00.000Z' }, at('2026-10-25T01:31:00Z'), tz), false, 'and not again an hour later');
    // In the user's words.
    assert.equal(assistantRoutineScheduleText({ time: '16:00', days: [5] }), 'varje fredag kl. 16:00');
    assert.equal(assistantRoutineScheduleText({ time: '08:00' }), 'varje dag kl. 08:00');
    assert.equal(assistantRoutineScheduleText({ time: '08:00', days: [] }), 'varje dag kl. 08:00', 'no days is every day');
    assert.equal(assistantRoutineScheduleText({ time: '07:30', days: [5, 1, 2, 3, 4, 1] }), 'vardagar kl. 07:30');
    assert.equal(assistantRoutineScheduleText({ time: '10:00', days: [7, 6] }), 'helger kl. 10:00');
    assert.equal(assistantRoutineScheduleText({ time: '09:00', days: [1, 3, 5] }), 'måndag, onsdag och fredag kl. 09:00');
    assert.equal(assistantRoutineScheduleText({ time: '09:00', days: [1, 2, 3, 4, 5, 6, 7] }), 'varje dag kl. 09:00');
    // The capacity warning counts watches and routines together, in words for both.
    assert.equal(assistantScheduleCapacityWarning(Array(12).fill(24), []), undefined);
    assert.equal(assistantScheduleCapacityWarning(Array(12).fill(24), [1 / 7]), ASSISTANT_SCHEDULE_CAPACITY_WARNING, 'a weekly routine beyond twelve hourly watches');
    assert.equal(assistantScheduleCapacityWarning([...Array(12).fill(24), 1], []), ASSISTANT_WATCH_CAPACITY_WARNING, 'without routines, the watches\' own words');
    assert.match(ASSISTANT_SCHEDULE_CAPACITY_WARNING, /bevakningar och rutiner[\s\S]*högst en bevakning eller rutin var femte minut/);
  }

  // The store: validation, twenty at most, counted failures with a watch's rules, and an interrupted run.
  {
    const shortcuts = [{ id: 'veckan', label: 'Veckans mejl', instructions: 'Sammanfatta veckans mejl.' }];
    assert.deepEqual(validateAssistantRoutine({ kind: 'task', title: 'Fredag', task: 'shortcut', shortcutId: 'veckan', schedule: { time: '16:00', days: [5, 5] } }, shortcuts).schedule, { time: '16:00', days: [5] });
    assert.deepEqual(validateAssistantRoutine({ kind: 'chat', title: 'Dag', prompt: 'Väder?', schedule: { time: '07:00', days: [7, 1, 2, 3, 4, 5, 6] } }, []).schedule, { time: '07:00' }, 'every day is stored as no list');
    assert.throws(() => validateAssistantRoutine({ kind: 'task', title: 'Saknas', task: 'shortcut', shortcutId: 'borta', schedule: { time: '16:00' } }, shortcuts), /sparad snabbknapp/);
    assert.throws(() => validateAssistantRoutine({ kind: 'task', title: 'Fel', task: 'check-mail', shortcutId: 'veckan', schedule: { time: '16:00' } }, shortcuts), /Bara en rutin för en snabbknapp/);
    assert.throws(() => validateAssistantRoutine({ kind: 'chat', title: 'Tid', prompt: 'x', schedule: { time: '25:00' } }, []));
    const dir = fresh(), store = new AssistantRoutines(dir), now = at('2026-11-02T09:00:00Z');
    const first = await store.create({ kind: 'chat', title: 'Nyheter', prompt: 'Vad hände i veckan?', schedule: { time: '16:00', days: [5] } }, [], randomUUID(), now);
    for (let index = 1; index < 20; index++) await store.create({ kind: 'chat', title: `Rutin ${index}`, prompt: 'x', schedule: { time: '08:00' } }, [], undefined, now);
    await assert.rejects(store.create({ kind: 'chat', title: 'För många', prompt: 'x', schedule: { time: '08:00' } }, [], undefined, now), /högst 20/);
    assert.equal(new AssistantRoutines(dir).list.length, 20, 'the routines are saved');
    const counted = new AssistantRoutines(dir).find(first.id), result = (status, failure) => ({ at: '2026-11-06T15:01:00.000Z', status, summary: 'x', ...(failure ? { failure } : {}) });
    assert.equal(assistantRoutineRecord(counted, result('failed', 'run')), false); assert.equal(counted.failedRuns, 1);
    for (const failure of ['interrupted', 'disconnected', 'unavailable', 'stopped']) assert.equal(assistantRoutineRecord(counted, result('failed', failure)), false);
    assert.equal(counted.failedRuns, 1, 'Tabai\'s own trouble neither adds nor clears');
    assert.equal(assistantRoutineRecord(counted, result('ok')), false); assert.equal(counted.failedRuns, undefined, 'a successful run clears the count');
    assistantRoutineRecord(counted, result('failed', 'run')); assistantRoutineRecord(counted, result('failed', 'run'));
    assert.equal(assistantRoutineRecord(counted, result('failed', 'run')), true, 'the third in a row pauses');
    assert.deepEqual([counted.enabled, counted.pausedAfterFailures], [false, true]);
    assistantRoutineSetEnabled(counted, true); assert.deepEqual([counted.enabled, counted.pausedAfterFailures, counted.failedRuns], [true, undefined, undefined]);
    assert.equal(assistantRoutineRecord(counted, { ...result('ok'), summary: 's'.repeat(400) }), false); assert.equal(counted.lastResult.summary.length, 300);
    await store.update(first.id, entry => { entry.lastRunAt = '2026-11-06T15:00:00.000Z'; });
    await new AssistantRoutines(dir).recover(at('2026-11-06T15:05:00Z'));
    const recovered = new AssistantRoutines(dir).find(first.id);
    assert.deepEqual([recovered.lastResult.status, recovered.lastResult.failure], ['failed', 'interrupted']); assert.match(recovered.lastResult.summary, /avbröts[\s\S]*körs inte om/);
    assert.equal(assistantRoutineDue(recovered, at('2026-11-06T15:10:00Z'), tz), false, 'an interrupted run is never repeated');
    writeFileSync(join(dir, 'routines.json'), '{ inte json', { mode: 0o600 });
    assert.match(new AssistantRoutines(dir).unavailable, /Rutinerna kunde inte läsas säkert/);
  }

  // A routine can never get the web level act: not from the setting, the prompt, the tool list, the CLIs or a call.
  {
    assert.equal(assistantRoutineWebLevel({ level: 'act', login: true }), 'read');
    assert.equal(assistantRoutineWebLevel({ level: 'read', login: false }), 'read');
    assert.equal(assistantRoutineWebLevel({ level: 'off', login: false }), 'off'); assert.equal(assistantRoutineWebLevel(undefined), 'off');
    const forbidden = ['web_click', 'web_fill', 'web_handover', 'chat_profile', 'chat_start_task', 'chat_module_reply'];
    for (const level of ['off', 'read', 'act']) for (const name of forbidden) assert.equal(assistantWorkerToolNames('routine', level).includes(name), false, `${name} at ${level}`);
    assert.deepEqual(assistantWorkerToolNames('routine', 'act'), assistantWorkerToolNames('routine', 'read'), 'act lists exactly what read lists');
    const prompt = assistantRoutinePrompt({ level: 'act', login: true });
    assert.match(prompt, /söka och läsa[\s\S]*inte klicka eller fylla i[\s\S]*Det här är en rutin[\s\S]*ingenting genomförs av sig självt/);
    assert.doesNotMatch(prompt, /web_click|approvalRequired|chat_profile|Inloggning är tillåten/, 'the prompt never offers the act level');
    assert.match(assistantRoutinePrompt({ level: 'off', login: false }), /Webbåtkomst är avstängd/);
    const claude = assistantClaudeArgs('/private/config.json', undefined, 'routine', 'act'), allowed = claude[claude.indexOf('--allowedTools') + 1];
    assert.match(allowed, /mcp__tabai_assistant__web_read/); for (const name of forbidden) assert.equal(allowed.includes(`__${name}`), false, `Claude never gets ${name}`);
    const codex = assistantCodexArgs(process.cwd(), '/private/work', undefined, 'routine', 'act'), enabled = codex.find(arg => arg.startsWith('mcp_servers.tabai_assistant.enabled_tools='));
    for (const name of forbidden) assert.equal(enabled.includes(`"${name}"`), false, `Codex never gets ${name}`);
    // The worker the local and Berget runners start lists exactly the routine's tools.
    const client = new Client({ name: 'routine-tools', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist', 'assistant-worker.mjs')], env: { TABAI_ASSISTANT_SOCKET: join(fresh(), 'unused'), TABAI_ASSISTANT_SECRET: 'unused', TABAI_ASSISTANT_CHAT: 'routine', TABAI_ASSISTANT_WEB: 'act' }, stderr: 'ignore' }));
    try { assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), assistantWorkerToolNames('routine', 'read'), 'the worker lists the routine tools, read-only even when told act'); }
    finally { await client.close(); }
    // The host refuses every acting tool in a routine's turn, even if its run were marked act, and opens the web read-only.
    const dir = fresh(), executor = new AssistantExecutor(dir, dir), accesses = [];
    const execution = webLevel => ({ context: { run: { id: randomUUID(), task: 'custom' }, settings: { accounts: [], timezone: tz }, items: [], chat: { messages: [{ role: 'user', text: 'Sammanfatta veckan.' }], conversationId: randomUUID(), web: { level: 'act', login: true }, routine: { title: 'Veckan' } } },
      callbacks: { chatReply: async () => {}, chatTask: async () => { throw new Error('never'); }, chatProfile: async () => ({}) }, chatContextRead: true, webGeneration: 0, webLevel });
    for (const level of ['read', 'act']) for (const name of forbidden) await assert.rejects(executor.dispatch(execution(level), name, name === 'chat_start_task' ? { task: 'check-mail' } : { tabId: 1, ref: 'ref_1', value: 'x' }), /finns inte i en rutin/, `${name} at ${level}`);
    const sessions = [];
    executor.webSession = async (_conversation, access, _windowId, options) => { accesses.push(access); sessions.push(options); return { search: async () => ({ results: [] }) }; };
    await executor.dispatch(execution('read'), 'web_search', { query: 'elpris vecka 45' });
    assert.deepEqual(accesses, [{ level: 'read', login: false }], 'the routine\'s web tab is opened read-only');
    // Nobody is at the computer: incognito without fallback to the signed-in window, but any public page may open.
    assert.deepEqual(sessions, [{ strictIncognito: true, routine: true }], 'a routine reads the web only in incognito, never limited to its own search results');
    const context = await executor.dispatch({ ...execution('read'), chatContextRead: false }, 'workflow_context', {});
    assert.deepEqual([context.chat, context.routine, context.conversation], [true, { title: 'Veckan' }, [{ role: 'user', text: 'Sammanfatta veckan.' }]], 'the routine\'s question is its only user message');
    await executor.close();
  }

  // The controller: cards, chat_config, the shared schedule, chat and task routines, notices and the panel's actions.
  const dir = fresh();
  let clock = at('2026-11-06T13:00:00.000Z');
  const notices = [];
  const chatExecutor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
  const background = { starts: [], stops: 0, fail: undefined, async start(context, callbacks) { if (this.fail) throw new Error(this.fail); this.starts.push({ context, callbacks }); }, async stop() { this.stops++; }, async close() {}, async revokeWeb() {} };
  const workflow = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async open() {} };
  const create = () => { const controller = new AssistantController(process.cwd(), dir, workflow, { chatExecutor, watchExecutor: background, clock: () => clock, awakeMs: 0, notice: notice => notices.push(notice) }); controllers.push(controller); return controller; };
  let controller = create();
  const request = (operation, input = {}) => controller.request(operation, input);
  const settings = async extra => { const current = (await request('status')).assistant; return request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, ...extra }) }); };
  const tick = (connected = true) => request('status', { scheduler: 'true', browserConnected: String(connected) });
  const later = minutes => { clock = new Date(clock.getTime() + minutes * 60_000); };
  const turn = async (text = 'Gör en rutin åt mig') => { await request('correct', { action: 'chat-send', messageId: randomUUID(), message: text }); return chatExecutor.starts.at(-1).callbacks; };
  const card = async id => (await request('status')).chat.messages.find(entry => entry.card?.id === id).card;
  const shown = async title => (await request('status')).chat.routines.find(entry => entry.title === title);
  const rutiner = async () => { const view = await request('status'); return view.chat.routineConversationId; };

  let view = (await request('status')).chat;
  assert.deepEqual(view.routines, []); assert.equal(view.routineNotifications, true, 'routine notices are on by default');
  assert.equal((await request('status')).assistant.settings.routineNotifications, undefined, 'old settings stay without the field');
  // Explicit: a new workspace takes the machine's time zone, and CI runs in UTC. Web access at act: routines still only read.
  await settings({ web: { level: 'act', login: true }, timezone: tz, accounts: [account] });
  // A chat routine and a task routine proposed on cards; nothing is saved before the tap.
  let callbacks = await turn('Varje fredag kl. 16 vill jag ha veckans nyheter om elpriset, och varje fredag kl. 18 en mejlkoll.');
  const chatCard = await callbacks.chatPropose({ kind: 'routine-create', routine: { kind: 'chat', title: 'Veckans elpris', prompt: 'Sammanfatta veckans nyheter om elpriset.', schedule: { time: '16:00', days: [5] } } });
  const taskCard = await callbacks.chatPropose({ kind: 'routine-create', routine: { kind: 'task', title: 'Mejlkoll', task: 'check-mail', schedule: { time: '18:00', days: [5] } } });
  await assert.rejects(callbacks.chatPropose({ kind: 'routine-create', routine: { kind: 'task', title: 'Snabb', task: 'shortcut', shortcutId: 'saknas', schedule: { time: '09:00' } } }), /sparad snabbknapp/, 'a shortcut must exist');
  await callbacks.chatReply('Två kort väntar.');
  let proposed = await card(chatCard.cardId);
  assert.equal(proposed.title, 'Ny rutin: Veckans elpris');
  assert.match(proposed.detail, /^Fråga: Sammanfatta veckans nyheter om elpriset\.\nSchema: varje fredag kl\. 16:00\.\nModell: Codex · [^\n]*\. Varje körning drar användning av ditt Codex-abonnemang\.\nRutinen svarar med chattmodellen i samtalet Rutiner\. Den läser högst på webben och kan inte klicka, fylla i, starta uppdrag eller godkänna något\. Kort som den föreslår väntar på dig\.$/);
  assert.equal(proposed.warning, undefined);
  assert.match((await card(taskCard.cardId)).detail, /^Uppdrag: Kolla mejl\nSchema: varje fredag kl\. 18:00\.[\s\S]*morgonkontrollen[\s\S]*Inget skickas utan ditt godkännande\.$/);
  assert.deepEqual((await request('status')).chat.routines, [], 'a card changes nothing before the user confirms it');
  const origin = (await request('status')).chat.id;
  // The same routine proposed again while its first card waits: both cards wait, only the first approved is saved.
  const again = await turn('Lägg till veckans elpris en gång till, kl. 17.');
  const copyCard = await again.chatPropose({ kind: 'routine-create', routine: { kind: 'chat', title: 'Veckans elpris', prompt: 'Elpriset den här veckan.', schedule: { time: '17:00', days: [5] } } });
  await again.chatReply('Ett kort väntar.');
  await request('correct', { action: 'chat-confirm', cardId: chatCard.cardId });
  await request('correct', { action: 'chat-confirm', cardId: taskCard.cardId });
  view = (await request('status')).chat;
  assert.deepEqual(view.routines.map(entry => [entry.title, entry.kind, entry.enabled, entry.runsPerWeek, entry.nextRunAt]), [['Veckans elpris', 'chat', true, 1, '2026-11-06T15:00:00.000Z'], ['Mejlkoll', 'task', true, 1, '2026-11-06T17:00:00.000Z']]);
  assert.equal(view.routines[0].createdFrom, origin); assert.equal(view.routines[1].label, 'Kolla mejl');
  assert.match(view.messages.at(-1).text, /Rutinen ”Mejlkoll” är sparad och körs varje fredag kl\. 18:00\. Uppdraget visas i Mejl/);
  await assert.rejects(request('correct', { action: 'chat-confirm', cardId: copyCard.cardId }), /^Error: Du har redan rutinen Veckans elpris\.$/);
  assert.deepEqual([(await card(copyCard.cardId)).status, (await card(copyCard.cardId)).error], ['failed', 'Du har redan rutinen Veckans elpris.']);
  assert.equal((await request('status')).chat.routines.length, 2, 'the copy is never saved');
  // chat_config lists them as the settings do, with routineId as their only identity.
  callbacks = await turn('Vilka rutiner har jag?');
  let config = await callbacks.chatConfig();
  assert.deepEqual(config.routines.map(entry => Object.keys(entry).sort()), [['kind', 'nextRun', 'prompt', 'routineId', 'schedule', 'status', 'title'], ['kind', 'nextRun', 'routineId', 'schedule', 'status', 'task', 'title']]);
  assert.deepEqual(config.routines[0], { routineId: view.routines[0].id, title: 'Veckans elpris', kind: 'chat', prompt: 'Sammanfatta veckans nyheter om elpriset.', schedule: 'varje fredag kl. 16:00', status: 'active', nextRun: '2026-11-06 16:00' });
  assert.equal(config.routines[1].task, 'Kolla mejl'); assert.match(config.routinesNote, /kort som användaren godkänner/);
  assert.equal(JSON.stringify(config).includes(origin), false, 'the conversation a routine came from stays with the host');
  await callbacks.chatReply('Två rutiner.');
  const [elpris, mejlkoll] = view.routines;

  // The shared schedule: an hourly watch and the routine are both due; the routine goes first, then nothing for five minutes or while it runs.
  callbacks = await turn('Bevaka elpriset varje timme');
  const watchCard = await callbacks.chatPropose({ kind: 'watch', title: 'Elpris', target: { url: 'https://elpriset.example/' }, condition: 'Under 1 kr/kWh', cadence: { hours: 1 } });
  await callbacks.chatReply('Ett kort väntar.');
  await request('correct', { action: 'chat-confirm', cardId: watchCard.cardId });
  const selected = (await request('status')).chat.id;
  clock = at('2026-11-06T15:00:00.000Z');
  await tick();
  assert.equal(background.starts.length, 1, 'one start per check');
  let started = background.starts[0];
  assert.equal(started.context.chat.routine.title, 'Veckans elpris', 'a due routine goes before a due watch');
  assert.deepEqual(started.context.chat.messages, [{ role: 'user', text: 'Sammanfatta veckans nyheter om elpriset.' }], 'the routine\'s question is its only user message');
  assert.deepEqual(started.context.chat.web, { level: 'read', login: false }, 'web access at act: the routine reads at most');
  assert.equal(started.context.settings.agent.backend, 'codex', 'the chat model'); assert.deepEqual(started.context.settings.accounts, []); assert.equal(started.context.watch, undefined);
  view = (await request('status')).chat;
  assert.equal(view.id, selected, 'a routine never selects its conversation');
  assert.equal(view.routines.find(entry => entry.id === elpris.id).running, true);
  await assert.rejects(request('correct', { action: 'watch-run', watchId: view.watches[0].id }), /En rutin körs just nu/, 'never two runs at once');
  await assert.rejects(request('correct', { action: 'routine-run', routineId: elpris.id }), /En rutin körs redan/);
  later(5); await tick();
  assert.equal(background.starts.length, 1, 'no watch starts while the routine runs');
  // The turn's card waits in Rutiner; it cannot start a task; its answer is an assistant message headed with the routine.
  const memory = await started.callbacks.chatPropose({ kind: 'memory', label: 'Elområde', value: 'SE3', scope: 'general' });
  await assert.rejects(started.callbacks.chatTask('check-mail'), /En rutin kan inte starta uppdrag/);
  await started.callbacks.webActivity(['Sökte med DuckDuckGo: elpris vecka 45']);
  const before = notices.length;
  await started.callbacks.chatReply('Elpriset sjönk under veckan enligt https://elpriset.example/.');
  let log = (await request('correct', { action: 'chat-select', conversationId: await rutiner() })).chat;
  assert.equal(log.title, 'Rutiner');
  const reply = log.messages.find(entry => entry.role === 'assistant');
  assert.deepEqual([reply.text, reply.status, reply.model], ['Rutin: Veckans elpris\nElpriset sjönk under veckan enligt https://elpriset.example/.', 'complete', 'codex:gpt-6.1-terra']);
  assert.deepEqual(log.messages.find(entry => entry.webActivity)?.webActivity, ['Sökte med DuckDuckGo: elpris vecka 45']);
  const waiting = log.messages.find(entry => entry.card?.id === memory.cardId).card;
  assert.equal(waiting.status, 'pending', 'nothing a routine proposes is approved by itself');
  assert.equal(notices.length, before + 1);
  assert.deepEqual(Object.keys(notices.at(-1)).sort(), ['count', 'critical', 'desktop', 'id', 'kind', 'routineTitle'], 'the fixed text and the routine\'s name only');
  assert.deepEqual([notices.at(-1).kind, notices.at(-1).routineTitle, notices.at(-1).desktop], ['routine', 'Veckans elpris', true]);
  assert.equal(JSON.stringify(notices.at(-1)).includes('sjönk'), false, 'never the answer');
  let saved = await shown('Veckans elpris');
  assert.deepEqual([saved.running, saved.lastResult.status, saved.lastResult.summary, saved.nextRunAt], [false, 'ok', 'Svaret finns i samtalet Rutiner.', '2026-11-13T15:00:00.000Z']);
  // The watch waits for the next check; then it runs on the same executor.
  later(1); await tick();
  assert.equal(background.starts.length, 1, 'the next check is five minutes after the last');
  later(4); await tick();
  assert.equal(background.starts.length, 2); started = background.starts[1];
  assert.equal(started.context.watch.title, 'Elpris', 'then the watch');
  clock = at('2026-11-06T17:00:00.000Z'); await tick();
  assert.equal(workflow.starts.length, 0, 'a task routine waits while a watch runs');
  await started.callbacks.watchReport({ changed: false, summary: 'Fortfarande över 1 kr.', activity: [], web: { succeeded: ['web_open'] } });

  // A task routine: started like the morning check, under the tasks' own rules, with a pointer in Rutiner; done when its task is.
  later(5); await tick();
  assert.equal(workflow.starts.length, 1); let task = workflow.starts[0];
  assert.deepEqual([task.context.run.task, task.context.run.label, task.context.run.scheduled], ['check-mail', 'Rutin: Mejlkoll', true]);
  assert.match(task.context.run.instructions, /^Kontrollera samtliga aktiverade mejlkonton\./, 'the morning check\'s own instructions');
  assert.equal(background.starts.length, 2, 'a task routine needs no background executor');
  saved = await shown('Mejlkoll');
  assert.deepEqual([saved.lastResult.status, saved.lastResult.taskId, saved.running], ['ok', task.context.run.id, false]);
  log = (await request('correct', { action: 'chat-select', conversationId: await rutiner() })).chat;
  const pointer = log.messages.find(entry => entry.task?.id === task.context.run.id);
  assert.deepEqual([pointer.role, pointer.task.label], ['system', 'Rutin: Mejlkoll'], 'a short pointer to Mejl, which the panel links there');
  assert.match(pointer.text, /^Pågår: Rutin: Mejlkoll\n/, 'it follows its task like a task started in the chat');
  await assert.rejects(request('correct', { action: 'routine-run', routineId: mejlkoll.id }), /uppdrag eller självtest pågår/);
  const noticed = notices.length;
  await task.callbacks.finish({ summary: 'Inget nytt som behöver svar.', findings: [], coverage: [{ accountId: account.id, status: 'checked', message: 'Inkorgen är läst.' }] });
  assert.deepEqual(notices.slice(noticed).map(entry => entry.kind ?? 'mail').at(-1), 'routine', 'the routine is done when its task is');
  assert.equal(notices.at(-1).routineTitle, 'Mejlkoll');
  log = (await request('status')).chat;
  assert.match(log.messages.find(entry => entry.task?.id === task.context.run.id).text, /^Resultat: Rutin: Mejlkoll\nInget nytt/, 'the pointer follows the task');

  // Counted failures pause a routine after three in a row; Tabai's own trouble never counts.
  await request('correct', { action: 'chat-select', conversationId: selected });
  const runNow = async id => { await request('correct', { action: 'routine-run', routineId: id }); return background.starts.at(-1).callbacks; };
  await request('correct', { action: 'watch-pause', watchId: (await request('status')).chat.watches[0].id });
  later(1); await (await runNow(elpris.id)).exit('Den lokala modellen avslutade utan ett verifierat resultat.', 'run');
  assert.equal((await shown('Veckans elpris')).failedRuns, 1);
  log = (await request('correct', { action: 'chat-select', conversationId: await rutiner() })).chat;
  assert.deepEqual([log.messages.at(-1).text, log.messages.at(-1).status], ['Rutin: Veckans elpris\nDen lokala modellen avslutade utan ett verifierat resultat.', 'failed']);
  await request('correct', { action: 'chat-select', conversationId: selected });
  later(1); await (await runNow(elpris.id)).exit('Ollama svarar inte på den här datorn.', 'unavailable');
  later(1); await (await runNow(elpris.id)).exit('Webbläsaranslutningen svarade inte.', 'disconnected');
  background.fail = 'Agenten kunde inte startas.'; later(1);
  await assert.rejects(request('correct', { action: 'routine-run', routineId: elpris.id }), /kunde inte startas/);
  background.fail = undefined;
  later(1); await tick(); later(2); await (await runNow(elpris.id)).exit('Uppdragets tidsgräns nåddes.', 'run', { timedOut: true });
  saved = await shown('Veckans elpris');
  assert.deepEqual([saved.failedRuns, saved.lastResult.failure], [1, 'disconnected'], 'a timeout after the browser went away does not count');
  // The broker's timeline for an extension reload during the run: the closed connection's pulse at once, the new
  // connection's three seconds later, and the dropped call's timeout before the next timer pulse.
  const seconds = value => { clock = new Date(clock.getTime() + value * 1000); };
  later(1); await tick(); const reloaded = await runNow(elpris.id);
  seconds(5); await tick(false); seconds(3); await tick(); seconds(25);
  await reloaded.exit('Uppdragets tidsgräns nåddes.', 'run', { timedOut: true });
  saved = await shown('Veckans elpris');
  assert.deepEqual([saved.failedRuns, saved.lastResult.failure], [1, 'disconnected'], 'a timeout after a reload during the run does not count');
  later(1); await tick(); await (await runNow(elpris.id)).exit('Uppdragets tidsgräns nåddes.', 'run', { timedOut: true });
  assert.equal((await shown('Veckans elpris')).failedRuns, 2, 'a timeout while the browser is connected counts');
  const pausing = notices.length;
  later(1); await (await runNow(elpris.id)).exit('Den lokala modellen slutade svara.', 'run');
  saved = await shown('Veckans elpris');
  assert.deepEqual([saved.enabled, saved.pausedAfterFailures, saved.nextRunAt], [false, true, undefined]);
  assert.deepEqual([notices.length, notices.at(-1).kind, notices.at(-1).routineEvent, notices.at(-1).routineTitle], [pausing + 1, 'routine', 'paused', 'Veckans elpris']);
  log = (await request('correct', { action: 'chat-select', conversationId: await rutiner() })).chat;
  assert.deepEqual([log.messages.at(-1).role, log.messages.at(-1).text], ['system', 'Rutinen ”Veckans elpris” pausades efter 3 misslyckade körningar i rad. Slå på den igen under Inställningar → Rutiner.']);
  await request('correct', { action: 'chat-select', conversationId: selected });
  callbacks = await turn('Hur går rutinen?');
  assert.equal((await callbacks.chatConfig()).routines.find(entry => entry.routineId === elpris.id).status, 'paused-after-failures');
  // The chat resumes it on a card, which starts the count over; a card for a removed routine is closed with the reason.
  const resume = await callbacks.chatPropose({ kind: 'routine-pause', routineId: elpris.id, paused: false });
  const remove = await callbacks.chatPropose({ kind: 'routine-delete', routineId: mejlkoll.id });
  await assert.rejects(callbacks.chatPropose({ kind: 'routine-delete', routineId: randomUUID() }), /Rutinen finns inte längre/);
  await callbacks.chatReply('Två kort väntar.');
  assert.deepEqual([(await card(resume.cardId)).title, (await card(resume.cardId)).detail], ['Återuppta rutinen: Veckans elpris', 'Rutinen ”Veckans elpris” körs igen: varje fredag kl. 16:00.']);
  assert.deepEqual([(await card(remove.cardId)).title, (await card(remove.cardId)).detail], ['Ta bort rutinen: Mejlkoll', 'Rutinen ”Mejlkoll” tas bort och körs inte mer. Tidigare svar finns kvar i samtalet Rutiner.']);
  await request('correct', { action: 'chat-confirm', cardId: resume.cardId });
  saved = await shown('Veckans elpris');
  assert.deepEqual([saved.enabled, saved.pausedAfterFailures, saved.failedRuns], [true, undefined, undefined]);
  await request('correct', { action: 'routine-delete', routineId: mejlkoll.id });
  await assert.rejects(request('correct', { action: 'chat-confirm', cardId: remove.cardId }), /finns inte längre/);
  assert.deepEqual([(await card(remove.cardId)).status, (await card(remove.cardId)).error], ['failed', 'Rutinen finns inte längre, så kortet kan inte genomföras.']);
  // The user changes the web setting during a chat routine and web stays on: the run ends as stopped, which never counts.
  {
    later(1); const changing = await runNow(elpris.id);
    const stopsBefore = background.stops;
    await settings({ web: { level: 'read', login: false } });
    saved = await shown('Veckans elpris');
    assert.deepEqual([saved.running, saved.lastResult.status, saved.lastResult.failure, saved.failedRuns], [false, 'failed', 'stopped', undefined], 'an act-to-read change ends the routine as stopped');
    assert.equal(background.stops, stopsBefore + 1);
    await changing.exit('Webbläsaråtkomsten har avslutats.', 'run');
    saved = await shown('Veckans elpris');
    assert.deepEqual([saved.lastResult.failure, saved.failedRuns], ['stopped', undefined], 'the run cut off by the change cannot report a counted failure afterwards');
    await settings({ web: { level: 'act', login: true } });
  }

  // The settings page: a new routine, its time, its notices, pause and delete; a running routine stops when deleted.
  await request('correct', { action: 'save-shortcut', id: 'veckan', label: 'Veckans mejl', instructions: 'Sammanfatta veckans mejl.' });
  await assert.rejects(request('correct', { action: 'routine-create', routine: '{ inte json' }), /fel format/);
  await assert.rejects(request('correct', { action: 'routine-create', routine: JSON.stringify({ kind: 'task', title: 'Saknas', task: 'shortcut', shortcutId: 'borta', schedule: { time: '09:00' } }) }), /sparad snabbknapp/);
  await request('correct', { action: 'routine-create', routine: JSON.stringify({ kind: 'task', title: 'Veckans mejl', task: 'shortcut', shortcutId: 'veckan', schedule: { time: '16:30', days: [5, 1] } }) });
  saved = await shown('Veckans mejl');
  assert.deepEqual([saved.kind, saved.task, saved.shortcutId, saved.label, saved.schedule, saved.createdFrom], ['task', 'shortcut', 'veckan', 'Veckans mejl', { time: '16:30', days: [1, 5] }, undefined]);
  await request('correct', { action: 'routine-schedule', routineId: saved.id, schedule: JSON.stringify({ time: '07:15', days: [] }) });
  assert.deepEqual((await shown('Veckans mejl')).schedule, { time: '07:15' }, 'no chosen day is every day');
  await assert.rejects(request('correct', { action: 'routine-schedule', routineId: saved.id, schedule: JSON.stringify({ time: '7:15' }) }), /TT:MM/);
  await request('correct', { action: 'routine-run', routineId: saved.id });
  task = workflow.starts.at(-1);
  assert.deepEqual([task.context.run.task, task.context.run.instructions, task.context.run.scheduled], ['custom', 'Sammanfatta veckans mejl.', undefined], 'Kör nu starts the shortcut as the user would');
  await request('stop');
  await request('correct', { action: 'save-shortcut', id: 'veckan', label: 'Veckans mejl', instructions: 'Sammanfatta veckans mejl.' });
  await request('correct', { action: 'delete-shortcut', id: 'veckan' });
  assert.equal((await shown('Veckans mejl')).label, 'Snabbknappen finns inte längre');
  await assert.rejects(request('correct', { action: 'routine-run', routineId: saved.id }), /Snabbknappen som rutinen startar finns inte längre/);
  assert.deepEqual([(await shown('Veckans mejl')).lastResult.failure, (await shown('Veckans mejl')).failedRuns], ['run', 1], 'a routine whose shortcut is gone fails on its own');
  await request('correct', { action: 'routine-pause', routineId: saved.id, paused: 'true' });
  assert.equal((await shown('Veckans mejl')).enabled, false);
  await request('correct', { action: 'routine-notify', enabled: 'false' });
  assert.equal((await request('status')).chat.routineNotifications, false);
  const current = (await request('status')).assistant;
  const { routineNotifications: _saved, ...stale } = current.settings;
  await request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify(stale) });
  assert.equal((await request('status')).chat.routineNotifications, false, 'a panel from before routines keeps their notice setting');
  later(1); let running = await runNow(elpris.id);
  await running.chatReply('Klart.');
  assert.equal(notices.at(-1).desktop, false, 'the routine setting turns the desktop notice off');
  await request('correct', { action: 'routine-notify', enabled: 'true' });
  later(1); running = await runNow(elpris.id);
  const stops = background.stops;
  await request('correct', { action: 'routine-delete', routineId: elpris.id });
  assert.equal(background.stops, stops + 1, 'deleting a running routine stops it');
  await running.chatReply('För sent.');
  log = (await request('correct', { action: 'chat-select', conversationId: await rutiner() })).chat;
  assert.deepEqual([log.messages.at(-1).text, log.messages.at(-1).status], ['Rutin: Veckans elpris\nRutinen togs bort under körningen.', 'interrupted'], 'the stopped run cannot answer afterwards');
  assert.equal((await request('status')).chat.routines.some(entry => entry.id === elpris.id), false);
  await assert.rejects(request('correct', { action: 'routine-run', routineId: elpris.id }), /finns inte längre/);

  // Without web access a chat routine still runs, with no web at all; a restart reports a running routine and never reruns it.
  await settings({ web: { level: 'off', login: false } });
  await request('correct', { action: 'routine-create', routine: JSON.stringify({ kind: 'chat', title: 'Dagens fråga', prompt: 'Ge mig ett ord för dagen.', schedule: { time: '20:00' } }) });
  clock = at('2026-11-06T19:00:00.000Z'); await tick();
  started = background.starts.at(-1);
  assert.deepEqual([started.context.chat.routine.title, started.context.chat.web], ['Dagens fråga', { level: 'off', login: false }]);
  await controller.close();
  clock = at('2026-11-06T19:10:00.000Z');
  controller = create(); await tick();
  saved = await shown('Dagens fråga');
  assert.deepEqual([saved.lastResult.failure, saved.running], ['interrupted', false]); assert.match(saved.lastResult.summary, /avbröts när Tabai stängdes/);
  assert.equal(background.starts.at(-1), started, 'nothing reruns after a restart');
  assert.equal(saved.nextRunAt, '2026-11-07T19:00:00.000Z');
  await controller.close();

  // A routine that is due waits for a computer that has stayed awake, like the morning check.
  {
    const awakeDir = fresh(), store = new AssistantRoutines(awakeDir);
    let now = at('2026-11-03T06:00:00.000Z');
    await store.create({ kind: 'chat', title: 'Morgonnyheter', prompt: 'Vad hände i natt?', schedule: { time: '08:00' } }, [], undefined, now);
    const runs = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const host = new AssistantController(process.cwd(), awakeDir, workflow, { chatExecutor, watchExecutor: runs, clock: () => now }); controllers.push(host);
    const status = (await host.request('status', {})).assistant;
    await host.request('correct', { action: 'settings', revision: String(status.revision), settings: JSON.stringify({ ...status.settings, web: { level: 'read', login: false }, timezone: tz }) });
    const pulse = async value => { now = at(value); await host.request('status', { scheduler: 'true', browserConnected: 'true' }); return runs.starts.length; };
    assert.equal(await pulse('2026-11-03T07:05:53.000Z'), 0, 'a due routine is not started in a maintenance wake');
    assert.equal(await pulse('2026-11-03T07:06:23.000Z'), 0);
    for (const value of ['2026-11-03T08:30:00.000Z', '2026-11-03T08:30:30.000Z', '2026-11-03T08:31:00.000Z', '2026-11-03T08:31:30.000Z', '2026-11-03T08:32:00.000Z', '2026-11-03T08:32:30.000Z']) assert.equal(await pulse(value), 0, 'nor before the computer has stayed awake');
    assert.equal(await pulse('2026-11-03T08:33:00.000Z'), 1, 'it starts once the computer has stayed awake');
    await host.close();
  }

  // The wait must not cost a routine its slot: awake from 23:58 local, the 20:00 routine is no longer due at 00:01.
  {
    const slotDir = fresh(), store = new AssistantRoutines(slotDir);
    let now = at('2026-11-03T06:00:00.000Z');
    const routine = await store.create({ kind: 'chat', title: 'Kvällsnyheter', prompt: 'Vad hände i kväll?', schedule: { time: '20:00' } }, [], undefined, now);
    const runs = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const host = new AssistantController(process.cwd(), slotDir, workflow, { chatExecutor, watchExecutor: runs, clock: () => now }); controllers.push(host);
    const status = (await host.request('status', {})).assistant;
    await host.request('correct', { action: 'settings', revision: String(status.revision), settings: JSON.stringify({ ...status.settings, web: { level: 'read', login: false }, timezone: tz }) });
    assert.equal(assistantRoutineDue(routine, at('2026-11-03T23:01:00.000Z'), tz), false, 'the slot has closed by the time the wait is over');
    const started = Date.parse('2026-11-03T22:58:00.000Z');
    for (const seconds of [0, 30, 60, 90, 120, 150]) { now = new Date(started + seconds * 1000); await host.request('status', { scheduler: 'true', browserConnected: 'true' }); assert.equal(runs.starts.length, 0); }
    now = new Date(started + 180_000); await host.request('status', { scheduler: 'true', browserConnected: 'true' });
    assert.equal(runs.starts.length, 1, 'it was due when the computer woke, so it still runs');
    await host.close();
    // The look back is bounded: a computer awake for a day does not revive yesterday's slot, and a closing slot goes before one still open.
    const lookback = new AssistantController(process.cwd(), slotDir, workflow, { chatExecutor, watchExecutor: runs, clock: () => now }); controllers.push(lookback);
    lookback.awakeSince = Date.parse('2026-11-04T19:30:00.000Z');
    assert.equal(assistantRoutineDue(lookback.routines.list[0], new Date(lookback.awakeSince), tz), true, 'the slot was open when this computer woke');
    assert.deepEqual(lookback.dueRoutines(at('2026-11-05T11:00:00.000Z'), tz), [], 'but that is too long ago to count');
    await lookback.routines.create({ kind: 'chat', title: 'Vid midnatt', prompt: 'Vad händer i natt?', schedule: { time: '00:00' } }, [], undefined, at('2026-11-04T06:00:00.000Z'));
    lookback.awakeSince = Date.parse('2026-11-04T22:58:00.000Z');
    assert.deepEqual(lookback.dueRoutines(at('2026-11-04T23:01:00.000Z'), tz).map(entry => entry.title), ['Kvällsnyheter', 'Vid midnatt'], 'the slot that would be lost is taken first');
    await lookback.close();
  }

  // The capacity warning on a routine's card counts the watches and routines that are on.
  {
    const capacityDir = fresh(), store = new AssistantWatches(capacityDir), now = at('2026-11-05T09:00:00.000Z');
    for (let index = 0; index < 12; index++) await store.create({ kind: 'watch', title: `Vara ${index}`, target: { query: `pris ${index}` }, condition: 'Lägre pris', cadence: { hours: 1 } }, undefined, now);
    const host = new AssistantController(process.cwd(), capacityDir, workflow, { chatExecutor, watchExecutor: background, clock: () => now, awakeMs: 0 }); controllers.push(host);
    const status = (await host.request('status', {})).assistant;
    await host.request('correct', { action: 'settings', revision: String(status.revision), settings: JSON.stringify({ ...status.settings, web: { level: 'read', login: false }, timezone: tz }) });
    await host.request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'En rutin till' });
    const turnCallbacks = chatExecutor.starts.at(-1).callbacks;
    const proposal = await turnCallbacks.chatPropose({ kind: 'routine-create', routine: { kind: 'chat', title: 'Mer', prompt: 'x', schedule: { time: '08:00', days: [1] } } });
    await turnCallbacks.chatReply('Ett kort väntar.');
    assert.equal((await host.request('status', {})).chat.messages.find(entry => entry.card?.id === proposal.cardId).card.warning, ASSISTANT_SCHEDULE_CAPACITY_WARNING);
    await host.close();
  }
  console.log('assistant-routines: weekday schedules with DST and a missed run at most once the same local day or up to 30 minutes past midnight, the store and its counted failures, never the act web level (setting, prompt, tools, CLIs, calls and the worker), cards and chat_config, the schedule shared with watches, chat routines in Rutiner whose cards wait, task routines started like the morning check, notices, the settings page\'s actions and restart recovery passed');
} finally {
  for (const controller of controllers) await controller.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
