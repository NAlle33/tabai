// Hitta billigast: the comparison rows and their checks, the host's rule that every
// row names a page the turn itself read on the row's own site, at a price that page
// shows (shipping it does not show becomes unknown), the card sorted by price plus
// shipping, and "Bevaka priset" as the ordinary new-watch card the user approves,
// never for a page already watched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AssistantComparePages, AssistantExecutor, assistantChatPrompt, assistantPageAmounts } from '../dist/assistant-agent.mjs';
import { assistantWorkerToolNames } from '../dist/assistant-tools.mjs';
import { AssistantChat, assistantCompareWatchIntent } from '../dist/assistant-chat.mjs';
import { AssistantController } from '../dist/assistant-controller.mjs';
import { ASSISTANT_WATCH_CAPACITY_WARNING } from '../dist/assistant-watches.mjs';
import { runBergetAgent } from '../dist/assistant-berget-agent.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(async () => { for (const close of closers.reverse()) await close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });
const compiled = await build({ entryPoints: ['shared/assistant-chat.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
const shared = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const directory = mkdtempSync(join(tmpdir(), 'tabai-compare-'));
const closers = [];
const row = (shop, price, shipping, url, extra = {}) => ({ shop, product: 'Laddkabel Typ 2', price, ...(shipping === undefined ? {} : { shipping }), currency: 'SEK', url, ...extra });
try {
  // The rows: at most eight, finite non-negative amounts, a currency code; each message says what to fix.
  const issues = value => shared.assistantChatCompareInputSchema.safeParse(value).error?.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') ?? '';
  const url = 'https://a.example/laddkabel';
  assert.equal(issues({ query: 'laddkabel typ 2', rows: [row('Butik A', 499, 49, url)] }), '');
  assert.match(issues({ query: 'x', rows: [row('Butik A', -1, 0, url)] }), /^rows\.0\.price: Priset kan inte vara negativt\.$/);
  assert.match(issues({ query: 'x', rows: [row('Butik A', 499, -5, url)] }), /^rows\.0\.shipping: Frakten kan inte vara negativ\.$/);
  assert.match(issues({ query: 'x', rows: [row('Butik A', Infinity, 0, url)] }), /rows\.0\.price: Ange priset som ett tal\./);
  assert.match(issues({ query: 'x', rows: [row('Butik A', '499 kr', 0, url)] }), /rows\.0\.price: Ange priset som ett tal, till exempel 499/);
  assert.match(issues({ query: 'x', rows: [row('Butik A', 499, 0, url, { currency: 'kr' })] }), /rows\.0\.currency: Ange valutan som en kod med tre stora bokstäver, till exempel SEK/);
  assert.match(issues({ query: 'x', rows: [row('Butik A', 2e8, 0, url)] }), /Priset är orimligt stort/);
  assert.match(issues({ query: 'x', rows: Array.from({ length: 9 }, (_, index) => row(`Butik ${index}`, 100, 0, url)) }), /^rows: Högst 8 butiker i en jämförelse\.$/);
  assert.notEqual(issues({ query: 'x', rows: [] }), '', 'a comparison has at least one shop');
  assert.notEqual(issues({ query: 'x', rows: [row('Butik A', 1, 0, url, { rating: 5 })] }), '', 'no fields beyond the row');

  // Cheapest total first; a shop without shipping counts with its price alone; equal totals keep their order.
  const sorted = shared.assistantCompareSorted([row('A', 499, 99, url), row('B', 549, 0, url), row('C', 520, undefined, url), row('D', 449, 199, url), row('E', 598, 0, url)]);
  assert.deepEqual(sorted.map(entry => entry.shop), ['C', 'B', 'A', 'E', 'D']);
  assert.equal(shared.assistantCompareTotal({ price: 0.1, shipping: 0.2 }), 0.3, 'totals in whole cents');
  assert.equal(shared.assistantCompareAmount(1299, 'SEK'), '1 299 kr');
  assert.equal(shared.assistantCompareAmount(1299, 'SEK', false), '1299 kr');
  assert.equal(shared.assistantCompareAmount(12.5, 'EUR'), '12,50 EUR');

  // The host's check: a row's address names a page the turn read, matched without its fragment.
  const read = new AssistantComparePages();
  read.read({ url: 'https://a.example/laddkabel#pris', text: 'Pris 499 kr, frakt 49 kr' }, 'https://a.example/laddkabel');
  read.read({ url: 'https://b.example/vara', text: 'Nu 520:-' });
  assert.deepEqual(read.rejections([row('Butik A', 499, 49, 'https://a.example/laddkabel'), row('Butik B', 520, 0, 'https://b.example/vara#recensioner')]), []);
  assert.deepEqual(read.rejections([row('Butik A', 499, 49, 'https://a.example/laddkabel'), row('Butik X', 1, 0, 'javascript:alert(1)'), row('Butik C', 1, 0, 'https://c.example/vara')]), [
    'Rad 2 (Butik X): adressen är ingen vanlig webbsida (http eller https).',
    'Rad 3 (Butik C): https://c.example/vara har inte öppnats eller lästs med web_open eller web_read i det här svaret. Öppna butikens sida och läs priset där, eller ta bort raden.']);
  assert.match(read.rejections([row('Butik A', 499, 49, 'https://a.example/laddkabel'), row('Butik B', 52, 0, 'https://b.example/vara', { currency: 'EUR' })]).join(' '), /olika valutor \(SEK, EUR\)/);
  // The requested address counts only when the page that loaded is an http(s) page on the same site, "www." aside.
  read.read({ url: 'https://www.d.example/produkt/7', text: '1 kr' }, 'https://d.example/p?id=7');
  read.read({ url: 'about:blank', text: '1 kr' }, 'https://e.example/vara');
  read.read({ url: 'https://annan.example/start', text: '1 kr' }, 'https://f.example/vara');
  read.read({ tabId: 4 }, 'https://g.example/vara');
  assert.deepEqual(read.rejections([row('Butik D', 1, 0, 'https://d.example/p?id=7'), row('Butik D2', 1, 0, 'https://www.d.example/produkt/7'), row('Annan', 1, 0, 'https://annan.example/start')]), [], 'a redirect within the shop, its target, and another site\'s page by its own address');
  const moved = (index, shop, address, page) => `Rad ${index} (${shop}): ${address} öppnades, men sidan som lästes var ${page}, inte en sida på samma webbplats. Ange adressen som web_open eller web_read gav om det är butikens produktsida, eller ta bort raden.`;
  assert.deepEqual(read.rejections([row('Butik E', 1, 0, 'https://e.example/vara'), row('Butik F', 1, 0, 'https://f.example/vara'), row('Butik G', 1, 0, 'https://g.example/vara')]), [
    moved(1, 'Butik E', 'https://e.example/vara', 'about:blank'), moved(2, 'Butik F', 'https://f.example/vara', 'https://annan.example/start'), moved(3, 'Butik G', 'https://g.example/vara', 'about:blank')],
    'a page that ended blank or on another site leaves the requested address unread');
  assert.equal(shared.assistantCompareSameSite('https://www.shop.example/a', 'http://shop.example/b'), true);
  assert.equal(shared.assistantCompareSameSite('https://m.shop.example/a', 'https://shop.example/a'), false, 'another host is another site');
  assert.equal(shared.assistantCompareSameSite('about:blank', 'about:blank'), false, 'only web pages have a site');

  // The tool exists for chat at both web levels, never without web, in a mail task or in a watch.
  for (const level of ['read', 'act']) assert(assistantWorkerToolNames(true, level).includes('chat_compare'), level);
  for (const level of ['off', 'read', 'act']) {
    assert.equal(assistantWorkerToolNames(true, 'off').includes('chat_compare'), false);
    assert.equal(assistantWorkerToolNames(false, level).includes('chat_compare'), false, `mail task (${level})`);
    assert.equal(assistantWorkerToolNames('watch', level).includes('chat_compare'), false, `watch (${level})`);
  }
  for (const level of ['read', 'act']) assert.match(assistantChatPrompt({ level, login: false }), /chat_compare[\s\S]*bara läsning: klicka eller fyll aldrig i för att köpa[\s\S]*Godkänn-kortet/, level);
  assert.doesNotMatch(assistantChatPrompt({ level: 'off', login: false }), /chat_compare/);
  // The real worker, which local models and Berget use, publishes the rows' schema.
  {
    const client = new Client({ name: 'tabai-compare-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/assistant-worker.mjs')],
      env: { TABAI_ASSISTANT_SOCKET: join(directory, 'unused'), TABAI_ASSISTANT_SECRET: 'unused', TABAI_ASSISTANT_CHAT: '1', TABAI_ASSISTANT_WEB: 'read' }, stderr: 'ignore' }));
    try {
      const tool = (await client.listTools()).tools.find(entry => entry.name === 'chat_compare');
      const rows = tool.inputSchema.properties.rows;
      assert.equal(rows.maxItems, 8); assert.deepEqual(Object.keys(rows.items.properties).sort(), ['currency', 'price', 'product', 'shipping', 'shop', 'url']);
      assert.equal(rows.items.properties.price.minimum, 0); assert.match(tool.description, /never click or fill to buy/);
    } finally { await client.close(); }
  }
  // Berget runs the same tool through its ordinary loop.
  {
    const calls = [], replies = [
      { tool_calls: [{ id: 'open', type: 'function', function: { name: 'web_open', arguments: JSON.stringify({ url }) } }] },
      { tool_calls: [{ id: 'compare', type: 'function', function: { name: 'chat_compare', arguments: JSON.stringify({ query: 'laddkabel', rows: [row('Butik A', 499, 49, url)] }) } }] },
      { tool_calls: [{ id: 'reply', type: 'function', function: { name: 'chat_reply', arguments: JSON.stringify({ text: 'Butik A är billigast.' }) } }] }];
    let index = 0;
    await runBergetAgent({ client: { async complete() { return { message: replies[index++] }; } }, model: 'zai-org/GLM-5.3-Flash', prompt: 'Synthetic', signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, chat: true,
      worker: { async listTools() { return { tools: ['workflow_context', 'web_open', 'chat_compare', 'chat_reply'].map(name => ({ name, inputSchema: { type: 'object' } })) }; },
        async callTool(input) { calls.push(input); return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }; } } });
    assert.deepEqual(calls.map(call => call.name), ['workflow_context', 'web_open', 'chat_compare', 'chat_reply']);
    assert.deepEqual(calls[2].arguments.rows[0], row('Butik A', 499, 49, url));
  }

  // The executor: the turn's own web record decides, never the conversation's text.
  {
    const executor = new AssistantExecutor(directory, directory), conversationId = randomUUID(); closers.push(() => executor.close());
    const tabs = new Map(); let next = 40;
    // Each shop page's text, in the formats shops use.
    const texts = { 'https://a.example/laddkabel': 'Laddkabel Typ 2\nPris 499 kr\nFrakt 49 kr', 'https://b.example/vara': 'Laddkabel Typ 2\n549:-\nFri frakt', 'https://b.example/vara?farg=svart': 'Svart\n529,00 SEK', 'https://annan.example/start': 'Kampanj 499 kr' };
    const session = { privateValues: [], sharedPageOrigins: [],
      // /flyttad redirects within its shop, /tom ends on a blank tab and /vidare on another site.
      async open(address, tabId) { const id = tabId ?? next++; tabs.set(id, address.includes('/flyttad') ? 'https://b.example/vara' : address.includes('/tom') ? 'about:blank' : address.includes('/vidare') ? 'https://annan.example/start' : address.replace(/#.*$/, '')); return this.read(id); },
      async read(tabId) { return { tabId, url: tabs.get(tabId), title: 'Butik', text: texts[tabs.get(tabId)] ?? '' }; },
      async click() { return { clicked: true, url: '', title: '' }; }, async fill() { return { filled: true }; }, async handover() { return { shown: true }; },
      log() {}, drainActivity() { return []; }, async close() {} };
    executor.web = { conversationId, key: JSON.stringify([conversationId, false, {}]), session };
    const shown = [];
    const turn = level => ({ context: { run: { id: randomUUID() }, settings: { accounts: [] }, chat: { messages: [{ role: 'user', text: 'Hitta billigast: laddkabel, till exempel https://d.example/annons' }], conversationId, web: { level, login: false } } },
      callbacks: { chatCompare: async input => { shown.push(input); return { shown: true }; }, chatReply: async () => {}, webActivity: async () => {}, status: async () => {} }, chatContextRead: true, webGeneration: 0 });
    const query = 'laddkabel typ 2';
    await assert.rejects(executor.dispatch(turn('off'), 'chat_compare', { query, rows: [row('Butik A', 499, 49, url)] }), /Webbåtkomsten tillåter inte det verktyget/);
    const act = turn('act');
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik A', 499, 49, url)] }), /^Error: Jämförelsen visades inte\. Rad 1 \(Butik A\): https:\/\/a\.example\/laddkabel har inte öppnats eller lästs/, 'nothing opened yet');
    await executor.dispatch(act, 'web_open', { url: `${url}#pris` });
    const moved = await executor.dispatch(act, 'web_open', { url: 'https://b.example/flyttad' });
    tabs.set(moved.tabId, 'https://b.example/vara?farg=svart');
    await executor.dispatch(act, 'web_read', { tabId: moved.tabId });
    // The address in the user's message was never opened in this turn.
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik A', 499, 49, url), row('Butik D', 399, 0, 'https://d.example/annons')] }), /Rad 2 \(Butik D\): https:\/\/d\.example\/annons har inte öppnats/);
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik A', 499, 49, url), row('Butik B', 52, 0, 'https://b.example/vara', { currency: 'EUR' })] }), /olika valutor/);
    // A requested address whose page ended blank or on another site is no page the turn read there.
    await executor.dispatch(act, 'web_open', { url: 'https://e.example/tom' });
    await executor.dispatch(act, 'web_open', { url: 'https://f.example/vidare' });
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik A', 499, 49, url), row('Butik E', 499, 0, 'https://e.example/tom')] }), /Rad 2 \(Butik E\): https:\/\/e\.example\/tom öppnades, men sidan som lästes var about:blank, inte en sida på samma webbplats/);
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik F', 499, 0, 'https://f.example/vidare')] }), /Rad 1 \(Butik F\): https:\/\/f\.example\/vidare öppnades, men sidan som lästes var https:\/\/annan\.example\/start/);
    // A price the row's page does not show is refused, also one read off another shop's page.
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik A', 449, 49, url)] }),
      /^Error: Jämförelsen visades inte\. Rad 1 \(Butik A\): Priset 449 kr står inte på sidan https:\/\/a\.example\/laddkabel som lästes\. Läs om sidan eller ta bort raden\.$/);
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows: [row('Butik A', 549, 49, url)] }), /Rad 1 \(Butik A\): Priset 549 kr står inte på sidan/, 'another shop\'s price does not count');
    assert.equal(shown.length, 0, 'a refused comparison shows nothing');
    // The opened, the redirected-to and the read address each count, each with the prices on its own page.
    const rows = [row('Butik A', 499, 49, `${url}#pris`), row('Butik B', 549, 0, 'https://b.example/flyttad'), row('Butik B2', 549, 0, 'https://b.example/vara'), row('Butik B3', 529, undefined, 'https://b.example/vara?farg=svart')];
    assert.deepEqual(await executor.dispatch(act, 'chat_compare', { query, rows }), { shown: true });
    assert.deepEqual(shown, [{ query, rows }], 'the host shows the rows as the model gave them');
    await assert.rejects(executor.dispatch(act, 'chat_compare', { query, rows }), /visar redan en prisjämförelse/, 'one card per turn');
    // From here the turn only reads: no click, fill or handover toward a purchase.
    for (const [tool, args] of [['web_click', { tabId: 40, ref: 'ref_1' }], ['web_fill', { tabId: 40, ref: 'ref_2', value: 'Kim' }], ['web_handover', { tabId: 40, message: 'Betala' }]])
      await assert.rejects(executor.dispatch(act, tool, args), /har visat en prisjämförelse, och en jämförelse bara läser/, tool);
    assert.equal((await executor.dispatch(act, 'web_read', { tabId: 40 })).url, url, 'reading goes on');
    // At the read level the same comparison works; shipping the page does not show reaches the card as unknown.
    const reading = turn('read');
    await executor.dispatch(reading, 'web_open', { url });
    assert.deepEqual(await executor.dispatch(reading, 'chat_compare', { query, rows: [row('Butik A', 499, 39, url)] }),
      { shown: true, shippingUnknown: ['Butik A'], note: 'Frakten för Butik A står inte på sidan som lästes och visas som okänd på kortet; summan där är bara priset.' });
    assert.deepEqual(shown.at(-1).rows, [row('Butik A', 499, undefined, url)], 'only checked amounts reach the card, and so "Bevaka priset"');
    // Free shipping (0) stays only on a page that says it is free.
    const free = turn('read');
    await executor.dispatch(free, 'web_open', { url });
    await executor.dispatch(free, 'web_open', { url: 'https://b.example/vara' });
    await executor.dispatch(free, 'chat_compare', { query, rows: [row('Butik A', 499, 0, url), row('Butik B', 549, 0, 'https://b.example/vara')] });
    assert.deepEqual(shown.at(-1).rows.map(entry => [entry.shop, entry.shipping]), [['Butik A', undefined], ['Butik B', 0]]);
  }

  // The amounts a page shows, in shops' own formats; a row's price must be one of them.
  {
    const amounts = text => [...assistantPageAmounts(text)].sort((a, b) => a - b);
    assert.deepEqual(amounts('Pris 1 249 kr'), [124900], 'a space groups thousands');
    assert.deepEqual(amounts('Pris 1\u00a0249\u00a0kr'), [124900], 'and a no-break space');
    assert.deepEqual(amounts('Pris 1\u202f249 kr'), [124900], 'and a narrow no-break space');
    assert.deepEqual(amounts('Nu 1249:-'), [124900]);
    assert.deepEqual(amounts('Nu 1 249,-'), [124900]);
    assert.deepEqual(amounts('Totalt 1 249,00 SEK'), [124900], 'decimals with a comma');
    assert.deepEqual(amounts('Price €12.99'), [1299], 'decimals with a point, the euro before');
    assert.deepEqual(amounts('Pris 12,99 €'), [1299]);
    assert.deepEqual(amounts('1.249 kr'), [124900], 'a point before three digits groups thousands');
    assert.deepEqual(amounts('Price 1,249.50 EUR'), [124950]);
    assert.deepEqual(amounts('Ord. pris 1 499 kr\nNu 1 099 kr\nFrakt 49 kr.'), [4900, 109900, 149900], 'several prices, a full stop after one');
    assert.deepEqual(amounts('1 249 1 099'), [109900, 124900], 'two grouped prices side by side');
    assert.equal(assistantPageAmounts('Pris 1 249 kr').has(24900), false, 'a thousands group is never a price of its own');
    const page = new AssistantComparePages();
    page.read({ url: 'https://shop.example/kabel', title: 'Laddkabel – 1 249 kr', text: 'Laddkabel Typ 2\nI lager', elements: '[ref_4] button "Köp – frakt 59 kr"' });
    page.found({ url: 'https://shop.example/kabel', matches: 'Ordinarie pris 1 399 kr' });
    page.read({ url: 'https://other.example/kabel', text: 'Pris 999 kr' });
    assert.deepEqual(page.rejections([row('Shop', 1249, 59, 'https://shop.example/kabel'), row('Shop', 1399, undefined, 'https://shop.example/kabel')]), [], 'the title, the listed elements and find matches are text the turn read');
    assert.deepEqual(page.rejections([row('Shop', 999, 59, 'https://shop.example/kabel')]), ['Rad 1 (Shop): Priset 999 kr står inte på sidan https://shop.example/kabel som lästes. Läs om sidan eller ta bort raden.']);
    assert.deepEqual(page.rejections([{ ...row('Shop', 12.5, 0, 'https://shop.example/kabel'), currency: 'EUR' }]), ['Rad 1 (Shop): Priset 12,50 EUR står inte på sidan https://shop.example/kabel som lästes. Läs om sidan eller ta bort raden.']);
    assert.deepEqual(page.shown([row('Shop', 1249, 59, 'https://shop.example/kabel'), row('Shop', 1249, 0, 'https://shop.example/kabel'), row('Shop', 1249, 79, 'https://shop.example/kabel')]),
      { rows: [row('Shop', 1249, 59, 'https://shop.example/kabel'), row('Shop', 1249, undefined, 'https://shop.example/kabel'), row('Shop', 1249, undefined, 'https://shop.example/kabel')], unknownShipping: ['Shop', 'Shop'] },
      'shipping on the page stays; free shipping on a page that never says so and an amount not on it become unknown');
    const freeShipping = words => {
      const page = new AssistantComparePages();
      page.read({ url: 'https://shop.example/kabel', text: `Pris 1 249 kr. ${words}.` });
      return page.shown([row('Shop', 1249, 0, 'https://shop.example/kabel')]).rows[0].shipping === 0;
    };
    for (const words of ['Fri frakt', 'FRI FRAKT', 'Fri frakt', 'Fraktfritt', 'Gratis frakt', 'Gratisfrakt', 'Frakt: gratis', 'fraktfri leverans', 'Fri leverans', 'Fri hemleverans', 'Frakt 0 kr', 'Frakt: 0,00 kr', 'Frakt 0:-'])
      assert.equal(freeShipping(words), true, words);
    // Free words about something else keep a claimed free shipping unknown.
    for (const words of ['Fri retur i 30 dagar', 'Gratis inslagning', 'Fritt fram att byta', 'Fritid och friluftsliv', 'Frakt 59 kr', 'Fri frakttabell saknas', 'Frakt 09 kr'])
      assert.equal(freeShipping(words), false, words);
  }

  // The chat host: the card is stored cheapest first, and "Bevaka priset" makes the existing watch card.
  {
    const validated = [], hourly = Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), title: `Tim ${index}`, target: { query: `vara ${index}` }, condition: 'Lägre pris', cadence: { hours: 1 }, enabled: true, createdAt: new Date().toISOString() }));
    let saved = [];
    const bridge = { agent: () => undefined, current: () => undefined, verifications: () => [], berget: () => ({ configured: false, message: '' }), async start() { throw new Error('no tasks'); },
      watches: () => saved, watchAgent: () => undefined, validateIntent: intent => { validated.push(intent); if (intent.kind === 'watch' && intent.target.url?.includes('blockerad')) throw new Error('Bevakningen kan inte läsa den sidan.'); } };
    const executor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {} };
    const chat = new AssistantChat(process.cwd(), join(directory, 'chat'), bridge, executor); closers.push(() => chat.close());
    await chat.send({ id: randomUUID(), text: 'Hitta billigast: kaffebryggare' });
    const callbacks = executor.starts[0].callbacks;
    const result = await callbacks.chatCompare({ query: 'kaffebryggare', rows: [row('Butik A', 899, 59, 'https://a.example/k'), row('Butik B', 949, 0, 'https://b.example/k'), row('Butik C', 1299.5, undefined, 'https://blockerad.example/k')] });
    assert.deepEqual(result.cheapest, { shop: 'Butik B', total: '949 kr' }, 'the lower price loses on shipping'); assert.match(result.message, /Inget är köpt eller bevakat\. Avsluta med chat_reply/);
    await callbacks.chatReply('Butik B är billigast med frakt.');
    const message = chat.view().messages.find(entry => entry.compare);
    assert.deepEqual(message.compare.rows.map(entry => entry.shop), ['Butik B', 'Butik A', 'Butik C']);
    assert.equal(message.role, 'system'); assert.equal(message.text, '');
    assert.ok(Math.abs(Date.parse(message.compare.readAt) - Date.now()) < 60_000, 'the host stamps when it recorded the prices');
    // The next turn's model reads the comparison as text.
    await chat.send({ id: randomUUID(), text: 'Bevaka den billigaste.' });
    assert.ok(executor.starts[1].context.chat.messages.some(entry => entry.text.startsWith('Prisjämförelse: kaffebryggare') && entry.text.includes('• Butik B: Laddkabel Typ 2, 949 kr + 0 kr frakt = 949 kr (https://b.example/k)') && entry.text.includes('1 299,50 kr, frakt okänd')));
    await executor.starts[1].callbacks.chatReply('Tryck på Bevaka priset.');
    assert.deepEqual(assistantCompareWatchIntent(message.compare.rows[0]), { kind: 'watch', title: 'Laddkabel Typ 2 hos Butik B', target: { url: 'https://b.example/k' }, condition: 'Säg till när priset är under 949 kr', cadence: { hours: 6 } });
    await chat.compareWatch({ conversationId: chat.view().id, messageId: message.id, row: 0 });
    let cards = chat.view().messages.filter(entry => entry.card).map(entry => entry.card);
    assert.equal(cards.length, 1); assert.equal(cards[0].status, 'pending'); assert.equal(cards[0].title, 'Bevaka: Laddkabel Typ 2 hos Butik B');
    assert.deepEqual(cards[0].intent, assistantCompareWatchIntent(message.compare.rows[0])); assert.deepEqual(validated, [cards[0].intent], 'checked like any watch card');
    assert.equal(cards[0].warning, undefined, 'one more six-hour watch fits');
    await chat.compareWatch({ messageId: message.id, row: 0 });
    assert.equal(chat.view().messages.filter(entry => entry.card).length, 1, 'a second tap finds the waiting card');
    // With twelve hourly watches the schedule cannot keep up: the existing warning.
    saved = hourly;
    await chat.compareWatch({ messageId: message.id, row: 1 });
    cards = chat.view().messages.filter(entry => entry.card).map(entry => entry.card);
    assert.equal(cards.at(-1).warning, ASSISTANT_WATCH_CAPACITY_WARNING);
    assert.equal(cards.at(-1).intent.condition, 'Säg till när priset är under 899 kr');
    await assert.rejects(chat.compareWatch({ messageId: message.id, row: 2 }), /kan inte läsa den sidan/);
    await assert.rejects(chat.compareWatch({ messageId: message.id, row: 3 }), /finns inte längre/);
    await assert.rejects(chat.compareWatch({ messageId: randomUUID(), row: 0 }), /finns inte längre/);
    await assert.rejects(chat.compareWatch({ conversationId: randomUUID(), messageId: message.id, row: 0 }), /Samtalet har ändrats/);
    assert.equal(chat.view().messages.filter(entry => entry.card).length, 2, 'refused taps add nothing');
    // A stopped turn shows no comparison.
    await chat.send({ id: randomUUID(), text: 'Hitta billigast: vattenkokare' });
    const late = executor.starts.at(-1).callbacks; await chat.stop();
    await assert.rejects(late.chatCompare({ query: 'vattenkokare', rows: [row('Butik A', 299, 0, 'https://a.example/v')] }), /stoppats/);
  }

  // Through the controller: the real watch checks, approval as today, and nothing bought.
  {
    const dir = join(directory, 'controller');
    const chatExecutor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const watchExecutor = { async start() {}, async stop() {}, async close() {}, async revokeWeb() {} };
    const workflow = { async start() { throw new Error('no mail tasks here'); }, async stop() {}, async close() {}, async open() {} };
    const controller = new AssistantController(process.cwd(), dir, workflow, { chatExecutor, watchExecutor, clock: () => new Date('2026-11-03T10:00:00.000Z'), notice: () => {} });
    closers.push(() => controller.close());
    const request = (operation, input = {}) => controller.request(operation, input);
    const settings = async extra => { const current = (await request('status')).assistant; return request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, ...extra }) }); };
    await settings({ web: { level: 'read', login: false }, timezone: 'Europe/Stockholm' });
    await request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Hitta billigast: laddkabel typ 2' });
    const callbacks = chatExecutor.starts.at(-1).callbacks;
    await callbacks.chatCompare({ query: 'laddkabel typ 2', rows: [row('Butik A', 499, 99, 'https://a.example/laddkabel'), row('Butik B', 549, 0, 'https://b.example/vara')] });
    await callbacks.chatReply('Butik B är billigast med frakt.');
    let view = (await request('status')).chat;
    const message = view.messages.find(entry => entry.compare);
    assert.deepEqual(message.compare.rows.map(entry => entry.shop), ['Butik B', 'Butik A']);
    await request('correct', { action: 'chat-compare-watch', conversationId: view.id, messageId: message.id, row: '1' });
    view = (await request('status')).chat;
    const card = view.messages.find(entry => entry.card?.intent.kind === 'watch').card;
    assert.equal(card.title, 'Bevaka: Laddkabel Typ 2 hos Butik A');
    assert.match(card.detail, /^Sida: https:\/\/a\.example\/laddkabel\nVillkor: Säg till när priset är under 499 kr\nSchema: var 6:e timme, 4 körningar per dygn[\s\S]*Modell: Lokal · Qwen3\.5 4B/);
    // A second card for the same page, proposed in chat while the first one waits: the proposal itself is accepted.
    await request('correct', { action: 'chat-send', messageId: randomUUID(), message: 'Bevaka laddkabeln hos Butik A var tolfte timme.' });
    const proposer = chatExecutor.starts.at(-1).callbacks;
    const copy = await proposer.chatPropose({ kind: 'watch', title: 'Laddkabeln', target: { url: 'https://a.example/laddkabel' }, condition: 'Under 450 kr', cadence: { hours: 12 } });
    await proposer.chatReply('Kortet väntar.');
    await request('correct', { action: 'chat-confirm', cardId: card.id });
    view = (await request('status')).chat;
    assert.deepEqual(view.watches.map(watch => ({ title: watch.title, target: watch.target, condition: watch.condition, cadence: watch.cadence, enabled: watch.enabled })),
      [{ title: 'Laddkabel Typ 2 hos Butik A', target: { url: 'https://a.example/laddkabel' }, condition: 'Säg till när priset är under 499 kr', cadence: { hours: 6 }, enabled: true }]);
    // The page is watched now: approving the other waiting card is refused and closes it, and another "Bevaka priset" adds no card.
    await assert.rejects(request('correct', { action: 'chat-confirm', cardId: copy.cardId }), /^Error: Du bevakar redan den här sidan: Laddkabel Typ 2 hos Butik A\.$/);
    view = (await request('status')).chat;
    const closed = view.messages.find(entry => entry.card?.id === copy.cardId).card;
    assert.deepEqual([closed.status, closed.error], ['failed', 'Du bevakar redan den här sidan: Laddkabel Typ 2 hos Butik A.']);
    assert.equal(view.watches.length, 1, 'one watch for the page');
    const cardCount = view.messages.filter(entry => entry.card).length;
    await assert.rejects(request('correct', { action: 'chat-compare-watch', conversationId: view.id, messageId: message.id, row: '1' }), /^Error: Du bevakar redan den här sidan: Laddkabel Typ 2 hos Butik A\.$/);
    view = (await request('status')).chat;
    assert.equal(view.messages.filter(entry => entry.card).length, cardCount, 'a page already watched gets no new card');
    assert.equal(view.watches.length, 1);
    await assert.rejects(request('correct', { action: 'chat-compare-watch', conversationId: view.id, messageId: message.id, row: '8' }));
    await settings({ web: { level: 'off', login: false } });
    await assert.rejects(request('correct', { action: 'chat-compare-watch', conversationId: view.id, messageId: message.id, row: '0' }), /Söka och läsa/, 'no watch card without web access');
    view = (await request('status')).chat;
    assert.equal(view.messages.filter(entry => entry.card).length, cardCount);
    assert.equal(view.messages.some(entry => entry.card?.intent.kind === 'web-action'), false, 'a comparison never leads to a purchase card');
  }
  console.log('Assistant compare: rows and their checks, the turn\'s own pages on their own sites, prices in shops\' formats that must be on the page, unknown shipping, one read-only card per turn sorted by price plus shipping, the price watch card through the controller and its duplicate guard, Berget and the worker schema passed');
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
  stopWatchdog();
}
