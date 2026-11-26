import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(directory, { recursive: true, force: true }));
const directory = mkdtempSync(join(tmpdir(), 'tabai-conversations-'));
const bundled = await build({ entryPoints: ['src/assistant-conversations.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
const { AssistantConversations } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const now = new Date().toISOString();
const message = text => ({ id: randomUUID(), role: 'user', text, createdAt: now, status: 'complete' });
const snapshot = dir => JSON.parse(readFileSync(join(dir, 'chat.json'), 'utf8')).chat;
try {
  const legacyDir = join(directory, 'legacy'); mkdirSync(legacyDir);
  const legacy = { version: 1, id: randomUUID(), messages: [message('En tidigare fråga')] };
  const original = JSON.stringify({ chat: legacy }); writeFileSync(join(legacyDir, 'chat.json'), original);
  const conversations = new AssistantConversations(legacyDir); await conversations.ready();
  assert.equal(conversations.selected.id, legacy.id);
  assert.deepEqual(conversations.selected.messages, legacy.messages);
  assert.equal(readFileSync(join(legacyDir, 'chat.json'), 'utf8'), original, 'migration stays read-only until first change');
  await conversations.rename(legacy.id, 'Sparat sammanhang');
  assert.equal(snapshot(legacyDir).version, 2);
  assert.equal(readFileSync(join(legacyDir, 'chat.json.bak'), 'utf8'), original, 'first v2 write backs up exact v1 bytes');
  const second = await conversations.create('Ett eget samtal');
  await conversations.edit(second, conversation => { conversation.messages.push(message('Andra ämnet')); });
  await conversations.select(legacy.id);
  assert.equal(conversations.selected.title, 'Sparat sammanhang');
  assert.equal(conversations.selected.messages.length, 1, 'conversation selection never merges histories');
  await assert.rejects(conversations.select(randomUUID()), /finns inte/);
  await assert.rejects(conversations.rename(legacy.id, ' '));

  await conversations.saveMemory({ label: 'Språk', value: 'Svenska', scope: 'general' });
  const memory = conversations.memories[0];
  const detached = conversations.memories; detached[0].value = 'Utsidan';
  assert.equal(conversations.memories[0].value, 'Svenska');
  await conversations.saveMemory({ label: 'språk', value: 'Svenska, kortfattat', scope: 'general' });
  assert.equal(conversations.memories.length, 1, 'same label/scope updates the existing private fact');
  assert.equal(conversations.memories[0].id, memory.id);
  await conversations.saveMemory({ id: memory.id, label: 'Språk', value: 'Svenska', scope: 'general' });
  await assert.rejects(conversations.saveMemory({ label: 'API-nyckel', value: 'synthetic', scope: 'general' }), /Hemligheter/);
  await assert.rejects(conversations.saveMemory({ label: 'Min uppgift', value: `sk-${'x'.repeat(32)}`, scope: 'general' }), /Hemligheter/);
  await assert.rejects(conversations.saveMemory({ label: 'Modul', value: 'Uppgift', scope: 'module' }), /Välj vilken/);
  await conversations.deleteMemory(memory.id);
  assert.equal(snapshot(legacyDir).memories.length, 0);
  assert.equal(snapshot(legacyDir).conversations.length, 2);
  assert.equal(JSON.parse(readFileSync(join(legacyDir, 'chat.json.bak'), 'utf8')).chat.memories.length, 0, 'deleted memories also leave immediate backup');
  await conversations.scheduleFor(second);
  assert.equal(conversations.scheduleConversationId, second);
  await conversations.remove(second);
  assert.equal(conversations.scheduleConversationId, undefined);
  assert.equal(readFileSync(join(legacyDir, 'chat.json.bak'), 'utf8').includes('Andra ämnet'), false, 'deleted conversation is absent from immediate backup');
  assert.equal(conversations.selected.id, legacy.id);
  await conversations.remove(legacy.id);
  assert.equal(conversations.conversations.length, 1, 'deleting last conversation leaves a usable empty one');
  assert.equal(conversations.selected.messages.length, 0);

  const restartDir = join(directory, 'restart');
  const pending = new AssistantConversations(restartDir);
  await pending.edit(pending.selected.id, conversation => {
    conversation.messages.push({ ...message(''), role: 'assistant', status: 'pending' }, {
      ...message(''), role: 'system', card: { id: randomUUID(), title: 'Spara uppgift', detail: 'Test', status: 'applying', intent: { kind: 'memory', label: 'Färg', value: 'Blå', scope: 'general' } },
    });
  });
  const restarted = new AssistantConversations(restartDir); await restarted.ready();
  assert.equal(restarted.selected.messages[0].status, 'interrupted');
  assert.equal(restarted.selected.messages[1].card.status, 'uncertain');
  assert.equal(restarted.memories.length, 0, 'restart never reapplies an uncertain action');
  assert.equal(snapshot(restartDir).conversations[0].messages[1].card.status, 'uncertain');

  const bounds = new AssistantConversations(join(directory, 'bounds'));
  await bounds.edit(bounds.selected.id, conversation => { conversation.messages = Array.from({ length: 20 }, () => message('x'.repeat(16000))); });
  const before = JSON.stringify(bounds.selected);
  await assert.rejects(bounds.edit(bounds.selected.id, conversation => { conversation.messages.push(...Array.from({ length: 10 }, () => message('x'.repeat(16000)))); }), /Samtalet är fullt/);
  assert.equal(JSON.stringify(bounds.selected), before, 'oversized writes are atomic and preserve previous state');
  await assert.rejects(bounds.change(state => { state.conversations = Array.from({ length: 101 }, () => ({ ...structuredClone(state.conversations[0]), id: randomUUID() })); }));
  await assert.rejects(bounds.change(state => {
    const first = state.conversations[0];
    state.conversations = Array.from({ length: 24 }, (_, index) => ({ ...structuredClone(first), id: index ? randomUUID() : first.id }));
  }), /Samtalsarkivet är fullt/);
  await Promise.all([bounds.rename(bounds.selected.id, 'Namn'), bounds.saveMemory({ label: 'Samtidig', value: 'Sparas också', scope: 'general' })]);
  assert.equal(bounds.selected.title, 'Namn'); assert.equal(bounds.memories.length, 1, 'serialized changes preserve both operations');

  const corruptDir = join(directory, 'corrupt'); mkdirSync(corruptDir); writeFileSync(join(corruptDir, 'chat.json'), '{broken');
  const corrupt = new AssistantConversations(corruptDir); await corrupt.ready();
  assert.ok(corrupt.unavailable);
  await assert.rejects(corrupt.create(), /kunde inte läsas/);
  assert.equal(readFileSync(join(corruptDir, 'chat.json'), 'utf8'), '{broken', 'unreadable originals are preserved');
  console.log('assistant-conversations: legacy backup, isolated CRUD, serialized memory, deletion, restart fences and atomic size limits passed');
} finally { rmSync(directory, { recursive: true, force: true }); stopWatchdog(); }
