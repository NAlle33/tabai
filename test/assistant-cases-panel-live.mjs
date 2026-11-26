import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capturePanelShots } from './assistant-chat-panel-live.mjs';

const stamp = '2026-11-01T09:00:00.000Z';
const fixtureId = index => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

// Invoked only by the isolated panel fixture, never by a product module.
export function assistantCasesFixtureCommand(workspace, operation, input) {
  if (operation === 'history' && input.action === 'fixture-case-state') return { description: JSON.stringify({ localEvents: workspace.localEvents || [], caseEvents: workspace.caseEvents || [], testEvents: workspace.testEvents || [], openedTests: workspace.openedTests || [], sourceOpens: workspace.sourceOpens || [] }) };
  if (operation === 'history' && input.caseOffset !== undefined) { workspace.casePage = { offset: Math.max(0, Number(input.caseOffset)) }; return {}; }
  if (operation === 'open' && input.testAccountId) { (workspace.openedTests ||= []).push(input.testAccountId); return {}; }
  if (operation === 'open' && input.itemId === 'fixture-archived-reference') { (workspace.sourceOpens ||= []).push(input.itemId); return {}; }
  if (operation === 'stop' && workspace.accountTests?.some(test => test.status === 'running')) {
    for (const test of workspace.accountTests) if (test.status === 'running') { test.status = 'interrupted'; delete test.tabId; }
    return {};
  }
  if (operation !== 'correct') return false;
  if (input.action === 'fixture-local-complete-pull') {
    const runtime = workspace.fixtureLocal;
    assert.equal(runtime.operation.kind, 'pull'); assert.equal(runtime.operation.status, 'running');
    runtime.operation.status = 'done'; runtime.operation.message = 'Hämtningen är klar.';
    Object.assign(runtime.models[0], { state: 'untested', message: 'Ollama 99.0.0 är inte provad med Qwen3.5 4B.' });
    return {};
  }
  if (input.action?.startsWith('local-')) {
    // Simulated transient runtime: the panel must route every command and render
    // whatever the strict view carries, without a real Ollama in the loop.
    const now = new Date().toISOString(), qwen = 'qwen3.5:4b-q4_K_M';
    const runtime = workspace.fixtureLocal ||= { reachable: true, checking: false, version: '99.0.0', checkedAt: now, models: [
      { id: qwen, state: 'missing', loaded: false }] };
    (workspace.localEvents ||= []).push({ action: input.action, model: input.model, operationId: input.operationId });
    if (input.action === 'local-pull') runtime.operation = { id: '11111111-1111-4111-8111-111111111111', kind: 'pull', model: input.model, status: 'running', message: 'Hämtar Qwen3.5 4B…', completed: 300_000_000, total: 3_300_000_000, startedAt: now, updatedAt: now };
    if (input.action === 'local-cancel') { assert.equal(input.operationId, runtime.operation?.id); Object.assign(runtime.operation, { status: 'aborted', message: 'Hämtningen avbröts. Ollama kan ha sparat en del av filen; hämta igen för att återuppta.', updatedAt: now }); }
    if (input.action === 'local-unload') { runtime.models[0].loaded = false; delete runtime.models[0].vramBytes; runtime.operation = { id: '22222222-2222-4222-8222-222222222222', kind: 'unload', model: input.model, status: 'done', message: 'Qwen3.5 4B är urladdad.', startedAt: now, updatedAt: now }; }
    if (input.action === 'local-selftest') { Object.assign(runtime.models[0], { state: 'ready', verifiedAt: now, loaded: true, vramBytes: 3_300_000_000 }); delete runtime.models[0].message; runtime.operation = { id: '33333333-3333-4333-8333-333333333333', kind: 'selftest', model: input.model, status: 'done', message: 'Självtestet klarade 3 av 3 rundor.', completed: 3, total: 3, startedAt: now, updatedAt: now }; }
    return {};
  }
  if (input.action === 'fixture-account-test-running') {
    const test = workspace.accountTests?.find(test => test.accountId === input.accountId); assert.ok(test);
    test.status = 'running'; test.steps[2].status = 'running'; return {};
  }
  if (input.action === 'fixture-case-external-update') {
    const record = workspace.cases?.find(record => record.id === input.caseId); assert.ok(record);
    record.nextAction = input.nextAction; record.revision++; return {};
  }
  if (input.action === 'fixture-case-unavailable-sources') {
    const record = workspace.cases?.find(record => record.id === input.caseId); assert.ok(record);
    record.links = [{ kind: 'module', moduleId: 'fixture-missing-module', runId: 'missing-module-run', label: 'Frånkopplad modulreferens' }, { kind: 'module', moduleId: 'test-module', runId: 'fixture-not-loaded-run', label: 'Körning utanför aktuell historiksida' }, { kind: 'item', itemId: 'fixture-archived-reference' }];
    record.revision++; return {};
  }
  if (input.action === 'fixture-private-sender') {
    const item = workspace.items[(workspace.itemPage?.offset || 0) + 1]; assert.ok(item);
    item.recipient = 'privat@gmail.com'; item.sender = 'privat@gmail.com'; item.revision++; return { description: item.id };
  }
  if (input.action === 'fixture-case-setup') {
    workspace.cases = Array.from({ length: 12 }, (_, index) => ({ id: fixtureId(index), revision: 0, title: `Isolerat ärende ${index + 1}`, description: 'Uttryckligt kopplat testunderlag.', status: index === 1 ? 'waiting' : 'open', nextAction: 'Granska underlaget', waitingFor: index === 1 ? 'Testpersonen' : '', links: [], createdAt: stamp, updatedAt: stamp }));
    workspace.cases[0].links = [{ kind: 'item', itemId: workspace.items[0].id }];
    workspace.items[0].status = 'uncertain';
    const visibleItem = workspace.items[workspace.itemPage?.offset || 0];
    if (visibleItem && workspace.settings.accounts[1]) visibleItem.accountId = workspace.settings.accounts[1].id;
    workspace.casePage = { offset: 0 }; workspace.caseEvents = []; workspace.testEvents = []; workspace.openedTests = [];
    return {};
  }
  if (input.action === 'test-account') {
    (workspace.testEvents ||= []).push(input.accountId);
    const result = { id: fixtureId(99), accountId: input.accountId, startedAt: stamp, updatedAt: stamp, status: 'partial', tabId: 1,
      steps: ['identity', 'inbox', 'thread', 'sent'].map(key => ({ key, status: key === 'thread' ? 'failed' : 'passed', message: key === 'thread' ? 'Visa hela testtråden i Chrome.' : 'Isolerad läsåtkomst fungerar.' })) };
    workspace.accountTests = [...(workspace.accountTests || []).filter(test => test.accountId !== input.accountId), result]; return {};
  }
  if (!input.action?.startsWith('case-')) return false;
  (workspace.caseEvents ||= []).push({ ...input });
  if (input.title === 'Simulerat ärendefel') throw new Error('Isolerat ärendefel');
  if (input.action === 'case-create') {
    workspace.cases.unshift({ id: fixtureId(100 + workspace.caseEvents.length), revision: 0, title: input.title, description: input.description, status: input.status, nextAction: input.nextAction, waitingFor: input.waitingFor, ...(input.deadline ? { deadline: input.deadline } : {}), links: [], createdAt: stamp, updatedAt: stamp });
    workspace.casePage = { offset: 0 }; return {};
  }
  const record = workspace.cases.find(record => record.id === input.caseId); assert.ok(record); assert.equal(record.revision, Number(input.revision));
  if (input.action === 'case-update') { Object.assign(record, { title: input.title, description: input.description, status: input.status, nextAction: input.nextAction, waitingFor: input.waitingFor }); if (input.deadline) record.deadline = input.deadline; else delete record.deadline; }
  if (input.action === 'case-link') record.links.push(JSON.parse(input.link));
  if (input.action === 'case-unlink') record.links = record.links.filter(link => JSON.stringify(link) !== input.link);
  if (input.action === 'case-delete') workspace.cases = workspace.cases.filter(candidate => candidate.id !== record.id);
  record.revision++; return {};
}

