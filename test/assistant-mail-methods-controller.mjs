import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantController } from '../dist/assistant-controller.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
const dir = mkdtempSync(join(tmpdir(), 'tabai-method-controller-'));
const executor = { async start(context, callbacks) { this.context = context; this.callbacks = callbacks; }, async stop() {}, async close() {}, async open() {} };
const controller = new AssistantController(process.cwd(), dir, executor);
const request = (operation, input = {}) => controller.request(operation, input);
const workspace = async () => (await request('status')).assistant;
const account = { id: 'mail', provider: 'gmail', label: 'Mail', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/?authuser=owner%40example.test', enabled: true };
const methodFile = join(dir, 'mail-methods.json');
const result = status => ({ summary: 'Kontroll avslutad.', findings: [], coverage: [{ accountId: account.id, status, message: 'Kontrollerat.' }] });
const report = (selection, status = 'verified') => ({ ...Object.fromEntries(['accountId', 'fingerprint', 'revision'].map(key => [key, selection[key]])),
  definition: selection.method?.definition ?? { steps: ['verify-account', 'read-incoming', 'read-sent', 'return-inbox'], expandThreads: false },
  ...(selection.method ? { usedId: selection.method.id } : {}), validated: status === 'verified',
  measurement: { at: new Date().toISOString(), status, mode: selection.method ? 'method' : 'learning', preparationCalls: 2, preparationMs: 30, folders: 1, reviewedThreads: 0 } });
const finish = async (status, reports) => { await executor.callbacks.finish(result(status), reports); await executor.callbacks.settled(); };
try {
  let view = await workspace();
  await request('correct', { action: 'settings', revision: String(view.revision), settings: JSON.stringify({ ...view.settings, accounts: [account] }) });
  await request('start', { task: 'check-mail' });
  assert.equal(executor.context.run.learnMail, false); assert.equal(executor.context.mailMethods, undefined);
  await finish('checked'); assert.equal(existsSync(methodFile), false);

  await request('correct', { action: 'mail-method', method: JSON.stringify({ action: 'learn', accountId: account.id }) });
  const selection = executor.context.mailMethods[0];
  assert.equal((await workspace()).settings.learnMail, true);
  const originalSave = controller.store.save.bind(controller.store);
  let resultPersisted = false;
  controller.store.save = async (name, data) => {
    if (data.workspace.current.coverage[0].status === 'checked') {
      assert.equal(existsSync(methodFile), false, 'no promotion before durable result'); resultPersisted = true;
    }
    return originalSave(name, data);
  };
  await finish('checked', [report(selection)]);
  controller.store.save = originalSave;
  assert.equal(resultPersisted, true);
  view = await workspace(); const active = view.mailMethods[0].active.id;
  assert.equal(view.mailMethods[0].history[0].status, 'verified');
  assert.equal(JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8')).state.workspace.current.coverage[0].status, 'checked');

  // An older panel omits the flag; saving unrelated settings preserves it.
  const { learnMail: omitted, ...older } = view.settings;
  await request('correct', { action: 'settings', revision: String(view.revision), settings: JSON.stringify(older) });
  assert.equal((await workspace()).settings.learnMail, true);
  await request('start', { task: 'check-mail' });
  assert.equal(executor.context.mailMethods[0].method.id, active, 'normal checks reuse saved method');
  await finish('partial', [report(executor.context.mailMethods[0])]);
  view = await workspace(); assert.equal(view.mailMethods[0].active.id, active); assert.equal(view.mailMethods[0].history[0].status, 'partial');

  await request('start', { task: 'check-mail' });
  await executor.callbacks.externalEffect();
  const beforeEffect = readFileSync(methodFile, 'utf8');
  await finish('checked', [report(executor.context.mailMethods[0])]);
  assert.equal(readFileSync(methodFile, 'utf8'), beforeEffect, 'effectful runs never learn');

  await request('start', { task: 'check-mail' });
  const late = executor.callbacks, lateReport = report(executor.context.mailMethods[0]);
  await request('stop'); const beforeStop = readFileSync(methodFile, 'utf8');
  await late.finish(result('checked'), [lateReport]); await late.settled();
  assert.equal(readFileSync(methodFile, 'utf8'), beforeStop, 'late finish cannot promote after stop');

  await request('start', { task: 'check-mail' });
  const beforeFailure = readFileSync(methodFile, 'utf8');
  controller.store.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(executor.callbacks.finish(result('checked'), [report(executor.context.mailMethods[0])]), /disk unavailable/);
  assert.equal(readFileSync(methodFile, 'utf8'), beforeFailure, 'failed result persistence cannot promote');
  controller.store.save = originalSave;
  await request('stop');
  view = await workspace();
  await request('correct', { action: 'mail-method', method: JSON.stringify({ action: 'save', accountId: account.id, revision: view.mailMethods[0].revision, definition: { ...view.mailMethods[0].active.definition, expandThreads: true } }) });
  await request('correct', { action: 'mail-method', method: JSON.stringify({ action: 'test', accountId: account.id }) });
  assert.notEqual(executor.context.mailMethods[0].method.id, active);
  await finish('checked', [report(executor.context.mailMethods[0])]);
  view = await workspace(); assert.equal(view.mailMethods[0].candidate, undefined); assert.notEqual(view.mailMethods[0].active.id, active);
  const schedule = { kind: 'schedule', enabled: false, time: '12:00', timezone: 'Europe/Stockholm', task: 'check-mail' };
  await controller.applyChatIntent({ ...schedule, learnMail: false }, '');
  assert.equal((await workspace()).settings.learnMail, false);
  await controller.applyChatIntent(schedule, '');
  assert.equal((await workspace()).settings.learnMail, false, 'omitted schedule choice preserves learning');
  await controller.applyChatIntent({ kind: 'routine-create', learnMail: true, routine: { kind: 'task', title: 'Kontroll', task: 'check-mail', schedule: { time: '12:00', days: [1] } } }, '');
  assert.equal((await workspace()).settings.learnMail, true);
  assert.equal(controller.routines.list[0].learnMail, undefined, 'routine uses shared choice rather than a copied preference');
  assert.equal(controller.mailMethodsForChat().mailMethods[0].verified, true);
  await controller.applyChatIntent({ kind: 'mail-learning', enabled: false }, '');
  assert.equal((await workspace()).settings.learnMail, false);
  console.log('Mail method controller: opt-in, shared reuse, durable promotion fence, old panels, partial/effect/stop/persist failures and candidate trial passed');
} finally { await controller.close(); rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
