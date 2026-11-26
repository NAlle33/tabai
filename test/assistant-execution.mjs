import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

// Fake worker processes, sockets and their cleanup waits run about 28 s.
const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }), 300_000);
// The owned contracts are account/evidence binding, explicit send authorization,
// durable intent before one dispatch, and process cleanup. All provider IO is
// replaced at the transport boundary; these checks never touch a real mailbox.
const dir = mkdtempSync(join(tmpdir(), "tabai-assistant-execution-"));
try {
  await build({ entryPoints: ["src/assistant-browser.ts", "src/assistant-agent.ts", "src/assistant-worker.ts", "src/assistant-local-runner.ts", "src/assistant-provider-progress.ts", "src/assistant-mail-method-execution.ts"], outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, packages: "external", platform: "node", format: "esm", target: "node20", logLevel: "silent" });
  // External package resolution starts from the bundle location.
  const { symlinkSync } = await import("node:fs");
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (process.argv.includes("--cleanup-mutation")) {
    const file = join(dir, "assistant-agent.mjs"), code = readFileSync(file, "utf8");
    assert(code.includes("process.kill(-pid, name)"));
    writeFileSync(file, code.replace("process.kill(-pid, name)", "process.kill(pid, name)"));
  }
  const browserModule = await import(pathToFileURL(join(dir, "assistant-browser.mjs")).href);
  const { AssistantBrowser, AssistantBrowserError, assistantAccessError, assistantElementScript, assistantLoadingScript, assistantMessageMetadataScript, assistantGmailRowTargetsScript, assistantUrl, assistantThreadId, guardAssistantElement, verifyAssistantComposer, validateAssistantEvidence, validateAssistantCoverageDepth } = browserModule;
  const { assistantZohoApiCard, AssistantExecutor, assistantCodexArgs, assistantWorkerFrame, assistantWorkerContext, assistantItemPage } = await import(pathToFileURL(join(dir, "assistant-agent.mjs")).href);
  const account = { id: "work", provider: "gmail", label: "Arbete", email: "user@example.test", url: "https://mail.google.com/mail/u/0/", enabled: true };
  const other = { ...account, id: "other", email: "other@example.test" };
  {
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir), url = account.url + '#inbox';
    browser.warmedTabs.add(41);
    browser.owned = async () => ({ account, url });
    const resolved = [], deadlines = [];
    let metadataReads = 0;
    browser.call = async (name, args, timeout) => {
      if (name === 'read_page') return { count: 500, truncated: true };
      assert.equal(name, 'resolve_target'); assert.equal(args.target.frameId, 0);
      resolved.push(args.target.selector); deadlines.push(timeout);
      return { ref: `ref_${resolved.length}`, documentId: 'fixture-doc' };
    };
    browser.script = async (_tabId, fn) => {
      if (fn === assistantGmailRowTargetsScript) return Array.from({ length: 20 }, (_, i) => `#native-subject-${i}`);
      assert.equal(fn, assistantMessageMetadataScript); metadataReads++;
      // The live list reordered while refs were issued. Only this fresh mapping may be offered.
      return { nativeThread: null, nativeMessage: null, scopeText: '', areas: ['inbox'], view: 'list', truncated: false, rows: [
        { thread: 'fixture-native-thread-b', last: 'fixture-native-message-b', at: new Date().toISOString(), unread: true, text: 'Fixture B', ref: resolved.length ? 'ref_1' : null },
        { thread: 'fixture-native-thread-a', last: 'fixture-native-message-a', at: new Date().toISOString(), unread: true, text: 'Fixture A', ref: null },
      ] };
    };
    const read = await browser.read(41);
    assert.equal(resolved.length, 12, 'a truncated generic snapshot still prepares a bounded set of native row references');
    assert.equal(metadataReads, 2, 'row bindings come from a fresh metadata read after resolution');
    assert(deadlines.every(timeout => timeout > 0 && timeout <= 5000));
    const execution = { context: { run: { task: 'check-mail', startedAt: new Date().toISOString() }, settings: { lookbackDays: 7 }, reviews: [] }, browser };
    const output = executor.withInbox(execution, read);
    assert.deepEqual(output.inbox.open, ['ref_1']);
    const mapped = [...browser.inboxRows.get(account.id).values()].find(row => browser.currentRowRef(row) === 'ref_1');
    assert.equal(mapped.key, 'gmail:fixture-native-thread-b');
    const initialCall = browser.call, initialScript = browser.script;
    browser.owned = async () => ({ account, url: account.url + '#sent' });
    browser.script = async (...args) => {
      const value = await initialScript(...args);
      return args[1] === assistantMessageMetadataScript ? { ...value, areas: ['sent'] } : value;
    };
    for (const count of [143, 500]) {
      resolved.length = 0;
      browser.call = async (name, ...args) => name === 'read_page'
        ? { count, truncated: count === 500, elements: '[ref_90] button "Reply"' } : initialCall(name, ...args);
      const sent = await browser.read(41);
      assert.deepEqual(sent.mailRows, [{ ref: 'ref_1', label: 'Fixture B' }],
        'fresh native Sent refs must reach the worker even when the original general scan omits them');
      assert.equal(sent.text, '', 'navigation labels never become quotable message evidence');
      assert.equal(sent.sourceId, '', 'native list navigation never becomes a reviewed thread');
      assert.equal(sent.inboxRows, undefined, 'Sent rows do not become inbox coverage obligations');
    }
    browser.owned = async () => ({ account, url });
    browser.call = initialCall; browser.script = initialScript;
    let attempts = 0;
    resolved.length = 0;
    browser.call = async (name, args) => {
      if (name === 'read_page') return {};
      assert.equal(name, 'resolve_target'); attempts++;
      if (attempts === 3) throw new AssistantBrowserError('failed', 'browser-tool', 'TOOL_ERROR: resolve_target: no visible match. []', 'TOOL_ERROR');
      resolved.push(args.target.selector); return { ref: `ref_${attempts}` };
    };
    const beforeMissingTarget = metadataReads;
    const changedList = await browser.read(41);
    assert.equal(attempts, 3, 'one disappeared optional target stops resolution without replay');
    assert.equal(metadataReads, beforeMissingTarget + 2, 'a disappeared target still requires fresh native metadata');
    assert.equal(changedList.view, 'list');
    assert.deepEqual(executor.withInbox(execution, changedList).inbox.open, ['ref_1']);
    const originalNow = Date.now;
    let clock = originalNow(), calls = 0;
    try {
      Date.now = () => clock;
      browser.call = async name => { if (name === 'read_page') return {}; assert.equal(name, 'resolve_target'); calls++; clock += 6000; return {}; };
      await browser.read(41);
      assert.equal(calls, 1, 'the elapsed preparation budget stops additional resolutions');
    } finally { Date.now = originalNow; }
    let navigated = false;
    browser.owned = async () => ({ account, url: navigated ? account.url + '#sent' : url });
    browser.call = async name => { if (name === 'read_page') return {}; assert.equal(name, 'resolve_target'); navigated = true; return {}; };
    const beforeNavigation = browser.observations.size;
    await assert.rejects(browser.read(41), /ändrades under läsningen/);
    assert.equal(browser.observations.size, beforeNavigation);
    browser.owned = async () => ({ account, url });
    resolved.length = 0;
    browser.call = async name => { if (name === 'read_page') return {}; throw new Error('resolver unavailable'); };
    const observations = browser.observations.size;
    await assert.rejects(browser.read(41), /resolver unavailable/);
    for (const error of [
      new AssistantBrowserError('failed', 'browser-tool', 'TOOL_ERROR: resolve_target: ambiguous (2 visible matches). []', 'TOOL_ERROR'),
      new AssistantBrowserError('failed', 'browser-tool', 'TIMEOUT: resolve_target timed out', 'TIMEOUT'),
      new AssistantBrowserError('failed', 'browser-tool', 'GROUP_IDENTITY_UNAVAILABLE: ownership unavailable', 'GROUP_IDENTITY_UNAVAILABLE'),
    ]) {
      browser.call = async name => { if (name === 'read_page') return {}; throw error; };
      await assert.rejects(browser.read(41), caught => caught === error);
    }
    assert.equal(browser.observations.size, observations, 'other preparation failures create no observation or read proof');
    const metadataScript = browser.script;
    browser.call = async name => { assert.equal(name, 'read_page'); return {}; };
    for (const rows of [
      [{ thread: 'fixture-native-thread-b', text: 'Fixture B', ref: 'ref_1' }],
      [], [{ text: '' }],
    ]) {
      browser.script = async (...args) => {
        assert.equal(args[1], assistantMessageMetadataScript, 'already referenced, empty and invalid rows need no extra discovery');
        return { ...await metadataScript(...args), rows };
      };
      await browser.read(41);
    }
    browser.owned = async () => ({ account: { ...account, provider: 'outlook' }, url: 'https://outlook.live.com/mail/0/inbox' });
    browser.call = async name => { assert.equal(name, 'read_page'); return {}; };
    browser.script = async (...args) => { assert.notEqual(args[1], assistantGmailRowTargetsScript, 'native Gmail preparation never runs for another provider'); return metadataScript(...args); };
    await browser.read(41);
    await browser.close(); await executor.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir), stamp = new Date().toISOString();
    const row = name => ({ thread: name, last: name + '-v1', at: stamp, unread: true, text: 'Fixture ' + name, ref: name === 'a' ? 'ref_1' : 'ref_2' });
    let rows = [], scoped = true;
    browser.warmedTabs.add(41);
    browser.owned = async () => ({ account, url: account.url + (scoped ? '#search/in%3Ainbox+newer_than%3A7d' : '#inbox') });
    browser.call = async name => { assert.equal(name, 'read_page'); return {}; };
    browser.script = async (_tab, fn) => {
      assert.equal(fn, assistantMessageMetadataScript);
      return { nativeThread: null, nativeMessage: null, scopeText: '', areas: ['inbox'], view: 'list', truncated: false, inboxSearchScoped: scoped, rows };
    };
    const reviews = [{ accountId: account.id, threadId: 'gmail:a', messageId: 'gmail:message:a-v1', reviewedAt: stamp, outcome: 'no-action', rows: [] }];
    const execution = { context: { run: { task: 'check-mail', startedAt: stamp }, settings: { accounts: [account], lookbackDays: 7 }, reviews }, browser };
    browser.readingProofs.set(account.id, [{ area: 'inbox', view: 'detail', historyComplete: true }, { area: 'sent', view: 'detail', historyComplete: true }]);
    const emptyList = executor.withInbox(execution, await browser.read(41));
    assert.equal(emptyList.view, 'list');
    assert.equal(emptyList.inbox?.inventoryRead, false, 'zero-row scoped lists still report the missing canonical inventory');
    const noInbox = { accountId: account.id, areas: ['sent'], view: 'list' };
    assert.equal(executor.withInbox(execution, noInbox), noInbox, 'unrelated reads stay unchanged');
    assert.equal(executor.withInbox({ ...execution, context: { ...execution.context, run: { ...execution.context.run, task: 'my-day' } } }, { ...noInbox, inboxRows: 0 }).inbox, undefined);
    rows = [row('a')];
    const filtered = executor.withInbox(execution, await browser.read(41));
    assert.equal(filtered.inbox.remaining, 0);
    assert.equal(filtered.inbox.inventoryRead, false);
    assert.deepEqual(filtered.inbox.open, []);
    assert.throws(() => executor.verifyCoverage(execution, { accountId: account.id, status: 'checked' }), /Läs inkorgens lista/,
      'a fully assessed filtered subset cannot certify inbox inventory');
    rows = [row('a'), row('b')];
    const positive = executor.withInbox(execution, await browser.read(41));
    assert.deepEqual(positive.inbox.open, ['ref_2'], 'scoped searches still expose actual unhandled row references');
    scoped = false; rows = [row('a')];
    const canonical = executor.withInbox(execution, await browser.read(41));
    assert.equal(canonical.inbox.inventoryRead, true);
    assert.equal(canonical.inbox.remaining, 1, 'canonical rereading never drops a previously observed unhandled row');
    assert.throws(() => executor.verifyCoverage(execution, { accountId: account.id, status: 'checked' }), /saknar ett utfall/);
    await browser.close(); await executor.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir), stamp = new Date().toISOString(), saved = [];
    let version = 'v1', sequence = 0, fail = false;
    const sourceId = 'gmail:fixture-attachment-thread', url = account.url + '#inbox/fixture-attachment-thread';
    const context = { run: { id: 'attachment-check', task: 'check-mail', checkpoints: [], startedAt: stamp, scanStartedAt: stamp }, settings: { accounts: [account], lookbackDays: 7 }, items: [] };
    const execution = { context, browser, callbacks: { async checkpoint(entry, result, review) { if (fail) throw new Error('disk failure'); saved.push({ entry, result, review }); } } };
    browser.read = async () => {
      const observationId = `attachment-${sequence++}`;
      browser.observations.set(observationId, { accountId: account.id, email: account.email, sourceId, messageId: `gmail:message:${version}`, url, tabId: 41, view: 'detail', areas: ['inbox'], historyComplete: false, truncated: false, attachmentReviewAvailable: true, text: 'Bilagans innehåll är inte läst. Manuell granskning krävs.' });
      return { observationId };
    };
    browser.inboxRows.set(account.id, new Map([[sourceId, { key: sourceId, version: 'gmail:message:v1', native: true, at: stamp, seenAt: Date.now(), firstUnread: false }]]));
    browser.inboxListed.set(account.id, 'rows');
    const read = await browser.read(41);
    const result = await executor.dispatch(execution, 'workflow_review_attachment', read);
    assert.equal(result.checkpoint.outcome, 'attachment-review'); assert.equal(result.inbox.remaining, 0);
    assert.equal(saved[0].result.findings[0].unreadAttachment, true); assert.equal(saved[0].result.findings[0].kind, 'action');
    assert.equal(saved[0].result.findings[0].draft, undefined); assert.match(saved[0].result.findings[0].summary, /inte läst/);
    assert.throws(() => validateAssistantEvidence(saved[0].result, [account], browser.observations), /workflow_review_attachment/, 'ordinary findings cannot forge the host-owned unread marker');
    assert.equal([...browser.observations.values()].at(-1).historyComplete, false, 'manual review never creates complete-read evidence');
    await executor.dispatch(execution, 'workflow_review_attachment', read);
    assert.equal(saved.length, 1, 'repeating the same native message creates no second action/checkpoint');
    assert.throws(() => executor.verifyCoverage({ ...execution, context: { ...context, run: { task: 'my-day' } } }, { accountId: account.id, status: 'checked' }), /Skickat|kalender|Inkorg/i);
    const notice = executor.inboxCoverage(execution, { accountId: account.id, status: 'checked', message: 'x'.repeat(2000) });
    assert.match(notice.message, /^1 trådar har olästa bilagor/);
    assert.equal(executor.unreadAttachments({ context: { items: [{ ...saved[0].result.findings[0], status: 'open' }], run: { checkpoints: [] } } }, account.id), 1, 'the unread action remains visible on a later run');
    version = 'v2';
    await assert.rejects(executor.dispatch(execution, 'workflow_review_attachment', read), /ändrades/);
    const changed = await browser.read(41);
    await assert.rejects(executor.dispatch({ ...execution, context: { ...context, approval: {} } }, 'workflow_review_attachment', changed), /utskick/);
    await assert.rejects(executor.dispatch(execution, 'workflow_checkpoint', { checkpoint: { accountId: account.id, threadId: sourceId, messageId: 'gmail:message:v2', sourceUrl: url, outcome: 'no-action' }, findings: [] }), /hela.*tråden/i);
    await executor.dispatch(execution, 'workflow_review_attachment', changed);
    assert.equal(saved.length, 2, 'a new native message version needs a new manual-review outcome');
    version = 'v3'; const third = await browser.read(41); fail = true;
    await assert.rejects(executor.dispatch(execution, 'workflow_review_attachment', third), /disk failure/);
    assert.equal(context.run.checkpoints[0].messageId, 'gmail:message:v2', 'failed persistence never consumes the new version');
    await browser.close(); await executor.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), originalNow = Date.now; let time = originalNow(), candidate = true, message = 'fixture-native-message';
    browser.tabs.set(41, account); browser.warmedTabs.add(41); browser.owned = async () => ({ account, url: account.url + '#inbox/fixture-thread' });
    browser.call = async () => ({ text: 'Native attachment fixture' });
    browser.script = async () => ({ nativeThread: 'fixture-thread', nativeMessage: message, scopeText: 'Native fixture header and attachment metadata.', areas: ['inbox'], view: 'detail', truncated: false, historyComplete: false, attachmentReviewCandidate: candidate, messages: [] });
    Date.now = () => time;
    try {
      assert.equal((await browser.read(41)).attachmentReviewAvailable, false);
      time += 600; const stable = await browser.read(41);
      assert.equal(stable.attachmentReviewAvailable, true); assert.equal(stable.historyComplete, false);
      message = 'new-native-message'; assert.equal((await browser.read(41)).attachmentReviewAvailable, false);
      time += 600; candidate = false; assert.equal((await browser.read(41)).attachmentReviewAvailable, false, 'a loading/body change revokes the manual-review candidate');
    } finally { Date.now = originalNow; await browser.close(); }
  }
  {
    const browser = new AssistantBrowser(dir, dir);
    browser.tabs.set(41, account); browser.warmedTabs.add(41);
    let detail = false, clicked = 0;
    const url = () => account.url + (detail ? '#inbox/abcdef1234567890' : '#inbox');
    browser.owned = async () => ({ account, url: url() });
    browser.call = async (name, args) => {
      if (name === 'read_page') return { text: 'Native fixture' };
      if (name === 'resolve_target') { assert.equal(args.target.selector, '[data-ccmcp-ref="ref_50"]'); return { ref: 'ref_50', documentId: 'fixture-document' }; }
      assert.equal(name, 'computer'); assert.equal(args.ref, 'ref_50'); assert.equal(args.documentId, 'fixture-document'); clicked++; detail = true; return { ok: true };
    };
    browser.script = async (_tab, fn) => fn.name === 'elementScript'
      ? { visible: true, label: 'Native subject', text: 'Native subject', type: 'TD', role: 'gridcell', href: null, row: true, body: false }
      : { nativeThread: detail ? 'fixture-thread' : null, nativeMessage: detail ? 'fixture-message' : null, scopeText: detail ? 'The complete native fixture message body.' : '',
        areas: ['inbox'], view: detail ? 'detail' : 'list', truncated: false, historyComplete: detail,
        rows: detail ? [] : [{ ref: 'ref_50', text: 'Native subject', at: new Date().toISOString(), unread: false }] };
    await browser.read(41);
    const row = [...browser.inboxRows.get(account.id).values()][0];
    assert.equal(browser.currentRowRef(row), 'ref_50');
    await browser.action('browser_click', { tabId: 41, ref: 'ref_50' });
    await browser.read(41);
    assert.equal(clicked, 1);
    assert.equal(browser.rowThreads.get(`${account.id}\0${row.key}`), 'gmail:fixture-thread', 'the subject-cell ref binds the original inbox row to its observed thread');
    await browser.close();
  }
  {
    // A split view: thread A is open beside the list. A click on row B that leaves A in the
    // detail must not bind row B to A, or a review of A would also close row B unread.
    const browser = new AssistantBrowser(dir, dir);
    browser.tabs.set(41, account); browser.warmedTabs.add(41);
    let shown = 'thread-a', opens = null;
    const rows = [{ ref: 'ref_50', text: 'Bertil Ny fråga om fakturan', at: new Date().toISOString(), unread: true },
      { ref: 'ref_51', thread: 'thread-a', text: 'Anna Mötet i morgon', at: new Date().toISOString(), unread: false }];
    browser.owned = async () => ({ account, url: `${account.url}#inbox/${shown}` });
    browser.call = async (name, args) => {
      if (name === 'read_page') return { text: 'Native fixture' };
      if (name === 'resolve_target') return { ref: args.target.selector.match(/ref_\d+/)[0], documentId: 'fixture-document' };
      assert.equal(name, 'computer'); if (opens) shown = opens; return { ok: true };
    };
    browser.script = async (_tab, fn) => fn.name === 'elementScript'
      ? { visible: true, label: 'Native subject', text: 'Native subject', type: 'TD', role: 'gridcell', href: null, row: true, body: false }
      : { nativeThread: shown, nativeMessage: `${shown}-message`, scopeText: `The complete native message body of ${shown}.`, areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, rows };
    await browser.read(41);
    const [rowB, rowA] = [...browser.inboxRows.get(account.id).values()];
    await browser.action('browser_click', { tabId: 41, ref: 'ref_50' });
    await browser.read(41);
    assert.equal(browser.rowThreads.get(`${account.id}\0${rowB.key}`), undefined, 'a detail the click did not change binds nothing to the clicked row');
    opens = 'thread-b';
    await browser.action('browser_click', { tabId: 41, ref: 'ref_50' });
    await browser.read(41);
    assert.equal(browser.rowThreads.get(`${account.id}\0${rowB.key}`), 'gmail:thread-b', 'a detail that changed after the click binds the row');
    opens = null;
    await browser.action('browser_click', { tabId: 41, ref: 'ref_51' });
    await browser.read(41);
    assert.equal(browser.rowThreads.get(`${account.id}\0${rowA.key}`), undefined, 'row A names its own thread, which the detail does not show now');
    shown = 'thread-a'; await browser.read(41);
    await browser.action('browser_click', { tabId: 41, ref: 'ref_51' });
    await browser.read(41);
    assert.equal(browser.rowThreads.get(`${account.id}\0${rowA.key}`), 'gmail:thread-a', "an unchanged detail that is the row's own thread binds it");
    await browser.close();
  }
  {
    // A Gmail row that names its own thread binds only to that thread. When the detail changes to a
    // third thread after a click on row B, a review of that thread must not close row B unread.
    const browser = new AssistantBrowser(dir, dir);
    browser.tabs.set(41, account); browser.warmedTabs.add(41);
    let shown = 'thread-a', opens = null;
    const rows = [{ ref: 'ref_50', thread: 'thread-b', text: 'Bertil Ny fråga om fakturan', at: new Date().toISOString(), unread: true }];
    browser.owned = async () => ({ account, url: `${account.url}#inbox/${shown}` });
    browser.call = async (name, args) => {
      if (name === 'read_page') return { text: 'Native fixture' };
      if (name === 'resolve_target') return { ref: args.target.selector.match(/ref_\d+/)[0], documentId: 'fixture-document' };
      assert.equal(name, 'computer'); if (opens) shown = opens; return { ok: true };
    };
    browser.script = async (_tab, fn) => fn.name === 'elementScript'
      ? { visible: true, label: 'Native subject', text: 'Native subject', type: 'TD', role: 'gridcell', href: null, row: true, body: false }
      : { nativeThread: shown, nativeMessage: `${shown}-message`, scopeText: `The complete native message body of ${shown}.`, areas: ['inbox'], view: 'detail', truncated: false, historyComplete: true, rows };
    await browser.read(41);
    const [rowB] = [...browser.inboxRows.get(account.id).values()];
    assert.equal(rowB.key, 'gmail:thread-b');
    opens = 'thread-c';
    await browser.action('browser_click', { tabId: 41, ref: 'ref_50' });
    await browser.read(41);
    assert.equal(browser.rowThreads.get(`${account.id}\0${rowB.key}`), undefined, 'a detail that changed to a third thread binds nothing to the row');
    opens = 'thread-b';
    await browser.action('browser_click', { tabId: 41, ref: 'ref_50' });
    await browser.read(41);
    assert.equal(browser.rowThreads.get(`${account.id}\0${rowB.key}`), 'gmail:thread-b', "the row's own thread binds it");
    await browser.close();
  }
  {
    const { AssistantMailMethodLearning } = await import(pathToFileURL(join(dir, 'assistant-mail-method-execution.mjs')).href);
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir), calls = [];
    const method = { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date().toISOString(), definition: { steps: ['verify-account', 'read-sent', 'read-incoming', 'return-inbox'], expandThreads: true } };
    const selection = { accountId: account.id, fingerprint: 'a'.repeat(64), revision: 1, method, active: method };
    const context = { run: { id: 'method-check', task: 'check-mail', learnMail: true, checkpoints: [] }, settings: { accounts: [account], lookbackDays: 7 }, items: [], answers: [], lastChecks: {}, mailMethods: [selection] };
    const execution = { context, browser, callbacks: { async finish(result, methods) { execution.saved = { result, methods }; } }, mailLearning: new AssistantMailMethodLearning([account], [selection]) };
    browser.context = async () => [{ tabId: 1, accountId: account.id }];
    let sequence = 0;
    const snapshot = area => ({ accountId: account.id, tabId: 1, view: 'empty', areas: [area], text: '', ref: `ref_${++sequence}` });
    browser.open = async () => { calls.push('verify'); return snapshot('inbox'); };
    browser.mailboxFolder = async (_account, area) => { calls.push(area); return snapshot(area); };
    browser.methodFolders = async () => [];
    const prepared = await executor.dispatch(execution, 'browser_run_mail_method', { accountId: account.id });
    assert.equal(prepared.mailMethod.prepared, true); assert.equal(prepared.ref, 'ref_4');
    assert.deepEqual(calls, ['verify', 'sent', 'inbox', 'inbox']);
    browser.readingProofs.set(account.id, [{ area: 'inbox', view: 'empty' }, { area: 'sent', view: 'empty' }]);
    browser.inboxListed.set(account.id, 'parsed'); browser.inboxRows.set(account.id, new Map());
    browser.observations.set('empty-mailbox', { accountId: account.id, view: 'empty', text: '', areas: ['inbox'] });
    const actions = [];
    browser.action = async tool => { actions.push(tool); return { accountId: account.id, tabId: 1, view: 'detail', historyComplete: tool === 'browser_expand_thread', truncated: tool !== 'browser_expand_thread' }; };
    const expanded = await executor.dispatch(execution, 'browser_read', { tabId: 1 });
    assert.equal(expanded.historyComplete, true); assert.deepEqual(actions, ['browser_read', 'browser_expand_thread']);
    await executor.dispatch(execution, 'workflow_finish', { result: { summary: 'Kontrollerat.', coverage: [{ accountId: account.id, status: 'checked', message: 'Kontrollerat.' }], findings: [] } });
    assert.equal(execution.saved.methods[0].validated, true);
    assert.equal(execution.saved.methods[0].usedId, method.id);
    assert.equal(execution.saved.methods[0].measurement.preparationCalls, 1);
    assert.equal(execution.terminal, true);
    const raw = { ...execution, terminal: false, webGeneration: 0,
      context: { ...context, run: { ...context.run, id: 'raw-learning' }, settings: { ...context.settings, web: { fullAccess: true } } },
      callbacks: { async externalEffect() { throw new Error('effect persist failed'); } },
      mailLearning: new AssistantMailMethodLearning([account], [selection]) };
    let rawCalls = 0;
    executor.fullBrowser = { conversationId: 'run:raw-learning', session: { tools: async () => ({ tools: [] }), call: async () => { rawCalls++; return { content: [] }; }, close: async () => {}, drainActivity: () => [] } };
    await assert.rejects(executor.dispatch(raw, 'mcp_browser_call', { name: 'future_tool', arguments: {} }), /effect persist failed/);
    assert.equal(rawCalls, 0);
    await raw.mailLearning.run(browser, account);
    raw.callbacks.externalEffect = async () => {};
    await executor.dispatch(raw, 'mcp_browser_call', { name: 'future_tool', arguments: {} });
    assert.equal(rawCalls, 1);
    await assert.rejects(executor.dispatch(raw, 'browser_run_mail_method', { accountId: account.id }), /externt steg/);
    await executor.close();
  }

  {
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir);
    browser.tabs.set(41, account);
    let url = 'https://mail.google.com/mail/u/0/#inbox/abcdef1234567890', ready = true, shown;
    browser.call = async name => { assert.equal(name, 'tabs_context_mcp'); return { tabs: [{ tabId: 41, url }] }; };
    browser.show = async selected => { shown = selected.id; };
    browser.read = async tabId => { assert.equal(tabId, 41); return { view: ready ? 'detail' : 'unsupported', historyComplete: ready }; };
    const help = await browser.helpTarget({ accountId: account.id, code: 'expand-thread', message: 'Öppna äldre meddelanden.' });
    assert.equal(help.tabId, 41); assert.equal(help.sourceUrl, url);
    executor.parked.set('scan:work', { browser, runId: 'scan', accountId: account.id });
    await executor.showHelp(help, account, 11); assert.equal(shown, account.id);
    await executor.preflightHelp(help);
    ready = false; await assert.rejects(executor.preflightHelp(help), /fortfarande inte läsas/);
    ready = true;
    await assert.rejects(executor.preflightHelp({ ...help, tabId: 99 }), /Öppna den blockerade arbetsfliken/);
    url = 'https://mail.google.com/mail/u/0/#sent';
    await assert.rejects(executor.preflightHelp(help), /annan källa/);
    await assert.rejects(browser.showHelp(help), /annan källa/);
    const legacy = { ...help }; delete legacy.tabId;
    let opened;
    browser.open = async (selected, source) => { assert.equal(selected.id, account.id); opened = source; url = source; };
    const restored = await browser.showHelp(legacy);
    assert.equal(opened, help.sourceUrl); assert.equal(restored.sourceUrl, help.sourceUrl); assert.equal(restored.tabId, 41, 'legacy help navigates its saved source before acquiring an exact tab identity');
    url = 'https://accounts.google.com/login';
    const login = await browser.helpTarget({ ...help, code: 'login' });
    assert.equal(login.tabId, 41, 'login help can show the owned login page without treating it as verified mail');
    executor.parked.clear(); await browser.close(); await executor.close();
  }
  {
    const executor = new AssistantExecutor(dir, dir), first = new AssistantBrowser(dir, dir), second = new AssistantBrowser(dir, dir);
    first.tabs.set(51, account); second.tabs.set(52, other);
    executor.parked.set('A:work', { browser: first, runId: 'A', scanId: 'A', accountId: account.id });
    executor.parked.set('A:other', { browser: second, runId: 'A', scanId: 'A', accountId: other.id });
    const context = (id, resumedFrom, selected) => ({ run: { id, resumedFrom, scanId: 'A', accountId: selected.id } });
    assert.equal(await executor.takeBrowser(context('B', 'A', account), [account]), first);
    assert.equal(executor.parked.size, 1);
    assert.equal(await executor.takeBrowser(context('C', 'B', other), [other]), second, 'the second help generation keeps the exact original parked browser');
    executor.viewer = first;
    executor.preparedHelp = { browser: first, runId: 'C', help: { accountId: account.id, tabId: 51, code: 'browser', message: 'Kontrollera.' } };
    assert.equal(await executor.takeBrowser(context('D', 'C', account), [account]), first, 'a preflighted replacement viewer is handed to the worker rather than replaced with a new default tab');
    assert.equal(executor.viewer, undefined);
    await first.close(); await second.close(); await executor.close();
  }
  {
    const { AssistantCliProgress, assistantPartialReply, assistantIntentPartialReply } = await import(pathToFileURL(join(dir, 'assistant-provider-progress.mjs')).href);
    assert.equal(assistantPartialReply('{"text":"Hej\\nVär'), 'Hej\nVär');
    assert.equal(assistantPartialReply('{"text":"hej\\uD83D'), 'hej');
    assert.equal(assistantPartialReply('{"reasoning":"PRIVATE"}'), undefined);
    assert.equal(assistantPartialReply(undefined), undefined);
    assert.equal(assistantPartialReply('{"text":"' + 'x'.repeat(16001)), undefined);
    assert.equal(assistantIntentPartialReply('{"action":"respond","tool":"__none__","arguments":{},"text":"Synlig del'), 'Synlig del');
    assert.equal(assistantIntentPartialReply('{"action":"call","tool":"chat_reply","arguments":{"text":"Synlig del'), 'Synlig del');
    assert.equal(assistantIntentPartialReply('{"action":"call","tool":"chat_propose","arguments":{"text":"Privat'), undefined);
    const parser = new AssistantCliProgress();
    const stream = event => parser.consume('claude', { type: 'stream_event', event });
    assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_REASONING' } }), {});
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'mcp__tabai_assistant__chat_reply' } });
    assert.equal(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"Hej' } }).partial, 'Hej');
    assert.equal(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' världen"}' } }).partial, 'Hej världen');
    stream({ type: 'content_block_stop', index: 0 });
    assert.deepEqual(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'late' } }), {});
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__tabai_assistant__chat_propose' } });
    assert.equal(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"PRIVATE_INTENT"}' } }).partial, undefined);
    assert.deepEqual(parser.consume('codex', { type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_REASONING' } }), {});
    assert(parser.consume('codex', { type: 'turn.started' }).status);
    assert.deepEqual(parser.consume('codex', { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }).usage, { inputTokens: 12, outputTokens: 3 });
    assert.deepEqual(parser.consume('codex', { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }), {});
    assert.equal(parser.consume('codex', { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'other', tool: 'chat_reply', arguments: { text: 'PRIVATE' } } }).partial, undefined);
    const request = { type: 'assistant', message: { id: 'request-one', usage: { input_tokens: 20, output_tokens: 5 } } };
    assert.deepEqual(parser.consume('claude', request).usage, { inputTokens: 20, outputTokens: 5 });
    assert.deepEqual(parser.consume('claude', request), {}, 'repeated full events do not duplicate usage');
    const executor = new AssistantExecutor(dir, dir), calls = [];
    const callbacks = Object.fromEntries(['chatConfig', 'chatPropose', 'chatModules', 'chatModuleStatus', 'chatModuleReply'].map(name => [name, async value => { calls.push([name, value]); return { acknowledged: true }; }]));
    const chat = { messages: [], memories: [{ id: 'memory', label: 'Saved', value: 'Explicit fact', scope: 'general', updatedAt: new Date().toISOString() }], selection: { label: 'Selected case', text: 'Bounded source' }, taskModel: 'codex:gpt-6.1-sol' };
    const execution = { context: { chat, settings: { accounts: [], timezone: 'UTC' } }, callbacks };
    await assert.rejects(executor.dispatch(execution, 'chat_config', {}), /workflow_context/);
    const context = await executor.dispatch(execution, 'workflow_context', {});
    assert.deepEqual(context.settings.accounts, []); assert.deepEqual(context.memories, chat.memories); assert.deepEqual(context.selection, chat.selection); assert.equal(context.taskModel, chat.taskModel);
    for (const [tool, args] of [['chat_config', {}], ['chat_propose', { intent: { kind: 'memory', label: 'Exact', value: 'Explicit', scope: 'general' } }], ['chat_modules', {}], ['chat_module_status', { moduleId: 'fixture' }], ['chat_module_reply', { moduleId: 'fixture', runId: 'fixture-run', questionId: 'question' }]]) assert.deepEqual(await executor.dispatch(execution, tool, args), { acknowledged: true });
    assert.equal(calls.length, 5);
    const effects = []; execution.callbacks.chatEffect = async () => { effects.push('persisted'); };
    execution.callbacks.chatSavedList = async kind => ({ displayed: true, kind });
    assert.deepEqual(await executor.dispatch(execution, 'chat_saved_list', { kind: 'watches' }), { displayed: true, kind: 'watches' });
    execution.context.chat.continuation = true;
    for (const tool of ['chat_start_task', 'chat_module_reply', 'chat_propose', 'web_click', 'web_fill', 'mcp_browser_call']) await assert.rejects(executor.dispatch(execution, tool, {}), /bara läsa/);
    assert.equal(effects.length, 0, 'continuation blocks dispatch before any external effect');

    await assert.rejects(executor.dispatch(execution, 'browser_open', { accountId: account.id }), /inte tillgängligt/);
    await executor.close();
  }
  const url = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXabcdefghijkl";
  const threadId = assistantThreadId("gmail", url);
  assert.equal(threadId, "gmail:FMfcgzQXabcdefghijkl");
  assert.equal(assistantThreadId("gmail", account.url + "#inbox"), undefined);
  assert.equal(assistantThreadId("gmail", account.url + "#search/longquerythatisnotathread"), undefined);
  assert.equal(assistantThreadId("outlook", "https://outlook.live.com/mail/0/id/AAAAABBBBBCCCCDDD"), "outlook:AAAAABBBBBCCCCDDD");
  assert.equal(assistantThreadId("zoho", "https://mail.zoho.eu/zm/#mail/folder/inbox/p/1/m/123456789"), "zoho:123456789");
  assert.equal(assistantThreadId("zoho", "https://mail.zoho.eu/zm/#mail/folder/sent/p/123456789"), "zoho:123456789");
  assert.equal(assistantThreadId("zoho", "https://mail.zoho.eu/zm/#mail/folder/sent/p/1"), undefined, "list pagination is not a native message identity");
  assert.equal(assistantUrl(account, url), url);
  assert.equal(assistantUrl({ ...account, provider: "zoho" }, "https://mail.zoho.com.cn/zm/"), "https://mail.zoho.com.cn/zm/");
  assert.equal(assistantAccessError(account, "https://accounts.google.com/v3/signin").status, "login");
  assert.equal(assistantAccessError(account, "https://example.test/unsupported").status, "unsupported");
  assert.equal(assistantAccessError({ ...account, provider: "zoho" }, "https://accounts.zoho.com.cn/signin").status, "login");
  for (const bad of ["https://evil.example/mail/", "https://mail.google.com.evil.example/mail/", "https://user:pass@mail.google.com/mail/", "https://mail.google.com/mail/?view=cm&to=someone@example.test", "https://mail.google.com/mail/#compose", "javascript:alert(1)"]) assert.throws(() => assistantUrl(account, bad));
  const base = { visible: true, label: "", text: "", type: "button", role: "button", href: null, row: false, body: false, search: false };
  {
    const browser = new AssistantBrowser(dir, dir), calls = [];
    browser.tabs.set(1, account);
    browser.owned = async () => { throw new AssistantBrowserError('login', 'login-required', 'Manual login needed'); };
    browser.call = async (name, args) => { calls.push({ name, args }); return {}; };
    await browser.showWork();
    assert.deepEqual(calls, [{ name: 'tab_switch', args: { tabId: 1, bringToFront: true } }], 'showing an owned login tab does not read or bypass login');
    browser.tabs.clear();
    await assert.rejects(browser.showWork(), /Ingen arbetsflik/);
    await browser.close();
  }
  for (const focused of [true, false]) {
    const browser = new AssistantBrowser(dir, dir), calls = [];
    browser.owned = async () => ({ account, url });
    browser.sameOwnedPage = async () => {};
    browser.script = async (_tab, _fn, args) => args.length === 2 ? { ...base, label: 'Sök i e-post', search: true } : focused;
    browser.call = async (name, args) => {
      calls.push({ name, args });
      if (name === 'resolve_target') return { ref: 'ref_1', documentId: 'current-document' };
      if (name === 'computer' && args.action === 'key' && args.documentId !== undefined) throw new Error('document-bound computer actions require a pointer ref action without coordinates');
      return {};
    };
    const action = browser.action('browser_search', { tabId: 1, ref: 'ref_1', query: 'in:sent newer_than:7d' });
    if (focused) {
      await action;
      assert.equal(browser.lastTabId, 1, 'the latest action selects the work tab even before another read');
      assert.deepEqual(calls.find(call => call.args.action === 'key').args, { tabId: 1, action: 'key', text: 'Enter' });
      assert.equal(calls.find(call => call.name === 'form_input').args.documentId, 'current-document');
    } else {
      await assert.rejects(action, /tappade fokus/);
      assert.equal(calls.filter(call => call.args.action === 'key').length, 0);
    }
    await browser.close();
  }
  {
    // A control that changes mail is refused for its label, with that refusal's own message: as a
    // button, as a link inside the account (links are otherwise readable) and as a reading control
    // (otherwise allowed) in Gmail and in Zoho, where only a native disclosure with its container passes.
    const zohoAccount = { ...account, provider: "zoho", url: "https://mail.zoho.eu/zm/" }, zohoUrl = "https://mail.zoho.eu/zm/#mail/folder/inbox";
    const verdict = (element, target = account, address = url) => { try { guardAssistantElement("click", element, target, address); return "allowed"; } catch (error) { return error.message; } };
    const changing = [
      ...["Send", "Skicka", "Archive", "Radera", "Forward", "Move to", "Compose", "New message", "Accept"].map(label => [`button "${label}"`, { ...base, label }]),
      ...["Delete", "Arkivera", "Move to"].map(label => [`link "${label}"`, { ...base, type: "A", role: "link", label, href: url }]),
      ...["Archive", "Radera"].map(label => [`Gmail reading control "${label}"`, { ...base, label, readingControl: true }]),
      ...["Archive", "Radera"].map(label => [`Zoho reading control "${label}"`, { ...base, label, readingControl: true }, zohoAccount, zohoUrl]),
    ];
    assert.deepEqual(changing.map(([name, ...args]) => [name, verdict(...args)]), changing.map(([name]) => [name, "Kontrollen ändrar e-post eller kalender och är spärrad."]));
    assert.match(verdict({ ...base, label: "Svara" }), /^Svar får endast öppnas efter ditt uttryckliga godkännande/, "Reply opens only with an approval");
    assert.match(verdict({ ...base, label: "Logga in" }), /^Inloggning hanteras av dig/, "a login control is the user's");
  }
  assert.doesNotThrow(() => guardAssistantElement("click", { ...base, label: "Sent" }, account, url));
  assert.doesNotThrow(() => guardAssistantElement("click", { ...base, label: "Please delete old report", row: true, role: "row" }, account, url));
  for (const label of ['Återställ lösenord', 'Sign-in notification', 'Logga in']) {
    const subject = { ...base, label, type: 'TD', role: 'gridcell', row: true, nativeGmailSubject: true };
    assert.doesNotThrow(() => guardAssistantElement('click', subject, account, url), 'native Gmail subjects are mail content, not login controls');
    for (const blocked of [{ ...subject, nativeGmailSubject: false }, { ...subject, row: false }, { ...subject, bodyContent: true }, { ...subject, visible: false }]) {
      assert.throws(() => guardAssistantElement('click', blocked, account, url));
    }
    for (const role of ['row', 'option', 'listitem']) assert.throws(() => guardAssistantElement('click', { ...base, label, row: true, role }, account, url));
    for (const operation of ['search', 'fill']) assert.throws(() => guardAssistantElement(operation, subject, account, url));
    assert.throws(() => guardAssistantElement('click', { ...subject, href: 'https://evil.example' }, account, url));
    assert.throws(() => guardAssistantElement('click', subject, { ...account, provider: 'outlook' }, 'https://outlook.live.com/mail/0/'));
  }
  assert.throws(() => guardAssistantElement("click", { ...base, label: "Click here", href: "https://evil.example" }, account, url));
  assert.throws(() => guardAssistantElement("search", { ...base, label: "Message body", body: true }, account, url));
  assert.doesNotThrow(() => guardAssistantElement("search", { ...base, label: "Sök", type: "search", search: true }, account, url));
  assert.throws(() => guardAssistantElement("fill", { ...base, body: true }, account, url));
  {
    const globals = ["document", "getComputedStyle", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    let inMessage = false, inButton = false;
    const element = { tagName: "DIV", innerText: "Native message subject", textContent: "Native message subject", isContentEditable: false,
      getBoundingClientRect: () => ({ width: 400, height: 40 }),
      getAttribute(name) { return ({ role: "option", "aria-label": "Native message subject", "data-ty": "mail", "aria-controls": "mail-detail" })[name] ?? null; },
      matches(selector) { return selector === 'div.zmList[role="option"][data-ty][aria-controls]'; },
      closest(selector) {
        if (selector === "a" || selector === '[role="grid"],[role="listbox"]') return null;
        if (selector.startsWith('.zmMailContent')) return inMessage || selector.includes(',button,') && inButton ? {} : null;
        if (selector.startsWith('.a3s')) return inMessage ? {} : null;
        if (selector === 'button,a,[role="button"],[role="menuitem"]') return inButton ? {} : null;
        throw new Error(`Unexpected native-row fixture selector ${selector}`);
      } };
    globalThis.document = { querySelector: () => element, querySelectorAll: selector => selector === 'div.zmList[role="option"][data-ty][aria-controls]' ? [element] : [] };
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    globalThis.location = { href: "https://mail.zoho.eu/zm/#mail/folder/inbox", pathname: "/zm/", hash: "#mail/folder/inbox" };
    try {
      const native = assistantElementScript("ref_1", "zoho"), zoho = { ...account, provider: "zoho" };
      assert.equal(native.row, true, "native Zoho rows do not require an ARIA listbox ancestor");
      assert.equal(assistantMessageMetadataScript("zoho", "").view, "list", "native Zoho rows classify the list even without an ARIA listbox/grid");
      assert.doesNotThrow(() => guardAssistantElement("click", native, zoho, "https://mail.zoho.eu/zm/"));
      assert.equal(assistantElementScript("ref_1", "gmail").row, false, "Zoho native recognition is provider-scoped");
      inMessage = true;
      const decoy = assistantElementScript("ref_1", "zoho");
      assert.equal(decoy.row, false); assert.equal(decoy.messageContent, true);
      assert.equal(assistantMessageMetadataScript("zoho", "").view, "unsupported", "a native-looking row inside message content cannot certify the mailbox list");
      assert.throws(() => guardAssistantElement("click", { ...decoy, label: "Inbox" }, zoho, "https://mail.zoho.eu/zm/"), /meddelandetexten/);
      inMessage = false; inButton = true;
      assert.equal(assistantElementScript("ref_1", "zoho").row, false);
    } finally { for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
  {
    // A row's date. A title the sender controls can come before the date cell; it must never
    // move the row out of the look-back window. The provider's time element wins; otherwise the
    // latest readable date does, a date without a time is the end of that day, and a date beyond
    // tomorrow is no row date.
    const globals = ["document", "getComputedStyle", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    const months = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
    const swedish = (date, clock = true) => `${date.getDate()} ${months[date.getMonth()]}. ${date.getFullYear()}${clock ? ` ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : ""}`;
    const minute = date => { const copy = new Date(date); copy.setSeconds(0, 0); return copy.toISOString(); };
    const cell = attributes => ({ getAttribute: name => attributes[name] ?? null,
      matches: selector => selector.split(",").some(part => part === "time[datetime]" ? attributes.time === true && "datetime" in attributes : part === "[title]" && "title" in attributes) });
    const nativeRow = children => ({ tagName: "DIV", innerText: "Kund Offert på tjänsten", textContent: "Kund Offert på tjänsten",
      getBoundingClientRect: () => ({ width: 400, height: 40 }),
      getAttribute(name) { return ({ role: "option", "aria-label": "Kund Offert på tjänsten", "data-ty": "mail", "aria-controls": "mail-detail" })[name] ?? null; },
      matches: selector => selector === 'div.zmList[role="option"][data-ty][aria-controls]', closest: () => null, querySelector: () => null,
      querySelectorAll: selector => children.filter(child => child.matches(selector)) });
    let shown;
    globalThis.document = { querySelector: () => null, querySelectorAll: selector => selector === 'div.zmList[role="option"][data-ty][aria-controls]' ? [shown] : [] };
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    globalThis.location = { href: "https://mail.zoho.eu/zm/#mail/folder/inbox", pathname: "/zm/", hash: "#mail/folder/inbox" };
    const dated = children => { shown = nativeRow(children); return assistantMessageMetadataScript("zoho", "").rows[0].at; };
    try {
      const now = Date.now(), received = new Date(now - 2 * 86_400_000), earlier = new Date(now - 3 * 86_400_000), later = new Date(now - 86_400_000);
      // A subject title that reads as an old date comes first; the provider's date cell follows.
      const at = dated([cell({ title: "Offert 3 jan. 2020" }), cell({ title: swedish(received) })]);
      const seen = { ...browserModule.assistantInboxRow("zoho", { text: "Kund Offert på tjänsten", at }, now), tabId: 1, order: 0 };
      const gap = browserModule.assistantInboxGap([seen], [], { now, lookbackDays: 7, scanStartedAt: new Date(now).toISOString() });
      assert.equal(gap.due.length, 1, `the row stays inside the look-back window (dated ${at})`);
      assert.equal(at, minute(received), "the row is dated by its newest readable date");
      assert.equal(dated([cell({ title: swedish(later) }), cell({ time: true, datetime: earlier.toISOString() })]), earlier.toISOString(), "the provider's time element wins over any title");
      const dayOnly = new Date(dated([cell({ title: swedish(received, false) })]));
      assert.deepEqual([dayOnly.getDate(), dayOnly.getHours(), dayOnly.getMinutes()], [received.getDate(), 23, 59], "a date without a time is read as the end of that day");
      assert.equal(dated([cell({ title: swedish(received) }), cell({ title: "Kampanj 1 jan. 2099" })]), minute(received), "a date beyond tomorrow cannot replace the row's date");
      assert.equal(dated([cell({ title: "Offert utan datum" })]), undefined, "no readable date stays undated");
    } finally { for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }

  const observation = { accountId: account.id, email: account.email, url, sourceId: threadId, messageId: "gmail:message:native-one", text: "Från sender@example.test. Hej user@example.test. Kan du granska avtalet före fredag?" };
  const finding = { accountId: account.id, threadId, messageId: observation.messageId, kind: "reply", title: "Granska avtalet", summary: "Avtal väntar på granskning.", reason: "Avsändaren ber om svar.", priority: 2, sourceUrl: url, recipient: "sender@example.test", draft: "Jag återkommer på fredag.", sources: [{ observationId: "one", quote: "Kan du granska avtalet före fredag?" }] };
  const result = { summary: "Ett svar att granska.", findings: [finding], coverage: [{ accountId: account.id, status: "checked", message: "Kontrollerat" }] };
  const observations = new Map([["one", observation]]);
  assert.deepEqual(validateAssistantEvidence(result, [account], observations), result);
  {
    const alias = "alias@example.test", permitted = new Map([["one", { ...observation, replyFrom: alias }]]), forged = { ...result, findings: [{ ...finding, replyFrom: "forged@example.test" }] };
    assert.equal(validateAssistantEvidence(result, [account], permitted).findings[0].replyFrom, alias, "the host's own read names the reply address");
    assert.equal(validateAssistantEvidence(forged, [account], permitted).findings[0].replyFrom, alias, "a finding cannot replace it");
    assert.equal(validateAssistantEvidence(forged, [account], observations).findings[0].replyFrom, undefined, "a finding cannot supply one either");
    assert.equal(validateAssistantEvidence({ ...result, findings: [{ ...finding, kind: "information", draft: undefined }] }, [account], permitted).findings[0].replyFrom, undefined, "only an answer has a reply address");
  }
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...finding, sources: [{ observationId: "one", quote: "Fabricated quote" }] }] }, [account], observations));
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...finding, accountId: other.id }] }, [account, other], observations));
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...finding, threadId: "gmail:differentthread" }] }, [account], observations));
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...finding, messageId: "gmail:message:unobserved" }] }, [account], observations));
  assert.throws(() => validateAssistantEvidence(result, [account], new Map([...observations, ["latest", { ...observation, messageId: "gmail:message:newer-with-identical-text" }]])), /senast lästa/);
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...finding, sourceUrl: account.url }] }, [account], observations));
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [], coverage: [...result.coverage, ...result.coverage] }, [account], observations));
  assert.throws(() => validateAssistantEvidence({ ...result, findings: [] }, [account], new Map()));
  {
    const browser = new AssistantBrowser(dir, dir);
    browser.owned = async () => ({ account, url });
    browser.call = async name => name === "read_page" ? { text: "UNRELATED SIDEBAR QUOTE from a different thread" } : {};
    browser.script = async () => ({ nativeThread: null, nativeMessage: "native-one", scopeText: observation.text, areas: ["inbox"], view: "detail", truncated: false });
    const read = await browser.read(1);
    assert(!read.text.includes("UNRELATED"));
    const scopedFinding = { ...finding, sources: [{ observationId: read.observationId, quote: finding.sources[0].quote }] };
    assert.doesNotThrow(() => validateAssistantEvidence({ ...result, findings: [scopedFinding] }, [account], browser.observations));
    assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...scopedFinding, sources: [{ observationId: read.observationId, quote: "UNRELATED SIDEBAR QUOTE" }] }] }, [account], browser.observations));
    const eventUrl = "https://calendar.google.com/calendar/u/0/r/eventedit/native-event";
    browser.owned = async () => ({ account, url: eventUrl });
    browser.script = async () => ({ nativeThread: "event:native-event", nativeMessage: null, scopeText: "Projektmöte måndag 09:00 med teamet.", areas: ["calendar"], view: "detail", truncated: false });
    const event = await browser.read(1);
    const eventFinding = { ...finding, kind: "meeting", threadId: event.sourceId, messageId: event.messageId, sourceUrl: event.url, recipient: undefined, sources: [{ observationId: event.observationId, quote: "Projektmöte måndag 09:00" }] };
    assert.doesNotThrow(() => validateAssistantEvidence({ ...result, findings: [eventFinding] }, [account], browser.observations));
    assert.throws(() => validateAssistantEvidence({ ...result, findings: [{ ...eventFinding, sources: [{ observationId: event.observationId, quote: "UNRELATED SIDEBAR QUOTE" }] }] }, [account], browser.observations));
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), selected = { ...account, provider: 'zoho', url: 'https://mail.zoho.eu/zm/#mail/folder/inbox/p/123456789' };
    browser.owned = async () => ({ account: selected, url: selected.url }); browser.warmedTabs.add(1);
    browser.call = async () => ({});
    const messages = [{nativeId:'newer',sender:'sender@example.test',body:'Newest message',complete:true},{nativeId:'older',sender:account.email,body:'Older message',complete:true}];
    browser.script = async (_tabId, fn) => fn.name === 'assistantZohoFoldersScript' ? { folders: [] }
      : ({nativeThread:null,nativeMessage:null,scopeText:'Native conversation',areas:['inbox'],view:'detail',truncated:false,historyComplete:true,chronological:false,messages});
    const first = await browser.read(1); messages[0].body = 'A new incoming reply changes the snapshot';
    const changed = await browser.read(1);
    assert.notEqual(first.messageId, changed.messageId, 'unordered conversation freshness covers every message, not merely its last DOM node');
    let clicks = 0;
    browser.read = async () => ({ historyComplete:false,truncated:false });
    browser.script = async () => ({ref:'ref_1',rootId:'native-unloaded'});
    browser.action = async () => { clicks++; return {}; };
    const stopped = await browser.expandThread(1);
    assert.equal(clicks,1,'an unchanged native disclosure is never clicked again in the same expansion'); assert(stopped.help);
    await browser.close();
  }
  for (const mode of ["already-ready", "allowed", "disabled", "still-loading", "url-before", "closed-before", "url-after", "closed-after", "mismatch", "loading-mismatch", "mismatch-after", "transport", "unsupported"]) {
    const browser = new AssistantBrowser(dir, dir), outlook = { ...account, provider: "outlook", url: "https://outlook.live.com/mail/0/" };
    browser.tabs.set(1, outlook);
    let url = outlook.url, alive = true, activated = false, foregroundRequests = 0, readyChecks = 0, identityReads = 0;
    const loading = () => new AssistantBrowserError("failed", "loading", "Appen laddar fortfarande");
    browser.waitForReady = async () => {
      readyChecks++;
      if (mode === "transport") throw new AssistantBrowserError("failed", "transport", "Transporten svarar inte");
      if (mode === "unsupported") throw new AssistantBrowserError("unsupported", "layout", "Okänd layout");
      if (mode === "already-ready" || mode === "mismatch") return;
      if (mode === "url-before") url = outlook.url + "inbox";
      if (mode === "closed-before") alive = false;
      if (mode === "still-loading" || !activated) throw loading();
    };
    browser.call = async (name, args) => {
      if (name === "tabs_context_mcp") return { tabs: alive ? [{ tabId: 1, url }] : [] };
      if (name === "tab_switch") {
        assert.equal(args.bringToFront, true); foregroundRequests++;
        if (mode === "disabled") throw new AssistantBrowserError("failed", "browser-tool", "FOCUS_DISABLED");
        activated = true;
        if (mode === "url-after") url = outlook.url + "inbox";
        if (mode === "closed-after") alive = false;
        return {};
      }
      throw new Error(`Unexpected foreground fixture call ${name}`);
    };
    browser.script = async (_tabId, fn) => {
      if (fn.name === "identityScript") {
        identityReads++;
        if (mode === "mismatch-after" && !activated) return [];
        return [mode.includes("mismatch") ? other.email : outlook.email];
      }
      throw new Error(`Unexpected foreground fixture script ${fn.name}`);
    };
    if (["already-ready", "allowed"].includes(mode)) {
      await browser.owned(1);
      assert.equal(foregroundRequests, mode === "allowed" ? 1 : 0);
      assert(identityReads > 0);
      if (mode === "allowed") { await browser.owned(1); assert.equal(foregroundRequests, 1); }
    } else {
      const expected = mode === "disabled" ? "foreground-required" : mode === "still-loading" ? "loading" : mode.startsWith("url-") ? "navigation-changed" : mode.startsWith("closed-") ? "tab-closed" : mode.includes("mismatch") ? "account-mismatch" : mode === "unsupported" ? "layout" : "transport";
      await assert.rejects(() => browser.owned(1), error => error instanceof AssistantBrowserError && error.code === expected, mode);
      const mayActivate = ["disabled", "still-loading", "url-after", "closed-after", "mismatch-after"].includes(mode);
      assert.equal(foregroundRequests, mayActivate ? 1 : 0, `${mode}: foreground is requested only after a proven loading failure on an unchanged owned tab`);
      if (mode === "disabled") assert.equal(activated, false, "the existing preference denial cannot activate a window");
      if (["disabled", "still-loading"].includes(mode)) {
        await assert.rejects(() => browser.owned(1));
        assert.equal(foregroundRequests, 1, "a consumed foreground attempt is never repeated for the tab");
      }
    }
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), zoho = { ...account, provider: "zoho", url: "https://mail.zoho.eu/zm/" };
    browser.tabs.set(1, zoho);
    let openAttempts = 0, clicks = 0, closes = 0;
    browser.call = async () => ({ tabs: [{ tabId: 1, url: zoho.url }] });
    browser.script = async (_tabId, fn, args) => {
      if (fn.name === "loadingScript") return false;
      if (fn.name === "identityScript") return clicks ? [zoho.email] : [];
      if (fn.name === "identityMenuScript" && args[1] === "open") { openAttempts++; if (openAttempts < 3) return false; clicks++; return true; }
      if (fn.name === "identityMenuScript" && args[1] === "close") { closes++; return true; }
      throw new Error(`Unexpected identity-readiness fixture script ${fn.name}`);
    };
    await browser.owned(1);
    assert.equal(openAttempts, 3); assert.equal(clicks, 1); assert.equal(closes, 1, "only nondispatched false attempts are repeated before one real menu click");
    openAttempts = 0; closes = 0;
    browser.script = async (_tabId, fn) => {
      if (fn.name === "loadingScript") return false;
      if (fn.name === "identityScript") return [];
      if (fn.name === "identityMenuScript") { openAttempts++; throw new Error("Ambiguous profile-click failure"); }
      throw new Error(`Unexpected ambiguous identity fixture script ${fn.name}`);
    };
    await assert.rejects(() => browser.owned(1), /Ambiguous profile-click failure/);
    assert.equal(openAttempts, 1); assert.equal(closes, 0, "a thrown profile click is never replayed or closed speculatively");
    await browser.close();
  }
  assert.throws(() => validateAssistantCoverageDepth("check-mail", [{ area: "inbox", view: "list" }, { area: "sent", view: "list" }]));
  assert.doesNotThrow(() => validateAssistantCoverageDepth("check-mail", [{ area: "inbox", view: "detail" }, { area: "sent", view: "empty" }]));
  assert.throws(() => validateAssistantCoverageDepth("my-day", [{ area: "inbox", view: "detail" }, { area: "sent", view: "detail" }, { area: "calendar", view: "list" }]));
  assert.doesNotThrow(() => validateAssistantCoverageDepth("prepare-meeting", [{ area: "inbox", view: "empty" }, { area: "sent", view: "detail" }, { area: "calendar", view: "detail" }]));
  {
    const zoho = { ...account, provider: 'zoho', url: 'https://mail.zoho.eu/zm/' };
    const folders = [{ id: '10000001', name: 'Inkorg', kind: 'inbox', url: zoho.url + '#mail/folder/10000001' },
      { id: '10000002', name: 'Projektkontoret', kind: 'custom', url: zoho.url + '#mail/folder/10000002' }];
    const browser = new AssistantBrowser(dir, dir), executor = new AssistantExecutor(dir, dir);
    browser.tabs.set(1, zoho); browser.warmedTabs.add(1);
    let index = 0, view = 'list', readableRows = true, folderReady = true, folderChecks = 0, loseReady = false;
    const currentUrl = () => folders[index].url + (view === 'detail' ? '/p/12345678' : '');
    browser.owned = async () => ({ account: zoho, url: currentUrl() });
    browser.call = async name => name === 'tabs_context_mcp' ? { tabs: [{ tabId: 1, url: folders[index].url }] } : { elements: '' };
    browser.script = async (_tabId, fn) => {
      if (fn.name === 'assistantZohoFoldersScript') {
        if (!folderReady && ++folderChecks >= 2) folderReady = true;
        return { folders, currentId: folders[index].id, listReady: folderReady };
      }
      const rendered = folderReady ? index : 0;
      if (loseReady) { folderReady = false; folderChecks = 0; }
      return { nativeThread: null, nativeMessage: null, scopeText: '', areas: index ? [] : ['inbox'], view, truncated: false,
        rows: readableRows ? [{ ref: `ref_${rendered + 1}`, thread: `thread-${rendered}`, last: `message-${rendered}`, text: `Native row ${rendered}`, at: new Date().toISOString() }] : [] };
    };
    const first = await browser.read(1);
    assert.equal(first.accountEmail, zoho.email, 'folder labels do not replace the verified profile identity');
    assert.deepEqual(browser.pendingMailFolders(zoho.id).map(folder => folder.name), ['Projektkontoret']);
    browser.readingProofs.set(zoho.id, [{ area: 'inbox', view: 'empty' }, { area: 'sent', view: 'empty' }]);
    const execution = { context: { run: { task: 'check-mail' }, settings: { lookbackDays: 7 } }, browser };
    assert.throws(() => executor.verifyCoverage(execution, { accountId: zoho.id, status: 'checked' }), /Projektkontoret/);
    assert.match(executor.inboxCoverage(execution, { accountId: zoho.id, status: 'partial', message: '' }).message, /Projektkontoret/);
    index = 1; view = 'unsupported'; await browser.read(1);
    assert.equal(browser.pendingMailFolders(zoho.id).length, 1, 'an unknown custom-folder layout is not certified');
    view = 'list'; readableRows = false; await browser.read(1);
    assert.equal(browser.pendingMailFolders(zoho.id).length, 1, 'a list whose rows could not be read is not an explicitly empty folder');
    readableRows = true; folderReady = false;
    view = 'list'; const second = await browser.read(1);
    assert.equal(second.inboxRows, 1);
    assert.equal(browser.inboxRows.get(zoho.id).size, 2, 'split-folder rows join the same account review scope');
    assert(folderChecks >= 2, 'the new folder is not read until its own list replaces the old rows');
    assert.equal(browser.pendingMailFolders(zoho.id).length, 0);
    const status = executor.inboxStatus(execution, zoho.id);
    assert.equal(status.remaining, 2); assert.deepEqual(status.open, ['ref_2']);
    assert(status.sources.includes(folders[0].url) && status.sources.includes(folders[1].url), 'stale refs retain the native source folder to reopen');
    browser.mailFolders.get(zoho.id).get(folders[1].id).listRead = false;
    const observations = browser.observations.size;
    loseReady = true;
    await assert.rejects(() => browser.read(1), error => error.code === 'folder-loading');
    assert.equal(browser.observations.size, observations, 'a list changing during capture supplies no reading proof');
    assert.equal(browser.pendingMailFolders(zoho.id).length, 1);
    loseReady = false; folderChecks = 0; folderReady = false; view = 'detail';
    const detail = await browser.read(1);
    assert.equal(detail.view, 'detail', 'a native detail remains readable when no folder list is ready');
    assert.equal(detail.inboxRows, undefined, 'residual detail rows do not certify another folder list');
    assert.equal(browser.pendingMailFolders(zoho.id).length, 1);
    browser.mailFolders.get(zoho.id).get(folders[1].id).listRead = true;
    assert.throws(() => executor.verifyCoverage(execution, { accountId: zoho.id, status: 'checked' }), /saknar ett utfall/);
    execution.context.run.task = 'my-day';
    assert.doesNotThrow(() => executor.inboxCoverage(execution, { accountId: zoho.id, status: 'partial', message: '' }));
    browser.inboxRows.clear();
    for (const folder of folders) browser.seeRows(zoho, 1, [{ text: 'Same rendered subject', ref: 'ref_3' }], 'list', folder.url);
    assert.equal(browser.inboxRows.get(zoho.id).size, 2, 'text-only rows in different split inboxes retain separate review identities');
    await browser.close(); await executor.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir, undefined, undefined, 42), calls = [];
    browser.call = async (name, args) => {
      calls.push({ name, args });
      return name === 'tabs_context_mcp' ? { tabs: [] } : name === 'tabs_create_mcp' ? { tabId: 1 } : {};
    };
    browser.read = async () => ({ status: 'ready' });
    await browser.open(account);
    assert.deepEqual(calls.find(call => call.name === 'tabs_context_mcp').args, { createIfEmpty: true, createWindowId: 42 });
    await browser.close();
  }
  for (const status of ["login", "unsupported", "failed"]) {
    const browser = new AssistantBrowser(dir, dir);
    browser.call = async name => name === "tabs_context_mcp" ? { tabs: [] } : name === "tabs_create_mcp" ? { tabId: 1 } : {};
    browser.read = async () => { throw new AssistantBrowserError(status, "fixture", "Klassat testfel"); };
    const opened = await browser.open(account);
    assert.equal(opened.status, status); assert.equal(opened.loginRequired, status === "login");
    await browser.close();
  }
  for (const hydrationPhase of ["identity", "snapshot"]) {
    const browser = new AssistantBrowser(dir, dir), zoho = { ...account, provider: "zoho", url: "https://mail.zoho.eu/zm/" };
    const canonical = zoho.url + "#mail/folder/inbox/p/1";
    let exists = false, currentUrl = zoho.url, navigations = 0, pageReads = 0, identityReads = 0;
    const failures = [], realRead = browser.read.bind(browser);
    browser.read = async tabId => { try { return await realRead(tabId); } catch (error) { failures.push(error); throw error; } };
    browser.call = async (name, args) => {
      if (name === "tabs_context_mcp") return { tabs: exists ? [{ tabId: 1, url: currentUrl }] : [] };
      if (name === "tabs_create_mcp") { exists = true; return { tabId: 1 }; }
      if (name === "navigate") { navigations++; currentUrl = args.url; return {}; }
      if (name === "tab_switch") { assert.equal(args.bringToFront, false); return {}; }
      if (name === "read_page") { pageReads++; if (hydrationPhase === "snapshot" && pageReads === 1) currentUrl = canonical; return { text: "native mailbox navigation" }; }
      throw new Error(`Unexpected hydration fixture call ${name}`);
    };
    browser.script = async (_tabId, fn) => {
      if (fn.name === "loadingScript") return false;
      if (fn.name === "identityScript") { identityReads++; if (hydrationPhase === "identity" && identityReads === 1) currentUrl = canonical; return [zoho.email]; }
      if (fn.name === 'identityMenuScript') return false;
      if (fn.name === 'assistantZohoFoldersScript') return { folders: [], listReady: true };
      if (fn.name === "messageMetadataScript") return { nativeThread: null, nativeMessage: null, scopeText: "", areas: ["inbox"], view: "list", truncated: false };
      throw new Error(`Unexpected hydration fixture script ${fn.name}`);
    };
    const opened = await browser.open(zoho);
    assert.equal(opened.status, "ready"); assert.equal(opened.url, canonical);
    assert.equal(pageReads, hydrationPhase === "identity" ? 1 : 2); assert.equal(navigations, 1, "SPA hydration retries only the read, never the navigation");
    assert(identityReads >= (hydrationPhase === "identity" ? 3 : 4), "each read rechecks exact identity before and after its snapshot");
    assert.equal(failures.length, 1); assert.equal(failures[0].code, "navigation-changed");
    assert.equal(browser.observations.size, 1, "the interrupted snapshot is never retained as evidence");
    await browser.close();
  }
  for (const code of ["navigation-changed", "browser-tool", "loading", "account-mismatch", "identity-unavailable", "tab-closed", "approval-navigation-changed"]) {
    const approvalMode = code === "approval-navigation-changed";
    const approved = approvalMode ? { itemId: "fixture", revision: 1, account, threadId, sourceUrl: url, recipient: "sender@example.test", body: "Approved body" } : undefined;
    const browser = new AssistantBrowser(dir, dir, approved);
    let reads = 0, navigations = 0;
    browser.call = async name => {
      if (name === "tabs_context_mcp") return { tabs: [] };
      if (name === "tabs_create_mcp") return { tabId: 1 };
      if (name === "navigate") { navigations++; return {}; }
      throw new Error(`Unexpected retry-bound fixture call ${name}`);
    };
    browser.read = async () => { reads++; throw new AssistantBrowserError(code === "account-mismatch" ? "login" : code === "identity-unavailable" ? "unsupported" : "failed", approvalMode ? "navigation-changed" : code, "Bounded fixture failure"); };
    const opened = await browser.open(account, approvalMode ? url : undefined);
    assert.equal(opened.code, approvalMode ? "navigation-changed" : code);
    assert.equal(reads, ["navigation-changed", "identity-unavailable"].includes(code) ? 2 : 1, `${code}: only one nonapproval SPA/readiness read may be retried`);
    assert.equal(navigations, 1);
    await browser.close();
  }
  {
    const globals = ["document", "getComputedStyle", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    const node = text => ({ innerText: text || "", getBoundingClientRect: () => ({ width: 2080, height: 1173 }), getAttribute: () => null });
    let hasHeader = true, rows = [], details = [], emptyStates = [], calendar = [];
    const retainedContainer = node();
    globalThis.document = { querySelectorAll(selector) {
      if (selector.includes("#owa-me-control-container")) return hasHeader ? [node()] : [];
      if (selector === '[role="listbox"]') return [node()];
      if (selector === '[role="listbox"] [role="option"]') return rows;
      if (selector.includes('MailReadCompose')) return details;
      if (selector.includes('empty-message-list')) return emptyStates;
      if (selector.includes('CalendarEventPeek')) return calendar;
      if (selector === '#loadingScreen') return [retainedContainer];
      throw new Error(`Unexpected loading fixture selector ${selector}`);
    } };
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
    globalThis.location = { pathname: "/mail/0/" };
    try {
      assert.equal(assistantLoadingScript("outlook"), true, "retained container plus an unpainted empty list remains loading");
      rows = Array.from({ length: 16 }, () => node("Native message row"));
      assert.equal(assistantLoadingScript("outlook"), false, "native painted rows prove ready despite the retained full-viewport container");
      hasHeader = false;
      assert.equal(assistantLoadingScript("outlook"), true, "rows require the native app header before overriding a loader");
      hasHeader = true; rows = []; details = [node("Actually rendered native message body")];
      assert.equal(assistantLoadingScript("outlook"), false);
      details = []; emptyStates = [node("There are no items to show.")];
      assert.equal(assistantLoadingScript("outlook"), false, "explicit native empty state in the listbox proves readiness");
      emptyStates = [node("A message merely mentions no items")];
      assert.equal(assistantLoadingScript("outlook"), true, "unrecognized prose cannot override loading");
      emptyStates = []; calendar = [node()]; globalThis.location.pathname = "/calendar/0/";
      assert.equal(assistantLoadingScript("outlook"), false);
    } finally {
      for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
  {
    const browser = new AssistantBrowser(dir, dir);
    const outlook = { ...account, provider: "outlook", url: "https://outlook.live.com/mail/0/" };
    let loading = 2;
    browser.call = async () => ({ tabs: [{ tabId: 1, url: outlook.url }] });
    browser.script = async (_tabId, fn) => fn.name === "loadingScript" ? loading-- > 0 : [outlook.email];
    await browser.waitForReady(1, outlook, 2000);
    assert.equal(loading, -1, "known app loader is polled until the app is ready");
    browser.script = async () => true;
    await assert.rejects(() => browser.waitForReady(1, outlook, 0), error => error instanceof AssistantBrowserError && error.status === "failed" && error.code === "loading");
    browser.read = async () => { throw new AssistantBrowserError("failed", "loading", "Appen laddar fortfarande"); };
    browser.call = async name => name === "tabs_context_mcp" ? { tabs: [] } : name === "tabs_create_mcp" ? { tabId: 1 } : {};
    const opened = await browser.open(outlook);
    assert.equal(opened.status, "failed"); assert.equal(opened.code, "loading"); assert.equal(opened.loginRequired, false);
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), switches = [];
    browser.tabs.set(1, account);
    browser.call = async (_name, args) => { switches.push(args); if (args.bringToFront) throw new Error("FOCUS_DISABLED"); return {}; };
    await assert.rejects(() => browser.show(account), /vald i bakgrunden/);
    assert.deepEqual(switches.map(item => item.bringToFront), [true, false]);
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), calls = [];
    const outlook = { ...account, provider: "outlook", url: "https://outlook.live.com/mail/0/inbox/id/AAAAABBBBBCCCCDDD" };
    browser.owned = async () => ({ account: outlook, url: outlook.url });
    browser.call = async (name, args) => {
      calls.push({ name, args });
      return name === "computer" ? { image: "DISCARDED_BACKGROUND_IMAGE" } : { text: "Inbox list" };
    };
    let scopeText = "Original native message from sender@example.test with full context.";
    browser.script = async () => ({ nativeThread: null, nativeMessage: null, scopeText, areas: ["inbox"], view: "detail", truncated: false });
    const first = await browser.read(1);
    scopeText += "\nReply composer: the exact approved draft was inserted.";
    const second = await browser.read(1);
    assert.equal(first.messageId, "outlook:message:AAAAABBBBBCCCCDDD");
    assert.equal(first.messageId, second.messageId, "native message identity survives a reply composer inside the read pane");
    assert.deepEqual(calls.filter(call => call.name === "computer"), [{ name: "computer", args: { tabId: 1, action: "screenshot", allowFocus: false } }]);
    assert.deepEqual(calls.filter(call => call.name === "tab_switch"), [{ name: "tab_switch", args: { tabId: 1, bringToFront: false } }]);
    assert(calls.findIndex(call => call.name === "tab_switch") < calls.findIndex(call => call.name === "computer"));
    assert(!JSON.stringify([first, second, [...browser.observations]]).includes("DISCARDED_BACKGROUND_IMAGE"), "the warmup image is neither returned nor retained as evidence");
    await browser.close();
  }
  for (const provider of ["outlook", "zoho"]) {
    const browser = new AssistantBrowser(dir, dir), selected = { ...account, provider,
      url: provider === "outlook" ? "https://outlook.live.com/mail/0/inbox/id/AAAAABBBBBCCCCDDD" : "https://mail.zoho.eu/zm/#mail/folder/inbox/p/123456789" };
    browser.tabs.set(1, selected);
    let painted = false, identityVerified = false, captures = 0;
    browser.waitForReady = async () => { assert(painted, "provider readiness depends on the earlier background paint capture"); };
    browser.call = async (name, args) => {
      if (name === "tabs_context_mcp") return { tabs: [{ tabId: 1, url: selected.url }] };
      if (name === "tab_switch") { assert.equal(args.bringToFront, false); return {}; }
      if (name === "computer") { assert.equal(args.action, "screenshot"); assert.equal(args.allowFocus, false); painted = true; captures++; return { image: "DISCARDED_BEFORE_IDENTITY" }; }
      if (name === "read_page") { assert(identityVerified, "full page text must remain gated by exact identity"); return { text: "navigation" }; }
      throw new Error(`Unexpected fixture call ${name}`);
    };
    browser.script = async (_tabId, fn) => {
      if (fn.name === "loadingScript") return !painted;
      if (fn.name === "identityScript") { identityVerified = true; return [selected.email]; }
      if (fn.name === 'identityMenuScript') return false;
      if (fn.name === "messageMetadataScript") { assert(identityVerified); return { nativeThread: null, nativeMessage: null, scopeText: "Scoped native message from sender@example.test.", areas: ["inbox"], view: "detail", truncated: false }; }
      if (fn.name === 'assistantZohoFoldersScript') { assert(identityVerified); return { folders: [] }; }
      throw new Error(`Unexpected fixture script ${fn.name}`);
    };
    const read = await browser.action("browser_read", { tabId: 1 });
    await browser.read(1);
    assert.equal(captures, 1); assert(identityVerified);
    assert(!JSON.stringify([read, [...browser.observations]]).includes("DISCARDED_BEFORE_IDENTITY"));
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), calls = [];
    browser.tabs.set(1, account);
    browser.call = async (name, args) => {
      calls.push({ name, args });
      if (name === "tabs_context_mcp") return { tabs: [{ tabId: 1, url }] };
      if (name === "tab_switch") { assert.equal(args.bringToFront, false); return {}; }
      if (name === "read_page") return { text: "Gmail native rows and message refs" };
      throw new Error(`Unexpected Gmail background-selection fixture call ${name}`);
    };
    browser.script = async (_tabId, fn) => {
      if (fn.name === "loadingScript") return false;
      if (fn.name === "identityScript") return [account.email];
      if (fn.name === "messageMetadataScript") return { nativeThread: null, nativeMessage: "native-gmail", scopeText: "Verified Gmail message from sender@example.test.", areas: ["inbox"], view: "detail", truncated: false };
      throw new Error(`Unexpected Gmail background-selection fixture script ${fn.name}`);
    };
    assert.equal((await browser.read(1)).status, "ready");
    assert.equal((await browser.read(1)).status, "ready");
    assert.deepEqual(calls.filter(call => call.name === "tab_switch"), [{ name: "tab_switch", args: { tabId: 1, bringToFront: false } }]);
    assert.equal(calls.filter(call => call.name === "computer").length, 0, "Gmail selection never captures a screenshot");
    assert.equal(browser.foregroundAttempts.size, 0, "Gmail selection never requests foreground");
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), zoho = { ...account, provider: "zoho", url: "https://mail.zoho.eu/zm/#mail/folder/inbox/p/123456789" };
    browser.tabs.set(1, zoho);
    let loader = true, captures = 0, pageReads = 0, signedIn = zoho.email;
    browser.call = async (name, args) => {
      if (name === "tabs_context_mcp") return { tabs: [{ tabId: 1, url: zoho.url }] };
      if (name === "tab_switch") { assert.equal(args.bringToFront, false); return {}; }
      if (name === "computer") {
        captures++; assert.equal(args.allowFocus, false); loader = false;
        throw new AssistantBrowserError("failed", "browser-tool", "Background screenshot unavailable: CDP capture failed and visible-tab fallback needs focus");
      }
      if (name === "read_page") { pageReads++; return { text: "native mailbox" }; }
      throw new Error(`Unexpected optional-capture fixture call ${name}`);
    };
    browser.script = async (_tabId, fn) => {
      if (fn.name === "loadingScript") return loader;
      if (fn.name === "identityScript") return [signedIn];
      if (fn.name === 'identityMenuScript') return false;
      if (fn.name === "messageMetadataScript") return { nativeThread: null, nativeMessage: null, scopeText: "Original native message from sender@example.test.", areas: ["inbox"], view: "detail", truncated: false };
      if (fn.name === 'assistantZohoFoldersScript') return { folders: [] };
      throw new Error(`Unexpected optional-capture fixture script ${fn.name}`);
    };
    const first = await browser.read(1), second = await browser.read(1);
    assert.equal(first.status, "ready"); assert.equal(second.status, "ready");
    assert.equal(captures, 1, "an unavailable auxiliary capture is consumed once and never retried");
    assert.equal(pageReads, 2, "verified textual reads continue after an unavailable auxiliary capture");
    signedIn = other.email;
    await assert.rejects(() => browser.read(1), error => error instanceof AssistantBrowserError && error.status === "login" && error.code === "account-mismatch");
    assert.equal(pageReads, 2, "optional capture handling cannot bypass a real identity failure");
    await browser.close();
  }
  {
    const browser = new AssistantBrowser(dir, dir), zoho = { ...account, provider: "zoho", url: "https://mail.zoho.eu/zm/#mail/folder/sent/p/123456789" };
    browser.owned = async () => ({ account: zoho, url: zoho.url });
    browser.call = async () => ({ text: "mail navigation" });
    browser.script = async (_tabId, fn) => fn.name === 'assistantZohoFoldersScript' ? { folders: [] }
      : ({ nativeThread: null, nativeMessage: null, scopeText: "Original native message from sender@example.test.", areas: ["sent"], view: "detail", truncated: false });
    const read = await browser.read(1);
    assert.equal(read.sourceId, "zoho:123456789");
    assert.equal(read.messageId, "zoho:message:123456789");
    await browser.close();
  }
  // A card read through Zoho's API is sent by the host: no worker starts, and the attempt is recorded before the request.
  {
    const zohoAccount = { id: "zoho", provider: "zoho", label: "Zoho", email: "owner@example.test", url: "https://mail.zoho.eu/zm/", enabled: true };
    const card = { id: "card", revision: 2, accountId: "zoho", threadId: "zoho:900", messageId: "zoho:message:100", sourceUrl: "https://mail.zoho.eu/zm/#mail/folder/111/p/100", recipient: "kund@example.test", replyFrom: "alias@example.test", draft: "Tack.", kind: "reply", status: "open" };
    const zohoApproval = { itemId: card.id, revision: card.revision, account: zohoAccount, threadId: card.threadId, sourceUrl: card.sourceUrl, recipient: card.recipient, body: card.draft, sender: card.replyFrom };
    const context = { run: { id: "send-run", task: "send" }, settings: { accounts: [zohoAccount] }, items: [card], answers: [], lastChecks: {}, approval: zohoApproval };
    const recording = log => ({ update: async () => { log.push("update"); }, sendIntent: async () => { log.push("intent"); }, sent: async receipt => { log.push(`sent:${receipt}`); }, exit: async message => { log.push(`exit:${message}`); } });

    assert.equal(assistantZohoApiCard(zohoApproval, card.messageId), true);
    assert.equal(assistantZohoApiCard(zohoApproval, "content:0123456789abcdef"), false, "a content hash names no message Zoho can confirm");
    assert.equal(assistantZohoApiCard({ ...zohoApproval, threadId: "zoho:123456789" }, "zoho:message:123456789"), true, "a web read of one message has the same shape and is confirmed at Zoho");
    assert.equal(assistantZohoApiCard({ ...zohoApproval, threadId: "zoho:abc" }, card.messageId), false);
    assert.equal(assistantZohoApiCard({ ...zohoApproval, account: account }, card.messageId), false, "another provider keeps its web route");

    {
      const executor = new AssistantExecutor(dir, join(dir, "zoho-host")), log = [];
      let release, received;
      const held = new Promise(resolve => { release = resolve; });
      executor.zohoApi = { reply: async (input, message, intent) => { received = { input, message }; await intent(); await held; log.push("post"); return "kvitto"; } };
      await executor.start(context, recording(log));
      assert.equal(executor.active, undefined, "no worker is started");
      await assert.rejects(executor.start(context, recording([])), /arbetar redan/, "a second start waits for the reply in flight");
      const closing = executor.close();
      let closed = false; void closing.then(() => { closed = true; });
      await delay(20);
      assert.equal(closed, false, "shutdown waits for a request already on its way");
      release();
      await closing;
      assert.deepEqual(log, ["update", "intent", "post", "sent:kvitto"]);
      assert.deepEqual(received, { input: zohoApproval, message: card.messageId });
    }
    for (const [why, items, expected] of [
      ["a reminder", [{ ...card, kind: "followup" }], /Påminnelser/],
      ["a card Zoho cannot confirm", [{ ...card, messageId: "content:0123456789abcdef" }], /Svara direkt i Zoho/],
    ]) {
      const executor = new AssistantExecutor(dir, join(dir, "zoho-host")), log = [];
      executor.zohoApi = { reply: async () => { throw new Error("Zoho must not be asked"); } };
      await executor.start({ ...context, items }, recording(log));
      assert.equal(executor.active, undefined, `${why}: no worker is started`);
      await executor.replying;
      assert.equal(log.length, 1, why);
      assert.match(log[0], expected, why);
      assert.match(log[0], /Inget skickades\.$/, why);
      await executor.close();
    }
    {
      // Outlook saves a draft the moment Reply is pressed, so an approved Outlook reply starts nothing and asks the user to reply there.
      const outlookAccount = { ...zohoAccount, id: "outlook-host", provider: "outlook", url: "https://outlook.live.com/mail/0/" };
      const outlookUrl = "https://outlook.live.com/mail/0/inbox/id/AQMkADAwATM0MDAAMS1hMjE2";
      const outlookCard = { ...card, accountId: outlookAccount.id, sourceUrl: outlookUrl, replyFrom: undefined };
      const outlookApproval = { ...zohoApproval, account: outlookAccount, sourceUrl: outlookUrl, sender: undefined };
      const executor = new AssistantExecutor(dir, join(dir, "outlook-host")), log = [];
      executor.zohoApi = { reply: async () => { throw new Error("Zoho must not be asked"); } };
      await executor.start({ ...context, settings: { accounts: [outlookAccount] }, items: [outlookCard], approval: outlookApproval }, recording(log));
      assert.equal(executor.active, undefined, "no worker is started for an Outlook reply");
      await executor.replying;
      assert.deepEqual(log, ["exit:Outlook-svar kan inte skickas härifrån ännu. Svara direkt i Outlook. Inget skickades."]);
      await executor.close();
    }
    for (const [why, reply, expected] of [
      ["a refusal before the attempt", async () => { throw new Error("Tråden har ändrats."); }, ["update", "exit:Tråden har ändrats. Inget skickades."]],
      ["a failure after the attempt", async (input, message, intent) => { await intent(); throw new Error("Kontrollera Skickat."); }, ["update", "intent", "exit:Kontrollera Skickat."]],
    ]) {
      const executor = new AssistantExecutor(dir, join(dir, "zoho-host")), log = [];
      executor.zohoApi = { reply };
      await executor.start(context, recording(log));
      await executor.replying;
      assert.deepEqual(log, expected, why);
      assert.equal(executor.replying, undefined, why);
      await executor.close();
    }
    {
      const executor = new AssistantExecutor(dir, join(dir, "zoho-host")), log = [];
      let posted = 0;
      executor.zohoApi = { reply: async (input, message, intent) => { await intent(); posted++; return "kvitto"; } };
      await executor.start(context, { ...recording(log), sendIntent: async () => { throw new Error("Godkännandet har ändrats."); } });
      await executor.replying;
      assert.equal(posted, 0, "a refused intent stops the request");
      assert.deepEqual(log, ["update", "exit:Godkännandet har ändrats. Inget skickades."]);
      await executor.close();
    }
    // A card that changed after its approval is refused before any route: no worker starts and
    // nothing is posted to Zoho. The worker route runs from a root without a runner, so even a
    // start that got past the check could not reach a model.
    const stale = [["a newer revision", { revision: card.revision + 1 }], ["an edited draft", { draft: "Ändrat." }], ["another recipient", { recipient: "annan@example.test" }], ["another sender", { replyFrom: "annat-alias@example.test" }]];
    for (const [why, changes] of stale) {
      const executor = new AssistantExecutor(dir, join(dir, "zoho-host")), log = [];
      let posted = 0;
      executor.zohoApi = { reply: async (input, message, intent) => { posted++; await intent(); return "kvitto"; } };
      await assert.rejects(executor.start({ ...context, items: [{ ...card, ...changes }] }, recording(log)), /^Error: Godkännandet är inaktuellt eller gäller en annan version av svaret\.$/, `Zoho, ${why}`);
      await executor.replying;
      assert.deepEqual([executor.active, posted, log], [undefined, 0, []], `Zoho, ${why}: no worker, no post, no callback`);
      await executor.close();
    }
    {
      const noRunner = join(dir, "no-runner-root"); mkdirSync(noRunner);
      const mailAccount = { ...zohoAccount, id: "gmail-host", provider: "gmail", url: "https://mail.google.com/mail/u/0/" };
      const mailCard = { ...card, accountId: mailAccount.id, threadId: "gmail:FMfcgzQZstale0001", messageId: "gmail:message:stale0001", sourceUrl: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZstale0001", replyFrom: undefined };
      const mailApproval = { ...zohoApproval, account: mailAccount, threadId: mailCard.threadId, sourceUrl: mailCard.sourceUrl, sender: undefined };
      const mailContext = { ...context, settings: { accounts: [mailAccount], agent: { backend: "local", codex: { model: "gpt-6.1-sol", reasoningEffort: "high" }, local: { model: "qwen3.5:4b-q4_K_M" } } }, approval: mailApproval };
      for (const [why, changes] of stale) {
        const executor = new AssistantExecutor(noRunner, join(dir, "worker-host")), log = [];
        await assert.rejects(executor.start({ ...mailContext, items: [{ ...mailCard, ...changes }] }, recording(log)), /^Error: Godkännandet är inaktuellt eller gäller en annan version av svaret\.$/, `worker route, ${why}`);
        assert.deepEqual([executor.active, log], [undefined, []], `worker route, ${why}: no worker and no callback`);
        await executor.close();
      }
    }
  }

  const approval = { itemId: "item-one", revision: 2, account, threadId, sourceUrl: url, recipient: finding.recipient, body: finding.draft };
  assert.doesNotThrow(() => guardAssistantElement("click", { ...base, label: "Svara" }, account, url, approval));
  assert.throws(() => guardAssistantElement("click", { ...base, label: "Svara" }, other, url, approval));
  assert.throws(() => guardAssistantElement("click", { ...base, label: "Svara alla" }, account, url, approval), /verifieras/, "an approval names one recipient, so Reply all is never opened");
  assert.throws(() => guardAssistantElement("click", { ...base, label: "Svara" }, account, account.url, approval));
  const composer = { from: [account.email], to: [finding.recipient], cc: [], bcc: [], fieldsVerified: true, unknownRecipients: [], body: finding.draft, sendRef: "ref_12", bodyRef: "ref_11", url };
  assert.deepEqual(verifyAssistantComposer(composer, approval), composer);
  for (const change of [{ from: [other.email] }, { to: ["wrong@example.test"] }, { to: [finding.recipient, other.email] }, { cc: [other.email] }, { bcc: [other.email] }, { fieldsVerified: false }, { unknownRecipients: [other.email] }, { body: "Different" }, { url: account.url }, { sendRef: null }]) assert.throws(() => verifyAssistantComposer({ ...composer, ...change }, approval));
  {
    // A card may name another permitted sender: then exactly that address, and only on such a card.
    const alias = "alias@example.test", named = { ...approval, sender: alias };
    assert.deepEqual(verifyAssistantComposer({ ...composer, from: [alias] }, named), { ...composer, from: [alias] });
    assert.throws(() => verifyAssistantComposer(composer, named), /avviker/, "the account's own address is not the one the card showed");
    assert.throws(() => verifyAssistantComposer({ ...composer, from: [alias] }, approval), /avviker/, "a card without a named sender keeps the account's own address");
    assert.throws(() => verifyAssistantComposer({ ...composer, from: [alias, account.email] }, named), /avviker/, "an ambiguous sender stops the send");
  }
  {
    // With no From field in Gmail's reply box the verified account is the sender, and nothing else may have been approved.
    const implicit = { ...composer, from: [], fromImplicit: true };
    assert.deepEqual(verifyAssistantComposer(implicit, approval), implicit);
    assert.throws(() => verifyAssistantComposer(implicit, { ...approval, sender: "alias@example.test" }), /avviker/, "a card naming another sender cannot rest on the account");
    assert.throws(() => verifyAssistantComposer(implicit, { ...approval, account: { ...approval.account, provider: "outlook" } }), /avviker/, "only Gmail's reply box has this form");
    assert.throws(() => verifyAssistantComposer({ ...implicit, from: [other.email] }, approval), /avviker/, "a sender that is shown is never ignored");
    assert.throws(() => verifyAssistantComposer({ ...composer, from: [] }, approval), /avviker/, "an empty sender outside that form stops the send");
    for (const change of [{ to: [] }, { to: ["wrong@example.test"] }, { cc: [other.email] }, { bcc: [other.email] }, { body: "Different" }]) assert.throws(() => verifyAssistantComposer({ ...implicit, ...change }, approval), /avviker/);
  }

  {
    // Outlook sends a message address back to its list on a page load, so the running app is handed it instead.
    const route = async (provider, url, { existing = false, fail, failedTabUrl } = {}) => {
      const target = { ...account, provider, url: provider === "outlook" ? "https://outlook.live.com/mail/0/" : provider === "zoho" ? "https://mail.zoho.eu/zm/" : account.url };
      const browser = new AssistantBrowser(dir, dir), calls = [];
      let reads = 0, waits = 0;
      if (existing) browser.tabs.set(1, target);
      browser.call = async (name, args) => {
        if (name === "tabs_context_mcp") return { tabs: failedTabUrl && waits ? [{ tabId: 1, url: failedTabUrl }] : existing ? [{ tabId: 1, url }] : [] };
        if (name === "tabs_create_mcp") return { tabId: 1 };
        if (name === "wait_for" && ++waits === fail) throw new AssistantBrowserError("failed", "browser-tool", "TIMEOUT: wait_for predicate timed out after 15000ms", "TIMEOUT");
        calls.push({ name, ...args });
        return {};
      };
      browser.read = async () => { reads++; return { view: "detail" }; };
      browser.zohoAccounts?.set?.(target.id, {});
      const outcome = await browser.open(target, url).catch(error => ({ error }));
      await browser.close();
      return { calls, reads, outcome };
    };
    const message = "https://outlook.live.com/mail/0/inbox/id/AQMkADAwATM0MDAAMS1hMjE2LTY4MTQtMDACLTAwCgBGAAAD%3D";
    // Outlook saves a draft as soon as Reply is pressed, so an approved reply stops before it.
    const outlook = { ...account, provider: "outlook", url: "https://outlook.live.com/mail/0/" };
    assert.throws(() => guardAssistantElement("click", { ...base, label: "Svara" }, outlook, message, { ...approval, account: outlook, sourceUrl: message }), /Outlook-svar kan inte skickas härifrån ännu.*ingenting skickades/);
    assert.throws(() => guardAssistantElement("click", { ...base, label: "Svara" }, outlook, message), /uttryckliga godkännande/, "without an approval the old refusal still applies");
    assert.doesNotThrow(() => guardAssistantElement("click", { ...base, label: "Svara" }, account, url, approval), "Gmail's Reply is still allowed");
    for (const existing of [false, true]) {
      const { calls, reads } = await route("outlook", message, { existing });
      assert.deepEqual(calls.map(call => call.name), ["navigate", "wait_for", "javascript_tool", "wait_for"], "the app loads, then gets the address");
      assert.equal(calls[0].url, "https://outlook.live.com/mail/0/", "only the app's start page is loaded");
      assert.match(calls[1].predicate, /location\.pathname==="\/mail\/0\/"/);
      assert.match(calls[1].predicate, /role="listbox"/, "the app has drawn its list before it is handed the address");
      assert.match(calls[1].predicate, /location\.origin==="https:\/\/outlook\.live\.com"/, "on Outlook itself");
      assert.match(calls[1].predicate, /&&!\[\.\.\.document\.querySelectorAll\("\[data-app-section/, "and with no message on show, so what appears next is the one asked for");
      assert.ok(calls[2].text.includes("history.pushState(null,'',"+JSON.stringify(message)+")"));
      assert.match(calls[2].text, /PopStateEvent\('popstate'/);
      assert.ok(calls[3].predicate.includes("location.href==="+JSON.stringify(message)), "the exact address must be showing");
      assert.match(calls[3].predicate, /MailReadCompose/, "and the message itself");
      assert.match(calls[3].predicate, /BIZfh[\s\S]*textContent\.trim\(\)/, "with its text rendered");
      assert.equal(reads, 1);
    }
    const sent = await route("outlook", "https://outlook.live.com/mail/0/sentitems/id/AQMkADAwATM0MDAAMS1hMjE2");
    assert.equal(sent.calls[0].url, "https://outlook.live.com/mail/0/", "a message in another folder goes the same way");
    for (const fail of [1, 2]) {
      const stopped = await route("outlook", message, { fail });
      assert.equal(stopped.outcome.error?.code, "navigation-changed");
      assert.match(stopped.outcome.error.message, /^Outlook öppnade inte meddelandet/);
      assert.equal(stopped.reads, 0, "nothing is read when the message never appeared");
    }
    const stillOutlook = await route("outlook", message, { fail: 2, failedTabUrl: "https://outlook.live.com/mail/0/" });
    assert.equal(stillOutlook.outcome.error?.code, "navigation-changed", "a tab still on Outlook did not open the message");
    assert.equal(stillOutlook.reads, 0);
    const signedOut = await route("outlook", message, { fail: 1, failedTabUrl: "https://login.live.com/login.srf" });
    assert.equal(signedOut.outcome.error, undefined, "a signed-out session is reported by the read that follows, with its sign-in help");
    assert.equal(signedOut.reads, 1);
    const unmeasured = await route("outlook", "https://outlook.live.com/mail/inbox/id/AQMkADAwATM0MDAAMS1hMjE2");
    assert.deepEqual(unmeasured.calls.map(call => call.name), ["navigate"], "an address form that was never measured is loaded as before");
    const list = await route("outlook", "https://outlook.live.com/mail/0/inbox");
    assert.deepEqual(list.calls.map(call => [call.name, call.url]), [["navigate", "https://outlook.live.com/mail/0/inbox"]], "a list address is loaded as before");
    const gmail = await route("gmail", "https://mail.google.com/mail/0/id/FMfcgzQfixture");
    assert.deepEqual(gmail.calls.map(call => call.name), ["navigate"], "other services are loaded as before");
    {
      const browser = new AssistantBrowser(dir, dir), target = { ...account, provider: "outlook", url: "https://outlook.live.com/mail/0/" };
      browser.call = async name => { if (name === "tabs_context_mcp") return { tabs: [] }; if (name === "tabs_create_mcp") return { tabId: 1 }; if (name === "navigate") return {}; throw new AssistantBrowserError("failed", "browser-tool", "NO_EXTENSION: extension not connected yet", "NO_EXTENSION"); };
      browser.read = async () => { throw new Error("must not read"); };
      await assert.rejects(browser.open(target, message), /NO_EXTENSION/, "a lost connection is reported as itself");
      await browser.close();
    }
  }

  const auth = "a".repeat(64);
  assert.equal(assistantWorkerFrame(JSON.stringify({ secret: auth, tool: "workflow_context", args: {} }) + "\n", auth).tool, "workflow_context");
  for (const frame of [JSON.stringify({ secret: "wrong", tool: "workflow_context", args: {} }) + "\n", JSON.stringify({ secret: auth, tool: "javascript_tool", args: { text: "alert(1)" } }) + "\n", JSON.stringify({ secret: auth, tool: "browser_click", args: { tabId: 1, ref: "not_a_ref", javascript: "x" } }) + "\n", "{}\n{}\n", "x".repeat(140000) + "\n"]) assert.throws(() => assistantWorkerFrame(frame, auth));
  {
    const executor = new AssistantExecutor(dir, dir);
    const execution = { secret: auth, sockets: new Set(), stopped: false, terminal: false, calls: 0, queue: Promise.resolve() };
    executor.active = execution;
    let dispatched = 0, arrival;
    executor.dispatch = async (_execution, tool) => { dispatched++; arrival?.(); await delay(120); return { tool, received: true }; };
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\tabai-frame-${randomBytes(6).toString('hex')}` : join(dir, 'frame.sock');
    const server = net.createServer({ allowHalfOpen: true }, socket => executor.connection(execution, socket));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    const exchange = (parts, closed = false, afterFirst = Promise.resolve()) => new Promise((resolve, reject) => {
      const socket = net.createConnection(address); let text = '', ended = false;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('framed request did not finish')); }, 3000);
      socket.setEncoding('utf8');
      socket.on('connect', () => { void (async () => { for (let i = 0; i < parts.length; i++) { if (i) await afterFirst; if (socket.destroyed) break; socket.write(parts[i]); await delay(10); } })().catch(reject); });
      socket.on('data', chunk => { text += chunk; });
      socket.on('end', () => { ended = true; clearTimeout(timer); if (!text && closed) resolve(undefined); else { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } } });
      socket.on('error', error => { clearTimeout(timer); if (closed) resolve(undefined); else reject(error); });
      socket.on('close', () => { clearTimeout(timer); if (!ended) { if (closed) resolve(undefined); else reject(new Error('response closed prematurely')); } });
    });
    const frame = JSON.stringify({ secret: auth, tool: 'workflow_context', args: {} }) + '\n';
    try {
      assert.deepEqual(await exchange([frame.slice(0, 25), frame.slice(25)]), { ok: true, result: { tool: 'workflow_context', received: true } }, 'fragmented frame receives delayed reply without client half-close');
      assert.equal(dispatched, 1);
      const denied = await exchange([frame.replace(auth, 'wrong')]); assert.equal(denied.ok, false); assert.equal(dispatched, 1);
      await exchange(['x'.repeat(140000) + '\n'], true); assert.equal(dispatched, 1, 'oversized input never dispatches');
      await exchange([frame + frame], true); assert.equal(dispatched, 1, 'multiple frames in one request are rejected');
      const started = new Promise(resolve => { arrival = resolve; });
      await exchange([frame, frame], false, started); arrival = undefined;
      assert.equal(dispatched, 2, 'a later frame cannot replay an already queued action');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const client = new Client({ name: 'assistant-framing-test', version: '1' });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dir, 'assistant-worker.mjs')], env: { TABAI_ASSISTANT_SOCKET: address, TABAI_ASSISTANT_SECRET: auth }, stderr: 'ignore' }));
        const reply = await client.callTool({ name: 'workflow_context', arguments: {} });
        assert.notEqual(reply.isError, true); assert.equal(JSON.parse(reply.content[0].text).received, true, 'actual worker receives a reply delayed beyond the Windows pipe shutdown interval');
        assert.equal(dispatched, 3);
        executor.dispatch = async () => { for (const socket of execution.sockets) socket.destroy(); return {}; };
        const closed = await client.callTool({ name: 'workflow_context', arguments: {} }, undefined, { timeout: 2000 });
        assert.equal(closed.isError, true); assert.match(closed.content[0].text, /stängdes innan svaret/);
      } finally { await client.close(); }
    } finally {
      for (const socket of execution.sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve)); executor.active = undefined; await executor.close();
    }
  }
  const args = assistantCodexArgs(resolve("."), join(dir, "empty"));
  assert(args.includes('model="gpt-6.1-terra"')); assert(args.includes('model_reasoning_effort="medium"'));
  const selectedArgs = assistantCodexArgs(resolve('.'), join(dir, 'empty'), { model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  assert(selectedArgs.includes('model="gpt-6.1-sol"')); assert(selectedArgs.includes('model_reasoning_effort="high"'));
  for (const flag of ["--no-daemon", "--strict-config", "--ignore-user-config", "--ignore-rules", "--ephemeral"]) assert(args.includes(flag));
  assert(args.includes("features.shell_tool=false")); assert(args.includes("features.unified_exec=false"));
  assert(args.includes("features.plugins=false")); assert(args.includes("features.hooks=false"));
  assert(args.includes("features.skip_host_skill_discovery=true"));
  {
    const now = new Date().toISOString();
    const saved = Array.from({ length: 100 }, (_, index) => ({ ...finding, id: `saved-${index}`, threadId: `gmail:thread-${index}`, messageId: `gmail:message-${index}`, revision: index, status: "open", updatedAt: now,
      summary: "😀".repeat(2000), draft: "SAVED_PRIVATE_DRAFT".repeat(600), sources: Array.from({ length: 6 }, () => ({ observationId: "x", quote: "😀".repeat(500) })) }));
    const context = { run: { id: "context-projection", task: "check-mail", label: "Test", status: "running", message: "", summary: "", startedAt: now, updatedAt: now, coverage: [], instructions: "Kontrollera alla öppna ärenden." },
      settings: { accounts: [account, { ...other, enabled: false }], lookbackDays: 30, followupDays: 7, timezone: "Europe/Stockholm", tone: "Saklig", autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: "" },
      lastChecks: { "check-mail:work": now, "check-mail:other": now, ["x".repeat(5000) + ":work"]: now }, items: saved,
      answers: Array.from({ length: 30 }, () => ({ question: "😀".repeat(2000), answer: "😀".repeat(3000) })) };
    const projected = assistantWorkerContext(context, []), bytes = JSON.stringify(projected);
    assert(Buffer.byteLength(JSON.stringify(context)) > 2 * 1024 * 1024, "the fixture exceeds the worker wire ceiling before projection");
    assert(Buffer.byteLength(bytes) < 1500000);
    assert(!bytes.includes("SAVED_PRIVATE_DRAFT"));
    assert.equal(projected.knownItems.length, 100, "all unresolved identities survive compact context");
    assert(projected.items.every(item => !("draft" in item) && !("sources" in item) && item.summary.length <= 600));
    assert(projected.answersIncomplete);
    assert.deepEqual(Object.keys(projected.lastChecks), ["check-mail:work"]);
    const pages = [];
    for (let offset = 0; offset < 100; offset += 20) pages.push(...assistantItemPage(context, offset, 20).items);
    assert.equal(new Set(pages.map(item => item.id)).size, 100);
    const scoped = assistantWorkerContext({ ...context, run: { ...context.run, accountId: account.id, threadId: "gmail:thread-7" } }, []);
    assert.deepEqual(scoped.items.map(item => item.id), ["saved-7"]);
  }
  {
    const executor = new AssistantExecutor(dir, dir), workDir = join(dir, "cleanup-work"), socketDir = join(dir, "cleanup-socket");
    mkdirSync(workDir); mkdirSync(socketDir);
    let exits = 0;
    const execution = { terminal: false, stopped: false, sockets: new Set([{ destroy() { throw new Error("fixture socket failure"); } }]),
      server: { listening: true, close(callback) { callback(new Error("fixture close failure")); } },
      browser: { async close() { throw new Error("fixture browser teardown failure"); } }, workDir, socketDir,
      callbacks: { async exit(message) { assert.equal(message, "original execution failure"); exits++; } } };
    executor.active = execution;
    await executor.failed(execution, "original execution failure");
    assert.equal(exits, 1, "exit state is reported despite multiple teardown failures");
    assert.equal(executor.active, undefined, "cleanup failure cannot leave the executor active");
    assert(!existsSync(workDir) && !existsSync(socketDir), "later cleanup steps still run after earlier failures");
    await executor.close();
  }

  if (process.argv.includes("--cli-smoke")) {
    // This optional probe uses real Codex auth, but an in-memory host that
    // refuses ALL browser requests. There is no route to any user's mailbox.
    const work = join(dir, "smoke-work"); mkdirSync(work, { mode: 0o700 });
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\ta-smoke-${randomBytes(6).toString("hex")}` : join(dir, "s");
    const secret = randomBytes(32).toString("hex"), toolCalls = [], sockets = new Set();
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    const smokeContext = { run: { task: "custom", instructions: "Isolerat konfigurationsprov. Använd endast workflow_context och workflow_finish. Inga browser-verktyg får anropas. Avsluta med summary Konfigurationsprov klart, findings: [], coverage: [{accountId: work, status: unsupported, message: Isolerat prov utan kontoåtkomst}]." }, settings: { accounts: [account] }, items: [], answers: [], lastChecks: {} };
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.setEncoding("utf8"); let frame = "", dispatched = false;
      socket.on("data", chunk => { frame += chunk; if (frame.length > 140000) socket.destroy(); else if (frame.includes("\n")) dispatch(); });
      socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
      const dispatch = () => {
        if (dispatched) return; dispatched = true;
        try {
          const { tool, args } = assistantWorkerFrame(frame, secret); toolCalls.push(tool);
          let result;
          if (tool === "workflow_context") result = smokeContext;
          else if (tool === "workflow_finish") { validateAssistantEvidence(args.result, [account], new Map()); result = { saved: true }; complete({ finished: true }); }
          else throw new Error("Det isolerade provet förbjuder alla browser- och skrivverktyg.");
          socket.end(JSON.stringify({ ok: true, result }));
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message })); }
      };
      socket.on("end", dispatch);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const cliArgs = assistantCodexArgs(dir, work);
    const workerConfig = cliArgs.findIndex(arg => arg.startsWith("mcp_servers.tabai_assistant.args="));
    cliArgs[workerConfig] = "mcp_servers.tabai_assistant.args=" + JSON.stringify([join(dir, "assistant-worker.mjs")]);
    const env = { TABAI_ASSISTANT_SOCKET: socketPath, TABAI_ASSISTANT_SECRET: secret };
    for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "CODEX_HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawn("codex", cliArgs, { cwd: work, env, stdio: "pipe", detached: process.platform !== "win32", shell: false });
    let errors = "", events = "", timer;
    child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
    child.stdout.on("data", chunk => { events = (events + String(chunk)).slice(-12000); }); child.stdin.on("error", () => {});
    const exited = new Promise(resolve => { child.once("error", error => { complete({ error: error.message }); resolve(); }); child.once("exit", code => { complete({ exitCode: code }); resolve(); }); });
    child.stdin.end("Detta är ett säkert konfigurationsprov. Anropa workflow_context och följ instruktionen där. Inga browserverktyg får anropas. Svara endast genom workflow_finish.");
    try {
      const outcome = await Promise.race([completed, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 60000); })]);
      clearTimeout(timer);
      if (!outcome.finished) {
        console.log("CLI smoke config diagnostic:", errors.split("\n").filter(line => /unknown|unrecognized|invalid|error loading|failed to parse|mcp|tools/i.test(line)).join("\n").slice(0, 3000));
        console.log("CLI smoke event diagnostic:", events.slice(-6000));
      }
      assert(outcome.finished, `Real CLI did not finish: ${JSON.stringify(outcome)}`);
      assert.deepEqual(toolCalls, ["workflow_context", "workflow_finish"]);
      console.log("assistant-execution CLI smoke: real authenticated Codex, strict isolated config and MCP context/finish passed; browser requests were host-blocked");
    } finally {
      clearTimeout(timer);
      if (child.pid) {
        try { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {}); else process.kill(-child.pid, "SIGTERM"); } catch {}
        await Promise.race([exited, delay(2000)]);
        try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }

  if (process.argv.includes("--claude-smoke")) {
    // Optional probe with the real Claude Code CLI and the user's own login,
    // against an in-memory host that refuses ALL browser requests: there is no
    // route to any mailbox. It proves the isolated CLI contract end to end.
    const { assistantClaudeArgs, assistantClaudeEvent, assistantClaudeArtifacts, ASSISTANT_CLAUDE_ENV, ASSISTANT_CLAUDE_PASSED_ENV } = await import(pathToFileURL(join(dir, "assistant-agent.mjs")).href);
    const work = join(dir, "claude-smoke-work"); mkdirSync(work, { mode: 0o700 });
    // A large context result proves results stay inline (never spilled to a file the model cannot read).
    const marker = `KONTROLL-${randomBytes(3).toString("hex").toUpperCase()}`;
    const largeEvidence = `${"Syntetisk utfyllnad utan instruktioner. ".repeat(3000)}Slutmarkör: ${marker}`;
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\ta-claude-${randomBytes(6).toString("hex")}` : join(dir, "cs");
    const secret = randomBytes(32).toString("hex"), toolCalls = [], sockets = new Set();
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    const smokeContext = { run: { task: "custom", instructions: "Isolerat konfigurationsprov. Använd endast workflow_context och workflow_finish. Inga browser-verktyg får anropas. Avsluta med en summary som börjar med Konfigurationsprov klart och innehåller slutmarkören som står allra sist i fältet largeEvidence, findings: [], coverage: [{accountId: \"work\", status: \"login\", message: \"Inget konto lästes i provet.\"}]." }, settings: { accounts: [account] }, largeEvidence, now: new Date().toISOString() };
    let summary = "";
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      let frame = "", dispatched = false; sockets.add(socket); socket.setEncoding("utf8");
      socket.on("data", chunk => { frame += chunk; if (frame.includes("\n")) dispatch(); });
      socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
      const dispatch = () => {
        if (dispatched) return; dispatched = true;
        try {
          const { tool, args } = assistantWorkerFrame(frame, secret); toolCalls.push(tool);
          let result;
          if (tool === "workflow_context") result = smokeContext;
          else if (tool === "workflow_finish") { validateAssistantEvidence(args.result, [account], new Map()); summary = args.result.summary; result = { saved: true }; complete({ finished: true }); }
          else throw new Error("Det isolerade provet förbjuder alla browser- och skrivverktyg.");
          socket.end(JSON.stringify({ ok: true, result }));
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: error.message })); }
      };
      socket.on("end", dispatch);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const config = join(work, "tabai-mcp.json"), artifacts = assistantClaudeArtifacts(work);
    writeFileSync(config, JSON.stringify({ mcpServers: { tabai_assistant: { type: "stdio", command: process.execPath, args: [join(dir, "assistant-worker.mjs")], env: { TABAI_ASSISTANT_SOCKET: socketPath, TABAI_ASSISTANT_SECRET: secret } } } }), { mode: 0o600 });
    const env = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", ...ASSISTANT_CLAUDE_PASSED_ENV, "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, ASSISTANT_CLAUDE_ENV);
    const started = Date.now();
    const child = spawn("claude", assistantClaudeArgs(config), { cwd: work, env, stdio: "pipe", detached: process.platform !== "win32", shell: false });
    let errors = "", buffer = "", timer;
    const seen = [], received = [];
    child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk; let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line); seen.push(`${event.type}${event.subtype ? `/${event.subtype}` : ""}`);
          // What the model actually received for each tool result: size, marker, or a spilled-file reference.
          if (event.type === "user" && Array.isArray(event.message?.content)) for (const block of event.message.content) if (block?.type === "tool_result") {
            const text = JSON.stringify(block.content ?? "");
            received.push({ chars: text.length, marker: text.includes(marker), spilled: /tool-results|saved to|\.txt/i.test(text) && text.length < 20_000 });
          }
          const verdict = assistantClaudeEvent(event, { model: "claude-opus-5-5" }); if (verdict.violation || verdict.diagnostic) complete({ verdict });
        } catch { /* Only JSON events are read. */ }
      }
    });
    child.stdin.on("error", () => {});
    const exited = new Promise(resolve => { child.once("error", error => { complete({ error: error.message }); resolve(); }); child.once("exit", code => { complete({ exitCode: code }); resolve(); }); });
    child.stdin.end("Detta är ett säkert konfigurationsprov. Anropa workflow_context och följ instruktionen där. Inga browserverktyg får anropas. Svara endast genom workflow_finish.");
    try {
      const outcome = await Promise.race([completed, new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), 180000); })]);
      clearTimeout(timer);
      if (!outcome.finished) console.log("Claude smoke diagnostic:", JSON.stringify(outcome), seen.slice(-12).join(" "), errors.slice(-1500));
      assert(outcome.finished, `Real Claude CLI did not finish: ${JSON.stringify(outcome)}`);
      assert.deepEqual(toolCalls, ["workflow_context", "workflow_finish"]);
      assert(seen.includes("system/init"), "the stream reports its isolated init");
      assert(received.some(entry => entry.marker && !entry.spilled), `the large result reached the model inline, to its last line: ${JSON.stringify(received)}`);
      if (!summary.includes(marker)) console.log("Claude smoke note: the model received the marker but did not quote it in its summary.");
      assert(!existsSync(join(artifacts[0], "tool-results")) && !existsSync(join(artifacts[0], "memory")), "no spilled tool results and no auto-memory for the run");
      console.log(`assistant-execution Claude smoke: real authenticated Claude Code, isolated CLI and MCP context/finish passed in ${Math.round((Date.now() - started) / 1000)} s; browser requests were host-blocked`);
    } finally {
      clearTimeout(timer);
      if (child.pid) {
        try { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {}); else process.kill(-child.pid, "SIGTERM"); } catch {}
        await Promise.race([exited, delay(2000)]);
        try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      for (const folder of artifacts) rmSync(folder, { recursive: true, force: true });
    }
  }

  const fixture = approved => {
    const browser = new AssistantBrowser(dir, dir, approved, observation.messageId);
    const calls = [];
    browser.owned = async () => ({ account, url });
    browser.read = async () => ({ sourceId: threadId, messageId: observation.messageId, text: `Original thread from ${finding.recipient}` });
    browser.script = async (_tabId, fn) => fn.name === "composerScript" ? structuredClone(composer) : "";
    browser.call = async (name, value) => { calls.push({ name, value }); return name === "resolve_target" ? { ref: "ref_12", documentId: "doc-one" } : {}; };
    return { browser, calls };
  };
  let sends = 0;
  {
    const { browser, calls } = fixture();
    await assert.rejects(() => browser.send(1, async () => {}, async () => {}), /godkännande/);
    assert.equal(calls.length, 0);
    await browser.close();
  }
  {
    const { browser, calls } = fixture(approval);
    browser.read = async () => ({ sourceId: threadId, messageId: "gmail:message:changed-after-approval", text: `New thread message from ${finding.recipient}` });
    await assert.rejects(() => browser.send(1, async () => {}, async () => {}), /tråden ändrats/);
    assert.equal(calls.filter(item => item.name === "computer").length, 0);
    await browser.close();
  }
  {
    const { browser, calls } = fixture(approval);
    await assert.rejects(() => browser.send(1, async () => { throw new Error("stale approval"); }, async () => {}), /stale approval/);
    assert.equal(calls.filter(item => item.name === "computer").length, 0, "a rejected durable intent cannot dispatch");
    await assert.rejects(() => browser.send(1, async () => {}, async () => {}), /redan/);
    await browser.close();
  }
  {
    const { browser, calls } = fixture(approval);
    browser.call = async (name, value) => {
      calls.push({ name, value });
      if (name === "computer") { sends++; throw new Error("ambiguous transport failure"); }
      return name === "resolve_target" ? { ref: "ref_12", documentId: "doc-one" } : {};
    };
    let persisted = false;
    await assert.rejects(() => browser.send(1, async () => { persisted = true; }, async () => {}), /ambiguous/);
    assert(persisted); assert.equal(sends, 1);
    await assert.rejects(() => browser.send(1, async () => {}, async () => {}), /redan/);
    assert.equal(sends, 1, "an ambiguous dispatch is never replayed");
    await browser.close();
  }
  {
    const { browser, calls } = fixture(approval);
    let persisted = false, receipt;
    browser.script = async (_tabId, fn) => fn.name === "composerScript" ? structuredClone(composer) : calls.some(item => item.name === "computer") ? "Message sent" : "";
    const originalCall = browser.call;
    browser.call = async (name, value) => { if (name === "computer") assert(persisted, "intent must be durable before dispatch"); return originalCall(name, value); };
    await browser.send(1, async () => { persisted = true; }, async value => { receipt = value; });
    assert.match(receipt, /Message sent/);
    assert.equal(calls.filter(item => item.name === "computer").length, 1);
    await assert.rejects(() => browser.send(1, async () => {}, async () => {}), /redan/);
    await browser.close();
  }
  // The reply box is read again once the intent is saved: a box that changed in between, in its
  // text or in its send button, is not clicked, and the used attempt is never made again.
  for (const [why, changed, refusal] of [["another text", { body: "Ändrad text." }, /^Error: Svaret avviker från godkännandet/], ["another send button", { sendRef: "ref_13" }, /^Error: Svaret ändrades efter kontrollen/]]) {
    const { browser, calls } = fixture(approval);
    let intents = 0, receipts = 0;
    browser.script = async (_tabId, fn) => fn.name === "composerScript" ? structuredClone(intents ? { ...composer, ...changed } : composer) : "";
    await assert.rejects(() => browser.send(1, async () => { intents++; }, async () => { receipts++; }), refusal, why);
    assert.deepEqual([intents, receipts, calls.filter(item => item.name === "computer").length], [1, 0, 0], `${why}: the intent is saved and nothing is clicked`);
    await assert.rejects(() => browser.send(1, async () => {}, async () => {}), /redan/, `${why}: never a second attempt`);
    await browser.close();
  }
  {
    // A sent notice already on the page before the click belongs to an earlier send: no intent, no click, no receipt.
    const { browser, calls } = fixture(approval);
    let intents = 0, receipts = 0;
    browser.script = async (_tabId, fn) => fn.name === "composerScript" ? structuredClone(composer) : "Message sent";
    await assert.rejects(() => browser.send(1, async () => { intents++; }, async () => { receipts++; }), /^Error: Ett tidigare skickat-kvitto syns redan\./);
    assert.deepEqual([intents, receipts, calls.filter(item => item.name === "computer").length], [0, 0, 0]);
    await browser.close();
  }

  // POSIX process-group cleanup uses an isolated fake codex executable. It also
  // proves start/stop never wait for callbacks queued by the controlling module.
  if (process.platform !== "win32") {
    const bin = join(dir, "bin"); mkdirSync(bin);
    const marker = join(bin, "helper-exited");
    writeFileSync(join(bin, "codex"), `#!/usr/bin/env node\n` + String.raw`
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const marker = path.join(__dirname, 'helper-exited');
const helper = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{require("node:fs").writeFileSync(process.argv[1],"done");process.exit(0)});process.stdout.write("ready");setInterval(()=>{},1000)', marker], {stdio:['ignore','pipe','ignore']});
const helperReady = new Promise(resolve=>helper.stdout.once('data',resolve));
process.on('SIGTERM',()=>{helper.once('exit',()=>process.exit(0));setTimeout(()=>process.exit(0),1000)});
fs.writeFileSync(path.join(__dirname,'pid'), String(process.pid));
fs.writeFileSync(path.join(__dirname,'helper-pid'), String(helper.pid));
const request = (tool,args) => new Promise((resolve,reject)=>{
  const socket = net.createConnection(process.env.TABAI_ASSISTANT_SOCKET);
  let buffer='';socket.setEncoding('utf8');socket.on('error',reject);
  socket.on('connect',()=>socket.write(JSON.stringify({secret:process.env.TABAI_ASSISTANT_SECRET,tool,args})+'\n'));
  socket.on('data',chunk=>buffer+=chunk);socket.on('end',()=>{try{resolve(JSON.parse(buffer))}catch(e){reject(e)}});
});
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',async()=>{
  fs.writeFileSync(path.join(__dirname,'prompt.txt'),prompt);
  await helperReady;
  const context = (await request('workflow_context',{})).result;
  if(context.run.instructions==='wait') await request('workflow_progress',{message:'Väntar i isolerat test'});
  else if(context.run.instructions==='question') await request('workflow_question',{question:'Vilket möte?',accountId:'work'});
  else await request('workflow_finish',{result:{summary:'Inget konto läst i testet.',findings:[],coverage:[{accountId:'work',status:'login',message:'Logga in manuellt.'}]}});
});
setInterval(()=>{},1000);
`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = bin + ":" + previousPath;
    const runContext = mode => ({ run: { id: "test-run", task: "check-mail", label: "Test", status: "running", message: "", summary: "", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), coverage: [], instructions: mode }, settings: { accounts: [account], lookbackDays: 30, followupDays: 7, timezone: "Europe/Stockholm", tone: "Saklig", autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: "" }, lastChecks: {}, items: [], answers: [] });
    const running = pid => {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return false; throw error; }
      try { return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z"); }
      catch (error) { if (error.status === 1) return false; throw error; }
    };
    try {
      for (const mode of ["finish", "question", "wait"]) {
        rmSync(marker, { force: true });
        let observed, release;
        const reached = new Promise(resolve => { release = resolve; });
        const callbacks = { update: async () => { observed = "wait"; release(); await new Promise(() => {}); }, question: async () => { observed = "question"; release(); }, finish: async () => { observed = "finish"; release(); }, sendIntent: async () => { throw new Error("test forbids send"); }, sent: async () => { throw new Error("test forbids send"); }, exit: async message => { throw new Error(message); } };
        const dataDir = join(dir, `state-${mode}`), executor = new AssistantExecutor(resolve("."), dataDir);
        let helperPid;
        try {
          const context = runContext(mode);
          if (mode === 'finish') { context.run.learnMail = true; context.settings.web = { fullAccess: true, level: 'off', login: false }; }
          await executor.start(context, callbacks);
          await Promise.race([reached, delay(5000).then(() => { throw new Error(`No ${mode} callback`); })]);
          helperPid = Number(readFileSync(join(bin, "helper-pid"), "utf8"));
          assert.equal(observed, mode);
          if (mode === 'finish') assert.match(readFileSync(join(bin, 'prompt.txt'), 'utf8'), /Börja med workflow_context\. Detta mejluppdrag lär in/);
          await executor.stop(); await executor.close();
          // A SIGTERM marker proves only graceful handler execution. SIGKILL is
          // a valid cleanup escalation, so observe the actual owned process.
          for (let i = 0; i < 40 && running(helperPid); i++) await delay(50);
          assert.equal(running(helperPid), false, `${mode}: no runnable helper may survive process-group cleanup`);
          assert.deepEqual(readdirSync(dataDir).filter(name => name.startsWith("worker-")), [], "socket and empty work directory are removed");
          const pid = Number(readFileSync(join(bin, "pid"), "utf8"));
          assert.throws(() => process.kill(pid, 0), /ESRCH/, "the owned Codex process exited");
          await assert.rejects(() => executor.start(runContext(mode), callbacks), /stängts/);
        } finally {
          await executor.close();
          // The optional fault-injection run must not leak its intentional survivor.
          if (helperPid && running(helperPid)) try { process.kill(helperPid, "SIGKILL"); } catch {}
        }
      }
      for (const mode of ["finish", "question"]) {
        const executor = new AssistantExecutor(resolve("."), join(dir, `restart-state-${mode}`));
        const previousWork = join(dir, `restart-previous-${mode}`); mkdirSync(previousWork);
        let terminalCallbacks = 0, releaseTeardown, signalTeardown, signalNextReady;
        const teardownAllowed = new Promise(resolve => { releaseTeardown = resolve; });
        const teardownEntered = new Promise(resolve => { signalTeardown = resolve; });
        const nextReady = new Promise(resolve => { signalNextReady = resolve; });
        const callbacks = { update: async () => { signalNextReady(); }, question: async () => { terminalCallbacks++; }, finish: async () => { terminalCallbacks++; }, sendIntent: async () => { throw new Error("send forbidden"); }, sent: async () => { throw new Error("send forbidden"); }, exit: async message => { throw new Error(message); } };
        const previous = { context: runContext(mode), callbacks, browser: new AssistantBrowser(dir, dir), server: { listening: false }, sockets: new Set(),
          exited: Promise.resolve(), terminal: false, stopped: false, workDir: previousWork };
        executor.active = previous;
        const actualCleanup = executor.cleanup.bind(executor);
        let teardownFinished = false;
        executor.cleanup = async execution => {
          if (execution === previous) { signalTeardown(); await teardownAllowed; }
          await actualCleanup(execution);
          if (execution === previous) teardownFinished = true;
        };
        let launching;
        try {
          await assert.rejects(() => executor.start(runContext("wait"), callbacks), /arbetar redan/, "truly active work still rejects a second start");
          if (mode === "finish") await executor.dispatch(previous, "workflow_finish", { result: { summary: "Slutfört", findings: [], coverage: [{ accountId: "work", status: "login", message: "Manuell inloggning behövs" }] } });
          else await executor.dispatch(previous, "workflow_question", { question: "Vilket möte?", accountId: "work" });
          assert.equal(terminalCallbacks, 1); assert.equal(previous.terminal, true);
          launching = executor.start(runContext("wait"), callbacks);
          // The barrier, rather than a sleep, proves no next child can launch
          // between the persisted terminal callback and completed teardown.
          await Promise.race([teardownEntered, launching.then(() => { throw new Error("next launch skipped teardown"); }), delay(5000).then(() => { throw new Error("terminal cleanup was not entered"); })]);
          assert.equal(executor.active, previous); assert.equal(previous.child, undefined); assert.equal(teardownFinished, false);
          releaseTeardown();
          await launching;
          assert.equal(teardownFinished, true);
          assert.notEqual(executor.active, previous); assert(executor.active.child?.pid, "the next process launches only after previous teardown");
          await Promise.race([nextReady, delay(5000).then(() => { throw new Error("next job did not reach its worker"); })]);
        } finally {
          releaseTeardown();
          await launching?.catch(() => {});
          await executor.close();
        }
      }
      // Beats only note a sleep: a run survives a short one, and if it then ends it says why.
      {
        const executor = new AssistantExecutor(resolve("."), join(dir, "sleep-state"));
        executor.runBeatMs = 10;
        let reached, ended;
        const waiting = new Promise(resolve => { reached = resolve; }), exited = new Promise(resolve => { ended = resolve; });
        const forbidden = async () => { throw new Error("test forbids this outcome"); };
        const callbacks = { update: async () => { reached(); }, question: forbidden, finish: forbidden, sendIntent: forbidden, sent: forbidden, exit: async (message, failure) => { ended({ message, failure }); } };
        const realNow = Date.now;
        try {
          await executor.start(runContext("wait"), callbacks);
          await Promise.race([waiting, delay(5000).then(() => { throw new Error("No wait callback"); })]);
          const running = executor.active, before = running.beatAt;
          await delay(80);
          assert(running.beatAt > before, "beats on time move on");
          assert.equal(running.wokeAt, undefined, "and find no sleep");
          Date.now = () => realNow() + 2 * 60_000;
          for (let i = 0; i < 400 && running.wokeAt === undefined; i++) await delay(5);
          assert(running.wokeAt, "a late beat finds the sleep");
          assert.equal(running.terminal, false, "a short sleep does not end the run");
          await executor.failed(running, "Uppdragets tidsgräns nåddes.", "run");
          assert.deepEqual(await exited, { message: "Datorn gick i viloläge och körningen avbröts. Det som hann sparas finns kvar.", failure: "disconnected" });
          const last = running.beatAt;
          await delay(60);
          assert.equal(running.beatAt, last, "the beat stops with the run");
        } finally { Date.now = realNow; await executor.close(); }
      }
    } finally { process.env.PATH = previousPath; }
  } else console.log("SKIP assistant-execution: worker process-group cleanup, teardown before the next launch and sleep detection use a POSIX fake codex and do not run on Windows");


  // Claude backend: an isolated fake `claude` executable records the exact CLI
  // contract, reaches the host only with the socket secret from its private MCP
  // config file, and a tool outside the assistant's own ends the run.
  if (process.platform !== "win32") {
    const { assistantClaudeArgs, assistantClaudeEvent, ASSISTANT_CLAUDE_TOOL_PREFIX, ASSISTANT_CLAUDE_ENV } = await import(pathToFileURL(join(dir, "assistant-agent.mjs")).href);
    const bin = join(dir, "claude-bin"); mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\n` + String.raw`
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const config = argv[argv.indexOf('--mcp-config') + 1];
const server = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.tabai_assistant;
fs.writeFileSync(path.join(__dirname, 'record.json'), JSON.stringify({ argv, cwd: process.cwd(), configMode: fs.statSync(config).mode & 0o777,
  secretInEnv: !!process.env.TABAI_ASSISTANT_SECRET || !!process.env.TABAI_ASSISTANT_SOCKET, workerArgs: server.args,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(MAX_MCP|ENABLE_MCP|CLAUDE_CODE_)/.test(key))) }));
