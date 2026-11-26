import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assistantCasesFixtureCommand, assistantCasesFixtureView } from './assistant-cases-panel-live.mjs';
import { capturePanelShots, chatFixture, chatFixtureCommand, chatFixturePreview } from './assistant-chat-panel-live.mjs';
import { assistantMailMethodsFixtureCommand, assistantMailMethodsPanelChecks } from './assistant-mail-methods-panel-live.mjs';

// A private JSONL fixture exercises the panel transport without opening a mailbox.
// All accounts, source text and send receipts below are explicitly test evidence.
export function assistantFixtureWorkspace() {
  return { revision: 0, settings: { accounts: [], lookbackDays: 7, followupDays: 3, timezone: 'Europe/Stockholm', tone: '', autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: '' }, items: [], shortcuts: [], history: [], lastChecks: {}, feedbackEvents: [], openedWork: false };
}
export function assistantFixtureItem(id = 'fixture-reply') {
  return { id, revision: 0, accountId: 'fixture-gmail', threadId: id, kind: 'reply', title: 'Isolerat svarsförslag', summary: 'Testunderlag från en tom lokal brevlåda.', reason: 'Behöver ett granskat svar.', priority: 1, sourceUrl: 'https://example.test/thread', sender: 'avsandare@example.test', recipient: 'mottagare@example.test', draft: 'Förslag från isolerad fixture.', sources: [{ observationId: 'fixture-observation', quote: '<img src=x onerror="alert(1)"> Testunderlag.' }], status: 'open', updatedAt: '2026-11-01T09:00:00.000Z' };
}
function fixtureView(workspace) {
  const { itemPage, feedbackEvents, openedWork, openedHelp, resumes, fixtureLocal, fixtureChat, fixtureMailMethods, quickTasks, lookups, reopens, bulk, sends, opens, resolves, ...assistant } = workspace;
  if (workspace.items.length > 10) {
    const offset = itemPage?.offset || 0, total = workspace.items.length;
    assistant.items = workspace.items.slice(offset, offset + 10);
    assistant.itemPage = { offset, total, ...(offset + 10 < total ? { nextOffset: offset + 10 } : {}) };
  }
  // Older module views have no localRuntime; the panel must render both shapes.
  return { title: 'Isolerad testassistent', description: 'Testar panelen utan riktiga konton.', startLabel: 'Starta', fields: [], assistant: assistantCasesFixtureView(workspace, assistant), ...(fixtureLocal ? { localRuntime: fixtureLocal } : {}), chat: chatFixture(workspace) };
}

async function runFixture(file) {
  const { createInterface } = await import('node:readline');
  let workspace = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : assistantFixtureWorkspace();
  const commands = [];
  // Test-only: while on, every draft save fails, so a typed reply stays unsaved in the panel.
  let failDrafts = false;
  // Test-only: the answer to the next send waits until the test releases it. The send itself is
  // done and recorded at once, as by a host that has sent the mail but not yet answered the panel.
  let holdSend = false, releaseSend;
  // Test-only, the same for any action the test names: the next request for it is done at once and
  // its answer waits for the release. An armed action maps to undefined, a reached one to its release.
  const holds = new Map();
  // Every start, finish and remove of an upload that reached the host, in order.
  const fileRequests = [];
  const command = (operation, input) => {
    if (operation === 'draft') throw new Error('Generic module drafts must never be dispatched for the assistant');
    if (operation === 'status' && input.chatPreview) {
      // The panel's own read of a card image: a piece in this reply only, never in the polled view.
      const view = fixtureView(workspace); view.chat.preview = chatFixturePreview(workspace, input);
      writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); return view;
    }
    if (operation === 'status') return fixtureView(workspace);
    try {
      if (assistantMailMethodsFixtureCommand(workspace, operation, input)) { workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); return fixtureView(workspace); }
    } catch (error) {
      // A refused method write can follow a concurrent store revision; persist that view for the next poll.
      writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); throw error;
    }
    const caseResult = assistantCasesFixtureCommand(workspace, operation, input);
    if (caseResult !== false) { workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); return { ...fixtureView(workspace), ...caseResult }; }
    if (operation === 'history') {
      if (input.action === 'fixture-state') return { ...fixtureView(workspace), description: JSON.stringify({ feedbackEvents: workspace.feedbackEvents, openedWork: workspace.openedWork, openedHelp: workspace.openedHelp, resumes: workspace.resumes ?? [], quickTasks: workspace.quickTasks ?? [], lookups: workspace.lookups ?? [], reopens: workspace.reopens ?? [], bulk: workspace.bulk ?? [], previewReads: workspace.fixtureChat?.previewReads ?? 0, sends: workspace.sends ?? [], opens: workspace.opens ?? [], resolves: workspace.resolves ?? [], mailMethodRequests: workspace.fixtureMailMethods?.requests ?? [] }) };
      // The held answers waiting for a release, and the upload actions that reached the host for one
      // file: kept apart from fixture-state, so the 4000 characters a view's description may hold suffice.
      if (input.action === 'fixture-holds') return { ...fixtureView(workspace), description: JSON.stringify({ holding: [...holds].filter(([, release]) => release).map(([action]) => action), fileRequests: fileRequests.filter(entry => entry.fileId === input.fileId).map(entry => entry.action) }) };
      if (input.action === 'fixture-hold') holds.set(input.hold, undefined);
      if (input.action === 'fixture-release') { const release = holds.get(input.hold); holds.delete(input.hold); release?.(); }
      if (input.offset !== undefined) { workspace.itemPage = { offset: Math.max(0, Number(input.offset)), total: workspace.items.length }; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); }
      // Test-only: a running check reads one more thread, as the host reports on each poll.
      if (input.action === 'fixture-threads') { assert.equal(workspace.current?.status, 'running'); workspace.current.activity.reviewedThreads = Number(input.threads); workspace.current.updatedAt = new Date().toISOString(); workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); }
      // Test-only: a reply alone at its own address, so a local case can be linked to it, put first and taken away again.
      if (input.action === 'fixture-handled') {
        workspace.items = workspace.items.filter(item => item.id !== 'fixture-handled');
        if (input.present === 'true') workspace.items.unshift({ ...assistantFixtureItem('fixture-handled'), title: 'Svar på ett avslutat ärende', sourceUrl: 'https://example.test/handled' });
        workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 });
      }
      if (input.action === 'fixture-draft-failure') failDrafts = input.fail === 'true';
      if (input.action === 'fixture-send-hold') holdSend = true;
      if (input.action === 'fixture-send-release') { holdSend = false; releaseSend?.(); releaseSend = undefined; }
      // Test-only: a reply Tabai has no proposal for, put first and taken away again, so the
      // rest of the suite still sees its ten mails on one page.
      // Test-only: open reply cards for mail that had been opened without a reply, as the host counts them.
      if (input.action === 'fixture-opened') {
        if (Number(input.count)) workspace.openedUnanswered = Number(input.count); else delete workspace.openedUnanswered;
        workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 });
      }
      if (input.action === 'fixture-self') {
        workspace.items = workspace.items.filter(item => item.id !== 'fixture-self');
        if (input.present === 'true') workspace.items.unshift({ ...assistantFixtureItem('fixture-self'), title: 'Svar utan förslag', draft: undefined });
        workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 });
      }
      // Test-only: the uncertain send back as it was, optionally with a later message found in its thread.
      if (input.action === 'fixture-uncertain') {
        const item = workspace.items.find(entry => entry.id === 'fixture-uncertain');
        item.status = 'uncertain'; item.revision++; delete item.pendingFinding;
        if (input.pending === 'true') { const { id: _id, revision: _revision, status: _status, updatedAt: _updatedAt, ...later } = assistantFixtureItem('fixture-uncertain'); item.pendingFinding = { ...later, messageId: 'fixture-later-message', title: 'Ny fråga i tråden' }; }
        workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 });
      }
      return fixtureView(workspace);
    }
    commands.push({ operation, input: input.action === 'berget-key' ? { ...input, key: '[redacted]' } : input });
    if (operation === 'correct' && ['chat-file-start', 'chat-file-finish', 'chat-file-remove'].includes(input.action)) fileRequests.push({ action: input.action, fileId: input.fileId });
    if (operation === 'correct' && input.action === 'chat-task') {
      // The quick choice uses the start path itself and records the task in the conversation.
      const chat = workspace.fixtureChat, conversation = chat.records.find(record => record.id === input.conversationId); assert.ok(conversation);
      if (chat.records.some(record => record.messages.some(message => message.id === input.messageId))) return fixtureView(workspace);
      assert.ok(['check-mail', 'my-day'].includes(input.task));
      command('start', { task: input.task, windowId: input.windowId });
      (workspace.quickTasks ||= []).push(input.task);
      conversation.messages.push({ id: input.messageId, role: 'system', text: `Startat: ${workspace.current.label}`, createdAt: new Date().toISOString(), status: 'complete', task: { id: randomUUID(), label: workspace.current.label, model: 'codex:gpt-6.1-terra' } });
      workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); return fixtureView(workspace);
    }
    // Like the host: a quiet upload chunk is answered with the smallest valid view, never the full one.
    if (operation === 'correct' && input.action === 'chat-file-chunk' && input.quiet === 'true' && chatFixtureCommand(workspace, operation, input)) {
      workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 });
      return { title: 'Isolerad testassistent', description: 'Testar panelen utan riktiga konton.', startLabel: 'Starta', fields: [] };
    }
    if (chatFixtureCommand(workspace, operation, input)) { workspace.revision++; writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); return fixtureView(workspace); }
    if (operation === 'correct') {
      if (input.action === 'settings') {
        assert.equal(Number(input.revision), workspace.revision); workspace.settings = JSON.parse(input.settings);
      } else if (input.action === 'save-shortcut') {
        const id = input.id || 'fixture-shortcut', previous = workspace.shortcuts.findIndex(shortcut => shortcut.id === id), shortcut = { id, label: input.label, instructions: input.instructions };
        if (previous < 0) workspace.shortcuts.push(shortcut); else workspace.shortcuts[previous] = shortcut;
      } else if (input.action === 'delete-shortcut') workspace.shortcuts = workspace.shortcuts.filter(shortcut => shortcut.id !== input.id);
      else if (input.action === 'dismiss-many') {
        // Same contract as the host: every revision must match before anything changes.
        const targets = JSON.parse(input.items), items = targets.map(target => workspace.items.find(item => item.id === target.id));
        assert.ok(targets.length && targets.length <= 100 && items.every((item, index) => item && item.revision === targets[index].revision && !['sending', 'sent', 'uncertain'].includes(item.status)));
        for (const item of items) { item.status = 'dismissed'; item.revision++; }
        (workspace.bulk ||= []).push(targets.map(target => target.id));
      } else {
        // Every send that reaches the host is recorded before any check, so a second one is counted even when refused.
        if (input.action === 'send') (workspace.sends ||= []).push({ itemId: input.itemId, body: input.body, revision: Number(input.revision), ...(input.sender ? { sender: input.sender } : {}) });
        const item = workspace.items.find(item => item.id === input.itemId); assert.ok(item); assert.equal(Number(input.revision), item.revision);
        if (input.action === 'draft') { if (input.body === 'Simulerat lagringsfel' || failDrafts) throw new Error('Isolerat lagringsfel'); item.draft = input.body; }
        if (input.action === 'feedback') {
          assert.ok(['no-reply', 'prioritize-sender', 'shorter'].includes(input.kind));
          workspace.feedbackEvents.push({ itemId: item.id, kind: input.kind });
          if (input.kind === 'no-reply') { item.feedback = 'no-reply'; item.status = 'dismissed'; }
          if (input.kind === 'shorter') workspace.settings.preferences = { shortReplies: workspace.settings.preferences?.shortReplies ?? false, senderRules: workspace.settings.preferences?.senderRules ?? [], ...workspace.settings.preferences, shortReplies: true };
          if (input.kind === 'prioritize-sender') workspace.settings.preferences = { shortReplies: workspace.settings.preferences?.shortReplies ?? false, senderRules: workspace.settings.preferences?.senderRules ?? [], ...workspace.settings.preferences, senderRules: [{ accountId: item.accountId, email: item.sender, priority: 'high' }] };
        }
        if (input.action === 'dismiss') item.status = 'dismissed';
        if (input.action === 'reopen') { assert.equal(item.status, 'dismissed'); item.status = 'open'; delete item.feedback; (workspace.reopens ||= []).push(item.id); }
        if (input.action === 'snooze') { item.status = 'snoozed'; item.snoozedUntil = input.until; }
        if (input.action === 'send') { assert.equal(input.recipient, item.recipient); assert.equal(item.status, 'open'); assert.ok(!item.question); item.draft = input.body; item.status = 'sent'; item.sendReceipt = 'Isolerad fixture: inget meddelande skickades.'; }
        // Same contract as the host: only an uncertain send, at its revision; nothing is sent.
        if (input.action === 'resolve-uncertain') {
          assert.equal(item.status, 'uncertain'); assert.ok(['sent', 'not-sent'].includes(input.outcome));
          (workspace.resolves ||= []).push({ itemId: item.id, revision: Number(input.revision), outcome: input.outcome });
          item.status = input.outcome === 'sent' ? 'sent' : 'open'; delete item.pendingFinding;
        }
        item.revision++; item.updatedAt = new Date().toISOString();
      }
    }
    if (operation === 'open') {
      if (input.helpAccountId) { assert.equal(input.helpAccountId, workspace.current.help.accountId); workspace.openedHelp = { accountId: input.helpAccountId, tabId: workspace.current.help.tabId }; }
      if (input.work === 'true') workspace.openedWork = true;
      else if (input.accountId) (workspace.opens ||= []).push({ accountId: input.accountId, ...(input.itemId ? { itemId: input.itemId } : {}) });
    }
    if (operation === 'start') {
      const old = workspace.current; if (old) workspace.history.unshift(old);
      const now = new Date().toISOString(), coverage = workspace.settings.accounts.filter(account => account.enabled).map((account, index) => ({ accountId: account.id, status: index === 2 ? 'unsupported' : index ? 'login' : 'checked', message: index === 2 ? 'Testvyn stöds inte.' : index ? 'Logga in i testkontot.' : 'Isolerad kontroll genomförd.', ...(index ? {} : { checkedAt: now }) }));
      workspace.current = { externalEffect: 'none', id: `fixture-${workspace.revision}`, task: input.task, label: `Isolerat uppdrag: ${input.task}`, status: 'review', message: 'Testkontrollen är klar.', summary: 'Endast isolerat testunderlag.', instructions: input.windowId, startedAt: now, updatedAt: now, coverage, accountProgress: [{ accountId: 'fixture-gmail', reviewedThreads: 3 }, { accountId: 'fixture-outlook', reviewedThreads: 2 }, { accountId: 'fixture-zoho', reviewedThreads: 4 }], activity: { stage: 'complete', message: 'Testkontrollen är klar.', updatedAt: now, reviewedThreads: input.task === 'check-mail' ? 7 : 2 } };
      if (input.task === 'check-mail') {
        workspace.items = [assistantFixtureItem(), { ...assistantFixtureItem('fixture-question'), title: 'Fråga innan svar', question: 'Vilken dag gäller det?' }, { ...assistantFixtureItem('fixture-uncertain'), title: 'Oklart utfall', status: 'uncertain' }, { ...assistantFixtureItem('fixture-action'), kind: 'action', draft: undefined, title: 'Isolerad åtgärd' }, { ...assistantFixtureItem('fixture-priority'), title: 'Prioriteringsfeedback', draft: 'Ett prioriterat testförslag.', replyFrom: 'alias@example.test' }, { ...assistantFixtureItem('fixture-shorter'), title: 'Kortare svar-feedback', draft: 'Ett längre testförslag.' }, { ...assistantFixtureItem('fixture-no-reply'), title: 'Återkoppling utan svarsbehov' },
          ...[1, 2, 3].map(index => ({ ...assistantFixtureItem(`fixture-info-${index}`), kind: 'information', priority: 3, draft: undefined, recipient: undefined, sender: `Nyhetsbrev ${index} <nyhetsbrev${index}@example.test>`, title: `Isolerat nyhetsbrev ${index}`, ...(index === 2 ? { accountId: 'fixture-outlook', sourceUrl: 'https://outlook.office.com/mail/' } : {}) }))];
        Object.assign(workspace.lastChecks, { 'check-mail:fixture-outlook': '2026-10-30T08:00:00.000Z', 'follow-ups:fixture-outlook': '2026-10-31T08:00:00.000Z', 'my-day:fixture-zoho': '2026-10-29T08:00:00.000Z', 'follow-ups:fixture-zoho': '2026-10-31T08:00:00.000Z' });
      }
      if (input.task === 'follow-ups-help') {
        workspace.current.task = 'follow-ups';
        workspace.current.status = 'waiting'; workspace.current.help = { accountId: 'fixture-outlook', message: 'Öppna den parkerade tråden och visa hela konversationen.', code: 'expand-thread', sourceUrl: 'https://example.test/work' };
        workspace.current.help.tabId = 87;
        workspace.current.activity = { stage: 'waiting', message: 'Väntar på hjälp i den parkerade tråden.', updatedAt: now, reviewedThreads: 2, accountId: 'fixture-outlook' };
      }
      if (input.task === 'check-mail-running') {
        workspace.current.task = 'check-mail'; workspace.current.status = 'running'; workspace.current.message = 'Läser testmejl.';
        workspace.current.activity = { stage: 'reading', message: 'Läser testmejl.', updatedAt: now, reviewedThreads: 2 };
      }
      if (input.task === 'prepare-meeting') { workspace.current.status = 'waiting'; workspace.current.question = 'Vilket testmöte gäller det?'; workspace.current.questionId = 'fixture-current-question'; }
      if (input.task === 'custom' && input.instructions === 'Isolerad pagineringskontroll') { workspace.items = Array.from({ length: 25 }, (_, index) => ({ ...assistantFixtureItem(`fixture-page-${index}`), title: `Isolerad sparad punkt ${index + 1}`, kind: 'information', draft: undefined })); delete workspace.itemPage; }
      for (const item of coverage) if (item.status === 'checked') workspace.lastChecks[`${input.task}:${item.accountId}`] = now;
    }
    if (operation === 'reply') {
      if (input.questionId) { assert.equal(input.questionId, workspace.current.questionId); delete workspace.current.question; delete workspace.current.questionId; workspace.current.status = 'review'; }
      else { const item = workspace.items.find(item => item.id === input.itemId); assert.equal(Number(input.revision), item.revision); item.answer = input.answer; delete item.question; item.revision++; }
    }
    if (operation === 'stop') workspace.current.status = 'paused';
    if (operation === 'resume') {
      if (workspace.current.help) {
        assert.equal(input.runId, workspace.current.id); assert.equal(input.helpAccountId, workspace.current.help.accountId);
        (workspace.resumes ||= []).push({ runId: input.runId, helpAccountId: input.helpAccountId });
      }
      if (input.model) workspace.current.model = input.model; workspace.current.status = 'review'; delete workspace.current.question; delete workspace.current.questionId; delete workspace.current.help;
    }
    workspace.revision++;
    writeFileSync(file, JSON.stringify(workspace), { mode: 0o600 }); return fixtureView(workspace);
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async line => {
    const request = JSON.parse(line);
    if (request.operation === 'correct' && request.input?.action === 'draft' && request.input?.body === 'Första långsamma utkastet') await new Promise(resolve => setTimeout(resolve, 1000));
    let reply;
    try { reply = { id: request.id, ok: true, result: command(request.operation, request.input || {}) }; }
    catch (error) { reply = { id: request.id, ok: false, error: String(error) }; }
    if (request.operation === 'correct' && request.input?.action === 'send' && holdSend) { holdSend = false; await new Promise(resolve => { releaseSend = resolve; }); }
    const held = request.operation === 'correct' ? request.input?.action : undefined;
    if (held && holds.has(held) && !holds.get(held)) await new Promise(resolve => holds.set(held, resolve));
    process.stdout.write(JSON.stringify(reply) + '\n');
  });
  lines.on('close', () => process.exit(0));
}

