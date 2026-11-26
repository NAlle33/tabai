import assert from 'node:assert/strict';
import { capturePanelShots, declineThenConfirm } from './assistant-chat-panel-live.mjs';

// The host's web features in the panel: watches, sender lookup, receipts, typed web
// activity, quick tasks and Mina uppgifter. Synthetic fixture data only.
export async function assistantFeaturePanelChecks({ ui, rpc, panelSession, until, check, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]', scope = `${card} .assistant-view-chat`;
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const status = async () => (await command('status')).result;
  const fixtureState = async () => JSON.parse((await command('history', { action: 'fixture-state' })).result.description);
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  const click = selector => ui(`document.querySelector(${JSON.stringify(`${card} ${selector}`)}).click()`);
  const clickText = (selector, label) => ui(`[...document.querySelectorAll(${JSON.stringify(`${card} ${selector}`)})].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  const type = (selector, value) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const choose = (selector, value) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const surface = () => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface`);
  const show = async (view, page) => {
    let current = await surface();
    // The list of watches is its own view; Tillbaka leaves it for wherever it was opened from.
    if (current === 'watches' && view !== 'watches') { await click('.assistant-back'); await until(async () => (current = await surface()) !== 'watches', 'leave the list of watches'); }
    if (view === 'chat' && current !== 'chat') await click(current === 'settings' ? '[data-view="settings"]' : current === 'mail' ? '[data-view="mail"]' : '.assistant-back');
    if (view !== 'chat' && current !== view) await click(`[data-view="${view}"]`);
    if (page) await click(`[data-settings-page="${page}"]`);
    await until(async () => await surface() === view && (!page || await ui(`!document.querySelector('${card} .assistant-settings-page[data-page="${page}"]').hidden`)), `${view}${page ? ` → ${page}` : ''}`);
  };
  const setWeb = async (level, fullAccess = false) => {
    await show('settings', 'web'); await choose('[name="webLevel"]', level);
    await ui(`(()=>{const checkbox=document.querySelector('${card} [name="webFullAccess"]');if(checkbox.checked!==${fullAccess})checkbox.click();})()`);
    await until(() => ui(`document.querySelector('${card} .assistant-workspace').getAttribute('aria-busy')==='false'`), 'panel ready before saving web access');
    await click('[data-settings-part="web"] button[type="submit"]');
    await until(async () => (await status()).assistant.settings.web?.level === level && (await status()).assistant.settings.web?.fullAccess === fullAccess && await ui(`document.querySelector('${card} [data-settings-part="web"] .assistant-settings-status').textContent==='Inställningarna är sparade.'`), `web access ${level}`);
  };
  // Rows are read only in the open list, where the user sees and taps them.
  const watchList = '.assistant-view-watches', watchRow = `${watchList} [data-watch-id]`;
  const visible = selector => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});return !!e&&!e.closest('[hidden]')&&e.getClientRects().length>0;})()`);
  const openList = async () => {
    await show('settings', 'watches');
    await clickText('.assistant-watch-settings button', 'Visa bevakningarna');
    await until(async () => await surface() === 'watches' && await visible(watchList) && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Bevakningar'`), 'Bevakningar opened from Inställningar → Bevakningar');
  };
  // Mejl shows one mail at a time: the sender lookup lives in that mail's ⋯ menu.
  const detail = `${card} .assistant-mail-detail`;
  const openMail = async id => {
    await show('mail');
    if (await ui(`document.querySelector('${card} .assistant-mail-inbox').hidden`)) await click('.assistant-back');
    await click('[data-tab="todo"]');
    await click(`.assistant-mail-inbox [data-item-id="${id}"] .assistant-mail-row`);
    await until(() => ui(`!document.querySelector('${detail}').hidden && document.querySelector('${detail}').dataset.itemId===${JSON.stringify(id)}`), `mail ${id} opened`);
  };
  const lookupOf = () => ui(`(()=>{const button=document.querySelector('${detail} [data-sender-lookup]');return {id:button.closest('[data-item-id]').dataset.itemId,disabled:button.disabled,reason:button.getAttribute('aria-describedby')?document.getElementById(button.getAttribute('aria-describedby'))?.textContent:''};})()`);

  // Watches are proposed on a card in the chat, with the same Godkänn/Avvisa contract as other proposals.
  await setWeb('read');
  await command('correct', { action: 'chat-fixture-watch-card' }); await refresh(); await show('chat');
  await until(() => ui(`!!document.querySelector('${scope} [data-watch-card]')`), 'watch card in the chat');
  const watchCard = await ui(`(()=>{const card=document.querySelector('${scope} [data-watch-card]');return {title:card.querySelector('h3').textContent,detail:card.querySelector('.module-summary').textContent,buttons:[...card.querySelectorAll('.assistant-actions button')].map(button=>button.textContent)};})()`);
  check('a watch card shows title, target, condition, schedule and model with Godkänn and Avvisa', () => {
    assert.equal(watchCard.title, 'Bevaka: Syntetisk produktsida');
    assert.match(watchCard.detail, /Sida: https:\/\/example\.test\/produkt[\s\S]*Villkor: Priset sjunker under 400 kr[\s\S]*Schema: varje dag kl\. 08:00[\s\S]*Modell: Lokal · Qwen3\.5 4B/);
    assert.deepEqual(watchCard.buttons, ['Godkänn', 'Avvisa']);
  });
  await clickText('[data-watch-card] button', 'Godkänn');
  await until(() => ui(`document.querySelector('${scope} [data-watch-card]').dataset.status==='applied'`), 'watch card confirmed');
  // A card the host gave a capacity warning shows it before the buttons; dismissing it saves nothing.
  await command('correct', { action: 'chat-fixture-watch-card', warning: 'Syntetisk varning: schemat hinner inte med.' }); await refresh();
  await until(() => ui(`!![...document.querySelectorAll('${scope} [data-watch-card]')].at(-1)?.querySelector('.assistant-card-warning')`), 'watch card with a warning');
  const warned = await ui(`(()=>{const card=[...document.querySelectorAll('${scope} [data-watch-card]')].at(-1);return {warning:card.querySelector('.assistant-card-warning').textContent,before:!!(card.querySelector('.assistant-card-warning').compareDocumentPosition(card.querySelector('.assistant-actions'))&Node.DOCUMENT_POSITION_FOLLOWING)};})()`);
  await ui(`[...[...document.querySelectorAll('${scope} [data-watch-card]')].at(-1).querySelectorAll('button')].find(button=>button.textContent==='Avvisa').click()`);
  await until(() => ui(`[...document.querySelectorAll('${scope} [data-watch-card]')].at(-1).dataset.status==='dismissed'`), 'warned card dismissed');
  check('a watch card shows the host’s capacity warning above its buttons', () => { assert.equal(warned.warning, 'Syntetisk varning: schemat hinner inte med.'); assert.equal(warned.before, true); });

  // Inställningar → Bevakningar → Visa bevakningarna opens the list with the watch, its schedule, result and actions.
  await openList();
  await until(() => visible(watchRow), 'watch visible in the list');
  const listed = await ui(`(()=>{const row=document.querySelector('${card} ${watchRow}'),shown=element=>!element.closest('[hidden]')&&element.getClientRects().length>0;return {text:row.textContent,href:row.querySelector('a')?.href,state:row.querySelector('.assistant-watch-state').textContent,buttons:[...row.querySelectorAll('button')].map(button=>[button.textContent,button.disabled]),shown:[row,...row.querySelectorAll('button')].every(shown)};})()`);
  const intro = await ui(`document.querySelector('${card} ${watchList} [data-section="watches"]').textContent`);
  check('Bevakningar lists title, target, condition, schedule, last result and status with Kör nu, Pausa and Ta bort', () => {
    assert.match(listed.text, /Syntetisk produktsida[\s\S]*Villkor: Priset sjunker under 400 kr[\s\S]*Varje dag kl\. 08:00 · 1 körning per dygn[\s\S]*Inte körd ännu\./);
    assert.equal(listed.href, 'https://example.test/produkt'); assert.equal(listed.state, 'Aktiv');
    assert.deepEqual(listed.buttons, [['Kör nu', false], ['Pausa', false], ['Ta bort', false]]);
    assert.equal(listed.shown, true, 'the row and its buttons are on screen in the open list');
    assert.match(intro, /Be om en bevakning i chatten[\s\S]*webbåtkomsten i chatten är på/);
  });
  await clickText(`${watchRow} button`, 'Kör nu');
  await until(() => ui(`document.querySelector('${card} ${watchRow} .assistant-watch-result')?.textContent.includes('Syntetiskt resultat: priset är nu 389 kr.')`), 'watch run result');
  assert.match(await ui(`document.querySelector('${card} ${watchRow} .assistant-watch-outcome').textContent`), /^Ändring · /);
  assert.equal(await visible(`${watchList} [data-section="watches"] > button`), true, 'Visa resultaten i samtalet Bevakningar is on screen');
  await click(`${watchList} [data-section="watches"] > button`);
  await until(async () => await surface() === 'chat' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Bevakningar'`), 'Bevakningar conversation');
  const posted = await ui(`(()=>{const message=[...document.querySelectorAll('${scope} .assistant-chat-system')].at(-1);return {text:message.querySelector('.assistant-chat-text')?.textContent,activity:message.querySelector('.assistant-chat-web-activity summary')?.textContent,steps:[...message.querySelectorAll('.assistant-chat-web-activity li')].map(item=>item.textContent)};})()`);
  check('Kör nu reports in the Bevakningar conversation as a system message with collapsed web activity', () => {
    assert.match(posted.text, /^Bevakning: Syntetisk produktsida\nStatus: Ändring\nSyntetiskt resultat/);
    assert.equal(posted.activity, 'Webbaktivitet · 1 steg'); assert.deepEqual(posted.steps, ['Läste https://example.test/produkt']);
  });
  await openList();
  assert.equal(await visible(watchRow), true);
  await clickText(`${watchRow} button`, 'Pausa');
  await until(() => ui(`document.querySelector('${card} ${watchRow} .assistant-watch-state').textContent==='Pausad' && !![...document.querySelectorAll('${card} ${watchRow} button')].find(button=>button.textContent==='Återuppta')`), 'watch paused');
  assert.equal((await status()).chat.watches[0].enabled, false);
  await clickText(`${watchRow} button`, 'Återuppta');
  await until(() => ui(`document.querySelector('${card} ${watchRow} .assistant-watch-state').textContent==='Aktiv'`), 'watch resumed');
  check('Pausa and Återuppta change only the watch’s own state', () => {});
  // The trend: with values the latest numbers and the last step's direction; without them the three latest summaries, folded away.
  await command('correct', { action: 'chat-fixture-watch-history' }); await refresh();
  await until(() => ui(`!!document.querySelector('${card} ${watchRow} .assistant-watch-trend')`), 'trend with values');
  const trend = await ui(`(()=>{const row=document.querySelector('${card} ${watchRow}'),line=row.querySelector('.assistant-watch-trend');return {values:line.querySelector('.assistant-watch-trend-values').textContent,label:line.querySelector('.assistant-watch-trend-label').textContent,direction:line.dataset.direction,spoken:line.querySelector('.visually-hidden')?.textContent,folded:!!row.querySelector('.assistant-watch-history'),shown:line.getClientRects().length>0,beforeActions:!!(line.compareDocumentPosition(row.querySelector('.assistant-actions'))&Node.DOCUMENT_POSITION_FOLLOWING)};})()`);
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'watches-trend', async () => { if (await surface() !== 'watches') await openList(); }, [375, 1440]);
  await command('correct', { action: 'chat-fixture-watch-history', values: 'false' }); await refresh();
  await until(() => ui(`!!document.querySelector('${card} ${watchRow} .assistant-watch-history')`), 'folded history');
  const folded = await ui(`(()=>{const row=document.querySelector('${card} ${watchRow}'),details=row.querySelector('.assistant-watch-history');return {open:details.open,summary:details.querySelector('summary').textContent,entries:[...details.querySelectorAll('li')].map(item=>[item.querySelector('.assistant-watch-outcome').textContent.split(' · ')[0],item.querySelector('.module-summary').textContent]),trend:!!row.querySelector('.assistant-watch-trend')};})()`);
  await command('correct', { action: 'chat-fixture-watch-history', clear: 'true' }); await refresh();
  await until(() => ui(`!document.querySelector('${card} ${watchRow} .assistant-watch-history') && !document.querySelector('${card} ${watchRow} .assistant-watch-trend')`), 'history cleared');
  check('the list shows a trend of the latest values, or the three latest summaries folded away', () => {
    assert.deepEqual(trend, { values: '164 → 120 → 48 öre/kWh ↓', label: 'Trend', direction: 'down', spoken: ', det senaste värdet är lägre', folded: false, shown: true, beforeActions: true });
    assert.deepEqual(folded, { open: false, summary: 'Senaste resultaten (3)', entries: [['Ändring', 'Syntetiskt: priset har sjunkit.'], ['Kunde inte köras', 'Syntetiskt: sidan kunde inte läsas.'], ['Ingen ändring', 'Syntetiskt: inget nytt.']], trend: false });
  });
  // Tabai's own pause after failed runs reads differently from the user's, and Återuppta clears it.
  await command('correct', { action: 'chat-fixture-watch-failures' }); await refresh();
  await until(() => ui(`document.querySelector('${card} ${watchRow}').dataset.state==='paused-failures'`), 'watch paused after failed runs');
  const failing = await ui(`(()=>{const row=document.querySelector('${card} ${watchRow}');return {state:row.querySelector('.assistant-watch-state').textContent,note:row.querySelector('.assistant-watch-failures')?.textContent,outcome:row.querySelector('.assistant-watch-outcome').textContent,buttons:[...row.querySelectorAll('button')].map(button=>button.textContent)};})()`);
  check('a watch Tabai paused after three failed runs says so in the list and can be resumed', () => {
    assert.equal(failing.state, 'Pausad efter misslyckanden');
    assert.equal(failing.note, 'Tabai pausade bevakningen efter 3 misslyckade körningar i rad. Återuppta den när sidan går att läsa igen.');
    assert.match(failing.outcome, /^Kunde inte köras · /); assert.deepEqual(failing.buttons, ['Kör nu', 'Återuppta', 'Ta bort']);
  });
  await clickText(`${watchRow} button`, 'Återuppta');
  await until(() => ui(`document.querySelector('${card} ${watchRow} .assistant-watch-state').textContent==='Aktiv' && !document.querySelector('${card} ${watchRow} .assistant-watch-failures')`), 'resumed after failed runs');
  // More enabled runs an hour than the controller starts: the list warns; without them it does not.
  assert.equal(await visible(`${watchList} .assistant-watch-capacity`), false, 'one daily watch fits');
  await command('correct', { action: 'chat-fixture-watch-capacity' }); await refresh();
  await until(() => visible(`${watchList} .assistant-watch-capacity`), 'capacity warning shown');
  const capacity = await ui(`document.querySelector('${card} ${watchList} .assistant-watch-capacity').textContent`);
  await command('correct', { action: 'chat-fixture-watch-capacity' }); await refresh();
  await until(async () => !await visible(`${watchList} .assistant-watch-capacity`), 'capacity warning gone with the extra watches');
  check('the list warns when the enabled watches need more than twelve runs an hour', () => assert.match(capacity, /fler än 12 körningar i timmen[\s\S]*högst en bevakning var femte minut/));
  // The model and notices stay under Inställningar → Bevakningar.
  await show('settings', 'watches');
  const model = await ui(`({value:document.querySelector('${card} [name="watch-model"]').value,cost:document.querySelector('${card} .assistant-watch-cost').textContent,cloud:document.querySelector('${card} .assistant-watch-cost').dataset.cloud})`);
  await choose('[name="watch-model"]', 'codex:gpt-6.1-terra');
  await until(async () => (await status()).chat.watchModel === 'codex:gpt-6.1-terra' && await ui(`document.querySelector('${card} .assistant-watch-cost').dataset.cloud==='true'`), 'cloud watch model saved');
  const cloud = await ui(`document.querySelector('${card} .assistant-watch-cost').textContent`);
  await choose('[name="watch-model"]', 'local:qwen3.5:4b-q4_K_M');
  await until(async () => (await status()).chat.watchModel === 'local:qwen3.5:4b-q4_K_M', 'local watch model restored');
  check('the watch model defaults to local Qwen 4B and a cloud model shows what every run costs', () => {
    assert.equal(model.value, 'local:qwen3.5:4b-q4_K_M'); assert.equal(model.cloud, 'false');
    assert.match(model.cost, /Lokal · Qwen3\.5 4B\. Körs på den här datorn utan kostnad\. Dina aktiva bevakningar körs 1 gång per dygn\./);
    assert.match(cloud, /Codex · GPT-6\.1 Terra\. Varje körning drar användning av ditt Codex-abonnemang\./);
  });
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings-watches', () => show('settings', 'watches'), [375, 1440]);

  // Kolla upp avsändaren on mail cards: disabled with the reason for private services and with web off.
  const privateId = (await command('correct', { action: 'fixture-private-sender' })).result.description; await refresh();
  const loadedIds = (await status()).assistant.items.map(item => item.id), organizationId = loadedIds.find(id => id !== privateId);
  await openMail(privateId);
  const privateLookup = await lookupOf();
  await openMail(organizationId);
  const openLookup = await lookupOf();
  check('a private mail service disables the lookup with its reason; an organization sender can be looked up', () => {
    assert.equal(privateLookup.id, privateId); assert.equal(privateLookup.disabled, true); assert.match(privateLookup.reason, /gmail\.com är en e-posttjänst för privatpersoner/);
    assert.equal(openLookup.id, organizationId); assert.equal(openLookup.disabled, false, JSON.stringify(openLookup));
  });
  // The menu is placed when it opens, so it opens again after each resize.
  const reopenMenu = async () => {
    await ui(`(()=>{const menu=document.querySelector('${detail} .assistant-mail-menu');if(menu.matches(':popover-open'))menu.hidePopover();})()`);
    await click('.assistant-mail-detail .assistant-mail-more');
    await until(() => ui(`document.querySelector('${detail} .assistant-mail-menu').matches(':popover-open')`), 'mail menu open for the screenshot');
  };
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'mail-lookup', () => openMail(privateId), [375, 1440], reopenMenu);
  await ui(`document.querySelector('${detail} .assistant-mail-menu').hidePopover()`);
  await openMail(organizationId);

  // With web access off, watches pause and lookups explain why they cannot run.
  await setWeb('off'); await openList();
  await until(async () => await visible(`${watchList} .assistant-watch-web`) && await visible(watchRow) && await ui(`document.querySelector('${card} ${watchRow} .assistant-watch-state').textContent==='Webbåtkomsten är avstängd'`), 'watches paused by web access');
  assert.equal(await ui(`[...document.querySelectorAll('${card} ${watchRow} button')].find(button=>button.textContent==='Kör nu').disabled`), true);
  await show('mail');
  assert.equal(await ui(`document.querySelector('${detail}').dataset.itemId`), openLookup.id, 'Mejl reopens on the same mail');
  const offReason = await ui(`(()=>{const button=document.querySelector('${detail}[data-item-id="${openLookup.id}"] [data-sender-lookup]');return {disabled:button.disabled,reason:document.getElementById(button.getAttribute('aria-describedby'))?.textContent};})()`);
  check('with web access off, Kör nu and the lookup are disabled with a way to turn it on', () => {
    assert.equal(offReason.disabled, true); assert.match(offReason.reason, /Slå på webbåtkomsten i chatten under Inställningar → Webbåtkomst/);
  });
  await setWeb('off', true); await openList();
  await until(() => ui(`![...document.querySelectorAll('${card} ${watchRow} button')].find(button=>button.textContent==='Kör nu').disabled`), 'full access enables watches with the guided level off');
  await show('mail');
  await until(() => ui(`!document.querySelector('${detail}[data-item-id="${openLookup.id}"] [data-sender-lookup]').disabled`), 'full access enables sender lookup with the guided level off');
  check('full access enables browser features independently of the saved guided level', () => {});
  await setWeb('read'); await show('mail');
  await until(() => ui(`!document.querySelector('${detail}[data-item-id="${openLookup.id}"] [data-sender-lookup]').disabled`), 'lookup enabled again');
  await click(`.assistant-mail-detail[data-item-id="${openLookup.id}"] [data-sender-lookup]`);
  await until(async () => await surface() === 'chat' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Kolla upp example.test' && document.querySelector('${scope} .assistant-context-chip')?.textContent.startsWith('Mejl: ') && document.querySelector('${scope} .assistant-chat-user')?.textContent.includes('Kolla upp organisationen bakom example.test')`), 'lookup conversation');
  assert.deepEqual((await fixtureState()).lookups.at(-1), openLookup.id);
  check('Kolla upp avsändaren in Mejl opens a scoped conversation through chat-sender-lookup', () => {});

  // The case's mail list offers the same lookup for points loaded in Mejl; Ärenden is under ⋯.
  await show('mail');
  if (await ui(`document.querySelector('${card} .assistant-mail-inbox').hidden`)) await click('.assistant-back');
  await until(() => ui(`!document.querySelector('${card} .assistant-mail-inbox').hidden`), 'Mejl list');
  await click('.assistant-mail-start .assistant-mail-more');
  await until(() => ui(`document.querySelector('${card} .assistant-mail-start .assistant-mail-menu').matches(':popover-open')`), 'start menu open');
  await click('.assistant-mail-start [data-mail-open="cases"]');
  await until(() => ui(`!document.querySelector('${card} .assistant-mail-cases').hidden`), 'Ärenden open');
  await click(`[data-case-id="10000000-0000-4000-8000-000000000000"] button`);
  await until(() => ui(`document.querySelectorAll('${card} .assistant-case-editor [data-link-kind="item"] [data-sender-lookup]').length >= 2`), 'case mail links with lookups');
  const caseLookups = await ui(`[...document.querySelectorAll('${card} .assistant-case-editor [data-link-kind="item"]')].map(row=>{const button=row.querySelector('[data-sender-lookup]');return {id:row.dataset.linkedItemId,disabled:button?.disabled,reason:button?.getAttribute('aria-describedby')?document.getElementById(button.getAttribute('aria-describedby')).textContent:''};})`);
  const loadedLink = caseLookups.find(entry => entry.disabled === false), unloadedLink = caseLookups.find(entry => /inte inläst här/.test(entry.reason));
  check('the case mail list offers the lookup for loaded points and explains unloaded ones', () => { assert.ok(loadedLink, JSON.stringify(caseLookups)); assert.ok(unloadedLink, JSON.stringify(caseLookups)); });
  await click(`.assistant-case-editor [data-linked-item-id="${loadedLink.id}"] [data-sender-lookup]`);
  await until(async () => await surface() === 'chat' && (await fixtureState()).lookups.at(-1) === loadedLink.id, 'lookup from the case');
  check('Kolla upp avsändaren from a case uses the same action', () => {});

  // Receipts are ordinary files; web activity is a typed list, and older text still renders.
  await command('correct', { action: 'chat-fixture-receipt' }); await command('correct', { action: 'chat-fixture-web-activity' }); await refresh();
  await until(() => ui(`[...document.querySelectorAll('${scope} .assistant-sent-file')].some(file=>file.textContent.includes('Kvitto example.test 2026-11-02.pdf'))`), 'receipt file in the chat');
  const rendered = await ui(`({receipt:[...document.querySelectorAll('${scope} .assistant-sent-file')].find(file=>file.textContent.includes('Kvitto'))?.textContent,activity:[...document.querySelectorAll('${scope} .assistant-chat-web-activity summary')].map(summary=>summary.textContent),steps:[...document.querySelectorAll('${scope} .assistant-chat-web-activity li')].map(item=>item.textContent),prefix:[...document.querySelectorAll('${scope} .assistant-chat-text')].some(text=>text.textContent.startsWith('Webbaktivitet:'))})`);
  check('a receipt shows as a PDF file and web activity collapses from the typed field and from older text', () => {
    assert.match(rendered.receipt, /Kvitto example\.test 2026-11-02\.pdf[\s\S]*1 sida/);
    assert.ok(rendered.activity.includes('Webbaktivitet · 2 steg') && rendered.activity.includes('Webbaktivitet · 1 steg'), JSON.stringify(rendered.activity));
    assert.ok(rendered.steps.includes('Sökte med DuckDuckGo: syntetisk produkt') && rendered.steps.includes('Sparad äldre rad'));
    assert.equal(rendered.prefix, false, 'no raw web activity text is shown');
  });
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'chat-features', () => show('chat'), [375, 1440]);

  // The mail quick choices start the task directly and show it as a task in the conversation.
  await command('correct', { action: 'chat-new' }); await refresh(); await show('chat');
  await until(() => ui(`!document.querySelector('${scope} .assistant-chat-empty').hidden && !document.querySelector('${scope} [data-quick-task="my-day"]').disabled`), 'empty chat with quick choices');
  const tasksBefore = (await fixtureState()).quickTasks.length;
  await click('[data-quick-task="my-day"]');
  await until(() => ui(`document.querySelector('${scope} .assistant-chat-task')?.textContent.includes('my-day')`), 'quick task in the conversation');
  const quick = await ui(`({users:document.querySelectorAll('${scope} .assistant-chat-user').length,open:!![...document.querySelectorAll('${scope} .assistant-chat-task button')].find(button=>button.textContent==='Visa i Mejl')})`);
  const after = await fixtureState();
  check('Min dag starts the task through chat-task without a chat message and shows it as a task', () => {
    assert.equal(after.quickTasks.length, tasksBefore + 1); assert.equal(after.quickTasks.at(-1), 'my-day');
    assert.equal(quick.users, 0, 'no chat message is sent'); assert.equal(quick.open, true);
  });
  assert.equal(await ui(`[...document.querySelectorAll('${scope} .assistant-chat-task button')].find(button=>button.textContent==='Visa i Mejl').dataset.mailTarget`), 'run');
  await clickText('.assistant-chat-task button', 'Visa i Mejl');
  await until(async () => await surface() === 'mail' && await ui(`!document.querySelector('${card} .assistant-mail-runs').hidden && document.querySelector('${card} .assistant-topbar-title').textContent==='Kontroller' && document.querySelector('${card} .assistant-overview-run h4')?.textContent.includes('my-day')`), 'task shown in Mejl');
  check('Visa i Mejl on a started task opens its check under Kontroller', () => {});
  await click('.assistant-back');
  await until(() => ui(`!document.querySelector('${card} .assistant-mail-inbox').hidden`), 'back to the list');
  await click('[data-tab="todo"]');

  // Mina uppgifter: Spara and Rensa, with the rules said on the page.
  await show('settings', 'memory');
  const profileText = await ui(`document.querySelector('${card} [data-section="profile"]').textContent`);
  await type('[name="profile-name"]', 'Syntetisk Testperson'); await type('[name="profile-city"]', 'Teststad'); await type('[name="profile-email"]', 'test@example.test');
  await clickText('[data-section="profile"] button', 'Lägg till en egen uppgift');
  await type('[name="profile-extra-label-0"]', 'Kundnummer'); await type('[name="profile-extra-value-0"]', 'T-1');
  assert.equal(await ui(`document.querySelector('${card} [data-settings-page="memory"]').dataset.dirty`), 'true');
  await clickText('[data-section="profile"] button', 'Spara mina uppgifter');
  await until(async () => (await status()).chat.profile?.name === 'Syntetisk Testperson' && await ui(`document.querySelector('${card} .assistant-profile-status').textContent==='Mina uppgifter är sparade privat på datorn.'`), 'profile saved');
  await refresh();
  await until(() => ui(`document.querySelector('${card} [name="profile-city"]').value==='Teststad' && document.querySelector('${card} [name="profile-extra-value-0"]')?.value==='T-1' && document.querySelector('${card} [data-section="profile"]').textContent.includes('Senast sparade')`), 'profile after refresh');
  const savedProfile = (await status()).chat.profile;
  check('Mina uppgifter saves through profile-save and says how the details are used and that passwords and cards are never saved', () => {
    assert.match(profileText, /bara när agenten fyller i ett formulär åt dig på nivån Agera med godkännande/);
    assert.match(profileText, /Lösenord, kortnummer, koder och BankID sparas aldrig/);
    assert.deepEqual({ name: savedProfile.name, city: savedProfile.city, email: savedProfile.email, extra: savedProfile.extra }, { name: 'Syntetisk Testperson', city: 'Teststad', email: 'test@example.test', extra: [{ label: 'Kundnummer', value: 'T-1' }] });
  });
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'settings-memory', async () => { await show('settings', 'memory'); await ui(`document.querySelector('${card} [data-section="profile"]').scrollIntoView({block:'start'})`); }, [375, 1440]);
  const profileClear = await declineThenConfirm({ ui, until }, `[...document.querySelectorAll(${JSON.stringify(`${card} [data-section="profile"] button`)})].find(button=>button.textContent==='Rensa mina uppgifter').click()`, async () => (await status()).chat.profile);
  await until(async () => !(await status()).chat.profile && await ui(`document.querySelector('${card} [name="profile-name"]').value===''`), 'profile cleared');
  check('Rensa removes Mina uppgifter through profile-clear after a confirmation, and answered no keeps them', () => {
    const question = 'Rensa mina uppgifter? Alla sparade fält tas bort från datorn.';
    assert.deepEqual(profileClear, { declined: [question], startedOnNo: false, kept: true, accepted: [question] });
  });

  // Ta bort, after a confirmation that names the watch.
  await openList();
  assert.equal(await visible(watchRow), true);
  const watchTitle = (await status()).chat.watches[0].title;
  const watchDelete = await declineThenConfirm({ ui, until }, `[...document.querySelectorAll(${JSON.stringify(`${card} ${watchRow} button`)})].find(button=>button.textContent==='Ta bort').click()`, async () => (await status()).chat.watches);
  await until(async () => !(await status()).chat.watches.length && await ui(`!document.querySelector('${card} ${watchRow}')`), 'watch deleted');
  check('Ta bort deletes the watch after a confirmation that names it, and answered no keeps it', () => {
    const question = `Ta bort bevakningen ”${watchTitle}”? Tidigare resultat finns kvar i samtalet Bevakningar.`;
    assert.deepEqual(watchDelete, { declined: [question], startedOnNo: false, kept: true, accepted: [question] });
  });
  await setWeb('off');
  await show('chat');
}