// Like the real CLI, keep per-working-directory folders under the user's home.
const slug = fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
for (const folder of [path.join(process.env.HOME, '.claude', 'projects', slug, 'memory'), process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Caches', 'claude-cli-nodejs', slug, 'mcp-logs') : path.join(process.env.HOME, '.cache', 'claude-cli-nodejs', slug, 'mcp-logs')])
  fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(__dirname, 'folders.json'), JSON.stringify(slug));
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const request = (tool,args) => new Promise((resolve,reject)=>{
  const socket = net.createConnection(server.env.TABAI_ASSISTANT_SOCKET);
  let buffer='';socket.setEncoding('utf8');socket.on('error',reject);
  socket.on('connect',()=>socket.write(JSON.stringify({secret:server.env.TABAI_ASSISTANT_SECRET,tool,args})+'\n'));
  socket.on('data',chunk=>buffer+=chunk);socket.on('end',()=>{try{resolve(JSON.parse(buffer))}catch(e){reject(e)}});
});
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',async()=>{
  emit({type:'system',subtype:'init',tools:['mcp__tabai_assistant__workflow_context','mcp__tabai_assistant__workflow_finish'],mcp_servers:[{name:'tabai_assistant',status:'connected'}]});
  const context = (await request('workflow_context',{})).result;
  fs.writeFileSync(path.join(__dirname,'prompt.txt'), prompt);
  if(context.run.instructions==='violation'){ emit({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'id'}}]}}); setInterval(()=>{},1000); return; }
  await request('workflow_finish',{result:{summary:'Inget konto läst i testet.',findings:[],coverage:[{accountId:'work',status:'login',message:'Logga in manuellt.'}]}});
  emit({type:'result',subtype:'success',is_error:false,result:'klart'});
});
`, { mode: 0o700 });
    const previousPath = process.env.PATH, previousHome = process.env.HOME, previousCache = process.env.XDG_CACHE_HOME, previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const fakeHome = join(dir, "claude-home"); mkdirSync(fakeHome);
    process.env.PATH = bin + ":" + previousPath; process.env.HOME = fakeHome; delete process.env.XDG_CACHE_HOME; delete process.env.CLAUDE_CONFIG_DIR;
    const claudeContext = mode => ({ run: { id: "claude-run", task: "check-mail", label: "Test", status: "running", message: "", summary: "", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), coverage: [], instructions: mode },
      settings: { accounts: [account], lookbackDays: 30, followupDays: 7, timezone: "Europe/Stockholm", tone: "Saklig", autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: "",
        agent: { backend: "claude", codex: { model: "gpt-6.1-terra", reasoningEffort: "medium" }, claude: { model: "claude-sonnet-5-5", effort: "high" }, local: { model: "qwen3.5:4b-q4_K_M" } } }, lastChecks: {}, items: [], answers: [] });
    try {
      for (const mode of ["finish", "violation"]) {
        let outcome, release;
        const reached = new Promise(resolve => { release = resolve; });
        const callbacks = { update: async () => {}, question: async () => { outcome = "question"; release(); }, finish: async () => { outcome = "finish"; release(); },
          sendIntent: async () => { throw new Error("test forbids send"); }, sent: async () => { throw new Error("test forbids send"); },
          exit: async message => { outcome = message ?? "exit"; release(); }, activity: async () => {}, checkpoint: async () => {} };
        const dataDir = join(dir, `claude-state-${mode}`), executor = new AssistantExecutor(resolve("."), dataDir);
        try {
          await executor.start(claudeContext(mode), callbacks);
          await Promise.race([reached, delay(8000).then(() => { throw new Error(`No ${mode} outcome from the Claude backend`); })]);
          const record = JSON.parse(readFileSync(join(bin, "record.json"), "utf8"));
          const expected = assistantClaudeArgs(record.argv[record.argv.indexOf("--mcp-config") + 1], { model: "claude-sonnet-5-5", effort: "high" });
          assert.deepEqual(record.argv, expected, "the CLI receives exactly the isolated contract");
          for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert(record.argv.includes(flag), flag);
          assert.equal(record.argv[record.argv.indexOf("--tools") + 1], "", "no built-in tools");
          assert.equal(record.argv[record.argv.indexOf("--setting-sources") + 1], "", "no user, project or local settings");
          assert.equal(record.argv[record.argv.indexOf("--permission-mode") + 1], "dontAsk");
          assert(record.argv[record.argv.indexOf("--allowedTools") + 1].split(",").every(name => name.startsWith(ASSISTANT_CLAUDE_TOOL_PREFIX)), "only the assistant's tools are allowed");
          assert(!record.argv.some(arg => /[0-9a-f]{64}/.test(arg)), "the socket secret is never a command-line argument");
          assert.equal(record.secretInEnv, false, "the socket and secret reach the worker only through the private config file");
          assert.equal(record.configMode, 0o600, "the config file is readable only by its owner");
          assert(record.workerArgs[0].endsWith("assistant-worker.mjs"));
          assert.deepEqual(record.env, { ...ASSISTANT_CLAUDE_ENV }, "results stay in memory, auto-memory, advisor and nonessential traffic are off");
          assert.equal(JSON.parse(record.argv[record.argv.indexOf("--settings") + 1]).disableAllHooks, true, "every hook is off");
          if (mode === "finish") {
            assert.equal(outcome, "finish");
            assert(readFileSync(join(bin, "prompt.txt"), "utf8").startsWith("Du är Tabais"), "the unchanged shared prompt arrives on stdin");
          } else assert.match(String(outcome), /utanför assistentens tillåtna uppdrag/, "a tool outside the assistant's own ends the run");
          await executor.stop(); await executor.close();
          assert.deepEqual(readdirSync(dataDir).filter(name => name.startsWith("worker-")), [], "the work directory and its config file are removed");
          const slug = JSON.parse(readFileSync(join(bin, "folders.json"), "utf8"));
          assert(!existsSync(join(fakeHome, ".claude", "projects", slug)), "the CLI's project folder for the run is removed");
          assert(!existsSync(process.platform === "darwin" ? join(fakeHome, "Library", "Caches", "claude-cli-nodejs", slug) : join(fakeHome, ".cache", "claude-cli-nodejs", slug)), "the CLI's log folder for the run is removed");
        } finally { await executor.close(); }
      }
      // Stream events: login and usage failures become actionable messages.
      assert.match(assistantClaudeEvent({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }).diagnostic, /loggas in/);
      assert.match(assistantClaudeEvent({ type: "result", is_error: true, result: "Usage limit reached" }).diagnostic, /användningsgräns/);
      assert.match(assistantClaudeEvent({ type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "tabai_assistant", status: "failed" }] }).violation, /kunde inte ansluta/);
      assert.match(assistantClaudeEvent({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [{ name: "tabai_assistant", status: "connected" }] }).violation, /utanför/);
      assert.deepEqual(assistantClaudeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: `${ASSISTANT_CLAUDE_TOOL_PREFIX}browser_read` }] } }), {});
      const init = { type: "system", subtype: "init", tools: [`${ASSISTANT_CLAUDE_TOOL_PREFIX}workflow_context`], mcp_servers: [{ name: "tabai_assistant", status: "connected" }], model: "claude-opus-5-5", permissionMode: "dontAsk", skills: [],
        plugins: [{ name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" }] };
      assert.deepEqual(assistantClaudeEvent(init, { model: "claude-opus-5-5" }), {}, "the isolated init with built-in plugins passes");
      for (const [change, label] of [[{ mcp_servers: [...init.mcp_servers, { name: "gmail", status: "connected" }] }, "another MCP server"], [{ plugins: [{ name: "x", path: "/tmp/x", source: "x@market" }] }, "a non-built-in plugin"],
        [{ skills: ["anything"] }, "skills"], [{ permissionMode: "bypassPermissions" }, "another permission mode"], [{ model: "claude-haiku-5-5" }, "another model"]])
        assert(assistantClaudeEvent({ ...init, ...change }, { model: "claude-opus-5-5" }).violation, label);
      assert(assistantClaudeEvent({ type: "assistant", message: { content: [{ type: "server_tool_use", name: "advisor" }] } }).violation, "server tool use");
      assert.match(assistantClaudeEvent({ type: "assistant", message: { content: [], error: "authentication_failed" } }).diagnostic, /loggas in/);
      assert.match(assistantClaudeEvent({ type: "result", is_error: true, result: "Response exceeded max_tokens" }).diagnostic, /rapporterade ett fel/, "a token-limit text is not a login failure");
      console.log("assistant-execution Claude backend: isolated CLI contract, private MCP config, finish and tool violation passed");
    } finally {
      process.env.PATH = previousPath; process.env.HOME = previousHome;
      if (previousCache !== undefined) process.env.XDG_CACHE_HOME = previousCache;
      if (previousConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = previousConfig;
    }
  } else console.log("SKIP assistant-execution: the Claude backend contract uses a POSIX fake claude and does not run on Windows");

  // Local inference seam: the real runner bundle drives the real MCP worker and
  // host socket while a loopback fixture plays Ollama. Only this test copy of the
  // runner points at the fixture port; production code has one fixed endpoint.
  {
    const http = await import("node:http");
    const { ASSISTANT_PROMPT, assistantLocalFailure } = await import(pathToFileURL(join(dir, "assistant-agent.mjs")).href);
    const model = "qwen3.5:4b-q4_K_M";
    const digests = { [model]: "d8b0f5e9760cd1682034f292d7ef72ec46f432149be0df7574bf2d6e92e38c04" };
    const fixture = { version: "0.40.13", digest: {}, chats: [], script: () => [], aborted: 0 };
    const server = http.createServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
      request.on("end", async () => {
        const send = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
        if (request.url === "/api/version") return fixture.version ? send({ version: fixture.version }) : request.socket.destroy();
        if (request.url === "/api/tags") return send({ models: Object.entries(digests).map(([name, digest]) => ({ name, model: name, digest: fixture.digest[name] ?? digest })) });
        if (request.url === "/api/show") { const { model } = JSON.parse(body); return send({ details: { family: "qwen35", quantization_level: "Q4_K_M" } }); }
        if (request.url !== "/api/chat") { response.writeHead(404); return response.end(); }
        const chat = JSON.parse(body); fixture.chats.push(chat);
        const reply = await fixture.script(chat, fixture.chats.length);
        if (reply === "hang") { response.writeHead(200); response.write(JSON.stringify({ message: { content: "" } }) + "\n"); response.on("close", () => { fixture.aborted++; }); return; }
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const event of reply) response.write(JSON.stringify(event) + "\n");
        response.end(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 }) + "\n");
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const localRoot = join(dir, "local-root"), localDist = join(localRoot, "dist");
    mkdirSync(localDist, { recursive: true });
    const runner = readFileSync(join(dir, "assistant-local-runner.mjs"), "utf8");
    assert.equal(runner.split("http://127.0.0.1:11434").length, 2, "the runner bundle has exactly one inference origin");
    writeFileSync(join(localDist, "assistant-local-runner-fixture.mjs"), runner.replace("http://127.0.0.1:11434", `http://127.0.0.1:${port}`));
    writeFileSync(join(localDist, "assistant-worker.mjs"), readFileSync(join(dir, "assistant-worker.mjs"), "utf8"));
    symlinkSync(resolve("node_modules"), join(localRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    // A Codex on PATH that only leaves a marker: local mode must never start it.
    const fakeBin = join(dir, "local-bin"), codexMarker = join(fakeBin, "codex-started");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, process.platform === "win32" ? "codex.cmd" : "codex"), process.platform === "win32" ? `@echo started> "${codexMarker}"\r\n` : `#!/bin/sh\necho started > "${codexMarker}"\n`, { mode: 0o700 });
    const savedPath = process.env.PATH;
    process.env.PATH = fakeBin + (process.platform === "win32" ? ";" : ":") + savedPath;
    const call = (name, args) => ({ function: { name, arguments: args } });
    const native = (...calls) => [{ message: { role: "assistant", content: "", tool_calls: calls } }];
    const intent = (action, tool, args, text = "") => [{ message: { role: "assistant", content: JSON.stringify({ action, tool, arguments: args, text }) } }];
    const finishArgs = { result: { summary: "Inget konto lästes i testet.", findings: [], coverage: [{ accountId: "work", status: "login", message: "Logga in manuellt." }] } };
    const settings = backend => ({ accounts: [account], lookbackDays: 30, followupDays: 7, timezone: "Europe/Stockholm", tone: "Saklig", autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: "",
      agent: { backend: "local", codex: { model: "gpt-6.1-sol", reasoningEffort: "high" }, local: { model: backend } } });
    const context = (model, extra = {}) => ({ run: { id: "local-run", task: "check-mail", label: "Lokal", status: "running", message: "", summary: "", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), coverage: [], instructions: "" },
      settings: settings(model), lastChecks: {}, items: [], answers: [],
      localVerifications: Object.entries(digests).map(([id, digest]) => ({ model: id, digest, ollamaVersion: "0.40.13", profile: "intent", verifiedAt: new Date().toISOString() })), ...extra });
    const scenario = async (name, profile, script, { expectExit, expectFinish, stopAfter, extra, dispatches } = {}) => {
      // Native remains a measured 4B variant. Only this fixture wrapper sets measurement;
      // an undefined profile exercises the production 4B intent default.
      writeFileSync(join(localDist, "assistant-local-runner.mjs"), `${profile ? `process.env.TABAI_LOCAL_CONFIG = JSON.stringify({...JSON.parse(process.env.TABAI_LOCAL_CONFIG), measurement: {profile: ${JSON.stringify(profile)}}});` : ''}
await import('./assistant-local-runner-fixture.mjs');
`);
      fixture.chats = []; fixture.aborted = 0; fixture.script = script;
      const outcome = { finish: 0, exit: undefined, updates: 0, calls: [] };
      let settle; const settled = new Promise(resolve => { settle = resolve; });
      const callbacks = { update: async () => { outcome.updates++; if (stopAfter === "update") settle(); }, question: async () => { settle(); }, finish: async () => { outcome.finish++; settle(); },
        sendIntent: async () => { throw new Error("test forbids send"); }, sent: async () => { throw new Error("test forbids send"); }, exit: async message => { outcome.exit = message; settle(); },
        activity: async () => {}, checkpoint: async () => {}, help: async () => { settle(); } };
      const executor = new AssistantExecutor(localRoot, join(dir, `local-state-${name}`));
      const dispatch = executor.dispatch.bind(executor);
      executor.dispatch = (execution, tool, args) => { outcome.calls.push(tool); return dispatch(execution, tool, args); };
      try {
        await executor.start(context(model, extra), callbacks);
        if (stopAfter === "chat") { for (let i = 0; i < 200 && !fixture.chats.length; i++) await delay(25); await delay(100); await executor.stop(); for (let i = 0; i < 80 && !fixture.aborted; i++) await delay(25); return outcome; }
        await Promise.race([settled, delay(20000).then(() => { throw new Error(`${name}: no terminal callback`); })]);
        if (stopAfter === "update") await executor.stop();
        for (let i = 0; i < 80 && executor.active; i++) await delay(25);
      } finally { await executor.close(); }
      if (expectFinish) assert.equal(outcome.finish, 1, `${name}: verified finish (${JSON.stringify(outcome)} chats=${fixture.chats.length})`);
      if (expectExit) assert.equal(outcome.exit, assistantLocalFailure(expectExit), `${name}: ${outcome.exit}`);
      if (dispatches) assert.deepEqual(outcome.calls, dispatches, `${name}: host dispatches`);
      return outcome;
    };
    try {
      // Measured native profile on 4B: same policy text as Codex, tools without format, verified finish.
      let outcome = await scenario("native", "native", (_chat, turn) => turn === 1 ? native(call("workflow_context", {})) : native(call("workflow_finish", finishArgs)), { expectFinish: true, dispatches: ["workflow_context", "workflow_finish"] });
      assert(fixture.chats[0].messages[0].content.startsWith(`${ASSISTANT_PROMPT}\n\n`), "the local system policy starts with the unchanged Codex prompt");
      assert.match(fixture.chats[0].messages[0].content, /Fyndtyper \(kind\)/, "local models also get the finding-kind guide");
      assert.equal(fixture.chats[0].messages.length, 2, "no status before the host has answered");
      assert(fixture.chats.every(chat => chat.tools?.length && !chat.format && chat.think === false && chat.model === model));
      assert.equal(fixture.chats[1].messages.at(-2).role, "tool", "the tool result returns to the model");
      assert.match(fixture.chats[1].messages.at(-1).content, /^Tabai-läge/, "a host status follows the result");
      assert.equal(fixture.chats[1].messages.length, 5, "the status of an earlier turn is not kept in the history");
      assert.equal(outcome.exit, undefined);
      // Intent profile: format without tools; host still dispatches only allowlisted calls.
      await scenario("intent", undefined, (_chat, turn) => turn === 1 ? intent("call", "workflow_context", {}) : intent("call", "workflow_finish", finishArgs), { expectFinish: true, dispatches: ["workflow_context", "workflow_finish"],
        extra: { localVerifications: [{ model: "qwen3.5:9b-q4_K_M", digest: "a".repeat(64), ollamaVersion: "0.40.13", profile: "intent", verifiedAt: new Date().toISOString() }] } });
      assert(fixture.chats.every(chat => chat.format && !chat.tools));
      assert(fixture.chats[0].messages[0].content.startsWith(ASSISTANT_PROMPT));
      assert.match(fixture.chats[1].messages.at(-2).content, /^TOOL_RESULT /);
      assert(fixture.chats[1].format.oneOf.some(branch => branch.properties.tool.enum[0] === "workflow_finish"), "the intent grammar is built from the host state");
      // Unknown tools, raw code and repeatedly invalid arguments never reach the host.
      await scenario("unknown-tool", "native", () => native(call("shell_exec", { command: "id" })), { expectExit: "protocol", dispatches: [] });
      await scenario("raw-code", undefined, () => [{ message: { content: "import os\nos.system('id')" } }], { expectExit: "protocol", dispatches: [] });
      await scenario("invalid-args", "native", () => native(call("workflow_items", { offset: 0, limit: 20, extra: true })), { expectExit: "protocol", dispatches: [] });
      assert.equal(fixture.chats.length, 4, "three corrections are allowed, the fourth invalid call stops the run");
      await scenario("loop", "native", () => native(call("workflow_items", { offset: 0, limit: 20 })), { expectExit: "loop", dispatches: ["workflow_items", "workflow_items", "workflow_items"] });
      await scenario("alternating-loop", "native", (_chat, turn) => native(turn % 2 ? call("workflow_items", { offset: 0, limit: 20 }) : call("workflow_context", {})),
        { expectExit: "loop", dispatches: ["workflow_items", "workflow_context", "workflow_items", "workflow_context", "workflow_items", "workflow_context", "workflow_items"] });
      assert(fixture.chats.length >= 4 && fixture.chats.every(chat => chat.messages.filter(message => message.content?.startsWith("Tabai-läge")).length <= 1 && !chat.messages.slice(0, -1).some(message => message.content?.startsWith("Tabai-läge"))), "only the newest status is sent; earlier ones never stay in the history");
      // A terminal call ends the batch: later calls in the same turn are never dispatched.
      await scenario("terminal-batch", "native", (_chat, turn) => turn === 1 ? native(call("workflow_context", {})) : native(call("workflow_finish", finishArgs), call("workflow_progress", { message: "sent efter slut" })), { expectFinish: true, dispatches: ["workflow_context", "workflow_finish"] });
      // Runtime identity is checked before any private context is requested.
      fixture.version = undefined;
      await scenario("offline", "native", () => native(call("workflow_context", {})), { expectExit: "unavailable", dispatches: [] });
      fixture.version = "0.40.13"; fixture.digest["qwen3.5:4b-q4_K_M"] = "0".repeat(64);
      await scenario("digest", "native", () => native(call("workflow_context", {})), { expectExit: "digest-mismatch", dispatches: [] });
      delete fixture.digest["qwen3.5:4b-q4_K_M"]; fixture.version = "99.1.0";
      await scenario("untested", "native", () => native(call("workflow_context", {})), { expectExit: "untested-version", dispatches: [] });
      assert.equal(fixture.chats.length, 0, "no inference request before the runtime is verified");
      await scenario("self-tested", "native", (_chat, turn) => turn === 1 ? native(call("workflow_context", {})) : native(call("workflow_finish", finishArgs)), { expectFinish: true,
        extra: { localVerifications: [{ model: "qwen3.5:4b-q4_K_M", digest: digests["qwen3.5:4b-q4_K_M"], ollamaVersion: "99.1.0", profile: "native", verifiedAt: new Date().toISOString() }] } });
      fixture.version = "0.40.13";
      // Stop during inference aborts the open request, kills the owned tree and admits no later call.
      outcome = await scenario("stop", "native", () => "hang", { stopAfter: "chat" });
      assert.equal(fixture.aborted, 1, "stop closed the in-flight inference request");
      assert.deepEqual(outcome.calls, []); assert.equal(outcome.exit, undefined, "a user stop is not reported as a failure");
      assert(!existsSync(codexMarker), "local mode never starts Codex");
    } finally {
      process.env.PATH = savedPath;
      await new Promise(resolve => server.close(resolve));
    }
  }
  // The summary names only what ran here: the POSIX-only blocks print their own skipped line on Windows.
  console.log(`assistant-execution: provider/account policy, native source evidence, authenticated frames, approved at-most-once sends${process.platform === "win32" ? "" : ", worker cleanup, the Claude backend"} and the local runner seam passed`);
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
