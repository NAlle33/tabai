import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog();
const saved = {}, alerts = [], badges = [];
let granted = false, failReceipt = false;
globalThis.chrome = {
  action: { async setBadgeBackgroundColor() {}, async setBadgeText(value) { badges.push(value.text); }, async setTitle() {} },
  runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  permissions: { async contains() { return granted; }, onAdded: { addListener() {} } },
  notifications: { onClicked: { addListener() {} }, async create(id, value) { alerts.push({ id, value }); if (failReceipt) throw new Error('Uncertain receipt'); } },
  storage: { local: { async get(key) { return { [key]: saved[key] }; }, async set(value) { Object.assign(saved, value); } } },
};
try {
  const source = await build({ entryPoints: ['extension/src/assistant-notifications.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const load = async suffix => import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}#${suffix}`);
  const { handleAssistantNotice } = await load('first');
  const notice = { id: 'a'.repeat(64), count: 2, critical: 1, desktop: true };
  await handleAssistantNotice(notice); assert.equal(alerts.length, 0); assert.equal(badges.at(-1), '2');
  granted = true;
  await Promise.all([handleAssistantNotice(notice), handleAssistantNotice(notice)]); assert.equal(alerts.length, 1, 'concurrent duplicate alerts are reserved once');
  assert(!JSON.stringify(alerts).includes('@'), 'OS notification payload contains counts, no mailbox address');
  failReceipt = true;
  await assert.rejects(handleAssistantNotice({ ...notice, id: 'b'.repeat(64) }), /Uncertain/);
  await handleAssistantNotice({ ...notice, id: 'b'.repeat(64) }); assert.equal(alerts.length, 2, 'an uncertain dispatch is never replayed');
  failReceipt = false;
  await (await load('restart')).handleAssistantNotice(notice); assert.equal(alerts.length, 2, 'delivery reservations survive worker restart');
  await handleAssistantNotice({ ...notice, count: 0, critical: 0, desktop: false }); assert.equal(badges.at(-1), '');
  await handleAssistantNotice({ ...notice, id: 'invalid', count: -1 }); assert.equal(alerts.length, 2);
  // A watch hit and an automatic pause have their own fixed texts; neither carries a watch title or page text.
  await handleAssistantNotice({ ...notice, id: 'c'.repeat(64), kind: 'watch' });
  assert.deepEqual([alerts.at(-1).value.title, alerts.at(-1).value.message], ['En bevakning har slagit till', 'Resultatet finns i samtalet Bevakningar i Tabai.']);
  await handleAssistantNotice({ ...notice, id: 'd'.repeat(64), kind: 'watch', watchEvent: 'paused' });
  assert.deepEqual([alerts.at(-1).value.title, alerts.at(-1).value.message], ['En bevakning har pausats', 'Den pausades efter tre misslyckade körningar i rad. Slå på den igen i listan Bevakningar i Tabai.']);
  await handleAssistantNotice({ ...notice, id: 'e'.repeat(64), kind: 'watch', watchEvent: 'paused', title: 'Sidans text' });
  assert.equal(alerts.length, 4, 'a notice with any other field is refused');
  // A routine's fixed texts carry only its own name, never its question or answer.
  await handleAssistantNotice({ ...notice, id: 'f'.repeat(64), kind: 'routine', routineTitle: 'Veckans elpris' });
  assert.deepEqual([alerts.at(-1).value.title, alerts.at(-1).value.message], ['Rutinen Veckans elpris är klar', 'Öppna Tabai för att se resultatet.']);
  await handleAssistantNotice({ ...notice, id: '1'.repeat(64), kind: 'routine', routineTitle: 'Veckans elpris', routineEvent: 'paused' });
  assert.deepEqual([alerts.at(-1).value.title, alerts.at(-1).value.message], ['En rutin har pausats', 'Rutinen Veckans elpris pausades efter tre misslyckade körningar i rad. Slå på den igen under Inställningar → Rutiner i Tabai.']);
  await handleAssistantNotice({ ...notice, id: '2'.repeat(64), kind: 'routine' });
  await handleAssistantNotice({ ...notice, id: '3'.repeat(64), kind: 'watch', routineTitle: 'Veckans elpris' });
  await handleAssistantNotice({ ...notice, id: '4'.repeat(64), kind: 'routine', routineTitle: 'Veckans elpris', watchEvent: 'paused' });
  await handleAssistantNotice({ ...notice, id: '5'.repeat(64), kind: 'routine', routineTitle: 'Veckans elpris', answer: 'Elpriset sjönk.' });
  assert.equal(alerts.length, 6, 'a routine notice names its routine, and routine and watch fields stay with their own kind');
  console.log('Assistant notifications: optional permission, counts-only payload, serialized durable deduplication, restart and ambiguous dispatch fences passed');
} finally { delete globalThis.chrome; stopWatchdog(); }
