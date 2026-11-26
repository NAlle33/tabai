import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { assistantCompareWatchIntent } from '../dist/assistant-chat.mjs';
import { assistantWebEnabled } from '../dist/assistant-web.mjs';
import { ASSISTANT_WATCH_CAPACITY_WARNING, assistantWatchOverCapacity, assistantWatchRunsPerDay } from '../dist/assistant-watches.mjs';

// Synthetic provider boundary for real extension panel/transport checks.
// No API key, model request, customer data or mailbox is used by this fixture.
function state(workspace) {
  if (!workspace.fixtureChat?.records) {
    const id = randomUUID();
    workspace.fixtureChat = { selected: id, model: 'codex:gpt-6.1-terra', taskModel: 'codex:gpt-6.1-terra', berget: { configured: false, message: 'Ingen Berget-nyckel är sparad.' }, records: [{ id, title: 'Nytt samtal', messages: [], busy: false, updatedAt: new Date().toISOString() }], query: '', memories: [], connections: [{ id: 'codex', label: 'Codex', configured: true, state: 'unknown', message: 'Syntetisk anslutning: inte testad.' }], budget: { period: '2026-11', currency: 'EUR', settledEur: 0.003, reservedEur: 0.002, uncertainEur: 0.001, inputTokens: 123, outputTokens: 45, prices: [], entries: [], message: 'Syntetisk förbrukning för UI-test.' }, watches: [], watchModel: 'local:qwen3.5:4b-q4_K_M' };
  }
  return workspace.fixtureChat;
}
function fixtureSavedList(chat, kind) {
  const rows = (kind === 'watches' ? chat.watches : chat.routines ?? []).map(entry => ({ id: entry.id, title: entry.title, enabled: entry.enabled, detail: 'Syntetiskt sparat schema och villkor.' }));
  return { kind, rows, readAt: '2026-11-03T12:00:00.000Z', revision: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}
export function chatFixture(workspace) {
  const chat = state(workspace), current = chat.records.find(record => record.id === chat.selected);
  const webOff = !assistantWebEnabled(workspace.settings.web);
  const watches = chat.watches.map(watch => ({ ...watch, running: false, runsPerDay: 'hours' in watch.cadence ? 24 / watch.cadence.hours : 1, ...(webOff ? { paused: 'Webbåtkomsten är avstängd' } : {}) }));
  // Routines as the host projects them: days sorted, a next run while enabled, and the task's label.
  const routines = (chat.routines ?? []).map(({ nextRunAt, ...routine }) => ({ ...routine, running: false, runsPerWeek: routine.schedule.days?.length || 7,
    ...(routine.enabled ? { nextRunAt } : {}), ...(routine.kind === 'task' ? { label: ROUTINE_TASKS[routine.task] } : {}) }));
  const routineFields = { routines, routineNotifications: chat.routineNotifications !== false, ...(chat.records.some(record => record.id === chat.routineConversationId) ? { routineConversationId: chat.routineConversationId } : {}) };
  // The fixture is a current host: it clears a named conversation, so it says so.
  return { clearById: true, ...routineFields, watches, watchModel: chat.watchModel, ...(chat.watchesError ? { watchesError: chat.watchesError } : {}), ...(chat.records.some(record => record.id === chat.watchConversationId) ? { watchConversationId: chat.watchConversationId } : {}), ...(chat.profile ? { profile: chat.profile } : {}), fileDrafts: (current.files ?? []).map(({bytes, ...file}) => file), id: current.id, title: current.title, messages: current.messages.map(message => message.lists ? { ...message, lists: message.lists.map(list => fixtureSavedList(chat, list.kind)) } : message), ...(chat.search ? { search: chat.search } : {}), ...(chat.focusMessageId ? { focusMessageId: chat.focusMessageId, focusRequestId: chat.focusRequestId } : {}), busy: chat.records.some(record => record.busy), ...(chat.records.find(record => record.busy) ? { activeConversationId: chat.records.find(record => record.busy).id } : {}), model: chat.model, taskModel: chat.taskModel, berget: chat.berget, ...(current.context ? { context: current.context } : {}), ...(current.moduleTarget ? { moduleTarget: current.moduleTarget } : {}), conversations: chat.records.filter(record => !chat.query || record.title.toLocaleLowerCase('sv-SE').includes(chat.query.toLocaleLowerCase('sv-SE'))).map(({ id, title, updatedAt, messages, busy, context }) => ({ id, title, updatedAt, count: messages.length, busy, ...(context ? { context } : {}) })), query: chat.query, memories: chat.memories, connections: chat.connections, budget: chat.budget, ...(chat.budgetError ? { budgetError: chat.budgetError } : {}), ...(current.activity ? { activity: current.activity } : {}) };
}
/** A synthetic checkout area for a web card's image, drawn here; no shop is ever captured for the fixture. */
function fixtureCardImage() {
  const canvas = createCanvas(560, 300), context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, 560, 300);
  context.fillStyle = '#1b1b1f'; context.font = 'bold 26px sans-serif'; context.fillText('Laddkabel Typ 2', 24, 48);
  context.font = '18px sans-serif'; context.fillText('Namn', 24, 92);
  context.strokeStyle = '#8a8f98'; context.lineWidth = 2; context.strokeRect(24, 104, 512, 44);
  context.fillText('Kim Testsson', 36, 133);
  context.fillText('Att betala 499 kr', 24, 192);
  context.fillStyle = '#0b5cad'; context.fillRect(24, 216, 160, 52);
  context.fillStyle = '#ffffff'; context.font = 'bold 20px sans-serif'; context.fillText('Köp nu', 70, 249);
  return canvas.toBuffer('image/png');
}
/** The fixture's answer to the panel's own read of a card image: one piece, as the host sends it. */
export function chatFixturePreview(workspace, input) {
  const chat = state(workspace), base64 = chat.images?.[input.chatPreview];
  assert.ok(base64, 'only an image on a fixture card is read');
  const offset = Number(input.previewOffset ?? 0); chat.previewReads = (chat.previewReads ?? 0) + 1;
  return { fileId: input.chatPreview, mimeType: 'image/png', offset, total: base64.length, base64: base64.slice(offset, offset + 192 * 1024) };
}
const ROUTINE_TASKS = { 'check-mail': 'Kolla mejl', 'my-day': 'Min dag', 'prepare-meeting': 'Förbered möte', 'follow-ups': 'Följ upp' };
const RUNNING_ANSWER = 'Svara långsamt på det här syntetiska meddelandet 6620.';
/** Like the host: days sorted without repeats, and every day stored as no list. */
const routineSchedule = schedule => { assert.match(schedule.time, /^(?:[01]\d|2[0-3]):[0-5]\d$/); const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b); assert(days.every(day => day >= 1 && day <= 7)); return { time: schedule.time, ...(days.length && days.length < 7 ? { days } : {}) }; };
const fixtureRoutine = definition => {
  assert(['chat', 'task'].includes(definition.kind)); assert(definition.title.trim()); if (definition.kind === 'chat') assert(definition.prompt.trim()); else assert(ROUTINE_TASKS[definition.task]);
  return { id: randomUUID(), ...definition, schedule: routineSchedule(definition.schedule), enabled: true, createdAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + 86_400_000).toISOString() };
};
export function chatFixtureCommand(workspace, operation, input) {
  if (operation !== 'correct' || !['chat-', 'berget-', 'memory-', 'task-model', 'connection-test', 'watch-', 'profile-', 'routine-', 'assistant-search'].some(prefix => input.action?.startsWith(prefix))) return false;
  const chat = state(workspace), current = chat.records.find(record => record.id === chat.selected);
  if (input.action === 'assistant-search') {
    const query = input.query.trim(), text = query.toLocaleLowerCase('sv-SE');
    const results = chat.records.flatMap(record => record.messages.map(message => ({ kind: 'chat', id: message.id, conversationId: record.id, messageId: message.id, title: record.title, date: message.createdAt, snippet: message.text.slice(0, 340) })).filter(result => `${result.title} ${result.snippet}`.toLocaleLowerCase('sv-SE').includes(text)));
    chat.search = { query, results: query ? results.slice(0, 100) : [], warnings: [], scanned: chat.records.length };
  } else if (input.action === 'assistant-search-open') {
    const result = chat.search.results.find(result => result.id === input.id && result.kind === input.kind); assert.ok(result);
    chat.selected = result.conversationId; chat.focusMessageId = result.messageId; chat.focusRequestId = randomUUID();
  } else if (input.action === 'chat-fixture-features') {
    chat.featureBackup = { watches: chat.watches, routines: chat.routines };
    chat.watches = [1,2].map(index => ({ id: randomUUID(), title: `Sparad syntetisk bevakning ${index}`, target: { url: 'https://example.test/' }, condition: 'Förändring', cadence: { hours: 12 }, enabled: true, createdAt: new Date().toISOString() }));
    chat.routines = [fixtureRoutine({ kind: 'chat', title: 'Sparad syntetisk rutin', prompt: 'Sammanfatta sidan.', schedule: { time: '08:00' } })];
    current.messages.push({ id: randomUUID(), role: 'assistant', text: 'Här är alla sparade poster.', createdAt: new Date().toISOString(), status: 'complete', model: chat.model, lists: ['watches', 'routines'].map(kind => fixtureSavedList(chat, kind)), continuation: { userId: current.messages.findLast(message => message.role === 'user').id, effect: 'none' } });
  } else if (input.action === 'chat-fixture-features-clear') {
    chat.watches = chat.featureBackup.watches; chat.routines = chat.featureBackup.routines; delete chat.featureBackup;
    current.messages = current.messages.filter(message => !message.lists && !message.continuation?.from);
  } else if (input.action === 'chat-continue') {
    const source = current.messages.find(message => message.id === input.replyId); assert.equal(source.continuation.effect, 'none');
    current.messages.push({ id: input.messageId, role: 'assistant', text: 'Fortsatt syntetiskt svar med vald modell.', createdAt: new Date().toISOString(), status: 'complete', model: input.model, continuation: { userId: source.continuation.userId, from: source.id, effect: 'none' } });
  } else if (input.action === 'chat-model' || input.action === 'task-model') {
    const role = input.action === 'chat-model' ? 'chat' : 'task'; chat[role === 'chat' ? 'model' : 'taskModel'] = input.model;
    const split = input.model.indexOf(':'), backend = input.model.slice(0, split), model = input.model.slice(split + 1), settingsKey = role === 'chat' ? 'chatAgent' : 'agent';
    const config = workspace.settings[settingsKey] && 'backend' in workspace.settings[settingsKey] ? workspace.settings[settingsKey] : { backend: 'codex', codex: { model: 'gpt-6.1-terra', reasoningEffort: 'medium' }, local: { model: 'qwen3.5:4b-q4_K_M' } };
    workspace.settings[settingsKey] = { ...config, backend, [backend]: { ...(config[backend] ?? {}), model } };
  } else if (input.action.startsWith('chat-file-')) {
    const record = chat.records.find(record => record.id === input.conversationId); assert.ok(record); record.files ??= [];
    if (input.action === 'chat-file-start' && chat.refuseNextFile) { delete chat.refuseNextFile; throw new Error('Syntetiskt avvisad bilaga.'); }
    // Like the host, the fixture keeps the panel's mark on a shared page; the chip is drawn from it.
    if (input.action === 'chat-file-start') record.files.push({ id: input.fileId, name: input.name, kind: 'text', size: Number(input.size), received: 0, status: 'uploading', bytes: '', ...(input.source === 'page' ? { source: 'page', pageUrl: input.pageUrl, ...(input.pageTruncated === 'true' ? { pageTruncated: true } : {}), ...(input.pageSelection === 'true' ? { pageSelection: true } : {}) } : {}) });
    else if (input.action === 'chat-file-remove') record.files = record.files.filter(file => file.id !== input.fileId);
    else {
      const file = record.files.find(file => file.id === input.fileId); assert.ok(file);
      if (input.action === 'chat-file-chunk') { assert.equal(Number(input.offset), file.received); const bytes = Buffer.from(input.fileChunk, 'base64'); assert.ok(bytes.length <= 48 * 1024); file.bytes += bytes.toString('utf8'); file.received += bytes.length; }
      // Like the host's reader, at most 500 000 characters of a file are read; the view's schema allows no more.
      else if (input.action === 'chat-file-finish') { assert.equal(file.received, file.size); file.status = 'ready'; file.textChars = Math.min(file.bytes.length, 500_000); file.preview = file.bytes.slice(0,600); }
    }
  } else if (input.action === 'chat-send') {
    assert.equal(input.conversationId, current.id); const date = new Date().toISOString();
    const files = input.fileIds ? JSON.parse(input.fileIds).map(id => { const { bytes, ...file } = current.files.find(file => file.id === id); assert.equal(file.status, 'ready'); return file; }) : []; current.files = (current.files ?? []).filter(file => !files.some(sent => sent.id === file.id));
    // This message gets an answer that is still being written, as while the model works; chat-stop ends it.
    const running = input.message === RUNNING_ANSWER;
    current.messages.push({ ...(files.length ? { files } : {}), id: input.messageId, role: 'user', text: input.message, createdAt: date, status: 'complete' },
      running ? { id: randomUUID(), role: 'assistant', text: '', createdAt: date, status: 'pending', model: chat.model } : { id: randomUUID(), role: 'assistant', text: `Fixtursvar: ${input.message}`, createdAt: date, status: 'complete', model: chat.model });
    if (running) current.busy = true;
    current.updatedAt = date;
  } else if (input.action === 'chat-new' || input.action === 'chat-context') {
    if (input.action === 'chat-context') { const source = (input.kind === 'item' ? workspace.items : workspace.cases).find(record => record.id === input.id); assert.ok(source); assert.equal(source.revision, Number(input.revision)); }
    const id = randomUUID(), context = input.action === 'chat-context' ? { kind: input.kind, id: input.id, revision: Number(input.revision), label: 'Syntetiskt valt underlag' } : undefined;
    chat.records.push({ id, title: context ? 'Samtal om valt underlag' : 'Nytt samtal', messages: [], busy: false, updatedAt: new Date().toISOString(), ...(context ? { context } : {}) }); chat.selected = id;
  } else if (input.action === 'chat-select') { assert.ok(chat.records.some(record => record.id === input.conversationId)); chat.selected = input.conversationId; }
  else if (input.action === 'chat-rename') chat.records.find(record => record.id === input.conversationId).title = input.title;
  else if (input.action === 'chat-delete') { chat.records = chat.records.filter(record => record.id !== input.conversationId); if (!chat.records.length) chatFixtureCommand(workspace, 'correct', { action: 'chat-new' }); else if (chat.selected === input.conversationId) chat.selected = chat.records[0].id; }
  else if (input.action === 'chat-search') chat.query = input.query;
  else if (input.action === 'chat-clear') { const target = input.conversationId ? chat.records.find(record => record.id === input.conversationId) : current; assert.ok(target); target.messages = []; }
  else if (input.action === 'chat-fixture-watch-card') current.messages.push({ id: randomUUID(), role: 'system', text: '', createdAt: new Date().toISOString(), status: 'complete', card: { id: randomUUID(), title: 'Bevaka: Syntetisk produktsida', detail: 'Sida: https://example.test/produkt\nVillkor: Priset sjunker under 400 kr\nSchema: varje dag kl. 08:00, 1 körning per dygn.\nModell: Lokal · Qwen3.5 4B. Körs på den här datorn utan kostnad.', status: 'pending', intent: { kind: 'watch', title: 'Syntetisk produktsida', target: { url: 'https://example.test/produkt' }, condition: 'Priset sjunker under 400 kr', cadence: { time: '08:00' } }, ...(input.warning ? { warning: input.warning } : {}) } });
  // The host paused the first watch after three counted failed runs.
  else if (input.action === 'chat-fixture-watch-failures') Object.assign(chat.watches[0], { enabled: false, failedRuns: 3, pausedAfterFailures: true, lastResult: { changed: false, summary: 'Syntetiskt: sidan kunde inte läsas.', at: new Date().toISOString(), status: 'failed', failure: 'run' } });
  // Twelve more enabled hourly watches than the schedule can start; a second call removes them.
  else if (input.action === 'chat-fixture-watch-capacity') {
    if (chat.watches.some(watch => watch.title.startsWith('Syntetisk timbevakning'))) chat.watches = chat.watches.filter(watch => !watch.title.startsWith('Syntetisk timbevakning'));
    else for (let index = 0; index < 12; index++) chat.watches.push({ id: randomUUID(), title: `Syntetisk timbevakning ${index + 1}`, target: { query: `syntetisk vara ${index + 1}` }, condition: 'Lägre pris', cadence: { hours: 1 }, enabled: true, createdAt: new Date().toISOString() });
  }
  // The host could not read watches.json; a second call makes it readable again.
  else if (input.action === 'chat-fixture-watches-error') chat.watchesError = chat.watchesError ? undefined : 'Bevakningarna kunde inte läsas säkert. Filen har bevarats.';
  // The end of a draft's text in its preview, so a live check can read where a long shared page was cut.
  else if (input.action === 'chat-fixture-file-tail') { const file = (current.files ?? []).find(entry => entry.id === input.fileId); assert.ok(file); file.preview = file.bytes.slice(-600); }
  // The next upload is refused at its start, as a host refuses a file it cannot take.
  else if (input.action === 'chat-fixture-file-refused') chat.refuseNextFile = true;
  // A saved watch whose latest run found what it looks for, as the host projects it.
  else if (input.action === 'chat-fixture-watch-hit') {
    const at = new Date().toISOString();
    chat.watches.push({ id: randomUUID(), title: 'Syntetisk lagerstatus', target: { url: 'https://example.test/lager' }, condition: 'Varan finns i lager', cadence: { hours: 6 }, enabled: true, createdAt: at, lastRunAt: at, lastResult: { changed: true, summary: 'Syntetiskt: varan finns i lager igen.', at, status: 'ok' }, nextRunAt: new Date(Date.parse(at) + 6 * 3_600_000).toISOString() });
  }
  // Two host-created web cards: one with the image the host took, one whose image could not be taken.
  else if (input.action === 'chat-fixture-web-card') {
    const fileId = randomUUID(), at = new Date().toISOString();
    chat.images = { ...(chat.images ?? {}), [fileId]: fixtureCardImage().toString('base64') };
    const approval = extra => ({ kind: 'web-action', approvalId: randomUUID(), tabId: 41, url: 'https://shop.example/kassa', site: 'shop.example', page: 'Laddkabel – kassa', action: 'Köp nu', amount: '499 kr',
      fields: [{ label: 'Namn', value: 'Kim Testsson' }], state: 'a'.repeat(64), ref: 'ref_7', documentId: 'doc-1', ...extra });
    const detail = action => `Webbplats: shop.example\nSida: Laddkabel – kassa\nKnapp: ”${action}”\nBelopp på sidan: 499 kr\nIfyllt av agenten:\n• Namn: Kim Testsson\nTabai klickar en gång när du godkänner, och bara om sidan, knappen och beloppet är oförändrade.`;
    current.messages.push({ id: randomUUID(), role: 'system', text: '', createdAt: at, status: 'complete', card: { id: randomUUID(), title: 'Godkänn: Köp nu', detail: detail('Köp nu'), status: 'pending', intent: approval({ previewFileId: fileId }) } },
      { id: randomUUID(), role: 'system', text: '', createdAt: at, status: 'complete', card: { id: randomUUID(), title: 'Godkänn: Skicka beställning', detail: detail('Skicka beställning'), status: 'pending', intent: approval({ action: 'Skicka beställning' }) } });
  }
  // A comparison as the host records it: the rows cheapest first and when they were read.
  else if (input.action === 'chat-fixture-compare') current.messages.push({ id: randomUUID(), role: 'system', text: '', createdAt: new Date().toISOString(), status: 'complete', compare: { query: input.query, rows: JSON.parse(input.rows), readAt: input.readAt } });
  // Bevaka priset: the panel names only the comparison and its row; the card is the host's own new-watch card for it.
  else if (input.action === 'chat-compare-watch') {
    assert.deepEqual(Object.keys(input).filter(key => key !== 'windowId').sort(), ['action', 'conversationId', 'messageId', 'row']); assert.equal(input.conversationId, current.id);
    const row = current.messages.find(message => message.id === input.messageId)?.compare?.rows[Number(input.row)]; assert.ok(row);
    const intent = assistantCompareWatchIntent(row);
    if (!current.messages.some(message => message.card?.status === 'pending' && JSON.stringify(message.card.intent) === JSON.stringify(intent))) {
      const warning = assistantWatchOverCapacity([...chat.watches.filter(watch => watch.enabled).map(watch => assistantWatchRunsPerDay(watch.cadence)), assistantWatchRunsPerDay(intent.cadence)]) ? ASSISTANT_WATCH_CAPACITY_WARNING : undefined;
      current.messages.push({ id: randomUUID(), role: 'system', text: '', createdAt: new Date().toISOString(), status: 'complete', card: { id: randomUUID(), title: `Bevaka: ${intent.title}`,
        detail: `Sida: ${row.url}\nVillkor: ${intent.condition}\nSchema: var 6:e timme, 4 körningar per dygn.\nModell: Lokal · Qwen3.5 4B. Körs på den här datorn utan kostnad.`, status: 'pending', intent, ...(warning ? { warning } : {}) } });
    }
  }
  else if (input.action === 'chat-fixture-receipt') current.messages.push({ id: randomUUID(), role: 'system', text: 'Godkänt och utfört: syntetiskt köp. Kvittot är sparat som PDF i samtalet: Kvitto example.test 2026-11-02.pdf.', createdAt: new Date().toISOString(), status: 'complete', files: [{ id: randomUUID(), name: 'Kvitto example.test 2026-11-02.pdf', kind: 'pdf', size: 2048, received: 2048, status: 'ready', pages: 1, textChars: 120, preview: 'Syntetisk orderbekräftelse · 499 kr' }] });
  else if (input.action === 'chat-fixture-web-activity') current.messages.push({ id: randomUUID(), role: 'system', text: '', createdAt: new Date().toISOString(), status: 'complete', webActivity: ['Sökte med DuckDuckGo: syntetisk produkt', 'Läste https://example.test/produkt'] }, { id: randomUUID(), role: 'system', text: 'Webbaktivitet:\n• Sparad äldre rad', createdAt: new Date().toISOString(), status: 'complete' });
  else if (input.action === 'chat-sender-lookup') {
    assert(assistantWebEnabled(workspace.settings.web), 'the panel never asks for a lookup while web access is off');
    const item = workspace.items.find(entry => entry.id === input.itemId); assert.ok(item); assert.equal(Number(input.revision), item.revision);
    const domain = (item.recipient || item.sender).split('@')[1]; assert.notEqual(domain, 'gmail.com', 'private mail services are never looked up');
    const id = randomUUID(), context = { kind: 'item', id: item.id, revision: item.revision, label: item.title };
    chat.records.push({ id, title: `Kolla upp ${domain}`, context, busy: false, updatedAt: new Date().toISOString(), messages: [{ id: randomUUID(), role: 'user', text: `Kolla upp organisationen bakom ${domain}: vad den gör och om den verkar seriös. Sök bara på domänen eller organisationens namn.`, createdAt: new Date().toISOString(), status: 'complete' }] });
    chat.selected = id; (workspace.lookups ||= []).push(item.id);
  }
  // The first watch's history, with values or with summaries only; clear removes it again.
  else if (input.action === 'chat-fixture-watch-history') {
    const watch = chat.watches[0]; assert.ok(watch);
    if (input.clear === 'true') delete watch.history;
    else {
      const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
      watch.history = input.values === 'false'
        ? ['Syntetiskt: första läsningen.', 'Syntetiskt: inget nytt.', 'Syntetiskt: sidan kunde inte läsas.', 'Syntetiskt: priset har sjunkit.'].map((summary, index) => ({ changed: index === 3, summary, at: at(40 - index * 10), status: index === 2 ? 'failed' : 'ok', ...(index === 2 ? { failure: 'run' } : {}) }))
        : [164, 120, 48].map((amount, index) => ({ changed: index === 2, summary: `Syntetiskt: ${amount} öre/kWh.`, at: at(30 - index * 10), status: 'ok', value: { amount, unit: 'öre/kWh' } }));
      watch.lastResult = { ...watch.history.at(-1) };
    }
  }
  else if (input.action === 'chat-fixture-routine-card') current.messages.push({ id: randomUUID(), role: 'system', text: '', createdAt: new Date().toISOString(), status: 'complete', card: { id: randomUUID(), title: 'Ny rutin: Syntetisk veckosammanfattning', detail: 'Fråga: Sammanfatta veckans syntetiska nyheter.\nSchema: varje fredag kl. 16:00.\nModell: Codex · GPT-6.1 Terra. Varje körning drar användning av ditt Codex-abonnemang.\nRutinen svarar med chattmodellen i samtalet Rutiner. Den läser högst på webben och kan inte klicka, fylla i, starta uppdrag eller godkänna något. Kort som den föreslår väntar på dig.', status: 'pending', intent: { kind: 'routine-create', routine: { kind: 'chat', title: 'Syntetisk veckosammanfattning', prompt: 'Sammanfatta veckans syntetiska nyheter.', schedule: { time: '16:00', days: [5] } } } } });
  else if (input.action === 'routine-notify') { assert(['true', 'false'].includes(input.enabled)); chat.routineNotifications = input.enabled === 'true'; }
  else if (input.action === 'routine-create') { (chat.routines ??= []).push(fixtureRoutine(JSON.parse(input.routine))); }
  else if (input.action.startsWith('routine-')) {
    const routine = (chat.routines ?? []).find(entry => entry.id === input.routineId); assert.ok(routine);
    if (input.action === 'routine-pause') { routine.enabled = input.paused === 'false'; delete routine.failedRuns; delete routine.pausedAfterFailures; }
    else if (input.action === 'routine-delete') chat.routines = chat.routines.filter(entry => entry.id !== routine.id);
    else if (input.action === 'routine-schedule') routine.schedule = routineSchedule(JSON.parse(input.schedule));
    else {
      assert.equal(input.action, 'routine-run');
      const at = new Date().toISOString(); routine.lastRunAt = at; routine.lastResult = { at, status: 'ok', summary: routine.kind === 'chat' ? 'Svaret finns i samtalet Rutiner.' : 'Uppdraget har startat. Resultatet visas i Mejl.' };
      let log = chat.records.find(record => record.id === chat.routineConversationId);
      if (!log) { log = { id: randomUUID(), title: 'Rutiner', messages: [], busy: false, updatedAt: at }; chat.records.push(log); chat.routineConversationId = log.id; }
      log.messages.push({ id: randomUUID(), role: 'assistant', text: `Rutin: ${routine.title}\nSyntetiskt svar: veckan var lugn.`, createdAt: at, status: 'complete', model: chat.model });
    }
  }
  else if (input.action === 'watch-model') { assert.match(input.model, /^(codex|claude|local|berget):/); chat.watchModel = input.model; }
  else if (input.action.startsWith('watch-')) {
    const watch = chat.watches.find(entry => entry.id === input.watchId); assert.ok(watch);
    // Like the host, the user's own pause or resume replaces an automatic pause and starts the count over.
    if (input.action === 'watch-pause') { watch.enabled = input.paused === 'false'; delete watch.failedRuns; delete watch.pausedAfterFailures; }
    else if (input.action === 'watch-delete') chat.watches = chat.watches.filter(entry => entry.id !== watch.id);
    else {
      assert.equal(input.action, 'watch-run'); assert(assistantWebEnabled(workspace.settings.web));
      const at = new Date().toISOString(); watch.lastRunAt = at; watch.lastResult = { changed: true, summary: 'Syntetiskt resultat: priset är nu 389 kr.', at, status: 'ok' };
      let log = chat.records.find(record => record.id === chat.watchConversationId);
      if (!log) { log = { id: randomUUID(), title: 'Bevakningar', messages: [], busy: false, updatedAt: at }; chat.records.push(log); chat.watchConversationId = log.id; }
      log.messages.push({ id: randomUUID(), role: 'system', text: `Bevakning: ${watch.title}\nStatus: Ändring\n${watch.lastResult.summary}`, createdAt: at, status: 'complete', webActivity: ['Läste https://example.test/produkt'] });
    }
  }
  else if (input.action === 'profile-save') {
    const extra = JSON.parse(input.extra); assert.ok(Array.isArray(extra) && extra.length <= 6);
    assert.equal(/\d{13,19}/.test(Object.values(input).join(' ').replace(/[ -]/g, '')), false, 'no card numbers in the synthetic profile');
    const fields = Object.fromEntries(['name', 'street', 'postalCode', 'city', 'country', 'phone', 'email'].filter(name => input[name]).map(name => [name, input[name]]));
    chat.profile = { ...fields, extra, updatedAt: new Date().toISOString() };
  }
  else if (input.action === 'profile-clear') delete chat.profile;
  else if (input.action === 'chat-stop') { const active = chat.records.find(record => record.busy) || current; active.busy = false; for (const message of active.messages) if (message.status === 'pending') message.status = 'interrupted'; delete active.activity; }
  else if (input.action === 'chat-fixture-stream') { current.busy = true; current.activity = { message: 'Syntetisk pågående providertext', updatedAt: new Date().toISOString() }; current.messages.push({ id: randomUUID(), role: 'assistant', text: 'Det här svaret växer successivt', createdAt: new Date().toISOString(), status: 'pending', model: chat.model }); }
  else if (input.action === 'chat-fixture-module') current.messages.push({ id: randomUUID(), role: 'system', text: 'Syntetisk modulfråga', createdAt: new Date().toISOString(), status: 'complete', module: { moduleId: 'test-module', runId: 'synthetic-module-run', title: 'Syntetiskt lokalt verktyg', status: 'waiting', message: 'Syntetiskt verktyg väntar på ditt svar.', question: 'Vilken syntetisk uppgift gäller det?', questionId: 'synthetic-module-question', choices: [{ label: 'Syntetiskt val', value: 'Endast testsvar' }], canOpen: true } });
  else if (input.action === 'chat-fixture-case') current.messages.push({ id: randomUUID(), role: 'system', text: 'Syntetiskt ärende', createdAt: new Date().toISOString(), status: 'complete', module: { moduleId: 'case-module', runId: 'synthetic-case-run', title: 'Syntetiskt ärende', status: 'failed', message: 'Stoppad', messaging: 'ready' } }), current.moduleTarget = { moduleId: 'case-module', runId: 'synthetic-case-run' };
  else if (input.action === 'chat-fixture-case-clear') { for (const record of chat.records) { record.messages = record.messages.filter(message => !message.module?.messaging); delete record.moduleTarget; } }
  else if (input.action === 'chat-module-target') { assert.equal(input.conversationId, current.id); if (input.moduleId) current.moduleTarget = { moduleId: input.moduleId, runId: input.runId }; else delete current.moduleTarget; }
  else if (input.action === 'chat-module-message') {
    assert.equal(input.conversationId, current.id); assert.match(input.messageId, /^[0-9a-f-]{36}$/);
    assert.ok(current.messages.some(message => message.module?.moduleId === input.moduleId && message.module?.runId === input.runId && message.module?.messaging === 'ready'));
    current.messages.push({ id: input.messageId, role: 'user', text: input.message, createdAt: new Date().toISOString(), status: 'complete' }, { id: randomUUID(), role: 'assistant', text: `Ärendet svarar: ${input.message}`, createdAt: new Date().toISOString(), status: 'complete' });
  }
  else if (input.action === 'chat-module-reply') { assert.equal(input.conversationId, current.id); const message = current.messages.findLast(message => message.module?.moduleId === input.moduleId && message.module?.runId === input.runId && message.module?.questionId === input.questionId); assert.ok(message); message.module.status = 'review'; message.module.message = `Syntetiskt svar mottaget: ${input.message}`; delete message.module.question; delete message.module.questionId; delete message.module.choices; current.messages.push({ id: input.messageId, role: 'user', text: input.message, createdAt: new Date().toISOString(), status: 'complete' }); }
  else if (input.action === 'chat-fixture-task-done') current.messages.push({ id: randomUUID(), role: 'system', text: 'Resultat: Kolla mina mejl\nSyntetisk kontroll klar.', createdAt: new Date().toISOString(), status: 'complete', task: { id: randomUUID(), label: 'Kolla mina mejl', status: 'review', model: 'codex:gpt-6.1-terra', counts: JSON.parse(input.counts) } });
  else if (input.action === 'chat-fixture-budget-error') { if (input.error) chat.budgetError = input.error; else delete chat.budgetError; }
  else if (input.action === 'chat-fixture-card') current.messages.push({ id: randomUUID(), role: 'system', text: 'Syntetiskt verktygsförslag', createdAt: new Date().toISOString(), status: 'complete', card: { id: randomUUID(), title: 'Spara syntetisk uppgift', detail: 'Uppgiften sparas först efter ditt godkännande.', status: 'pending', intent: { kind: 'memory', label: 'Syntetisk uppgift', value: 'Syntetiskt värde', scope: 'general' } } });
  else if (input.action === 'chat-confirm' || input.action === 'chat-dismiss') {
    const card = current.messages.find(message => message.card?.id === input.cardId).card; assert.deepEqual(Object.keys(input).filter(key => key !== 'windowId').sort(), ['action', 'cardId']); card.status = input.action === 'chat-confirm' ? 'applied' : 'dismissed';
    if (input.action === 'chat-confirm' && card.intent.kind === 'watch') { const { kind, ...watch } = card.intent; chat.watches.push({ id: randomUUID(), ...watch, enabled: true, createdAt: new Date().toISOString(), createdFrom: current.id }); }
    if (input.action === 'chat-confirm' && card.intent.kind === 'routine-create') (chat.routines ??= []).push({ ...fixtureRoutine(card.intent.routine), createdFrom: current.id });
  }
  else if (input.action === 'connection-test') { const row = chat.connections.find(connection => connection.id === input.provider); row.state = 'ready'; row.testedAt = new Date().toISOString(); row.message = 'Syntetiskt anslutningstest godkänt.'; }
  else if (input.action === 'berget-key') { assert.ok(input.key.length >= 16); chat.berget = { configured: true, message: 'Nyckeln är sparad privat; testfixture gör inga API-anrop.' }; }
  else if (input.action === 'berget-key-remove') chat.berget = { configured: false, message: 'Nyckeln är borttagen.' };
  else if (input.action === 'berget-budget') { if (input.limit === '') delete chat.budget.limitEur; else chat.budget.limitEur = Number(input.limit); }
  else if (input.action === 'memory-save') { const memory = { id: input.id || randomUUID(), label: input.label, value: input.value, scope: input.scope, ...(input.moduleId ? { moduleId: input.moduleId } : {}), updatedAt: new Date().toISOString() }; chat.memories = chat.memories.filter(record => record.id !== memory.id).concat(memory); }
  else if (input.action === 'memory-delete') chat.memories = chat.memories.filter(record => record.id !== input.id);
  return true;
}

