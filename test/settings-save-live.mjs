import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { openCdpObserver } from './helpers/cdp-observer.mjs';
import { watchdog } from './watchdog.mjs';

const endpoint = new URL(process.argv[2]);
assert.equal(endpoint.hostname, '127.0.0.1');
const observer = await openCdpObserver(endpoint, { timeoutMs: 10000, timeoutMessage: method => `${method} timed out`, handshakeTimeout: 5000 });
let targetId;
const cleanup = async () => { if (targetId) await observer.rpc('Target.closeTarget', { targetId }).catch(() => {}); observer.socket.close(); };
const stop = watchdog(cleanup);
try {
  const { outputFiles } = await build({ stdin: { contents: "export {AssistantChatSettings} from './extension/src/assistant-chat-settings'; export {AssistantRoutineSettings} from './extension/src/assistant-routine-settings'; export {AssistantWatchSettings} from './extension/src/assistant-watch-settings';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SaveFixture' });
  ({ targetId } = await observer.rpc('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = await observer.rpc('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await observer.rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate(outputFiles[0].text);
  const checks = await evaluate(`(async () => {
    const checks = [], pending = [];
    const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
    const act = (_operation, input) => new Promise(resolve => pending.push({ input, resolve }));
    const finish = async value => { check(pending.length === 1, 'one save in flight'); pending.shift().resolve(value); await new Promise(resolve => setTimeout(resolve, 0)); };
    const input = (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
    const view = { model: 'codex:gpt-6.1-sol', berget: { configured: false, message: '' }, memories: [], connections: [], watchNotifications: false, routineNotifications: false };
    const chat = new SaveFixture.AssistantChatSettings(act);
    document.body.append(chat.memory, chat.budget, chat.connection);
    chat.update(view);
    const name = chat.memory.querySelector('[name="memory-label"]'), value = chat.memory.querySelector('[name="memory-value"]');
    input(name, 'Initial'); input(value, 'Sent value'); chat.memory.querySelector('form').requestSubmit();
    check(pending[0].input.value === 'Sent value', 'memory save sends its initial snapshot');
    input(value, 'Newer unsaved text'); await finish(true);
    check(value.value === 'Newer unsaved text' && /osparade/.test(chat.memory.textContent), 'memory edits survive an earlier save acknowledgement');
    chat.memory.querySelector('form').requestSubmit(); await finish(true);
    check(value.value === '', 'unchanged memory form clears after a successful save');
    const limit = chat.budget.querySelector('[name="berget-budget"]'); input(limit, '10'); chat.budget.querySelector('form').requestSubmit(); input(limit, '20'); await finish(true);
    chat.update({ ...view, budget: { limitEur: 10, period: 'test', message: '', settledEur: 0, reservedEur: 0, uncertainEur: 0, inputTokens: 0, outputTokens: 0, entries: [], prices: [] } });
    check(limit.value === '20' && chat.dirty('cost'), 'polling preserves budget edits made during save');
    const key = chat.connection.querySelector('[name="berget-api-key"]'); input(key, 'test-key-one'); chat.connection.querySelector('form').requestSubmit(); input(key, 'test-key-two'); await finish(true);
    check(key.value === 'test-key-two', 'new API key input survives the previous save');
    const routine = new SaveFixture.AssistantRoutineSettings(act, async () => true);
    document.body.append(routine.element); routine.element.querySelector('.assistant-routine-new').click();
    const form = routine.element.querySelector('.assistant-routine-form');
    input(form.querySelector('input[name$="-title"]'), 'Routine'); input(form.querySelector('textarea'), 'First question'); form.requestSubmit();
    input(form.querySelector('textarea'), 'New question'); await finish(true);
    check(!form.hidden && form.querySelector('textarea').value === 'New question' && /osparade/.test(form.textContent), 'routine save preserves newer form text');
    const watch = new SaveFixture.AssistantWatchSettings(act, () => {}); document.body.append(watch.element);
    // The host snapshot establishes the last saved settings, independently of the pending write.
    watch.update(view); routine.view = view;
    form.requestSubmit();
    const routineToggle = routine.element.querySelector('[name="routine-notify"]');
    routineToggle.checked = true; routineToggle.dispatchEvent(new Event('change', { bubbles: true }));
    check(pending.length === 2 && pending[1].input.action === 'routine-notify', 'notification changes persist during a routine save');
    pending.shift().resolve(true); await finish(false);
    check(!routineToggle.checked && /kunde inte sparas/.test(routine.element.textContent), 'concurrent routine save cannot hide notification failure');
    const model = watch.element.querySelector('select'), watchToggle = watch.element.querySelector('[name="watch-notify"]');
    model.dispatchEvent(new Event('change', { bubbles: true }));
    check(watchToggle.disabled, 'notification changes are disabled immediately during model save');
    watchToggle.click(); check(pending.length === 1 && !watchToggle.checked, 'a disabled notification toggle cannot show an unsaved change');
    await finish(true); check(!watchToggle.disabled, 'notification control reopens after model save');
    for (const [settings, name] of [[watch, 'watch-notify'], [routine, 'routine-notify']]) {
      const toggle = settings.element.querySelector('[name="' + name + '"]');
      toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true })); await finish(false);
      check(!toggle.checked && /kunde inte sparas/.test(settings.element.textContent), name + ' reports failed persistence and restores the saved value');
    }
    return checks;
  })()`);
  console.log(`Settings saves: ${checks.length} checks passed for pending edits and failed notification writes`);
} finally { stop(); await cleanup(); }
