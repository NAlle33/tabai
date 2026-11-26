// Mina uppgifter: private form details with no cards, passwords or keys; the
// panel's save and clear; and chat_profile, which only the act level offers and
// which the user sees as web activity.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantProfileStore, assistantContainsCardNumber, validateAssistantProfile } from '../dist/assistant-profile.mjs';
import { AssistantController } from '../dist/assistant-controller.mjs';
import { assistantWorkerToolNames } from '../dist/assistant-tools.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(async () => { for (const controller of controllers) await controller.close().catch(() => {}); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const dirs = [], controllers = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'tabai-profile-')); dirs.push(dir); return dir; };
const valid = { name: 'Kim Svensson', street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm', country: 'Sverige', phone: '+46 70 123 45 67', email: 'kim@example.se', extra: [{ label: 'Kundnummer', value: '12345678' }] };
try {
  // Cards: one printed run of 13–19 digits that passes Luhn.
  for (const card of ['4111 1111 1111 1111', '4111-1111-1111-1111', '5555555555554444', '378282246310005', 'kort 4012888888881881 tack']) assert.equal(assistantContainsCardNumber(card), true, card);
  for (const other of ['4111 1111 1111 1112', '+46 70 123 45 67', '111 22', '12345678', '2026-11-02', '1234567812345678']) assert.equal(assistantContainsCardNumber(other), false, other);

  assert.deepEqual(validateAssistantProfile(valid), valid);
  assert.deepEqual(validateAssistantProfile({ name: '  Kim   Svensson ', extra: [{ label: '', value: '' }] }), { name: 'Kim Svensson', extra: [] }, 'whitespace is tidied and empty rows dropped');
  const refused = [
    [{ street: 'Kort 4111 1111 1111 1111' }, /kortnummer sparas aldrig/],
    [{ extra: [{ label: 'Betalning', value: '5555 5555 5555 4444' }] }, /kortnummer sparas aldrig/],
    [{ extra: [{ label: 'Lösenord', value: 'hemligt123' }] }, /lösenord, koder och nycklar/],
    [{ extra: [{ label: 'PIN', value: '1234' }] }, /lösenord, koder och nycklar/],
    [{ extra: [{ label: 'API-nyckel', value: 'abc' }] }, /lösenord, koder och nycklar/],
    [{ extra: [{ label: 'Övrigt', value: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV' }] }, /lösenord, koder och nycklar/],
    [{ extra: [{ label: 'Övrigt', value: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4' }] }, /lösenord, koder och nycklar/],
    [{ extra: [{ label: 'Övrigt', value: 'Bearer abcdefghijklmnopqrstuvwxyz123' }] }, /lösenord, koder och nycklar/],
    [{ email: 'inte en adress' }, /giltig e-postadress/],
    [{ phone: '12' }, /6–15 siffror/],
    [{ phone: 'ring mig' }, /6–15 siffror/],
    [{ extra: [{ label: 'Etikett', value: '' }] }, /både en etikett och ett värde/],
    [{ extra: Array.from({ length: 7 }, (_, index) => ({ label: `Fält ${index}`, value: 'x' })) }, /högst sex/],
  ];
  for (const [input, pattern] of refused) assert.throws(() => validateAssistantProfile(input), pattern, JSON.stringify(input));
  assert.throws(() => validateAssistantProfile({ unknown: 'x' }), 'unknown fields are refused');
  assert.throws(() => validateAssistantProfile({ extra: [{ label: 'Övrigt', value: 'min-sparade-nyckel' }] }, text => { if (text.includes('min-sparade-nyckel')) throw new Error('API-nyckeln får inte sparas i samtal eller minne.'); }), /API-nyckeln/);

  // The private store: saving and clearing also overwrite the backup copy.
  {
    const dir = fresh(), store = new AssistantProfileStore(dir);
    assert.equal(store.profile, undefined);
    const saved = await store.save(valid, new Date('2026-11-02T20:00:00.000Z'));
    assert.equal(saved.updatedAt, '2026-11-02T20:00:00.000Z'); assert.equal(new AssistantProfileStore(dir).profile.city, 'Stockholm');
    await store.save({ ...valid, street: 'Nygatan 2' });
    assert.doesNotMatch(readFileSync(join(dir, 'profile.json.bak'), 'utf8'), /Storgatan/, 'an old address does not linger in the backup');
    await store.clear();
    assert.equal(new AssistantProfileStore(dir).profile, undefined);
    assert.doesNotMatch(readFileSync(join(dir, 'profile.json'), 'utf8') + (existsSync(join(dir, 'profile.json.bak')) ? readFileSync(join(dir, 'profile.json.bak'), 'utf8') : ''), /Kim|Nygatan|kim@example/, 'clearing leaves no copy');
    assert.equal(await store.save({ name: ' ', extra: [] }), undefined, 'an empty form saves nothing');
  }

  // The panel's actions and view, and chat_profile through the chat.
  const dir = fresh();
  const chatExecutor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
  const watchExecutor = { async start() {}, async stop() {}, async close() {} };
  const workflow = { async start() {}, async stop() {}, async close() {}, async open() {} };
  const controller = new AssistantController(process.cwd(), dir, workflow, { chatExecutor, watchExecutor }); controllers.push(controller);
  const request = (operation, input = {}) => controller.request(operation, input);
  assert.equal((await request('status')).chat.profile, undefined);
  await request('correct', { action: 'profile-save', name: valid.name, street: valid.street, postalCode: valid.postalCode, city: valid.city, country: valid.country, phone: valid.phone, email: valid.email, extra: JSON.stringify(valid.extra) });
  let profile = (await request('status')).chat.profile;
  assert.equal(profile.name, 'Kim Svensson'); assert.deepEqual(profile.extra, valid.extra); assert.match(profile.updatedAt, /^\d{4}-/);
  await assert.rejects(request('correct', { action: 'profile-save', name: 'Kim', extra: JSON.stringify([{ label: 'Kort', value: '4111 1111 1111 1111' }]) }), /kortnummer/);
  assert.equal((await request('status')).chat.profile.street, 'Storgatan 1', 'a refused save changes nothing');
  await assert.rejects(request('correct', { action: 'profile-save', extra: '{' }), /fel format/);
  await request('correct', { action: 'berget-key', key: 'berget-test-key-DEMO' });
  await assert.rejects(request('correct', { action: 'profile-save', name: 'Kim', extra: JSON.stringify([{ label: 'Övrigt', value: 'berget-test-key-DEMO' }]) }), /API-nyckeln/, 'the saved Berget key is never a detail');
  // chat_profile: the details reach the model only when it calls the tool, and only on act.
  const current = (await request('status')).assistant;
  await request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, web: { level: 'act', login: false } }) });
  await request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Fyll i leveransformuläret på shop.example' });
  const turn = chatExecutor.starts.at(-1);
  assert.equal(JSON.stringify(turn.context).includes('Storgatan'), false, 'the details are not in the turn context');
  const read = await turn.callbacks.chatProfile();
  assert.equal(read.profile.street, 'Storgatan 1'); assert.match(read.note, /bara i formuläret/);
  await turn.callbacks.chatReply('Klart.');
  assert(assistantWorkerToolNames(true, 'act').includes('chat_profile') && !assistantWorkerToolNames(true, 'read').includes('chat_profile') && !assistantWorkerToolNames(false, 'act').includes('chat_profile'), 'only the act level offers the tool');
  await request('correct', { action: 'profile-clear' });
  assert.equal((await request('status')).chat.profile, undefined);
  await request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Fyll i formuläret igen' });
  const empty = await chatExecutor.starts.at(-1).callbacks.chatProfile();
  assert.equal(empty.profile, null); assert.match(empty.note, /Fråga användaren/);
  console.log('assistant-profile: Luhn and key refusals, email and phone shapes, backup-purging store, panel save and clear, and chat_profile only on act passed');
} finally {
  for (const controller of controllers) await controller.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