export async function assistantPanelChecks({ ui, rpc, panelSession, until, check, artifactDir }) {
  const card = '[data-module-id="assistant-fixture"]';
  const command = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'assistant-fixture', operation, input } })})`);
  const fixtureState = async () => JSON.parse((await command('history', { action: 'fixture-state' })).result.description);
  const type = (selector, value) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click = label => ui(`[...document.querySelectorAll('${card} button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  const refresh = () => ui(`document.querySelector('#refresh').click()`);
  const openSettingsPage = async page => {
    await ui(`(()=>{const card=document.querySelector('${card}');if(card.querySelector('.assistant-workspace').dataset.surface!=='settings')card.querySelector('[data-view="settings"]').click();})()`);
    await until(() => ui(`!document.querySelector('${card} .assistant-view-settings').hidden`), 'settings open');
    await ui(`document.querySelector('${card} [data-settings-page="${page}"]').click()`);
    await until(() => ui(`!document.querySelector('${card} .assistant-settings-page[data-page="${page}"]').hidden`), `settings page ${page}`);
  };
  const savePart = async part => {
    const status = `${card} [data-settings-part="${part}"] .assistant-settings-status`;
    await until(() => ui(`document.querySelector('${card} .assistant-workspace').getAttribute('aria-busy')==='false'&&!document.querySelector('${card} [data-settings-part="${part}"] button[type="submit"]').disabled`), `${part} save enabled`);
    await ui(`document.querySelector('${card} [data-settings-part="${part}"] button[type="submit"]').click()`);
    await until(() => ui(`document.querySelector(${JSON.stringify(status)}).textContent==='Inställningarna är sparade.'`), `${part} settings saved`);
  };
  await until(() => ui(`!!document.querySelector('${card} .assistant-workspace')`), 'assistant workspace');
  assert.equal(await ui(`document.querySelector('${card} .assistant-view-chat').hidden`), false);
  assert.equal(await ui(`document.querySelectorAll('${card} .assistant-nav').length`), 0);
  const opening = await ui(`(()=>{const card=document.querySelector('${card}');return {header:card.querySelectorAll('.assistant-workspace > header').length,controls:[...card.querySelectorAll('.assistant-topbar button')].filter(button=>button.getClientRects().length).map(button=>button.getAttribute('aria-label')||button.textContent),quick:[...card.querySelectorAll('.assistant-quick button')].map(button=>button.textContent),setup:!!card.querySelector('.assistant-view-mail [data-setup="accounts"] button')};})()`);
  check('assistant starts in one main chat with an honest setup state and disabled tasks', () => {
    assert.equal(opening.header, 1);
    assert.ok(opening.controls.includes('Inställningar') && opening.controls.some(label => label.startsWith('Mejl')));
    assert.deepEqual(opening.quick, ['Kolla mina mejl', 'Min dag', 'Förbered möte', 'Sök och sammanfatta', 'Hitta billigast']);
    assert.equal(opening.setup, true);
  });
  assert.equal(await ui(`document.querySelector('${card} [data-task="check-mail"]').disabled`), true);
  await ui(`document.querySelector('${card} [data-setup="accounts"] button').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-settings-page[data-page="accounts"]').hidden && document.querySelector('${card} .assistant-topbar-title').textContent==='Mejlkonton'`), 'setup leads to the account settings');
  await ui(`document.querySelector('${card} .assistant-back').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-settings-list').hidden`), 'back returns to the settings list');
  await ui(`document.querySelector('${card} [data-view="settings"]').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-view-chat').hidden`), 'settings toggle returns to chat');
  check('the account setup route opens Inställningar → Mejlkonton and back returns one step', () => {});
  await until(() => ui(`!!document.querySelector('${card} [data-pending-module="test-module"]')`), 'other agent review in decisions');
  await ui(`document.querySelector('${card} [data-pending-module="test-module"] button').click()`);
  const moduleOpenState = (hostSelector = card) => ui(`(() => {
    const workspace = document.querySelector(${JSON.stringify(hostSelector)});
    const module = document.querySelector('[data-module-id="test-module"]');
    const tools = workspace?.querySelector('.assistant-view-tools');
    const selected = workspace?.querySelector('[name="inline-module"]')?.value;
    const answer = module?.querySelector('textarea[name="answer"]');
    const heading = module?.querySelector('h2');
    const target = answer || heading;
    const rect = element => { if (!element) return null; const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
    const describe = element => element ? { tag: element.tagName, id: element.id, name: element.getAttribute('name'), moduleId: element.closest('[data-module-id]')?.dataset.moduleId, text: element.textContent?.slice(0, 200) } : null;
    const ancestors = [];
    for (let element = target; element && ancestors.length < 40; element = element.parentElement) {
      const style = getComputedStyle(element);
      ancestors.push({ tag: element.tagName, id: element.id, className: element.className, hidden: element.hidden,
        display: style.display, visibility: style.visibility,
        closedDetails: element.tagName === 'DETAILS' && !element.open && !element.querySelector('summary')?.contains(target) });
    }
    const hiddenAncestor = ancestors.some(element => element.hidden || element.display === 'none' || element.visibility === 'hidden' || element.visibility === 'collapse' || element.closedDetails);
    const targetRect = rect(target);
    const rendered = !!module?.isConnected && !!workspace?.querySelector('.assistant-inline-module')?.contains(module) && !!targetRect && targetRect.width > 0 && targetRect.height > 0;
    const active = describe(document.activeElement);
    return { ready: selected === 'test-module' && !!tools && !tools.hidden && rendered && !hiddenAncestor && active?.moduleId === 'test-module',
      selected, toolsOpen: !!tools && !tools.hidden, rendered, hiddenAncestor, ancestors, moduleRect: rect(module), headingRect: rect(heading), answerRect: rect(answer), target: describe(target), active,
      feedback: [...(workspace?.querySelectorAll('.module-error') || [])].map(element => element.textContent?.slice(0, 1000)) };
  })()`);
  const expectModuleOpen = async (hostSelector, description) => {
    try {
      await until(async () => (await moduleOpenState(hostSelector)).ready, description);
    } catch (error) {
      const diagnostics = await moduleOpenState(hostSelector).catch(failure => ({ diagnosticsError: String(failure) }));
      throw new Error(`${String(error)}\nPending-module open diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
  };
  await expectModuleOpen(card, 'pending module opens inline and receives focus');
  assert.equal(await ui(`document.activeElement.closest('[data-module-id]')?.dataset.moduleId`),'test-module');
  check('the decision queue includes other agent reviews and focuses their original card', () => {});
  let hostRefresh = 0;
  const refreshOwnedModule = async (hostSelector, description) => {
    const workspace = (await command('status')).result.assistant;
    const marker = `Syntetisk pollingmarkör ${++hostRefresh}`;
    const saved = await command('correct', { action: 'settings', revision: String(workspace.revision), settings: JSON.stringify({ ...workspace.settings, tone: marker }) });
    assert.equal(saved.ok, true);
    await refresh();
    await until(() => ui(`document.querySelector('${card} [name="tone"]').value===${JSON.stringify(marker)}`), 'fresh assistant fixture view after refresh');
    await expectModuleOpen(hostSelector, description);
    assert.equal(await ui(`document.querySelectorAll('[data-module-id="test-module"]').length`), 1, 'ownership transfers the original generic card without cloning it');
  };
  await refreshOwnedModule(card, 'refresh retains the generic module under its invoking assistant');
  const otherHostId = await ui(`[...document.querySelectorAll('#personal-modules > [data-module-id]')].find(element=>element.dataset.moduleId!=='assistant-fixture'&&element.querySelector('.assistant-workspace'))?.dataset.moduleId`);
  assert.ok(otherHostId, 'the live fixture includes another assistant host');
  const otherHost = `[data-module-id="${otherHostId}"]`;
  const chooseModuleHost = hostSelector => ui(`(() => {const host=document.querySelector(${JSON.stringify(hostSelector)});const select=host.querySelector('[name="inline-module"]');select.value='test-module';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await chooseModuleHost(otherHost);
  await expectModuleOpen(otherHost, 'another assistant dropdown takes ownership of the same generic module');
  await refreshOwnedModule(otherHost, 'refresh retains the explicitly chosen other assistant host');
  await chooseModuleHost(card);
  await expectModuleOpen(card, 'the original assistant dropdown can reclaim the generic module');
  await ui(`document.querySelector('${card} [data-view="settings"]').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-view-settings').hidden`), 'settings transition before module open');
  await ui(`document.querySelector('${card} [data-pending-module="test-module"] button').click()`);
  await expectModuleOpen(card, 'module open awaits the return from settings before focusing its target');
  check('generic module ownership survives polling, transfers through either assistant dropdown, and focuses after chat navigation', () => {});
  await ui(`document.querySelector('${card} [data-view="settings"]').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-view-settings').hidden`), 'settings opened for onboarding');
  await openSettingsPage('accounts');
  await click('Lägg till konto');
  await type('[data-account] [name="label"]', 'Nytt isolerat konto');
  await type('[data-account] [name="email"]', 'konto@example.test');
  assert.equal(await ui(`document.querySelector('${card} [data-account] [name="url"]').value`), 'https://mail.google.com/mail/u/?authuser=konto%40example.test');
  for (const [provider, url] of [['outlook','https://outlook.office.com/mail/'], ['zoho','https://mail.zoho.com/']]) {
    await ui(`(()=>{const e=document.querySelector('${card} [data-account] [name="provider"]');e.value=${JSON.stringify(provider)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await ui(`document.querySelector('${card} [data-account] [name="url"]').value`),url);
  }
  await savePart('accounts');
  assert.equal(await ui(`document.querySelector('${card} [data-account] [name="email"]').readOnly`),true);
  check('account onboarding selects provider URLs and Gmail routes to the explicit email identity', () => {});
  const settings = assistantFixtureWorkspace().settings;
  settings.accounts = [
    { id: 'fixture-gmail', provider: 'gmail', label: 'Isolerat Gmail', email: 'gmail@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true },
    { id: 'fixture-outlook', provider: 'outlook', label: 'Isolerat Outlook', email: 'outlook@example.test', url: 'https://outlook.office.com/mail/', enabled: true },
    { id: 'fixture-zoho', provider: 'zoho', label: 'Isolerat Zoho', email: 'zoho@example.test', url: 'https://mail.zoho.com/', enabled: true },
  ];
  const initial = (await command('status')).result.assistant;
  assert.equal((await command('correct', { action: 'settings', settings: JSON.stringify(settings), revision: String(initial.revision) })).ok, true); await refresh();
  await until(() => ui(`!document.querySelector('${card} [data-task="check-mail"]').disabled`), 'configured tasks');
  // A spy on chrome.permissions.request, in place before the panel's own scripts run: loading the
  // panel, a refresh and a save never ask Chrome for a permission, and turning the morning
  // notifications on asks once. The spy answers no, so the test browser is never granted anything.
  const permissionRequests = () => ui(`window.__permissionSpy?window.__permissionSpy.asked.map(request=>JSON.stringify(request)):'no spy'`);
  await rpc('Page.enable', {}, panelSession);
  const permissionSpy = await rpc('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=chrome.permissions.request,asked=[];window.__permissionSpy={asked,original};chrome.permissions.request=request=>{asked.push(request);return Promise.resolve(false);};})()` }, panelSession);
  const requested = {};
  try {
    await rpc('Page.reload', {}, panelSession);
    await until(() => ui(`!!window.__permissionSpy && chrome.permissions.request!==window.__permissionSpy.original && !!document.querySelector('${card} [data-task="check-mail"]') && !document.querySelector('${card} [data-task="check-mail"]').disabled`).catch(() => false), 'the panel loaded with the permission spy');
    requested.load = await permissionRequests();
    const marker = `Syntetisk behörighetsmarkör ${++hostRefresh}`, workspace = (await command('status')).result.assistant;
    assert.equal((await command('correct', { action: 'settings', revision: String(workspace.revision), settings: JSON.stringify({ ...workspace.settings, tone: marker }) })).ok, true);
    await refresh();
    await until(() => ui(`document.querySelector('${card} [name="tone"]').value===${JSON.stringify(marker)}`), 'a refreshed view with the permission spy');
    requested.refresh = await permissionRequests();
    await ui(`document.querySelector('${card} details[data-keep="assistant-morning"]').open=true`);
    await ui(`document.querySelector('${card} [name="morningEnabled"]').click()`);
    await type('[name="morningTime"]', '07:30');
    await savePart('accounts');
    requested.save = await permissionRequests();
    await ui(`document.querySelector('${card} [name="morningNotifications"]').click()`);
    await until(() => ui(`document.querySelector('${card} [data-settings-part="accounts"] .assistant-settings-status').textContent==='Chrome nekade aviseringar. Spara morgonkontrollen utan aviseringar.'`).catch(() => false), 'the declined notification permission answered').catch(() => {});
    requested.change = await permissionRequests();
    requested.notifications = await ui(`document.querySelector('${card} [name="morningNotifications"]').checked`);
  } finally {
    await rpc('Page.removeScriptToEvaluateOnNewDocument', { identifier: permissionSpy.identifier }, panelSession);
    await ui(`(()=>{if(window.__permissionSpy){chrome.permissions.request=window.__permissionSpy.original;delete window.__permissionSpy;}})()`);
    await rpc('Page.disable', {}, panelSession);
  }
  check('loading the panel, a refresh and a save never ask Chrome for a permission; turning notifications on asks once', () => {
    assert.deepEqual(requested, { load: [], refresh: [], save: [], change: [JSON.stringify({ permissions: ['notifications'] })], notifications: false });
  });
  const savedMorning = (await command('status')).result.assistant.settings.morning;
  assert.deepEqual(savedMorning, { enabled: true, time: '07:30', notifications: false, task: 'my-day' });
  check('morning schedule controls dispatch the saved time and stay notification-opt-in', () => {});
  // Each settings page sends the whole settings object, but only its own fields come from its form.
  const serverSettings = async () => (await command('status')).result.assistant.settings;
  const read = selector => ui(`document.querySelector(${JSON.stringify(`${card} ${selector}`)}).value`);
  const choose = (selector, next) => ui(`(()=>{const e=document.querySelector(${JSON.stringify(`${card} ${selector}`)});e.value=${JSON.stringify(next)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const before = await serverSettings();
  await openSettingsPage('accounts'); await type('[name="tone"]', 'Osparad ton på Mejlkonton');
  await openSettingsPage('web'); await choose('[name="webLevel"]', 'read'); await savePart('web');
  let stored = await serverSettings();
  assert.equal(stored.web.level, 'read'); assert.equal(stored.tone, before.tone, 'saving Webbåtkomst leaves the unsaved tone out');
  await ui(`document.querySelector('${card} [name="webFullAccess"]').click()`);
  await savePart('web');
  assert.equal((await serverSettings()).web.fullAccess, true);
  assert.equal(await ui(`['webLevel','webLogin','webTasks'].every(name=>document.querySelector('${card} [name="'+name+'"]').disabled)`), true);
  assert.equal(await read('[name="webLevel"]'), 'read', 'full mode retains the guided level');
  await ui(`document.querySelector('${card} [name="webFullAccess"]').click()`);
  await savePart('web');
  assert.equal((await serverSettings()).web.fullAccess, false);
  assert.equal(await ui(`document.querySelector('${card} [name="webLevel"]').disabled`), false);
  check('full browser access is explicit, saved and reversible without clearing guided settings', () => {});
  assert.equal(await read('[name="tone"]'), 'Osparad ton på Mejlkonton', 'the unsaved tone stays in its form');
  assert.equal(await ui(`document.querySelector('${card} [data-settings-page="accounts"]').dataset.dirty`), 'true', 'the settings list marks the page with unsaved changes');
  await choose('[name="webTasks"]', 'manual');
  await openSettingsPage('general'); await type('[name="timezone"]', 'Europe/Oslo'); await savePart('general');
  stored = await serverSettings();
  assert.equal(stored.timezone, 'Europe/Oslo'); assert.equal(stored.web.tasks ?? 'off', 'off'); assert.equal(stored.tone, before.tone);
  assert.equal(await read('[name="webTasks"]'), 'manual');
  await openSettingsPage('models'); await ui(`document.querySelector('${card} [data-keep="assistant-agent-model"]').open=true`);
  await choose('[name="agentReasoningEffort"]', 'high');
  await openSettingsPage('accounts'); await savePart('accounts');
  stored = await serverSettings();
  assert.equal(stored.tone, 'Osparad ton på Mejlkonton'); assert.deepEqual(stored.agent, before.agent); assert.equal(stored.timezone, 'Europe/Oslo'); assert.equal(stored.web.level, 'read');
  assert.equal(await read('[name="agentReasoningEffort"]'), 'high');
  await openSettingsPage('web'); await choose('[name="webLevel"]', 'off');
  await openSettingsPage('models'); await choose('[name="agentReasoningEffort"]', 'medium'); await savePart('agent');
  stored = await serverSettings();
  assert.equal(stored.agent.codex.reasoningEffort, 'medium'); assert.equal(stored.web.level, 'read'); assert.equal(stored.tone, 'Osparad ton på Mejlkonton');
  assert.equal(await read('[name="webLevel"]'), 'off');
  await ui(`document.querySelector('${card} [data-keep="assistant-agent-model"]').open=false`);
  await openSettingsPage('web'); await choose('[name="webTasks"]', 'off'); await savePart('web');
  await openSettingsPage('general'); await type('[name="timezone"]', before.timezone); await savePart('general');
  await openSettingsPage('accounts'); await type('[name="tone"]', before.tone); await savePart('accounts');
  stored = await serverSettings();
  assert.deepEqual({ timezone: stored.timezone, tone: stored.tone, web: stored.web.level, tasks: stored.web.tasks, morning: stored.morning }, { timezone: before.timezone, tone: before.tone, web: 'off', tasks: 'off', morning: before.morning });
  check('each settings page saves the whole object with only its own fields and never overwrites unsaved fields on another page', () => {});
  const localStorageKeys = await ui('Object.keys(localStorage)');
  assert.equal(localStorageKeys.some(key=>key.startsWith('tabai-assistant-draft:')), false);
  assert.equal(localStorageKeys.every(key=>key==='tabai-panel-appearance'||key.startsWith('tabai-assistant-view:')), true);
  check('assistant local storage is limited to appearance and namespaced view preferences', () => {});
  await assistantMailMethodsPanelChecks({ ui, until, check });
  await type('[name="tone"]', 'Min osparade ton'); await refresh();
  assert.equal(await ui(`document.querySelector('${card} [name="tone"]').value`), 'Min osparade ton');
  check('unsaved settings survive a status refresh', () => {});
  {
    // A sender rule added elsewhere while Mejlkonton holds unsaved text: the page keeps the user's
    // text, shows the change as a conflict, sends nothing until the user chooses, and saving the
    // user's own changes keeps the new rule. The clean Webbåtkomst page shows when the view arrived.
    const accountsPart = `${card} [data-settings-part="accounts"]`, conflict = `${accountsPart} [data-settings-conflict]`;
    const rule = { accountId: 'fixture-gmail', email: 'regel@example.test', priority: 'high' };
    const hostWrite = async change => {
      const workspace = (await command('status')).result.assistant;
      assert.equal((await command('correct', { action: 'settings', revision: String(workspace.revision), settings: JSON.stringify(change(workspace.settings)) })).ok, true);
      await refresh();
    };
    const page = () => ui(`(()=>{const part=document.querySelector('${accountsPart}'),box=part.querySelector('[data-settings-conflict]');return {tone:part.querySelector('[name="tone"]').value,rules:[...part.querySelectorAll('[data-sender-rule] [name="sender-email"]')].map(input=>input.value),conflict:!!box&&!box.hidden,status:part.querySelector('.assistant-settings-status').textContent,dirty:part.dataset.dirty==='true'};})()`);
    await openSettingsPage('accounts');
    await hostWrite(settings => ({ ...settings, preferences: { shortReplies: settings.preferences?.shortReplies ?? false, senderRules: [...(settings.preferences?.senderRules ?? []), rule] }, web: { ...settings.web, tasks: 'manual' } }));
    await until(() => ui(`document.querySelector('${card} [name="webTasks"]').value==='manual'`), 'the host change reached the panel');
    const arrived = await page();
    await ui(`document.querySelector('${accountsPart} button[type="submit"]').click()`);
    await until(async () => (await page()).status !== 'Du har osparade ändringar.' && (await page()).status !== 'Sparar inställningar…', 'the save button answered');
    const unchosen = { page: await page(), stored: await serverSettings() };
    check('a save of a page that changed elsewhere is not sent before the user chooses, and the new rule stays', () => {
      assert.equal(arrived.tone, 'Min osparade ton', 'the typed text is kept');
      assert.notEqual(unchosen.stored.tone, 'Min osparade ton', 'nothing was sent');
      assert.deepEqual(unchosen.stored.preferences.senderRules, [rule]);
      assert.equal(unchosen.page.status, 'Välj först om du vill läsa in de nya värdena eller spara dina ändringar över dem.');
    });
    check('the page shows the change as a conflict with the typed text kept', () => assert.deepEqual({ conflict: arrived.conflict, tone: arrived.tone, rules: arrived.rules }, { conflict: true, tone: 'Min osparade ton', rules: [] }));
    await ui(`[...document.querySelectorAll('${conflict} button')].find(button=>button.textContent==='Spara mina ändringar').click()`);
    await until(async () => (await page()).status === 'Inställningarna är sparade.', 'own changes saved over the new values');
    const kept = { page: await page(), stored: await serverSettings() };
    check('saving the user\'s own changes over the new values keeps the rule the user never touched', () => {
      assert.equal(kept.stored.tone, 'Min osparade ton'); assert.deepEqual(kept.stored.preferences.senderRules, [rule]); assert.equal(kept.stored.web.tasks, 'manual');
      assert.deepEqual({ conflict: kept.page.conflict, tone: kept.page.tone, rules: kept.page.rules, dirty: kept.page.dirty }, { conflict: false, tone: 'Min osparade ton', rules: [rule.email], dirty: false });
    });
    // The other choice: the new values are read in and the unsaved text on the page goes.
    await type('[name="tone"]', 'Andra osparade tonen');
    await hostWrite(settings => ({ ...settings, preferences: { ...settings.preferences, senderRules: [] }, web: { ...settings.web, tasks: 'off' } }));
    await until(() => ui(`document.querySelector('${card} [name="webTasks"]').value==='off'`), 'the second host change reached the panel');
    await until(async () => (await page()).conflict, 'the second change is a conflict too');
    await ui(`[...document.querySelectorAll('${conflict} button')].find(button=>button.textContent==='Läs in de nya värdena').click()`);
    const readIn = await page();
    check('reading the new values in replaces the unsaved text on the page and leaves nothing to save', () => {
      assert.deepEqual({ conflict: readIn.conflict, tone: readIn.tone, rules: readIn.rules, dirty: readIn.dirty }, { conflict: false, tone: 'Min osparade ton', rules: [], dirty: false });
    });
    // The tone changed and saved, then typed back to the tone the page was drawn with while the host
    // holds its answer to that save: the user's own revert is saved by the next save. A sender rule
    // added elsewhere after the save is still a conflict, and saving over it keeps the rule.
    const first = readIn.tone, middle = 'Tillfällig ton under sparandet';
    await type('[name="tone"]', middle);
    await command('history', { action: 'fixture-hold', hold: 'settings' });
    let held = false;
    try {
      await ui(`document.querySelector('${accountsPart} button[type="submit"]').click()`);
      held = await until(async () => JSON.parse((await command('history', { action: 'fixture-holds' })).result.description).holding.includes('settings'), 'the save held at the host').then(() => true, () => false);
      await type('[name="tone"]', first);
    } finally { await command('history', { action: 'fixture-release', hold: 'settings' }); }
    const acknowledged = await until(async () => (await page()).status === 'Inställningarna sparades. Dina senaste ändringar är fortfarande osparade.', 'the save acknowledged with the typing kept').then(() => true, () => false);
    const between = (await serverSettings()).tone;
    await hostWrite(settings => ({ ...settings, preferences: { ...settings.preferences, senderRules: [rule] } }));
    const conflicted = await until(async () => (await page()).conflict, 'a rule added after the save is a conflict').then(() => true, () => false);
    if (conflicted) await ui(`[...document.querySelectorAll('${conflict} button')].find(button=>button.textContent==='Spara mina ändringar').click()`);
    else await ui(`document.querySelector('${accountsPart} button[type="submit"]').click()`);
    await until(async () => (await page()).status === 'Inställningarna är sparade.', 'the next save done').catch(() => {});
    const reverted = { stored: await serverSettings(), page: await page() };
    check('a field typed back to its first value while its save is on its way is saved by the next save, and a rule added after that save is kept', () => {
      assert.deepEqual({ held, acknowledged, between, conflicted, tone: reverted.stored.tone, rules: reverted.stored.preferences.senderRules, page: { tone: reverted.page.tone, dirty: reverted.page.dirty } },
        { held: true, acknowledged: true, between: middle, conflicted: true, tone: first, rules: [rule], page: { tone: first, dirty: false } });
    });
    // The rest of the suite starts without the rule and with the tone as it was.
    await hostWrite(settings => ({ ...settings, tone: first, preferences: { ...settings.preferences, senderRules: [] } }));
    await until(async () => { const shown = await page(); return !shown.dirty && !shown.conflict && shown.tone === first && !shown.rules.length; }, 'Mejlkonton as it was');
  }
  // Mejl is an inbox: "Kollat …", Kolla mina mejl with ⋯, the tabs and one mail at a time.
  const surface = () => ui(`document.querySelector('${card} .assistant-workspace').dataset.surface`);
  const detail = `${card} .assistant-mail-detail`;
  const mailPage = () => ui(`(()=>{const view=document.querySelector('${card} .assistant-view-mail');return !view.querySelector('.assistant-mail-inbox').hidden?'inbox':!view.querySelector('.assistant-mail-detail').hidden?'item':!view.querySelector('.assistant-mail-cases').hidden?'cases':'runs';})()`);
  // ⋯ next to Kolla mina mejl, opened as the user does, then one of its entries.
  const fromStartMenu = async selector => {
    await ui(`document.querySelector('${card} .assistant-mail-start .assistant-mail-more').click()`);
    await until(() => ui(`document.querySelector('${card} .assistant-mail-start .assistant-mail-menu').matches(':popover-open')`), 'start menu open');
    await ui(`document.querySelector(${JSON.stringify(`${card} .assistant-mail-start .assistant-mail-menu ${selector}`)}).click()`);
  };
  // One card: its sentence, its one main control, the small buttons below it and what ⋯ holds.
  const cardShape = () => ui(`(()=>{const view=document.querySelector('${detail}'),shown=element=>!element.closest('[hidden]');return {sentence:view.querySelector('.assistant-mail-next').textContent,main:[...view.querySelectorAll('[data-main]')].filter(shown).map(control=>[control.dataset.main,control.textContent]),primary:[...view.querySelectorAll('.primary')].filter(shown).length,small:[...view.querySelectorAll('.assistant-mail-secondary > button')].filter(shown).map(control=>control.dataset.feedback?'no-reply':control.dataset.markDone?'done':control.dataset.remind?'remind':control.textContent),menu:[...view.querySelectorAll('.assistant-mail-detail-bar .assistant-mail-menu :is(button,a)')].map(control=>control.dataset.mailAction||control.dataset.feedback||(control.dataset.senderLookup?'lookup':control.textContent)),done:view.querySelectorAll('[data-mark-done]:not([hidden])').length};})()`);
  const toInbox = async () => {
    if (await surface() !== 'mail') await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
    await until(async () => await surface() === 'mail', 'Mejl open');
    if (await mailPage() !== 'inbox') await ui(`document.querySelector('${card} .assistant-back').click()`);
    await until(async () => await mailPage() === 'inbox', 'Mejl list');
  };
  const openMail = async id => {
    await toInbox();
    await ui(`document.querySelector('${card} .assistant-mail-inbox [data-item-id="${id}"] .assistant-mail-row').click()`);
    await until(() => ui(`!document.querySelector('${detail}').hidden && document.querySelector('${detail}').dataset.itemId===${JSON.stringify(id)}`), `mail ${id} opened`);
  };
  const pick = selector => ui(`document.querySelector(${JSON.stringify(`${detail} ${selector}`)}).click()`);
  const item = async id => (await command('status')).result.assistant.items.find(entry => entry.id === id);
  const toChat = async () => {
    const current = await surface();
    if (current !== 'chat') await ui(`document.querySelector('${card} [data-view="${current === 'settings' ? 'settings' : 'mail'}"]').click()`);
    await until(async () => await surface() === 'chat', 'back in the chat');
  };
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-view-mail').hidden && document.querySelector('${card} [data-view="mail"]').getAttribute('aria-current')==='page'`), 'Mejl opened from the header');
  const inboxShape = await ui(`(()=>{const view=document.querySelector('${card} .assistant-view-mail'),tabs=[...view.querySelectorAll('[role="tablist"] [role="tab"]')];return {status:!!view.querySelector('.assistant-mail-status-text'),alerts:view.querySelector('.assistant-mail-alerts').hidden,region:[view.querySelector('.assistant-mail-alert-region').getAttribute('aria-live'),view.querySelector('.assistant-mail-alert-region').hidden,view.querySelector('.assistant-mail-alerts').parentElement.className],details:!!view.querySelector('.assistant-mail-status [data-mail-details]'),main:view.querySelector('[data-task="check-mail"]').textContent,primary:view.querySelector('[data-task="check-mail"]').classList.contains('primary'),more:view.querySelector('.assistant-mail-start .assistant-mail-more').getAttribute('aria-label'),tabs:tabs.map(tab=>{const panel=document.getElementById(tab.getAttribute('aria-controls'));return [tab.querySelector('.assistant-mail-tab-label').textContent,tab.getAttribute('aria-selected'),panel?.getAttribute('role'),panel?.getAttribute('aria-labelledby')===tab.id,panel?.hidden];}),title:document.querySelector('${card} .assistant-topbar-title').textContent};})()`);
  check('Mejl opens as an inbox: a status row without a red row or Detaljer, Kolla mina mejl with ⋯ and the tabs Att göra and Klart', () => {
    assert.equal(inboxShape.status, true); assert.equal(inboxShape.main, 'Kolla mina mejl'); assert.equal(inboxShape.primary, true); assert.equal(inboxShape.more, 'Fler val'); assert.equal(inboxShape.title, 'Mejl');
    assert.equal(inboxShape.alerts, true, 'no red row before an account needs the user'); assert.equal(inboxShape.details, false, 'the details live under ⋯');
    assert.deepEqual(inboxShape.region, ['polite', false, 'assistant-mail-alert-region'], 'the live region is there before any row, so a new row is read out');
    assert.deepEqual(inboxShape.tabs, [['Att göra', 'true', 'tabpanel', true, false], ['Klart', 'false', 'tabpanel', true, true]]);
  });
  await ui(`(()=>{const tab=document.querySelector('${card} [data-tab="todo"]');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`);
  const arrowed = await ui(`[document.activeElement.dataset.tab,document.querySelector('${card} [data-tab="done"]').getAttribute('aria-selected'),document.querySelector('${card} [data-tab="done"]').tabIndex,document.querySelector('${card} [data-panel="done"]').hidden,document.querySelector('${card} [data-panel="todo"]').hidden]`);
  await ui(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  const wrapped = await ui(`document.activeElement.dataset.tab`);
  await ui(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
  const ended = await ui(`document.activeElement.dataset.tab`);
  await ui(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
  check('the tabs are a tablist: arrow keys, Home and End move and select', () => {
    assert.deepEqual(arrowed, ['done', 'true', 0, false, true]); assert.equal(wrapped, 'todo'); assert.equal(ended, 'done');
  });
  assert.equal(await ui(`document.querySelector('${card} [data-tab="todo"]').getAttribute('aria-selected')`), 'true');
  await ui(`document.querySelector('${card} .assistant-mail-start .assistant-mail-more').click()`);
  await until(() => ui(`document.querySelector('${card} .assistant-mail-start .assistant-mail-menu').matches(':popover-open')`), 'start menu open');
  const startMenu = await ui(`[...document.querySelectorAll('${card} .assistant-mail-start .assistant-mail-menu button')].map(button=>button.dataset.task||button.dataset.shortcutId||button.dataset.mailOpen||button.textContent)`);
  check('⋯ next to Kolla mina mejl holds Min dag, Förbered möte, Följ upp, own shortcuts, Ärenden and the checks', () => assert.deepEqual(startMenu, ['my-day', 'prepare-meeting', 'follow-ups', 'Lägg till en egen snabbknapp', 'cases', 'details']));
  // Ärenden is a page in Mejl, reached from ⋯; ← returns to the list with focus on ⋯.
  await ui(`document.querySelector('${card} .assistant-mail-start [data-mail-open="cases"]').click()`);
  await until(async () => await mailPage() === 'cases' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Ärenden' && document.activeElement===document.querySelector('${card} .assistant-mail-cases') && document.querySelector('${card} .assistant-mail-cases [data-section="cases"]').getClientRects().length>0`), 'Ärenden from ⋯');
  const casesPage = await ui(`({back:document.querySelector('${card} .assistant-back').getAttribute('aria-label'),label:document.querySelector('${card} .assistant-mail-cases').getAttribute('aria-label'),menu:document.querySelector('${card} .assistant-mail-start .assistant-mail-menu').matches(':popover-open')})`);
  await ui(`document.querySelector('${card} .assistant-back').click()`);
  await until(async () => await mailPage() === 'inbox' && await ui(`document.activeElement===document.querySelector('${card} .assistant-mail-start .assistant-mail-more')`), 'back from Ärenden to the list');
  check('Ärenden opens from ⋯ as its own page, and ← returns to the list with focus on ⋯', () => assert.deepEqual(casesPage, { back: 'Tillbaka till Mejl', label: 'Ärenden', menu: false }));
  await fromStartMenu('[data-manage-shortcuts]');
  await until(() => ui(`!document.querySelector('${card} .assistant-mail-runs').hidden && document.querySelector('${card} [data-keep="assistant-shortcuts"]').open && document.activeElement?.name==='shortcut-label' && document.querySelector('${card} .assistant-topbar-title').textContent==='Kontroller'`), 'shortcut form on Kontroller');
  await type('[name="shortcut-label"]', 'Mitt testuppdrag'); await type('[name="shortcut-instructions"]', 'Gå igenom isolerat testunderlag.'); await refresh();
  assert.equal(await ui(`document.querySelector('${card} [name="shortcut-instructions"]').value`), 'Gå igenom isolerat testunderlag.');
  await click('Spara snabbknapp'); await until(() => ui(`!!document.querySelector('${card} .assistant-mail-start [data-shortcut-id]') && !!document.querySelector('${card} [data-shortcut-row]')`), 'shortcut saved');
  check('shortcut authoring survives refresh and persists through the real module transport', () => {});
  assert.equal(await ui(`document.querySelector('${card} .assistant-back').getAttribute('aria-label')`), 'Tillbaka till Mejl');
  await ui(`document.querySelector('${card} .assistant-back').click()`);
  await until(async () => await surface() === 'mail' && await mailPage() === 'inbox' && await ui(`document.activeElement===document.querySelector('${card} .assistant-mail-start .assistant-mail-more')`), 'back from Kontroller to the list');
  check('← on Kontroller returns to the list with focus on ⋯, not to the chat', () => {});
  for (const task of ['follow-ups', 'my-day', 'custom']) {
    await ui(`document.querySelector('${card} ${task === 'custom' ? '[data-shortcut-id]' : `[data-task="${task}"]`}').click()`);
    await until(async () => (await command('status')).result.assistant.current?.task === task, `task ${task}`);
  }
  await ui(`document.querySelector('${card} [data-task="check-mail"]').click()`);
  await until(async () => (await command('status')).result.assistant.current?.task === 'check-mail', 'Kolla mina mejl starts a check');
  await until(() => ui(`!!document.querySelector('${card} [data-item-id="fixture-reply"] .assistant-mail-row')`), 'reply row');
  check('the main button Kolla mina mejl starts a check', () => {});
  const mailBadge = () => ui(`(()=>{const button=document.querySelector('${card} [data-view="mail"]'),badge=button.querySelector('.assistant-badge'),tab=document.querySelector('${card} [data-tab="todo"]');return {text:badge.hidden?'':badge.textContent,label:button.getAttribute('aria-label'),queued:Number(tab.dataset.count),spoken:tab.querySelector('.visually-hidden').textContent};})()`);
  const counted = await mailBadge();
  check('the Mejl counter shows what waits on the user, matches Att göra and is read out', () => {
    assert.ok(counted.queued > 1); assert.equal(counted.text, String(counted.queued)); assert.equal(counted.label, `Mejl, ${counted.queued} väntar`); assert.equal(counted.spoken, `, ${counted.queued} väntar på dig`);
  });
  assert.equal((await command('status')).result.assistant.current.instructions, String(await ui('chrome.windows.getCurrent().then(window=>window.id)')));
  check('assistant task buttons carry their own panel document window through the module transport', () => {});
  check('all daily task launchers and custom shortcuts dispatch their specific task', () => {});
  const rows = await ui(`[...document.querySelectorAll('${card} [data-panel="todo"] .assistant-mail-entry')].map(row=>({id:row.dataset.itemId||row.dataset.pendingModule,status:row.querySelector('.assistant-mail-chip').textContent,tag:row.querySelector('.assistant-mail-row').tagName,list:row.parentElement.tagName,done:row.querySelector('[data-mark-done]')?.getAttribute('aria-label')??'',group:row.closest('[data-group]')?.dataset.group??''}))`);
  check('each mail is one button in a list with its status word; only rows för kännedom carry Klar', () => {
    const by = id => rows.find(row => row.id === id);
    assert.deepEqual([by('fixture-reply').status, by('fixture-question').status, by('fixture-action').status, by('fixture-uncertain').status, by('fixture-info-1').status], ['Svar att skicka', 'Fråga till dig', 'Behöver dig', 'Kolla om det skickades', 'För kännedom']);
    assert.ok(rows.every(row => row.tag === 'BUTTON' && row.list === 'UL'), JSON.stringify(rows));
    assert.deepEqual(rows.filter(row => row.done).map(row => [row.id, row.group, row.done]), [1, 2, 3].map(index => [`fixture-info-${index}`, 'info', `Klar: Isolerat nyhetsbrev ${index}`]));
    assert.ok(by('test-module'), 'other agents\u2019 work is in Att göra');
  });
  const statusLine = await ui(`document.querySelector('${card} .assistant-mail-status-text').textContent`);
  const alertRows = await ui(`(()=>{const list=document.querySelector('${card} .assistant-mail-alerts'),resolved=(property,value)=>{const probe=document.createElement('i');probe.style[property]=value;document.body.append(probe);const result=getComputedStyle(probe)[property];probe.remove();return result;};return {hidden:list.hidden,live:list.parentElement.getAttribute('aria-live'),rows:[...list.querySelectorAll('.assistant-mail-alert')].map(row=>[row.dataset.alertAccount,row.querySelector('.assistant-mail-alert-text').textContent,row.querySelector('button').textContent,row.querySelector('button').getAttribute('aria-label'),row.querySelector('button').getBoundingClientRect().height>=44,row.dataset.tone,getComputedStyle(row).color,getComputedStyle(row).backgroundColor]),tones:{danger:resolved('color','var(--danger)'),dangerSoft:resolved('backgroundColor','var(--danger-soft)'),warning:resolved('color','var(--warning)'),warningSoft:resolved('backgroundColor','var(--warning-soft)')},before:!!(list.compareDocumentPosition(document.querySelector('${card} [data-task="check-mail"]'))&Node.DOCUMENT_POSITION_FOLLOWING)};})()`);
  check('partial coverage stays explicit; login needs action while an unsupported view offers its status', () => {
    assert.equal(statusLine, 'Kontrollen är delvis klar.');
    assert.deepEqual({ hidden: alertRows.hidden, live: alertRows.live, before: alertRows.before }, { hidden: false, live: 'polite', before: true });
    assert.deepEqual(alertRows.rows.map(row => row.slice(0, 6)), [
      ['fixture-outlook', 'Isolerat Outlook behöver loggas in', 'Åtgärda', 'Åtgärda: Isolerat Outlook behöver loggas in', true, 'danger'],
      ['fixture-zoho', 'Isolerat Zoho visas i en vy som Tabai inte kan läsa', 'Visa status', 'Visa status: Isolerat Zoho visas i en vy som Tabai inte kan läsa', true, 'warning']]);
    assert.deepEqual(alertRows.rows.map(row => row.slice(6)), [[alertRows.tones.danger, alertRows.tones.dangerSoft], [alertRows.tones.warning, alertRows.tones.warningSoft]]);
  });
  await command('history', { action: 'fixture-opened', count: '3' }); await refresh();
  await until(() => ui(`document.querySelector('${card} .assistant-mail-status-text').textContent==='Kontrollen är delvis klar. · 3 mejl du öppnat men inte svarat på'`), 'the check summary counts opened mail without a reply');
  const openedLine = await ui(`({live:document.querySelector('${card} .assistant-mail-status-sentence').textContent,buttons:document.querySelectorAll('${card} .assistant-mail-status-actions button').length})`);
  check('the check summary names opened mail still without a reply in the same short line, with no new buttons', () => {
    assert.match(openedLine.live, / · 3 mejl du öppnat men inte svarat på$/); assert.equal(openedLine.buttons, 1);
  });
  await command('history', { action: 'fixture-opened', count: '0' }); await refresh();
  await until(() => ui(`document.querySelector('${card} .assistant-mail-status-text').textContent==='Kontrollen är delvis klar.'`), 'without such mail the line is unchanged');
  await ui(`document.querySelector('${card} [data-alert-account="fixture-outlook"] button').click()`);
  await until(async () => JSON.stringify((await fixtureState()).opens.at(-1)) === JSON.stringify({ accountId: 'fixture-outlook' }), 'Åtgärda opens the account');
  check('Åtgärda opens that account, as Öppna kontot does under Kontroller', () => {});
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'mail-inbox', toInbox);
  await fromStartMenu('[data-mail-open="details"]');
  await until(async () => await mailPage() === 'runs' && await ui(`!!document.activeElement?.closest('.assistant-progress')`), 'the checks open from ⋯');
  const meter = await ui(`(()=>{const progress=document.querySelector('${card} .assistant-activity-progress progress');return progress&&{max:Number(progress.max),value:Number(progress.value),label:progress.getAttribute('aria-label')}})()`);
  check('activity count stays separate from honest completed-account coverage', () => assert.deepEqual(meter, { max: 3, value: 1, label: 'Kontotäckning' }));
  const coverage = await ui(`[...document.querySelectorAll('${card} [data-coverage]')].map(row=>row.dataset.coverage)`);
  check('coverage distinguishes successful accounts, login gaps and unsupported views', () => assert.deepEqual(coverage, ['checked', 'login', 'unsupported']));
  const cursorTimes = await ui(`['fixture-outlook','fixture-zoho'].map(id=>document.querySelector('${card} [data-account-id="'+id+'"] time')?.dateTime)`);
  check('account timestamps use the current task cursor or the newest available task-prefixed cursor', () => assert.deepEqual(cursorTimes, ['2026-10-30T08:00:00.000Z','2026-10-31T08:00:00.000Z']));
  assert.equal(await ui(`[...document.querySelectorAll('${card} .assistant-account-link[href]')].every(link=>link.protocol==='https:'&&link.target==='_blank'&&link.rel==='noopener noreferrer')`),true);
  check('Kontroller och konton under ⋯ leads to the checks with coverage and history', () => {});
  await openMail('fixture-question');
  const opened = await ui(`(()=>{const view=document.querySelector('${detail}');return {focus:document.activeElement===view.querySelector('.assistant-mail-detail-title'),title:view.querySelector('.assistant-mail-detail-title').textContent,labelled:view.getAttribute('aria-labelledby')===view.querySelector('.assistant-mail-detail-title').id,back:document.querySelector('${card} .assistant-back').getAttribute('aria-label'),list:document.querySelector('${card} .assistant-mail-inbox').hidden};})()`);
  check('one tap opens the mail; the detail gets focus and ← says where it goes', () => assert.deepEqual(opened, { focus: true, title: 'Fråga innan svar', labelled: true, back: 'Tillbaka till Mejl', list: true }));
  const questionCard = await cardShape();
  // Tabai's quotes are behind ⋯ → Visa vad Tabai läste, and show as text.
  await ui(`document.querySelector('${detail} .assistant-mail-more').click()`);
  await until(() => ui(`document.querySelector('${detail} .assistant-mail-detail-bar .assistant-mail-menu').matches(':popover-open')`), 'mail menu open');
  const evidenceHidden = await ui(`!document.querySelector('${detail} blockquote')`);
  await ui(`document.querySelector('${detail} [data-mail-action="evidence"]').click()`);
  await until(() => ui(`!!document.querySelector('${detail} .assistant-mail-evidence blockquote') && document.activeElement===document.querySelector('${detail} .assistant-mail-evidence h4')`), 'Tabai’s quotes shown');
  const questionSafety = await ui(`({unsafe:document.querySelectorAll('${detail} img,${detail} script').length,quote:document.querySelector('${detail} blockquote').textContent,send:document.querySelectorAll('${detail} [data-approve],${detail} [data-send-open]').length,recipient:document.querySelectorAll('${card} input[name="recipient"]').length,links:[...document.querySelectorAll('${detail} a')].every(link=>/^https?:/.test(link.href)&&link.rel==='noopener noreferrer'&&link.target==='_blank'),original:document.querySelector('${detail} a[data-mail-action="original"]')?.href,hide:document.querySelector('${detail} [data-mail-action="evidence"] .assistant-menu-label').textContent})`);
  check('a question card says what Tabai needs, answers with Svara Tabai and offers Inget svar behövs and Påminn mig', () => assert.deepEqual(questionCard, {
    sentence: 'Tabai behöver veta en sak innan det går att svara.', main: [['answer', 'Svara Tabai']], primary: 1, small: ['no-reply', 'remind'],
    menu: ['original', 'evidence', 'lookup', 'chat', 'shorter', 'prioritize-sender'], done: 0,
  }));
  await ui(`document.querySelector('${card} .assistant-back').click()`);
  await until(async () => await mailPage() === 'inbox' && await ui(`document.activeElement?.closest('[data-item-id]')?.dataset.itemId==='fixture-question'`), 'back to the list with focus on the row');
  check('← returns from the mail to the list and focus returns to its row', () => {});
  // A local module that starts from a mail: offered on an Outlook mail, never on Gmail, and it only fills the form.
  const workspaceCard = '[data-module-id="workspace-module"]';
  const workspaceCommand = (operation, input = {}) => ui(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'panel-command', command: { action: 'module', moduleId: 'workspace-module', operation, input } })})`);
  const runBefore = (await workspaceCommand('status')).result.run?.id ?? null;
  await openMail('fixture-question');
  const onGmail = await ui(`!!document.querySelector('${detail} [data-mail-start]')`);
  await openMail('fixture-info-2');
  await until(() => ui(`document.querySelector('${detail} [data-mail-start="workspace-module"]')?.textContent==='Skapa uppdrag'`), 'mail start offered on an Outlook mail');
  await ui(`(()=>{const e=document.querySelector('${workspaceCard} [name="extra"]');e.value='Gammal länk';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pick('[data-mail-start="workspace-module"]');
  await until(() => ui(`(()=>{const element=document.querySelector('${workspaceCard}'),form=element?.querySelector('textarea[name="request"]')?.form;return !!form&&form.elements.request.value.startsWith('Mejl från Nyhetsbrev 2')&&form.elements.request.value.includes('Isolerat nyhetsbrev 2')&&!form.elements.request.value.includes('Testunderlag')&&form.elements.option.value==='Outlook'&&form.elements.link.value==='https://outlook.office.com/mail/'&&form.elements.extra.value===''&&form.querySelector('details').open&&form.elements.option.closest('details').open&&!element.closest('[hidden]')&&document.activeElement===form.querySelector('button[type="submit"]');})()`), 'module start form filled from the mail');
  await until(async () => (await workspaceCommand('status')).result.drafts.start.values.option === 'Outlook', 'filled start saved as the module draft');
  const runAfter = (await workspaceCommand('status')).result.run?.id ?? null;
  check('a mail opens a local module with its start form filled (sender, account and title, not the mail content) and saved, on Outlook but not Gmail, and starts nothing', () => { assert.equal(onGmail, false); assert.equal(runAfter, runBefore); });
  check('a mail start gives the module the mail address and empties the fields it names', () => {});
  // Mail that reads like the module's request gets the start as its one main action.
  await workspaceCommand('correct', { field: 'keywords', value: 'nyhetsbrev' }); await refresh();
  await openMail('fixture-info-2');
  await until(() => ui(`(()=>{const start=document.querySelector('${detail} [data-main="module-start"]');return !!start&&start.classList.contains('primary')&&start.textContent==='Skapa uppdrag'&&document.querySelectorAll('${detail} .assistant-mail-main.primary').length===1&&!document.querySelector('${detail} .assistant-mail-module-starts [data-mail-start]');})()`), 'request start as the main button');
  check('a mail matching the module words shows its start as the one main button', () => {});
  // Starting from the mail links the two: the mail shows the case and opens it.
  await pick('[data-main="module-start"]');
  await until(() => ui(`document.querySelector('${workspaceCard} [name="link"]')?.value==='https://outlook.office.com/mail/'`), 'start form filled from the request');
  await ui(`document.querySelector('${workspaceCard} [name="link"]').form.requestSubmit()`);
  await until(async () => (await workspaceCommand('status')).result.mailRuns?.[0]?.link === 'https://outlook.office.com/mail/', 'the started case is listed under the mail address');
  await openMail('fixture-info-2');
  await until(() => ui(`(()=>{const line=document.querySelector('${detail} [data-mail-run]');return !!line&&line.textContent.includes('Personlig arbetsyta: Arbetar')&&[...line.querySelectorAll('button')].some(b=>b.textContent==='Öppna ärendet')&&!document.querySelector('${detail} [data-mail-start]');})()`), 'mail shows its case');
  const linkedRun = await ui(`document.querySelector('${detail} [data-mail-run]').dataset.mailRun`);
  // The case works, as right after a start: the module refuses select then, and none is needed.
  await workspaceCommand('resume', { 'run-id': linkedRun });
  await ui(`[...document.querySelectorAll('${detail} [data-mail-run] button')].find(b=>b.textContent==='Öppna ärendet').click()`);
  await until(async () => (await workspaceCommand('status')).result.run?.id === linkedRun && await ui(`!document.querySelector('${workspaceCard}').closest('[hidden]')`), 'Öppna ärendet opens the case');
  check('a mail that started a case shows its state and Öppna ärendet opens that case, also while it works', () => {});
  // A handled case marks its mail Klar once, and Ångra holds.
  await workspaceCommand('correct', { field: 'handled', value: 'true' }); await refresh();
  // Not while the module card is on screen: its Ångra would not be seen.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const whileAway = (await item('fixture-info-2')).status;
  await toInbox();
  await until(async () => (await item('fixture-info-2')).status === 'dismissed', 'handled case marks the mail Klar');
  const toast = await ui(`[...document.querySelectorAll('${card} .assistant-mail-toast-region *')].map(e=>e.textContent).join(' ')`);
  await ui(`document.querySelector('${card} [data-undo]').click()`);
  await until(async () => (await item('fixture-info-2')).status === 'open', 'Ångra reopens the mail');
  // Ångra changed the mail after the case was handled, so not even a reloaded panel marks it again.
  await rpc('Page.reload', {}, panelSession);
  await until(() => ui(`!!document.querySelector('${card} .assistant-workspace [data-item-id="fixture-info-2"]')`).catch(() => false), 'panel after reload');
  await new Promise(resolve => setTimeout(resolve, 3000)); await refresh(); await new Promise(resolve => setTimeout(resolve, 800));
  const afterUndo = (await item('fixture-info-2')).status;
  check('a handled case marks its mail Klar once Mejl is on screen, with Ångra, and Ångra holds across a panel reload', () => { assert.equal(whileAway, 'open'); assert.match(toast, /ärendet är avslutat/); assert.equal(afterUndo, 'open'); });
  {
    // A case handled while its mail holds a reply the user has not got saved yet: the panel saves
    // the reply first, which changes the mail, so it is judged again and is not marked Klar.
    const handledLink = 'https://example.test/handled', typed = 'Mitt svar medan ärendet avslutas';
    await command('history', { action: 'fixture-handled', present: 'true' });
    await workspaceCommand('start', { request: 'Ärende från ett eget mejl', link: handledLink }); await refresh();
    try {
      await openMail('fixture-handled');
      await until(() => ui(`!!document.querySelector('${detail} [data-mail-run]')`), 'the mail shows its linked case');
      await command('history', { action: 'fixture-draft-failure', fail: 'true' });
      await type('[data-item-id="fixture-handled"] [name="body"]', typed);
      await until(() => ui(`document.querySelector('${detail} .assistant-draft-status').textContent.startsWith('Utkastet kunde inte sparas')`), 'the typed reply is still unsaved');
      await command('history', { action: 'fixture-draft-failure', fail: 'false' });
      await workspaceCommand('correct', { field: 'handled', value: 'true', link: handledLink }); await refresh();
      await until(async () => (await item('fixture-handled')).draft === typed, 'the panel saved the reply before deciding');
      await new Promise(resolve => setTimeout(resolve, 2500));
      const after = await item('fixture-handled');
      check('a case handled while its mail has an unsaved reply does not mark that mail Klar once the reply is saved', () => assert.deepEqual([after.status, after.draft], ['open', typed]));
    } finally {
      await command('history', { action: 'fixture-draft-failure', fail: 'false' });
      await command('history', { action: 'fixture-handled', present: 'false' }); await refresh();
      await toInbox();
      await until(() => ui(`!document.querySelector('${card} .assistant-mail-inbox [data-item-id="fixture-handled"]')`), 'the linked mail taken away again');
    }
  }
  // A reply Tabai has no proposal for: the user answers in the account and marks it Klar.
  await command('history', { action: 'fixture-self', present: 'true' }); await refresh();
  await until(() => ui(`!!document.querySelector('${card} .assistant-mail-inbox [data-item-id="fixture-self"]')`), 'a reply without a proposal listed');
  const selfRow = await ui(`document.querySelector('${card} [data-item-id="fixture-self"] .assistant-mail-chip').textContent`);
  await openMail('fixture-self');
  const selfCard = await cardShape();
  await command('history', { action: 'fixture-self', present: 'false' }); await refresh();
  await until(async () => await mailPage() === 'inbox' && await ui(`!document.querySelector('${card} .assistant-mail-inbox [data-item-id="fixture-self"]') && !!document.querySelector('${card} .assistant-mail-inbox [data-item-id="fixture-info-3"]')`), 'the list is back to its ten mails');
  assert.equal(selfRow, 'Behöver dig');
  check('a reply without a proposal says to answer in the account, with Klar and Påminn mig below', () => assert.deepEqual(selfCard, {
    sentence: 'Tabai har inget förslag på svar. Svara själv i Isolerat Gmail.', main: [['open-account', 'Öppna i Isolerat Gmail']], primary: 1, small: ['done', 'remind'],
    menu: ['original', 'evidence', 'lookup', 'chat', 'shorter', 'prioritize-sender'], done: 1,
  }));
  await openMail('fixture-uncertain');
  const uncertain = await ui(`({text:document.querySelector('${detail}').textContent,approve:document.querySelectorAll('${detail} [data-approve],${detail} [data-send-open]').length,small:document.querySelector('${detail} .assistant-mail-secondary').hidden,tone:document.querySelector('${detail} .assistant-mail-next').dataset.tone})`);
  const uncertainCard = await cardShape();
  await ui(`document.querySelector('${detail} [data-main="open-account"]').click()`);
  await until(async () => JSON.stringify((await fixtureState()).opens.at(-1)) === JSON.stringify({ accountId: 'fixture-gmail', itemId: 'fixture-uncertain' }), 'Öppna i Isolerat Gmail');
  check('questions cannot be sent, ambiguous sends have no retry and source evidence remains text behind ⋯', () => {
    assert.equal(evidenceHidden, true, 'the quotes wait behind ⋯'); assert.equal(questionSafety.hide, 'Dölj vad Tabai läste');
    assert.equal(questionSafety.unsafe, 0); assert.match(questionSafety.quote, /<img src=x onerror="alert\(1\)">/); assert.equal(questionSafety.send, 0); assert.equal(questionSafety.recipient, 0); assert.equal(questionSafety.links, true);
    assert.equal(questionSafety.original, 'https://example.test/thread');
    assert.match(uncertain.text, /Tabai skickar inte svaret igen/); assert.equal(uncertain.approve, 0); assert.equal(uncertain.small, true, 'no Klar or Påminn on an uncertain send'); assert.equal(uncertain.tone, 'danger');
    assert.deepEqual(uncertainCard, { sentence: 'Det är oklart om svaret skickades. Kolla i kontot innan du gör något mer.', main: [['open-account', 'Öppna i Isolerat Gmail']], primary: 1, small: [], menu: ['original', 'evidence', 'lookup', 'chat'], done: 0 }, 'no feedback on an uncertain send');
  });
  check('Öppna i {konto} on an uncertain send opens the mail in its account', () => {});
  await ui(`document.querySelector('${detail} .assistant-mail-detail-title').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await until(async () => await mailPage() === 'inbox' && await ui(`document.activeElement?.closest('[data-item-id]')?.dataset.itemId==='fixture-uncertain'`), 'Escape leaves the mail');
  check('Escape leaves the mail and returns focus to its row', () => {});
  // After checking Skickat the user says what happened: each choice sends its one action, and nothing is sent.
  const resolveUncertain = async (pending, choice) => {
    await command('history', { action: 'fixture-uncertain', pending: String(pending) }); await refresh();
    await openMail('fixture-uncertain');
    await until(() => ui(`document.querySelector('${detail}').dataset.status==='uncertain'&&!!document.querySelector('${detail} [data-resolve="${choice}"]')`), 'the resolve choices');
    const shown = await ui(`(()=>{const view=document.querySelector('${detail}');return {choices:[...view.querySelectorAll('[data-resolve]')].map(control=>[control.dataset.resolve,control.textContent,control.classList.contains('primary')]),pending:view.querySelector('[data-pending-message]')?.textContent??'',main:[...view.querySelectorAll('[data-main]')].map(control=>control.dataset.main)};})()`);
    const revision = (await item('fixture-uncertain')).revision, sends = (await fixtureState()).sends.length;
    await ui(`document.querySelector('${detail} [data-resolve="${choice}"]').click()`);
    await until(async () => JSON.stringify((await fixtureState()).resolves.at(-1)) === JSON.stringify({ itemId: 'fixture-uncertain', revision, outcome: choice }), `resolve ${choice}`);
    return { shown, sends: (await fixtureState()).sends.length - sends, status: (await item('fixture-uncertain')).status };
  };
  const wasSent = await resolveUncertain(false, 'sent'), notSent = await resolveUncertain(true, 'not-sent');
  // The list row names a later message too, before the card is opened.
  const uncertainChip = () => ui(`document.querySelector('${card} .assistant-mail-inbox [data-item-id="fixture-uncertain"] .assistant-mail-chip')?.textContent??''`);
  await command('history', { action: 'fixture-uncertain', pending: 'true' }); await refresh(); await toInbox();
  await until(async () => await uncertainChip() === 'Kolla om det skickades · nytt meddelande', 'the row names the later message');
  await command('history', { action: 'fixture-uncertain', pending: 'false' }); await refresh(); await toInbox();
  await until(async () => await uncertainChip() === 'Kolla om det skickades', 'without a later message the row keeps its label');
  check('an uncertain send with a later message says so on its list row; without one the row keeps its label', () => {});
  check('an uncertain send offers Det skickades and Det skickades inte beside Öppna i konto, each sends its outcome and nothing is sent', () => {
    assert.deepEqual(notSent.shown.choices, [['sent', 'Det skickades', false], ['not-sent', 'Det skickades inte', false]]);
    assert.deepEqual(notSent.shown.main, ['open-account'], 'Öppna i konto stays the one main action');
    assert.match(notSent.shown.pending, /nytt meddelande/, 'the card says that a new message arrived');
    assert.equal(wasSent.shown.pending, '');
    assert.deepEqual([notSent.sends, notSent.status, wasSent.sends, wasSent.status], [0, 'open', 0, 'sent']);
  });
  await openMail('fixture-shorter');
  await ui(`(()=>{const editor=document.querySelector('${detail} [name="body"]');editor.focus();editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));})()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const escapeInEditor = { page: await mailPage(), focus: await ui(`document.activeElement?.name`) };
  check('Escape while writing the reply stays in the mail', () => assert.deepEqual(escapeInEditor, { page: 'item', focus: 'body' }));
  // Påminn mig's times follow the local day: the panel clock is held at Sunday 23:58 and then
  // Monday 00:01 in Europe/Stockholm, and nothing but opening the menu renders in between.
  const remindMenu = `${detail} .assistant-mail-remind-menu`;
  await ui(`(()=>{const Real=Date;let now=Date.parse('2026-11-08T22:58:00Z');window.__realDate=Real;window.__setNow=value=>{now=Date.parse(value);};window.Date=class extends Real{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};})()`);
  let reminderLabels;
  try {
    const nextWeek = async () => {
      await ui(`document.querySelector('${detail} .assistant-mail-remind').click()`);
      await until(() => ui(`document.querySelector('${remindMenu}').matches(':popover-open')`), 'Påminn mig open');
      const label = await ui(`document.querySelector('${remindMenu} [data-mail-action="snooze-next-week"] .muted').textContent`);
      await ui(`document.querySelector('${remindMenu}').hidePopover()`);
      return label;
    };
    const sunday = await nextWeek();
    await ui(`window.__setNow('2026-11-08T23:01:00Z')`);
    reminderLabels = { sunday, monday: await nextWeek() };
  } finally { await ui(`window.Date=window.__realDate`); }
  check('Påminn mig → Nästa vecka follows the local day after midnight', () => assert.deepEqual(reminderLabels, { sunday: 'i morgon 08:00', monday: 'mån 16 nov. 08:00' }));
  await openMail('fixture-no-reply');
  const replyCard = await cardShape();
  const compose = await ui(`(()=>{const view=document.querySelector('${detail}'),box=view.querySelector('.assistant-mail-compose'),editor=box.querySelector('textarea'),to=box.firstElementChild;return {to:to.textContent,first:to.classList.contains('assistant-mail-to'),described:editor.getAttribute('aria-describedby')===to.id,label:editor.labels[0]?.textContent,editors:view.querySelectorAll('textarea[name="body"]').length,review:view.querySelectorAll('details').length,text:view.textContent.includes('Granska'),preview:view.querySelectorAll('.assistant-send-preview').length};})()`);
  await ui(`document.querySelector('${detail} .assistant-mail-remind').click()`);
  await until(() => ui(`document.querySelector('${remindMenu}').matches(':popover-open') && document.querySelector('${detail} .assistant-mail-remind').getAttribute('aria-expanded')==='true'`), 'Påminn mig open');
  const remindChoices = await ui(`[...document.querySelectorAll('${remindMenu} button')].map(button=>[button.dataset.mailAction,button.querySelector('.assistant-menu-label').textContent])`);
  await ui(`document.querySelector('${remindMenu}').hidePopover()`);
  await ui(`document.querySelector('${detail} .assistant-mail-more').click()`);
  await until(() => ui(`document.querySelector('${detail} .assistant-mail-detail-bar .assistant-mail-menu').matches(':popover-open') && document.querySelector('${detail} .assistant-mail-more').getAttribute('aria-expanded')==='true'`), 'mail menu open');
  const menuSections = await ui(`({titles:[...document.querySelectorAll('${detail} .assistant-mail-detail-bar .assistant-mail-menu .assistant-menu-title')].map(title=>title.textContent),focus:document.activeElement?.dataset.mailAction})`);
  check('a reply card has one sentence, the reply once with Till above it, Skicka svaret, then Inget svar behövs and Påminn mig', () => {
    assert.deepEqual(replyCard, { sentence: 'Tabai har skrivit ett svar. Läs, ändra om du vill och skicka.', main: [['send', 'Skicka svaret']], primary: 1, small: ['no-reply', 'remind'], menu: ['original', 'evidence', 'lookup', 'chat', 'shorter', 'prioritize-sender'], done: 0 });
    assert.deepEqual(compose, { to: 'Till: mottagare@example.test', first: true, described: true, label: 'Ditt svar', editors: 1, review: 0, text: false, preview: 0 });
    assert.deepEqual(remindChoices, [['snooze-tomorrow', 'I morgon'], ['snooze-next-week', 'Nästa vecka']]);
  });
  check('⋯ on a mail holds Öppna originalet, Visa vad Tabai läste, Kolla upp avsändaren, Chatta om detta and Lär Tabai, with focus on the first', () => assert.deepEqual(menuSections, { titles: ['Lär Tabai'], focus: 'original' }));
  await ui(`document.querySelector('${detail} .assistant-mail-detail-bar .assistant-mail-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await mailPage(), 'item', 'Escape inside an open menu never leaves the mail');
  await pick('[data-feedback="no-reply"]');
  await until(async () => (await fixtureState()).feedbackEvents.length === 1, 'no-reply feedback');
  await until(async () => await mailPage() === 'inbox' && await ui(`document.querySelector('${card} .assistant-mail-toast-text')?.textContent==='Inget svar behövs: Återkoppling utan svarsbehov' && !!document.querySelector('${card} [data-undo]')`), 'Inget svar behövs leaves the mail with Ångra');
  await openMail('fixture-priority'); await pick('[data-feedback="prioritize-sender"]');
  await until(async () => (await fixtureState()).feedbackEvents.length === 2, 'sender-priority feedback');
  await openMail('fixture-shorter'); await pick('[data-feedback="shorter"]');
  await until(async () => (await fixtureState()).feedbackEvents.length === 3, 'shorter feedback');
  const feedback = (await command('status')).result.assistant;
  assert.deepEqual((await fixtureState()).feedbackEvents.map(event => event.kind), ['no-reply', 'prioritize-sender', 'shorter']);
  assert.equal(feedback.settings.preferences.shortReplies, true);
  assert.equal(feedback.settings.preferences.senderRules[0].email, 'avsandare@example.test');
  check('feedback controls dispatch no-reply, sender-priority and shorter corrections', () => {});
  await openMail('fixture-priority');
  await type('[data-item-id="fixture-priority"] [name="body"]', 'Utkast före sidbyte');
  await ui(`document.querySelector('${card} [data-view="settings"]').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-view-settings').hidden`), 'assistant settings navigation');
  await ui(`document.querySelector('${card} [data-view="settings"]').click()`);
  await until(() => ui(`!document.querySelector('${card} .assistant-view-chat').hidden`), 'return to main conversation');
  assert.equal(await ui(`document.querySelector('${card} [data-item-id="fixture-priority"] [name="body"]').value`), 'Utkast före sidbyte');
  assert.equal((await item('fixture-priority')).draft, 'Utkast före sidbyte');
  check('assistant navigation flushes dirty drafts to the controller before changing views', () => {});
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(async () => await surface() === 'mail' && await mailPage() === 'item' && await ui(`document.activeElement===document.querySelector('${detail} .assistant-mail-detail-title')`), 'Mejl reopens on the same mail with focus on it');
  await type('[data-item-id="fixture-priority"] [name="body"]', 'Utkast före kontextsamtal');
  await pick('[data-mail-action="chat"]');
  await until(() => ui(`document.querySelector('${card} .assistant-context-chip')?.textContent.includes('Syntetiskt valt underlag')`), 'scoped mail conversation');
  assert.equal((await item('fixture-priority')).draft, 'Utkast före kontextsamtal');
  check('chat about a mail item flushes its draft and submits the current exact source revision', () => {});
  await openMail('fixture-reply');
  const draft = '[name="body"]';
  await type('[data-item-id="fixture-reply"] '+draft, 'Första långsamma utkastet');
  await until(() => ui(`document.querySelector('${card} .assistant-workspace').getAttribute('aria-busy')==='true'`), 'draft save in progress');
  await type('[data-item-id="fixture-reply"] '+draft, 'Mitt redigerade testsvar');
  await refresh();
  assert.equal(await ui(`document.querySelector('${card} [data-item-id="fixture-reply"] ${draft}').value`), 'Mitt redigerade testsvar');
  await until(async () => (await command('status')).result.assistant.items[0].draft === 'Mitt redigerade testsvar', 'draft persisted');
  await rpc('Page.reload', {}, panelSession);
  await until(() => ui(`!!document.querySelector('${card} .assistant-workspace [data-item-id="fixture-reply"]')`).catch(() => false), 'panel after reload');
  await openMail('fixture-reply');
  assert.equal(await ui(`document.querySelector('${card} [data-item-id="fixture-reply"] ${draft}').value`), 'Mitt redigerade testsvar');
  check('typing during an in-flight save survives stale polling and a full panel reload', () => {});
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'mail-detail', () => openMail('fixture-reply'), [375, 1440]);
  await type('[data-item-id="fixture-reply"] '+draft, 'Simulerat lagringsfel');
  await until(() => ui(`document.querySelector('${card} [data-item-id="fixture-reply"] .assistant-draft-status').textContent.includes('kunde inte sparas')`), 'failed save feedback'); await refresh();
  assert.equal(await ui(`document.querySelector('${card} [data-item-id="fixture-reply"] ${draft}').value`), 'Simulerat lagringsfel');
  check('failed draft saves preserve input and display an honest error', () => {});
  await type('[data-item-id="fixture-reply"] '+draft, 'Exakt godkänt testsvar');
  await until(async () => (await command('status')).result.assistant.items[0].draft === 'Exakt godkänt testsvar', 'corrected draft saved');
  // The reply is shown once; Skicka svaret asks "Skicka till …?" in the card and only its Skicka sends.
  const approval = await ui(`(()=>{const view=document.querySelector('${detail}'),open=view.querySelector('[data-send-open="fixture-reply"]'),box=view.querySelector('.assistant-mail-compose');return {to:box.firstElementChild.textContent,body:box.querySelector('textarea').value,label:open.textContent,primary:open.classList.contains('primary'),disabled:open.disabled,sends:view.querySelectorAll('[data-approve]').length}})()`);
  const openConfirm = async id => {
    await ui(`document.querySelector('${detail} [data-send-open="${id}"]').click()`);
    await until(() => ui(`!!document.querySelector('${detail} [data-approve="${id}"]') && !document.querySelector('${detail} [data-approve="${id}"]').disabled && document.activeElement?.dataset.sendCancel===${JSON.stringify(id)}`), 'Skicka till … asked');
  };
  const sendsFor = async id => (await fixtureState()).sends.filter(send => send.itemId === id);
  const unsentRevision = (await item('fixture-reply')).revision;
  await openConfirm('fixture-reply');
  const confirmShape = await ui(`(()=>{const view=document.querySelector('${detail}'),group=view.querySelector('.assistant-mail-send-confirm'),send=view.querySelector('[data-approve="fixture-reply"]');return {role:group.getAttribute('role'),question:group.querySelector('p').textContent,labelled:group.getAttribute('aria-labelledby')===group.querySelector('p').id,buttons:[...group.querySelectorAll('button')].map(button=>[button.textContent,button.classList.contains('primary')]),open:!!view.querySelector('[data-send-open]'),described:send.getAttribute('aria-describedby').split(' ').includes(group.querySelector('p').id),body:view.querySelector('.assistant-mail-compose textarea').value};})()`);
  await capturePanelShots({ ui, rpc, panelSession, artifactDir, until }, card, 'mail-confirm', async () => { await openMail('fixture-reply'); await openConfirm('fixture-reply'); }, [375, 1440]);
  await ui(`document.querySelector('${detail} [data-send-cancel="fixture-reply"]').click()`);
  await until(() => ui(`!document.querySelector('${detail} [data-approve]') && document.activeElement?.dataset.sendOpen==='fixture-reply'`), 'Avbryt closes the question');
  const afterCancel = { sends: await sendsFor('fixture-reply'), item: await item('fixture-reply') };
  await openConfirm('fixture-reply');
  await ui(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await until(async () => await ui(`!document.querySelector('${detail} [data-approve]') && document.activeElement?.dataset.sendOpen==='fixture-reply'`) && await mailPage() === 'item', 'Escape closes the question and stays on the mail');
  const afterEscape = { sends: await sendsFor('fixture-reply'), item: await item('fixture-reply') };
  check('Skicka svaret asks "Skicka till mottagare@example.test?" in the card; Avbryt and Escape send nothing', () => {
    assert.deepEqual(approval, { to: 'Till: mottagare@example.test', body: 'Exakt godkänt testsvar', label: 'Skicka svaret', primary: true, disabled: false, sends: 0 });
    assert.deepEqual(confirmShape, { role: 'group', question: 'Skicka till mottagare@example.test?', labelled: true, buttons: [['Avbryt', false], ['Skicka', true]], open: false, described: true, body: 'Exakt godkänt testsvar' });
    for (const after of [afterCancel, afterEscape]) {
      assert.deepEqual(after.sends, []); assert.equal(after.item.status, 'open'); assert.equal(after.item.revision, unsentRevision);
    }
  });
  // The question is about what the user saw: a change to the mail, an edit to the text or
  // leaving Mejl closes it, and nothing is sent.
  await openConfirm('fixture-reply');
  const changedFrom = await item('fixture-reply');
  await command('correct', { action: 'draft', itemId: 'fixture-reply', revision: String(changedFrom.revision), body: 'Exakt godkänt testsvar' });
  await refresh();
  await until(() => ui(`!document.querySelector('${detail} [data-approve]') && !!document.querySelector('${detail} [data-send-open]') && document.querySelector('${card} .assistant-mail-toast-text')?.textContent==='Mejlet ändrades. Läs svaret igen och tryck Skicka svaret.'`), 'a changed mail closes the question');
  const afterChange = await sendsFor('fixture-reply');
  await openConfirm('fixture-reply');
  const typedClosed = await ui(`(()=>{const editor=document.querySelector('${detail} [name="body"]');editor.focus();editor.value='Exakt godkänt testsvar ';editor.dispatchEvent(new Event('input',{bubbles:true}));return {question:!!document.querySelector('${detail} [data-approve]'),focus:document.activeElement?.name,open:document.querySelector('${detail} [data-send-open]')?.disabled};})()`);
  await type('[data-item-id="fixture-reply"] [name="body"]', 'Exakt godkänt testsvar');
  await until(async () => (await item('fixture-reply')).draft === 'Exakt godkänt testsvar' && await ui(`!document.querySelector('${detail} [data-send-open]').disabled`), 'edit saved');
  const afterEdit = await sendsFor('fixture-reply');
  await openConfirm('fixture-reply');
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(async () => await surface() === 'chat', 'left Mejl with the question open');
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(async () => await surface() === 'mail' && await mailPage() === 'item' && await ui(`!document.querySelector('${detail} [data-approve]') && !!document.querySelector('${detail} [data-send-open]')`), 'back in Mejl without the old question');
  const afterReturn = await sendsFor('fixture-reply');
  check('a change to the mail, an edit or leaving Mejl closes "Skicka till …?" and sends nothing', () => {
    assert.deepEqual([afterChange, afterEdit, afterReturn], [[], [], []]);
    assert.deepEqual(typedClosed, { question: false, focus: 'body', open: true });
  });
  // Skicka pressed twice at once reaches the host once. The host's answer is held while the user
  // presses refresh, Escape, ← and Mejl and Skicka once more: nothing is sent again and the question
  // is not taken back while the send is on its way. Once the answer arrives the card says the reply
  // is sent, with no notice that the mail changed, also after leaving Mejl and coming back.
  const sendRevision = (await item('fixture-reply')).revision;
  await openConfirm('fixture-reply');
  await command('history', { action: 'fixture-send-hold' });
  const onItsWay = () => ui(`({question:!!document.querySelector('${detail} [data-approve="fixture-reply"]'),disabled:document.querySelector('${detail} [data-approve="fixture-reply"]')?.disabled??null,page:document.querySelector('${detail}').hidden?'not the mail':document.querySelector('${detail}').dataset.itemId,surface:document.querySelector('${card} .assistant-workspace').dataset.surface})`);
  let held;
  try {
    // A notice already shown before the send is marked, so only a new one counts below.
    await ui(`(()=>{document.querySelectorAll('${card} .assistant-mail-toast').forEach(toast=>toast.dataset.beforeSend='true');const send=document.querySelector('${detail} [data-approve="fixture-reply"]');send.click();send.click();})()`);
    await until(async () => (await sendsFor('fixture-reply')).length > 0, 'the send reached the host');
    const clicked = await onItsWay();
    await ui(`(()=>{document.querySelector('#refresh').click();document.querySelector('${detail}').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));document.querySelector('${card} .assistant-back').click();document.querySelector('${card} [data-view="mail"]').click();document.querySelector('${detail} [data-approve="fixture-reply"]')?.click();})()`);
    held = { clicked, after: await onItsWay(), sends: (await sendsFor('fixture-reply')).length };
  } finally { await command('history', { action: 'fixture-send-release' }); }
  const answered = await until(async () => (await item('fixture-reply')).status === 'sent' && await ui(`document.querySelector('${detail} .assistant-mail-next')?.textContent==='Svaret är skickat.' && document.activeElement===document.querySelector('${detail} .assistant-mail-next')`), 'isolated approval').then(() => true, () => false);
  const notices = await ui(`[...document.querySelectorAll('${card} .assistant-mail-toast:not([data-before-send]) .assistant-mail-toast-text')].map(text=>text.textContent)`);
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(async () => await surface() === 'chat', 'left Mejl after the send');
  await ui(`document.querySelector('${card} [data-view="mail"]').click()`);
  await until(async () => await surface() === 'mail' && await mailPage() === 'item', 'back in Mejl on the sent mail');
  const returned = await ui(`({question:!!document.querySelector('${detail} [data-approve]'),sentence:document.querySelector('${detail} .assistant-mail-next')?.textContent})`);
  const sent = { sends: await sendsFor('fixture-reply'), item: await item('fixture-reply') };
  check('while the send is on its way, refresh, Escape, ← and Mejl neither send again nor take the question back', () => {
    const onTheWay = { question: true, disabled: true, page: 'fixture-reply', surface: 'mail' };
    assert.deepEqual(held, { clicked: onTheWay, after: onTheWay, sends: 1 });
  });
  check('once the held answer arrives the card says the reply is sent, with no notice that the mail changed, also after leaving Mejl', () => {
    assert.equal(answered, true, 'the card says "Svaret är skickat." with focus on it');
    assert.deepEqual(notices, []);
    assert.deepEqual(returned, { question: false, sentence: 'Svaret är skickat.' });
  });
  check('Skicka sends exactly once: the saved text to the sourced recipient at the mail’s revision', () => {
    assert.deepEqual(sent.sends, [{ itemId: 'fixture-reply', body: 'Exakt godkänt testsvar', revision: sendRevision }]);
    assert.equal(sent.item.draft, 'Exakt godkänt testsvar');
  });
  check('explicit approval dispatches one exact recipient/body snapshot through the module', () => {});
  // Typing and then sending at once: Skicka svaret waits for the saved draft, and ← still leaves the mail.
  await openMail('fixture-priority');
  const quick = await ui(`(()=>{const editor=document.querySelector('${detail} [name="body"]');editor.value='Snabbt godkänt testsvar';editor.dispatchEvent(new Event('input',{bubbles:true}));const open=document.querySelector('${detail} [data-send-open="fixture-priority"]');open.click();const status=document.querySelector('${detail} .assistant-approval-status');return {disabled:open.disabled,status:status.hidden?'':status.textContent,described:open.getAttribute('aria-describedby')===status.id,confirm:!!document.querySelector('${detail} [data-approve]')};})()`);
  const quickUnsent = (await item('fixture-priority')).status;
  await until(async () => (await item('fixture-priority')).draft === 'Snabbt godkänt testsvar' && await ui(`!document.querySelector('${detail} [data-send-open="fixture-priority"]').disabled && document.querySelector('${detail} .assistant-approval-status').hidden`), 'quick draft saved and Skicka svaret unlocked');
  await openConfirm('fixture-priority');
  const fromShown = await ui(`({lines:[...document.querySelectorAll('${detail} .assistant-mail-compose .assistant-mail-to')].map(e=>e.textContent),question:document.querySelector('${detail} .assistant-mail-send-confirm p').textContent})`);
  // Text typed while the send is on its way is never saved over the sent mail and never blocks ←.
  await ui(`(()=>{document.querySelector('${detail} [data-approve="fixture-priority"]').click();const editor=document.querySelector('${detail} [name="body"]');editor.value='Skrivet medan svaret skickas';editor.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(async () => (await item('fixture-priority')).status === 'sent' && await ui(`document.querySelector('${card} .assistant-mail-toast-text')?.textContent==='Svaret är godkänt. Det du skrev efter godkännandet sparades inte.'`), 'quick approval sent');
  await ui(`document.querySelector('${card} .assistant-back').click()`);
  await until(async () => await mailPage() === 'inbox', '← after approving right after typing');
  const quickSent = await item('fixture-priority');
  const quickSends = await sendsFor('fixture-priority');
  check('a reply from another permitted address shows it on the card and in the question, and sends exactly it', () => {
    assert.deepEqual(fromShown, { lines: ['Från: alias@example.test', 'Till: mottagare@example.test'], question: 'Skicka från alias@example.test till mottagare@example.test?' });
    assert.equal(quickSends.at(-1).sender, 'alias@example.test');
  });
  check('Skicka svaret waits for the saved draft, and ← works right after sending', () => {
    assert.deepEqual(quick, { disabled: true, status: 'Sparar utkastet…', described: true, confirm: false });
    assert.equal(quickUnsent, 'open', 'a click while the draft is unsaved sends nothing');
    assert.equal(quickSent.draft, 'Snabbt godkänt testsvar', 'the approved text is what was sent');
  });
  await until(async () => { const after = await mailBadge(); return after.queued < counted.queued && after.text === String(after.queued) && after.label === `Mejl, ${after.queued} väntar`; }, 'Mejl counter follows handled decisions');
  check('the Mejl counter drops when decisions are handled', () => {});
  await openMail('fixture-action');
  const actionCard = await cardShape();
  check('a card that needs the user says so in one sentence with Klar as its main button and only Påminn mig below', () => {
    assert.deepEqual(actionCard, { sentence: 'Läs mejlet och gör det som behövs. Tryck Klar när du är färdig.', main: [['done', 'Klar']], primary: 1, small: ['remind'], menu: ['original', 'evidence', 'lookup', 'chat'], done: 1 });
  });
  assert.equal(await ui(`document.querySelector('${detail} [data-mark-done="fixture-action"]').textContent`), 'Klar');
  await ui(`document.querySelector('${detail} [data-mark-done="fixture-action"]').click()`);
  await until(async () => (await item('fixture-action')).status === 'dismissed', 'dismissed action');
  const undoShown = await ui(`({page:!document.querySelector('${card} .assistant-mail-inbox').hidden,text:document.querySelector('${card} .assistant-mail-toast-text')?.textContent,role:document.querySelector('${card} .assistant-mail-toast-region').getAttribute('role'),focus:document.activeElement?.closest('[data-item-id]')?.dataset.itemId,gone:!document.querySelector('${card} [data-panel="todo"] [data-item-id="fixture-action"]')})`);
  check('Klar returns to the list, moves focus to the next mail and offers Ångra in a status region', () => {
    assert.equal(undoShown.page, true); assert.equal(undoShown.text, 'Klar: Isolerad åtgärd'); assert.equal(undoShown.role, 'status'); assert.equal(undoShown.gone, true);
    assert.ok(undoShown.focus && undoShown.focus !== 'fixture-action', JSON.stringify(undoShown));
  });
  const undoOrder = await ui(`(()=>{const view=document.querySelector('${card} .assistant-view-mail'),region=view.querySelector('.assistant-mail-toast-region');const focusable=[...view.querySelectorAll('button,input,select,textarea,a[href]')].filter(element=>!element.disabled&&element.tabIndex>=0&&!element.closest('[hidden]')&&element.getClientRects().length);const todo=focusable.filter(element=>element.closest('[data-panel="todo"]'));return {afterList:focusable.indexOf(region.querySelector('[data-undo]'))===focusable.indexOf(todo.at(-1))+1,inInbox:region.parentElement===view.querySelector('.assistant-mail-inbox'),beforePager:region.nextElementSibling===view.querySelector('.assistant-item-pagination')};})()`);
  check('Ångra comes right after the last row of Att göra in Tab order', () => assert.deepEqual(undoOrder, { afterList: true, inInbox: true, beforePager: true }));
  await ui(`document.querySelector('${card} [data-undo]').click()`);
  await until(async () => (await item('fixture-action')).status === 'open' && (await fixtureState()).reopens.at(-1) === 'fixture-action', 'Ångra reopens');
  await until(() => ui(`!!document.querySelector('${card} [data-panel="todo"] [data-item-id="fixture-action"]') && document.querySelector('${card} .assistant-mail-toast-text')?.textContent==='Mejlet är tillbaka i Att göra.' && !document.querySelector('${card} [data-undo]')`), 'mail back in Att göra');
  check('Ångra calls reopen and the mail is back in Att göra', () => {});
  await openMail('fixture-info-3');
  const infoCard = await cardShape();
  check('a mail för kännedom says "Bara för kännedom." with Klar as its main button and only Påminn mig below', () => {
    assert.deepEqual(infoCard, { sentence: 'Bara för kännedom.', main: [['done', 'Klar']], primary: 1, small: ['remind'], menu: ['original', 'evidence', 'lookup', 'chat'], done: 1 });
  });
  await toInbox();
  await ui(`document.querySelector('${card} [data-mark-done="fixture-info-1"]').click()`);
  await until(async () => (await item('fixture-info-1')).status === 'dismissed' && await ui(`!!document.querySelector('${card} [data-undo]')`), 'Klar on a row');
  await ui(`document.querySelector('${card} [data-undo]').click()`);
  await until(async () => (await item('fixture-info-1')).status === 'open', 'Ångra after Klar on a row');
  check('Klar on a row för kännedom works without opening the mail, and Ångra brings it back', () => {});
  const accountOptions = await ui(`[...document.querySelectorAll('${card} [name="mail-account"] option')].map(option=>[option.value,option.textContent])`);
  const filterTo = async value => {
    await ui(`(()=>{const select=document.querySelector('${card} [name="mail-account"]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    return ui(`({rows:[...document.querySelectorAll('${card} [data-panel="todo"] [data-item-id]')].map(row=>row.dataset.itemId),accounts:document.querySelectorAll('${card} [data-panel="todo"] .assistant-mail-account').length})`);
  };
  const outlookOnly = await filterTo('fixture-outlook'), everyAccount = await filterTo('');
  check('the account filter lists every account and shows only that account’s mail', () => {
    assert.deepEqual(accountOptions, [['', 'Alla konton'], ['fixture-gmail', 'Isolerat Gmail'], ['fixture-outlook', 'Isolerat Outlook'], ['fixture-zoho', 'Isolerat Zoho']]);
    assert.deepEqual(outlookOnly, { rows: ['fixture-info-2'], accounts: 0 });
    assert.ok(everyAccount.rows.length > 1 && everyAccount.rows.includes('fixture-info-2') && everyAccount.accounts > 0, JSON.stringify(everyAccount));
  });
  await ui(`document.querySelector('${card} [data-done-all]').click()`);
  const confirmAll = await ui(`({text:document.querySelector('${card} .assistant-mail-confirm p').textContent,focus:document.activeElement?.dataset.doneAllConfirm==='true',label:document.querySelector('${card} [data-done-all-confirm]').textContent})`);
  await ui(`[...document.querySelectorAll('${card} .assistant-mail-confirm button')].find(button=>button.textContent==='Avbryt').click()`);
  assert.equal(await ui(`!document.querySelector('${card} .assistant-mail-confirm') && document.activeElement?.dataset.doneAll==='true'`), true, 'Avbryt closes the question without a change');
  assert.deepEqual((await fixtureState()).bulk, []);
  await ui(`document.querySelector('${card} [data-done-all]').click()`);
  await ui(`document.querySelector('${card} [data-done-all-confirm]').click()`);
  await until(async () => (await fixtureState()).bulk.length === 1, 'Klar för alla');
  const bulk = await fixtureState(), afterBulk = (await command('status')).result.assistant.items;
  check('Klar för alla asks first and then marks every mail för kännedom in one dismiss-many', () => {
    assert.deepEqual(confirmAll, { text: 'Markera 3 mejl för kännedom som klara?', focus: true, label: 'Ja, markera 3 som klara' });
    assert.deepEqual(bulk.bulk, [['fixture-info-1', 'fixture-info-2', 'fixture-info-3']]);
    assert.ok(['fixture-info-1', 'fixture-info-2', 'fixture-info-3'].every(id => afterBulk.find(entry => entry.id === id).status === 'dismissed'));
  });
  await until(() => ui(`!document.querySelector('${card} [data-group="info"]') && document.querySelector('${card} .assistant-mail-toast-text')?.textContent==='3 mejl för kännedom är markerade som klara.'`), 'kännedom group cleared');
  await openMail('fixture-question');
  await type('[data-item-id="fixture-question"] [name="answer"]', 'Tisdag');
  await ui(`document.querySelector('${card} [data-item-id="fixture-question"] [name="answer"]').form.requestSubmit()`);
  await until(async () => (await command('status')).result.assistant.items[1].answer === 'Tisdag', 'finding answer');
  await pick('[data-mail-action="snooze-next-week"]');
  await until(async () => (await item('fixture-question')).status === 'snoozed', 'snoozed item');
  const nextWeek = (await item('fixture-question')).snoozedUntil;
  await openMail('fixture-shorter'); await pick('[data-mail-action="snooze-tomorrow"]');
  await until(async () => (await item('fixture-shorter')).status === 'snoozed', 'snoozed until tomorrow');
  const tomorrow = (await item('fixture-shorter')).snoozedUntil;
  const stockholm = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  check('Påminn nästa vecka is Monday 08:00 and Påminn i morgon is tomorrow 08:00 in the user’s time zone', () => {
    assert.match(stockholm(nextWeek), /^måndag,? \d{4}-\d\d-\d\d 08:00$/); const days = (Date.parse(nextWeek) - Date.now()) / 86_400_000; assert.ok(days > 0 && days <= 8, String(days));
    assert.match(stockholm(tomorrow), / 08:00$/);
    const next = new Date(`${today}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); assert.ok(stockholm(tomorrow).includes(next.toISOString().slice(0, 10)), `${stockholm(tomorrow)} after ${today}`);
  });
  check('finding questions and snoozing persist through their panel actions', () => {});
  await toInbox(); await ui(`document.querySelector('${card} [data-tab="done"]').click()`);
  const doneRows = await ui(`Object.fromEntries([...document.querySelectorAll('${card} [data-panel="done"] [data-item-id]')].map(row=>[row.dataset.itemId,row.querySelector('.assistant-mail-chip').textContent]))`);
  check('Klart lists done, sent and snoozed mail with their status', () => {
    assert.equal(doneRows['fixture-info-1'], 'Klar'); assert.equal(doneRows['fixture-no-reply'], 'Inget svar behövs'); assert.equal(doneRows['fixture-reply'], 'Svar skickat');
    assert.match(doneRows['fixture-question'], /^Påminner (mån \d+ \S+|i morgon) 08:00$/);
  });
  // After Ångra has gone, a done mail in Klart moves back from its ⋯ at its current revision.
  await ui(`document.querySelector('${card} [data-panel="done"] [data-item-id="fixture-no-reply"] .assistant-mail-row').click()`);
  await until(() => ui(`!document.querySelector('${detail}').hidden && document.querySelector('${detail}').dataset.itemId==='fixture-no-reply'`), 'done mail opened from Klart');
  const doneCard = await cardShape();
  const doneRevision = (await item('fixture-no-reply')).revision;
  await pick('[data-mail-action="reopen"]');
  await until(async () => (await item('fixture-no-reply')).status === 'open' && (await fixtureState()).reopens.at(-1) === 'fixture-no-reply' && await ui(`document.querySelector('${card} .assistant-mail-toast-text')?.textContent==='Mejlet är tillbaka i Att göra.'`), 'moved back to Att göra from Klart');
  const movedBack = await item('fixture-no-reply');
  check('⋯ on a done mail in Klart has Flytta tillbaka, which reopens it at its current revision', () => {
    assert.deepEqual(doneCard, { sentence: 'Du markerade att inget svar behövs.', main: [], primary: 0, small: [], menu: ['original', 'evidence', 'lookup', 'chat', 'reopen'], done: 0 });
    assert.equal(movedBack.revision, doneRevision + 1); assert.equal(movedBack.feedback, undefined);
  });
  await ui(`document.querySelector('${card} [data-tab="todo"]').click()`);
  // Klar once more; the page records when Ångra appears and goes while the next steps run.
  await openMail('fixture-action');
  await ui(`(()=>{const region=document.querySelector('${card} .assistant-mail-toast-region'),timing=window.__undoTiming={};const observer=new MutationObserver(()=>{const shown=!!region.querySelector('[data-undo]');if(shown&&timing.shown===undefined)timing.shown=performance.now();if(!shown&&timing.shown!==undefined){timing.gone=performance.now();observer.disconnect();}});observer.observe(region,{childList:true,subtree:true});})()`);
  await ui(`document.querySelector('${detail} [data-mark-done="fixture-action"]').click()`);
  await until(async () => (await item('fixture-action')).status === 'dismissed' && await ui(`window.__undoTiming.shown!==undefined`), 'Klar again');
  check('marking a finding complete persists a local dismissal', () => {});
  // While a check runs, only the sentence is live; each new thread count shows beside it unannounced.
  const sentence = `${card} .assistant-mail-status-text [aria-live]`, threadCount = `${card} .assistant-mail-status-threads`;
  await command('start', { task: 'check-mail-running' }); await refresh();
  await until(() => ui(`document.querySelector('${sentence}')?.textContent==='Kollar dina mejl…' && document.querySelector('${threadCount}').textContent===' · 2 trådar bedömda och sparade'`), 'running status row');
  await ui(`(()=>{window.__liveChanges=0;window.__liveObserver=new MutationObserver(list=>{window.__liveChanges+=list.length;});window.__liveObserver.observe(document.querySelector('${sentence}'),{childList:true,subtree:true,characterData:true});})()`);
  for (const threads of [3, 4, 5]) {
    await command('history', { action: 'fixture-threads', threads: String(threads) }); await refresh();
    await until(() => ui(`document.querySelector('${threadCount}').textContent===' · ${threads} trådar bedömda och sparade'`), `${threads} threads shown`);
  }
  const quietCounts = await ui(`({changes:window.__liveChanges,outside:!document.querySelector('${threadCount}').closest('[aria-live]'),text:document.querySelector('${card} .assistant-mail-status-text').textContent})`);
  await command('resume'); await refresh();
  await until(() => ui(`document.querySelector('${sentence}').textContent==='Kontrollen är delvis klar.' && window.__liveChanges>0 && document.querySelector('${threadCount}').textContent===''`), 'a finished partial check changes the sentence');
  await ui(`window.__liveObserver.disconnect()`);
  check('the thread count updates outside the live sentence, which is read out only when its meaning changes', () => {
    assert.deepEqual(quietCounts, { changes: 0, outside: true, text: 'Kollar dina mejl… · 5 trådar bedömda och sparade' });
  });
  await toChat();
  assert.equal(await ui(`document.querySelector('${card} .assistant-view-chat').hidden`), false);
  await command('start', { task: 'follow-ups-help' }); await refresh();
  await until(() => ui(`!!document.querySelector('${card} .assistant-help')`), 'manual help state');
  assert.equal(await ui(`document.querySelector('${card} .assistant-mail-status-text').textContent`), 'Tabai behöver din hjälp.');
  await toInbox();
  const helpRows = await ui(`[...document.querySelectorAll('${card} .assistant-mail-alert')].map(row=>[row.dataset.alertAccount,row.querySelector('.assistant-mail-alert-text').textContent,row.querySelector('button').dataset.alertAction])`);
  await ui(`document.querySelector('${card} [data-alert-account="fixture-outlook"] button').click()`);
  await until(async () => await mailPage() === 'runs' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Kontroller' && document.querySelector('${card} .assistant-help').getClientRects().length>0 && !!document.activeElement?.closest('.assistant-progress')`), 'Åtgärda leads to the help');
  check('a run waiting for help shows a red row for that account, and Åtgärda leads to the help under Kontroller', () => {
    assert.deepEqual(helpRows, [['fixture-outlook', 'Isolerat Outlook behöver din hjälp', 'help'], ['fixture-zoho', 'Isolerat Zoho visas i en vy som Tabai inte kan läsa', 'status']]);
  });
  await ui(`document.querySelector('${card} .assistant-back').click()`);
  await until(async () => await mailPage() === 'inbox' && await ui(`document.activeElement===document.querySelector('${card} [data-alert-account="fixture-outlook"] button')`), 'back to the red row');
  check('← from the help returns focus to its Åtgärda', () => {});
  await ui(`document.querySelector('${card} [data-alert-account="fixture-outlook"] button').click()`);
  await until(async () => await mailPage() === 'runs' && await ui(`document.querySelector('${card} .assistant-help')?.getClientRects().length>0`), 'return to the selected help');
  const helpContract = await ui(`(()=>{const progress=document.querySelector('${card} .assistant-progress'),help=progress.querySelector('.assistant-help'),message='Öppna den parkerade tråden och visa hela konversationen.',coverage=progress.querySelector('details[data-keep="assistant-coverage"]');coverage.open=true;const probe=document.createElement('i');probe.style.color='var(--danger)';document.body.append(probe);const danger=getComputedStyle(probe).color;probe.style.color='var(--warning)';const warning=getComputedStyle(probe).color;probe.remove();const rows=[...coverage.querySelectorAll('.assistant-coverage-row')];return {blocks:progress.querySelectorAll('.assistant-help').length,account:help.dataset.helpAccount,heading:help.querySelector('strong').textContent,messageCount:[...progress.querySelectorAll('p')].filter(node=>node.textContent===message).length,overview:progress.querySelector('.assistant-overview-message').textContent,buttons:[...help.querySelectorAll('button')].map(button=>button.textContent),showWork:[...progress.querySelectorAll('button')].filter(button=>button.textContent==='Visa arbete').length,counts:rows.map(row=>[row.dataset.accountId,[...row.querySelectorAll('p')].find(node=>/trådar bedömda och sparade$/.test(node.textContent))?.textContent]),tones:rows.filter(row=>['fixture-outlook','fixture-zoho'].includes(row.dataset.accountId)).map(row=>[row.dataset.accountId,row.dataset.tone,getComputedStyle(row.querySelector('.assistant-coverage-status')).color]),colors:{danger,warning}};})()`);
  check('help is one exact account-targeted block; account counts remain visible and warning coverage is amber', () => {
    assert.deepEqual({ blocks: helpContract.blocks, account: helpContract.account, heading: helpContract.heading, messageCount: helpContract.messageCount, overview: helpContract.overview, buttons: helpContract.buttons, showWork: helpContract.showWork }, { blocks: 1, account: 'fixture-outlook', heading: 'Isolerat Outlook behöver hjälp', messageCount: 1, overview: 'Kontrollen väntar på hjälp. Övriga kontons resultat är sparade.', buttons: ['Öppna den blockerade fliken', 'Kontrollera och fortsätt'], showWork: 0 });
    assert.deepEqual(helpContract.counts, [['fixture-gmail', '3 trådar bedömda och sparade'], ['fixture-outlook', '2 trådar bedömda och sparade'], ['fixture-zoho', '4 trådar bedömda och sparade']]);
    assert.deepEqual(helpContract.tones, [['fixture-outlook', 'danger', helpContract.colors.danger], ['fixture-zoho', 'warning', helpContract.colors.warning]]);
  });
  // The card's markup is checked on every run; it is written out as a static page only with an artifact directory.
  const panelMarkup = await ui(`document.querySelector('${card}').outerHTML`);
  assert.equal(/<script\b/i.test(panelMarkup), false, 'the synthetic fixture card contains no executable scripts');
  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    const logo = `data:image/png;base64,${readFileSync(join(process.cwd(), 'extension/assets/tabai-mandala.png')).toString('base64')}`;
    const staticPanel = panelMarkup.replaceAll('assets/tabai-mandala.png', logo);
    const styles = readFileSync(join(process.cwd(), 'extension/sidepanel.css'), 'utf8');
    writeFileSync(join(artifactDir, 'assistant-mail-recovery-help.html'), `<!doctype html><html lang="sv" data-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabai · syntetisk kontovis återhämtning</title><style>${styles}</style></head><body><main class="shell">${staticPanel}</main></body></html>`);
  }
  const helpViewport = await ui('({width:innerWidth,height:innerHeight})');
  for (const width of [375, 768, 1440]) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, panelSession);
    await ui(`document.querySelector('${card} .assistant-progress').scrollIntoView({block:'start'})`);
    assert.equal(await ui(`(()=>{const help=document.querySelector('${card} .assistant-help'),rect=help.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&rect.left>=0&&rect.right<=innerWidth&&[...help.querySelectorAll('button')].every(button=>button.scrollWidth<=button.clientWidth&&button.getBoundingClientRect().height>=44);})()`), true, `the single help block fits at ${width}px`);
  }
  await rpc('Emulation.setDeviceMetricsOverride', { ...helpViewport, deviceScaleFactor: 1, mobile: false }, panelSession);
  await ui(`document.querySelector('${card} .assistant-help button').click()`);
  await until(async () => JSON.stringify((await fixtureState()).openedHelp) === JSON.stringify({ accountId: 'fixture-outlook', tabId: 87 }), 'the exact blocked help tab opened');
  assert.equal(await ui(`document.querySelectorAll('${card} .assistant-help').length`), 1);
  await click('Kontrollera och fortsätt');
  await until(async () => (await command('status')).result.assistant.current.status === 'review', 'manual help resumed');
  assert.deepEqual((await fixtureState()).resumes.at(-1), { runId: (await command('status')).result.assistant.current.id, helpAccountId: 'fixture-outlook' });
  assert.equal(await ui(`!![...document.querySelectorAll('${card} button')].find(button=>button.textContent==='Kontrollera och fortsätt')`), false);
  check('manual-help waiting work offers the parked tab, then resumes after help', () => {});
  await command('start', { task: 'check-mail-running' }); await command('stop'); await refresh();
  await toInbox();
  await fromStartMenu('[data-mail-open="details"]');
  await until(async () => await mailPage() === 'runs' && await ui(`document.querySelector('${card} .assistant-topbar-title').textContent==='Kontroller'`), 'the continuation chooser opens under Kontroller');
  await until(() => ui(`!!document.querySelector('${card} .assistant-progress [name="continuation-model"]') && !document.querySelector('${card} .assistant-progress [name="continuation-model"]').disabled`), 'mail continuation chooser enabled after request');
  const modelChoice = `${card} .assistant-progress [name="continuation-model"]`;
  await ui(`(()=>{const select=document.querySelector('${modelChoice}');select.closest('details').open=true;select.value='codex:gpt-6.1-sol';select.dispatchEvent(new Event('change',{bubbles:true}));select.focus();})()`);
  const modelChoiceBeforeRefresh = await ui(`(()=>{const select=document.querySelector('${modelChoice}');return {page:document.querySelector('${card} .assistant-mail-runs').hidden?'hidden':'runs',visible:select.getClientRects().length>0,focused:document.activeElement===select};})()`);
  assert.deepEqual(modelChoiceBeforeRefresh, { page: 'runs', visible: true, focused: true }, 'the continuation model select is visible and focused before polling');
  const continuationWorkspace = (await command('status')).result.assistant;
  const pollingMarker = `Syntetisk modellpoll ${++hostRefresh}`;
  const marked = await command('correct', { action: 'settings', revision: String(continuationWorkspace.revision), settings: JSON.stringify({ ...continuationWorkspace.settings, tone: pollingMarker }) });
  assert.equal(marked.ok, true);
  await refresh();
  await until(() => ui(`document.querySelector('${card} [name="tone"]').value===${JSON.stringify(pollingMarker)} && document.querySelector('${modelChoice}').value==='codex:gpt-6.1-sol' && !document.querySelector('${modelChoice}').disabled && document.querySelector('${modelChoice}').closest('details').open`), 'mail model choice survives a fresh poll');
  assert.equal(await ui(`document.activeElement===document.querySelector('${modelChoice}')`), true, 'polling keeps keyboard focus in the continuation model select');
  await ui(`document.querySelector('${modelChoice}').closest('details').querySelector('button').click()`);
  await until(async () => (await command('status')).result.assistant.current.model === 'codex:gpt-6.1-sol', 'explicit mail model reaches host');
  check('the mail continuation chooser remains enabled, keeps an explicit selection across polls and submits only that model', () => {});

  await command('start', { task: 'send' }); await refresh();
  await until(() => ui(`document.querySelector('${card} .assistant-overview-run h4')?.textContent.includes('send')`), 'send mode rendered');
  const sendResumeLabels = await ui(`[...document.querySelectorAll('${card} button')].map(button=>button.textContent).filter(label=>label==='Fortsätt efter hjälpen'||label==='Fortsätt saknade delar'||label==='Fortsätt uppdraget'||label==='Fortsätt')`);
  assert.deepEqual(sendResumeLabels, []);
  check('send-mode runs never expose a resume action', () => {});
  await ui(`document.querySelector('${card} [data-task="prepare-meeting"]').click()`);
  await until(() => ui(`!!document.querySelector('${card} [data-panel="todo"] [data-question-key="fixture-current-question"] [name="answer"]')`), 'run question');
  await click('Stoppa uppdraget');
  await until(() => ui(`!![...document.querySelectorAll('${card} button')].find(button=>button.textContent==='Fortsätt uppdraget') && document.querySelector('${card} .assistant-mail-status-text').textContent==='Kontrollen är pausad.'`), 'paused run');
  await click('Fortsätt uppdraget');
  await until(async () => (await command('status')).result.assistant.current.status === 'review', 'resumed run');
  check('waiting work can be stopped and resumed without presenting a stale question', () => {});
  await ui(`document.querySelector('${card} [data-task="prepare-meeting"]').click()`);
  await until(() => ui(`!!document.querySelector('${card} [data-question-key="fixture-current-question"] [name="answer"]') && document.querySelector('${card} .assistant-mail-status-text').textContent==='Tabai väntar på ditt svar.'`), 'new run question');
  await type('[data-question-key="fixture-current-question"] [name="answer"]', 'Det isolerade testmötet');
  await ui(`document.querySelector('${card} [data-question-key="fixture-current-question"] [name="answer"]').form.requestSubmit()`);
  await until(async () => !(await command('status')).result.assistant.current.question, 'run question answered');
  check('meeting preparation asks and accepts missing context at the top of Att göra', () => {});
  await type('[name="tone"]', 'Osparad ton vid sidbyte');
  await type('[name="shortcut-instructions"]', 'Osparad snabbknapp vid sidbyte');
  await command('start', { task: 'custom', instructions: 'Isolerad pagineringskontroll' }); await refresh();
  await until(() => ui(`document.querySelector('${card} [data-item-page="0"]')?.textContent.includes('Visar 1–10 av 25 sparade mejl')`), 'first saved item page');
  assert.equal(await ui(`document.querySelector('${card} [data-item-page-action="previous"]').disabled`), true);
  await ui(`document.querySelector('${card} [data-item-page-action="next"]').click()`);
  await until(() => ui(`document.querySelector('${card} [data-item-page="10"]')?.textContent.includes('Visar 11–20 av 25 sparade mejl')`), 'next saved item page');
  assert.equal(await ui(`document.querySelector('${card} [name="tone"]').value`), 'Osparad ton vid sidbyte');
  assert.equal(await ui(`document.querySelector('${card} [name="shortcut-instructions"]').value`), 'Osparad snabbknapp vid sidbyte');
  assert.equal(await ui(`!!document.querySelector('${card} [data-pending-module="test-module"]')`), true);
  await ui(`document.querySelector('${card} [data-item-page-action="previous"]').click()`);
  await until(() => ui(`!!document.querySelector('${card} [data-item-page="0"]')`), 'previous saved item page');
  await ui(`document.querySelector('${card} [data-item-page-action="next"]').click()`);
  await until(() => ui(`!!document.querySelector('${card} [data-item-page="10"]')`), 'second saved item page');
  await ui(`document.querySelector('${card} [data-item-page-action="next"]').click()`);
  await until(() => ui(`document.querySelector('${card} [data-item-page="20"]')?.textContent.includes('Visar 21–25 av 25 sparade mejl')`), 'last saved item page');
  assert.equal(await ui(`document.querySelector('${card} [data-item-page-action="next"]').disabled`), true);
  check('saved-item pagination dispatches history offsets and preserves settings, shortcuts and other-agent decisions', () => {});
  await until(() => ui(`window.__undoTiming.gone!==undefined`), 'Ångra expires');
  const undoTiming = await ui(`window.__undoTiming`);
  check('Ångra is offered for 6 s and then goes away', () => { const shown = undoTiming.gone - undoTiming.shown; assert.ok(shown >= 5900 && shown < 7500, String(shown)); });
  const viewport = await ui('({width:innerWidth,height:innerHeight})');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false }, panelSession);
  await toInbox();
  await ui(`document.querySelector('${card}').scrollIntoView({block:'start'})`);
  const fold = await ui(`new Promise(resolve=>requestAnimationFrame(()=>{const inside=element=>{const rect=element.getBoundingClientRect();return rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight;};const rows=[...document.querySelectorAll('${card} [data-panel="todo"] .assistant-mail-row')];resolve({status:inside(document.querySelector('${card} .assistant-mail-status')),main:inside(document.querySelector('${card} [data-task="check-mail"]')),rows:rows.slice(0,3).map(inside),count:rows.length,overflow:document.documentElement.scrollWidth>innerWidth});}))`);
  await rpc('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, panelSession);
  check('at 375×812 the status row, Kolla mina mejl and three rows show without scrolling', () => {
    assert.ok(fold.count >= 3, JSON.stringify(fold)); assert.deepEqual({ status: fold.status, main: fold.main, rows: fold.rows, overflow: fold.overflow }, { status: true, main: true, rows: [true, true, true], overflow: false });
  });
  await toChat();
  if (artifactDir) mkdirSync(artifactDir,{recursive:true});
  for (const width of [375,768,1440]) {
    await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},panelSession);
    await ui(`document.querySelector('${card}').scrollIntoView()`);
    assert.equal(await ui('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.equal(await ui(`(()=>{const buttons=[...document.querySelectorAll('${card} .assistant-topbar button')].filter(button=>button.getClientRects().length);return buttons.length>=2&&buttons.every(button => button.scrollWidth <= button.clientWidth && button.getBoundingClientRect().height >= 44);})()`),true,`navigation labels and touch targets fit at ${width}px`);
    if (artifactDir) { const shot = await rpc('Page.captureScreenshot',{format:'png'},panelSession); writeFileSync(join(artifactDir,`assistant-${width}.png`),Buffer.from(shot.data,'base64')); }
  }
  check('assistant chat controls and settings entry fit 375, 768 and 1440 pixel panel viewports', () => {});
}

if (process.argv[2] === '--fixture') await runFixture(process.argv[3]);
