// Live web access in the launched browser: a local shop, a login page and a
// search page served on loopback. Tabai fills, stops before the purchase and
// clicks exactly once after approval; login off without incognito permission
// falls back honestly, and the card comes with a real image of the button
// and its form. A page that patches DOM prototypes cannot fool the
// host's isolated checks, nor can a page whose CSP allows no script at all,
// an empty DuckDuckGo page falls back to a Bing-like page, and a receipt PDF
// lands in the server's own store. "Hitta billigast" reads two loopback shops
// through the executor's own checks: a price the page does not show is refused,
// then the card, a watch card from it and no order. The assistant's own server gives
// no page a file from its private data directory, nor a directory at all. Runs under
// test/ci-harness.mjs with its CI ports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AssistantBrowser } from '../dist/assistant-browser.mjs';
import { AssistantWeb, ASSISTANT_WEB_BING_URL, ASSISTANT_WEB_SEARCH_URL } from '../dist/assistant-web.mjs';
import { AssistantExecutor } from '../dist/assistant-agent.mjs';
import { AssistantChat } from '../dist/assistant-chat.mjs';
import { watchdog } from './watchdog.mjs';

const port = 9239, base = `http://127.0.0.1:${port}`;
let orders = 0;
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, base);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.method === 'POST' && url.pathname === '/order') { orders++; response.end(page('Tack', '<h1>Tack för din order</h1>')); return; }
  if (url.pathname === '/shop') {
    response.end(page('Laddkabel – kassa', `<div role="dialog" id="cookie-consent"><p>Vi använder kakor.</p><button onclick="this.parentElement.remove()">Godkänn alla kakor</button></div>
      <h1>Laddkabel Typ 2</h1><form role="search" action="/shop"><input name="q" aria-label="Sök produkt"><button>Sök</button></form>
      <form method="post" action="/order"><label>Namn <input name="name"></label><p>Att betala 499 kr</p><button type="submit">Köp nu</button></form>
      <div class="checkout__consent cmp-container"><button type="button" onclick="fetch('/order',{method:'POST'})">Slutför köp</button></div>`));
    return;
  }
  if (url.pathname === '/login') {
    response.end(page('Logga in', '<form method="post" action="/order"><label>E-post <input name="user" type="email"></label><label>Lösenord <input name="pw" type="password"></label><button>Logga in</button></form>'));
    return;
  }
  if (url.pathname === '/app-login') {
    response.end(page('Logga in', '<div><label>E-post <input name="user" type="email"></label><label>Lösenord <input name="pw" type="password"></label><button type="button" onclick="fetch(\'/order\',{method:\'POST\'})">Logga in</button></div>'));
    return;
  }
  if (url.pathname === '/pay') {
    response.end(page('Betalning', '<label>Kortnummer <input autocomplete="cc-number" name="card"></label><button type="button" onclick="document.title=\'Debiterat\'">Fortsätt</button>'));
    return;
  }
  if (url.pathname === '/spoof') {
    // The page's own script makes every button read "Läs mer" and hides its form from closest() and .form.
    response.end(page('Kampanj', `<script>
      const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
      Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.tagName === 'BUTTON' ? 'Läs mer' : own.get.call(this); } });
      Element.prototype.closest = function () { return null; };
      Object.defineProperty(HTMLButtonElement.prototype, 'form', { configurable: true, get() { return null; } });
    </script><h1>Kampanj</h1><form method="post" action="/order"><p>Att betala 299 kr</p><button type="submit">Köp nu</button></form>`));
    return;
  }
  if (url.pathname === '/strict' || url.pathname === '/strict-login') {
    // No script may run on these pages, not even their own: only Tabai's isolated world reads them.
    response.setHeader('content-security-policy', "script-src 'none'");
    response.end(url.pathname === '/strict'
      ? page('Strikt kassa', `<script>document.title = 'Sidans skript körde'</script>
        <div role="dialog" id="cookie-consent"><p>Vi använder kakor.</p><button type="button">Godkänn alla kakor</button></div>
        <h1>Strikt kassa</h1><form method="post" action="/order"><p>Att betala 199 kr</p><button type="submit">Köp nu</button></form>`)
      : page('Strikt inloggning', '<form method="post" action="/order"><label>E-post <input name="user" type="email"></label><label>Lösenord <input name="pw" type="password"></label><button>Logga in</button></form>'));
    return;
  }
  // Two shops for "Hitta billigast"; the second one's address redirects to its product page.
  if (url.pathname === '/butik-a') { response.end(page('Laddkabel Typ 2 – Butik A', '<h1>Laddkabel Typ 2</h1><p>Pris 499 kr</p><p>Frakt 49 kr</p><form method="post" action="/order"><button type="submit">Köp nu</button></form>')); return; }
  if (url.pathname === '/butik-b') { response.statusCode = 302; response.setHeader('location', '/butik-b/vara'); response.end(); return; }
  if (url.pathname === '/butik-b/vara') { response.end(page('Laddkabel Typ 2 – Butik B', '<h1>Laddkabel Typ 2</h1><p>Pris 529 kr</p><p>Fri frakt</p><form method="post" action="/order"><button type="submit">Köp nu</button></form>')); return; }
  if (url.pathname === '/ddg-empty') { response.end(page('Sök', '<div class="no-results">Inga träffar</div>')); return; }
  if (url.pathname === '/upload') { response.end(page('Uppladdning', '<input type="file" id="one" aria-label="Enstaka fil"><input type="file" id="folder" webkitdirectory aria-label="Hel mapp">')); return; }
  if (url.pathname === '/bing') {
    const wrapped = `https://www.bing.com/ck/a?!&&p=abc&ptn=3&u=a1${Buffer.from(`${base}/shop`).toString('base64url')}&ntb=1`;
    response.end(page('Bing', `<ol id="b_results"><li class="b_ad"><h2><a href="https://ads.example/">Annons</a></h2></li>
      <li class="b_algo"><h2><a href="${wrapped}">Laddkabel Typ 2</a></h2><div class="b_caption"><p>Köp laddkabel</p></div></li></ol>`));
    return;
  }
  if (url.pathname === '/ddg') {
    response.end(page('Sök', `<div class="result result--ad"><a class="result__a" href="https://ads.example/">Annons</a></div>
      <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`${base}/shop`)}">Laddkabel Typ 2</a><a class="result__snippet">Köp laddkabel</a></div>`));
    return;
  }
  response.statusCode = 404; response.end(page('Saknas', 'Saknas'));
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');