/**
 * The view in light and dark mode at each width: it never scrolls sideways, also when no
 * screenshots are taken. Screenshots for the panel report are written only with an artifact
 * directory. Settle runs after each resize.
 */
export async function capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, name, open, widths = [375, 768, 1440], settle = async () => {}) {
  const original = await ui('({width:innerWidth,height:innerHeight})'), directory = artifactDir ? join(artifactDir, 'panel-shots') : undefined;
  if (directory) mkdirSync(directory, { recursive: true });
  const mode = value => ui(`(()=>{const select=document.querySelector('${card} [name="appearance-mode"]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for (const scheme of ['light', 'dark']) {
    await mode(scheme); await open();
    for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]].filter(([width]) => widths.includes(width))) {
      await rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, panelSession);
      await ui(`document.querySelector('${card}').scrollIntoView({block:'start'})`);
      await settle();
      await until(() => ui(`new Promise(resolve=>requestAnimationFrame(()=>resolve(document.documentElement.dataset.mode===${JSON.stringify(scheme)}&&document.documentElement.scrollWidth<=innerWidth)))`), `${name} fits ${width}px in ${scheme} mode`);
      if (!directory) continue;
      // Colour transitions after a mode switch or a finished action settle before the capture.
      await ui('new Promise(resolve=>setTimeout(resolve,300))');
      const shot = await rpc('Page.captureScreenshot', { format: 'png' }, panelSession);
      writeFileSync(join(directory, `${name}-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await mode('system');
  await rpc('Emulation.setDeviceMetricsOverride', { ...original, deviceScaleFactor: 1, mobile: false }, panelSession);
}

const fixtureWorkspace = '[data-module-id="assistant-fixture"] .assistant-workspace';
/**
 * Runs a click while window.confirm answers `answer`, and returns every question asked and whether
 * the fixture card then works on an action. The panel asks inside the click, so the stub lives only
 * for the click. The card is read a task later, after the click handler's own awaits: an action the
 * answer did not stop has marked it busy by then. A control that is gone is reported, not thrown.
 */
export function confirmClick(ui, script, answer) {
  return ui(`(async()=>{const original=window.confirm,asked=[];let missing;window.confirm=message=>{asked.push(String(message));return ${answer ? 'true' : 'false'};};try{${script}}catch(error){missing=String(error);}finally{window.confirm=original;}await new Promise(resolve=>setTimeout(resolve,0));return {asked,busy:document.querySelector('${fixtureWorkspace}').getAttribute('aria-busy')==='true',...(missing?{missing}:{})};})()`);
}
/**
 * A destructive control behind window.confirm, answered no and then yes. Answered no it must ask
 * once, start nothing and leave `state()` as it was; answered yes it must ask once more.
 */
export async function declineThenConfirm({ ui, until }, script, state) {
  await until(() => ui(`document.querySelector('${fixtureWorkspace}').getAttribute('aria-busy')==='false'`), 'the card is free before a confirmed action');
  const before = JSON.stringify(await state());
  const declined = await confirmClick(ui, script, false);
  const kept = JSON.stringify(await state()) === before;
  const accepted = await confirmClick(ui, script, true);
  const missing = [declined.missing, accepted.missing].filter(Boolean);
  return { declined: declined.asked, startedOnNo: declined.busy, kept, accepted: accepted.asked, ...(missing.length ? { missing } : {}) };
}

export async function assistantChatPanelChecks({ ui, until, check, rpc, panelSession, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]', scope = `${card} .assistant-view-chat`, settings = `${card} .assistant-view-settings`;
  const command = (input) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'correct', input } })})`);
  const status = () => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'status', input: {} } })})`).then(reply => reply.result.chat);
  const history = input => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'history', input } })})`);
  // The answers the fixture holds for the test, and the upload actions that reached it for one file.
  const holds = async (fileId = '') => JSON.parse((await history({ action: 'fixture-holds', fileId })).result.description);
  const busy = () => ui(`document.querySelector('${card} .assistant-workspace').getAttribute('aria-busy')==='true'`);
  const type = (selector, value) => ui(`(()=>{const input=document.querySelector(${JSON.stringify(`${card} ${selector}`)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const settingsToggle = () => ui(`document.querySelector('${card} [data-view="settings"]').click()`);
  const capture = async (name, selector) => {
    const original = await ui('({width:innerWidth,height:innerHeight})');
    if (artifactDir) mkdirSync(artifactDir, { recursive: true });
    for (const [width, height] of [[375,812], [768,1024], [1440,900]]) {
      await rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, panelSession);
      await ui(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      assert.equal(await ui('document.documentElement.scrollWidth <= innerWidth'), true, `${name} has no horizontal overflow at ${width}`);
      if (artifactDir) { const shot = await rpc('Page.captureScreenshot', {format:'png'}, panelSession); writeFileSync(join(artifactDir, `${name}-${width}.png`), Buffer.from(shot.data, 'base64')); }
      if (artifactDir && width === 375 && name === 'assistant-saved-lists') {
        const image = readFileSync(join(process.cwd(), 'extension', 'assets', 'tabai-mandala.png')).toString('base64');
        const body = (await ui('document.body.outerHTML')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replaceAll('src="assets/tabai-mandala.png"', `src="data:image/png;base64,${image}"`);
        writeFileSync(join(artifactDir, 'assistant-features.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + readFileSync(join(process.cwd(), 'extension', 'sidepanel.css'), 'utf8') + '</style>' + body);
      }

    }
    await rpc('Emulation.setDeviceMetricsOverride', { ...original, deviceScaleFactor:1, mobile:false }, panelSession);
  };

  const select = async (name, model) => {
    await ui(`(()=>{const select=document.querySelector('${settings} [name="${name}"]');select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => ui(`document.querySelector('${settings} [name="${name}"]').value===${JSON.stringify(model)} && !document.querySelector('${settings} [name="${name}"]').disabled`), 'model save completed');
  };
  if (await ui(`document.querySelector('${scope}').hidden`)) await settingsToggle();
  assert.equal(await ui(`document.querySelectorAll('${card} .assistant-nav').length`), 0);
  assert.equal(await ui(`document.querySelectorAll('${card} .assistant-chat-composer').length`), 1);
  const viewport = await ui('({width:innerWidth,height:innerHeight})');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false }, panelSession);
  // The panel opens on the first assistant at the top of the page, and the fixture card on its own top.
  const composerFits = selector => ui(`new Promise(resolve=>requestAnimationFrame(()=>{const composer=document.querySelector(${JSON.stringify(selector)}),rect=composer.getBoundingClientRect(),send=composer.querySelector('button[type="submit"]').getBoundingClientRect();resolve({top:rect.top,bottom:rect.bottom,sendBottom:send.bottom,height:innerHeight,scrolled:scrollY,width:document.documentElement.scrollWidth<=innerWidth});}))`);
  await ui('window.scrollTo(0,0)');
  const first = await composerFits('.assistant-workspace[data-surface="chat"] .assistant-chat-composer');
  await ui(`document.querySelector('${card}').scrollIntoView({block:'start'})`);
  const fixture = await composerFits(`${card} .assistant-chat-composer`);
  check('the composer is visible without scrolling at 375×812', () => {
    assert.equal(first.scrolled, 0); assert.ok(first.top >= 0 && first.bottom <= first.height && first.sendBottom <= first.height, JSON.stringify(first)); assert.equal(first.width, true);
    assert.ok(fixture.top >= 0 && fixture.bottom <= fixture.height, JSON.stringify(fixture));
  });
  await rpc('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, panelSession);
  await settingsToggle(); await select('chat-model', 'codex:gpt-6.1-terra'); await settingsToggle();
  await until(() => ui(`!document.querySelector('${scope}').hidden && !!document.querySelector('${scope} [name="chat-message"]')`), 'chat default surface');
  check('one main conversation and composer replace six primary tabs', () => {});
  await settingsToggle(); await ui(`document.querySelector('${card} [data-settings-page="general"]').click()`);
  const sizeSelector = `${settings} [name="panel-text-size"]`;
  const setSize = value => ui(`(()=>{const input=document.querySelector(${JSON.stringify(sizeSelector)});input.value=${value};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await setSize(12);
  assert.ok(Math.abs(await ui(`parseFloat(getComputedStyle(document.querySelector('${scope} [name="chat-message"]')).fontSize)`) - 12) < .1);
  await settingsToggle();
  await until(() => ui(`!document.querySelector('${scope}').hidden`), 'chat visible at smallest font');
  assert.ok(await ui(`document.querySelector('${scope} .assistant-chat-composer button[type="submit"]').getBoundingClientRect().height`) >= 44);
  await settingsToggle(); await ui(`document.querySelector('${card} [data-settings-page="general"]').click()`);
  await until(() => ui(`!document.querySelector('${settings} .assistant-settings-page[data-page="general"]').hidden`), 'general settings page');
  await setSize(20);
  assert.ok(Math.abs(await ui(`parseFloat(getComputedStyle(document.querySelector('${scope} [name="chat-message"]')).fontSize)`) - 20) < .1);
  assert.equal(await ui(`JSON.parse(localStorage.getItem('tabai-panel-appearance')).textSize`), 20);
  await ui(`document.querySelector('#refresh').click()`);
  assert.equal(await ui(`document.querySelector(${JSON.stringify(sizeSelector)}).value`), '20');
  await capture('chat-text-size-20', sizeSelector);
  await setSize(14); await settingsToggle();
  check('font size changes globally, persists, and preserves 44px control targets', () => {});

  const dropText = 'Syntetiskt filunderlag 4281. '.repeat(2500);
  await ui(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(dropText)}], 'test-underlag.txt', {type:'text/plain'}));document.querySelector('${scope} .assistant-chat-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
  await until(() => ui(`!!document.querySelector('${scope} [data-file-status="ready"]') && !document.querySelector('${scope} .assistant-chat-composer button[type="submit"]').disabled`), 'dropped chunked file ready for file-only send');
  await capture('chat-file-draft', `${scope} .assistant-chat-composer`);
  await ui(`document.querySelector('${scope} .assistant-chat-composer').requestSubmit()`);
  await until(() => ui(`!!document.querySelector('${scope} .assistant-chat-log .assistant-sent-file') && !document.querySelector('${scope} .assistant-file-row')`), 'file attached to sent message');
  assert.ok((await ui(`document.querySelector('${scope} .assistant-sent-file').textContent`)).includes('test-underlag.txt'));
  assert.equal(await ui(`JSON.stringify(localStorage).includes('Syntetiskt filunderlag')`), false);
  await ui(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['Ta bort detta underlag'], 'ta-bort.txt'));const picker=document.querySelector('${scope} input[type="file"]');picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => ui(`!!document.querySelector('${scope} [data-file-status="ready"]')`), 'file picker upload');
  await ui(`document.querySelector('${scope} [data-remove-file]').click()`);
  await until(() => ui(`!document.querySelector('${scope} .assistant-file-row')`), 'remove unsent attachment');
  check('drop and picker upload real chunks, file-only send, private preview and draft removal', () => {});
  await ui(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['unsupported'], 'unsupported.exe'));document.querySelector('${scope} .assistant-chat-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-files [role="alert"]').textContent.includes('unsupported.exe')`), 'unsupported file has visible error');
  await capture('chat-file-error', `${scope} .assistant-chat-composer`);
  {
    // A 3 MB upload while an answer streams, in a conversation of its own: each 48 KiB chunk goes
    // through the host's queue without marking the card busy, redrawing the view or starting a
    // poll. The host answers each chunk with its smallest view and Stopp stays usable. The host holds
    // its answer to the finish until the test releases it, so the card is provably busy while a search
    // is typed twice: nothing is searched then, and the latest text is searched once it is free.
    const stopButton = `${scope} .assistant-stop`, original = (await status()).id;
    await command({ action: 'chat-new' }); await command({ action: 'chat-fixture-stream' });
    const uploading = (await status()).id;
    await ui(`document.querySelector('#refresh').click()`);
    try {
      await until(() => ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]')?.closest('[data-conversation-id]').dataset.conversationId===${JSON.stringify(uploading)} && !document.querySelector('${stopButton}').hidden && !document.querySelector('${stopButton}').disabled`), 'a streaming answer in its own conversation, with Stopp enabled');
      await ui(`(()=>{
        const send = chrome.runtime.sendMessage, root = document.querySelector('${card} .assistant-workspace'), stop = document.querySelector('${stopButton}');
        // A redraw (the panel draws a view whenever it sets data-surface) runs in the same task as the
        // reply it draws, after this recorder has noted that reply: so each redraw is put down to the
        // reply before it, and one a poll started before the upload never counts against a chunk.
        const observer = new MutationObserver(entries => { if (record.lastReply === 'chat-file-chunk') record.chunkRedraws += entries.length; });
        const record = window.__quietUpload = { log: [], chunkRedraws: 0, lastReply: '', restore: () => { chrome.runtime.sendMessage = send; observer.disconnect(); delete document.hidden; } };
        // The interval poll skips a hidden document, so every poll seen here was started by an action.
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        observer.observe(root, { attributes: true, attributeFilter: ['data-surface'] });
        const recorder = (message, ...rest) => {
          const command = message?.command ?? {}, entry = { at: performance.now(), action: command.action, kind: command.input?.action, query: command.input?.query, stopDisabled: stop.disabled, busy: root.getAttribute('aria-busy') };
          record.log.push(entry);
          const reply = send.call(chrome.runtime, message, ...rest);
          Promise.resolve(reply).then(value => { entry.done = performance.now(); entry.size = JSON.stringify(value ?? null).length; entry.workspace = !!value?.result?.assistant; record.lastReply = entry.kind ?? entry.action; },
            () => { entry.done = performance.now(); entry.failed = true; record.lastReply = entry.kind ?? entry.action; });
          return reply;
        };
        chrome.runtime.sendMessage = recorder;
        if (chrome.runtime.sendMessage !== recorder) throw new Error('the panel requests cannot be observed');
      })()`);
      const size = 3 * 1024 * 1024, line = 'Stor syntetisk bilaga 6390. ';
      // Each wait is judged in the checks below, so one message names everything that went wrong.
      let finishing = false, typed = [], held = false;
      await history({ action: 'fixture-hold', hold: 'chat-file-finish' });
      try {
        await ui(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(line)}.repeat(${Math.ceil(size / line.length)}).slice(0,${size})],'langsam-bilaga.txt',{type:'text/plain'}));document.querySelector('${scope} .assistant-chat-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
        finishing = await until(async () => (await holds()).holding.includes('chat-file-finish') && await busy(), 'every chunk sent and the finish held at the host').then(() => true, () => false);
        // Each query waits past the panel's 200 ms pause in typing on a timer of the page's own, which
        // the page runs after the panel's timer: the panel has judged the query against a busy card by then.
        if (finishing) typed = await ui(`(async()=>{const input=document.querySelector('${card} [name="conversation-search"]'),seen=[],busy=()=>document.querySelector('${card} .assistant-workspace').getAttribute('aria-busy')==='true';
          for(const query of ['Fixtur','Fixtursvar']){input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));seen.push(busy());await new Promise(resolve=>setTimeout(resolve,300));seen.push(busy());}
          return seen;})()`);
        held = finishing && (await holds()).holding.includes('chat-file-finish');
      } finally { await history({ action: 'fixture-release', hold: 'chat-file-finish' }); }
      const ready = finishing && await until(() => ui(`!!document.querySelector('${scope} [data-file-status="ready"]')`), 'the upload ready').then(() => true, () => false);
      const searched = ready && await until(() => ui(`document.querySelectorAll('${scope} .assistant-local-search-result').length>=1`), 'the search run after the upload').then(() => true, () => false);
      const upload = { ready, searched, typed, held, ...await ui(`(()=>{
        const { log, chunkRedraws } = window.__quietUpload, chunks = log.filter(entry => entry.kind === 'chat-file-chunk');
        // A poll sent after the first chunk and before the last chunk's answer was started by a chunk.
        const first = chunks[0]?.at ?? 0, last = Math.max(0, ...chunks.map(entry => entry.done ?? 1e12));
        const finish = log.find(entry => entry.kind === 'chat-file-finish');
        return { chunks: chunks.length, failed: chunks.filter(entry => entry.failed).length, largest: Math.max(0, ...chunks.map(entry => entry.size ?? 1e12)), workspace: chunks.filter(entry => entry.workspace).length,
          busy: chunks.filter(entry => entry.busy === 'true').length, stopDisabled: chunks.filter(entry => entry.stopDisabled).length,
          polls: log.filter(entry => entry.action === 'modules' && entry.at > first && entry.at < last).length, redraws: chunkRedraws,
          // Every search sent, and whether it left after the host's answer to the finish freed the card.
          searches: log.filter(entry => entry.kind === 'assistant-search').map(entry => ({ query: entry.query, afterFinish: !!finish?.done && entry.at >= finish.done })) };
      })()`) };
      check('a 3 MB upload sends 64 quiet chunks: no busy card, redraw or poll per chunk, a small host answer to each, and Stopp stays enabled', () => {
        assert.deepEqual({ ready: upload.ready, chunks: upload.chunks, failed: upload.failed, workspace: upload.workspace, busy: upload.busy, stopDisabled: upload.stopDisabled, polls: upload.polls, redraws: upload.redraws },
          { ready: true, chunks: 64, failed: 0, workspace: 0, busy: 0, stopDisabled: 0, polls: 0, redraws: 0 }, JSON.stringify(upload));
        assert.ok(upload.largest < 400, `the largest answer to a chunk was ${upload.largest} characters`);
      });
      check('a search typed twice while the card is provably busy sends nothing then, and the latest text once the card is free', () => {
        assert.deepEqual({ typed: upload.typed, held: upload.held, searched: upload.searched, searches: upload.searches },
          { typed: [true, true, true, true], held: true, searched: true, searches: [{ query: 'Fixtursvar', afterFinish: true }] }, JSON.stringify(upload));
      });
    } finally {
      await ui(`window.__quietUpload?.restore?.();delete window.__quietUpload`);
      await type('[name="conversation-search"]', '');
      await command({ action: 'chat-select', conversationId: original }); await command({ action: 'chat-delete', conversationId: uploading });
      await ui(`document.querySelector('#refresh').click()`);
      await until(() => ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]')?.closest('[data-conversation-id]').dataset.conversationId===${JSON.stringify(original)} && !document.querySelector('${scope} [data-conversation-id="${uploading}"]') && document.querySelector('${scope} .assistant-local-search-results').hidden`), 'back in the first conversation without the upload');
    }
  }
  {
    // Another action holds the card when an upload reaches its finish: the host holds its answers to
    // the file's only chunk and to a search typed meanwhile, so the search is provably in flight when
    // the chunk is acknowledged. The finish waits for the free card and reaches the host once. A cancel
    // while the finish waits, or while the chunk is on its way, removes the file at the host instead,
    // also when the card is busy then; no row is left on "Laddar upp".
    const rows = () => ui(`[...document.querySelectorAll('${scope} .assistant-file-row')].map(row=>({id:row.dataset.fileId,status:row.dataset.fileStatus,text:row.querySelector('p').textContent,full:row.querySelector('progress').value>0&&row.querySelector('progress').value===row.querySelector('progress').max,cancel:!row.querySelector('[data-remove-file]').disabled}))`);
    const requestsFor = async id => (await holds(id)).fileRequests;
    const cancel = id => ui(`(()=>{const control=document.querySelector('${scope} [data-remove-file="${id}"]');if(!control||control.disabled)return false;control.click();return true;})()`);
    // Removes what a scenario left behind through each row's own ✕, once the card lets it.
    const clearRows = async () => {
      for (let round = 0; round < 4 && (await rows()).length; round++) {
        const [row] = await rows();
        await until(async () => !(await busy()) && (await rows()).some(entry => entry.id === row.id && entry.cancel), 'a file row can be removed').catch(() => {});
        await cancel(row.id);
        await until(async () => !(await rows()).some(entry => entry.id === row.id), 'the file row removed').catch(() => {});
      }
    };
    const scenario = async (name, when) => {
      const result = {};
      await history({ action: 'fixture-hold', hold: 'chat-file-chunk' }); await history({ action: 'fixture-hold', hold: 'assistant-search' });
      try {
        await ui(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['Väntande syntetisk bilaga 5150.'],${JSON.stringify(name)},{type:'text/plain'}));document.querySelector('${scope} .assistant-chat-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`);
        result.chunkHeld = await until(async () => (await holds()).holding.includes('chat-file-chunk'), `${name}: its chunk held at the host`).then(() => true, () => false);
        const id = await ui(`document.querySelector('${scope} .assistant-file-row[data-file-status="uploading"]')?.dataset.fileId ?? ''`);
        await type('[name="conversation-search"]', `Fixtursvar ${name}`);
        result.searchHeld = result.chunkHeld && await until(async () => (await holds()).holding.includes('assistant-search') && await busy(), `${name}: a search in flight`).then(() => true, () => false);
        if (when === 'chunk') result.cancelled = await cancel(id);
        await history({ action: 'fixture-release', hold: 'chat-file-chunk' });
        result.acknowledged = result.searchHeld && await until(async () => (await rows()).some(row => row.id === id && (row.full || row.status !== 'uploading')), `${name}: the chunk acknowledged`).then(() => true, () => false);
        if (when === 'finish') result.cancelled = await cancel(id);
        const waiting = (await rows()).find(row => row.id === id);
        result.whileBusy = { busy: await busy(), status: waiting?.status ?? 'gone', requests: await requestsFor(id) };
        await history({ action: 'fixture-release', hold: 'assistant-search' });
        const settled = row => when ? !row : row?.status === 'ready';
        result.settled = await until(async () => settled((await rows()).find(row => row.id === id)), `${name}: the upload settled`).then(() => true, () => false);
        const row = (await rows()).find(entry => entry.id === id);
        result.after = { row: row ? `${row.status}: ${row.text}` : 'gone', requests: await requestsFor(id), atHost: (await status()).fileDrafts.some(file => file.id === id), error: await ui(`document.querySelector('${scope} .assistant-chat-files [role="alert"]').textContent`) };
      } finally {
        await history({ action: 'fixture-release', hold: 'chat-file-chunk' }); await history({ action: 'fixture-release', hold: 'assistant-search' });
        await clearRows();
      }
      return result;
    };
    try {
      const attached = await scenario('vantande-bilaga.txt');
      check('an upload whose last chunk is acknowledged while another action holds the card still becomes attached, with one finish at the host', () => {
        assert.deepEqual(attached, { chunkHeld: true, searchHeld: true, acknowledged: true, whileBusy: { busy: true, status: 'uploading', requests: ['chat-file-start'] }, settled: true,
          after: { row: 'ready: Klar · 1 kB · 31 tecken', requests: ['chat-file-start', 'chat-file-finish'], atHost: true, error: '' } });
      });
      const waited = await scenario('avbruten-vid-slutet.txt', 'finish');
      check('a cancel while the finish waits for a busy card sends no finish, removes the file at the host and leaves no row on "Laddar upp"', () => {
        assert.deepEqual(waited, { chunkHeld: true, searchHeld: true, acknowledged: true, cancelled: true, whileBusy: { busy: true, status: 'uploading', requests: ['chat-file-start'] }, settled: true,
          after: { row: 'gone', requests: ['chat-file-start', 'chat-file-remove'], atHost: false, error: '' } });
      });
      const early = await scenario('avbruten-under-delen.txt', 'chunk');
      check('a cancel while the chunk is on its way and the card is busy removes the file at the host once the card is free and leaves no row on "Laddar upp"', () => {
        assert.deepEqual(early, { chunkHeld: true, searchHeld: true, cancelled: true, acknowledged: true, whileBusy: { busy: true, status: 'uploading', requests: ['chat-file-start'] }, settled: true,
          after: { row: 'gone', requests: ['chat-file-start', 'chat-file-remove'], atHost: false, error: '' } });
      });
    } finally {
      await type('[name="conversation-search"]', '');
      await until(() => ui(`document.querySelector('${scope} .assistant-local-search-results').hidden && !document.querySelector('${scope} .assistant-file-row')`), 'no search and no file rows after the waiting uploads');
    }
  }
  {
    // After a send the status line says so once, then shows the run's own status at the next view.
    const original = (await status()).id;
    await command({ action: 'chat-new' }); const running = (await status()).id;
    await ui(`document.querySelector('#refresh').click()`);
    try {
      await until(() => ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]')?.closest('[data-conversation-id]').dataset.conversationId===${JSON.stringify(running)}`), 'a conversation for the running answer');
      await type('[name="chat-message"]', RUNNING_ANSWER);
      await ui(`document.querySelector('${scope} .assistant-chat-composer').requestSubmit()`);
      const sent = await until(() => ui(`document.querySelector('${scope} [name="chat-message"]').value===''`), 'the message sent').then(() => true, () => false);
      await ui(`document.querySelector('#refresh').click()`);
      const own = await until(() => ui(`document.querySelector('${scope} .assistant-chat-status').textContent==='Agenten arbetar. Du kan stoppa svaret.'`), 'the run\'s own status back').then(() => true, () => false);
      const line = await ui(`document.querySelector('${scope} .assistant-chat-status').textContent`);
      check('after a send the status line shows the run\'s own status again at the next view, not "Meddelandet är skickat."', () => assert.deepEqual({ sent, own, line }, { sent: true, own: true, line: 'Agenten arbetar. Du kan stoppa svaret.' }));
    } finally {
      await command({ action: 'chat-stop' }); await command({ action: 'chat-select', conversationId: original }); await command({ action: 'chat-delete', conversationId: running });
      await ui(`document.querySelector('#refresh').click()`);
      await until(() => ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]')?.closest('[data-conversation-id]').dataset.conversationId===${JSON.stringify(original)} && !document.querySelector('${scope} [data-conversation-id="${running}"]')`), 'back in the first conversation without the running answer');
    }
  }

  const message = 'Förklara denna idé: <img src=x onerror="alert(1)">';
  await type('[name="chat-message"]', message); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${scope} [name="chat-message"]').value===${JSON.stringify(message)}`), 'chat draft survives polling');
  await ui(`document.querySelector('${scope} .assistant-chat-composer').requestSubmit()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-log').textContent.includes('Fixtursvar:') && document.querySelector('${scope} [name="chat-message"]').value===''`), 'chat reply and submission complete');
  assert.equal(await ui(`document.querySelectorAll('${scope} .assistant-chat-log img').length`), 0);
  assert.ok((await ui(`document.querySelector('${scope} .assistant-chat-log').textContent`)).includes(message));
  assert.ok((await ui(`document.querySelector('${scope} .assistant-chat-assistant .assistant-chat-author').textContent`)).includes('Terra'));
  check('chat transport renders text safely and identifies the real selected model', () => {});
  const firstId = await ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]').closest('[data-conversation-id]').dataset.conversationId`);
  await type('[name="chat-message"]', 'Osänt utkast i första samtalet');
  await command({ action: 'chat-new' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${scope} [name="chat-message"]').value==='' && document.querySelectorAll('${scope} .assistant-chat-message').length===0`), 'new conversation keeps previous');
  const secondId = await ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]').closest('[data-conversation-id]').dataset.conversationId`);
  assert.notEqual(secondId, firstId);
  await type('[name="chat-message"]', 'Osänt utkast i andra samtalet');
  await ui(`document.querySelector('${scope} [data-conversation-id="${firstId}"] .assistant-conversation-select').click()`);
  await until(() => ui(`document.querySelector('${scope} [name="chat-message"]').value==='Osänt utkast i första samtalet'`), 'separate conversation drafts');
  await ui(`window.__chatPrompt=window.prompt;window.prompt=()=> 'Mitt syntetiska samtal';document.querySelector('${scope} [data-conversation-id="${firstId}"] .assistant-conversation-menu button').click();window.prompt=window.__chatPrompt;delete window.__chatPrompt`);
  await until(() => ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Mitt syntetiska samtal'`), 'rename conversation');
  await type('[name="conversation-search"]', 'Mitt syntetiska');
  await until(() => ui(`document.querySelectorAll('${scope} .assistant-local-search-result').length>=1`), 'local search results');
  await type('[name="conversation-search"]', '');
  await until(() => ui(`document.querySelectorAll('${scope} [data-conversation-id]').length>=2`), 'search cleared');
  check('saved conversations can be selected, named and searched with separate unsent drafts', () => {});
  await command({ action: 'chat-fixture-features' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelectorAll('${scope} .assistant-saved-list-row').length===3`), 'complete host-owned lists');
  const pauseList = `${scope} [data-saved-list="watches"] .assistant-saved-list-row button:last-child`;
  await ui(`document.querySelector('${pauseList}').click()`);
  await until(() => ui(`document.querySelector('${pauseList}').textContent==='Återuppta'`), 'list pause reflects fresh host state');
  await capture('assistant-saved-lists', `${scope} .assistant-saved-list`);
  await ui(`document.querySelector('${scope} .assistant-model-continuation').open=true;const select=document.querySelector('${scope} [name="continuation-model"]');select.value='codex:gpt-6.1-sol';select.dispatchEvent(new Event('change',{bubbles:true}));select.closest('details').querySelector('button').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-log').textContent.includes('Fortsatt syntetiskt svar med vald modell.')`), 'explicit one-attempt continuation');
  assert.equal(await ui(`document.querySelector('${scope} .assistant-chat-message:last-child .assistant-chat-author').textContent.includes('Sol')`), true);
  await command({ action: 'chat-fixture-features-clear' }); await ui(`document.querySelector('#refresh').click()`);
  check('host list cards show every watch/routine, pause controls refresh, and continuation shows the chosen model', () => {});

  await command({ action: 'chat-fixture-stream' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-log').textContent.includes('Det här svaret växer successivt')`), 'cumulative pending text');
  assert.equal(await ui(`document.querySelector('${scope} .assistant-chat-composer').textContent.includes('Syntetisk pågående providertext')`), true);
  await ui(`document.querySelector('${scope} [data-conversation-id="${secondId}"] .assistant-conversation-select').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]').closest('[data-conversation-id]').dataset.conversationId===${JSON.stringify(secondId)} && document.querySelector('${scope} [name="chat-message"]').value==='Osänt utkast i andra samtalet'`), 'selected conversation is independent of another active turn');
  assert.equal(await ui(`document.querySelector('${scope} .assistant-chat-log').textContent.includes('Det här svaret växer successivt')`), false);
  await type('[name="chat-message"]', 'Redigerat utkast medan första samtalet arbetar');
  await ui(`document.querySelector('${scope} [data-conversation-id="${firstId}"] .assistant-conversation-select').click()`);
  await until(() => ui(`document.querySelector('${scope} [name="chat-message"]').value==='Osänt utkast i första samtalet' && document.querySelector('${scope} .assistant-chat-log').textContent.includes('Det här svaret växer successivt')`), 'active conversation draft restored after switching away');
  check('selecting B while A runs retains B identity, transcript and draft, then restores A independently', () => {});
  await ui(`[...document.querySelectorAll('${scope} button')].find(button=>button.textContent==='Stoppa svar').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-log').textContent.includes('Svaret är stoppat.')`), 'stop pending answer');
  await command({ action: 'chat-fixture-card' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`!!document.querySelector('${scope} [data-chat-card-id]')`), 'typed action proposal');
  await ui(`[...document.querySelectorAll('${scope} [data-chat-card-id] button')].find(button=>button.textContent==='Godkänn ändringen').click()`);
  await until(() => ui(`document.querySelector('${scope} [data-chat-card-id]').textContent.includes('Genomfört')`), 'host-authorized card confirmation');
  check('pending provider text and real status render progressively; approval transmits only its host card ID', () => {});
  await command({ action: 'chat-fixture-module' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`!!document.querySelector('${scope} [data-chat-module-id="test-module"]')`), 'module question in the main chat');
  await ui(`[...document.querySelectorAll('${scope} [data-chat-module-id="test-module"] button')].find(button=>button.textContent==='Svara i chatten').click()`);
  await type('[name="chat-message"]', 'Mitt uttryckliga syntetiska modulsvar');
  await ui(`document.querySelector('${scope} .assistant-chat-composer').requestSubmit()`);
  await until(() => ui(`document.querySelector('${scope} [data-chat-module-id="test-module"]').textContent.includes('Syntetiskt svar mottaget: Mitt uttryckliga syntetiska modulsvar') && document.querySelector('${scope} [name="chat-message"]').value===''`), 'exact scoped module reply through the shared composer');
  check('a real host-projected module question uses the one composer with exact module, run, question and conversation IDs', () => {});
  await command({ action: 'chat-fixture-case' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-case-chip')?.textContent.includes('Skriver till ärendet: Syntetiskt ärende')`), 'linked run marked in the composer');
  await type('[name="chat-message"]', 'Varför stannade ärendet?');
  await ui(`document.querySelector('${scope} .assistant-chat-composer').requestSubmit()`);
  await until(() => ui(`document.querySelector('${scope}').textContent.includes('Ärendet svarar: Varför stannade ärendet?') && document.querySelector('${scope} [name="chat-message"]').value===''`), 'text reaches the linked run');
  await ui(`document.querySelector('${scope} .assistant-case-chip button').click()`);
  await until(() => ui(`!document.querySelector('${scope} .assistant-case-chip')`), 'leaving the run removes its mark');
  await type('[name="chat-message"]', 'Till den vanliga chatten');
  await ui(`document.querySelector('${scope} .assistant-chat-composer').requestSubmit()`);
  await until(() => ui(`document.querySelector('${scope}').textContent.includes('Till den vanliga chatten') && !document.querySelector('${scope}').textContent.includes('Ärendet svarar: Till den vanliga chatten')`), 'after leaving, text goes to the ordinary chat');
  await until(() => ui(`[...document.querySelectorAll('${scope} [data-chat-module-id="case-module"] button')].some(button=>button.textContent==='Skriv till ärendet'&&!button.disabled)`), 'the card offers a way back');
  await ui(`[...document.querySelectorAll('${scope} [data-chat-module-id="case-module"] button')].find(button=>button.textContent==='Skriv till ärendet').click()`);
  await until(() => ui(`!!document.querySelector('${scope} .assistant-case-chip')`), 'writing to the run again');
  await command({ action: 'chat-fixture-case-clear' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`!document.querySelector('${scope} .assistant-case-chip')`), 'linked run removed from the fixture');
  check('a linked run takes the composer directly, is marked, and ✕ returns the composer to the ordinary chat', () => {});
  // After a finished check the task card shows Mejl's numbers and leads to the list.
  await command({ action: 'chat-fixture-task-done', counts: JSON.stringify({ replies: 2, needsYou: 1, info: 5 }) });
  await command({ action: 'chat-fixture-task-done', counts: JSON.stringify({ replies: 0, needsYou: 0, info: 0 }) });
  await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelectorAll('${scope} .assistant-chat-task[data-counts]').length===2`), 'finished task cards');
  const taskCards = await ui(`[...document.querySelectorAll('${scope} .assistant-chat-task[data-counts]')].map(card=>({counts:card.querySelector('.assistant-chat-task-counts').textContent,detail:card.querySelector('.muted').textContent,button:card.querySelector('button').textContent,target:card.querySelector('button').dataset.mailTarget}))`);
  check('after a check the chat card says "2 svar att godkänna · 1 behöver ditt svar · 5 för kännedom" with Visa i Mejl', () => {
    assert.deepEqual(taskCards.map(entry => entry.counts), ['2 svar att godkänna · 1 behöver ditt svar · 5 för kännedom', 'Inget väntar på dig']);
    assert.ok(taskCards.every(entry => entry.button === 'Visa i Mejl' && entry.target === 'inbox' && entry.detail.startsWith('Klart')), JSON.stringify(taskCards));
  });
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'chat-counts', async () => {
    await until(() => ui(`!document.querySelector('${scope}').hidden`), 'chat for the counts screenshot');
  }, [375], () => ui(`document.querySelector('${scope} .assistant-chat-task[data-counts]').scrollIntoView({block:'start'})`));
  await ui(`document.querySelector('${scope} .assistant-chat-task[data-counts] button').click()`);
  await until(() => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface==='mail' && !document.querySelector('${card} .assistant-mail-inbox').hidden && document.querySelector('${card} [data-tab="todo"]').getAttribute('aria-selected')==='true' && document.querySelector('${card} .assistant-topbar-title').textContent==='Mejl'`), 'Visa i Mejl opens the list');
  check('Visa i Mejl on a finished check opens Att göra in Mejl', () => {});
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(() => ui(`!document.querySelector('${scope}').hidden`), 'back to the chat after Mejl');
  await settingsToggle();
  await select('task-model', 'codex:gpt-6.1-sol');
  assert.equal(await ui(`document.querySelector('${settings} [name="chat-model"]').value`), 'codex:gpt-6.1-terra');
  await select('chat-model', 'berget:zai-org/GLM-5.3-Flash');
  const options = await ui(`[...document.querySelectorAll('${settings} [name="chat-model"] optgroup[label="Berget.ai"] option')].map(option=>option.value)`);
  assert.deepEqual(options, ['berget:zai-org/GLM-5.3-Flash', 'berget:google/gemma-4-31B-it', 'berget:mistralai/Mistral-Small-3.2-24B-Instruct-2506']);
  await type('[name="chat-message"]', 'Nästa fråga');
  assert.equal(await ui(`document.querySelector('${scope} .assistant-chat-composer button[type="submit"]').disabled`), true);
  const fixtureKey = 'fixture-only-berget-credential-no-real-access';
  await type('[name="berget-api-key"]', fixtureKey); await ui(`document.querySelector('${settings} [name="berget-api-key"]').form.requestSubmit()`);
  await until(() => ui(`document.querySelector('${settings} [name="berget-api-key"]').value==='' && !document.querySelector('${scope} .assistant-chat-composer button[type="submit"]').disabled`), 'private key save completed');
  assert.equal(await ui(`JSON.stringify(localStorage).includes(${JSON.stringify(fixtureKey)})`), false);
  assert.equal(await ui(`document.querySelector('${card}').textContent.includes(${JSON.stringify(fixtureKey)})`), false);
  await ui(`[...document.querySelectorAll('${settings} button')].find(button=>button.textContent==='Ta bort sparad nyckel').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-composer button[type="submit"]').disabled && !document.querySelector('${settings} [name="chat-model"]').disabled && document.querySelector('${settings}').textContent.includes('Den sparade Berget-nyckeln är borttagen.')`), 'key removal completed');
  await select('chat-model', 'codex:gpt-6.1-terra');
  await ui(`document.querySelector('${settings} [data-connection-id="codex"] button').click()`);
  await until(() => ui(`document.querySelector('${settings} [data-connection-id="codex"]').textContent.includes('Tillgänglig') && !!document.querySelector('${settings} [data-connection-id="codex"] time')`), 'connection result');
  await type('[name="berget-budget"]', '1,25'); await ui(`document.querySelector('${settings} [name="berget-budget"]').form.requestSubmit()`);
  await until(() => ui(`document.querySelector('${settings} [name="berget-budget"]').value==='1.25' || document.querySelector('${settings} [data-section="budget"]').textContent.includes('Budgetgränsen är sparad')`), 'budget save');
  assert.ok((await ui(`document.querySelector('${settings} .assistant-budget-summary').textContent`)).includes('0,003'));
  await command({ action: 'chat-fixture-budget-error', error: 'Syntetiskt läsfel i budgetfilen' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${settings} .assistant-budget-summary').textContent.includes('Syntetiskt läsfel') && !document.querySelector('${settings} .assistant-budget-totals') && document.querySelector('${settings} [name="berget-budget"]').disabled`), 'unreadable budget has no invented zero totals');
  await command({ action: 'chat-fixture-budget-error', error: '' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`!!document.querySelector('${settings} .assistant-budget-totals') && !document.querySelector('${settings} [name="berget-budget"]').disabled`), 'budget restored after explicit fixture recovery');
  await type('[name="memory-label"]', 'Syntetiskt minne'); await type('[name="memory-value"]', 'Endast testdata');
  await ui(`document.querySelector('${settings} [name="memory-label"]').form.requestSubmit()`);
  await until(() => ui(`!!document.querySelector('${settings} [data-memory-id]')`), 'private memory save');
  await ui(`document.querySelector('${settings} [data-memory-id] button').click()`);
  assert.equal(await ui(`document.querySelector('${settings} [name="memory-value"]').value`), 'Endast testdata');
  const memoryDelete = await declineThenConfirm({ ui, until }, `document.querySelector('${settings} [data-memory-id] button:nth-of-type(2)').click()`, async () => (await status()).memories);
  await until(() => ui(`!document.querySelector('${settings} [data-memory-id]')`), 'private memory deletion');
  check('settings separates chat/task models, protects keys, distinguishes tested connections and manages precise budgets/memories', () => {});
  check('Radera uppgift asks once with the memory\'s name; answered no it keeps the memory, answered yes it deletes it', () => {
    const question = 'Radera den sparade uppgiften ”Syntetiskt minne”?';
    assert.deepEqual(memoryDelete, { declined: [question], startedOnNo: false, kept: true, accepted: [question] });
  });
  await settingsToggle();
  await until(() => ui(`!document.querySelector('${scope}').hidden`), 'chat before final screenshots');
  // The composer's own model menu uses the same chat-model action as the settings page.
  await ui(`document.querySelector('${scope} .assistant-model-trigger').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-model-menu').matches(':popover-open') && document.querySelector('${scope} .assistant-model-trigger').getAttribute('aria-expanded')==='true'`), 'model menu opened');
  assert.match(await ui(`document.querySelector('${scope} .assistant-model-menu').textContent`), /skickas till OpenAI via Codex/);
  await ui(`(()=>{const radio=document.querySelector('${scope} .assistant-model-menu input[value="codex:gpt-6.1-sol"]');radio.checked=true;radio.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => ui(`document.querySelector('${settings} [name="chat-model"]').value==='codex:gpt-6.1-sol' && document.querySelector('${scope} .assistant-model-name').textContent==='GPT-6.1 Sol' && !document.querySelector('${scope} .assistant-model-menu').matches(':popover-open')`), 'composer model choice saved');
  await select('chat-model', 'codex:gpt-6.1-terra');
  check('the composer model menu explains where each backend sends the chat and saves through chat-model', () => {});
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'chat', async () => {
    if (await ui(`document.querySelector('${scope}').hidden`)) await settingsToggle();
    await until(() => ui(`!document.querySelector('${scope}').hidden`), 'chat for screenshots');
  });
  await ui(`document.querySelector('${scope} [data-conversation-id="${secondId}"] .assistant-conversation-select').click()`);
  await until(() => ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]')?.closest('[data-conversation-id]').dataset.conversationId===${JSON.stringify(secondId)}`), 'second conversation selected before clearing the first');
  const conversationMenu = (id, label) => `[...document.querySelectorAll('${scope} [data-conversation-id="${id}"] .assistant-conversation-menu button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`;
  const titled = async id => (await status()).conversations.find(record => record.id === id).title;
  const firstTitle = await titled(firstId), secondTitle = await titled(secondId);
  const cleared = await declineThenConfirm({ ui, until }, conversationMenu(firstId, 'Rensa meddelanden'), async () => (await status()).conversations.find(record => record.id === firstId));
  await until(async () => { const chat = await status(); return chat.id === secondId && chat.conversations.find(record => record.id === firstId)?.count === 0; }, 'clear a conversation that was not selected');
  assert.equal(await ui(`document.querySelector('${scope} .assistant-conversation-select[aria-current]').closest('[data-conversation-id]').dataset.conversationId`), secondId, 'the selection never moves');
  check('each conversation menu clears exactly that conversation without selecting it', () => {});
  check('Rensa meddelanden asks once with the conversation\'s name; answered no it clears nothing', () => {
    const question = `Rensa meddelandena i ”${firstTitle}”? Bifogade filer i samtalet, även kvitton, tas också bort. Samtalet och sparade uppdrag behålls.`;
    assert.deepEqual(cleared, { declined: [question], startedOnNo: false, kept: true, accepted: [question] });
  });
  const deleted = await declineThenConfirm({ ui, until }, conversationMenu(secondId, 'Radera samtal'), async () => (await status()).conversations.map(record => record.id));
  await until(() => ui(`!document.querySelector('${scope} [data-conversation-id="${secondId}"]')`), 'delete selected conversation metadata');
  check('deleting a named conversation requires explicit confirmation and keeps saved assistant work', () => {
    const question = `Radera samtalet ”${secondTitle}”? Meddelandena tas bort. Sparade mejl, ärenden och uppdrag finns kvar.`;
    assert.deepEqual(deleted, { declined: [question], startedOnNo: false, kept: true, accepted: [question] });
  });
}

/** "08.00" in the panel's time zone, as the Bevakningar row says it. */
function clockIn(value, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.hour}.${parts.minute}`;
}

/**
 * Den här sidan: an ordinary tab in the panel's own window is offered by its address,
 * read only on Dela, and arrives as a chat file with title, address, selection and
 * visible text but no form values. Non-http(s) pages and the panel itself are never offered.
 */
export async function assistantPageShareChecks({ ui, until, check, rpc, panelSession, artifactDir, pageUrl, query }) {
  const card = '[data-module-id="assistant-fixture"]', scope = `${card} .assistant-view-chat`, share = `${scope} .assistant-page-share`, chip = `${scope} .assistant-page-chip`;
  const command = input => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'correct', input } })})`);
  const status = () => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'status', input: {} } })})`).then(reply => reply.result);
  const drafts = async () => (await status()).chat.fileDrafts;
  const panel = await ui('Promise.all([chrome.tabs.getCurrent(),chrome.windows.getCurrent()]).then(([tab,window])=>({tabId:tab.id,windowId:window.id}))');
  const opened = [];
  // A page opened outside the extension, then made the active tab of the panel's window.
  const open = async url => {
    const { targetId } = await rpc('Target.createTarget', { url }); opened.push(targetId);
    const tabId = await until(() => ui(`chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===${JSON.stringify(url)}||tab.pendingUrl===${JSON.stringify(url)})?.id)`), `tab for ${url}`);
    await until(() => ui(`chrome.tabs.get(${tabId}).then(tab=>tab.status==='complete')`), `${url} loaded`);
    await ui(`(async()=>{const tab=await chrome.tabs.get(${tabId});if(tab.windowId!==${panel.windowId})await chrome.tabs.move(${tabId},{windowId:${panel.windowId},index:-1});await chrome.tabs.update(${tabId},{active:true});})()`);
    return { targetId, tabId };
  };
  const inPage = async (target, expression) => {
    const { sessionId } = await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    try { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true }, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); }
    finally { await rpc('Target.detachFromTarget', { sessionId }); }
  };
  const offered = label => ui(`(()=>{const row=document.querySelector('${share}');return !!row&&!row.hidden&&row.querySelector('.assistant-page-share-address').textContent===${JSON.stringify(label)};})()`);
  const tapShare = async () => {
    await ui(`document.querySelector('${share} .assistant-page-share-button').click()`);
    await until(async () => (await drafts()).some(file => file.status === 'ready') && await ui(`!!document.querySelector('${chip}[data-file-status="ready"]')`), 'shared page ready as a chat file');
    return (await drafts()).find(file => file.status === 'ready');
  };
  const unshare = async () => {
    await ui(`document.querySelector('${chip} [data-remove-file]').click()`);
    await until(async () => !(await drafts()).length && await ui(`!document.querySelector('${chip}')`), 'shared page removed');
  };
  const chipText = () => ui(`(()=>{const row=document.querySelector('${chip}');return row?{name:row.querySelector('strong').textContent,note:row.querySelector('p').textContent,remove:row.querySelector('[data-remove-file]').getAttribute('aria-label'),offer:document.querySelector('${share}').hidden}:null;})()`);
  const privacy = 'Sidans text skickas till OpenAI via Codex när du skickar. Bara chattmodellen läser den, och den följer aldrig med till uppdrag. Delningen gäller bara det här samtalet.';
  // The share page's other editors (sidepanel-live.mjs): shadow root, nested, several role tokens, islands.
  const editorMarkers = ['Skugg-redigerare-7722', 'Yttre-redigerare-7723', 'Inre-redigerare-7724', 'Flera-roller-7725', 'Utkast-med-o-7726', 'O-i-redigerare-7727', 'Redigerare-i-o-7728'];
  const statusLine = () => ui(`document.querySelector('${scope} .assistant-chat-status').textContent`);
  // The composer fits each width; screenshots of it only with an artifact directory. The panel's
  // tab is in the background here, so no animation frames run.
  const capture = async name => {
    const original = await ui('({width:innerWidth,height:innerHeight})');
    if (artifactDir) mkdirSync(join(artifactDir, 'panel-shots'), { recursive: true });
    for (const [width, height] of [[375, 812], [1440, 900]]) {
      await rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, panelSession);
      await ui(`document.querySelector('${scope} .assistant-chat-composer').scrollIntoView({block:'end'})`);
      assert.equal(await ui('document.documentElement.scrollWidth<=innerWidth'), true, `${name} fits ${width}px`);
      if (!artifactDir) continue;
      const shot = await rpc('Page.captureScreenshot', { format: 'png' }, panelSession);
      writeFileSync(join(artifactDir, 'panel-shots', `${name}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    await rpc('Emulation.setDeviceMetricsOverride', { ...original, deviceScaleFactor: 1, mobile: false }, panelSession);
  };
  try {
    if (await ui(`document.querySelector('${card} .assistant-workspace').dataset.surface!=='chat'`)) await ui(`document.querySelector('${card} [data-view="settings"]').click()`);
    await until(() => ui(`!document.querySelector('${scope}').hidden`), 'chat before sharing a page');
    assert.equal(await ui(`document.querySelector('${share}').hidden`), true, 'the panel itself is never offered');
    const page = await open(`${pageUrl}${query}`);
    await inPage(page, "getSelection().selectAllChildren(document.querySelector('#chosen'))");
    const label = `${new URL(pageUrl).host}${new URL(pageUrl).pathname}`;
    await until(() => offered(label), 'the active page is offered by its address');
    const before = await drafts();
    check('the composer offers the active http(s) page by its address and reads nothing before Dela', () => {
      assert.deepEqual(before, [], 'no file exists before the tap');
    });
    await capture('chat-page-offer');
    const file = await tapShare();
    const text = file.preview;
    check('Dela adds the page as a chat file with title, address, selection and visible text, never form values', () => {
      assert.match(file.name, /^Sida 127\.0\.0\.1-9234 \d{4}-\d{2}-\d{2}\.txt$/); assert.equal(file.kind, 'text');
      assert.ok(file.textChars < 600, 'the whole file is in its preview');
      assert.match(text, /^Delad sida från din egen flik\nTitel: Delningstest\nAdress: http:\/\/127\.0\.0\.1:9234\/share\?order=dolt&q=paket&token=dolt\nDelad: \d{4}-\d{2}-\d{2} kl\. \d{2}\.\d{2}\n\nMarkerad text:\nPaketet lämnade lagret i Borås i morse\.\n\nSidans text:\n/);
      for (const shown of ['Leveransstatus för order 4711', 'Beräknad leverans: torsdag.']) assert.ok(text.includes(shown), shown);
      for (const kept of ['Hemligt-Losen-9931', 'Inskrivet-Namn-8842', 'Skrivet-Utkast-6610', 'Forifylld-anteckning-5521', 'Dold-rad-7310', 'Hemlig-Token-3301', '#konto']) assert.equal(text.includes(kept), false, `${kept} never leaves the page`);
      assert.equal(file.source, 'page'); assert.equal(file.pageUrl, 'http://127.0.0.1:9234/share?order=dolt&q=paket&token=dolt', 'the host keeps the mark and the address the model reads');
    });
    check('only text a sighted user sees follows: no sr-only, opacity:0, off-page, transparent, font-size:0, aria-hidden or inert text', () => {
      for (const hidden of ['Skarmlasartext-6001', 'Genomskinlig-6002', 'Utanfor-skarmen-6003', 'Osynlig-farg-6004', 'Noll-storlek-6005', 'Dold-for-alla-6006', 'Inert-text-6007']) assert.equal(text.includes(hidden), false, `${hidden} is not visible`);
      assert.match(text, /Leveransstatus för order 4711\nPaketet lämnade lagret i Borås i morse\.\nBeräknad leverans: torsdag\./, 'blocks are separated by line breaks');
      assert.ok(text.includes('Langt-ner-6008'), 'text further down a content-visibility:auto page is visible on scrolling, so it is shared');
    });
    check('typed text in a contenteditable composer or a role="textbox" field never follows the page', () => {
      for (const typed of ['Osant-meddelande-7720', 'Rollruta-7721']) assert.equal(text.includes(typed), false, `${typed} stays in its editor`);
    });
    check('nor does text in an editor in an open shadow root, a nested editor, a role with several tokens, a non-editable island in an editor or an editor in such an island', () => {
      for (const typed of editorMarkers) assert.equal(text.includes(typed), false, `${typed} stays in its editor`);
    });
    const shownChip = await chipText();
    check('the chip says "Sida: värd/sökväg", how much is shared, that the text never goes to a task, and has ✕', () => {
      assert.equal(shownChip.name, `Sida: ${label}`);
      assert.equal(shownChip.note, `${file.textChars} tecken · ${privacy}`);
      assert.equal(shownChip.remove, `Sluta dela sidan ${label}`); assert.equal(shownChip.offer, true, 'a page already shared is not offered again');
    });
    await capture('chat-page-shared');
    // The chip is drawn from the host's mark, so it survives a reload of the panel.
    await rpc('Page.reload', {}, panelSession);
    await until(async () => JSON.stringify(await chipText()) === JSON.stringify(shownChip), 'the shared page chip after a panel reload');
    check('after a panel reload the chip keeps "Sida: …", its note and ✕, and the page is still not offered again', () => {});
    await unshare();
    await until(() => offered(label), 'offered again after ✕');
    // A selection inside a form control is the user's typing, not page text, also after the field lost focus.
    await inPage(page, "(()=>{const note=document.querySelector('#note');note.focus();note.select();})()");
    const typed = await tapShare();
    check('a selection inside a form field never follows the page', () => {
      assert.equal(typed.preview.includes('Markerad text'), false); assert.equal(typed.preview.includes('Skrivet-Utkast-6610'), false);
    });
    // A view drawn after the share (the conversation's new name shows it arrived) keeps the message: every
    // action is followed by a poll, and this view has no status of its own to put in its place.
    const sharedIn = (await status()).chat, sharedName = 'Delningstest med bifogad sida';
    await command({ action: 'chat-rename', conversationId: sharedIn.id, title: sharedName });
    let attachedLine;
    try {
      await ui(`document.querySelector('#refresh').click()`);
      const drawn = await until(() => ui(`document.querySelector('${card} .assistant-topbar-title').textContent===${JSON.stringify(sharedName)}`), 'a view drawn after the share').then(() => true, () => false);
      attachedLine = { drawn, attached: /^Sidan .+ är bifogad\. Skriv vad du vill veta och skicka\.$/.test(await statusLine()) };
    } finally { await command({ action: 'chat-rename', conversationId: sharedIn.id, title: sharedIn.title }); await ui(`document.querySelector('#refresh').click()`); }
    check('a shared page\'s message stays on the status line through the next view, which has no status of its own', () => assert.deepEqual(attachedLine, { drawn: true, attached: true }));
    await unshare();
    const afterRemoved = await statusLine();
    check('once the shared page is removed, the status line no longer says it is attached', () => assert.equal(afterRemoved, ''));
    await inPage(page, "(()=>{const note=document.querySelector('#note');note.focus();note.setSelectionRange(0,7);note.blur();})()");
    const blurred = await tapShare();
    check('a selection left in a textarea that lost focus never follows the page', () => {
      assert.equal(blurred.preview.includes('Markerad text'), false); assert.equal(blurred.preview.includes('Skrivet'), false);
    });
    await unshare();
    // A selection of the whole page takes in its editors, whose text the page text leaves out: so it is
    // not the page itself and follows as "Markerad text", while "Sidans text" still leaves the editors out.
    // A selection of all the page text is not repeated; that is checked on the composer page below.
    await inPage(page, "getSelection().selectAllChildren(document.body)");
    const whole = await tapShare();
    await command({ action: 'chat-fixture-file-tail', fileId: whole.id });
    const wholeTail = (await drafts())[0].preview, wholePage = wholeTail.slice(wholeTail.lastIndexOf('\n\nSidans text:\n'));
    check('a selection of the whole page, editors included, follows as "Markerad text", and the page text still leaves the editors out', () => {
      assert.match(whole.preview, /\n\nMarkerad text:\nLeveransstatus för order 4711\n/); assert.ok(whole.preview.includes('Osant-meddelande-7720'), 'the user selected the composer too');
      assert.match(wholePage, /^\n\nSidans text:\nLeveransstatus för order 4711\n/);
      for (const typed of ['Osant-meddelande-7720', 'Rollruta-7721', ...editorMarkers]) assert.equal(wholePage.includes(typed), false, `${typed} is not page text`);
    });
    await unshare();
    // A page that is slow to answer: the read belongs to the conversation of the tap, and Dela stays usable on other tabs.
    const tapped = (await status()).chat.id;
    await inPage(page, "setTimeout(()=>{const end=Date.now()+6000;while(Date.now()<end);},0)");
    await ui(`document.querySelector('${share} .assistant-page-share-button').click()`);
    await until(() => ui(`document.querySelector('${share} .assistant-page-share-button').textContent==='Läser…'`), 'the slow page is being read');
    const other = await open('http://localhost:9234/scroll');
    await until(() => offered('localhost:9234/scroll'), 'another tab is offered while the first one is read');
    const otherButton = await ui(`(()=>{const button=document.querySelector('${share} .assistant-page-share-button');return {text:button.textContent,disabled:button.disabled};})()`);
    await command({ action: 'chat-new' });
    await ui(`document.querySelector('#refresh').click()`);
    await until(async () => (await status()).chat.id !== tapped, 'another conversation while the page is read');
    await until(() => ui(`document.querySelector('${scope} .assistant-chat-files .module-error').textContent.includes('Du bytte samtal medan sidan lästes')`), 'the late page is dropped with a message');
    const after = await status();
    check('one slow tab never holds Dela for other tabs, and a read finished after a conversation switch is dropped with a message', () => {
      assert.deepEqual(otherButton, { text: 'Dela', disabled: false });
      assert.deepEqual(after.chat.fileDrafts, [], 'nothing lands in the conversation opened meanwhile');
    });
    await command({ action: 'chat-select', conversationId: tapped });
    await ui(`document.querySelector('#refresh').click()`);
    await until(async () => (await status()).chat.id === tapped && !(await drafts()).length, 'nothing landed in the first conversation either');
    await rpc('Target.closeTarget', { targetId: other.targetId });
    // A long page is cut at 500 000 characters, with a line saying so.
    await open(`${pageUrl}-long`);
    await until(() => offered(`${label}-long`), 'the long page is offered');
    const long = await tapShare();
    await command({ action: 'chat-fixture-file-tail', fileId: long.id });
    const tail = (await drafts())[0].preview;
    const longChip = await chipText();
    check('a page with more than 500 000 characters is cut with a marker, and the chip says "kapad"', () => {
      assert.match(longChip.note, /^500\s000 tecken · kapad · Sidans text skickas/);
      assert.equal(long.pageTruncated, true);
      assert.ok(long.textChars <= 500_000 && long.textChars > 499_000, String(long.textChars));
      assert.match(tail, /\n\n\[Texten är kapad vid 500 000 tecken\. Resten av sidan kom inte med\.\]$/); assert.equal(tail.includes('Slutet-av-sidan-4410'), false);
    });
    await unshare();
    // The context menu: the worker opens the panel inside the click and leaves it this request (test/assistant-context-menu.mjs).
    const menu = (kind, target, url) => ui(`chrome.storage.session.set({tabaiPanelRequest:{id:crypto.randomUUID(),at:Date.now(),kind:${JSON.stringify(kind)},windowId:${panel.windowId},tabId:${target.tabId},url:${JSON.stringify(url)}}})`);
    await ui(`chrome.tabs.update(${page.tabId},{active:true})`);
    await inPage(page, "getSelection().selectAllChildren(document.querySelector('#chosen'))");
    await menu('selection', page, `${pageUrl}${query}`);
    await until(async () => (await drafts()).some(file => file.pageSelection && file.status === 'ready') && await ui(`!!document.querySelector('${chip}[data-file-status="ready"]')`), 'the selection shared from the context menu');
    const selected = (await drafts()).find(file => file.pageSelection), selectedChip = await chipText();
    check('"Fråga Tabai om ”…”" shares only the selected text, as a page file with the address the model reads', () => {
      assert.match(selected.preview, /^Markerad text från din egen flik\nAdress: http:\/\/127\.0\.0\.1:9234\/share\?order=dolt&q=paket&token=dolt\nDelad: \d{4}-\d{2}-\d{2} kl\. \d{2}\.\d{2}\n\nMarkerad text:\nPaketet lämnade lagret i Borås i morse\.$/);
      for (const kept of ['Leveransstatus', 'Beräknad leverans', 'Delningstest', 'Hemligt-Losen-9931', 'Inskrivet-Namn-8842', 'Langt-ner-6008']) assert.equal(selected.preview.includes(kept), false, `${kept} stays on the page`);
      assert.deepEqual([selected.source, selected.pageSelection, selected.pageUrl], ['page', true, 'http://127.0.0.1:9234/share?order=dolt&q=paket&token=dolt']);
      assert.deepEqual(selectedChip, { name: 'Markerad text från 127.0.0.1:9234', note: `${selected.textChars} tecken · ${privacy.replace('Sidans text', 'Den markerade texten')}`, remove: 'Sluta dela den markerade texten från 127.0.0.1:9234', offer: false });
    });
    await capture('chat-selection-shared');
    await unshare();
    // Removes every shared draft through its own ✕, also one that failed and lives only in the panel.
    const clearShared = async () => {
      for (let round = 0; round < 6 && await ui(`!!document.querySelector('${chip} [data-remove-file]')`); round++) {
        const id = await ui(`document.querySelector('${chip} [data-remove-file]').dataset.removeFile`);
        await until(() => ui(`!document.querySelector('${chip} [data-remove-file="${id}"]').disabled`), 'a shared draft can be removed');
        await ui(`document.querySelector('${chip} [data-remove-file="${id}"]').click()`);
        await until(() => ui(`!document.querySelector('${chip} [data-remove-file="${id}"]')`), 'a shared draft removed');
      }
    };
    {
      // Focus inside an editor puts a caret, not a selection, there: a whole-page share still leaves the typed text out.
      try {
        for (const [id, name] of [['composer', 'the contenteditable composer'], ['rolebox', 'the role="textbox" field']]) {
          await inPage(page, `(()=>{const editor=document.querySelector('#${id}');editor.focus();getSelection().collapse(editor,0);})()`);
          const focused = await tapShare();
          check(`with focus inside ${name} a whole-page share leaves every editor's text out`, () => {
            for (const typed of ['Osant-meddelande-7720', 'Rollruta-7721']) assert.equal(focused.preview.includes(typed), false, `${typed} stays in its editor`);
            assert.match(focused.preview, /Sidans text:\nLeveransstatus för order 4711/);
          });
          await unshare();
        }
      } finally { await clearShared(); }
    }
    {
      // A selection the user makes inside an editor is deliberate and is shared as a selection; one inside an input is not.
      try {
        await inPage(page, "(()=>{const composer=document.querySelector('#composer');composer.focus();getSelection().selectAllChildren(composer);})()");
        await menu('selection', page, `${pageUrl}${query}`);
        await until(async () => (await drafts()).some(file => file.pageSelection && file.status === 'ready'), 'the selection inside the composer shared');
        const inComposer = (await drafts()).find(file => file.pageSelection);
        check('a selection made inside a contenteditable composer is shared as a selection, and only it', () => {
          assert.match(inComposer.preview, /\n\nMarkerad text:\nOsant-meddelande-7720$/);
          for (const kept of ['Leveransstatus', 'Rollruta-7721', 'Inskrivet-Namn-8842']) assert.equal(inComposer.preview.includes(kept), false, `${kept} stays on the page`);
        });
        await unshare();
        await inPage(page, "(()=>{const typed=document.querySelector('#typed');typed.focus();typed.select();})()");
        await menu('selection', page, `${pageUrl}${query}`);
        await until(() => ui(`document.querySelector('${scope} .assistant-chat-files .module-error').textContent.startsWith('Ingen markerad text kunde läsas.')`), 'the selection inside an input refused');
        const inInput = await drafts();
        check('a selection inside an input is never shared', () => assert.deepEqual(inInput, []));
      } finally { await clearShared(); }
    }
    {
      // A page that is one large editor has no page text: Dela shares nothing and the status line says to select the text.
      try {
        const editor = await open(`${pageUrl}-editor`);
        await until(() => offered(`${label}-editor`), 'the editable page is offered');
        await ui(`document.querySelector('${share} .assistant-page-share-button').click()`);
        // Läser… turns back into Dela only after the read and anything it shared have finished.
        await until(() => ui(`document.querySelector('${share} .assistant-page-share-button').textContent==='Dela'`), 'Dela on the editable page answered');
        const editable = { status: await ui(`document.querySelector('${scope} .assistant-chat-status').textContent`), drafts: await drafts() };
        check('a page that is one large editor shares nothing, and the status line says to select the text to share', () => {
          assert.deepEqual(editable, { status: 'Hela sidan är ett redigerbart fält, så Tabai delar inte dess text. Markera det du vill dela och tryck Dela igen.', drafts: [] });
        });
        await inPage(editor, "getSelection().selectAllChildren(document.querySelector('#draft'))");
        const chosen = await tapShare();
        check('a selection on such a page is shared as a selection', () => {
          assert.equal(chosen.pageSelection, true); assert.match(chosen.preview, /\n\nMarkerad text:\nHela-sidan-redigerbar-7730$/); assert.equal(chosen.preview.includes('Mitt utkast'), false);
        });
        await unshare();
      } finally { await clearShared(); await ui(`chrome.tabs.update(${page.tabId},{active:true})`); }
    }
    {
      // Dela on a page with a little ordinary text and a long selection inside its composer: the selection
      // is not page text, so it follows, however long. A selection of all the page text is not repeated.
      try {
        const composer = await open(`${pageUrl}-composer`);
        await until(() => offered(`${label}-composer`), 'the composer page is offered');
        await inPage(composer, "(()=>{const editor=document.querySelector('#composer');editor.focus();getSelection().selectAllChildren(editor);})()");
        const inEditor = await tapShare();
        check('Dela on a page with ordinary text shares a selection made inside its composer, also one longer than the page text', () => {
          assert.equal(inEditor.pageSelection, undefined, 'the page is shared, with the selection in it');
          assert.match(inEditor.preview, /\n\nMarkerad text:\n(?:Langt-utkast-7741 ){4}Langt-utkast-7741\n\nSidans text:\nKort-text-7740$/);
        });
        await unshare();
        await inPage(composer, "(()=>{document.activeElement?.blur();getSelection().selectAllChildren(document.querySelector('#short'));})()");
        const allText = await tapShare();
        check('a selection of all the page text is the page itself and is not repeated as "Markerad text"', () => {
          assert.equal(allText.preview.includes('Markerad text'), false); assert.match(allText.preview, /\n\nSidans text:\nKort-text-7740$/);
        });
        await unshare();
        // A page whose only text is in an editor: without a selection Dela asks for one, with one it shares only that.
        const only = await open(`${pageUrl}-composer-only`);
        await until(() => offered(`${label}-composer-only`), 'the editor-only page is offered');
        await ui(`document.querySelector('${share} .assistant-page-share-button').click()`);
        await until(() => ui(`document.querySelector('${share} .assistant-page-share-button').textContent==='Dela'`), 'Dela on the editor-only page answered');
        const asked = { status: await statusLine(), error: await ui(`document.querySelector('${scope} .assistant-chat-files .module-error').textContent`), drafts: await drafts() };
        check('a page whose only text is in an editor shares nothing without a selection, and the status line asks for one', () => {
          assert.deepEqual(asked, { status: 'Sidans text står i redigerbara fält, så Tabai delar den inte. Markera det du vill dela och tryck Dela igen.', error: '', drafts: [] });
        });
        await inPage(only, "(()=>{const editor=document.querySelector('#composer');editor.focus();getSelection().selectAllChildren(editor);})()");
        const onlyChosen = await tapShare();
        const onlyStatus = await statusLine();
        check('a selection on such a page is shared as a selection, never as an empty page', () => {
          assert.equal(onlyChosen.pageSelection, true); assert.match(onlyChosen.preview, /^Markerad text från din egen flik\n[\s\S]*\n\nMarkerad text:\nBara-redigerare-7742$/);
          assert.equal(onlyStatus.startsWith('Sidan '), false, `the status line said "${onlyStatus}"`);
        });
        await unshare();
      } finally { await clearShared(); await ui(`chrome.tabs.update(${page.tabId},{active:true})`); }
    }
    {
      // A share the host refuses is not reported as attached: the status line says so and Dela is offered again.
      try {
        await until(() => offered(label), 'the share page is offered again');
        await inPage(page, 'getSelection().removeAllRanges()');
        await command({ action: 'chat-fixture-file-refused' });
        await ui(`document.querySelector('${share} .assistant-page-share-button').click()`);
        await until(() => ui(`!!document.querySelector('${chip}[data-file-status="failed"]') && document.querySelector('${share} .assistant-page-share-button').textContent==='Dela'`), 'the refused share is shown as failed');
        const refused = await ui(`({status:document.querySelector('${scope} .assistant-chat-status').textContent,offered:!document.querySelector('${share}').hidden,row:document.querySelector('${chip}[data-file-status="failed"] p').textContent})`);
        check('a page share the host refuses is never reported as attached: the status line says so and Dela is offered again', () => {
          assert.deepEqual(refused, { status: `Sidan ${label} kunde inte bifogas. Se felet ovanför och tryck Dela igen.`, offered: true, row: 'Uppladdningen kunde inte startas.' });
        });
        // A view drawn after the failure (the conversation's new name shows it arrived) keeps the message.
        const conversation = (await status()).chat, renamed = 'Delningstest efter en ny vy';
        await command({ action: 'chat-rename', conversationId: conversation.id, title: renamed });
        try {
          await ui(`document.querySelector('#refresh').click()`);
          const drawn = await until(() => ui(`document.querySelector('${card} .assistant-topbar-title').textContent===${JSON.stringify(renamed)}`), 'a view drawn after the refused share').then(() => true, () => false);
          const kept = await statusLine();
          check('the refused share\'s message stays on the status line through the next view', () => assert.deepEqual({ drawn, kept }, { drawn: true, kept: `Sidan ${label} kunde inte bifogas. Se felet ovanför och tryck Dela igen.` }));
        } finally { await command({ action: 'chat-rename', conversationId: conversation.id, title: conversation.title }); await ui(`document.querySelector('#refresh').click()`); }
      } finally { await clearShared(); }
    }
    // "Fråga Tabai om länken" only fills in the question.
    const tabsBefore = await ui('chrome.tabs.query({}).then(tabs=>tabs.length)');
    await menu('link', page, 'https://kim:pw@example.test/produkt?id=7#recensioner');
    await until(() => ui(`document.querySelector('${scope} [name="chat-message"]').value==='Vad finns på https://example.test/produkt?id=7?'`), 'the link question in the input');
    const linkState = { drafts: await drafts(), tabs: await ui('chrome.tabs.query({}).then(tabs=>tabs.length)'), status: await ui(`document.querySelector('${scope} .assistant-chat-status').textContent`) };
    check('"Fråga Tabai om länken" fills in "Vad finns på {url}?" without credentials or fragment, and nothing is opened or read', () => {
      assert.deepEqual(linkState, { drafts: [], tabs: tabsBefore, status: 'Frågan om länken står i rutan. Ingenting har hämtats; skicka när du vill.' });
    });
    await ui(`(()=>{const input=document.querySelector('${scope} [name="chat-message"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    // Chrome's own pages are never offered, and the offer follows the active tab.
    await open('chrome://version/');
    await until(() => ui(`document.querySelector('${share}').hidden`), 'no offer for chrome://');
    check('chrome:// pages and the panel itself are never offered', () => {});
    // Mail and calendar belong to Mejl. Port 1 is refused by Chrome itself, so no mail service is ever contacted.
    const mailTab = await open('https://mail.google.com:1/mail/u/0/');
    await until(() => offered('mail.google.com:1/mail/u/0/'), 'a mail page shows its row');
    const mail = await ui(`(()=>{const row=document.querySelector('${share}');return {button:row.querySelector('.assistant-page-share-button').hidden,note:row.querySelector('.assistant-page-share-mail').hidden?'':row.querySelector('.assistant-page-share-mail').textContent};})()`);
    check('a mail or calendar page is never offered for sharing; the row says "Mejlen hanteras i Mejl"', () => {
      assert.deepEqual(mail, { button: true, note: 'Mejlen hanteras i Mejl' });
    });
    // The context menu on a mail page shares nothing either, and says why.
    await menu('selection', mailTab, 'https://mail.google.com:1/mail/u/0/');
    await until(() => ui(`document.querySelector('${scope} .assistant-chat-files .module-error').textContent==='Mejlen hanteras i Mejl.'`), 'the mail page refused');
    const mailDrafts = await drafts();
    check('the context menu on a mail page is refused with "Mejlen hanteras i Mejl." and nothing is read or shared', () => assert.deepEqual(mailDrafts, []));
  } finally {
    await ui(`chrome.tabs.update(${panel.tabId},{active:true})`);
    for (const targetId of opened) await rpc('Target.closeTarget', { targetId }).catch(() => {});
  }
  await until(() => ui(`document.querySelector('${share}').hidden && document.visibilityState==='visible'`), 'the panel is the active tab again');
}

/**
 * A web approval card's image: fetched by the panel once, outside the poll; shown under the title,
 * enlarged on a tap, fitting 320 px in light and dark mode. A card without one says so. Then the
 * context menu's switch in Settings → Allmänt and the Dela shortcut.
 */
export async function assistantApprovalCardChecks({ ui, until, check, rpc, panelSession, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]', scope = `${card} .assistant-view-chat`, web = `${scope} [data-web-action]`;
  const command = (operation, input) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const reads = async () => JSON.parse((await command('history', { action: 'fixture-state' })).result.description).previewReads;
  const surface = () => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface`);
  const toChat = async () => { if (await surface() !== 'chat') await ui(`document.querySelector('${card} [data-view="settings"]').click()`); await until(async () => await surface() === 'chat', 'the chat'); };
  await toChat();
  await command('correct', { action: 'chat-new' });
  await command('correct', { action: 'chat-fixture-web-card' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelectorAll('${web}').length===2 && document.querySelector('${web} .assistant-approval-preview[data-preview="ready"] img')?.naturalWidth>0`), 'the card image loaded');
  const shown = await ui(`(()=>{const [first,second]=document.querySelectorAll('${web}'),figure=first.querySelector('.assistant-approval-preview'),image=figure.querySelector('img'),open=figure.querySelector('button');
    return {order:[...first.children].slice(0,3).map(child=>child.tagName),alt:image.alt,label:open.getAttribute('aria-label'),caption:figure.querySelector('figcaption').textContent,local:image.src.startsWith('blob:chrome-extension://'),
      width:image.naturalWidth,missing:second.querySelector('.assistant-approval-preview-missing')?.textContent,secondImage:!!second.querySelector('img')};})()`);
  check('a web card shows the image of what would be clicked under its title; one without an image says "Ingen bild kunde tas."', () => {
    assert.deepEqual(shown, { order: ['H3', 'FIGURE', 'P'], alt: 'Bild av det som klickas på shop.example', label: 'Förstora bilden: Bild av det som klickas på shop.example',
      caption: 'Så såg sidan ut när kortet skapades. Tryck för att förstora.', local: true, width: 560, missing: 'Ingen bild kunde tas.', secondImage: false });
  });
  await ui(`document.querySelector('${web} .assistant-approval-preview-open').click()`);
  await until(() => ui(`document.querySelector('${card} .assistant-approval-preview-dialog').open`), 'the enlarged image');
  const large = await ui(`(()=>{const dialog=document.querySelector('${card} .assistant-approval-preview-dialog'),image=dialog.querySelector('img'),rect=image.getBoundingClientRect();
    return {same:image.src===document.querySelector('${web} .assistant-approval-preview img').src,alt:image.alt,caption:dialog.querySelector('p').textContent,inside:rect.left>=0&&rect.right<=innerWidth,close:dialog.querySelector('button').textContent};})()`);
  await ui(`document.querySelector('${card} .assistant-approval-preview-dialog button').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-approval-preview-dialog').open`), 'Stäng closes the enlarged image');
  check('one tap enlarges the image in a dialog that fits the panel, and Stäng closes it', () => {
    assert.deepEqual(large, { same: true, alt: 'Bild av det som klickas på shop.example', caption: 'Bild av det som klickas på shop.example', inside: true, close: 'Stäng' });
  });
  const original = await ui('({width:innerWidth,height:innerHeight})');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: false }, panelSession);
  await ui(`document.querySelector('${web}').scrollIntoView({block:'start'})`);
  const narrow = await ui(`new Promise(resolve=>requestAnimationFrame(()=>{const card=document.querySelector('${web}').getBoundingClientRect(),image=document.querySelector('${web} .assistant-approval-preview img').getBoundingClientRect();resolve({page:document.documentElement.scrollWidth<=innerWidth,inside:image.left>=card.left&&image.right<=card.right,height:image.height>0&&image.height<=card.height});}))`);
  await rpc('Emulation.setDeviceMetricsOverride', { ...original, deviceScaleFactor: 1, mobile: false }, panelSession);
  check('at 320 px the image stays inside its card and the panel never scrolls sideways', () => assert.deepEqual(narrow, { page: true, inside: true, height: true }));
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'web-approval-card', toChat, [375], () => ui(`document.querySelector('${web}').scrollIntoView({block:'start'})`));
  if (artifactDir) {
    // The card alone at 375 px, for the report: messages left in the composer by earlier suites stay out of it.
    const viewport = await ui('({width:innerWidth,height:innerHeight})');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false }, panelSession);
    for (const scheme of ['light', 'dark']) {
      await ui(`(()=>{const select=document.querySelector('${card} [name="appearance-mode"]');select.value=${JSON.stringify(scheme)};select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${web}').scrollIntoView({block:'start'});})()`);
      await ui('new Promise(resolve=>setTimeout(resolve,300))');
      const box = await ui(`(()=>{const rect=document.querySelector('${web}').getBoundingClientRect();return {x:0,y:Math.max(0,rect.top-8),width:innerWidth,height:Math.min(innerHeight,rect.height+16)};})()`);
      const shot = await rpc('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } }, panelSession);
      writeFileSync(join(artifactDir, 'panel-shots', `web-approval-card-only-375-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await ui(`(()=>{const select=document.querySelector('${card} [name="appearance-mode"]');select.value='system';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await rpc('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, panelSession);
  }
  const fetched = await reads();
  await ui(`[...document.querySelectorAll('${web} button')].find(button=>button.textContent==='Godkänn').click()`);
  await until(() => ui(`document.querySelector('${web}').dataset.status==='applied' && document.querySelector('${web} .assistant-approval-preview[data-preview="ready"]')`), 'the approved card keeps its image');
  const after = await reads();
  check('Godkänn sends only the card ID, and the image is fetched once, not again on every redraw', () => { assert.equal(fetched, 1); assert.equal(after, fetched); });

  // Settings → Allmänt: the context menu is an optional permission asked for on the user's own click.
  await ui(`(()=>{const root=document.querySelector('${card}');if(root.querySelector('.assistant-workspace').dataset.surface!=='settings')root.querySelector('[data-view="settings"]').click();})()`);
  await until(async () => await surface() === 'settings', 'settings');
  await ui(`document.querySelector('${card} [data-settings-page="general"]').click()`);
  const row = `${card} .assistant-settings-page[data-page="general"] [data-section="context-menu"]`, toggle = `${row} [name="context-menu"]`;
  await until(() => ui(`!!document.querySelector('${row} .assistant-shortcut kbd')`), 'the Dela shortcut in Allmänt');
  const offered = await ui(`chrome.permissions.contains({permissions:['contextMenus']}).then(granted=>({checked:document.querySelector('${toggle}').checked,label:document.querySelector('${row} label').textContent,shortcut:document.querySelector('${row} .assistant-shortcut').textContent,granted}))`);
  check('Allmänt offers "Visa Tabai i högerklicksmenyn", off until the user turns it on, and names the Dela shortcut', () => {
    assert.deepEqual({ ...offered, shortcut: undefined }, { checked: false, label: 'Visa Tabai i högerklicksmenyn', shortcut: undefined, granted: false });
    assert.match(offered.shortcut, /^Kortkommando för Dela: (⌥⇧D|Alt\+Shift\+D)\. Det öppnar panelen och delar sidan du har framme\.$/);
  });
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings-context-menu', async () => {}, [375], () => ui(`document.querySelector('${row}').scrollIntoView({block:'center'})`));
  if (process.env.CCMCP_HEADLESS) {
    // Headless Chrome answers its own permission prompt; a headed run leaves the prompt to a person.
    const tap = () => rpc('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(toggle)}).click()`, userGesture: true }, panelSession);
    const menus = "Promise.all(['tabai-ask-selection','tabai-share-page','tabai-ask-link'].map(id=>chrome.contextMenus?chrome.contextMenus.update(id,{}).then(()=>true,()=>false):false))";
    await tap();
    await until(() => ui(`chrome.permissions.contains({permissions:['contextMenus']}).then(granted=>granted&&!document.querySelector(${JSON.stringify(toggle)}).disabled)`), 'the permission granted on the click');
    await until(async () => (await ui(menus)).every(Boolean), 'the worker created the three menu items');
    const on = await ui(`({checked:document.querySelector(${JSON.stringify(toggle)}).checked,status:document.querySelector('${row} .assistant-context-menu-status').textContent})`);
    await tap();
    await until(() => ui(`chrome.permissions.contains({permissions:['contextMenus']}).then(granted=>!granted&&!document.querySelector(${JSON.stringify(toggle)}).disabled)`), 'the permission removed');
    const off = await ui(`({checked:document.querySelector(${JSON.stringify(toggle)}).checked,status:document.querySelector('${row} .assistant-context-menu-status').textContent})`);
    check('the switch asks Chrome on the click, the worker then adds the menu, and turning it off removes the permission again', () => {
      assert.deepEqual(on, { checked: true, status: 'Tabai finns nu i högerklicksmenyn på webbsidor.' });
      assert.deepEqual(off, { checked: false, status: 'Tabai visas inte längre i högerklicksmenyn.' });
    });
  } else console.log('  - skipped: the context-menu switch asking Chrome, because only headless Chrome answers its own permission prompt (CCMCP_HEADLESS=1)');
  {
    // A panel that goes and comes back, as when its module drops out of one poll's list, leaves no
    // permission listener behind: the panel is disposed and built again while every listener added to
    // or removed from chrome.permissions is counted. The other assistant host is recreated, so the
    // fixture card keeps its state, and the cards are put back in their order afterwards.
    const other = await ui(`[...document.querySelectorAll('#personal-modules > [data-module-id]')].find(element=>element.dataset.moduleId!=='assistant-fixture'&&element.querySelector('.assistant-workspace'))?.dataset.moduleId ?? ''`);
    const order = await ui(`[...document.querySelectorAll('#personal-modules > [data-module-id]')].map(element=>element.dataset.moduleId)`);
    let counted;
    try {
      await ui(`(()=>{
        const send=chrome.runtime.sendMessage,count={added:0,removed:0},events=[chrome.permissions.onAdded,chrome.permissions.onRemoved],originals=events.map(event=>[event.addListener,event.removeListener]);
        events.forEach((event,index)=>{const [add,remove]=originals[index];event.addListener=function(...rest){count.added++;return add.apply(this,rest);};event.removeListener=function(...rest){count.removed++;return remove.apply(this,rest);};});
        let drop=true;
        const filter=function(message,...rest){const reply=send.call(chrome.runtime,message,...rest);
          return drop&&message?.command?.action==='modules'?Promise.resolve(reply).then(value=>{if(!value?.ok||!Array.isArray(value.result))return value;drop=false;return {...value,result:value.result.filter(module=>module.id!==${JSON.stringify(other)})};}):reply;};
        chrome.runtime.sendMessage=filter;
        window.__recreate={count,restore:()=>{chrome.runtime.sendMessage=send;events.forEach((event,index)=>{event.addListener=originals[index][0];event.removeListener=originals[index][1];});}};
        if(chrome.runtime.sendMessage!==filter||events.some((event,index)=>event.addListener===originals[index][0]||event.removeListener===originals[index][1]))throw new Error('the panel cannot be observed');
      })()`);
      await ui(`document.querySelector('#refresh').click()`);
      const gone = await until(() => ui(`!document.querySelector('[data-module-id="${other}"]')`), 'the other panel disposed').then(() => true, () => false);
      await ui(`document.querySelector('#refresh').click()`);
      const back = gone && await until(() => ui(`!!document.querySelector('[data-module-id="${other}"] .assistant-workspace [name="context-menu"]')`), 'the other panel built again').then(() => true, () => false);
      counted = { other: !!other, gone, back, ...await ui('({...window.__recreate.count})') };
    } finally {
      await ui(`window.__recreate?.restore();delete window.__recreate;(()=>{const root=document.getElementById('personal-modules');for(const id of ${JSON.stringify(order)}){const element=root.querySelector(':scope > [data-module-id="'+id+'"]');if(element)root.append(element);}})()`);
    }
    check('recreating a panel adds no permission listener: the switch on Allmänt removes its listeners with the panel', () => {
      assert.deepEqual(counted, { other: true, gone: true, back: true, added: 2, removed: 2 });
    });
  }
  await toChat();
}

/**
 * Hitta billigast: the quick choice fills the composer; the card lists the shops cheapest
 * first with the time the prices were read; Öppna opens an ordinary tab and Bevaka priset
 * gives the existing new-watch card, with the capacity warning when it applies. The card
 * stacks its rows at 320 px and is a table at 1440 px, in light and dark mode.
 */
export async function assistantCompareCardChecks({ ui, until, check, rpc, panelSession, artifactDir, base }) {
  const card = '[data-module-id="assistant-fixture"]', scope = `${card} .assistant-view-chat`, compare = `${scope} [data-compare]`;
  const command = input => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'correct', input } })})`);
  const status = () => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation: 'status', input: {} } })})`).then(reply => reply.result);
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  const surface = () => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface`);
  const toChat = async () => { if (await surface() !== 'chat') await ui(`document.querySelector('${card} [data-view="settings"]').click()`); await until(async () => await surface() === 'chat', 'the chat'); };
  const tap = (index, label) => ui(`[...document.querySelectorAll('${compare} tbody tr')][${index}].querySelector(${JSON.stringify(`button[aria-label^="${label}"]`)}).click()`);
  await toChat();
  await command({ action: 'chat-new' }); await refresh();
  await until(() => ui(`!document.querySelector('${scope} .assistant-chat-empty').hidden`), 'an empty conversation');
  const quick = await ui(`[...document.querySelectorAll('${scope} .assistant-quick button')].map(button=>button.textContent)`);
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'chat-quick', toChat, [375]);
  await ui(`[...document.querySelectorAll('${scope} .assistant-quick button')].find(button=>button.textContent==='Hitta billigast').click()`);
  const filled = await ui(`(()=>{const input=document.querySelector('${scope} [name="chat-message"]');return {value:input.value,focused:document.activeElement===input,caret:input.selectionStart};})()`);
  check('"Hitta billigast" in the empty chat fills the composer with "Hitta billigast: "', () => {
    assert.deepEqual(quick, ['Kolla mina mejl', 'Min dag', 'Förbered möte', 'Sök och sammanfatta', 'Hitta billigast']);
    assert.deepEqual(filled, { value: 'Hitta billigast: ', focused: true, caret: 17 });
  });
  await ui(`(()=>{const input=document.querySelector('${scope} [name="chat-message"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);

  const readAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = [{ shop: 'Butik B', product: 'Laddkabel Typ 2, 5 m', price: 529, shipping: 0, currency: 'SEK', url: `${base}/butik-b` },
    { shop: 'Butik A', product: 'Laddkabel Typ 2 (5 meter)', price: 499, shipping: 49, currency: 'SEK', url: `${base}/butik-a` },
    { shop: 'Elbilsbutiken i Norrland', product: 'Laddkabel Mode 3 Typ 2 – 7,5 m, 22 kW, svart', price: 1249, currency: 'SEK', url: `${base}/butik-c` }];
  await command({ action: 'chat-fixture-compare', query: 'laddkabel typ 2', rows: JSON.stringify(rows), readAt }); await refresh();
  await until(() => ui(`!!document.querySelector('${compare}')`), 'the comparison card');
  const { assistant } = await status();
  const shown = await ui(`(()=>{const card=document.querySelector('${compare}');return {title:card.querySelector('h3').textContent,note:card.querySelector('.assistant-compare-note').textContent,
    author:card.closest('.assistant-chat-message').querySelector('.assistant-chat-author').classList.contains('visually-hidden'),
    rows:[...card.querySelectorAll('tbody tr')].map(row=>({shop:row.querySelector('.assistant-compare-shop').textContent,product:row.querySelector('.assistant-compare-product').textContent,
      price:row.querySelector('.assistant-compare-price').textContent,shipping:row.querySelector('.assistant-compare-shipping').textContent,total:row.querySelector('.assistant-compare-total').textContent,
      cheapest:row.dataset.cheapest==='true',badge:row.querySelector('.assistant-compare-badge')?.textContent??null,buttons:[...row.querySelectorAll('button')].map(button=>[button.textContent,button.getAttribute('aria-label')])})),
    footnote:card.querySelector('.assistant-compare-footnote')?.textContent,headers:[...card.querySelectorAll('thead th')].map(cell=>cell.textContent)};})()`);
  check('the card lists the shops cheapest first by price plus shipping, says when the prices were read, and offers Öppna and Bevaka priset on every row', () => {
    assert.equal(shown.title, 'Prisjämförelse: laddkabel typ 2');
    assert.equal(shown.note, `Priser lästa kl. ${clockIn(readAt, assistant.settings.timezone).replace('.', ':')}. Kontrollera i butiken innan du köper.`);
    assert.equal(shown.author, true, 'the card carries its own heading');
    assert.deepEqual(shown.headers, ['Butik', 'Pris', 'Frakt', 'Summa', 'Åtgärder']);
    assert.deepEqual(shown.rows.map(row => [row.shop, row.price, row.shipping, row.total, row.cheapest, row.badge]), [
      ['Butik B', '529 kr', 'Fri', '529 kr', true, 'Billigast'], ['Butik A', '499 kr', '49 kr', '548 kr', false, null], ['Elbilsbutiken i Norrland', '1\u00a0249 kr', 'Okänd', '1\u00a0249 kr', false, null]]);
    assert.deepEqual(shown.rows[0].buttons, [['Öppna', 'Öppna Butik B i en ny flik'], ['Bevaka priset', 'Bevaka priset hos Butik B']]);
    assert.equal(shown.footnote, 'Okänd frakt: frakten stod inte på butikens sida som lästes, så summan är bara priset.');
  });
  const original = await ui('({width:innerWidth,height:innerHeight})');
  const layout = async width => {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, panelSession);
    await ui(`document.querySelector('${compare}').scrollIntoView({block:'start'})`);
    return ui(`new Promise(resolve=>requestAnimationFrame(()=>{const card=document.querySelector('${compare}'),box=card.getBoundingClientRect(),rows=[...card.querySelectorAll('tbody tr')];
      resolve({page:document.documentElement.scrollWidth<=innerWidth,display:getComputedStyle(rows[0]).display,header:card.querySelector('thead').getBoundingClientRect().height>1,
        inside:[...card.querySelectorAll('tbody tr, tbody tr > *, button')].filter(element=>{const rect=element.getBoundingClientRect();return rect.left<box.left-0.5||rect.right>box.right+0.5;}).map(element=>element.tagName.toLowerCase()+'.'+element.className).join(', ')||true,
        targets:[...card.querySelectorAll('button')].every(button=>button.getBoundingClientRect().height>=44)});}))`);
  };
  const narrow = await layout(320), wide = await layout(1440);
  await rpc('Emulation.setDeviceMetricsOverride', { ...original, deviceScaleFactor: 1, mobile: false }, panelSession);
  check('at 320 px every shop stacks inside the card without sideways scroll; at 1440 px the card is a table with column headings; every button is at least 44 px', () => {
    assert.deepEqual(narrow, { page: true, display: 'grid', header: false, inside: true, targets: true });
    assert.deepEqual(wide, { page: true, display: 'table-row', header: true, inside: true, targets: true });
  });

  const panel = await ui('chrome.tabs.getCurrent().then(tab=>({tabId:tab.id,windowId:tab.windowId}))');
  await tap(0, 'Öppna');
  const opened = await until(() => ui(`chrome.tabs.query({}).then(tabs=>tabs.find(tab=>(tab.pendingUrl||tab.url)===${JSON.stringify(rows[0].url)}))`), 'Öppna opened the shop');
  await ui(`chrome.tabs.update(${panel.tabId},{active:true})`);
  await ui(`chrome.tabs.remove(${opened.id})`);
  await until(() => ui(`document.visibilityState==='visible'`), 'the panel is the active tab again');
  check('Öppna opens the shop in an ordinary tab of the panel\'s window, outside Tabai\'s tab groups and incognito', () => {
    assert.equal(opened.windowId, panel.windowId); assert.equal(opened.groupId, -1); assert.equal(opened.incognito, false); assert.equal(opened.active, true);
  });

  const watchCards = () => ui(`[...document.querySelectorAll('${scope} [data-watch-card]')].map(card=>({id:card.dataset.chatCardId,title:card.querySelector('h3').textContent,detail:card.querySelector('.module-summary').textContent,
    status:card.dataset.status,warning:card.querySelector('.assistant-card-warning')?.textContent??null,buttons:[...card.querySelectorAll('.assistant-actions button')].map(button=>button.textContent)}))`);
  // The button is busy from the tap until the host has answered.
  const answered = () => until(() => ui(`!document.querySelector('${compare} tbody tr button[aria-label^="Bevaka priset"]').disabled`), 'the tap answered');
  await tap(0, 'Bevaka priset'); await answered();
  await until(async () => (await watchCards()).length === 1, 'Bevaka priset gives a watch card');
  await tap(0, 'Bevaka priset'); await answered();
  await refresh();
  const first = await watchCards();
  check('Bevaka priset gives the existing new-watch card for the row: its page, "Säg till när priset är under 529 kr" and every six hours, waiting for Godkänn; a second tap adds none', () => {
    assert.equal(first.length, 1);
    assert.deepEqual({ ...first[0], id: undefined }, { id: undefined, title: 'Bevaka: Laddkabel Typ 2, 5 m hos Butik B', status: 'pending', warning: null, buttons: ['Godkänn', 'Avvisa'],
      detail: `Sida: ${base}/butik-b\nVillkor: Säg till när priset är under 529 kr\nSchema: var 6:e timme, 4 körningar per dygn.\nModell: Lokal · Qwen3.5 4B. Körs på den här datorn utan kostnad.` });
  });
  await command({ action: 'chat-fixture-watch-capacity' });
  await tap(1, 'Bevaka priset');
  await until(async () => (await watchCards()).length === 2, 'a second watch card');
  const warned = (await watchCards())[1];
  await command({ action: 'chat-fixture-watch-capacity' });
  check('with more runs an hour than Tabai starts, the card shows the existing capacity warning', () => {
    assert.equal(warned.title, 'Bevaka: Laddkabel Typ 2 (5 meter) hos Butik A'); assert.equal(warned.warning, ASSISTANT_WATCH_CAPACITY_WARNING);
  });
  await ui(`[...document.querySelector('${scope} [data-chat-card-id="${warned.id}"]').querySelectorAll('button')].find(button=>button.textContent==='Avvisa').click()`);
  await until(() => ui(`document.querySelector('${scope} [data-chat-card-id="${warned.id}"]').dataset.status==='dismissed'`), 'the warned card dismissed');
  await ui(`[...document.querySelector('${scope} [data-chat-card-id="${first[0].id}"]').querySelectorAll('button')].find(button=>button.textContent==='Godkänn').click()`);
  await until(() => ui(`document.querySelector('${scope} [data-chat-card-id="${first[0].id}"]').dataset.status==='applied'`), 'the watch card approved');
  const saved = (await status()).chat.watches.find(watch => watch.title === 'Laddkabel Typ 2, 5 m hos Butik B');
  const purchases = await ui(`document.querySelectorAll('${scope} [data-web-action]').length`);
  check('Godkänn saves the price watch as today, and the comparison never leads to a purchase card', () => {
    assert.deepEqual({ target: saved.target, condition: saved.condition, cadence: saved.cadence, enabled: saved.enabled }, { target: { url: `${base}/butik-b` }, condition: 'Säg till när priset är under 529 kr', cadence: { hours: 6 }, enabled: true });
    assert.equal(purchases, 0);
  });

  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'compare-card', toChat, [375, 768, 1440], () => ui(`document.querySelector('${compare}').scrollIntoView({block:'start'})`));
  if (artifactDir) {
    // The card alone at 375 px, for the report.
    const viewport = await ui('({width:innerWidth,height:innerHeight})');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false }, panelSession);
    for (const scheme of ['light', 'dark']) {
      await ui(`(()=>{const select=document.querySelector('${card} [name="appearance-mode"]');select.value=${JSON.stringify(scheme)};select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('${compare}').scrollIntoView({block:'start'});})()`);
      await ui('new Promise(resolve=>setTimeout(resolve,300))');
      const box = await ui(`(()=>{const rect=document.querySelector('${compare}').getBoundingClientRect();return {x:0,y:Math.max(0,rect.top-8),width:innerWidth,height:Math.min(innerHeight,rect.height+16)};})()`);
      const shot = await rpc('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } }, panelSession);
      writeFileSync(join(artifactDir, 'panel-shots', `compare-card-only-375-${scheme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await ui(`(()=>{const select=document.querySelector('${card} [name="appearance-mode"]');select.value='system';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await rpc('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, panelSession);
  }
}

/** Bevakningar: a fixed row in the conversation list with count, next run and a marker for a hit not yet seen. */
export async function assistantWatchEntryChecks({ ui, rpc, panelSession, until, check, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]', entry = `${card} .assistant-watch-entry`;
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const status = async () => (await command('status')).result;
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  const click = selector => ui(`document.querySelector(${JSON.stringify(`${card} ${selector}`)}).click()`);
  const surface = () => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface`);
  const show = async (view, page) => {
    const current = await surface();
    if (view === 'chat' && current !== 'chat') await click(current === 'settings' ? '[data-view="settings"]' : current === 'mail' ? '[data-view="mail"]' : '.assistant-back');
    if (view !== 'chat' && current !== view) await click(`[data-view="${view}"]`);
    if (page) await click(`[data-settings-page="${page}"]`);
    await until(async () => await surface() === view && (!page || await ui(`!document.querySelector('${card} .assistant-settings-page[data-page="${page}"]').hidden`)), `${view}${page ? ` → ${page}` : ''}`);
  };
  const setWeb = async level => {
    await show('settings', 'web');
    await ui(`(()=>{const e=document.querySelector('${card} [name="webLevel"]');e.value=${JSON.stringify(level)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => ui(`document.querySelector('${card} .assistant-workspace').getAttribute('aria-busy')==='false'`), 'panel ready before saving web access');
    await click('[data-settings-part="web"] button[type="submit"]');
    await until(async () => (await status()).assistant.settings.web?.level === level, `web access ${level}`);
  };
  const row = () => ui(`(()=>{const row=document.querySelector('${entry}');return {hidden:row.hidden,title:row.querySelector('.assistant-watch-entry-title').textContent,detail:row.querySelector('.assistant-watch-entry-detail').textContent,unseen:row.dataset.unseen,marker:!row.querySelector('.assistant-watch-marker').hidden,first:row.nextElementSibling?.classList.contains('assistant-conversation-list')};})()`);
  await show('chat');
  const empty = await row();
  await command('correct', { action: 'chat-fixture-watch-hit' }); await refresh();
  await until(async () => (await row()).unseen === 'true', 'a hit marks the row');
  const paused = await row();
  check('the Bevakningar row sits above the conversations, says Pausade while web access is off and marks an unseen hit', () => {
    assert.deepEqual({ hidden: empty.hidden, title: empty.title, detail: empty.detail, first: empty.first }, { hidden: false, title: 'Bevakningar', detail: 'Inga ännu', first: true });
    assert.equal(paused.detail, 'Pausade'); assert.equal(paused.marker, true);
  });
  await setWeb('read'); await show('chat');
  const { assistant, chat } = await status(), expected = `1 aktiv · nästa kl. ${clockIn(chat.watches[0].nextRunAt, assistant.settings.timezone)}`;
  await until(async () => (await row()).detail === expected, 'active count and next run');
  check('with web access on the row says "1 aktiv · nästa kl. HH.MM"', () => {});
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'chat-watch-entry', () => show('chat'), [768, 1440]);
  await click('.assistant-watch-entry');
  await until(async () => await surface() === 'watches' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Bevakningar' && !document.querySelector('${card} .assistant-view-watches').hidden`), 'one tap opens the list');
  const list = await ui(`(()=>{const view=document.querySelector('${card} .assistant-view-watches');return {rows:[...view.querySelectorAll('[data-watch-id]')].map(row=>[row.querySelector('h4').textContent,[...row.querySelectorAll('button')].map(button=>button.textContent)]),results:!!view.querySelector('[data-section="watches"] > button'),back:document.querySelector('${card} .assistant-back').getAttribute('aria-label')};})()`);
  check('one tap on the row opens the list with Kör nu, Pausa and Ta bort', () => {
    assert.deepEqual(list.rows, [['Syntetisk lagerstatus', ['Kör nu', 'Pausa', 'Ta bort']]]); assert.equal(list.results, true); assert.equal(list.back, 'Tillbaka till chatten');
  });
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'watches-list', async () => { if (await surface() !== 'watches') await click('.assistant-watch-entry'); await until(async () => await surface() === 'watches', 'list for screenshots'); }, [375, 1440]);
  await click('.assistant-back');
  await until(async () => await surface() === 'chat' && (await row()).unseen === 'false', 'the marker goes once the list was open');
  check('the marker disappears when the list has been opened', () => {});
  // A later hit marks the row again; the list opened from Inställningar clears it too.
  await command('correct', { action: 'watch-run', watchId: (await status()).chat.watches[0].id }); await refresh();
  await until(async () => (await row()).marker, 'a new hit marks the row again');
  await show('settings', 'watches');
  await ui(`[...document.querySelectorAll('${card} .assistant-watch-settings button')].find(button=>button.textContent==='Visa bevakningarna').click()`);
  await until(async () => await surface() === 'watches' && await ui(`document.querySelector('${card} .assistant-back').getAttribute('aria-label')==='Tillbaka till Inställningar'`), 'list from the settings');
  await click('.assistant-back');
  await until(async () => await surface() === 'settings' && await ui(`!document.querySelector('${card} .assistant-settings-page[data-page="watches"]').hidden`), 'back to Inställningar → Bevakningar');
  const settingsPage = await ui(`document.querySelector('${card} .assistant-settings-page[data-page="watches"]').textContent`);
  check('Inställningar → Bevakningar keeps the model and notices and links to the list', () => {
    assert.match(settingsPage, /Dina bevakningar[\s\S]*1 bevakning, 1 aktiv\.[\s\S]*Visa bevakningarna[\s\S]*Modell för bevakningar[\s\S]*Avisera mig när en bevakning slår till/);
  });
  await show('chat');
  assert.equal((await row()).unseen, 'false');
  await setWeb('off'); await show('chat');
  await until(async () => (await row()).detail === 'Pausade', 'paused again with web access off');
  await command('correct', { action: 'watch-delete', watchId: (await status()).chat.watches[0].id }); await refresh();
  await until(async () => (await row()).detail === 'Inga ännu' && (await row()).unseen === 'false', 'no watches left');
  check('the row follows the web setting and the watches that remain', () => {});
  // An unreadable watches.json is not "Inga ännu".
  await command('correct', { action: 'chat-fixture-watches-error' }); await refresh();
  await until(async () => (await row()).detail === 'Kunde inte läsas', 'the row says the watches could not be read');
  check('when watches.json cannot be read the row says "Kunde inte läsas", not "Inga ännu"', () => {});
  await command('correct', { action: 'chat-fixture-watches-error' }); await refresh();
  await until(async () => (await row()).detail === 'Inga ännu', 'readable again');
}

/**
 * Inställningar → Rutiner and the routine card: the empty list, a new routine with its
 * weekday, Kör nu with the answer in Rutiner, Pausa, Ändra tid with a draft that survives
 * a redraw, notices, the shared capacity warning and Ta bort. Synthetic fixture data only.
 */
export async function assistantRoutinePanelChecks({ ui, rpc, panelSession, until, check, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]', page = '.assistant-settings-page[data-page="routines"]', row = `${page} [data-routine-id]`, form = `${page} .assistant-routine-form`;
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const status = async () => (await command('status')).result;
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  const click = selector => ui(`document.querySelector(${JSON.stringify(`${card} ${selector}`)}).click()`);
  const clickText = (selector, label) => ui(`[...document.querySelectorAll(${JSON.stringify(`${card} ${selector}`)})].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  const type = (selector, value) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const surface = () => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface`);
  const visible = selector => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});return !!e&&!e.closest('[hidden]')&&e.getClientRects().length>0;})()`);
  const show = async (view, settingsPage) => {
    let current = await surface();
    if (current === 'watches' && view !== 'watches') { await click('.assistant-back'); await until(async () => (current = await surface()) !== 'watches', 'leave the list of watches'); }
    if (view === 'chat' && current !== 'chat') await click(current === 'settings' ? '[data-view="settings"]' : current === 'mail' ? '[data-view="mail"]' : '.assistant-back');
    if (view !== 'chat' && current !== view) await click(`[data-view="${view}"]`);
    if (settingsPage) await click(`[data-settings-page="${settingsPage}"]`);
    await until(async () => await surface() === view && (!settingsPage || await ui(`!document.querySelector('${card} .assistant-settings-page[data-page="${settingsPage}"]').hidden`)), `${view}${settingsPage ? ` → ${settingsPage}` : ''}`);
  };
  const rowInfo = () => ui(`(()=>{const row=document.querySelector(${JSON.stringify(`${card} ${row}`)});return {title:row.querySelector('h4').textContent,state:row.querySelector('.assistant-routine-state').textContent,what:row.querySelector('.assistant-routine-what').textContent,when:row.querySelector('.assistant-routine-when').textContent,outcome:row.querySelector('.assistant-routine-outcome')?.textContent??'',buttons:[...row.querySelectorAll(':scope > .assistant-actions button')].map(button=>button.textContent),shown:row.getClientRects().length>0};})()`);

  await show('settings');
  const entry = await ui(`document.querySelector('${card} [data-settings-page="routines"]').textContent`);
  await show('settings', 'routines');
  const empty = await ui(`(()=>{const root=document.querySelector('${card} ${page}');return {empty:root.querySelector('.assistant-empty')?.textContent,form:root.querySelector('.assistant-routine-form').hidden,results:[...root.querySelectorAll('.assistant-routine-tools button')].find(button=>button.textContent==='Visa svaren i samtalet Rutiner').hidden,notify:root.querySelector('[name="routine-notify"]').checked,title:document.querySelector('${card} .assistant-topbar-title').textContent};})()`);
  check('Inställningar → Rutiner starts empty, with Ny rutin and its notices on', () => {
    assert.match(entry, /^Rutiner[\s\S]*Frågor och uppdrag som körs på bestämda tider/);
    assert.deepEqual(empty, { empty: 'Inga rutiner ännu. Lägg till en med Ny rutin eller be om en i chatten.', form: true, results: true, notify: true, title: 'Rutiner' });
  });
  // The form: a task shows the tasks and the model's rules; a chat question takes a name, a question, a time and days.
  await clickText('.assistant-routine-tools button', 'Ny rutin');
  await until(() => visible(`${form} [name$="-title"]`), 'the new routine form');
  await click(`${form} input[type="radio"][value="task"]`);
  const asTask = await ui(`(()=>{const form=document.querySelector(${JSON.stringify(`${card} ${form}`)});return {prompt:form.querySelector('[data-routine-field="prompt"]').hidden,task:form.querySelector('[data-routine-field="task"]').hidden,options:[...form.querySelectorAll('select[name="routine-task"] option')].map(option=>[option.textContent,option.parentElement.tagName==='OPTGROUP'?option.parentElement.label:'']),note:form.querySelector('.assistant-routine-note').textContent};})()`);
  await click(`${form} input[type="radio"][value="chat"]`);
  await type(`${form} [name$="-title"]`, 'Syntetisk fredagsfråga');
  await type(`${form} textarea`, 'Vad hände i veckan?');
  await type(`${form} input[type="time"]`, '16:00');
  await click(`${form} [data-routine-day="5"]`);
  const asChat = await ui(`(()=>{const form=document.querySelector(${JSON.stringify(`${card} ${form}`)});return {note:form.querySelector('.assistant-routine-note').textContent,days:[...form.querySelectorAll('[data-routine-day]')].map(input=>[input.parentElement.textContent,input.checked]),hint:form.querySelector('.assistant-routine-days .muted').textContent};})()`);
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings-routine-form', () => show('settings', 'routines'), [375, 1440]);
  await click(`${form} button[type="submit"]`);
  await until(async () => (await status()).chat.routines?.length === 1 && await ui(`!!document.querySelector(${JSON.stringify(`${card} ${row}`)}) && document.querySelector(${JSON.stringify(`${card} ${form}`)}).hidden`), 'routine saved');
  const saved = (await status()).chat.routines[0], listed = await rowInfo();
  check('a new routine is saved from the form and listed with its question, day, time and actions', () => {
    assert.deepEqual([asTask.prompt, asTask.task], [true, false]); assert.deepEqual(asTask.options.slice(0, 4), [['Kolla mejl', ''], ['Min dag', ''], ['Förbered möte', ''], ['Följ upp', '']]);
    assert(asTask.options.slice(4).every(([, group]) => group === 'Dina snabbknappar'), 'the user\'s own shortcuts follow, in their own group');
    assert.match(asTask.note, /^Startar uppdraget med uppdragsmodellen, [^,]+ · [^,]+, och med uppdragens egna regler för mejl och webb\./, 'the task model, whichever is chosen');
    assert.match(asChat.note, /^Svarar med chattmodellen, .+ · .+\. (?:Körs på den här datorn|Varje körning) .+\. Läser högst på webben, och bara när webbåtkomsten är på\.$/, `the chat model and what a run costs: ${asChat.note}`);
    assert.deepEqual(asChat.days, [['Mån', false], ['Tis', false], ['Ons', false], ['Tor', false], ['Fre', true], ['Lör', false], ['Sön', false]]); assert.equal(asChat.hint, 'Välj inga dagar för varje dag.');
    assert.deepEqual([saved.kind, saved.title, saved.prompt, saved.schedule], ['chat', 'Syntetisk fredagsfråga', 'Vad hände i veckan?', { time: '16:00', days: [5] }]);
    assert.deepEqual({ ...listed, when: listed.when.replace(/ · Nästa: .*$/, '') }, { title: 'Syntetisk fredagsfråga', state: 'Aktiv', what: 'Fråga: Vad hände i veckan?', when: 'Varje fredag kl. 16:00', outcome: '', buttons: ['Kör nu', 'Pausa', 'Ändra tid', 'Ta bort'], shown: true });
    assert.match(listed.when, / · Nästa: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  // Kör nu: the answer is in Rutiner, which the list opens.
  await clickText(`${row} button`, 'Kör nu');
  await until(async () => (await rowInfo()).outcome.startsWith('Klar · ') && await visible(`${page} .assistant-routine-tools button:last-child`), 'routine ran');
  await clickText('.assistant-routine-tools button', 'Visa svaren i samtalet Rutiner');
  await until(async () => await surface() === 'chat' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Rutiner'`), 'Rutiner conversation');
  const answer = await ui(`[...document.querySelectorAll('${card} .assistant-view-chat .assistant-chat-assistant .assistant-chat-text')].at(-1).textContent`);
  check('Kör nu answers in the conversation Rutiner, headed with the routine', () => assert.equal(answer, 'Rutin: Syntetisk fredagsfråga\nSyntetiskt svar: veckan var lugn.'));
  // Pausa and Återuppta; Ändra tid with a draft that survives the list being redrawn.
  await show('settings', 'routines');
  await clickText(`${row} button`, 'Pausa');
  await until(async () => (await rowInfo()).state === 'Pausad' && (await rowInfo()).buttons[1] === 'Återuppta', 'routine paused');
  const paused = await rowInfo();
  await clickText(`${row} button`, 'Återuppta');
  await until(async () => (await rowInfo()).state === 'Aktiv', 'routine resumed');
  await clickText(`${row} button`, 'Ändra tid');
  await until(() => visible(`${row} .assistant-routine-editor`), 'time editor');
  const editor = `${row} .assistant-routine-editor`;
  const opened = await ui(`(()=>{const editor=document.querySelector(${JSON.stringify(`${card} ${editor}`)});return {time:editor.querySelector('input[type="time"]').value,days:[...editor.querySelectorAll('[data-routine-day]')].filter(input=>input.checked).map(input=>input.value),focused:document.activeElement===editor.querySelector('input[type="time"]')};})()`);
  await type(`${editor} input[type="time"]`, '09:15');
  // The editor is drawn anew when the routine changes; the new one must carry the draft.
  await ui(`document.querySelector(${JSON.stringify(`${card} ${editor}`)}).dataset.stale='true'`);
  await command('correct', { action: 'routine-run', routineId: saved.id }); await refresh();
  await until(() => ui(`(()=>{const editor=document.querySelector(${JSON.stringify(`${card} ${editor}`)});return !!editor&&!editor.dataset.stale&&editor.querySelector('input[type="time"]').value==='09:15';})()`), 'draft after a redraw');
  await type(`${editor} input[type="time"]`, '07:30');
  for (const day of ['1', '2', '3', '4']) await click(`${editor} [data-routine-day="${day}"]`);
  await clickText(`${editor} button`, 'Spara tiden');
  await until(async () => JSON.stringify((await status()).chat.routines[0].schedule) === JSON.stringify({ time: '07:30', days: [1, 2, 3, 4, 5] }) && !await visible(editor) && (await rowInfo()).when.startsWith('Vardagar kl. 07:30'), 'new time saved');
  check('Pausa, Återuppta and Ändra tid change only the routine, and a time draft survives a redraw', () => {
    assert.deepEqual([paused.state, paused.buttons], ['Pausad', ['Kör nu', 'Återuppta', 'Ändra tid', 'Ta bort']]);
    assert.deepEqual(opened, { time: '16:00', days: ['5'], focused: true });
  });
  // Notices: off through routine-notify; the shared capacity warning counts routines too.
  await click(`${page} [name="routine-notify"]`);
  await until(async () => (await status()).chat.routineNotifications === false, 'routine notices off');
  await command('correct', { action: 'routine-notify', enabled: 'true' }); await refresh();
  await until(() => ui(`document.querySelector(${JSON.stringify(`${card} ${page} [name="routine-notify"]`)}).checked`), 'routine notices on again');
  assert.equal(await visible(`${page} .assistant-routine-capacity`), false);
  await command('correct', { action: 'chat-fixture-watch-capacity' }); await refresh();
  await until(() => visible(`${page} .assistant-routine-capacity`), 'capacity warning on the routine page');
  const capacity = await ui(`document.querySelector(${JSON.stringify(`${card} ${page} .assistant-routine-capacity`)}).textContent`);
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings-routines', () => show('settings', 'routines'), [375, 768, 1440]);
  await command('correct', { action: 'chat-fixture-watch-capacity' }); await refresh();
  await until(async () => !await visible(`${page} .assistant-routine-capacity`), 'capacity warning gone');
  check('the routine page warns when watches and routines together need more than twelve runs an hour', () => assert.match(capacity, /^Dina aktiva bevakningar och rutiner behöver fler än 12 körningar i timmen\.[\s\S]*högst en bevakning eller rutin var femte minut/));
  // A routine proposed in the chat is a card like any other change, and Godkänn saves it.
  await show('chat');
  await command('correct', { action: 'chat-fixture-routine-card' }); await refresh();
  const routineCard = `${card} .assistant-view-chat [data-routine-card="routine-create"]`;
  await until(() => ui(`!!document.querySelector(${JSON.stringify(routineCard)})`), 'routine card in the chat');
  const proposal = await ui(`(()=>{const card=[...document.querySelectorAll(${JSON.stringify(routineCard)})].at(-1);return {title:card.querySelector('h3').textContent,detail:card.querySelector('.module-summary').textContent,buttons:[...card.querySelectorAll('.assistant-actions button')].map(button=>button.textContent)};})()`);
  await ui(`[...[...document.querySelectorAll(${JSON.stringify(routineCard)})].at(-1).querySelectorAll('button')].find(button=>button.textContent==='Spara rutinen').click()`);
  await until(async () => (await status()).chat.routines.length === 2 && await ui(`[...document.querySelectorAll(${JSON.stringify(routineCard)})].at(-1).dataset.status==='applied'`), 'routine card confirmed');
  check('a routine card shows the question, schedule, model and that it reads at most, and Spara rutinen saves it', () => {
    assert.equal(proposal.title, 'Ny rutin: Syntetisk veckosammanfattning');
    assert.match(proposal.detail, /^Fråga: [^\n]+\nSchema: varje fredag kl\. 16:00\.\nModell: [^\n]+\nRutinen svarar med chattmodellen i samtalet Rutiner\. Den läser högst på webben/);
    assert.deepEqual(proposal.buttons, ['Spara rutinen', 'Avvisa'], 'the button says what happens to the routine');
  });
  // Ta bort, after a confirmation, for both: the first is answered no before yes.
  await show('settings', 'routines');
  const removals = [];
  for (let remaining = 2; remaining > 0; remaining--) {
    const title = await ui(`document.querySelector(${JSON.stringify(`${card} ${row} h4`)}).textContent`);
    const remove = `[...document.querySelectorAll(${JSON.stringify(`${card} ${row} button`)})].find(button=>button.textContent==='Ta bort').click()`;
    removals.push({ title, ...remaining === 2 ? await declineThenConfirm({ ui, until }, remove, async () => (await status()).chat.routines) : (({ asked, missing }) => ({ accepted: asked, ...(missing ? { missing: [missing] } : {}) }))(await confirmClick(ui, remove, true)) });
    await until(async () => (await status()).chat.routines.length === remaining - 1 && await ui(`document.querySelectorAll(${JSON.stringify(`${card} ${row}`)}).length===${remaining - 1}`), `routine deleted, ${remaining - 1} left`);
  }
  check('Ta bort deletes a routine after a confirmation that names it, and answered no keeps it', () => {
    const question = title => `Ta bort rutinen ”${title}”? Tidigare svar finns kvar i samtalet Rutiner.`;
    assert.deepEqual(removals.map(entry => entry.title).sort(), ['Syntetisk fredagsfråga', 'Syntetisk veckosammanfattning']);
    assert.deepEqual(removals, [{ title: removals[0].title, declined: [question(removals[0].title)], startedOnNo: false, kept: true, accepted: [question(removals[0].title)] }, { title: removals[1].title, accepted: [question(removals[1].title)] }]);
  });
  await show('chat');
}
