import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseline = () => ({ steps: ['verify-account', 'read-incoming', 'read-sent', 'return-inbox'], expandThreads: false });
const version = definition => ({ id: randomUUID(), definition: structuredClone(definition), createdAt: new Date().toISOString() });
const measurement = (mode, calls) => ({ at: new Date().toISOString(), status: 'verified', mode, preparationCalls: calls, preparationMs: calls * 100, folders: 2, reviewedThreads: 3 });

/** The model/store boundary is synthetic; the real panel and transport handle every UI action. */
export function assistantMailMethodsFixtureCommand(workspace, operation, input) {
  if (operation === 'history' && input.action === 'fixture-mail-methods-begin') {
    assert.equal(workspace.fixtureMailMethods, undefined);
    workspace.fixtureMailMethods = { requests: [], backup: structuredClone({ settings: workspace.settings, current: workspace.current, mailMethods: workspace.mailMethods }) };
    workspace.mailMethods = workspace.settings.accounts.map(account => ({ accountId: account.id, revision: 0, history: [] }));
    return true;
  }
  const fixture = workspace.fixtureMailMethods;
  if (!fixture) return false;
  if (operation === 'history' && input.action === 'fixture-mail-methods-end') {
    const backup = fixture.backup;
    workspace.settings = backup.settings;
    if (backup.current) workspace.current = backup.current; else delete workspace.current;
    if (backup.mailMethods) workspace.mailMethods = backup.mailMethods; else delete workspace.mailMethods;
    delete workspace.fixtureMailMethods;
    return true;
  }
  if (operation === 'history' && input.action === 'fixture-mail-methods-next-save') {
    assert.ok(['failure', 'stale'].includes(input.outcome)); fixture.nextSave = input.outcome; return true;
  }
  if (operation !== 'correct' || input.action !== 'mail-method') return false;
  const request = JSON.parse(input.method);
  assert.ok(['save', 'forget', 'learn', 'test'].includes(request.action));
  const account = workspace.settings.accounts.find(account => account.id === request.accountId);
  assert.ok(account, 'the panel names its saved account');
  const record = workspace.mailMethods.find(record => record.accountId === account.id);
  fixture.requests.push(request);
  if (request.action === 'save' && fixture.nextSave) {
    const outcome = fixture.nextSave; delete fixture.nextSave;
    if (outcome === 'stale') {
      record.candidate = version(baseline()); record.revision++;
      throw new Error('Metoden har ändrats. Ditt utkast finns kvar; läs in den senaste versionen innan du sparar.');
    }
    throw new Error('Isolerat lagringsfel för mejlmetoden.');
  }
  if (request.action === 'save' || request.action === 'forget') assert.equal(request.revision, record.revision, 'the editor sends the revision it read');
  if (request.action === 'save') {
    assert.deepEqual([...request.definition.steps].sort(), [...baseline().steps].sort());
    assert.equal(typeof request.definition.expandThreads, 'boolean');
    record.candidate = version(request.definition); record.revision++;
  } else if (request.action === 'forget') {
    delete record.active; delete record.candidate; record.history = []; record.revision++;
  } else {
    assert.equal(account.enabled, true);
    workspace.settings.learnMail = true;
    const active = request.action === 'test' ? record.candidate ?? record.active : version(baseline());
    assert.ok(active, 'testing uses a stored method');
    record.active = { ...active, verifiedAt: new Date().toISOString() };
    delete record.candidate;
    record.history = [measurement(request.action === 'learn' ? 'learning' : 'method', request.action === 'learn' ? 9 : 4), ...record.history].slice(0, 8);
    record.revision++;
  }
  return true;
}

