import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function workspacePanelChecks({ ui, rpc, panelSession, until, check, artifactDir }) {
  const card = '[data-module-id="workspace-module"]';
  const field = `${card} textarea[name="request"]`, answer = `${card} textarea[name="answer"]`;
  const type = (selector, value) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'workspace-module', operation, input } })})`);
  await until(() => ui(`!!document.querySelector('${field}')`), 'workspace form');
  const advanced = await ui(`document.querySelector('${card} input[name="option"]').closest('details').open`);
  check('optional settings are collapsed in the simplified start form', () => assert.equal(advanced, false));
  await type(field, 'Ett påbörjat uppdrag');
  await until(async () => (await command('status')).result.drafts.start.values.request === 'Ett påbörjat uppdrag', 'start text saved');
  await rpc('Page.reload', {}, panelSession);
  await until(() => ui(`document.querySelector('${field}')?.value==='Ett påbörjat uppdrag'`), 'unsent start restored');
  check('unsent start text survives panel reload via the private module', () => {});
  await ui(`document.querySelector('${field}').form.requestSubmit()`);
  await until(() => ui(`!!document.querySelector('${answer}')`), 'workspace question');
  const ordering = await ui(`(()=>{const c=document.querySelector('${card}');return !!(c.querySelector('textarea[name="answer"]').compareDocumentPosition(c.querySelector('.module-review'))&Node.DOCUMENT_POSITION_FOLLOWING)})()`);
  check('required question precedes the review and supporting details', () => assert.equal(ordering, true));
  await type(answer, 'Mitt oskickade svar');
  await until(async () => (await command('status')).result.drafts.reply.values.answer === 'Mitt oskickade svar', 'reply text saved');
  await rpc('Page.reload', {}, panelSession);
  await until(() => ui(`document.querySelector('${answer}')?.value==='Mitt oskickade svar'`), 'unsent reply restored');
  check('unsent answer survives panel reload in the same question', () => {});
  await type(answer, 'Simulerat lagringsfel');
  await until(() => ui(`document.querySelector('${answer}').form.textContent.includes('kunde inte sparas')`), 'visible autosave failure');
  check('failed autosave keeps the visible text and does not claim it was saved', () => {});
  await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${answer}').value==='Simulerat lagringsfel'`), 'failed text retained');
  // Allow the real status poll to supply the last committed revision before retry.
  await new Promise(resolve => setTimeout(resolve, 2200));
  await type(answer, 'September');
  await until(async () => (await command('status')).result.drafts.reply.values.answer === 'September', 'retry saved');
  await ui(`[...document.querySelectorAll('${card} .module-choices button')].find(b=>b.textContent==='September').click()`);
  await until(() => ui(`document.querySelector('${card}').textContent.includes('Klart för granskning')`), 'quick answer accepted');
  check('quick answer follows the same persisted reply path', () => {});
  const summary = await ui(`({overview:!!document.querySelector('${card} .review-overview'),collapsed:!document.querySelector('${card} details[data-keep="review"]').open})`);
  check('review has a concise overview and collapsed full evidence', () => { assert.equal(summary.overview,true);assert.equal(summary.collapsed,true); });
  await ui(`(()=>{const e=document.querySelector('${card} input[data-field="subject"]');e.closest('details').open=true;e.value='Korrigerat underlag';e.form.requestSubmit()})()`);
  await until(async () => (await command('status')).result.run.summary === 'Korrigerat underlag', 'individual correction saved');
  check('individual correction persists the updated module summary', () => {});
  // Paging and search go through the card's own Tidigare ärenden controls; the module's filter
  // shows what the panel asked for.
  const historyRows = () => ui(`[...document.querySelectorAll('${card} .module-history li')].map(row=>row.querySelector('h3')?.textContent??row.textContent)`);
  const historyPage = async () => (await command('status')).result.historyPage;
  const pageButtons = () => ui(`[...document.querySelectorAll('${card} button')].map(b=>b.textContent).filter(label=>label==='Föregående sida'||label==='Nästa sida')`);
  await until(() => ui(`!!document.querySelector('${card} input[name="query"]')`), 'history controls');
  await ui(`document.querySelector('${card} input[name="query"]').closest('details').open=true`);
  const firstPage = { rows: (await historyRows()).length, buttons: await pageButtons() };
  await ui(`[...document.querySelectorAll('${card} button')].find(b=>b.textContent==='Nästa sida').click()`);
  await until(async () => (await pageButtons()).includes('Föregående sida'), 'history page rendered');
  const secondPage = { rows: await historyRows(), buttons: await pageButtons(), page: await historyPage() };
  check('Nästa sida pages the history beyond the first twenty records', () => {
    assert.deepEqual(firstPage, { rows: 20, buttons: ['Nästa sida'] });
    assert.deepEqual(secondPage, { rows: [19, 20, 21, 22, 23, 24].map(index => `Tidigare uppdrag ${index}`), buttons: ['Föregående sida'], page: { query: '', archived: false, offset: 20, total: 26 } });
  });
  await ui(`(()=>{const search=document.querySelector('${card} input[name="query"]');search.value='Tidigare uppdrag 24';search.form.querySelector('button[type="submit"]').click();})()`);
  await until(() => ui(`document.querySelectorAll('${card} .module-history li').length===1`), 'history search rendered');
  const searched = { rows: await historyRows(), buttons: await pageButtons(), page: await historyPage() };
  check('Sök in Tidigare ärenden finds the case from the first page', () => {
    assert.deepEqual(searched, { rows: ['Tidigare uppdrag 24'], buttons: [], page: { query: 'Tidigare uppdrag 24', archived: false, offset: 0, total: 1 } });
  });
  await ui(`[...document.querySelectorAll('${card} .module-history button')].find(b=>b.textContent==='Öppna ärendet').click()`);
  await until(async () => (await command('status')).result.run.id==='case-24', 'history selection');
  await until(() => ui(`document.querySelector('${card} .module-case-title')?.textContent==='Tidigare uppdrag 24'`), 'selected title rendered');
  await type(field, 'Nästa uppdrag');
  await ui(`[...document.querySelectorAll('${card} .module-next-action button')].find(b=>b.textContent==='Arkivera ärendet').click()`);
  await until(async () => !(await command('status')).result.run, 'archived case cleared');
  await until(() => ui(`!document.querySelector('${card} .module-case-title')&&document.querySelector('${field}').closest('details').open`), 'new assignment form opened');
  check('archiving from the current card clears it and opens the new assignment form',()=>{});
  await rpc('Page.reload',{},panelSession);
  await until(() => ui(`document.querySelector('${field}')?.value==='Nästa uppdrag'&&!document.querySelector('${card} .module-case-title')`), 'clear selection and unsent start survive reload');
  check('archived card stays hidden after reopening without losing unsent start text',()=>{});
  // Visa: Arkiverade ärenden, with the search kept, finds the archived case.
  await until(() => ui(`!!document.querySelector('${card} input[name="query"]')`), 'history controls after reload');
  await ui(`(()=>{const search=document.querySelector('${card} input[name="query"]'),select=search.form.querySelector('select');search.closest('details').open=true;search.value='Tidigare uppdrag 24';select.value='true';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => ui(`[...document.querySelectorAll('${card} .module-history li')].some(row=>row.textContent.includes('Tidigare uppdrag 24')&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Återställ'))`), 'archived case remains searchable');
  const archivedSearch = { rows: await historyRows(), page: await historyPage() };
  check('Visa: Arkiverade ärenden finds the archived case with the search kept', () => {
    assert.deepEqual(archivedSearch, { rows: ['Tidigare uppdrag 24'], page: { query: 'Tidigare uppdrag 24', archived: true, offset: 0, total: 1 } });
  });
  await ui(`[...document.querySelectorAll('${card} .module-history button')].find(b=>b.textContent==='Öppna ärendet').click()`);
  await until(() => ui(`[...document.querySelectorAll('${card} button')].some(b=>b.textContent==='Återställ ärendet')`), 'archive restored after reload');
  await ui(`[...document.querySelectorAll('${card} button')].find(b=>b.textContent==='Återställ ärendet').click()`);
  await until(async () => (await command('status')).result.run.archived===false, 'case restored');
  check('history selection, archiving and restoration work through panel buttons', () => {});
  // A generic module is shown under its assistant host's Lokala verktyg view.
  await ui(`(()=>{const host=document.querySelector('${card}').closest('.assistant-workspace');const select=host.querySelector('[name="inline-module"]');select.value='workspace-module';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => ui(`(()=>{const element=document.querySelector('${card}'),host=element.closest('.assistant-workspace');return host.dataset.surface==='tools'&&!element.closest('[hidden]')&&element.getBoundingClientRect().height>0;})()`), 'workspace module shown under Lokala verktyg');
  check('a local module opens in its own Lokala verktyg view', () => {});
  if (artifactDir) mkdirSync(artifactDir,{recursive:true});
    for(const width of [375,768,1440]) {
      await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},panelSession);
      await ui(`document.querySelector('${card}').scrollIntoView()`);
      const layout=await ui(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`);assert.ok(layout.scroll<=layout.width);
      if (artifactDir) {
        const capture=await rpc('Page.captureScreenshot',{format:'png'},panelSession);
        writeFileSync(join(artifactDir,`workspace-${width}.png`),Buffer.from(capture.data,'base64'));
      }
    }
  check('workspace controls fit narrow and wide panel viewports',()=>{});
  const message = `${card} textarea[name="message"]`;
  await until(() => ui(`!!document.querySelector('${message}')`), 'free-text box on the run');
  await type(message, 'Varför stannade det?');
  await ui(`document.querySelector('${message}').form.requestSubmit()`);
  await until(() => ui(`[...document.querySelectorAll('${card} .module-chat-log li')].some(entry=>entry.dataset.role==='agent'&&entry.textContent==='Svar på: Varför stannade det?')&&document.querySelector('${message}').value===''`), 'agent words on the card');
  check('a run takes free text on its card and shows the dialogue', () => {});
  await ui(`[...document.querySelectorAll('${card} .module-chat button')].find(b=>b.textContent==='Chatta om ärendet').click()`);
  const host = `document.querySelector('${card}').closest('.assistant-workspace')`, chatView = `${host}.querySelector('.assistant-view-chat')`;
  await until(() => ui(`${host}.dataset.surface==='chat'&&${chatView}.querySelector('.assistant-case-chip')?.textContent.includes('Skriver till ärendet')`), 'linked conversation opens');
  await until(() => ui(`${chatView}.textContent.includes('Svar på: Varför stannade det?')`), 'earlier dialogue mirrored into the linked conversation');
  check('the card opens a conversation linked to its run, marked in the composer, with the dialogue so far', () => {});
  await ui(`(()=>{const e=${chatView}.querySelector('[name="chat-message"]');e.value='Hur går det?';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => ui(`!${chatView}.querySelector('.assistant-chat-composer button[type="submit"]').disabled`), 'composer ready for the linked run');
  await ui(`${chatView}.querySelector('.assistant-chat-composer').requestSubmit()`);
  await until(() => ui(`${chatView}.textContent.includes('Svar på: Hur går det?')&&${chatView}.querySelector('[name="chat-message"]').value===''`), 'reply through the real host');
  const mirrored = await ui(`(${chatView}.textContent.match(/Svar på: Hur går det/g)||[]).length`);
  check('a linked conversation sends through the real host and broker and shows the reply once', () => assert.equal(mirrored, 1));
  await until(() => ui(`[...${chatView}.querySelectorAll('article')].at(-1).querySelector('[data-chat-module-id="workspace-module"]')!==null`), 'card below the dialogue');
  check('the run card follows the dialogue in the live panel', () => {});
  await ui(`${chatView}.querySelector('.assistant-case-chip button').click()`);
  await until(() => ui(`!${chatView}.querySelector('.assistant-case-chip')`), 'leaving the linked run');
  await ui(`(()=>{const host=document.querySelector('${card}').closest('.assistant-workspace');const select=host.querySelector('[name="inline-module"]');select.value='workspace-module';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => ui(`document.querySelector('${card}').closest('.assistant-workspace').dataset.surface==='tools'`), 'back in the tools view');
  await ui(`document.querySelector('${card}').closest('.assistant-workspace').querySelector('.assistant-back').click()`);
  await until(() => ui(`document.querySelector('${card}').closest('.assistant-workspace').dataset.surface==='chat'`), 'tools host returns to its chat');
  // A working case: the module's reason it cannot be archived, then Avbryt och arkivera behind a kept confirmation.
  await ui(`(()=>{const host=document.querySelector('${card}').closest('.assistant-workspace');const select=host.querySelector('[name="inline-module"]');select.value='workspace-module';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const runId = (await command('status')).result.run.id, nextAction = `${card} .module-next-action`;
  // A module may name its resume button.
  await command('correct', { field: 'resume-label', value: 'Skapa svarsutkast' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`[...document.querySelectorAll('${nextAction} button.primary')].some(b=>b.textContent==='Skapa svarsutkast')&&![...document.querySelectorAll('${nextAction} button')].some(b=>b.textContent==='Fortsätt ärendet')`), 'module-named resume button');
  await command('correct', { field: 'resume-label', value: '' });
  check('a module may name the resume button', () => {});
  await command('resume', { 'run-id': runId, blocked: 'true', nostop: 'true' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('${nextAction} .module-archive-blocked')?.textContent.includes('kan inte avbrytas')&&![...document.querySelectorAll('${nextAction} button, ${nextAction} summary')].some(b=>/arkivera|Stoppa/i.test(b.textContent))`), 'blocked archive explained');
  check('a case the module cannot archive now says why instead of offering Arkivera, and canStop false hides Stoppa', () => {});
  await command('resume', { 'run-id': runId }); await command('history', { query: 'Tidigare uppdrag 24', archived: 'false' });
  await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`(()=>{const c=document.querySelector('${card}'),confirm=c.querySelector('.module-next-action .module-archive-confirm'),row=[...c.querySelectorAll('.module-history li')].find(li=>li.textContent.includes('Tidigare uppdrag 24'));return !!confirm&&!confirm.open&&confirm.querySelector('summary').textContent==='Avbryt och arkivera'&&[...c.querySelectorAll('.module-next-action button')].some(b=>b.textContent==='Stoppa efter pågående åtgärd')&&!![...c.querySelectorAll('.module-next-action button')].every(b=>b.textContent!=='Arkivera ärendet')&&!!row?.querySelector('.module-archive-confirm')&&[...row.querySelectorAll('button')].every(b=>b.textContent!=='Arkivera');})()`), 'working case offers Avbryt och arkivera');
  check('a working case offers Avbryt och arkivera on its card and its history row instead of Arkivera', () => {});
  await ui(`(()=>{const confirm=document.querySelector('${nextAction} .module-archive-confirm');confirm.querySelector('summary').click();[...confirm.querySelectorAll('button')].find(b=>b.textContent==='Ja, avbryt och arkivera').focus();})()`);
  await command('message', { 'run-id': runId, 'message-id': randomUUID(), message: 'Pågår det?' }); await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`[...document.querySelectorAll('${card} .module-chat-log li')].some(entry=>entry.textContent==='Svar på: Pågår det?')`), 'card re-rendered after a change');
  const kept = await ui(`(()=>{const confirm=document.querySelector('${nextAction} .module-archive-confirm');return {open:confirm.open,focus:confirm.contains(document.activeElement)&&document.activeElement.textContent==='Ja, avbryt och arkivera'};})()`);
  check('an opened archive confirmation survives the card re-rendering with keyboard focus on its button', () => assert.deepEqual(kept, { open: true, focus: true }));
  await ui(`[...document.querySelectorAll('${nextAction} .module-archive-confirm button')].find(b=>b.textContent==='Ja, avbryt och arkivera').click()`);
  await until(async () => !(await command('status')).result.run, 'working case archived');
  const archived = (await command('history', { query: 'Tidigare uppdrag 24', archived: 'true' })).result.history.some(item => item.id === runId);
  await command('history', { query: '', archived: 'false' });
  check('confirming Avbryt och arkivera archives the working case', () => assert.equal(archived, true));
}
