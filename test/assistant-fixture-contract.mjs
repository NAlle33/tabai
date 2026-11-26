import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PersonalModules } from '../dist/personal-modules.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => { modules.close(); rmSync(dir, { recursive: true, force: true }); });
const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'tabai-assistant-fixture-'));
writeFileSync(join(dir, 'personal-modules.json'), JSON.stringify([{ id: 'assistant-fixture', command: process.execPath, args: [join(root, 'test/assistant-panel-live.mjs'), '--fixture', join(dir, 'fixture.json')], cwd: root }]));
const modules = new PersonalModules(dir);
try {
  const initial = (await modules.request('assistant-fixture', 'status', {})).assistant;
  assert(initial); assert(!('feedbackEvents' in initial)); assert(!('openedWork' in initial));
  await modules.request('assistant-fixture', 'correct', { action: 'settings', revision: String(initial.revision), settings: JSON.stringify({ ...initial.settings, accounts: [{ id: 'fixture-gmail', provider: 'gmail', label: 'Test', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true }] }) });
  let view = await modules.request('assistant-fixture', 'start', { task: 'check-mail' });
  for (const [id, kind] of [['fixture-no-reply', 'no-reply'], ['fixture-priority', 'prioritize-sender'], ['fixture-shorter', 'shorter']]) {
    const item = view.assistant.items.find(item => item.id === id);
    view = await modules.request('assistant-fixture', 'correct', { action: 'feedback', kind, itemId: id, revision: String(item.revision) });
  }
  view = await modules.request('assistant-fixture', 'start', { task: 'follow-ups-help' });
  assert.equal(view.assistant.current.task, 'follow-ups'); assert.equal(view.assistant.current.status, 'waiting');
  view = await modules.request('assistant-fixture', 'start', { task: 'check-mail-running' });
  assert.equal(view.assistant.current.task, 'check-mail'); assert.equal(view.assistant.current.status, 'running');
  view = await modules.request('assistant-fixture', 'history', { action: 'fixture-threads', threads: '5' });
  assert.equal(view.assistant.current.activity.reviewedThreads, 5, 'the live suite moves a running check forward one poll at a time');
  await modules.request('assistant-fixture', 'open', { work: 'true' });
  const meta = await modules.request('assistant-fixture', 'history', { action: 'fixture-state' });
  assert.equal(JSON.parse(meta.description).feedbackEvents.length, 3); assert.equal(JSON.parse(meta.description).openedWork, true);
  await modules.request('assistant-fixture', 'correct', { action: 'chat-send', conversationId: meta.chat.id, messageId: randomUUID(), message: 'Syntetiskt underlag.' });
  const listed = await modules.request('assistant-fixture', 'correct', { action: 'chat-fixture-features' });
  assert.deepEqual(listed.chat.messages.at(-1).lists.map(list => list.rows.length), [2, 1]);
  await modules.request('assistant-fixture', 'correct', { action: 'chat-fixture-features-clear' });
  console.log('Assistant fixture: real module transport validates setup, feedback, help and test-only metadata separation');
} finally { modules.close(); rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