export async function assistantMailMethodsPanelChecks({ ui, until, check }) {
  const card = '[data-module-id="assistant-fixture"]', accountId = 'fixture-gmail';
  const root = `${card} [data-mail-method="${accountId}"]`;
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const workspace = async () => (await command('status')).result.assistant;
  const requests = async () => JSON.parse((await command('history', { action: 'fixture-state' })).result.description).mailMethodRequests;
  const record = async () => (await workspace()).mailMethods.find(record => record.accountId === accountId);
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  const buttonState = label => ui(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(`${root} button`)})].find(button=>button.textContent===${JSON.stringify(label)});return button?{disabled:button.disabled}:null;})()`);
  const click = async label => {
    await until(async () => (await buttonState(label))?.disabled === false, `${label} enabled`);
    await ui(`[...document.querySelectorAll(${JSON.stringify(`${root} button`)})].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  };
  const draft = () => ui(`(()=>{const root=document.querySelector(${JSON.stringify(root)});return {order:root.querySelector('select').value,expand:root.querySelector('input[type="checkbox"]').checked};})()`);
  const edit = async (order, expand) => {
    await until(() => ui(`!document.querySelector(${JSON.stringify(root)}).querySelector('select').disabled&&!document.querySelector(${JSON.stringify(root)}).querySelector('input[type="checkbox"]').disabled`), 'method editor ready');
    return ui(`(()=>{const root=document.querySelector(${JSON.stringify(root)}),order=root.querySelector('select'),expand=root.querySelector('input[type="checkbox"]');order.value=${JSON.stringify(order)};order.dispatchEvent(new Event('change',{bubbles:true}));if(expand.checked!==${expand})expand.click();})()`);
  };
  const tone = value => ui(`(()=>{const input=document.querySelector('${card} [name="tone"]');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const saveAccounts = async () => {
    await until(() => ui(`!document.querySelector('${card} [data-settings-part="accounts"] button[type="submit"]').disabled`), 'account save enabled');
    await ui(`document.querySelector('${card} [data-settings-part="accounts"] button[type="submit"]').click()`);
    await until(() => ui(`document.querySelector('${card} [data-settings-part="accounts"] .assistant-settings-status').textContent==='Inställningarna är sparade.'`), 'account settings saved');
  };
  const expectDraft = async (expected, message) => assert.deepEqual(await draft(), expected, message);
  assert.equal((await command('history', { action: 'fixture-mail-methods-begin' })).ok, true);
  try {
    await refresh();
    await until(() => ui(`!!document.querySelector(${JSON.stringify(root)})`), 'mail method editor mounted');
    assert.equal(await ui(`document.querySelector(${JSON.stringify(root)}).getClientRects().length>0`), true, 'methods appear on Mejlkonton');
    await ui(`document.querySelector('${card} [name="learnMail"]').click()`);
    await saveAccounts();
    assert.equal((await workspace()).settings.learnMail, true);
    await refresh();
    await until(() => ui(`document.querySelector('${card} [name="learnMail"]').checked`), 'saved learning choice after polling');
    check('Mejlkonton saves the persistent learning choice and polling retains it', () => {});

    await click('Kör nu och lär in');
    await until(async () => !!(await record()).active?.verifiedAt, 'learned method in the host view');
    await until(() => ui(`document.querySelector(${JSON.stringify(root)}).textContent.includes('Verifierad metod finns.')`), 'verified method status');
    assert.deepEqual((await requests()).at(-1), { action: 'learn', accountId });
    const original = (await record()).active;
    check('Kör nu och lär in targets the saved account and shows its verified result', () => {});

    await edit('sent', true);
    await refresh();
    await expectDraft({ order: 'sent', expand: true }, 'a method draft survives polling');
    await click('Spara metodändring');
    await until(async () => !!(await record()).candidate, 'candidate stored');
    const candidate = (await record()).candidate;
    assert.deepEqual((await record()).active, original, 'saving a candidate keeps the verified method');
    assert.deepEqual((await requests()).at(-1), { action: 'save', accountId, revision: 1, definition: { steps: ['verify-account', 'read-sent', 'read-incoming', 'return-inbox'], expandThreads: true } });
    await until(() => ui(`document.querySelector(${JSON.stringify(root)}).textContent.includes('Den fungerande metoden behålls.')`), 'candidate status explains active method remains');
    await click('Prova sparad ändring');
    await until(async () => (await record()).active.id === candidate.id && !(await record()).candidate, 'tested candidate promoted');
    await until(() => ui(`document.querySelector(${JSON.stringify(root)}).textContent.includes('Senaste förberedelse: 4 verktygsanrop')&&document.querySelector(${JSON.stringify(root)}).textContent.includes('Föregående förberedelse: 9 verktygsanrop')`), 'latest and previous measurements in their real order');
    assert.deepEqual((await requests()).at(-1), { action: 'test', accountId });
    check('a saved candidate preserves the active method until tested and shows latest versus previous measurements honestly', () => {});

    await edit('incoming', false);
    await command('history', { action: 'fixture-mail-methods-next-save', outcome: 'failure' });
    const beforeFailure = (await requests()).length;
    await click('Spara metodändring');
    await until(async () => (await requests()).length === beforeFailure + 1, 'failed method save reaches the host once');
    await until(() => ui(`document.querySelector('${card}').textContent.includes('Isolerat lagringsfel för mejlmetoden.')`), 'save failure is visible');
    await refresh();
    await expectDraft({ order: 'incoming', expand: false }, 'a failed save does not clear the draft');
    assert.equal((await record()).candidate, undefined);
    assert.equal((await record()).active.id, candidate.id);
    check('a failed method save leaves the draft and verified method intact', () => {});

    await edit('sent', false);
    await command('history', { action: 'fixture-mail-methods-next-save', outcome: 'stale' });
    const beforeStale = (await requests()).length;
    await click('Spara metodändring');
    await until(async () => (await requests()).length === beforeStale + 1, 'stale save reaches the host once');
    await refresh();
    await until(() => ui(`document.querySelector(${JSON.stringify(root)}).textContent.includes('Metoden har ändrats sedan du började redigera.')`), 'remote revision conflict');
    await expectDraft({ order: 'sent', expand: false }, 'the rejected stale save retains the unsaved order');
    assert.deepEqual(await buttonState('Spara metodändring'), { disabled: true });
    assert.deepEqual(await buttonState('Glöm metoden'), { disabled: true });
    const conflictedRequests = (await requests()).length;
    await ui(`[...document.querySelectorAll(${JSON.stringify(`${root} button`)})].filter(button=>['Spara metodändring','Glöm metoden'].includes(button.textContent)).forEach(button=>button.click())`);
    assert.equal((await requests()).length, conflictedRequests, 'conflicted controls send no request');
    await click('Läs in sparad version');
    await expectDraft({ order: 'incoming', expand: false }, 'explicit reload adopts the saved candidate');
    await until(async () => (await buttonState('Spara metodändring'))?.disabled === false, 'save unlocked after explicit reload');
    check('a stale save keeps its draft, blocks further stale writes and reloads only on request', () => {});

    await edit('sent', true);
    const savedTone = (await workspace()).settings.tone;
    await tone('Osparad kontoton under metodkontroll');
    await refresh();
    await until(async () => (await buttonState('Kör nu och lär in'))?.disabled === true, 'unsaved account settings block method actions');
    for (const label of ['Spara metodändring', 'Prova sparad ändring', 'Glöm metoden']) assert.deepEqual(await buttonState(label), { disabled: true }, label);
    await expectDraft({ order: 'sent', expand: true }, 'an account settings poll keeps the method draft');
    assert.equal(await ui(`document.querySelector('${card} [name="tone"]').value`), 'Osparad kontoton under metodkontroll');
    await saveAccounts();
    await expectDraft({ order: 'sent', expand: true }, 'saving account settings does not submit or clear the method draft');
    assert.deepEqual((await record()).candidate.definition, baseline());
    await tone(savedTone); await saveAccounts();
    await click('Läs in sparad version');
    check('account settings and method drafts survive polls and save independently', () => {});

    const beforeForget = (await requests()).length;
    await click('Glöm metoden');
    await until(async () => !(await record()).active && !(await record()).candidate, 'method forgotten');
    assert.equal((await requests()).length, beforeForget + 1);
    assert.equal((await requests()).at(-1).action, 'forget');
    await until(() => ui(`document.querySelector(${JSON.stringify(root)}).textContent.includes('Ingen verifierad metod ännu.')`), 'forgotten status');
    await ui(`document.querySelector('${card} [name="learnMail"]').click()`); await saveAccounts();
    assert.equal((await workspace()).settings.learnMail, false);
    check('Glöm metoden clears active and candidate methods, and learning can be disabled', () => {});
  } finally {
    await command('history', { action: 'fixture-mail-methods-end' });
    await refresh();
  }
}
