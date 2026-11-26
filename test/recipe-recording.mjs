// Deterministic recording lifecycle and private-store contracts. Browser target
// identity and the complete panel/save/replay path live in recipe-recording-live.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(directory, { recursive: true, force: true }));
const bundle = await build({ stdin: { contents: "export { RecipeRecording } from './src/recipe-recording'; export { RecipeStore } from './src/recipe-store'; export { recipeSchema, bindParameters } from './shared/workflow-schema';", resolveDir: process.cwd() }, platform: 'node', format: 'esm', bundle: true, write: false });
const { RecipeRecording, RecipeStore, recipeSchema, bindParameters } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const directory = mkdtempSync(join(tmpdir(), 'tabai-recording-'));
const file = join(directory, 'recipes.json');
const store = new RecipeStore(file, value => recipeSchema.parse(value));
const descriptor = { target: { selector: '#name' }, fieldSelector: '#name', sensitive: false, role: 'textbox', name: 'Name' };
const calls = [];
let target = descriptor;
const call = async (tool, args) => {
  calls.push({ tool, args });
  if (tool === 'tabs_context_mcp') return { tabs: [{ tabId: 1, url: 'https://example.test/form' }] };
  if (tool === 'resolve_target') return { recordingTarget: structuredClone(target) };
  throw new Error(`Unexpected observer call ${tool}`);
};
const field = { tool: 'form_input', args: { tabId: 1, ref: 'issued-ref', value: 'First name' } };
const review = (draft, name = 'Recorded') => ({ recordingId: draft.recordingId, revision: draft.revision, name,
  steps: draft.entries.map(step => ({ id: step.id, target: step.action.target,
    expect: step.input && step.action.expect?.fieldValue && JSON.stringify(step.action.expect.fieldValue.value) === JSON.stringify(step.action.args[step.input.key])
      ? { ...step.action.expect, fieldValue: { ...step.action.expect.fieldValue, value: { $param: step.input.parameterName } } }
      : step.action.expect ?? { text: 'Done' },
    ...(step.input ? { parameter: { enabled: true, name: step.input.parameterName } } : {}) })) });
