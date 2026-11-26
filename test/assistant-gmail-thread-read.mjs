import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
// The contract is account, list and evidence binding for the session read. Provider
// IO is replaced at the page-function boundary; no real mailbox is involved.
const dir = mkdtempSync(join(tmpdir(), 'tabai-gmail-thread-read-'));
try {
  await build({ entryPoints: ['src/assistant-browser.ts', 'src/assistant-agent.ts', 'src/assistant-local-state.ts', 'src/assistant-mcp-browser.ts', 'src/assistant-tools.ts'], outdir: dir, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { AssistantBrowser, AssistantBrowserError, assistantAccessError, assistantGmailOpenThreadScript, assistantGmailPrintScript, assistantGmailRowTargetsScript, assistantMessageMetadataScript } = await import(pathToFileURL(join(dir, 'assistant-browser.mjs')).href);
  const { AssistantExecutor } = await import(pathToFileURL(join(dir, 'assistant-agent.mjs')).href);
  const { AssistantLocalState } = await import(pathToFileURL(join(dir, 'assistant-local-state.mjs')).href);
  const { AssistantMcpBrowser } = await import(pathToFileURL(join(dir, 'assistant-mcp-browser.mjs')).href);

  const account = { id: 'work', provider: 'gmail', label: 'Arbete', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true };
  const other = { ...account, id: 'other', email: 'other@example.test' };
  const thread = 'aaaaaaaaaaaa0001', threadId = `gmail:${thread}`, last = 'bbbbbbbbbbbb0001', inboxUrl = `${account.url}#inbox`;
  const message = (name, address, body) => `<table class="message"><tr><td><font size=-1><b>${name}</b> &lt;${address}&gt;</font></td><td align=right><font size=-1>3 nov. 2026</font><tr><td colspan=2><font class="recipient" size=-1><div>Till: ${account.email}</div></font><tr><td colspan=2><table><tr><td><div><font size=-1>${body}</font></div></table></table>`;
  const print = (messages, { declared = messages.length, owner = account.email } = {}) => `<div class="bodycontainer"><table><tr><td></td><td align=right><font size=-1><b>Ägare &lt;${owner}&gt;</b></font></td></tr></table><hr><div class="maincontent"><table><tr><td><font size=+1><b>Ämne</b></font><br><font size=-1 color=#777>${declared} meddelanden</font></td></tr></table><hr>${messages.join('')}</div></div>`;
  const customer = message('Kund', 'kund@example.test', 'Kan ni svara?');
  const setup = ({ html = print([customer]), items = [] } = {}) => {
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir), stamp = new Date().toISOString(), saved = [], printed = [];
    const state = { response: { html, truncated: false } };
    browser.warmedTabs.add(41); browser.tabs.set(41, account);
    const ownedCalls = [];
    browser.owned = async tabId => { ownedCalls.push(tabId); return { account, url: inboxUrl }; };
    browser.call = async name => { if (name === 'read_page') return { count: 1, truncated: false }; throw new Error(`unexpected ${name}`); };
    browser.script = async (_tabId, fn, args) => {
      if (fn === assistantGmailRowTargetsScript) return [];
      if (fn === assistantMessageMetadataScript) return { nativeThread: null, nativeMessage: null, scopeText: '', areas: ['inbox'], view: 'list', truncated: false, rows: [{ thread, last, at: stamp, unread: true, text: 'Fixture', ref: null }] };
      assert.equal(fn, assistantGmailPrintScript); printed.push(args);
      return state.response;
    };
    const context = { run: { id: 'check', task: 'check-mail', checkpoints: [], startedAt: stamp, scanStartedAt: stamp }, settings: { accounts: [account, other], lookbackDays: 7 }, items, reviews: [] };
    const execution = { context, browser, callbacks: { async checkpoint(entry, result, review) { saved.push({ entry, result, review }); } } };
    return { browser, executor, execution, context, saved, printed, state, ownedCalls };
  };
  const refusal = (promise, code) => assert.rejects(promise, error => error instanceof AssistantBrowserError && error.code === code);

  // A row without any list reference is still readable, which is the point of this route.
  {
    const { browser, executor, execution, saved, printed, ownedCalls } = setup();
    const listed = executor.withInbox(execution, await browser.read(41));
    assert.deepEqual(listed.inbox.open, [], 'no click reference exists for the row');
    assert.deepEqual(listed.inbox.openThreads, [threadId]);
    assert.match(listed.inbox.note, /browser_read_thread/);
    const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: account.id, threadId });
    assert.deepEqual(printed, [[thread, account.email]], 'only the listed native ID and the expected account reach the page');
    assert.deepEqual(ownedCalls.at(-1), 41, 'the tab identity is verified for the read itself');
    assert.equal(read.view, 'detail'); assert.equal(read.historyComplete, true); assert.equal(read.truncated, false); assert.equal(read.chronological, true);
    assert.equal(read.sourceId, threadId); assert.equal(read.messageId, `gmail:message:${last}`, 'the newest message keeps the list row native ID');
    assert.equal(read.url, `https://mail.google.com/mail/u/0/#inbox/${thread}`);
    assert.equal(read.latestSender, 'kund@example.test');
    assert.match(read.text, /Kan ni svara\?/);
    assert.deepEqual(browser.readingProofs.get(account.id).filter(proof => proof.view === 'detail'), [{ area: 'inbox', view: 'detail', historyComplete: true }], 'a complete read proves the area of the list that showed it');
    assert.equal(read.warning.includes('webbvyn'), false);
    const saveResult = await executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId, messageId: read.messageId, sourceUrl: read.url, outcome: 'no-action' }, findings: [] });
    assert.equal(saveResult.inbox.remaining, 0, 'the checkpoint binds to the inbox row');
    assert.deepEqual(saved[0].review.review.rows, [{ key: threadId, version: `gmail:message:${last}` }]);
    assert.equal(executor.withInbox(execution, await browser.read(41)).inbox.openThreads, undefined, 'a reviewed row is not offered again');
  }

  // Own latest message supports already-replied through the same ordered evidence.
  {
    const { browser, executor, execution } = setup({ html: print([customer, message('Ägare', account.email, 'Vi svarar så här.')]) });
    await browser.read(41);
    const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: account.id, threadId });
    assert.equal(read.latestSender, account.email);
    assert.equal(read.messageIds.length, 2);
    assert.match(read.messageIds[0], /^content:[0-9a-f]{64}$/, 'an older message has no native ID in this view');
    assert.equal(read.messageIds[1], `gmail:message:${last}`);
    const result = await executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId, messageId: read.messageId, sourceUrl: read.url, outcome: 'already-replied' }, findings: [] });
    assert.equal(result.saved, true);
  }

  // An incomplete read can never be saved as a reviewed thread.
  {
    const { browser, executor, execution } = setup({ html: print([customer], { declared: 2 }) });
    await browser.read(41);
    const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: account.id, threadId });
    assert.equal(read.historyComplete, false);
    assert.match(read.warning, /browser_open/);
    assert.deepEqual(browser.readingProofs.get(account.id).filter(proof => proof.view === 'detail'), [{ area: 'inbox', view: 'detail', historyComplete: false }]);
    await assert.rejects(executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId, messageId: read.messageId, sourceUrl: read.url, outcome: 'no-action' }, findings: [] }), /Läs hela/);
  }
  {
    const { browser, executor, execution, state } = setup();
    await browser.read(41);
    state.response = { html: print([customer]), truncated: true };
    const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: account.id, threadId });
    assert.equal(read.truncated, true, 'a response cut in the page is not complete evidence');
    await assert.rejects(executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId, messageId: read.messageId, sourceUrl: read.url, outcome: 'no-action' }, findings: [] }), /Läs hela/);
  }

  // Only a thread the host saw for this account can be read.
  {
    const { browser, printed } = setup();
    await assert.rejects(browser.readGmailThread(account, threadId), /inte visats/, 'nothing has been listed yet');
    await browser.read(41);
    await assert.rejects(browser.readGmailThread(account, 'gmail:cccccccccccc0001'), /inte visats/);
    await assert.rejects(browser.readGmailThread(other, threadId), /inte visats/, 'a thread listed for one account is not readable through another');
    await refusal(browser.readGmailThread({ ...account, provider: 'zoho' }, threadId), 'direct-read-unsupported');
    browser.approval = { account, sourceUrl: inboxUrl };
    await refusal(browser.readGmailThread(account, threadId), 'direct-read-approval');
    assert.deepEqual(printed, [], 'a refused read never reaches the page');
  }

  // The answering session must be the configured account, by two independent signals.
  {
    const { browser, state } = setup();
    await browser.read(41);
    const listOnly = browser.observations.size;
    state.response = { error: 'account-mismatch' };
    await refusal(browser.readGmailThread(account, threadId), 'account-mismatch');
    state.response = { html: print([customer], { owner: other.email }), truncated: false };
    await refusal(browser.readGmailThread(account, threadId), 'account-mismatch');
    assert.equal(browser.observations.size, listOnly, 'a refused read leaves no evidence');
    state.response = { error: 'fetch-failed' };
    await refusal(browser.readGmailThread(account, threadId), 'direct-read-failed');
    state.response = { error: 'session-unavailable' };
    await refusal(browser.readGmailThread(account, threadId), 'direct-read-failed');
    state.response = { html: '<html>changed page</html>', truncated: false };
    await refusal(browser.readGmailThread(account, threadId), 'direct-read-failed');
  }

  // A tab that now shows another account stops the read before the page function runs.
  {
    const { browser, printed } = setup();
    await browser.read(41);
    browser.owned = async () => ({ account: other, url: inboxUrl });
    await refusal(browser.readGmailThread(account, threadId), 'account-mismatch');
    assert.deepEqual(printed, []);
  }

  // An unsent draft could print as the newest message and read as an own reply.
  {
    const { browser, executor, execution } = setup({ html: print([customer, message('Ägare', account.email, 'Osparat utkast')]) });
    const metadata = browser.script;
    browser.script = async (tabId, fn, args) => {
      const value = await metadata(tabId, fn, args);
      return fn === assistantMessageMetadataScript ? { ...value, rows: value.rows.map(row => ({ ...row, draft: true })) } : value;
    };
    await browser.read(41);
    const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: account.id, threadId });
    assert.equal(read.historyComplete, false);
    assert.match(read.warning, /utkast/);
    await assert.rejects(executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId, messageId: read.messageId, sourceUrl: read.url, outcome: 'already-replied' }, findings: [] }), /Läs hela/);
  }

  // A draft started after the list read prints exactly like a sent reply. The row is read again
  // after the print fetch; only a fresh row without a draft lets the own latest message count.
  {
    const draftSetup = html => {
      const fixture = setup({ html }), metadata = fixture.browser.script, state = { drafted: false, rowShown: true, lists: 0 };
      fixture.browser.script = async (tabId, fn, args) => {
        const value = await metadata(tabId, fn, args);
        if (fn !== assistantMessageMetadataScript) return value;
        state.lists++;
        return { ...value, rows: state.rowShown ? value.rows.map(row => ({ ...row, draft: state.drafted })) : [] };
      };
      return { ...fixture, state };
    };
    const checkpoint = (fixture, read) => fixture.executor.dispatch(fixture.execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId, messageId: read.messageId, sourceUrl: read.url, outcome: 'already-replied' }, findings: [] });
    const own = print([customer, message('Ägare', account.email, 'Ett svar som ännu bara är ett utkast.')]);
    {
      const fixture = draftSetup(own);
      await fixture.browser.read(41);
      fixture.state.drafted = true; // The user starts a reply after the list was read.
      const read = await fixture.executor.dispatch(fixture.execution, 'browser_read_thread', { accountId: account.id, threadId });
      await assert.rejects(checkpoint(fixture, read), /Läs hela/, 'an unsent draft is never closed as already answered');
      assert.equal(read.latestSender, account.email, 'the print view shows the draft as the newest message');
      assert.equal(read.historyComplete, false);
      assert.match(read.warning, /browser_open/, 'the web view reads the thread instead');
      assert.equal(fixture.state.lists, 2, 'the row was read again after the print fetch');
    }
    {
      // The list tab no longer shows the row: without a fresh row the web view decides.
      const fixture = draftSetup(own);
      await fixture.browser.read(41);
      fixture.state.rowShown = false;
      const read = await fixture.executor.dispatch(fixture.execution, 'browser_read_thread', { accountId: account.id, threadId });
      assert.equal(read.historyComplete, false, 'no fresh row, no complete history');
      await assert.rejects(checkpoint(fixture, read), /Läs hela/);
    }
    {
      // A fresh row without a draft confirms the reply was sent.
      const fixture = draftSetup(own);
      await fixture.browser.read(41);
      const read = await fixture.executor.dispatch(fixture.execution, 'browser_read_thread', { accountId: account.id, threadId });
      assert.equal(read.historyComplete, true);
      assert.equal((await checkpoint(fixture, read)).saved, true);
      assert.equal(fixture.state.lists, 2);
    }
    {
      // Someone else wrote last: no second read, as before.
      const fixture = draftSetup(print([customer]));
      await fixture.browser.read(41);
      fixture.state.drafted = true;
      const read = await fixture.executor.dispatch(fixture.execution, 'browser_read_thread', { accountId: account.id, threadId });
      assert.equal(read.historyComplete, true, 'a draft only matters where the account would be the latest sender');
      assert.equal(fixture.state.lists, 1, 'the row is not read again');
    }
  }

  // A closed tab drops what it listed instead of being offered again.
  {
    const { browser } = setup();
    await browser.read(41);
    assert.equal(browser.canReadThread(account.id, threadId), true);
    browser.owned = async () => { throw new AssistantBrowserError('failed', 'tab-closed', 'closed'); };
    await refusal(browser.readGmailThread(account, threadId), 'tab-closed');
    assert.equal(browser.canReadThread(account.id, threadId), false);
  }

  // Closing a saved item needs native IDs of older messages, so the read says so.
  {
    const { browser, executor, execution } = setup({ items: [{ id: 'i', accountId: account.id, threadId, status: 'open' }] });
    await browser.read(41);
    const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: account.id, threadId });
    assert.match(read.note, /browser_open/);
  }

  // The page function: identity, session key, no redirect and no page markup in the result.
  {
    const globals = globalThis, saved = { window: globals.window, location: globals.location, fetch: globals.fetch };
    const set = (name, value) => Object.defineProperty(globals, name, { value, configurable: true, writable: true });
    // Serialized like the real injection, so a reference to module scope fails here.
    const run = (...args) => (0, eval)(`(${assistantGmailPrintScript.toString()})`)(...args);
    const requests = [];
    const reply = (body, type = 'text/html; charset=UTF-8', ok = true) => async (url, init) => { requests.push({ url, init }); return { ok, headers: { get: () => type }, text: async () => body }; };
    try {
      set('location', { pathname: '/mail/u/2/' });
      set('window', { GLOBALS: Object.assign([], { 9: 'k3y-abc', 10: 'Owner@Example.test' }) });
      set('fetch', reply('<p>a</p><style>x</style><script>y</script>'));
      assert.deepEqual(await run(thread, account.email), { html: '<p>a</p><style>x</style><script>y</script>', truncated: false }, 'boundaries are found on the unmodified page');
      assert.equal(requests[0].url, `/mail/u/2/?ik=k3y-abc&view=pt&search=all&th=${thread}`);
      assert.deepEqual(requests[0].init, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' }, 'a redirect to a sign-in page is not followed');
      set('fetch', reply('x'.repeat(1_000_001)));
      const long = await run(thread, account.email);
      assert.equal(long.html.length, 1_000_000); assert.equal(long.truncated, true);
      requests.length = 0;
      set('fetch', reply('never'));
      set('window', { GLOBALS: Object.assign([], { 9: 'k3y-abc', 10: other.email }) });
      assert.deepEqual(await run(thread, account.email), { error: 'account-mismatch' });
      set('window', { GLOBALS: Object.assign([], { 10: account.email }) });
      assert.deepEqual(await run(thread, account.email), { error: 'session-unavailable' });
      set('window', { GLOBALS: Object.assign([], { 9: 'k3y-abc', 10: account.email }) });
      set('location', { pathname: '/mail/?authuser=1' });
      assert.deepEqual(await run(thread, account.email), { error: 'session-unavailable' });
      assert.equal(requests.length, 0, 'identity and route are checked before any request');
      set('location', { pathname: '/mail/u/0/' });
      set('fetch', reply('login', 'text/plain'));
      assert.deepEqual(await run(thread, account.email), { error: 'fetch-failed' });
      set('fetch', reply('nope', 'text/html', false));
      assert.deepEqual(await run(thread, account.email), { error: 'fetch-failed' });
      set('fetch', async () => { throw new TypeError('redirect'); });
      assert.deepEqual(await run(thread, account.email), { error: 'fetch-failed' });
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete globals[name]; else set(name, value); }
    }
  }

  // Google's identity confirmation is still a login state, named for what it asks.
  {
    const confirm = assistantAccessError(account, 'https://accounts.google.com/v3/signin/confirmidentifier?authuser=2');
    assert.equal(confirm.status, 'login'); assert.equal(confirm.code, 'login-required');
    assert.match(confirm.message, /bekräftar din identitet/);
    assert.match(assistantAccessError(account, 'https://accounts.google.com/v3/signin').message, /^Logga in som/);
  }
  // Zoho through its API: the same evidence and row binding, without any browser tab.
  {
    const zoho = { ...account, id: 'z', provider: 'zoho', url: 'https://mail.zoho.eu/zm/' }, key = 'zoho:900000001', stamp = new Date().toISOString();
    const rows = [{ key, version: 'zoho:message:100000001', at: stamp, unread: false, label: 'Kund Ämne' }];
    const entry = (messageId, folderId, incoming, sender, addressed = [account.email]) => ({ messageId, folderId, incoming, sender, from: sender, date: stamp, at: 1, recipients: `Till: ${addressed.join(', ')}`, addressed, body: `Text ${messageId}` });
    const messages = [entry('100000000', '11111', true, 'kund@example.test'), entry('100000001', '22222', true, 'kund@example.test'), entry('100000002', '33333', false, 'info@example.test', ['kund@example.test'])];
    const zohoSetup = (overrides = {}) => {
      const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir), calls = [], saved = [], consulted = [];
      browser.zohoApi = { available: target => target.provider === 'zoho', inventory: async (target, since) => { consulted.push(since); return { email: target.email, rows, sentThreads: [key], complete: true }; }, canRead: (_accountId, id) => id === key, readThread: async () => ({ subject: 'Ämne', messages, complete: true }), ...overrides };
      browser.call = async name => { calls.push(name); throw new AssistantBrowserError('failed', 'web-route', 'web route reached'); };
      const context = { run: { id: 'check', task: 'check-mail', checkpoints: [], startedAt: stamp, scanStartedAt: stamp }, settings: { accounts: [zoho], lookbackDays: 7 }, items: [], reviews: [] };
      return { browser, executor, calls, saved, consulted, context, execution: { context, browser, callbacks: { async checkpoint(item, result, review) { saved.push({ item, result, review }); } } } };
    };
    {
      const { browser, executor, execution, calls, saved, consulted } = zohoSetup();
      const opened = await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      assert.equal(opened.apiRead, true); assert.equal(opened.tabId, undefined); assert.deepEqual(calls, [], 'no browser call is made');
      assert(Math.abs(consulted[0] - (Date.now() - 7 * 86_400_000)) < 5000, 'the inventory uses the configured period');
      assert.deepEqual(opened.inbox.openThreads, [key]); assert.equal(opened.inbox.inventoryRead, true);
      assert.deepEqual(opened.sentThreads, [key]); assert.equal(opened.mailFolders, undefined);
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      assert.equal(read.view, 'detail'); assert.equal(read.historyComplete, true); assert.equal(read.sourceId, key);
      assert.equal(read.messageId, 'zoho:message:100000002', 'the conversation version is its newest message, even a sent one');
      assert.deepEqual(read.messageIds, ['zoho:message:100000000', 'zoho:message:100000001', 'zoho:message:100000002'], 'Zoho names every message natively');
      assert.equal(read.url, 'https://mail.zoho.eu/zm/#mail/folder/22222/p/100000001', 'the original opens at the newest incoming message');
      assert.equal(read.latestSender, account.email, "a reply from another address of the account, found in Zoho's Sent, is the account's own"); assert.deepEqual(read.areas, ['inbox', 'sent']);
      const result = await executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: 'z', threadId: key, messageId: read.messageId, sourceUrl: read.url, outcome: 'already-replied' }, findings: [] });
      assert.equal(result.inbox.remaining, 0); assert.deepEqual(saved[0].review.review.rows, [{ key, version: 'zoho:message:100000001' }]);
      assert.doesNotThrow(() => executor.verifyCoverage(execution, { accountId: 'z', status: 'checked' }), 'inbox and sent are proven and every row has an outcome');
      assert.equal(browser.canReadThread('z', key), true); assert.equal(browser.canReadThread('other', key), false, 'the inventory belongs to its own account');
      assert.deepEqual(browser.rowThreads.size, 0);
      browser.tabs.set(51, zoho); browser.warmedTabs.add(51);
      const webUrl = read.url;
      browser.owned = async () => ({ account: zoho, url: webUrl });
      browser.call = async name => name === 'read_page' ? { count: 1, truncated: false } : (() => { throw new Error(`unexpected ${name}`); })();
      browser.script = async (_tabId, fn) => fn === assistantMessageMetadataScript ? { nativeThread: null, nativeMessage: 'web-id', scopeText: 'Tråden i webbvyn med tillräckligt med text för en identitet.', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, chronological: true, messages: [] } : { folders: [], currentId: undefined, listReady: false, state: 'unknown-layout', reason: 'x' };
      const web = await browser.read(51);
      assert.equal(browser.rowThreads.get(`z\0${key}`), web.sourceId, 'a web read of an API-listed conversation can still close its inbox row');
    }
    {
      // A sender field naming the account proves nothing: From is written by whoever sent the mail.
      const { executor, execution } = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages: [messages[0], { ...messages[1], sender: account.email }], complete: true }) });
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      assert.equal(read.latestSender, undefined, 'an incoming message is never the account, even when it claims to be');
      await assert.rejects(executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: 'z', threadId: key, messageId: read.messageId, sourceUrl: read.url, outcome: 'already-replied' }, findings: [] }), /already-replied/);
      // A forward to a colleague leaves the customer unanswered.
      const forward = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages: [messages[0], entry('100000003', '33333', false, 'info@example.test', ['kollega@example.test'])], complete: true }) });
      await forward.executor.dispatch(forward.execution, 'browser_open', { accountId: 'z' });
      const forwarded = await forward.executor.dispatch(forward.execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      assert.equal(forwarded.latestSender, 'info@example.test');
      await assert.rejects(forward.executor.dispatch(forward.execution, 'workflow_checkpoint', { checkpoint: { accountId: 'z', threadId: key, messageId: forwarded.messageId, sourceUrl: forwarded.url, outcome: 'already-replied' }, findings: [] }), /already-replied/);
      const ownForward = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages: [messages[0], entry('100000003', '33333', false, account.email, ['kollega@example.test'])], complete: true }) });
      await ownForward.executor.dispatch(ownForward.execution, 'browser_open', { accountId: 'z' });
      assert.equal((await ownForward.executor.dispatch(ownForward.execution, 'browser_read_thread', { accountId: 'z', threadId: key })).latestSender, undefined, 'the primary address forwarding is no reply either');
      const spoof = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages: [messages[0], { ...messages[1], sender: 'annan@example.test' }], complete: true }) });
      await spoof.executor.dispatch(spoof.execution, 'browser_open', { accountId: 'z' });
      const spoofRead = await spoof.executor.dispatch(spoof.execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      assert.equal(spoofRead.latestSender, 'annan@example.test');
      await assert.rejects(spoof.executor.dispatch(spoof.execution, 'workflow_checkpoint', { checkpoint: { accountId: 'z', threadId: key, messageId: spoofRead.messageId, sourceUrl: spoofRead.url, outcome: 'already-replied' }, findings: [] }), /already-replied/, 'an incoming last message is never an own reply');
    }
    {
      const { browser, executor, execution, calls } = zohoSetup({ inventory: async () => { throw new Error('api down'); } });
      await assert.rejects(executor.dispatch(execution, 'browser_open', { accountId: 'z' }), /web route reached/);
      assert.deepEqual(calls, ['tabs_context_mcp'], 'an API failure continues on the web route');
      await assert.rejects(browser.readThread(zoho, key), /inte visats/, 'without an inventory nothing is readable');
    }
    for (const [name, args] of [['an explicit web address', [zoho, 'https://mail.zoho.eu/zm/#mail/folder/1/p/123456789', { lookbackDays: 7 }]], ['an internal caller', [zoho]]]) {
      const { browser, calls, consulted } = zohoSetup();
      await assert.rejects(browser.open(...args), /web route reached/);
      assert.deepEqual(consulted, [], `${name} never uses the inventory`); assert.equal(calls[0], 'tabs_context_mcp');
    }
    {
      const { browser, consulted } = zohoSetup();
      browser.approval = { account: zoho, sourceUrl: `${zoho.url}#mail/folder/1/p/123456789` };
      await assert.rejects(browser.open(zoho, undefined, { lookbackDays: 7 }), /godkända tråden/);
      assert.deepEqual(consulted, [], 'sending stays on the web route');
      await refusal(browser.readThread(zoho, key), 'direct-read-approval');
    }
    {
      const { browser, executor, execution } = zohoSetup();
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      await assert.rejects(browser.readThread(zoho, 'zoho:123456789'), /inte visats/);
    }
    {
      const { browser, executor, execution } = zohoSetup({ inventory: async target => ({ email: target.email, rows: [], sentThreads: [], complete: true }) });
      const opened = await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      assert.equal(opened.view, 'empty'); assert.equal(browser.inboxListed.get('z'), 'empty');
      assert.doesNotThrow(() => executor.verifyCoverage(execution, { accountId: 'z', status: 'checked' }), 'an inventory with nothing in the period proves both areas empty');
    }
    {
      const { browser, executor, execution } = zohoSetup({ inventory: async target => ({ email: target.email, rows, sentThreads: [key], complete: false }) });
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      assert.equal(browser.inboxListed.get('z'), 'unparsed', 'an inventory cut at its page limit is not called read');
      assert.equal(executor.inboxCoverage(execution, { accountId: 'z', status: 'checked', message: 'x' }).status, 'partial', 'and the account cannot end as checked');
    }
    {
      const { browser, executor, execution } = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages, complete: false }) });
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      assert.equal(read.historyComplete, false); assert.match(read.warning, /browser_open/);
      await assert.rejects(executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: 'z', threadId: key, messageId: read.messageId, sourceUrl: read.url, outcome: 'no-action' }, findings: [] }), /Läs hela/);
      assert.equal(browser.inboxRows.get('z').size, 1);
      // The web read replaces the incomplete API read, so the row and the coverage check can finish.
      browser.tabs.set(51, zoho); browser.warmedTabs.add(51);
      browser.owned = async () => ({ account: zoho, url: read.url });
      browser.call = async name => name === 'read_page' ? { count: 1, truncated: false } : (() => { throw new Error(`unexpected ${name}`); })();
      browser.script = async (_tabId, fn) => { assert.equal(fn, assistantMessageMetadataScript, 'an API account does not walk the web folder tree'); return { nativeThread: null, nativeMessage: 'web-id', scopeText: 'Tråden i webbvyn med tillräckligt med text för en identitet.', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, chronological: true, messages: [] }; };
      const web = await browser.read(51);
      assert.equal([...browser.observations.values()].some(observation => observation.sourceId === key), false, 'the incomplete API read is superseded');
      const saved = await executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: 'z', threadId: web.sourceId, messageId: web.messageId, sourceUrl: web.url, outcome: 'no-action' }, findings: [] });
      assert.equal(saved.inbox.remaining, 0, 'the web read closes the row');
      browser.readingProofs.get('z').push({ area: 'sent', view: 'empty' });
      assert.doesNotThrow(() => executor.verifyCoverage(execution, { accountId: 'z', status: 'checked' }), 'no incomplete API read is left behind to block the account');
    }
    {
      // A draft in the conversation must not move the web address away from the row's own message.
      const { browser, executor, execution } = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages: [messages[0], messages[1], entry('100000005', 'drafts', true, account.email)], complete: false }) });
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      assert.equal(read.url, 'https://mail.zoho.eu/zm/#mail/folder/22222/p/100000001', "the anchor is the row's own message");
    }
    {
      // A complete API read stays: only an incomplete one is replaced by a web read.
      const { browser, executor, execution } = zohoSetup();
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      browser.tabs.set(51, zoho); browser.warmedTabs.add(51);
      browser.owned = async () => ({ account: zoho, url: read.url });
      browser.call = async name => name === 'read_page' ? { count: 1, truncated: false } : (() => { throw new Error(`unexpected ${name}`); })();
      browser.script = async () => ({ nativeThread: null, nativeMessage: 'web-id', scopeText: 'Tråden i webbvyn med tillräckligt med text för en identitet.', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, chronological: true, messages: [] });
      const web = await browser.read(51);
      assert.equal(web.replacesThread, key);
      assert.equal([...browser.observations.values()].some(observation => observation.sourceId === key), true, 'a complete API read is kept');
    }
    {
      // A Sent-only conversation has no inbox row, and its incomplete read must still be replaceable.
      const { browser, executor, execution } = zohoSetup({ inventory: async target => ({ email: target.email, rows: [], sentThreads: [key], complete: true }), readThread: async () => ({ subject: 'Ämne', messages, complete: false }) });
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      browser.tabs.set(51, zoho); browser.warmedTabs.add(51);
      browser.owned = async () => ({ account: zoho, url: read.url });
      browser.call = async name => name === 'read_page' ? { count: 1, truncated: false } : (() => { throw new Error(`unexpected ${name}`); })();
      browser.script = async () => ({ nativeThread: null, nativeMessage: 'web-id', scopeText: 'Tråden i webbvyn med tillräckligt med text för en identitet.', areas: ['sent'], view: 'detail', truncated: false, historyComplete: true, chronological: true, messages: [] });
      const web = await browser.read(51);
      assert.equal(web.replacesThread, key);
      assert.equal([...browser.observations.values()].some(observation => observation.sourceId === key), false);
    }
    {
      // An earlier web read's pending folders do not outlive a later API inventory.
      const { browser, executor, execution } = zohoSetup();
      browser.mailFolders.set('z', new Map([['f', { id: 'f', name: 'Mapp', url: 'https://mail.zoho.eu/zm/#mail/folder/f', kind: 'custom', listRead: false }]]));
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      assert.deepEqual(browser.pendingMailFolders('z'), []);
    }
    {
      // On Zoho every message has a native ID, so an open item needs no web read to close.
      const { executor, execution, context } = zohoSetup();
      context.items = [{ id: 'i', accountId: 'z', threadId: key, status: 'open' }];
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      assert.equal((await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key })).note, undefined);
    }
    {
      // A newer message after the API read must not be covered by a web view of the older one.
      const { browser, executor, execution } = zohoSetup({ readThread: async () => ({ subject: 'Ämne', messages, complete: false }) });
      await executor.dispatch(execution, 'browser_open', { accountId: 'z' });
      const read = await executor.dispatch(execution, 'browser_read_thread', { accountId: 'z', threadId: key });
      const row = browser.inboxRows.get('z').get(key);
      browser.inboxRows.get('z').set(key, { ...row, version: 'zoho:message:100000009' });
      browser.tabs.set(51, zoho); browser.warmedTabs.add(51);
      browser.owned = async () => ({ account: zoho, url: read.url });
      browser.call = async name => name === 'read_page' ? { count: 1, truncated: false } : (() => { throw new Error(`unexpected ${name}`); })();
      browser.script = async () => ({ nativeThread: null, nativeMessage: 'web-id', scopeText: 'Tråden i webbvyn med tillräckligt med text för en identitet.', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, chronological: true, messages: [] });
      await browser.read(51);
      assert.equal(browser.rowThreads.size, 0, 'a stale anchor binds nothing');
    }
  }

  // Full access reaches files through upload tools; page text must not be able to name the credential.
  {
    const raw = []; const mcp = new AssistantMcpBrowser({ listTools: async () => ({ tools: [{ name: 'file_upload' }, { name: 'navigate' }] }), callRaw: async (name, args) => { raw.push([name, args]); return { ok: true }; }, close: async () => {} });
    await assert.rejects(mcp.call('file_upload', { tabId: 1, paths: ['/Users/x/.claude-chrome-mcp/assistant/zoho-mail-oauth.json'] }), /privat/);
    await assert.rejects(mcp.call('file_upload', { tabId: 1, paths: ['/Users/x/.claude-chrome-mcp/assistant/ZOHO-Mail-OAuth.json'] }), /privat/, 'a case variant names the same file on this file system');
    await assert.rejects(mcp.call('file_upload', { tabId: 1, paths: ['/Users/x/.claude-chrome-mcp/assistant/zoho-mail-oauth-send.json'] }), /privat/, 'the send grant is as private as the read grant');
    assert.deepEqual(raw, []);
    await mcp.call('navigate', { tabId: 1, url: 'https://example.test/' });
    assert.equal(raw.length, 1, 'other calls are unaffected');
  }

  // The local runner mirrors the host: it offers only listed threads and leaves a failed one to the web view.
  {
    const catalog = [{ name: 'browser_read_thread', description: '', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, threadId: { type: 'string' } } } }];
    const state = new AssistantLocalState();
    state.record('workflow_context', {}, JSON.stringify({ run: { task: 'check-mail' }, settings: { accounts: [{ id: 'bench' }] }, tabs: [{ tabId: 3, accountId: 'bench' }] }));
    assert.deepEqual(state.constrain(catalog), [], 'the tool is hidden until the host names a thread');
    const list = { tabId: 3, accountId: 'bench', url: inboxUrl, sourceId: '', observationId: 'o-list', page: '', text: '', areas: ['inbox'], view: 'list', inbox: { accountId: 'bench', remaining: 1, open: [], openThreads: [threadId], inventoryRead: true } };
    state.record('browser_open', { accountId: 'bench' }, JSON.stringify(list));
    const offered = state.constrain(catalog)[0].inputSchema.properties;
    assert.deepEqual(offered.threadId.enum, [threadId]); assert.deepEqual(offered.accountId.enum, ['bench']);
    assert.match(state.summary(), /browser_read_thread \(accountId bench, threadId gmail:aaaaaaaaaaaa0001\)/);
    state.record('browser_read_thread', { accountId: 'bench', threadId }, JSON.stringify({ tabId: 3, accountId: 'bench', url: `${account.url}#inbox/${thread}`, sourceId: threadId, messageId: `gmail:message:${last}`, observationId: 'o-t', text: 'x', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: false, chronological: true }));
    assert.deepEqual(state.constrain(catalog), [], 'an incomplete direct read is not offered again');
    const replaced = new AssistantLocalState();
    replaced.record('workflow_context', {}, JSON.stringify({ run: { task: 'check-mail' }, settings: { accounts: [{ id: 'bench' }] } }));
    replaced.record('browser_open', { accountId: 'bench' }, JSON.stringify({ accountId: 'bench', url: 'https://mail.zoho.eu/zm/', sourceId: '', observationId: 'r-list', text: '', areas: ['inbox'], view: 'empty', apiRead: true, sentThreads: [], inbox: { accountId: 'bench', remaining: 0, open: [], inventoryRead: true } }));
    assert.doesNotMatch(replaced.summary() ?? '', /Skickat/, 'no sent mail in the period needs no Sent read');
    replaced.record('browser_read_thread', { accountId: 'bench', threadId: 'zoho:900000001' }, JSON.stringify({ accountId: 'bench', url: 'https://mail.zoho.eu/zm/#mail/folder/1/p/100000001', sourceId: 'zoho:900000001', messageId: 'zoho:message:100000001', observationId: 'r-t', text: 'x', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: false, chronological: true }));
    assert.match(replaced.summary(), /zoho:900000001/);
    replaced.record('browser_read', { tabId: 7 }, JSON.stringify({ tabId: 7, accountId: 'bench', url: 'https://mail.zoho.eu/zm/#mail/folder/1/p/100000001', sourceId: 'zoho:100000001', messageId: 'zoho:message:w', observationId: 'r-w', text: 'x', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, chronological: true, replacesThread: 'zoho:900000001' }));
    assert.doesNotMatch(replaced.summary(), /zoho:900000001/, 'the replaced API read is no longer waiting to be saved');
    const sentState = new AssistantLocalState();
    sentState.record('workflow_context', {}, JSON.stringify({ run: { task: 'check-mail' }, settings: { accounts: [{ id: 'bench' }] } }));
    sentState.record('browser_open', { accountId: 'bench' }, JSON.stringify({ accountId: 'bench', url: 'https://mail.zoho.eu/zm/', sourceId: '', observationId: 'z-list', text: '', areas: ['inbox'], view: 'list', apiRead: true, sentThreads: ['zoho:900000001'], inbox: { accountId: 'bench', remaining: 0, open: [], inventoryRead: true } }));
    assert.deepEqual(sentState.constrain(catalog)[0].inputSchema.properties.threadId.enum, ['zoho:900000001']);
    assert.match(sentState.summary(), /läs en tråd i Skickat med browser_read_thread \(accountId bench, threadId zoho:900000001\)/i);
    assert.match(state.summary(), new RegExp(`öppna ${account.url.replace(/[./]/g, '\\$&')}#inbox/${thread} med browser_open`), 'an incomplete read of a row without a reference continues in the web view');
    const refs = new AssistantLocalState();
    refs.record('workflow_context', {}, JSON.stringify({ run: { task: 'check-mail' }, settings: { accounts: [{ id: 'bench' }] }, tabs: [{ tabId: 3, accountId: 'bench' }] }));
    refs.record('browser_open', { accountId: 'bench' }, JSON.stringify({ ...list, page: '[ref_1] row "Rad"', inbox: { ...list.inbox, open: ['ref_1'] } }));
    const clickCatalog = [{ name: 'browser_click', description: '', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, ref: { type: 'string' } } } }];
    const before = refs.constrain(clickCatalog)[0].inputSchema.properties.ref.enum;
    refs.record('browser_read_thread', { accountId: 'bench', threadId }, JSON.stringify({ tabId: 3, accountId: 'bench', url: `${account.url}#inbox/${thread}`, sourceId: threadId, messageId: `gmail:message:${last}`, observationId: 'o-t2', text: 'x', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, chronological: true }));
    assert.deepEqual(refs.constrain(clickCatalog)[0].inputSchema.properties.ref.enum, before, 'a session read leaves the tab references of the mirror intact');
  }

  // A card from a direct read can be sent while its thread is unchanged, and only then.
  {
    const { assistantToolSchemas } = await import(pathToFileURL(join(dir, 'assistant-tools.mjs')).href);
    const recipient = 'kund@example.test', latest = `gmail:message:${last}`, sourceUrl = `${account.url}#inbox/${thread}`, rewritten = `${account.url}#inbox/FMfcgzQZfixture`;
    const approval = { itemId: 'item', revision: 1, account, threadId, sourceUrl, recipient, body: 'Hej' };
    const zoho = { id: 'z', provider: 'zoho', label: 'Zoho', email: 'owner@example.test', url: 'https://mail.zoho.eu/zm/', enabled: true };
    const sendable = (target, granted, approvedMessage, { url, pageHref = url, fresh, composer = {} }) => {
      const browser = new AssistantBrowser(dir, dir, granted, approvedMessage), counts = { intent: 0, click: 0 };
      browser.tabs.set(41, target);
      browser.owned = async () => ({ account: target, url });
      browser.read = async () => ({ text: `Från ${recipient}`, ...fresh });
      browser.call = async name => {
        if (name === 'read_page') return {};
        if (name === 'resolve_target') return { ref: 'ref_9', documentId: 'd' };
        if (name === 'computer') { counts.click++; return {}; }
        throw new Error(`unexpected ${name}`);
      };
      browser.script = async (_tabId, fn) => {
        if (fn.name === 'composerScript') return { from: [granted.sender ?? target.email], to: [recipient], cc: [], bcc: [], fieldsVerified: true, unknownRecipients: [], body: 'Hej', sendRef: 'ref_9', bodyRef: 'ref_8', url: pageHref, ...composer };
        if (fn.name === 'sentFeedbackScript') return counts.click ? 'Message sent' : '';
        assert.match(fn.toString(), /location\.href/);
        if (pageHref === null) throw new Error('page pin failed');
        return pageHref;
      };
      return { browser, counts, run: () => browser.send(41, async () => { counts.intent++; }, async () => {}) };
    };
    const refused = async (setupSend, pattern, label) => {
      const { counts, run } = setupSend();
      await assert.rejects(run(), pattern, label);
      assert.deepEqual(counts, { intent: 0, click: 0 }, `nothing is dispatched: ${label}`);
    };

    // Gmail replaces the thread part of the address after loading.
    const gmail = ({ fresh, ...options } = {}) => sendable(account, approval, latest, { url: rewritten, fresh: { sourceId: threadId, messageId: latest, ...fresh }, ...options });
    {
      const { counts, run } = gmail();
      await run();
      assert.deepEqual(counts, { intent: 1, click: 1 }, 'the rewritten address is the approved thread once the page names it');
    }
    await refused(() => gmail({ pageHref: null }), /annat konto eller en annan tråd/, 'the page does not name the approved thread');
    await refused(() => gmail({ fresh: { messageId: 'gmail:message:cccccccccccc0002' } }), /måste kunna bekräftas/, 'a newer message arrived');
    await refused(() => gmail({ fresh: { sourceId: 'gmail:dddddddddddd0001' } }), /måste kunna bekräftas/, 'another thread is open');
    await refused(() => gmail({ fresh: { text: 'Inget' } }), /måste kunna bekräftas/, 'the recipient is not in the thread');
    await refused(() => gmail({ composer: { url: `${account.url}#inbox` } }), /avviker/, 'the composer left the thread');
    await refused(() => gmail({ composer: { from: ['annan@example.test'] } }), /avviker/, 'the composer names another sender');
    {
      // A card from the web route keeps working after the web view's thread name changed.
      const webCard = { ...approval, threadId: 'gmail:FMfcgzQZfixture', sourceUrl: rewritten };
      const { counts, run } = sendable(account, webCard, latest, { url: rewritten, fresh: { sourceId: threadId, messageId: latest } });
      await run();
      assert.deepEqual(counts, { intent: 1, click: 1 });
    }

    const zohoCard = { ...approval, account: zoho, threadId: 'zoho:9000000001', sourceUrl: `${zoho.url}#mail/folder/1/p/4000000001`, sender: 'alias@example.test' };
    const zohoLatest = 'zoho:message:5000000002';

    // The tab check itself runs in the page: exact address, or Gmail's own heading at the same place.
    {
      const browser = new AssistantBrowser(dir, dir, approval, latest);
      browser.tabs.set(41, account);
      let text;
      browser.call = async (_name, args) => { text = args.text; };
      await browser.script(41, function () { return 'ran'; });
      const heading = (id, { width = 10, inMail = false } = {}) => ({ getAttribute: () => id, getBoundingClientRect: () => ({ width }), closest: () => inMail ? {} : null });
      const inPage = (href, headings = []) => new Function('location', 'document', `return ${text}`)({ href, origin: new URL(href).origin, hash: new URL(href).hash }, { querySelectorAll: () => headings });
      assert.equal(inPage(sourceUrl), 'ran', 'the exact approved address');
      assert.equal(inPage(rewritten, [heading(thread)]), 'ran', 'the rewritten address when the heading names the thread');
      for (const [label, href, headings] of [
        ['no heading', rewritten, []], ['another thread', rewritten, [heading('eeeeeeeeeeee0001')]], ['a hidden heading', rewritten, [heading(thread, { width: 0 })]],
        ['a heading inside a message', rewritten, [heading(thread, { inMail: true })]], ['another mailbox area', `${account.url}#sent/FMfcgzQZfixture`, [heading(thread)]],
        ['another signed-in account', 'https://mail.google.com/mail/u/1/#inbox/FMfcgzQZfixture', [heading(thread)]],
      ]) assert.throws(() => inPage(href, headings), /Kontots sida ändrades/, label);
      const web = new AssistantBrowser(dir, dir, { ...approval, threadId: 'gmail:FMfcgzQZfixture', sourceUrl: rewritten }, latest);
      web.tabs.set(41, account); web.call = async (_name, args) => { text = args.text; };
      await web.script(41, function () { return 'ran'; });
      assert.throws(() => inPage(sourceUrl, [heading(thread)]), /Kontots sida ändrades/, 'a card without a direct ID keeps its exact address');
    }

    // Opening waits out the rewrite, so the read that follows sees a settled page.
    {
      const browser = new AssistantBrowser(dir, dir, approval, latest), urls = [sourceUrl, rewritten, rewritten];
      browser.tabs.set(41, account);
      let owned = 0;
      browser.owned = async () => ({ account, url: urls[Math.min(owned++, urls.length - 1)] });
      browser.script = async (_tabId, fn) => { assert.equal(fn, assistantGmailOpenThreadScript); if (owned === 1) throw new Error('page pin failed'); return thread; };
      await browser.settleApprovedAddress(41);
      assert.equal(owned, 3, 'a page that failed its check counts for nothing; the same named address twice is settled');
      const untouched = new AssistantBrowser(dir, dir, zohoCard, zohoLatest);
      untouched.owned = async () => { throw new Error('not needed'); };
      await untouched.settleApprovedAddress(41);
    }

    // A worker cannot name the reply address through either result tool.
    {
      const found = { accountId: account.id, threadId, kind: 'reply', title: 'T', summary: 'S', reason: 'R', priority: 1, sourceUrl, sources: [{ observationId: 'o', quote: 'q' }] };
      const finish = finding => assistantToolSchemas.workflow_finish.safeParse({ result: { summary: '', coverage: [], findings: [finding] } }).success;
      const checkpoint = finding => assistantToolSchemas.workflow_checkpoint.safeParse({ checkpoint: { accountId: account.id, threadId, messageId: latest, sourceUrl, outcome: 'needs-action' }, findings: [finding] }).success;
      assert.equal(finish(found), true); assert.equal(checkpoint(found), true);
      assert.equal(finish({ ...found, replyFrom: 'x@example.test' }), false); assert.equal(checkpoint({ ...found, replyFrom: 'x@example.test' }), false);
    }
  }
  console.log('PASS assistant-gmail-thread-read');
} finally {
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
