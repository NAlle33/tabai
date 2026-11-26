import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { openCdpObserver } from './helpers/cdp-observer.mjs';
import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from './helpers/mcp-client.mjs';
import { watchdog } from './watchdog.mjs';

const root = process.cwd(), configDir = mkdtempSync(join(tmpdir(), 'tabai-recording-live-'));
const sessions = [], targets = [];
let observer;
const origin = 'http://127.0.0.1:9237';
const fixture = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Recording fixture</title>
    <label>Name <input id="name"></label><label>Password <input id="password" type="password"></label>
    <label>Country <select id="country"><option value="se">Sweden</option></select></label>
    <label>Enabled <input id="enabled" type="checkbox"></label><label>File <input id="file" type="file"></label>
    <button id="submit" onclick="window.submissions++;document.querySelector('#result').textContent='Submitted'">Submit</button>
    <output id="result"></output><script>window.submissions=0</script>`);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await sleep(100); } throw new Error(`Timed out: ${label}`); }
async function call(session, name, args = {}) {
  const result = await callRaw(session.client, { name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}
async function connect(name) {
  const session = { client: createMcpClient({ name, version: '1.0.0' }), tabs: [] }; sessions.push(session);
  await connectMcpClient(session.client, createMcpTransport({ command: process.execPath, args: [join(root, 'dist/server.js')], cwd: root, env: { CCMCP_CONFIG_DIR: configDir } }));
  const context = await call(session, 'tabs_context_mcp', { createIfEmpty: true });
  session.tabId = context.tabs[0].tabId; session.tabs.push(session.tabId); session.groupId = context.groupId;
  return session;
}
async function evaluate(sessionId, expression) {
  const result = await observer.rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
let cleaning;
function cleanup() { return cleaning ??= (async () => {
  for (const targetId of targets) await observer?.rpc('Target.closeTarget', { targetId }).catch(() => {});
  for (const session of sessions) {
    for (const tabId of session.tabs) await callRaw(session.client, { name: 'tabs_close_mcp', arguments: { tabId } }).catch(() => {});
    await session.client.close();
  }
  observer?.socket.close(); fixture.closeAllConnections();
  if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
  rmSync(configDir, { recursive: true, force: true });
})(); }
const stop = watchdog(cleanup, 120000);
try {
  fixture.listen(9237, '127.0.0.1'); await once(fixture, 'listening');
  const endpoint = new URL(process.argv[2]); assert.equal(endpoint.hostname, '127.0.0.1');
  observer = await openCdpObserver(endpoint, { timeoutMs: 20000, timeoutMessage: method => `${method} timed out` });
  const a = await connect('recording-a'), b = await connect('recording-b');
  const { targetInfos } = await observer.rpc('Target.getTargets');
  const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
  const worker = targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith(`/${manifest.background.service_worker}`));
  assert.ok(worker); const extensionId = new URL(worker.url).hostname;
  const workerSession = (await observer.rpc('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId;
  const groups = await evaluate(workerSession, 'chrome.storage.local.get("mcpGroups").then(s=>s.mcpGroups)');
  a.id = Object.keys(groups).find(id => groups[id] === a.groupId); b.id = Object.keys(groups).find(id => groups[id] === b.groupId);
  const { targetId } = await observer.rpc('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` }); targets.push(targetId);
  const panel = (await observer.rpc('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const ui = expression => evaluate(panel, expression);
  const command = command => ui(`chrome.runtime.sendMessage({type:'panel-command',command:${JSON.stringify(command)}})`);
  await until(() => ui(`Array.from(document.querySelector('#session')?.options??[]).some(option=>option.value===${JSON.stringify(a.id)})`), 'session option');
  await ui(`document.querySelector('#session').value=${JSON.stringify(a.id)};document.querySelector('#session').dispatchEvent(new Event('change'));`);
  await until(() => ui('document.querySelector("#connection").textContent.includes("Ansluten")'), 'session connected');
  // Open the real Settings -> Avancerat -> Recept route.
  await until(() => ui('!!document.querySelector(".assistant-workspace")'), 'assistant workspace');
  await ui('document.querySelector(".assistant-workspace [data-view=settings]").click()');
  await ui('document.querySelector("[data-settings-page=advanced]").click()');
  await ui('document.querySelector("#technical-controls [data-view=recipes]").click()');
  const button = text => ui(`(()=>{const b=[...document.querySelectorAll('#recording-root button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b||b.disabled||!b.getClientRects().length)throw new Error('Button unavailable: '+${JSON.stringify(text)});b.click()})()`);
  await until(() => ui('!!document.querySelector("#recording-root select").value'), 'owned tabs');
  await button('Börja spela in');
  const state = await until(async () => { const status = await call(a, 'recipe_record', { action: 'status' }); return status.state === 'recording' && status; }, 'recording started');
  assert.equal((await call(b, 'recipe_record', { action: 'status' })).state, 'idle');
  assert.equal((await command({ action: 'recording-discard', sessionId: b.id, recordingId: state.recordingId })).ok, false);
  await call(a, 'navigate', { tabId: a.tabId, url: origin });
  for (const [selector, value] of [['#name', 'Original name'], ['#password', 'SECRET-original-789']]) {
    const resolved = await call(a, 'resolve_target', { tabId: a.tabId, target: { selector } });
    const described = await call(a, 'resolve_target', { tabId: a.tabId, describeRef: resolved.ref, documentId: resolved.documentId });
    assert.equal(described.recordingTarget.sensitive, selector === '#password'); assert.deepEqual(described.recordingTarget.target, { selector });
    await call(a, 'form_input', { tabId: a.tabId, ref: resolved.ref, documentId: resolved.documentId, value });
  }
  const batch = await call(a, 'browser_batch', { actions: [{ tool: 'computer', args: { tabId: a.tabId, action: 'left_click' }, target: { selector: '#submit' }, expect: { text: 'Submitted' } }] });
  assert.equal(batch.ok, true);
  assert.equal((await call(a, 'recipe_record', { action: 'status' })).steps, 4, 'internal resolve/wait probes and batch wrapper do not duplicate steps');
  await button('Stoppa och granska');
  await until(() => ui('!!document.querySelector(".recording-review")'), 'review form');
  assert.doesNotMatch(await ui('document.querySelector("#recording-root").innerHTML'), /SECRET-original-789/);
  assert.equal(await ui('document.querySelector("[name=recording-parameter-2]").disabled'), true);
  assert.match(await ui('document.querySelector("[name=recording-parameter-name-2]").value'), /^secret_/, 'a sensitive field is offered with the reserved secret prefix');
  await ui(`document.querySelector('[name=recording-name]').value='Recorded form';document.querySelector('[name=recording-parameter-name-1]').value='customer';document.querySelector('[name=recording-parameter-name-2]').value='secret_password'`);
  await ui('document.querySelector("#refresh").click()');
  await until(() => ui('!document.querySelector("#refresh").disabled'), 'poll complete');
  assert.equal(await ui('document.querySelector("[name=recording-name]").value'), 'Recorded form');
  await observer.rpc('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false }, panel);
  assert.equal(await ui('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'review fits a narrow sidepanel');
  await button('Spara granskat recept');
  await until(() => ui('document.querySelector("#recording-root").textContent.includes("Recorded form är sparat")'), 'saved acknowledgement');
  const bytes = readFileSync(join(configDir, 'recipes.json'), 'utf8'); const recipe = JSON.parse(bytes)['Recorded form'];
  assert.equal(recipe.actions.length, 4); assert.doesNotMatch(bytes, /SECRET-original|Original name|documentId|tabId|data-ccmcp-ref|ref_\d{50}/);
  assert.deepEqual(recipe.parameters.secret_password, { type: 'string', required: true });
  assert.equal(await call(a, 'javascript_tool', { tabId: a.tabId, text: 'window.submissions' }), 1, 'recording never repeats the original action');
  const fresh = (await call(a, 'tabs_create_mcp')).tabId; a.tabs.push(fresh);
  const run = await call(a, 'recipe_run', { name: 'Recorded form', tabId: fresh, parameters: { customer: 'Different name', secret_password: 'SECRET-new-456' } });
  assert.equal(run.ok, true, JSON.stringify(run));
  const actual = await call(a, 'javascript_tool', { tabId: fresh, text: 'JSON.stringify({count:window.submissions,name:document.querySelector("#name").value,password:document.querySelector("#password").value})' });
  assert.deepEqual(actual, { count: 1, name: 'Different name', password: 'SECRET-new-456' });
  // Cloning an issued attribute never creates a valid reverse descriptor.
  const resolved = await call(a, 'resolve_target', { tabId: fresh, target: { selector: '#name' } });
  await call(a, 'javascript_tool', { tabId: fresh, text: 'document.body.append(document.querySelector("#name").cloneNode(true))' });
  const cloned = await callRaw(a.client, { name: 'resolve_target', arguments: { tabId: fresh, describeRef: resolved.ref } });
  assert.equal(cloned.isError, true);
  for (const [selector, fieldType] of [['#country', 'selection'], ['#enabled', 'boolean']]) {
    const target = await call(a, 'resolve_target', { tabId: fresh, target: { selector } });
    const described = await call(a, 'resolve_target', { tabId: fresh, describeRef: target.ref });
    assert.equal(described.recordingTarget.fieldType, fieldType);
  }
  const fileTarget = await call(a, 'resolve_target', { tabId: fresh, target: { selector: '#file' } });
  const upload = join(configDir, 'upload.png'); writeFileSync(upload, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64'));
  const uploadRecording = await call(a, 'recipe_record', { action: 'start', tabId: fresh });
  await call(a, 'upload_image', { tabId: fresh, ref: fileTarget.ref, path: upload });
  assert.equal((await call(a, 'recipe_record', { action: 'status' })).state, 'blocked', 'server-only upload cannot silently disappear from a recorded flow');
  await call(a, 'recipe_record', { action: 'discard', recordingId: uploadRecording.recordingId });
  console.log('Recording live: opt-in panel, session isolation, secret binding, batch capture, review/save, narrow layout, fresh-tab parameter replay and exactly one submission PASS');

  // Deterministic delayed UI replies exercise session changes without timing races.
  const { outputFiles } = await build({ stdin: { contents: "export {createRecipeRecordingView} from './extension/src/recipe-recording-view'", resolveDir: root }, bundle: true, write: false, format: 'iife', globalName: 'RecordingUI' });
  const blank = (await observer.rpc('Target.createTarget', { url: 'about:blank' })).targetId; targets.push(blank);
  const viewSession = (await observer.rpc('Target.attachToTarget', { targetId: blank, flatten: true })).sessionId;
  await evaluate(viewSession, outputFiles[0].text);
  await evaluate(viewSession, `(async()=>{
    const pending=[];const view=RecordingUI.createRecipeRecordingView(command=>new Promise(resolve=>pending.push({command,resolve})),async()=>{});document.body.append(view.element);
    const idle={state:'idle',steps:0,pending:0,revision:0};const tabs=[{tabId:1,title:'One'}];
    view.update('old',true,idle,tabs,false);[...view.element.querySelectorAll('button')].find(b=>b.textContent==='Börja spela in').click();
    view.update('new',true,idle,tabs,false);pending.shift().resolve({state:'recording',recordingId:'old',steps:0,pending:0,revision:1});await new Promise(r=>setTimeout(r,0));
    if(!view.element.textContent.includes('Redo.'))throw new Error('late start replaced new session');
    const draft=${JSON.stringify({ state: 'review', steps: 1, pending: 0, revision: 3, recordingId: state.recordingId, entries: [{ id: recipe.actions[0].id ?? state.recordingId, title: 'Field', action: { tool: 'form_input', target: { selector: '#name' }, args: { value: 'One' }, expect: { fieldValue: { selector: '#name', value: 'One' }, stableForMs: 200 } }, input: { key: 'value', type: 'string', sensitive: false, parameterName: 'name' }, checkSource: 'suggested' }] })};
    view.update('new',true,draft,tabs,false);[...view.element.querySelectorAll('button')].find(b=>b.textContent==='Granska inspelningen').click();const oldPoll=view.snapshotEpoch();pending.shift().resolve(draft);await new Promise(r=>setTimeout(r,0));
    const name=view.element.querySelector('[name=recording-name]');name.value='Keep draft';view.update('new',true,idle,tabs,false,oldPoll);
    if(view.element.querySelector('[name=recording-name]')!==name||name.disabled||name.value!=='Keep draft')throw new Error('delayed old recording snapshot replaced review');
    view.update('new',true,draft,tabs,false,view.snapshotEpoch());if(name.value!=='Keep draft')throw new Error('poll replaced draft');
    view.element.querySelector('form').requestSubmit();if(pending[0].command.review.steps[0].expect.stableForMs!==200)throw new Error('lost stability');
    if(!name.disabled)throw new Error('save allowed concurrent edits');view.update('newer',true,idle,tabs,false);pending.shift().resolve({name:'Old saved'});await new Promise(r=>setTimeout(r,0));
    if(!view.element.textContent.includes('Redo.')||view.element.querySelector('form'))throw new Error('late save replaced new session');
  })()`);
  console.log('Recording UI: polling preserves review edits; stale start/save replies cannot affect a different session PASS');
} finally { stop(); await cleanup(); }