const capture = async (recorder, action = field, success = true) => { const finish = await recorder.before(action); await finish(success); };
let checks = 0;
async function test(name, run) { await run(); checks++; console.log(`  ✓ ${name}`); }
try {
  await test('inactive and other-tab work never captures or probes', async () => {
    const recorder = new RecipeRecording(call, store); calls.length = 0;
    await capture(recorder); assert.equal(calls.length, 0);
    await assert.rejects(recorder.start(2), /tillhör/);
    await recorder.start(1); calls.length = 0;
    await capture(recorder, { ...field, args: { ...field.args, tabId: 2 } });
    assert.equal(calls.length, 0); assert.equal(recorder.status().steps, 0);
  });
  await test('portable recipe is explicitly saved, parameterized and retry-idempotent', async () => {
    const recorder = new RecipeRecording(call, store); const start = await recorder.start(1);
    await capture(recorder, { tool: 'navigate', args: { tabId: 1, url: 'https://example.test/form' } });
    await capture(recorder); await capture(recorder, { tool: 'computer', args: { tabId: 1, ref: 'issued-ref', documentId: 'live-doc', action: 'left_click', modifiers: 'shift' } });
    await capture(recorder, { tool: 'wait_for', args: { tabId: 1, text: 'Done', stableForMs: 100 } });
    assert.deepEqual(store.load(), Object.create(null));
    const draft = recorder.stop(start.recordingId), payload = review(draft);
    assert.equal(draft.entries.length, 3); assert.equal(draft.entries[2].checkSource, 'declared');
    await assert.rejects(recorder.save({ ...payload, revision: payload.revision - 1 }), /senaste/);
    await recorder.save(payload); const bytes = readFileSync(file, 'utf8');
    await recorder.save(payload); assert.equal(readFileSync(file, 'utf8'), bytes);
    assert.doesNotMatch(bytes, /issued-ref|documentId|tabId|coordinate|First name/);
    const recipe = store.load().Recorded;
    const actions = bindParameters(recipe.actions, recipe.parameters, { url_1: 'https://example.test/other', value_2: 'Second name' });
    assert.equal(actions[0].expect.url, 'https://example.test/other');
    assert.equal(actions[1].args.value, 'Second name'); assert.equal(actions[1].expect.fieldValue.value, 'Second name');
    assert.equal(actions[2].expect.stableForMs, 100); assert.equal(recorder.draft().entries.length, 0);
    assert.equal(actions[2].args.modifiers, 'shift');
  });
  await test('secret values never enter drafts or store and binding cannot be disabled', async () => {
    target = { ...descriptor, sensitive: true };
    const recorder = new RecipeRecording(call, store); const start = await recorder.start(1);
    await capture(recorder, { ...field, args: { ...field.args, value: 'SECRET-456' } });
    const draft = recorder.stop(start.recordingId), payload = review(draft, 'Private');
    assert.doesNotMatch(JSON.stringify(draft), /SECRET-456/);
    assert.equal(draft.entries[0].input.parameterName, 'secret_value_1', 'a sensitive field gets the reserved secret prefix');
    const invalid = structuredClone(payload); invalid.steps[0].parameter.enabled = false;
    await assert.rejects(recorder.save(invalid), /Känsliga/);
    const unprefixed = structuredClone(payload); unprefixed.steps[0].parameter.name = 'password';
    await assert.rejects(recorder.save(unprefixed), /secret_/, 'the review keeps the reserved prefix');
    payload.steps[0].parameter.name = 'secret_password'; await recorder.save(payload);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /SECRET-456/);
    // Older servers share this store: the saved recipe uses only the unchanged schema.
    const stored = JSON.parse(readFileSync(file, 'utf8')).Private;
    assert.deepEqual(recipeSchema.parse(stored).parameters, { secret_password: { type: 'string', required: true } });
    assert.deepEqual(stored.parameters, { secret_password: { type: 'string', required: true } }, 'no field beyond the existing parameter schema is written');
    assert.deepEqual(store.load().Private.parameters.secret_password, { type: 'string', required: true });
    assert.deepEqual(store.load().Private.actions[0].expect.fieldValue.value, { $param: 'secret_password' });
    target = descriptor;
  });
  await test('field reclassification during input releases the captured literal', async () => {
    const recorder = new RecipeRecording(call, store); await recorder.start(1);
    const finish = await recorder.before(field); target = { ...descriptor, sensitive: true }; await finish(true); target = descriptor;
    assert.equal(recorder.status().state, 'blocked'); assert.doesNotMatch(JSON.stringify(recorder.draft()), /First name/);
  });
  await test('select labels and string checkbox input require an explicit outcome instead of an impossible field check', async () => {
    for (const fieldType of ['selection', 'boolean']) {
      target = { ...descriptor, fieldType };
      const recorder = new RecipeRecording(call, store); const start = await recorder.start(1);
      await capture(recorder); const step = recorder.stop(start.recordingId).entries[0];
      assert.equal(step.checkSource, 'required'); assert.equal(step.action.expect, undefined);
    }
    target = descriptor;
  });
  await test('unsupported, ambiguous and failed actions cannot become a partial recipe', async () => {
    for (const action of [
      { tool: 'javascript_tool', args: { tabId: 1, text: 'secret executable text' } },
      { tool: 'computer', args: { tabId: 1, action: 'type', text: 'secret typed text' } },
      { tool: 'computer', args: { tabId: 1, action: 'double_click', ref: 'issued-ref' } },
      { tool: 'computer', args: { tabId: 1, action: 'left_click', coordinate: [3, 4] } },
      { tool: 'navigate', args: { tabId: 1, url: 'https://example.test/?token=SECRET' } },
      { tool: 'wait_for', args: { tabId: 1, predicate: 'window.mutations++' } },
    ]) {
      const recorder = new RecipeRecording(call, store); const start = await recorder.start(1); await capture(recorder);
      await capture(recorder, action); assert.equal(recorder.status().state, 'blocked');
      await assert.rejects(recorder.save(review(recorder.stop(start.recordingId))), /Stoppa/);
      assert.doesNotMatch(JSON.stringify(recorder.draft()), /secret executable|secret typed|SECRET|window.mutations/);
    }
    for (const action of [field, { tool: 'wait_for', args: { tabId: 1, fieldValue: { selector: '#secret', value: 'SECRET' } } }]) {
      const recorder = new RecipeRecording(call, store); await recorder.start(1); await capture(recorder); await capture(recorder, action, false);
      assert.equal(recorder.status().state, 'blocked'); assert.doesNotMatch(JSON.stringify(recorder.draft()), /SECRET/);
    }
  });
  await test('stop drains exactly one pending step and discard fences its completion', async () => {
    const recorder = new RecipeRecording(call, store); const first = await recorder.start(1);
    const finish = await recorder.before(field); assert.equal(recorder.stop(first.recordingId).state, 'stopping');
    await finish(true); await finish(true); assert.equal(recorder.status().state, 'review'); assert.equal(recorder.status().steps, 1);
    recorder.discard(first.recordingId); const second = await recorder.start(1); const late = await recorder.before(field);
    recorder.discard(second.recordingId); await assert.rejects(recorder.start(1), /befintliga/);
    await late(true); const third = await recorder.start(1); assert.equal(recorder.status().steps, 0);
    assert.notEqual(third.recordingId, second.recordingId); assert.throws(() => recorder.stop(second.recordingId), /ändrats/);
  });
  await test('overlap blocks recording, and separate recorder instances stay independent', async () => {
    const recorder = new RecipeRecording(call, store), other = new RecipeRecording(call, store);
    await recorder.start(1); await other.start(1); const finish = await recorder.before(field);
    await capture(recorder); await finish(true); assert.equal(recorder.status().state, 'blocked'); assert.equal(recorder.status().steps, 0);
    await capture(other); assert.equal(other.status().steps, 1); assert.equal(other.status().state, 'recording');
  });
  await test('existing names, failed persistence and malicious review preserve the draft', async () => {
    const recorder = new RecipeRecording(call, store); const start = await recorder.start(1); await capture(recorder);
    const payload = review(recorder.stop(start.recordingId)); const original = readFileSync(file, 'utf8');
    await assert.rejects(recorder.save(payload), /redan/); assert.equal(readFileSync(file, 'utf8'), original); assert.equal(recorder.status().state, 'review');
    for (const change of [step => { step.expect = { predicate: 'window.sideEffect++' }; }, step => { step.target = { selector: '[data-ccmcp-ref]' }; }, step => { step.expect = { selector: '[data-ccmcp-ref]' }; }, step => { step.expect = { fieldValue: { selector: '[data-ccmcp-ref]', value: 'x' } }; }, step => { step.parameter.name = '__proto__'; }]) {
      const bad = structuredClone(payload); change(bad.steps[0]); await assert.rejects(recorder.save(bad));
    }
    const failed = new RecipeRecording(call, { update: async () => { throw new Error('Disk full'); } });
    const begin = await failed.start(1); await capture(failed); const draft = failed.stop(begin.recordingId);
    await assert.rejects(failed.save(review(draft)), /Disk full/); assert.deepEqual(failed.draft(), draft);
    payload.name = 'Recovered'; await recorder.save(payload);
  });
  await test('step and byte bounds fail closed', async () => {
    const recorder = new RecipeRecording(call, store); await recorder.start(1);
    for (let i = 0; i < 50; i++) await capture(recorder); assert.equal(recorder.status().steps, 50);
    await capture(recorder); assert.equal(recorder.status().state, 'blocked');
    const large = new RecipeRecording(call, store); await large.start(1);
    await capture(large, { ...field, args: { ...field.args, value: 'x'.repeat(256 * 1024) } });
    assert.equal(large.status().state, 'blocked'); assert.equal(large.status().steps, 0);
  });
  await test('an explicitly unbound literal outcome remains independent of input parameters', async () => {
    const recorder = new RecipeRecording(call, store); const start = await recorder.start(1); await capture(recorder);
    const payload = review(recorder.stop(start.recordingId), 'Literal check');
    payload.steps[0].expect = { fieldValue: { selector: '#fixed-status', value: field.args.value } };
    await recorder.save(payload);
    assert.deepEqual(store.load()['Literal check'].actions[0].expect, payload.steps[0].expect);
  });
  await test('start cannot race an unrecorded mutation during its ownership lookup', async () => {
    let release; const recorder = new RecipeRecording(() => new Promise(resolve => { release = resolve; }), store);
    const starting = recorder.start(1);
    const finish = await recorder.before({ tool: 'javascript_tool', args: { tabId: 1, text: 'mutation' } });
    await finish(true); release({ tabs: [{ tabId: 1 }] });
    await assert.rejects(starting, /ändrades/); assert.equal(recorder.status().state, 'idle');
  });
  console.log(`Recipe recording: ${checks} contract groups PASS`);
} finally { rmSync(directory, { recursive: true, force: true }); stopWatchdog(); }