export function assistantCasesFixtureView(workspace, assistant) {
  delete assistant.caseEvents; delete assistant.testEvents; delete assistant.openedTests; delete assistant.sourceOpens; delete assistant.fixtureLocal; delete assistant.localEvents;
  if (!workspace.cases) return assistant;
  const offset = workspace.casePage?.offset || 0, total = workspace.cases.length;
  assistant.cases = workspace.cases.slice(offset, offset + 10);
  assistant.casePage = { offset, total, ...(offset + 10 < total ? { nextOffset: offset + 10 } : {}) };
  const linked = new Set(assistant.cases.flatMap(record => record.links.filter(link => link.kind === 'item').map(link => link.itemId)));
  assistant.caseItems = workspace.items.filter(item => linked.has(item.id)).map(({ id, title, status, kind, accountId, sourceUrl, deadline }) => ({ id, title, status, kind, accountId, sourceUrl, ...(deadline ? { deadline } : {}) }));
  return assistant;
}

export async function assistantCasesPanelChecks({ ui, rpc, panelSession, until, check, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]';
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const status = async () => (await command('status')).result.assistant;
  const state = async () => JSON.parse((await command('history', { action: 'fixture-case-state' })).result.description);
  const click = selector => ui(`document.querySelector(${JSON.stringify(`${card} ${selector}`)}).click()`);
  const type = (selector, value) => ui(`(()=>{const input=document.querySelector(${JSON.stringify(`${card} ${selector}`)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  // Each settings page saves its own part of the settings object.
  const saveSettings = async (part, expected) => {
    const submit = `[data-settings-part="${part}"] button[type="submit"]`, statusSelector = `[data-settings-part="${part}"] .assistant-settings-status`;
    const ready = () => ui(`(()=>{const root=document.querySelector('${card} .assistant-workspace'),save=document.querySelector('${card} ${submit}');return root?.getAttribute('aria-busy')==='false'&&!!save&&!save.disabled;})()`);
    try {
      await until(ready, 'settings Save enabled after the current panel action');
      if (expected) assert.deepEqual(await ui(`({backend:document.querySelector('${card} [name="agentBackend"]').value,model:document.querySelector('${card} [name="localModel"]').value})`), expected, 'runtime refresh retains the intended unsaved model choice');
      // Use the same enabled control as a user. requestSubmit bypasses its busy guard.
      await click(submit);
      await until(async () => await ready() && await ui(`document.querySelector('${card} ${statusSelector}')?.textContent.includes('är sparade')`), 'settings Save completed');
    } catch (error) {
      const observed = await Promise.allSettled([
        ui(`(()=>{const root=document.querySelector('${card} .assistant-workspace'),save=document.querySelector('${card} ${submit}');return {busy:root?.getAttribute('aria-busy'),submitDisabled:save?.disabled,status:document.querySelector('${card} ${statusSelector}')?.textContent,errors:[...document.querySelectorAll('${card} .module-error')].map(node=>node.textContent),backend:document.querySelector('${card} [name="agentBackend"]')?.value,model:document.querySelector('${card} [name="localModel"]')?.value};})()`),
        status().then(workspace => workspace.settings.agent),
      ]);
      throw new Error(`${error.message}\nSettings Save diagnostics: ${JSON.stringify(observed)}`, { cause: error });
    }
  };
  const openPage = async page => {
    await ui(`(()=>{const card=document.querySelector('${card}');if(card.querySelector('.assistant-workspace').dataset.surface!=='settings')card.querySelector('[data-view="settings"]').click();})()`);
    await until(() => ui(`!document.querySelector('${card} .assistant-view-settings').hidden`), 'settings open');
    await click(`[data-settings-page="${page}"]`);
    await until(() => ui(`!document.querySelector('${card} .assistant-settings-page[data-page="${page}"]').hidden`), `settings page ${page}`);
  };
  await openPage('accounts');
  await ui(`(()=>{const input=document.querySelector('${card} .assistant-account [name="enabled"]');input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await saveSettings('accounts');
  await until(() => ui(`document.querySelector('${card} [data-settings-part="accounts"] .assistant-settings-status').textContent.includes('är sparade')`), 'settings saved before read tests');
  const firstAccount = (await status()).settings.accounts[0].id;
  assert.equal((await status()).settings.accounts[0].enabled, false);
  await click(`[data-test-account="${firstAccount}"]`);
  await until(async () => (await status()).accountTests?.[0]?.status === 'partial', 'read test result');
  await until(() => ui(`document.querySelector('${card} [data-account-test="${firstAccount}"] [data-step-status="failed"]')?.textContent.includes('Visa hela testtråden')`), 'failed thread step');
  assert.equal(await ui(`document.querySelectorAll('${card} [data-account-test="${firstAccount}"] [data-test-step]').length`), 4);
  await ui(`[...document.querySelectorAll('${card} [data-account-test="${firstAccount}"] button')].find(button=>button.textContent==='Visa test i Chrome').click()`);
  await until(async () => (await state()).openedTests.includes(firstAccount), 'test tab opened');
  await command('correct', { action: 'fixture-account-test-running', accountId: firstAccount }); await refresh();
  await until(() => ui(`!!document.querySelector('${card} [data-stop-account-test="${firstAccount}"]')`), 'running test stop action');
  await click(`[data-stop-account-test="${firstAccount}"]`);
  await until(async () => (await status()).accountTests[0].status === 'interrupted', 'account test stopped');
  await until(() => ui(`!document.querySelector('${card} [data-stop-account-test="${firstAccount}"]')`), 'stop action removed after interruption');
  check('running account self-test can be stopped through the shared stop operation', () => {});
  await type('[name="tone"]', 'Osparad testton');
  await refresh();
  assert.equal(await ui(`document.querySelector('${card} [data-test-account="${firstAccount}"]').disabled`), true);
  assert.equal(await ui(`document.querySelector('${card} [name="tone"]').value`), 'Osparad testton');
  assert.equal(await ui(`document.querySelectorAll('${card} [data-account-test="${firstAccount}"] [data-test-step]').length`), 4);
  check('account read tests show four real steps, a recovery route and retained unsaved settings', () => {});
  await openPage('models');
  assert.equal(await ui(`document.querySelector('${card} [data-keep="assistant-agent-model"]').open`), false);
  await click('[data-keep="assistant-agent-model"] summary');
  // Opening the section refreshes runtime status; wait so the refresh never races a save.
  await until(() => ui(`document.querySelector('${card} .assistant-local-status')?.textContent.includes('körs lokalt')`), 'runtime status after opening the model section');
  const choose = (selector, value) => ui(`(()=>{const input=document.querySelector(${JSON.stringify(`${card} ${selector}`)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const visible = selector => ui(`(()=>{const node=document.querySelector(${JSON.stringify(`${card} ${selector}`)});return !!node && !node.closest('[hidden]');})()`);
  assert.equal(await visible('[name="agentModel"]'), true, 'Codex is the default backend');
  assert.equal(await visible('[name="localModel"]'), false);
  await choose('[name="agentModel"]', 'gpt-6.1-sol'); await choose('[name="agentReasoningEffort"]', 'high');
  await saveSettings('agent');
  await until(async () => (await status()).settings.agent?.codex?.model === 'gpt-6.1-sol', 'agent model saved');
  assert.deepEqual((await status()).settings.agent, { backend: 'codex', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, claude: { model: 'claude-opus-5-5', effort: 'medium' }, local: { model: 'qwen3.5:4b-q4_K_M' }, berget: { model: 'zai-org/GLM-5.3-Flash' } });
  check('agent model settings retain the selected model and reasoning effort', () => {});
  // Claude: a third cloud choice with its own model and effort; the other choices are kept.
  assert.deepEqual(await ui(`[...document.querySelectorAll('${card} [name="agentBackend"] option')].map(option=>option.value)`), ['codex', 'claude', 'local', 'berget']);
  await choose('[name="agentBackend"]', 'claude');
  assert.equal(await visible('[name="claudeModel"]'), true); assert.equal(await visible('[name="agentModel"]'), false); assert.equal(await visible('[name="localModel"]'), false);
  assert.deepEqual(await ui(`[...document.querySelectorAll('${card} [name="claudeModel"] option')].map(option=>option.value)`), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
  assert.equal(await ui(`document.querySelector('${card} [name="claudeModel"]').value`), 'claude-opus-5-5', 'Opus 5.5 is the default Claude model');
  assert.match(await ui(`document.querySelector('${card} .assistant-agent-claude').textContent`), /skickas till Anthropic.*ingen API-nyckel/s, 'the panel says where the content goes and that no key is stored');
  await choose('[name="claudeModel"]', 'claude-sonnet-5-5'); await choose('[name="claudeEffort"]', 'high');
  await saveSettings('agent');
  await until(async () => (await status()).settings.agent?.backend === 'claude', 'Claude backend saved');
  assert.deepEqual((await status()).settings.agent, { backend: 'claude', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, claude: { model: 'claude-sonnet-5-5', effort: 'high' }, local: { model: 'qwen3.5:4b-q4_K_M' }, berget: { model: 'zai-org/GLM-5.3-Flash' } });
  // Local inference: the single pinned model, explicit choice, both choices kept.
  await choose('[name="agentBackend"]', 'local');
  assert.equal(await visible('[name="localModel"]'), true); assert.equal(await visible('[name="agentModel"]'), false);
  assert.deepEqual(await ui(`[...document.querySelectorAll('${card} [name="localModel"] option')].map(option=>option.value)`), ['qwen3.5:4b-q4_K_M']);
  assert.equal(await ui(`document.querySelector('${card} [name="localModel"]').value`), 'qwen3.5:4b-q4_K_M', '4B is the default local model');
  assert.match(await ui(`document.querySelector('${card} .assistant-agent-local').textContent`), /aldrig själv till Codex/);
  assert.match(await ui(`document.querySelector('${card} .assistant-agent-local').textContent`), /Experimentellt: den lokala modellen kan missa eller feltolka mejl/, "local mode says it is experimental");
  await choose('[name="localModel"]', 'qwen3.5:4b-q4_K_M');
  await saveSettings('agent', { backend: 'local', model: 'qwen3.5:4b-q4_K_M' });
  await until(async () => (await status()).settings.agent?.backend === 'local', 'local backend saved');
  assert.deepEqual((await status()).settings.agent, { backend: 'local', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, claude: { model: 'claude-sonnet-5-5', effort: 'high' }, local: { model: 'qwen3.5:4b-q4_K_M' }, berget: { model: 'zai-org/GLM-5.3-Flash' } });
  await refresh();
  await until(() => ui(`!!document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"][data-state="missing"]')`), 'runtime status rendered from the view');
  assert.match(await ui(`document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"]').textContent`), /Apache-2\.0/);
  assert.doesNotMatch(await ui(`document.querySelector('${card} .assistant-local-models').textContent`), /\b(?:2B|9B)\b/, 'removed models are not displayed');
  // Runtime re-renders never discard unsaved settings.
  await type('[name="tone"]', 'Osparad ton under modellhämtning');
  await click('[data-local-model="qwen3.5:4b-q4_K_M"] [data-local-action="pull"]');
  await until(() => ui(`!!document.querySelector('${card} [data-local-operation="running"] progress')`), 'pull progress');
  assert.match(await ui(`document.querySelector('${card} [data-local-operation]').textContent`), /av 3,3 GB/);
  assert.equal(await ui(`document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"] [data-local-action="pull"]').disabled`), true, 'one runtime job at a time');
  await click('[data-local-cancel]');
  await until(() => ui(`document.querySelector('${card} [data-local-operation]')?.dataset.localOperation === 'aborted'`), 'pull cancelled');
  assert.match(await ui(`document.querySelector('${card} [data-local-operation]').textContent`), /återuppta/);
  await click('[data-local-model="qwen3.5:4b-q4_K_M"] [data-local-action="pull"]');
  await until(() => ui(`!!document.querySelector('${card} [data-local-operation="running"] progress')`), 'pull resumed');
  await command('correct', { action: 'fixture-local-complete-pull' }); await refresh();
  await until(() => ui(`!!document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"][data-state="untested"]')`), 'completed pull needs a self-test');
  assert.match(await ui(`document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"]').textContent`), /inte provad med Qwen3\.5 4B/, 'an untested runtime release says so before the self-test passes');
  await click('[data-local-model="qwen3.5:4b-q4_K_M"] [data-local-action="selftest"]');
  await until(() => ui(`!!document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"][data-state="ready"]')`), 'self-test result');
  assert.match(await ui(`document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"]').textContent`), /självtest godkänt.*laddad i minnet/);
  await click('[data-local-model="qwen3.5:4b-q4_K_M"] [data-local-action="unload"]');
  await until(() => ui(`!document.querySelector('${card} [data-local-model="qwen3.5:4b-q4_K_M"] [data-local-action="unload"]')`), 'unloaded model');
  assert.equal(await ui(`document.querySelector('${card} [name="tone"]').value`), 'Osparad ton under modellhämtning');
  await choose('[name="agentBackend"]', 'codex'); await type('[name="tone"]', '');
  await saveSettings('agent');
  await saveSettings('accounts');
  await until(async () => (await status()).settings.agent?.backend === 'codex', 'switched back to Codex');
  assert.deepEqual((await status()).settings.agent, { backend: 'codex', codex: { model: 'gpt-6.1-sol', reasoningEffort: 'high' }, claude: { model: 'claude-sonnet-5-5', effort: 'high' }, local: { model: 'qwen3.5:4b-q4_K_M' }, berget: { model: 'zai-org/GLM-5.3-Flash' } });
  // The fixture's state query bumps its revision, so it runs only after the last save.
  const localEvents = (await state()).localEvents;
  assert(localEvents.some(event => event.action === 'local-refresh'), 'opening the model section refreshes runtime status');
  assert.deepEqual(localEvents.filter(event => event.action !== 'local-refresh'), [
    { action: 'local-pull', model: 'qwen3.5:4b-q4_K_M' }, { action: 'local-cancel', operationId: '11111111-1111-4111-8111-111111111111' },
    { action: 'local-pull', model: 'qwen3.5:4b-q4_K_M' }, { action: 'local-selftest', model: 'qwen3.5:4b-q4_K_M' }, { action: 'local-unload', model: 'qwen3.5:4b-q4_K_M' }]);
  await refresh();
  check('local inference: one pinned model, explicit backend switch, runtime pull/cancel/self-test/unload through the panel transport and retained unsaved settings', () => {});
  await command('correct', { action: 'fixture-case-setup' }); await refresh(); await click('[data-view="mail"]');
  await until(() => ui(`!document.querySelector('${card} .assistant-view-mail').hidden`), 'Mejl open');
  if (await ui(`document.querySelector('${card} .assistant-mail-inbox').hidden`)) await click('.assistant-back');
  await until(() => ui(`!document.querySelector('${card} .assistant-mail-inbox').hidden`), 'Mejl list');
  // Ärenden is a page in Mejl, opened from ⋯ next to Kolla mina mejl.
  await click('.assistant-mail-start .assistant-mail-more');
  await until(() => ui(`document.querySelector('${card} .assistant-mail-start .assistant-mail-menu').matches(':popover-open')`), 'start menu open');
  await click('.assistant-mail-start [data-mail-open="cases"]');
  await until(() => ui(`document.querySelector('${card} .assistant-view-mail [data-section="cases"]')?.getClientRects().length > 0 && document.querySelector('${card} [data-section="cases"]').closest('.assistant-mail-cases').getAttribute('aria-label')==='Ärenden' && document.querySelector('${card} .assistant-topbar-title').textContent==='Ärenden' && document.querySelector('${card} .assistant-back').getAttribute('aria-label')==='Tillbaka till Mejl' && document.querySelector('${card} .assistant-mail-inbox').hidden`), 'Ärenden is a page in Mejl');
  await until(() => ui(`document.querySelector('${card} [data-case-page="0"]')?.textContent.includes('av 12')`), 'case page');
  await type('[name="case-search"]', 'Isolerat ärende 2');
  assert.equal(await ui(`document.querySelectorAll('${card} .assistant-case-list [data-case-id]').length`), 1);
  await type('[name="case-search"]', '');
  await click(`[data-case-id="${fixtureId(0)}"] button`);
  await until(() => ui(`!!document.querySelector('${card} [data-linked-item-status="uncertain"]')`), 'uncertain linked source');
  assert.equal(await ui(`document.querySelector('${card} [data-linked-item-status="uncertain"]').textContent.includes('skickar inte svaret igen')`), true);
  // A linked mail carries the same status word as its row in Mejl.
  assert.equal(await ui(`document.querySelector('${card} [data-linked-item-status="uncertain"] .notice').textContent`), 'Kolla om det skickades');
  await type('[name="case-next-action"]', 'Mitt osparade nästa steg'); await refresh();
  assert.equal(await ui(`document.querySelector('${card} [name="case-next-action"]').value`), 'Mitt osparade nästa steg');
  await click('[data-case-save]');
  await until(async () => (await status()).cases[0].nextAction === 'Mitt osparade nästa steg', 'case edit saved');
  const editBase = (await status()).cases[0];
  await type('[name="case-next-action"]', 'Lokal text före en annan panels ändring');
  await command('correct', { action: 'fixture-case-external-update', caseId: editBase.id, nextAction: 'Extern ändring ska bevaras' }); await refresh();
  await until(() => ui(`document.querySelector('${card} .assistant-case-message').textContent.includes('Ärendet har ändrats')`), 'external edit conflict');
  await click('[data-case-save]');
  await until(async () => (await state()).caseEvents.at(-1)?.revision === String(editBase.revision), 'stale edit revision submitted');
  assert.equal((await status()).cases[0].nextAction, 'Extern ändring ska bevaras');
  assert.equal(await ui(`document.querySelector('${card} [name="case-next-action"]').value`), 'Lokal text före en annan panels ändring');
  await ui(`[...document.querySelectorAll('${card} .assistant-case-editor button')].find(button=>button.textContent==='Avbryt ändringar').click()`);
  assert.equal(await ui(`document.querySelector('${card} [name="case-next-action"]').value`), 'Extern ändring ska bevaras');
  check('external case edits reject the original dirty revision until explicit discard/reload', () => {});
  await click('[data-keep^="assistant-case-link-editor-"] summary');
  await type('[name="case-link-kind"]', 'url');
  await ui(`document.querySelector('${card} [name="case-link-kind"]').dispatchEvent(new Event('change'))`);
  await type('[name="case-link-url"]', 'javascript:alert(1)');
  await ui(`document.querySelector('${card} [name="case-link-url"]').form.requestSubmit()`);
  await until(() => ui(`document.querySelector('${card} .assistant-case-editor').textContent.includes('http- eller https-adress')`), 'unsafe link rejected');
  await type('[name="case-description"]', 'Osparad beskrivning vid länkning');
  await type('[name="case-link-url"]', 'https://example.test/explicit-source'); await type('[name="case-link-label"]', 'Uttryckligt valt underlag');
  await ui(`document.querySelector('${card} [name="case-link-url"]').form.requestSubmit()`);
  await until(async () => (await status()).cases[0].links.some(link => link.kind === 'url'), 'url linked');
  await until(() => ui(`!!document.querySelector('${card} [data-link-kind="url"] a')`), 'safe source shown');
  assert.equal(await ui(`document.querySelector('${card} [name="case-description"]').value`), 'Osparad beskrivning vid länkning');
  assert.equal(await ui(`document.querySelector('${card} [data-link-kind="url"] a').rel`), 'noopener noreferrer');
  await click('[data-link-kind="url"] button');
  await until(async () => !(await status()).cases[0].links.some(link => link.kind === 'url'), 'url unlinked');
  assert.equal(await ui(`document.querySelector('${card} [name="case-description"]').value`), 'Osparad beskrivning vid länkning');
  await ui(`[...document.querySelectorAll('${card} .assistant-case-editor button')].find(button=>button.textContent==='Avbryt ändringar').click()`);
  await type('[name="case-link-kind"]', 'item');
  await ui(`document.querySelector('${card} [name="case-link-kind"]').dispatchEvent(new Event('change'))`);
  const itemChoice = await ui(`(()=>{const select=document.querySelector('${card} [name="case-link-source"]');const option=[...select.options].find(option=>option.value&&JSON.parse(option.value).kind==='item');select.value=option.value;return {link:JSON.parse(option.value),label:option.textContent};})()`);
  assert.match(itemChoice.label, /Isolerat Outlook/);
  await ui(`document.querySelector('${card} [name="case-link-source"]').form.requestSubmit()`);
  await until(async () => (await status()).cases[0].links.some(link => link.kind === 'item' && link.itemId === itemChoice.link.itemId), 'cross-account item linked');
  await type('[name="case-link-kind"]', 'module');
  await ui(`document.querySelector('${card} [name="case-link-kind"]').dispatchEvent(new Event('change'))`);
  await ui(`(()=>{const select=document.querySelector('${card} [name="case-link-source"]');select.value=[...select.options].find(option=>option.value&&JSON.parse(option.value).kind==='module').value;select.form.requestSubmit();})()`);
  await until(async () => (await status()).cases[0].links.filter(link => link.kind === 'module').length === 1, 'exact module run linked');
  await click('[data-link-kind="module"] button');
  await until(() => ui(`document.activeElement.closest('[data-module-id]')?.dataset.moduleId==='test-module'`), 'module source opened');
  check('case edits survive polling and source links require explicit safe selection', () => {});
  await command('correct', { action: 'fixture-case-unavailable-sources', caseId: fixtureId(1) }); await refresh();
  await click(`[data-case-id="${fixtureId(1)}"] button`);
  await until(() => ui(`!!document.querySelector('${card} [data-module-link-id="fixture-missing-module"] button')`), 'unavailable sources rendered after the refresh');
  await until(() => ui(`!!document.querySelector('${card} [data-module-link-id="fixture-missing-module"] button') && !!document.querySelector('${card} [data-module-run-id="fixture-not-loaded-run"] button')`), 'updated unavailable source controls rendered');
  assert.equal(await ui(`document.querySelector('${card} [data-module-link-id="fixture-missing-module"] button').disabled`), true);
  assert.match(await ui(`document.querySelector('${card} [data-module-link-id="fixture-missing-module"]').textContent`), /Modulen är inte tillgänglig/);
  assert.equal(await ui(`document.querySelector('${card} [data-module-run-id="fixture-not-loaded-run"] button').disabled`), false);
  await click('[data-module-run-id="fixture-not-loaded-run"] button');
  await until(() => ui(`document.querySelector('${card} [data-module-run-id="fixture-not-loaded-run"] .assistant-case-source-error')?.textContent.includes('Modulen visade inte den valda körningen')`), 'exact source select failure shown in case');
  assert.match(await ui(`document.querySelector('${card} [data-link-kind="item"]').textContent`), /Mejlet är inte inläst här/);
  await click('[data-link-kind="item"] button');
  await until(async () => (await state()).sourceOpens.includes('fixture-archived-reference'), 'archived reference opened through controller');
  check('unavailable modules are explicit, unknown runs still select exactly and unloaded item references remain openable', () => {});
  await click('[data-case-page-action="next"]');
  await until(() => ui(`!!document.querySelector('${card} [data-case-page="10"]')`), 'next case page');
  await click('[data-case-page-action="previous"]');
  await until(() => ui(`!!document.querySelector('${card} [data-case-page="0"]')`), 'previous case page');
  await click('[data-case-create]'); await type('[name="case-title"]', 'Simulerat ärendefel'); await click('[data-case-save]');
  await until(() => ui(`document.querySelector('${card} .assistant-case-message').textContent.includes('kunde inte sparas')`), 'case save error');
  await refresh(); assert.equal(await ui(`document.querySelector('${card} [name="case-title"]').value`), 'Simulerat ärendefel');
  await type('[name="case-title"]', 'Nytt uttryckligt testärende'); await type('[name="case-waiting-for"]', 'Testpersonen'); await click('[data-case-save]');
  await until(async () => (await status()).cases[0].title === 'Nytt uttryckligt testärende', 'new case created');
  check('case paging and create failure retain the input until a successful save', () => {});
  if (artifactDir) mkdirSync(artifactDir, { recursive: true });
  await click('[data-view="mail"]');
  await until(() => ui(`!document.querySelector('${card} .assistant-view-mail').hidden`), 'Mejl before case layout');
  for (const width of [375, 768, 1440]) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, panelSession);
    await ui(`document.querySelector('${card} .assistant-case-editor').scrollIntoView({block:'start'})`);
    assert.equal(await ui('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await ui(`(()=>{const buttons=[...document.querySelectorAll('${card} .assistant-topbar button')].filter(button=>button.getClientRects().length);return buttons.length>=2&&buttons.every(button=>button.scrollWidth<=button.clientWidth&&button.getBoundingClientRect().height>=44);})()`), true);
    if (artifactDir) { const shot = await rpc('Page.captureScreenshot', { format: 'png' }, panelSession); writeFileSync(join(artifactDir, `assistant-cases-${width}.png`), Buffer.from(shot.data, 'base64')); }
  }
  check('case navigation and editing fit 375, 768 and 1440 pixel viewports', () => {});
  const deletedId = (await status()).cases[0].id;
  await click('[data-case-delete]');
  await ui(`[...document.querySelectorAll('${card} .assistant-case-delete-confirm button')].find(button=>button.textContent==='Ja, ta bort ärendet').click()`);
  await until(async () => !(await status()).cases.some(record => record.id === deletedId), 'case deleted after confirmation');
  check('case deletion requires naming the case and confirming removal', () => {});
  const contextualCase = (await status()).cases[0];
  await ui(`[...document.querySelectorAll(${JSON.stringify(`${card} [data-case-id="${contextualCase.id}"] button`)})].find(button=>button.textContent==='Chatta om detta').click()`);
  await until(() => ui(`document.querySelector('${card} .assistant-context-chip')?.textContent.includes('Ärende:')`), 'scoped case conversation');
  assert.equal(await ui(`document.querySelector('${card} .assistant-view-chat').hidden`), false);
  check('an exact case reference opens a scoped conversation in the same main chat', () => {});
  const show = async (view, page) => {
    await ui(`(()=>{const card=document.querySelector('${card}'),current=card.querySelector('.assistant-workspace').dataset.surface;if(current!==${JSON.stringify(view)}&&${JSON.stringify(view)}!=='chat')card.querySelector('[data-view="${view}"]').click();if(${JSON.stringify(view)}==='chat'&&current!=='chat')card.querySelector(current==='settings'?'[data-view="settings"]':current==='mail'?'[data-view="mail"]':'.assistant-back').click();})()`);
    if (page) await click(`[data-settings-page="${page}"]`);
    await until(() => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface===${JSON.stringify(view)}${page ? ` && !document.querySelector('${card} .assistant-settings-page[data-page="${page}"]').hidden` : ''}`), `${view} for screenshots`);
  };
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'chat-context', () => show('chat'));
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings', () => show('settings'));
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings-accounts', () => show('settings', 'accounts'));
  await show('chat');
}