const directory = mkdtempSync(join(tmpdir(), 'tabai-web-live-'));
// Files outside every deny root of this run: what an ordinary upload may send.
const outside = mkdtempSync(join(tmpdir(), 'tabai-web-live-outside-'));
const browser = new AssistantBrowser(process.cwd(), directory);
// The search pages are served locally; every other call reaches the real extension unchanged.
// A query with "reserv" gets an empty DuckDuckGo page, so the host falls back to the Bing-like page.
const searchPage = url => url.startsWith(ASSISTANT_WEB_BING_URL) ? `${base}/bing` : new URL(url).searchParams.get('q')?.includes('reserv') ? `${base}/ddg-empty` : `${base}/ddg`;
const transport = {
  call: (name, args = {}) => browser.call(name, name === 'navigate' && (String(args.url).startsWith(ASSISTANT_WEB_SEARCH_URL) || String(args.url).startsWith(ASSISTANT_WEB_BING_URL)) ? { ...args, url: searchPage(String(args.url)) } : args),
  close: () => browser.close(),
};
const web = new AssistantWeb(transport, { level: 'act', login: false }, true, undefined, { allowLocal: true });
const cleanup = async () => { await web.close().catch(() => {}); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); };
const stop = watchdog(cleanup);
/** The pixel size in a JPEG's frame header. */
const jpegSize = bytes => {
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('no JPEG frame');
};
const ref = (read, label) => {
  const found = String(read.elements ?? read.matches).match(new RegExp(`\\[(ref_\\d+)\\][^\\n]*${label}`, 'i'))?.[1];
  assert(found, `ref for ${label} in:\n${read.elements ?? read.matches}`);
  return found;
};
try {
  // The optional full mode reaches the actual catalogue through the executor;
  // it retains the ordinary server's scheme, schema and tab-ownership guards.
  {
    const executor = new AssistantExecutor(process.cwd(), join(directory, 'full-browser'));
    const execution = { context: { chat: { conversationId: randomUUID(), messages: [], web: { level: 'off', login: false, fullAccess: true } },
      settings: { accounts: [] }, run: { id: randomUUID() } }, callbacks: {}, webGeneration: 0, chatContextRead: true };
    const call = (name, args = {}) => executor.dispatch(execution, 'mcp_browser_call', { name, arguments: args });
    const value = result => {
      const text = result.content.find(block => block.type === 'text').text;
      try { return JSON.parse(text); } catch { return text; }
    };
    try {
      const catalog = await executor.dispatch(execution, 'mcp_browser_tools', { offset: 0, limit: 5 });
      const actual = await browser.listTools();
      assert.deepEqual(catalog.names, actual.tools.map(tool => tool.name));
      for (const name of ['javascript_tool', 'cookies', 'download', 'file_upload', 'browser_batch', 'recipe_run']) assert(catalog.names.includes(name));
      const context = value(await call('tabs_context_mcp', { createIfEmpty: true }));
      const tabId = context.tabs[0].tabId;
      assert.equal(context.tabs[0].url, 'about:blank');
      assert.notEqual((await call('navigate', { tabId, url: `${base}/butik-a` })).isError, true, 'full mode may reach local HTTP fixtures');
      assert.equal(value(await call('javascript_tool', { tabId, text: 'document.title' })), 'Laddkabel Typ 2 – Butik A');
      const secondTurn = { ...execution, context: structuredClone(execution.context) };
      assert.equal(value(await executor.dispatch(secondTurn, 'mcp_browser_call', { name: 'tabs_context_mcp', arguments: {} })).tabs[0].tabId, tabId);
      const image = await call('screenshot', { tabId });
      assert(image.content.some(block => block.type === 'image'), 'MCP image blocks are preserved');
      const rejectedScheme = await call('navigate', { tabId, url: 'file:///etc/passwd' });
      assert.equal(rejectedScheme.isError, true);
      const rejectedSchema = await call('navigate', { tabId, url: 42 });
      assert.equal(rejectedSchema.isError, true);
      const foreign = await browser.call('tabs_context_mcp', { createIfEmpty: true });
      const rejectedTab = await call('get_page_text', { tabId: foreign.tabs[0].tabId });
      assert.equal(rejectedTab.isError, true, 'a different MCP session stays out of reach');
      // The assistant's own server has the per-user data directory (here this run's temp
      // directory, which holds the executor's data) as its deny root: no file from it and no
      // directory reaches a page; a file elsewhere does.
      assert.notEqual((await call('navigate', { tabId, url: `${base}/upload` })).isError, true);
      const input = async selector => value(await call('resolve_target', { tabId, target: { selector, frameId: 0 } })).ref;
      const privateFile = join(directory, 'full-browser', 'private-note.txt'), shared = join(outside, 'delad.txt');
      mkdirSync(dirname(privateFile), { recursive: true }); writeFileSync(privateFile, 'privat'); writeFileSync(shared, 'delad');
      for (const [why, path, selector] of [['a file in the data directory', privateFile, '#one'], ['the private directory as a folder', directory, '#folder'], ['any folder', outside, '#folder']]) {
        const refused = await call('file_upload', { tabId, ref: await input(selector), paths: [path] });
        assert.equal(refused.isError, true, `${why} is refused`);
        assert.match(refused.content.find(block => block.type === 'text').text, /FILE_REFUSED/, why);
      }
      assert.equal(value(await call('javascript_tool', { tabId, text: "document.querySelector('#one').files.length + document.querySelector('#folder').files.length" })), 0, 'nothing reached the page');
      assert.notEqual((await call('file_upload', { tabId, ref: await input('#one'), paths: [shared] })).isError, true, 'a file outside the root is uploaded');
      assert.equal(value(await call('javascript_tool', { tabId, text: "document.querySelector('#one').files[0]?.name ?? ''" })), 'delad.txt');
      await executor.revokeWeb();
      await assert.rejects(call('tabs_context_mcp'), /ändrades under svaret/);
    } finally { await executor.close(); }
  }
  {
    // Information only, never asserted: does Chromium hand a webkitdirectory input a whole
    // folder for one directory path through DOM.setFileInputFiles? Measured in a session
    // without a deny root, which every MCP session but the assistant's own is.
    const folder = join(outside, 'mapp');
    mkdirSync(join(folder, 'under'), { recursive: true }); writeFileSync(join(folder, 'a.txt'), 'a'); writeFileSync(join(folder, 'under', 'b.txt'), 'b');
    const raw = new Client({ name: 'webkitdirectory-experiment', version: '1.0.0' });
    await raw.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/server.js')], cwd: process.cwd(), stderr: 'ignore',
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name, setting]) => name.startsWith('CCMCP_') && name !== 'CCMCP_UPLOAD_DENY_ROOT' && typeof setting === 'string')), CCMCP_CONFIG_DIR: join(outside, 'raw-store') } }));
    try {
      const rawCall = async (name, args) => {
        const result = await raw.callTool({ name, arguments: args }), text = result.content.find(block => block.type === 'text')?.text ?? '';
        if (result.isError) throw new Error(text);
        try { return JSON.parse(text); } catch { return text; }
      };
      const rawTab = (await rawCall('tabs_context_mcp', { createIfEmpty: true })).tabs[0].tabId;
      await rawCall('navigate', { tabId: rawTab, url: `${base}/upload` });
      for (const [label, selector] of [['webkitdirectory input', '#folder'], ['plain file input', '#one']]) {
        let outcome;
        try {
          const { ref } = await rawCall('resolve_target', { tabId: rawTab, target: { selector, frameId: 0 } });
          await rawCall('file_upload', { tabId: rawTab, ref, paths: [folder] });
          outcome = JSON.stringify(await rawCall('javascript_tool', { tabId: rawTab, text: `JSON.stringify([...document.querySelector('${selector}').files].map(file => file.webkitRelativePath || file.name))` }));
        } catch (error) { outcome = `error: ${String(error.message).slice(0, 200)}`; }
        console.log(`  webkitdirectory experiment, ${label}, one directory path: ${outcome}`);
      }
    } finally { await raw.close().catch(() => {}); }
  }
  const searched = await web.search('laddkabel typ 2');
  assert.deepEqual(searched.results.map(result => result.url), [`${base}/shop`], 'the ad is skipped and the redirect target decoded');
  // The launched browser has not allowed Tabai in incognito: the fallback says so.
  assert.equal(web.incognito, false); assert.match(web.notice, /Tillåt i inkognito/);

  let shop = await web.open(`${base}/shop`);
  assert.match(shop.text, /Att betala 499 kr/); assert(shop.notice.startsWith(web.notice) && /Berätta det för användaren/.test(shop.notice), 'the agent is told to pass the fallback on');
  assert.equal((await web.click(shop.tabId, ref(shop, 'Godkänn alla kakor'))).clicked, true, 'a cookie banner is dismissed without approval');
  shop = await web.read(shop.tabId);
  await web.fill(shop.tabId, ref(shop, 'Namn'), 'Kim Testsson');
  const pending = await web.click(shop.tabId, ref(shop, 'Köp nu'));
  assert(pending.approval, 'the purchase waits for approval');
  assert.equal(orders, 0, 'nothing is submitted before approval');
  assert.equal(pending.approval.amount, '499 kr'); assert.deepEqual(pending.approval.fields, [{ label: 'Namn', value: 'Kim Testsson' }], 'the card shows the form the submit sends');
  // The card's image: the button and its form through the extension's own screenshot tool, a JPEG of at most 1200×900 and 1 MB.
  assert(pending.preview, 'the card comes with an image');
  const shot = jpegSize(pending.preview.bytes);
  assert.ok(pending.preview.bytes.length <= 1024 * 1024 && shot.width <= 1200 && shot.height <= 900 && shot.width >= 100 && shot.height >= 40, JSON.stringify({ ...shot, bytes: pending.preview.bytes.length }));
  assert.equal('previewFileId' in pending.approval, false, 'the image is not part of the approval');
  const done = await web.approve(pending.approval);
  assert.equal(orders, 1, 'exactly one order after approval');
  assert.equal(done.title, 'Tack');
  await assert.rejects(web.approve(pending.approval), /redan använts/);
  assert.equal(orders, 1, 'an approval is never replayed');
  // The receipt is saved by the server in this session's own store, where the host reads and removes it.
  const printed = await web.receipt(shop.tabId);
  assert.equal(dirname(printed.path), join(directory, 'browser-store', 'pdfs'), 'AssistantBrowser points the server at its private store');
  assert(printed.bytes > 500 && existsSync(printed.path), 'a real PDF of the confirmation page');
  rmSync(printed.path);
  shop = await web.open(`${base}/shop`, shop.tabId);
  assert((await web.click(shop.tabId, ref(shop, 'Slutför köp'))).approval, 'a checkout wrapper named consent is no cookie banner');
  assert.equal(orders, 1);

  // A page that patches innerText, closest() and .form cannot hide its purchase from the isolated checks.
  // Later pages reuse the shop tab: a conversation keeps at most six web tabs.
  const spoof = await web.open(`${base}/spoof`, shop.tabId);
  const fooled = await browser.call('javascript_tool', { tabId: spoof.tabId, text: "document.querySelector('button').innerText" });
  assert.equal(fooled, 'Läs mer', 'the page world is patched');
  assert.equal(await browser.call('javascript_tool', { tabId: spoof.tabId, text: "document.querySelector('button').innerText", world: 'isolated' }), 'Köp nu', 'the isolated world reads the real text');
  const spoofed = await web.click(spoof.tabId, ref(spoof, 'Köp nu'));
  assert(spoofed.approval, 'the patched purchase still needs approval');
  assert.equal(spoofed.approval.action, 'Köp nu'); assert.equal(spoofed.approval.amount, '299 kr');
  assert.equal(orders, 1, 'nothing was submitted');
  // Content-Security-Policy: script-src 'none'. The page's own script is blocked, the isolated world
  // still evaluates, and every button is classified: consent clicked, purchase held, login refused.
  let strict = await web.open(`${base}/strict`, shop.tabId);
  assert.equal(strict.title, 'Strikt kassa', 'the policy blocks the page\'s own script');
  assert.equal(await browser.call('javascript_tool', { tabId: strict.tabId, text: "document.querySelector('h1').textContent + ' · ' + document.title", world: 'isolated' }), 'Strikt kassa · Strikt kassa', 'javascript_tool evaluates in the isolated world under script-src none');
  assert.equal((await web.click(strict.tabId, ref(strict, 'Godkänn alla kakor'))).clicked, true, 'allow: a consent button is clicked without approval');
  strict = await web.read(strict.tabId);
  const strictPurchase = await web.click(strict.tabId, ref(strict, 'Köp nu'));
  assert(strictPurchase.approval, 'approval: the purchase waits for the user');
  assert.equal(strictPurchase.approval.action, 'Köp nu'); assert.equal(strictPurchase.approval.amount, '199 kr');
  assert.ok(strictPurchase.preview && jpegSize(strictPurchase.preview.bytes).width <= 1200, 'the image is taken under script-src none too');
  assert.equal(orders, 1, 'nothing was submitted on the strict page');
  web.access = { level: 'act', login: true };
  const strictLogin = await web.open(`${base}/strict-login`, shop.tabId);
  await assert.rejects(web.click(strictLogin.tabId, ref(strictLogin, 'Logga in')), /Inloggningen skickar användaren själv/, 'refuse: the agent never submits a login');
  web.access = { level: 'act', login: false };
  assert.equal(orders, 1);
  // An empty DuckDuckGo page: one search on the Bing-like page, decoded and filtered the same way.
  const fallback = await web.search('reservsökning laddkabel');
  assert.equal(fallback.engine, 'Bing');
  assert.deepEqual(fallback.results.map(result => result.url), [`${base}/shop`], 'the ad is skipped and the ck/a link decoded');
  assert.equal((await web.open(`${base}/shop`, shop.tabId)).title, 'Laddkabel – kassa');

  const login = await web.open(`${base}/login`, shop.tabId);
  await assert.rejects(web.fill(login.tabId, ref(login, 'Lösenord'), 'hemligt'), /Inloggning är avstängd|fyller användaren i själv/);
  await assert.rejects(web.click(login.tabId, ref(login, 'Logga in')), /Inloggning är avstängd/);
  web.access = { level: 'act', login: true };
  await assert.rejects(web.fill(login.tabId, ref(login, 'Lösenord'), 'hemligt'), /fyller användaren i själv/);
  await assert.rejects(web.click(login.tabId, ref(login, 'Logga in')), /Inloggningen skickar användaren själv/);
  const app = await web.open(`${base}/app-login`, shop.tabId);
  await assert.rejects(web.click(app.tabId, ref(app, 'Logga in')), /Inloggningen skickar användaren själv/, 'a login page without <form>');
  web.access = { level: 'act', login: false };
  await assert.rejects(web.fill(app.tabId, ref(app, 'E-post'), 'kim@example.test'), /Inloggning är avstängd/);
  assert.equal(orders, 1, 'a login form is never submitted by the agent');

  const pay = await web.open(`${base}/pay`, shop.tabId);
  await assert.rejects(web.fill(pay.tabId, ref(pay, 'Kortnummer'), '4111111111111111'), /fyller användaren i själv/);
  assert((await web.click(pay.tabId, ref(pay, 'Fortsätt'))).approval, 'any button on a payment page needs approval');
  assert.equal((await web.read(pay.tabId)).title, 'Betalning', 'the payment button was not clicked');
  // The mail hosts on port 1: the guard refuses the host name, and a broken guard would meet a port
  // Chrome never connects to, so no request can reach a real mail service.
  await assert.rejects(web.open('https://mail.google.com:1/mail/u/0/'), /Mejl och kalender/);
  await assert.rejects(web.open('https://outlook.cloud.microsoft:1/mail/'), /Mejl och kalender/);

  // Hitta billigast: a chat turn at the act level reads two loopback shops with the
  // executor's own web tools in this browser; the host shows only rows whose pages the
  // turn read, and from the comparison on the turn only reads.
  {
    const before = orders, webDir = join(directory, 'compare-web');
    const executor = new AssistantExecutor(process.cwd(), webDir);
    // Test-only: the executor's own sessions may open these loopback shops.
    const session = executor.webSession.bind(executor);
    executor.webSession = (key, access, windowId, options = {}) => session(key, access, windowId, { ...options, allowLocal: true });
    const turns = { async start(context, callbacks) { this.turn = { context, callbacks }; }, async stop() {}, async close() {} };
    const chat = new AssistantChat(process.cwd(), join(directory, 'compare-chat'), { agent: () => undefined, current: () => undefined, verifications: () => [], berget: () => ({ configured: false, message: '' }),
      async start() { throw new Error('no tasks'); }, webAccess: () => ({ level: 'act', login: false }), watches: () => [], watchAgent: () => undefined }, turns);
    try {
      await chat.send({ id: randomUUID(), text: 'Hitta billigast: laddkabel typ 2' });
      const execution = { context: turns.turn.context, callbacks: turns.turn.callbacks, chatContextRead: true, webGeneration: 0 };
      const a = await executor.dispatch(execution, 'web_open', { url: `${base}/butik-a` });
      const b = await executor.dispatch(execution, 'web_open', { url: `${base}/butik-b` });
      assert.match(a.text, /Pris 499 kr[\s\S]*Frakt 49 kr/); assert.equal(b.url, `${base}/butik-b/vara`, 'Chrome followed the redirect'); assert.match(b.text, /Pris 529 kr[\s\S]*Fri frakt/);
      const row = (shop, price, shipping, address) => ({ shop, product: 'Laddkabel Typ 2', price, shipping, currency: 'SEK', url: address });
      await assert.rejects(executor.dispatch(execution, 'chat_compare', { query: 'laddkabel typ 2', rows: [row('Butik A', 499, 49, `${base}/butik-a`), row('Butik C', 399, 0, `${base}/butik-c`)] }),
        /Rad 2 \(Butik C\): http:\/\/127\.0\.0\.1:9239\/butik-c har inte öppnats eller lästs/, 'a shop page the turn never read is refused');
      // The model's price is not on the page Chrome rendered: the row is refused with the host's own words.
      await assert.rejects(executor.dispatch(execution, 'chat_compare', { query: 'laddkabel typ 2', rows: [row('Butik A', 449, 49, `${base}/butik-a`), row('Butik B', 529, 0, b.url)] }),
        /^Error: Jämförelsen visades inte\. Rad 1 \(Butik A\): Priset 449 kr står inte på sidan http:\/\/127\.0\.0\.1:9239\/butik-a som lästes\. Läs om sidan eller ta bort raden\.$/, 'a price the shop page does not show is refused');
      const result = await executor.dispatch(execution, 'chat_compare', { query: 'laddkabel typ 2', rows: [row('Butik A', 499, 49, `${base}/butik-a`), row('Butik B', 529, 0, b.url)] });
      assert.deepEqual(result.cheapest, { shop: 'Butik B', total: '529 kr' }, 'free shipping makes the higher price the cheapest');
      const buy = String(a.elements).match(/\[(ref_\d+)\][^\n]*Köp nu/)?.[1]; assert(buy, a.elements);
      await assert.rejects(executor.dispatch(execution, 'web_click', { tabId: a.tabId, ref: buy }), /en jämförelse bara läser/, 'no purchase step after a comparison');
      await executor.dispatch(execution, 'chat_reply', { text: 'Butik B är billigast med fri frakt.' });
      const messages = chat.view().messages, compare = messages.find(entry => entry.compare);
      assert.deepEqual(compare.compare.rows.map(entry => [entry.shop, entry.url, entry.price, entry.shipping]), [['Butik B', `${base}/butik-b/vara`, 529, 0], ['Butik A', `${base}/butik-a`, 499, 49]],
        'prices and shipping as the pages show them: "Fri frakt" and "Frakt 49 kr"');
      assert(messages.some(entry => entry.webActivity?.some(line => line === `Öppnade ${base}/butik-b`)), 'the pages are in the visible web record');
      // "Bevaka priset" watches the checked price.
      await chat.compareWatch({ messageId: compare.id, row: 0 });
      const card = chat.view().messages.find(entry => entry.card)?.card;
      assert.deepEqual({ title: card.title, status: card.status, intent: card.intent }, { title: 'Bevaka: Laddkabel Typ 2 hos Butik B', status: 'pending',
        intent: { kind: 'watch', title: 'Laddkabel Typ 2 hos Butik B', target: { url: `${base}/butik-b/vara` }, condition: 'Säg till när priset är under 529 kr', cadence: { hours: 6 } } });
      assert.equal(orders, before, 'no order from a comparison');
    } finally { await chat.close(); await executor.close(); }
  }
  console.log('Assistant web live: search parsing, incognito fallback, consent versus checkout, fill, one approved purchase with its card image and its receipt, isolated checks against a patched page and under a script-src none policy, Bing fallback, form and app login and payment gates, and a read-only price comparison of two shops whose prices must be on their pages, with its watch card passed');
} finally { await cleanup(); stop(); }
