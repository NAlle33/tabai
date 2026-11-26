// Web access for the chat agent: one level for every model choice, host gates
// for final steps, secrets and login, and exactly one click after approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AssistantWeb, AssistantWebError, ASSISTANT_WEB_PREVIEW_MS, assistantWebAdminPage, assistantBingResultUrl, assistantLookupDomain, assistantTaskWebLevel, assistantWebBingUrl, assistantWebUrl, assistantWebSearchUrl, classifyAssistantWebTarget, assistantWebElementScript, assistantWebFormStateScript } from '../dist/assistant-web.mjs';
import { assistantWatchToolNames, assistantWorkerMode, assistantWorkerToolNames, assistantWebToolNames, assistantWorkerWebLevel } from '../dist/assistant-tools.mjs';
import { AssistantExecutor, ASSISTANT_PROMPT, ASSISTANT_WATCH_PROMPT, assistantChatPrompt, assistantTaskPrompt, assistantClaudeArgs, assistantClaudeMcpConfig, assistantCodexArgs } from '../dist/assistant-agent.mjs';
import { AssistantChat } from '../dist/assistant-chat.mjs';
import { AssistantBrowser, AssistantBrowserError, assistantBrowserDisconnected, assistantUrl } from '../dist/assistant-browser.mjs';
import { AssistantController, validateAssistantAccount } from '../dist/assistant-controller.mjs';
import { watchdog } from './watchdog.mjs';

// Real worker processes and controllers run about 6.5 s.
const stopWatchdog = watchdog(async () => { for (const chat of chats) await chat.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); }, 90_000);
const directory = mkdtempSync(join(tmpdir(), 'tabai-web-'));
const chats = [];
try {
  // Addresses: http(s) only, no credentials, never the user's mail or calendar services.
  assert.equal(assistantWebUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(assistantWebUrl('http://127.0.0.1:9238/shop', true), 'http://127.0.0.1:9238/shop', 'local fixtures only with the test option');
  for (const blocked of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'ftp://example.com', 'https://user:pw@example.com/',
    'https://mail.google.com/mail/u/0/', 'http://mail.google.com/', 'https://mail.google.com./', 'https://MAIL.google.com:443/', 'https://calendar.google.com/calendar/r',
    'https://outlook.office.com/mail/', 'https://outlook.cloud.microsoft/mail/', 'https://mail.zoho.eu/zm/', 'not a url',
    'http://127.0.0.1:9238/shop', 'http://localhost:11434/', 'http://192.168.1.1/', 'http://10.0.0.8/', 'http://172.20.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://router.local/', 'http://2130706433/'])
    assert.throws(() => assistantWebUrl(blocked), AssistantWebError, blocked);
  // Names that only the local network resolves: a single label, and the suffixes routers,
  // NAS boxes, ad blockers and test setups use. IP literals keep their own rules.
  for (const local of ['http://nas/', 'http://router/', 'http://NAS./', 'https://pi.hole/admin/', 'http://fritz.box/', 'http://router.home/', 'http://wiki.corp/', 'http://host.localdomain/',
    'http://portal.intranet/', 'http://files.private/', 'http://site.test/', 'http://x.invalid/', 'http://nas.lan/', 'http://metadata.google.internal/', 'http://printer.home.arpa/',
    'http://[::ffff:192.168.1.1]/', 'http://[fd12:3456::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://100.64.0.1/', 'http://100.127.255.254/',
    // Every trailing dot names the same host, and a name with an empty label is no public name.
    'http://router../', 'http://localhost../', 'http://nas.lan.../', 'http://a..example.com/', 'http://.example.com/', 'http://..../',
    // Site-local IPv6, and the IPv4-compatible and other addresses of ::/96.
    'http://[fec0::1]/', 'http://[feff:1::2]/', 'http://[::7f00:1]/', 'http://[::127.0.0.1]/', 'http://[::a00:1]/', 'http://[::1:2]/', 'http://[0:0:0:0:0:0:c0a8:101]/'])
    assert.throws(() => assistantWebUrl(local), /lokala nätverket/, local);
  for (const mail of ['https://mail.google.com../', 'https://outlook.office.com.../mail/'])
    assert.throws(() => assistantWebUrl(mail, true), /Mejl och kalender/, `${mail} is the mail service`);
  for (const open of ['https://example.com/', 'https://www.boxed.com/', 'https://test.com/', 'https://home.se/', 'https://intranet.example/', 'http://100.63.255.255/', 'http://100.128.0.1/', 'http://93.184.216.34/', 'http://[2001:db8::1]/',
    'https://example.com./', 'http://[2606:4700::1111]/', 'http://[1::7f00:1]/'])
    assert.equal(assistantWebUrl(open), new URL(open).href, `${open} is a public address`);
  assert.throws(() => assistantWebUrl('https://outlook.cloud.microsoft/mail/', true), /Mejl och kalender/, 'mail stays blocked even for fixtures');
  // The same host is a readable Outlook account address for mail tasks, with the same route rules.
  const outlookAccount = { id: 'outlook-new', provider: 'outlook', label: 'Outlook', email: 'owner@example.test', url: 'https://outlook.cloud.microsoft/mail/', enabled: true };
  assert.equal(validateAssistantAccount(outlookAccount).url, 'https://outlook.cloud.microsoft/mail/');
  assert.equal(assistantUrl(outlookAccount, 'https://outlook.cloud.microsoft/mail/inbox/id/AAAB'), 'https://outlook.cloud.microsoft/mail/inbox/id/AAAB');
  assert.throws(() => assistantUrl(outlookAccount, 'https://outlook.cloud.microsoft/people/'), /Endast Outlooks/);
  assert.throws(() => assistantUrl(outlookAccount, 'https://outlook.cloud.microsoft/mail/deleteitems/delete'), /ändra kontot/);
  assert.throws(() => assistantUrl({ ...outlookAccount, provider: 'gmail' }, 'https://outlook.cloud.microsoft/mail/'), /tillåtna/, 'still bound to its own provider');
  assert.match(assistantWebSearchUrl('pris på el'), /^https:\/\/html\.duckduckgo\.com\/html\/\?q=pris%20p%C3%A5%20el/);

  // One tool list per level, identical for every backend; tasks never get web tools.
  assert.deepEqual(assistantWebToolNames('off'), []);
  assert.deepEqual(assistantWebToolNames('read'), ['web_search', 'web_open', 'web_read', 'web_find', 'web_scroll']);
  assert.deepEqual(assistantWebToolNames('act'), ['web_search', 'web_open', 'web_read', 'web_find', 'web_scroll', 'web_click', 'web_fill', 'web_handover', 'chat_profile'], "the user's own details only where forms are filled");
  // Mail tasks: at most the read tools, only when chosen, never in a send and only manual runs unless "all".
  const mailTools = assistantWorkerToolNames(false, 'off');
  assert(!mailTools.some(name => name.startsWith('web_')));
  assert.deepEqual(assistantWorkerToolNames(false, 'read'), [...mailTools, ...assistantWebToolNames('read')]);
  assert.deepEqual(assistantWorkerToolNames(false, 'act'), [...mailTools, ...assistantWebToolNames('read')], 'a task never clicks or fills on the web');
  for (const level of ['off', 'read', 'act']) {
    assert(!assistantWorkerToolNames(false, level).some(name => name === 'chat_profile' || name === 'watch_report'), `a mail task never reads the profile or reports a watch (${level})`);
    assert(!assistantWorkerToolNames(true, level).includes('watch_report'), `chat never reports a watch (${level})`);
    assert.equal(assistantWorkerToolNames(true, level).includes('chat_profile'), level === 'act', `chat_profile only on act (${level})`);
  }
  // A watch: its context, the read tools and its report; never clicks, fills, mail or chat tools.
  assert.deepEqual(assistantWorkerToolNames('watch', 'read'), ['workflow_context', 'web_search', 'web_open', 'web_read', 'web_find', 'web_scroll', 'watch_report']);
  assert.deepEqual(assistantWorkerToolNames('watch', 'act'), assistantWatchToolNames, 'the chat level never widens a watch');
  assert.equal(assistantWorkerMode('1'), true); assert.equal(assistantWorkerMode('watch'), 'watch');
  for (const value of [undefined, '', 'WATCH', '0', 'true']) assert.equal(assistantWorkerMode(value), false);
  {
    const codex = assistantCodexArgs(directory, directory, undefined, 'watch', 'read'), entry = codex.find(arg => arg.startsWith('mcp_servers.tabai_assistant.enabled_tools='));
    assert.deepEqual(JSON.parse(entry.slice(entry.indexOf('=') + 1)), assistantWatchToolNames, 'Codex receives exactly the watch list');
    assert(codex.some(arg => arg.startsWith('mcp_servers.tabai_assistant.env_vars=') && arg.includes('TABAI_ASSISTANT_CHAT') && arg.includes('TABAI_ASSISTANT_WEB')));
    const claude = assistantClaudeArgs('/tmp/config.json', undefined, 'watch', 'read');
    assert.deepEqual(claude[claude.indexOf('--allowedTools') + 1].split(',').map(name => name.replace('mcp__tabai_assistant__', '')), assistantWatchToolNames, 'Claude receives exactly the watch list');
    assert.equal(assistantClaudeMcpConfig(directory, 's', 'x', 'watch', 'read').mcpServers.tabai_assistant.env.TABAI_ASSISTANT_CHAT, 'watch');
    assert.equal(assistantClaudeMcpConfig(directory, 's', 'x', true, 'read').mcpServers.tabai_assistant.env.TABAI_ASSISTANT_CHAT, '1');
    assert.equal(assistantClaudeMcpConfig(directory, 's', 'x', false, 'read').mcpServers.tabai_assistant.env.TABAI_ASSISTANT_CHAT, undefined);
    assert.match(ASSISTANT_WATCH_PROMPT, /Börja med workflow_context[\s\S]*Avsluta alltid med watch_report[\s\S]*kan inte klicka, fylla i, logga in/);
  }
  const run = (task, scheduled) => ({ task, ...(scheduled ? { scheduled } : {}) });
  assert.equal(assistantTaskWebLevel(undefined, run('check-mail')), 'off');
  assert.equal(assistantTaskWebLevel({ level: 'act', login: true }, run('check-mail')), 'off', 'the chat level alone never reaches tasks');
  assert.equal(assistantTaskWebLevel({ level: 'off', login: false, tasks: 'manual' }, run('check-mail')), 'read');
  assert.equal(assistantTaskWebLevel({ level: 'off', login: false, tasks: 'manual' }, run('check-mail', true)), 'off', 'manual excludes unattended scheduled checks');
  assert.equal(assistantTaskWebLevel({ level: 'off', login: false, tasks: 'all' }, run('my-day', true)), 'read');
  assert.equal(assistantTaskWebLevel({ level: 'act', login: true, tasks: 'all' }, run('send')), 'off', 'a send never has web tools');
  assert.equal(assistantTaskPrompt('off'), ASSISTANT_PROMPT, 'without web the task policy is unchanged');
  assert.match(assistantTaskPrompt('read'), /WEBB \(söka och läsa\)[\s\S]*öppna aldrig länkar från mejl/);
  assert.equal(assistantWorkerWebLevel('act'), 'act'); assert.equal(assistantWorkerWebLevel('read'), 'read');
  for (const value of [undefined, '', 'ACT', 'all', '1']) assert.equal(assistantWorkerWebLevel(value), 'off');
  for (const level of ['off', 'read', 'act']) {
    const expected = assistantWorkerToolNames(true, level);
    const codex = assistantCodexArgs(directory, directory, undefined, true, level);
    const entry = codex.find(arg => arg.startsWith('mcp_servers.tabai_assistant.enabled_tools='));
    const enabled = JSON.parse(entry.slice(entry.indexOf('=') + 1));
    assert.deepEqual(enabled, expected, `Codex receives exactly the ${level} list`);
    assert.equal(codex.some(arg => arg.startsWith('mcp_servers.tabai_assistant.env_vars=') && arg.includes('TABAI_ASSISTANT_WEB')), level !== 'off');
    assert(codex.includes('web_search="disabled"'), "Codex's own web search stays off");
    const claude = assistantClaudeArgs('/tmp/config.json', undefined, true, level);
    assert.deepEqual(claude[claude.indexOf('--allowedTools') + 1].split(',').map(name => name.replace('mcp__tabai_assistant__', '')), expected, `Claude receives exactly the ${level} list`);
    assert.equal(claude[claude.indexOf('--tools') + 1], '', "Claude's own tools stay off");
    assert.equal(assistantClaudeMcpConfig(directory, 's', 'x', true, level).mcpServers.tabai_assistant.env.TABAI_ASSISTANT_WEB, level === 'off' ? undefined : level);
    const task = assistantClaudeArgs('/tmp/config.json', undefined, false, level);
    assert.deepEqual(task[task.indexOf('--allowedTools') + 1].split(',').map(name => name.replace('mcp__tabai_assistant__', '')), assistantWorkerToolNames(false, level), `Claude tasks receive the ${level} task list`);
    const codexTask = assistantCodexArgs(directory, directory, undefined, false, level), taskEntry = codexTask.find(arg => arg.startsWith('mcp_servers.tabai_assistant.enabled_tools='));
    assert.deepEqual(JSON.parse(taskEntry.slice(taskEntry.indexOf('=') + 1)), assistantWorkerToolNames(false, level), `Codex tasks receive the ${level} task list`);
  }
  // The real worker (shared by local inference and Berget) lists the same names.
  for (const level of ['off', 'read', 'act']) {
    const client = new Client({ name: 'tabai-web-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/assistant-worker.mjs')],
      env: { TABAI_ASSISTANT_SOCKET: join(directory, 'unused'), TABAI_ASSISTANT_SECRET: 'unused', TABAI_ASSISTANT_CHAT: '1', ...(level === 'off' ? {} : { TABAI_ASSISTANT_WEB: level }) }, stderr: 'ignore' }));
    try { assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), assistantWorkerToolNames(true, level)); }
    finally { await client.close(); }
  }
  {
    const client = new Client({ name: 'tabai-web-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/assistant-worker.mjs')],
      env: { TABAI_ASSISTANT_SOCKET: join(directory, 'unused'), TABAI_ASSISTANT_SECRET: 'unused', TABAI_ASSISTANT_CHAT: 'watch', TABAI_ASSISTANT_WEB: 'read' }, stderr: 'ignore' }));
    try { assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), assistantWatchToolNames, 'the worker lists exactly the watch tools'); }
    finally { await client.close(); }
  }
  assert.match(assistantChatPrompt({ level: 'off', login: false }), /Webbåtkomst är avstängd/);
  assert.match(assistantChatPrompt({ level: 'read', login: false }), /inte klicka eller fylla i/);
  assert.match(assistantChatPrompt({ level: 'act', login: false }), /approvalRequired[\s\S]*Inloggning är avstängd/);
  assert.match(assistantChatPrompt({ level: 'act', login: true }), /fyller själv i lösenordet/);
  assert.match(assistantChatPrompt({ level: 'act', login: false }), /chat_profile/, 'act explains Mina uppgifter');
  assert.doesNotMatch(assistantChatPrompt({ level: 'read', login: false }), /chat_profile/);
  assert.match(assistantChatPrompt({ level: 'read', login: false }), /kind watch/, 'with web on, the chat can propose a watch');
  assert.doesNotMatch(assistantChatPrompt({ level: 'off', login: false }), /kind watch/);

  // Bing's result links: the target behind ck/a is decoded; anything else stays a Bing link.
  const bing = target => `https://www.bing.com/ck/a?!&&p=abc123&ptn=3&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`;
  assert.equal(assistantBingResultUrl(bing('https://example.com/el?pris=1')), 'https://example.com/el?pris=1');
  assert.equal(assistantBingResultUrl('https://example.com/direct'), 'https://example.com/direct');
  assert.equal(assistantBingResultUrl(bing('javascript:alert(1)')), bing('javascript:alert(1)'), 'a non-http target is not decoded');
  assert.equal(assistantBingResultUrl('https://www.bing.com/ck/a?u=zz'), 'https://www.bing.com/ck/a?u=zz');
  const lookalike = 'https://evil.example/ck/a?u=a1' + Buffer.from('https://x.example/').toString('base64url');
  assert.equal(assistantBingResultUrl(lookalike), lookalike, 'only Bing wraps links');
  assert.match(assistantWebBingUrl('pris på el'), /^https:\/\/www\.bing\.com\/search\?q=pris%20p%C3%A5%20el$/);

  // Sender lookup: an organization's domain, never a personal mailbox provider.
  assert.equal(assistantLookupDomain('Anna@Foretaget.se'), 'foretaget.se');
  assert.equal(assistantLookupDomain('info@kommun.stockholm.se'), 'kommun.stockholm.se');
  for (const address of ['kim@gmail.com', 'kim@hotmail.se', 'kim@outlook.com', 'kim@live.se', 'kim@icloud.com', 'kim@yahoo.co.uk', 'kim@proton.me', 'kim@protonmail.com', 'kim@telia.com', 'kim@me.com'])
    assert.throws(() => assistantLookupDomain(address), /privatpersoner/, address);
  for (const address of [undefined, '', 'Anna Andersson', 'anna@localhost', 'anna@router.local', 'a@b', 'anna@[127.0.0.1]', 'anna@fritz.box', 'anna@nas.lan']) assert.throws(() => assistantLookupDomain(address), AssistantWebError, String(address));

  // The host's verdict on a live element.
  const act = { level: 'act', login: false }, actLogin = { level: 'act', login: true };
  const element = values => ({ found: true, tag: 'button', type: 'button', role: '', text: '', label: '', autocomplete: '', name: '', href: null, inForm: false, formSearch: false,
    formHasPassword: false, formHasPayment: false, submit: false, pageHasPayment: false, consent: false, disabled: false, editable: false, ...values });
  const verdict = (operation, values, access = act) => classifyAssistantWebTarget(operation, element(values), access).kind;
  assert.equal(verdict('click', { tag: 'a', text: 'Läs mer', href: 'https://example.com/a' }, { level: 'read', login: false }), 'refuse', 'read level never clicks');
  assert.equal(verdict('click', { tag: 'a', text: 'Läs mer', href: 'https://example.com/a' }), 'allow');
  for (const text of ['Köp nu', 'Betala 499 kr', 'Slutför beställning', 'Bekräfta', 'Skicka', 'Boka tid', 'Place order', 'Pay now', 'Confirm purchase', 'Säg upp abonnemang', 'Radera',
    'Skriv under', 'Underteckna', 'Ta bort annons', 'Avboka', 'Avbeställ', 'Överför', 'Transfer', 'Publicera', 'Publish', 'Tweet', 'Ansök nu', 'Lägg beställningen', 'Beställa', 'Place your order', 'Complete checkout', 'Post'])
    assert.equal(verdict('click', { text }), 'approval', text);
  // Moderation words on any page; on an admin page every control button, while links still navigate.
  for (const text of ['Avvisa bild', 'Neka', 'Pausa medlem', 'Avregistrera', 'Spärra konto', 'Blockera', 'Inaktivera', 'Arkivera', 'Återkalla', 'Stäng av', 'Reject', 'Suspend user', 'Ban', 'Approve'])
    assert.equal(verdict('click', { text }), 'approval', text);
  assert.equal(verdict('click', { text: 'Avvisa alla', consent: true }), 'allow', 'a cookie banner still declines without a card');
  const admin = (values, url = 'https://eventpoolen.se/admin/pool') => classifyAssistantWebTarget('click', element(values), act, { admin: assistantWebAdminPage(url) }).kind;
  assert.equal(admin({ text: 'Visa' }), 'approval', 'any control button on an admin page');
  assert.equal(admin({ tag: 'input', type: 'checkbox', label: 'Markera' }), 'approval');
  assert.equal(admin({ tag: 'a', text: 'Bläcker', href: 'https://eventpoolen.se/admin/members/1' }), 'allow', 'links still navigate on an admin page');
  assert.equal(admin({ text: 'Visa' }, 'https://eventpoolen.se/pool'), 'allow', 'not an admin page');
  for (const url of ['https://admin.example.com/', 'https://example.com/wp-admin/edit.php', 'https://example.com/backoffice/orders', 'https://example.com/Admin']) assert.equal(assistantWebAdminPage(url), true, url);
  for (const url of ['https://example.com/administrera-inte-detta', 'https://example.com/badminton', 'not a url']) assert.equal(assistantWebAdminPage(url), false, url);
  for (const text of ['Godkänner villkoren', 'Köpvillkor', 'Visa betalningsalternativ', 'Fortsätt', 'Nästa bild'])
    assert.equal(verdict('click', { text }), 'allow', text);
  assert.equal(verdict('click', { text: 'Lägg i varukorg', submit: true, inForm: true }), 'allow', 'adding to a cart is not the purchase');
  assert.equal(verdict('click', { text: 'Gå vidare', submit: true, inForm: true }), 'approval', 'a submit of a non-search form');
  assert.equal(verdict('click', { text: 'Sök', submit: true, inForm: true, formSearch: true }), 'allow', 'a search form');
  assert.equal(verdict('click', { text: 'Fortsätt', pageHasPayment: true }), 'approval', 'any button on a payment page');
  assert.equal(verdict('click', { text: 'Godkänn alla kakor', consent: true }), 'allow', 'cookie banners');
  assert.equal(verdict('click', { text: 'Acceptera', consent: true }), 'allow');
  for (const text of ['Slutför köp', 'Bekräfta och betala', 'Skicka beställning']) assert.equal(verdict('click', { text, consent: true }), 'approval', `consent never hides “${text}”`);
  assert.equal(verdict('click', { text: 'Köp', consent: true, pageHasPayment: true }), 'approval', 'consent never hides a payment button');
  assert.equal(verdict('click', { text: 'OK', inDialog: true }), 'approval', 'a confirmation dialog');
  assert.equal(verdict('click', { text: 'OK' }), 'allow');
  assert.equal(verdict('click', { text: 'Köp', disabled: true }), 'refuse');
  assert.equal(verdict('click', { found: false }), 'refuse');
  assert.equal(verdict('click', { text: 'Logga in', submit: true, inForm: true, formHasPassword: true }, actLogin), 'refuse', 'the user submits a login');
  assert.equal(verdict('click', { tag: 'a', text: 'Glömt lösenord?', inForm: true, formHasPassword: true }, act), 'refuse', 'login forms stay closed while login is off');
  assert.equal(verdict('click', { tag: 'a', text: 'Glömt lösenord?', inForm: true, formHasPassword: true }, actLogin), 'allow');
  assert.equal(verdict('click', { text: 'Logga in', pageHasPassword: true }, actLogin), 'refuse', 'a login page without <form>');
  assert.equal(verdict('fill', { tag: 'input', type: 'email', pageHasPassword: true }, act), 'refuse', 'a login page without <form> while login is off');
  assert.equal(verdict('click', { text: 'Köp nu', inForm: true, pageHasPassword: true }, act), 'approval', 'a password elsewhere does not block other forms');
  assert.equal(verdict('fill', { tag: 'input', type: 'password' }, actLogin), 'refuse');
  assert.equal(verdict('fill', { tag: 'input', type: 'text', autocomplete: 'cc-number' }), 'refuse');
  assert.equal(verdict('fill', { tag: 'input', type: 'tel', name: 'cvc' }), 'refuse');
  assert.equal(verdict('fill', { tag: 'input', type: 'text', autocomplete: 'one-time-code' }), 'refuse');
  for (const values of [{ name: 'otp' }, { label: 'Engångskod' }, { label: 'Verifieringskod' }, { name: '2fa-code' }]) assert.equal(verdict('fill', { tag: 'input', type: 'text', ...values }), 'refuse', JSON.stringify(values));
  assert.equal(verdict('fill', { tag: 'input', type: 'text', name: 'postal_code', label: 'Postnummer' }), 'allow', 'an ordinary code field');
  assert.equal(verdict('fill', { tag: 'input', type: 'email', inForm: true, formHasPassword: true }, act), 'refuse');
  assert.equal(verdict('fill', { tag: 'input', type: 'email', inForm: true, formHasPassword: true }, actLogin), 'allow', 'the user name with login on');
  assert.equal(verdict('fill', { tag: 'input', type: 'email', label: 'Ange giltig e-postadress' }), 'allow');
  assert.equal(verdict('fill', { tag: 'input', type: 'hidden' }), 'refuse');
  assert.equal(verdict('fill', { tag: 'div', editable: true }), 'allow');
  assert.equal(verdict('fill', { tag: 'div' }), 'refuse');

  // A minimal genuine PDF, as a printed receipt.
  const pdf = () => {
    const stream = 'BT /F1 24 Tf 50 700 Td (KVITTO 4281) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    const chunks = [Buffer.from('%PDF-1.4\n')], offsets = []; let length = chunks[0].length;
    objects.forEach((object, i) => { offsets.push(length); const chunk = Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`); chunks.push(chunk); length += chunk.length; });
    return Buffer.concat([...chunks, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`)]);
  };

  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic card image'), Buffer.from([0xff, 0xd9])]);
  // A fake Tabai session: tabs, page state and every dispatched call.
  const fake = (options = {}) => {
    const calls = [], state = { tabs: [], next: 40, amount: '499 kr', documentId: 'doc-1', element: { text: 'Köp nu' }, form: [], results: options.results ?? [{ title: 'Elpris', url: 'https://example.com/el', snippet: 'Dagens pris' }], bing: options.bing ?? [], pdf: { ok: true, path: '/tmp/doc.pdf', bytes: 3 }, incognito: options.incognito ?? true };
    const transport = {
      closed: false,
      async call(name, args = {}) {
        calls.push({ name, args });
        if (name === 'tabs_context_mcp') {
          if (args.incognito && options.noIncognito) throw new Error('INCOGNITO_UNAVAILABLE: Tabai is not allowed in incognito windows.');
          if (args.createIfEmpty && !state.tabs.length) state.tabs.push({ tabId: state.next++, url: 'about:blank', title: '', incognito: !!args.incognito && !options.oldExtension });
          return { tabs: state.tabs.map(tab => ({ ...tab })) };
        }
        if (name === 'tabs_create_mcp') { const tab = { tabId: state.next++, url: 'about:blank', title: '', incognito: state.incognito }; state.tabs.push(tab); return { tabId: tab.tabId }; }
        if (name === 'tabs_close_mcp') { state.tabs = state.tabs.filter(tab => tab.tabId !== args.tabId); return { ok: true }; }
        // A server redirect: the tab ends on the table's address, as Chrome would report it.
        if (name === 'navigate') { const tab = state.tabs.find(item => item.tabId === args.tabId); tab.url = options.redirects?.[args.url] ?? args.url; tab.title = 'Sida'; return { ok: true }; }
        if (name === 'javascript_tool') {
          if (args.text.includes('__tabaiIsolationProbe')) {
            if (args.text.startsWith('(globalThis.__tabaiIsolationProbe=')) state.probe = JSON.parse(args.text.slice('(globalThis.__tabaiIsolationProbe='.length, args.text.lastIndexOf(',')));
            // A current extension evaluates `world: 'isolated'` apart; an old one ignores it.
            return args.text.startsWith('globalThis.__tabaiIsolationProbe') ? (args.world === 'isolated' && !options.oldWorld ? null : state.probe) : true;
          }
          // The card image's area: the button and its form in page coordinates.
          if (args.text.includes('previewMargin')) return options.region === undefined ? [0, 100, 600, 400] : options.region;
          if (args.text.includes('b_algo')) return state.bing;
          if (args.text.includes('result__a')) return state.results;
          if (args.text.includes('Ikryssad')) return structuredClone(state.form);
          if (args.text.includes('data-ccmcp-ref')) return element(state.element);
          if (args.text.includes('att betala')) return state.amount;
          throw new Error('unexpected script');
        }
        if (name === 'resolve_target') return { ref: 'opaque-1', documentId: state.documentId };
        if (name === 'computer') { if (options.clickFails) throw new Error('transport closed'); return { ok: true }; }
        if (name === 'get_page_text') return { text: 'Kassa. Att betala 499 kr. ' + 'x'.repeat(13_000) };
        if (name === 'read_page') return { elements: '[ref_7] button "Köp nu"' };
        if (name === 'form_input' || name === 'wait_for' || name === 'tab_switch' || name === 'find') return { ok: true, matches: '' };
        if (name === 'print_to_pdf') return state.pdf;
        if (name === 'screenshot') {
          if (options.shot === 'hang') return new Promise(() => {});
          if (options.shot === 'fail') throw new Error('capture failed');
          if (options.shot === 'navigates') state.documentId = 'doc-9';
          return options.shot === 'png' ? { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' } : { base64: JPEG.toString('base64'), mimeType: 'image/jpeg' };
        }
        throw new Error(`unexpected ${name}`);
      },
      async close() { this.closed = true; },
    };
    return { transport, calls, state, web: new AssistantWeb(transport, options.access ?? { level: 'act', login: false }, !(options.access ?? { login: false }).login || !!options.web?.strictIncognito, options.windowId, options.web) };
  };
  {
    const { web, calls } = fake();
    const searched = await web.search('elpris idag');
    assert.deepEqual(searched.results.map(item => item.url), ['https://example.com/el']);
    assert.deepEqual(calls[0], { name: 'tabs_context_mcp', args: { createIfEmpty: true, incognito: true } }, 'login off starts an incognito group');
    assert.match(calls.find(call => call.name === 'navigate').args.url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=elpris%20idag/);
    await web.search('igen');
    assert.equal(calls.filter(call => call.name === 'tabs_create_mcp').length, 0, 'searches reuse one tab');
    const opened = await web.open('https://shop.example/kassa');
    assert.equal(opened.url, 'https://shop.example/kassa'); assert.equal(opened.text.length, 12_000); assert.equal(opened.nextOffset, 12_000); assert.equal(opened.incognito, true);
    assert.equal((await web.read(opened.tabId, 12_000)).nextOffset, undefined, 'the last chunk ends the text');
    await assert.rejects(web.open('https://mail.google.com/mail/u/0/'), /Mejl och kalender/);
    assert.equal(calls.filter(call => call.name === 'navigate' && call.args.url.includes('mail.google')).length, 0, 'a mail address is never navigated');
    await assert.rejects(web.read(999), /hör inte till/, 'foreign tabs are refused');
    assert.deepEqual(web.drainActivity(), ['Sökte med DuckDuckGo: elpris idag', 'Sökte med DuckDuckGo: igen', 'Öppnade https://shop.example/kassa'], 'the activity names the search engine');
    const reopened = await web.open('https://shop.example/kassa', 1);
    assert.notEqual(reopened.tabId, 1, 'an unknown reuse id opens a new owned tab, never tab 1');
  }
  {
    // A public address that redirects into the local network or to a mail service is refused
    // where it lands: the final address is checked before any page text is read.
    const redirects = {
      'https://short.example/nas': 'http://nas/admin/', 'https://short.example/router': 'http://192.168.1.1/', 'https://short.example/box': 'http://fritz.box/',
      'https://short.example/hole': 'https://pi.hole/admin/', 'https://short.example/home': 'http://router.home/', 'https://short.example/mapped': 'http://[::ffff:c0a8:101]/',
      'https://short.example/cgnat': 'http://100.64.0.1/', 'https://short.example/mail': 'https://mail.google.com/mail/u/0/', 'https://short.example/zoho': 'https://mail.zoho.eu/zm/',
      'https://short.example/public': 'https://www.example.com/landing',
    };
    for (const [from, to] of Object.entries(redirects).filter(([, to]) => !to.startsWith('https://www.example.com'))) {
      const { web, calls } = fake({ redirects });
      await assert.rejects(web.open(from), /mail\.|zoho/.test(to) ? /Mejl och kalender/ : /lokala nätverket/, `${from} -> ${to}`);
      assert.equal(calls.filter(call => call.name === 'navigate').length, 1, `${from}: one navigation, never a second attempt`);
      assert.equal(calls.filter(call => ['get_page_text', 'read_page'].includes(call.name)).length, 0, `${from} -> ${to}: no page text is read`);
    }
    const { web, calls } = fake({ redirects });
    const landed = await web.open('https://short.example/public');
    assert.equal(landed.url, 'https://www.example.com/landing', 'a public landing page is read');
    assert.equal(calls.filter(call => call.name === 'get_page_text').length, 1);
  }
  {
    const { web, calls } = fake({ noIncognito: true });
    const opened = await web.open('https://example.com/');
    assert.equal(opened.incognito, false); assert.match(opened.notice, /Tillåt i inkognito/, 'the fallback says that sign-ins are visible');
    assert.deepEqual(calls.filter(call => call.name === 'tabs_context_mcp').slice(0, 2).map(call => call.args), [{ createIfEmpty: true, incognito: true }, { createIfEmpty: true }]);
  }
  {
    // An extension that ignores `world` would run the checks in the page's world: the probe stops them.
    const old = fake({ oldWorld: true });
    const { tabId } = await old.web.open('https://shop.example/kassa');
    await assert.rejects(old.web.click(tabId, 'ref_7'), /äldre version som inte kan isolera/);
    assert.equal(old.calls.filter(call => call.name === 'computer').length, 0, 'nothing is clicked without isolation');
    const current = fake();
    const opened = await current.web.open('https://shop.example/kassa');
    await current.web.click(opened.tabId, 'ref_7'); await current.web.click(opened.tabId, 'ref_7');
    assert.equal(current.calls.filter(call => call.name === 'javascript_tool' && call.args.text.startsWith('(globalThis.__tabaiIsolationProbe=')).length, 1, 'the probe runs once per session');
  }
  {
    // Mail tasks: incognito or nothing, and only their own search results.
    const strict = fake({ noIncognito: true, access: { level: 'read', login: false }, web: { strictIncognito: true, searchOnly: true } });
    await assert.rejects(strict.web.search('företag ab'), /bara i ett eget inkognitofönster/);
    assert(!strict.calls.some(call => call.name === 'tabs_context_mcp' && call.args.createIfEmpty && !call.args.incognito), 'no fallback to a normal window');
    const old = fake({ oldExtension: true, access: { level: 'read', login: false }, web: { strictIncognito: true, searchOnly: true } });
    await assert.rejects(old.web.search('företag ab'), /bara i ett eget inkognitofönster/, 'an extension without the option is caught');
    assert(old.calls.some(call => call.name === 'tabs_close_mcp'), 'the normal window it opened is closed');
    const task = fake({ access: { level: 'read', login: false }, web: { strictIncognito: true, searchOnly: true } });
    await task.web.search('elpris');
    await assert.rejects(task.web.open('https://evil.example/magic-login?token=1'), /aldrig länkar från mejl/);
    assert.equal((await task.web.open('https://example.com/el')).url, 'https://example.com/el', 'a search result opens');
    // Routines: incognito or nothing too, said in the routine's own words, and any public page opens.
    const routine = fake({ noIncognito: true, access: { level: 'read', login: false }, web: { strictIncognito: true, routine: true } });
    await assert.rejects(routine.web.open('https://example.com/el'), /^AssistantWebError: Rutinen kunde inte köras, eftersom Tabai inte får användas i inkognito\. Rutiner använder webben bara i ett eget inkognitofönster/);
    assert(!routine.calls.some(call => call.name === 'tabs_context_mcp' && call.args.createIfEmpty && !call.args.incognito), 'a routine never falls back to the normal window');
    assert(!routine.calls.some(call => call.name === 'navigate'), 'nothing is opened');
    const oldRoutine = fake({ oldExtension: true, access: { level: 'read', login: false }, web: { strictIncognito: true, routine: true } });
    await assert.rejects(oldRoutine.web.search('elpris'), /Rutinen kunde inte köras/, 'an extension without the option is caught');
    assert(oldRoutine.calls.some(call => call.name === 'tabs_close_mcp') && !oldRoutine.calls.some(call => call.name === 'navigate'), 'the normal window it opened is closed before any page loads');
    const reading = fake({ access: { level: 'read', login: false }, web: { strictIncognito: true, routine: true } });
    const page = await reading.web.open('https://example.com/nyheter');
    assert.deepEqual([page.url, page.incognito], ['https://example.com/nyheter', true], 'a routine opens a public page without searching first, in incognito');
    const chatOld = fake({ oldExtension: true });
    assert.equal((await chatOld.web.open('https://example.com/')).incognito, false, 'chat falls back honestly for an old extension');
    assert(chatOld.web.drainActivity().some(line => /Tillåt i inkognito/.test(line)), 'the fallback is in the visible activity');
  }
  {
    const { web, state, calls } = fake();
    const opened = await web.open('https://example.com/');
    state.tabs.find(tab => tab.tabId === opened.tabId).incognito = false;
    await assert.rejects(web.read(opened.tabId), /Inkognitofönstret har stängts/);
    assert(calls.some(call => call.name === 'tabs_close_mcp'), 'a non-incognito tab is closed, never read');
  }
  {
    const { web, state, calls } = fake({ access: { level: 'act', login: true }, windowId: 7 });
    const { tabId } = await web.open('https://shop.example/kassa');
    assert.deepEqual(calls[0].args, { createIfEmpty: true, createWindowId: 7 }, 'login on uses the panel window');
    state.element = { tag: 'input', type: 'text', label: 'Namn' };
    await web.fill(tabId, 'ref_3', 'Kim Svensson');
    state.element = { tag: 'input', type: 'password' };
    await assert.rejects(web.fill(tabId, 'ref_4', 'hemligt'), /fyller användaren i själv/);
    assert.equal(calls.filter(call => call.name === 'form_input').length, 1, 'a password is never filled');
    state.element = { text: 'Köp nu' }; state.form = [{ label: 'Namn', value: 'Kim Svensson' }, { label: 'Leverans', value: 'Hemleverans' }, { label: 'Kortnummer', value: '•••' }];
    const first = await web.click(tabId, 'ref_7');
    assert(first.approval, 'a final step returns an approval');
    assert.equal(calls.filter(call => call.name === 'computer').length, 0, 'nothing is clicked before approval');
    assert.deepEqual(first.approval.fields, state.form, 'the card shows every choice the submit sends, secrets masked');
    assert.match(first.approval.state, /^[0-9a-f]{64}$/);
    assert.equal(first.approval.amount, '499 kr'); assert.equal(first.approval.action, 'Köp nu'); assert.equal(first.approval.site, 'shop.example');
    await assert.rejects(web.approve({ ...first.approval, action: 'Annat' }), /gäller inte längre/, 'a tampered card is refused');
    state.amount = '599 kr';
    await assert.rejects(web.approve(first.approval), error => error instanceof AssistantWebError && !error.uncertain && /Beloppet/.test(error.message));
    state.amount = '499 kr'; state.documentId = 'doc-2';
    await assert.rejects(web.approve(first.approval), /Inget har klickats/);
    state.documentId = 'doc-1';
    const done = await web.approve(first.approval);
    assert.equal(done.url, 'https://shop.example/kassa');
    assert.equal(calls.filter(call => call.name === 'computer').length, 1, 'exactly one click after approval');
    await assert.rejects(web.approve(first.approval), /redan använts/);
    assert.equal(calls.filter(call => call.name === 'computer').length, 1, 'an approval is never replayed');
    // Any later agent step on the tab cancels the waiting card.
    const second = await web.click(tabId, 'ref_7');
    state.element = { tag: 'input', type: 'radio', label: 'Expressleverans' };
    await web.click(tabId, 'ref_5');
    state.element = { text: 'Köp nu' };
    await assert.rejects(web.approve(second.approval), /gäller inte längre/, 'a click after the card cancels it');
    const third = await web.click(tabId, 'ref_7');
    state.element = { tag: 'input', type: 'text', label: 'Namn' };
    await web.fill(tabId, 'ref_3', 'Någon annan');
    state.element = { text: 'Köp nu' };
    await assert.rejects(web.approve(third.approval), /gäller inte längre/, 'a fill after the card cancels it');
    // A choice changed by the page or the user is caught by the state check.
    const fourth = await web.click(tabId, 'ref_7');
    state.form = [{ label: 'Namn', value: 'Någon annan' }, { label: 'Leverans', value: 'Express' }];
    await assert.rejects(web.approve(fourth.approval), /Valen eller uppgifterna/);
    const fifth = await web.click(tabId, 'ref_7');
    web.access = { level: 'read', login: true };
    await assert.rejects(web.approve(fifth.approval), /tillåter inte längre/);
    assert.equal(calls.filter(call => call.name === 'computer' && call.args.action === 'left_click' && call.args.tabId === tabId && call.args.ref === 'opaque-1').length, 2, 'only the approved purchase and the radio click were dispatched');
  }
  {
    // The card's image is taken with the extension's own screenshot tool and is never part of the approval.
    const { web, calls, state } = fake();
    const { tabId } = await web.open('https://shop.example/kassa');
    state.element = { text: 'Köp nu' };
    const pending = await web.click(tabId, 'ref_7');
    assert.ok(pending.preview?.bytes.equals(JPEG) && pending.preview.mimeType === 'image/jpeg', 'a final step comes with an image of its button');
    assert.deepEqual(calls.find(call => call.name === 'screenshot').args, { tabId, region: [0, 100, 600, 400], format: 'jpeg', quality: 80, maxWidth: 1200 });
    assert.equal(calls.find(call => call.name === 'javascript_tool' && call.args.text.includes('previewMargin')).args.world, 'isolated', 'the area is read in the isolated world');
    assert.equal('previewFileId' in pending.approval, false, 'the issued approval carries no image');
    assert.equal(calls.filter(call => call.name === 'computer').length, 0, 'taking the image clicks nothing');
    // With the card's image id, every binding check still runs before the one click.
    const shown = { ...pending.approval, previewFileId: randomUUID() };
    state.amount = '599 kr';
    await assert.rejects(web.approve(shown), /Beloppet/, 'a changed amount is caught with an image on the card');
    state.amount = '499 kr';
    await assert.rejects(web.approve({ ...shown, state: 'b'.repeat(64) }), /gäller inte längre/, 'an image id never lets a different card through');
    state.form = [{ label: 'Namn', value: 'Någon annan' }];
    await assert.rejects(web.approve(shown), /Valen eller uppgifterna/, 'changed choices are caught with an image on the card');
    state.form = [];
    await web.approve(shown);
    assert.equal(calls.filter(call => call.name === 'computer').length, 1, 'exactly one click');
    await assert.rejects(web.approve(pending.approval), /redan använts/, 'with or without its image id, an approval is used once');
  }
  {
    // Any failure gives a card without an image: a failed capture, a wrong area or format, a changed document.
    for (const [options, why] of [[{ shot: 'fail' }, 'a failed capture'], [{ region: [0, 0, 5000, 400] }, 'an area larger than 1200×900'], [{ region: null }, 'no element'],
      [{ shot: 'navigates' }, 'a document that changed during the capture'], [{ shot: 'png' }, 'anything but the JPEG asked for']]) {
      const { web, calls } = fake(options);
      const { tabId } = await web.open('https://shop.example/kassa');
      const pending = await web.click(tabId, 'ref_7');
      assert.ok(pending.approval && !('preview' in pending), why);
      if (options.region !== undefined) assert.equal(calls.some(call => call.name === 'screenshot'), false, `${why}: nothing is captured`);
    }
    // A capture that never answers holds the card back for three seconds at most.
    assert.equal(ASSISTANT_WEB_PREVIEW_MS, 3_000);
    const { web } = fake({ shot: 'hang' });
    const { tabId } = await web.open('https://shop.example/kassa');
    const started = Date.now(), pending = await web.click(tabId, 'ref_7'), waited = Date.now() - started;
    assert.ok(pending.approval && !pending.preview && waited >= 2_900 && waited < 4_500, `the card came after ${waited} ms`);
  }
  {
    const { web, state } = fake({ access: { level: 'act', login: false }, clickFails: true });
    const { tabId } = await web.open('https://shop.example/kassa');
    state.element = { text: 'Betala' };
    const pending = await web.click(tabId, 'ref_9');
    await assert.rejects(web.approve(pending.approval), error => error instanceof AssistantWebError && error.uncertain, 'a failed dispatch is uncertain');
  }


  {
    // Every host check runs in the isolated world, so the page's own scripts cannot change what it reads.
    const { web, calls, state } = fake({ access: { level: 'act', login: true } });
    const { tabId } = await web.open('https://shop.example/kassa');
    await web.search('laddkabel');
    state.element = { tag: 'input', type: 'text', label: 'Namn' };
    await web.fill(tabId, 'ref_3', 'Kim');
    state.element = { text: 'Köp nu' };
    const pending = await web.click(tabId, 'ref_7');
    await web.approve(pending.approval);
    const scripts = calls.filter(call => call.name === 'javascript_tool' && !call.args.text.includes('__tabaiIsolationProbe'));
    assert(scripts.length >= 6, 'search, element, amount and form scripts ran');
    assert(scripts.every(call => call.args.world === 'isolated'), 'no host check runs in the page world');
    const pageWorld = calls.filter(call => call.name === 'javascript_tool' && call.args.world !== 'isolated').map(call => call.args.text);
    assert(pageWorld.length === 2 && pageWorld.every(text => /^\((globalThis\.__tabaiIsolationProbe=|delete globalThis\.__tabaiIsolationProbe)/.test(text)), 'only the isolation probe sets and removes its marker in the page world');
  }
  {
    // DuckDuckGo with no results: one Bing search, decoded and under the same address filter.
    const wrap = target => `https://www.bing.com/ck/a?!&&p=1&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`;
    const { web, calls } = fake({ results: [], bing: [
      { title: 'Elpris idag', url: wrap('https://elpriset.example/idag'), snippet: 'Spotpris' },
      { title: 'Router', url: wrap('http://192.168.1.1/'), snippet: 'lokal' },
      { title: 'Mejl', url: wrap('https://mail.google.com/mail/u/0/'), snippet: 'mejl' },
      { title: 'Direkt', url: 'https://direkt.example/', snippet: '' },
    ] });
    const searched = await web.search('elpris idag');
    assert.equal(searched.engine, 'Bing');
    assert.deepEqual(searched.results.map(result => result.url), ['https://elpriset.example/idag', 'https://direkt.example/'], 'local and mail targets are filtered like DuckDuckGo results');
    assert.deepEqual(calls.filter(call => call.name === 'navigate').map(call => call.args.url), [assistantWebSearchUrl('elpris idag'), assistantWebBingUrl('elpris idag')], 'Bing only after an empty DuckDuckGo page');
    assert.deepEqual(web.drainActivity(), ['Sökte med DuckDuckGo: elpris idag', 'Sökte med Bing: elpris idag'], 'the activity shows both engines');
    assert.equal((await web.open('https://elpriset.example/idag')).url, 'https://elpriset.example/idag');
    const both = fake({ bing: [{ title: 'Annat', url: 'https://other.example/', snippet: '' }] });
    assert.equal((await both.web.search('elpris')).engine, 'DuckDuckGo');
    assert.equal(both.calls.filter(call => call.name === 'navigate').length, 1, 'results from DuckDuckGo never trigger Bing');
    const none = fake({ results: [], bing: [] });
    const empty = await none.web.search('ingenting');
    assert.deepEqual(empty.results, []); assert.equal(empty.engine, 'Bing'); assert.match(empty.note, /inga läsbara träffar/);
  }
  {
    // A watch: its own address opens without a search; nothing else does; incognito or nothing.
    const watch = fake({ access: { level: 'read', login: false }, web: { strictIncognito: true, searchOnly: true, allowedUrls: ['https://shop.example/pris', 'http://127.0.0.1:9/'] } });
    assert.equal((await watch.web.open('https://shop.example/pris')).url, 'https://shop.example/pris');
    await assert.rejects(watch.web.open('https://shop.example/annat'), /Bevakningen kan bara öppna sin egen adress/);
    await assert.rejects(watch.web.open('http://127.0.0.1:9/'), /lokala nätverket/, 'an allowed local address is still refused');
    await watch.web.search('elpris');
    assert.equal((await watch.web.open('https://example.com/el')).url, 'https://example.com/el', 'its own search results open');
    const blocked = fake({ noIncognito: true, access: { level: 'read', login: false }, web: { strictIncognito: true, searchOnly: true, allowedUrls: [] } });
    await assert.rejects(blocked.web.search('elpris'), /Bevakningar använder webben bara i ett eget inkognitofönster/);
  }
  {
    // A turn that read a page the user shared reaches only that page's site: no search, and no
    // address, form or click elsewhere, so the page's text cannot leave with them.
    const { web, calls, state } = fake();
    state.element = { tag: 'input', type: 'text', label: 'Meddelande' };
    const elsewhere = await web.open('https://other.example/form');
    web.sharedPageOrigins = ['https://shop.example'];
    const message = /Den här turen har läst en delad sida\. Andra webbplatser öppnas i ett nytt meddelande, så att sidans innehåll inte kan följa med\./;
    const before = calls.length;
    await assert.rejects(web.search('order 4711'), message, 'no search at all');
    await assert.rejects(web.open('https://other.example/?q=order+4711'), message, 'no other site');
    await assert.rejects(web.open('http://shop.example/order'), message, 'another scheme is another site');
    await assert.rejects(web.fill(elsewhere.tabId, 'ref_7', 'Order 4711'), message, 'no form on another site');
    await assert.rejects(web.click(elsewhere.tabId, 'ref_7'), message, 'no click on another site');
    assert.equal(calls.slice(before).filter(call => ['navigate', 'form_input', 'computer'].includes(call.name)).length, 0, 'nothing was navigated, filled or clicked');
    const same = await web.open('https://shop.example/order/4711');
    assert.equal(same.url, 'https://shop.example/order/4711', 'the page\'s own site opens in the agent\'s own tab');
    assert.equal((await web.fill(same.tabId, 'ref_7', 'Fråga om leveransen')).filled, true, 'and its forms can be filled');
    web.sharedPageOrigins = ['https://shop.example', 'https://bank.example'];
    await assert.rejects(web.open('https://shop.example/order'), message, 'two shared sites leave none');
    web.sharedPageOrigins = [];
    assert.ok((await web.search('elpris')).results, 'a later turn searches again');
  }
  {
    // A receipt prints one of this session's own tabs; the PDF path is returned for the host to check.
    const { web, calls, state } = fake();
    const { tabId } = await web.open('https://shop.example/tack');
    assert.deepEqual(await web.receipt(tabId), { path: '/tmp/doc.pdf', bytes: 3 });
    assert.deepEqual(calls.filter(call => call.name === 'print_to_pdf').map(call => call.args), [{ tabId }]);
    await assert.rejects(web.receipt(999), /hör inte till/);
    state.pdf = { ok: true };
    await assert.rejects(web.receipt(tabId), /ingen PDF-fil/);
    assert(web.drainActivity().some(line => /PDF-kvitto: shop\.example/.test(line)));
  }
  {
    // The guided tools keep their own copies of the extension's page predicates:
    // autocomplete is a list of tokens, and a control in a disabled fieldset is
    // disabled. A small fake DOM runs the real page scripts, as they are injected.
    const { default: vm } = await import('node:vm');
    const control = /^(BUTTON|INPUT|SELECT|TEXTAREA|FIELDSET)$/;
    const disabledByFieldset = el => {
      for (let child = el, node = el.parentElement; node; child = node, node = node.parentElement)
        if (node.tagName === 'FIELDSET' && node.hasAttribute('disabled') && child !== node.children.find(item => item.tagName === 'LEGEND')) return true;
      return false;
    };
    const matchesCompound = (el, compound) => {
      let rest = compound.trim();
      const tag = /^[a-z][a-z0-9-]*/i.exec(rest);
      if (tag) { if (el.tagName !== tag[0].toUpperCase()) return false; rest = rest.slice(tag[0].length); }
      while (rest) {
        let part;
        if ((part = /^\[([\w-]+)(?:([\^*~]?=)"([^"]*)"(\s+i)?)?\]/.exec(rest))) {
          const value = el.getAttribute(part[1]);
          if (value === null) return false;
          if (part[2]) {
            const [have, want] = part[4] ? [value.toLowerCase(), part[3].toLowerCase()] : [value, part[3]];
            if (part[2] === '=' ? have !== want : part[2] === '^=' ? !have.startsWith(want) : part[2] === '*=' ? !have.includes(want) : !have.split(/\s+/).includes(want)) return false;
          }
        } else if ((part = /^:not\(([^()]*)\)/.exec(rest))) { if (matchesCompound(el, part[1])) return false; }
        else if ((part = /^:disabled/.exec(rest))) { if (!control.test(el.tagName) || !el.hasAttribute('disabled') && !disabledByFieldset(el)) return false; }
        else throw new Error(`the fake DOM cannot evaluate the selector ${compound}`);
        rest = rest.slice(part[0].length);
      }
      return true;
    };
    class FakeElement {
      constructor(tag, attrs = {}, children = [], text = '') {
        this.tagName = tag.toUpperCase(); this.attrs = attrs; this.children = children; this.parentElement = null; this.text = text;
        for (const child of children) child.parentElement = this;
      }
      getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
      hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
      get id() { return this.attrs.id ?? ''; }
      get className() { return this.attrs.class ?? ''; }
      get type() { return (this.attrs.type ?? (this.tagName === 'BUTTON' ? 'submit' : 'text')).toLowerCase(); }
      // The property reflects the element's own attribute only, as in a browser.
      get disabled() { return this.hasAttribute('disabled'); }
      get value() { return this.attrs.value ?? ''; }
      get form() { return this.closest('form'); }
      get labels() { return null; }
      get isContentEditable() { return false; }
      get innerText() { return [this.text, ...this.children.map(child => child.innerText)].filter(Boolean).join(' '); }
      matches(selector) { return selector.split(',').some(part => matchesCompound(this, part)); }
      closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
      getBoundingClientRect() { return { left: 0, top: 0, right: 120, bottom: 24, width: 120, height: 24 }; }
    }
    const el = (tag, attrs, children, text) => new FakeElement(tag, attrs, children, text);
    const inPage = (fn, ...children) => {
      const body = el('body', {}, children);
      const document = { body, querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), getElementById: id => body.querySelector(`[id="${id}"]`) };
      return (...args) => vm.runInContext(`(${fn.toString()})`, vm.createContext({ document }))(...args);
    };
    const shop = () => [el('form', { action: '/pay', method: 'post' }, [
      el('input', { 'aria-label': 'Namn', value: 'Kim Svensson', 'data-ccmcp-ref': 'ref_1' }),
      el('input', { 'aria-label': 'Kortfält', autocomplete: 'billing cc-number', value: '4111-2222', 'data-ccmcp-ref': 'ref_2' }),
      el('button', { 'data-ccmcp-ref': 'ref_3' }, [], 'Fortsätt'),
    ])];
    // Each item reports on its own, so one failure cannot hide another.
    const failures = [];
    const item = async (name, run) => {
      try { await run(); console.log(`  ✓ ${name}`); }
      catch (error) { failures.push(name); console.error(`  ✗ ${name}: ${error.message}`); }
    };
    await item('the fill refusal reads every autocomplete token', () => {
      const card = inPage(assistantWebElementScript, ...shop())('ref_2');
      assert.equal(card.autocomplete, 'billing cc-number', 'fixture: the page script reads the field');
      assert.equal(classifyAssistantWebTarget('fill', card, act).kind, 'refuse', 'a card field with a section token is never filled');
      for (const autocomplete of ['section-login one-time-code', 'billing cc-number', 'shipping new-password', 'section-a current-password'])
        assert.equal(classifyAssistantWebTarget('fill', { ...element({ tag: 'input', type: 'text' }), autocomplete }, act).kind, 'refuse', `fill refuses ${autocomplete}`);
      assert.equal(classifyAssistantWebTarget('fill', { ...element({ tag: 'input', type: 'text' }), autocomplete: 'section-a postal-code' }, act).kind, 'allow', 'an ordinary token is filled');
    });
    await item('the approval card masks a card number named by a section token', () => {
      // The page script's objects come from the fake page's realm; compare their data.
      assert.deepEqual(JSON.parse(JSON.stringify(inPage(assistantWebFormStateScript, ...shop())('ref_3'))), [{ label: 'Namn', value: 'Kim Svensson' }, { label: 'Kortfält', value: '•••' }]);
    });
    await item('a card field named by a section token makes the form a payment form', () => {
      const button = inPage(assistantWebElementScript, ...shop())('ref_3');
      assert.deepEqual([button.formHasPayment, button.pageHasPayment], [true, true]);
      assert.equal(classifyAssistantWebTarget('click', button, act).kind, 'approval');
    });
    const locked = () => [el('form', {}, [el('fieldset', { disabled: '' }, [
      el('legend', {}, [el('button', { type: 'button', 'data-ccmcp-ref': 'ref_4' }, [], 'Visa')]),
      el('button', { type: 'button', 'data-ccmcp-ref': 'ref_5' }, [], 'Lägg till'),
    ])]), el('button', { type: 'button', 'data-ccmcp-ref': 'ref_6' }, [], 'Mer')];
    await item('a control in a disabled fieldset counts as disabled', () => {
      const inFieldset = inPage(assistantWebElementScript, ...locked())('ref_5');
      assert.equal(inFieldset.disabled, true);
      assert.equal(classifyAssistantWebTarget('click', inFieldset, act).kind, 'refuse');
      assert.deepEqual([inPage(assistantWebElementScript, ...locked())('ref_4').disabled, inPage(assistantWebElementScript, ...locked())('ref_6').disabled], [false, false],
        "the fieldset's first legend and a control outside it stay enabled");
    });
    await item('a guided scroll reports whether the page moved, and why not', async () => {
      const { web, transport, calls } = fake();
      const { tabId } = await web.open('https://example.com/lang-sida');
      const original = transport.call;
      let reply = { ok: true, moved: false, reason: 'the page is already at its end in that direction', info: 'did not scroll down' };
      transport.call = async function (name, args = {}) {
        if (name !== 'computer' || args.action !== 'scroll') return original.call(this, name, args);
        calls.push({ name, args });
        return reply;
      };
      assert.deepEqual(await web.scroll(tabId, 'down'), { direction: 'down', moved: false, reason: 'the page is already at its end in that direction' }, 'a scroll that moved nothing says so');
      reply = { ok: true, moved: true, info: 'scrolled up (page)' };
      assert.deepEqual(await web.scroll(tabId, 'up'), { direction: 'up', moved: true });
      assert.equal(calls.filter(call => call.name === 'computer' && call.args.action === 'scroll').length, 2, 'each scroll is one call');
    });
    assert.deepEqual(failures, [], 'guided web predicates and scroll');
  }

  // The executor refuses web tools above the configured level, before anything runs.
  {
    const executor = new AssistantExecutor(directory, directory);
    const execution = level => ({ context: { run: { id: randomUUID() }, settings: { accounts: [] }, chat: { messages: [], conversationId: randomUUID(), web: { level, login: false } } }, callbacks: {}, chatContextRead: true });
    await assert.rejects(executor.dispatch(execution('off'), 'web_search', { query: 'x' }), /Webbåtkomsten tillåter inte/);
    await assert.rejects(executor.dispatch(execution('read'), 'web_click', { tabId: 1, ref: 'ref_1' }), /Webbåtkomsten tillåter inte/);
    await assert.rejects(executor.webApprove(randomUUID(), {}), /inte längre öppen/);
    const task = webLevel => ({ context: { run: { id: randomUUID(), task: 'check-mail' }, settings: { accounts: [] }, items: [] }, callbacks: {}, webLevel });
    await assert.rejects(executor.dispatch(task('off'), 'web_search', { query: 'x' }), /mejluppdrag är avstängd/);
    await assert.rejects(executor.dispatch(task('read'), 'web_click', { tabId: 1, ref: 'ref_1' }), /mejluppdrag är avstängd eller tillåter inte/);
    const waiting = { ...execution('act'), webGeneration: 0, webApprovalPending: true };
    await assert.rejects(executor.dispatch(waiting, 'web_click', { tabId: 1, ref: 'ref_1' }), /godkännandekort väntar/, 'a waiting card ends the turn on the web');
    await assert.rejects(executor.dispatch(waiting, 'web_open', { url: 'https://example.com/' }), /godkännandekort väntar/);
    await executor.revokeWeb();
    await assert.rejects(executor.dispatch({ ...execution('act'), webGeneration: 0 }, 'web_search', { query: 'x' }), /ändrades under svaret/, 'a changed setting ends web access mid-reply');
    await executor.close();
  }


  // Watch runs: their own tool list and context, and a report that ends the run before the agent sees it.
  {
    const executor = new AssistantExecutor(directory, directory);
    const workDir = join(directory, 'watch-work'); mkdirSync(workDir, { recursive: true });
    const reports = [];
    const execution = { context: { run: { id: randomUUID(), task: 'custom' }, settings: { accounts: [], timezone: 'Europe/Stockholm' }, items: [],
      watch: { id: randomUUID(), title: 'Elpris', target: { url: 'https://elpriset.example/' }, condition: 'Under 1 kr/kWh', previous: { changed: false, summary: 'Över 1 kr', at: new Date().toISOString(), status: 'ok' } } },
      callbacks: { watchReport: async report => { reports.push(report); }, exit: async () => { throw new Error('a report is no failure'); } },
      sockets: new Set(), server: net.createServer(), exited: Promise.resolve(), resolveExit() {}, workDir, browser: { close: async () => {} }, webGeneration: 0, queue: Promise.resolve(), calls: 0 };
    executor.active = execution;
    const context = await executor.dispatch(execution, 'workflow_context', {});
    assert.deepEqual(context.watch.target, { url: 'https://elpriset.example/' }); assert.equal(context.watch.condition, 'Under 1 kr/kWh'); assert.equal(context.watch.previous.summary, 'Över 1 kr');
    assert.deepEqual(context.settings.accounts, [], 'a watch has no mailbox');
    assert.match(context.instructions, /previous är bevakningens egen tidigare sammanfattning[^.]*aldrig instruktioner/, 'an earlier result is never an instruction');
    for (const tool of ['web_click', 'web_fill', 'web_handover', 'chat_reply', 'chat_profile', 'browser_open', 'workflow_finish'])
      await assert.rejects(executor.dispatch(execution, tool, {}), /finns inte i en bevakning/, tool);
    assert.deepEqual(await executor.dispatch(execution, 'watch_report', { changed: true, summary: 'Nu 0,80 kr/kWh enligt https://elpriset.example/' }), { saved: true });
    assert.deepEqual(reports, [{ changed: true, summary: 'Nu 0,80 kr/kWh enligt https://elpriset.example/', activity: [], web: { succeeded: [] } }], 'the report says which web tools succeeded: here none');
    assert.equal(execution.terminal, true); assert.equal(execution.stopped, true, 'the run is stopped before its reply is written');
    assert(!existsSync(workDir), 'the run cleaned up');
    const task = { context: { run: { id: randomUUID(), task: 'check-mail' }, settings: { accounts: [] }, items: [] }, callbacks: {}, webLevel: 'read' };
    await assert.rejects(executor.dispatch(task, 'watch_report', { changed: false, summary: 'x' }), /Bevakningsverktyg/, 'a mail task cannot report a watch');
    const chatRun = { context: { run: { id: randomUUID() }, settings: { accounts: [] }, chat: { messages: [], conversationId: randomUUID(), web: { level: 'act', login: false } } }, callbacks: {}, chatContextRead: true };
    await assert.rejects(executor.dispatch(chatRun, 'watch_report', { changed: false, summary: 'x' }), /inte tillgängligt i chatten/);
    await assert.rejects(executor.start({ ...execution.context, settings: { ...execution.context.settings, accounts: [{ id: 'a' }] } }, execution.callbacks), /bevakning får inte innehålla/);
    await executor.close();
  }
  // Why a watch run failed: an unreadable source is the run's own failure; Tabai's lost browser connection is not.
  {
    const executor = new AssistantExecutor(directory, directory), reports = [], exits = [];
    const details = [];
    const callbacks = { watchReport: async report => { reports.push(report); }, exit: async (message, failure, detail) => { exits.push({ message, failure }); details.push(detail); } };
    const watchRun = name => {
      const workDir = join(directory, name); mkdirSync(workDir, { recursive: true });
      const run = { context: { run: { id: randomUUID(), task: 'custom' }, settings: { accounts: [], timezone: 'Europe/Stockholm' }, items: [], watch: { id: randomUUID(), title: 'Elpris', target: { url: 'https://elpriset.example/' }, condition: 'Under 1 kr/kWh' } },
        callbacks, sockets: new Set(), server: net.createServer(), exited: Promise.resolve(), resolveExit() {}, workDir, browser: { close: async () => {} }, webGeneration: 0, queue: Promise.resolve(), calls: 0 };
      executor.active = run; return run;
    };
    let run = watchRun('watch-unreadable');
    await executor.dispatch(run, 'watch_report', { changed: true, summary: 'Sidan visar bara ett felmeddelande.', readable: false });
    assert.deepEqual(reports.at(-1), { changed: false, summary: 'Sidan visar bara ett felmeddelande.', activity: [], failure: 'run', web: { succeeded: [] } }, 'readable=false is a failed run, never a change');
    run = watchRun('watch-readable');
    await executor.dispatch(run, 'watch_report', { changed: false, summary: 'Fortfarande över 1 kr.', readable: true });
    assert.deepEqual(reports.at(-1), { changed: false, summary: 'Fortfarande över 1 kr.', activity: [], web: { succeeded: [] } }, 'a read source is an ordinary result');
    // A web call that failed on Tabai's own connection marks the run; a page's own failure does not.
    run = watchRun('watch-disconnected');
    executor.webTool = async () => { throw new AssistantBrowserError('failed', 'browser-tool', 'NO_EXTENSION: extension not connected yet (retryable)', 'NO_EXTENSION'); };
    await assert.rejects(executor.dispatch(run, 'web_open', { url: 'https://elpriset.example/' }), /NO_EXTENSION/);
    assert.equal(run.webDisconnected, true);
    await executor.dispatch(run, 'watch_report', { changed: false, summary: 'Sidan kunde inte läsas.', readable: false });
    assert.equal(reports.at(-1).failure, 'disconnected', 'an unreadable source after a lost connection is not the run\'s fault');
    run = watchRun('watch-page-error');
    executor.webTool = async () => { throw new AssistantBrowserError('failed', 'browser-tool', 'TOOL_ERROR: net::ERR_NAME_NOT_RESOLVED', 'TOOL_ERROR'); };
    await assert.rejects(executor.dispatch(run, 'web_open', { url: 'https://elpriset.example/' }), /TOOL_ERROR/);
    assert.equal(run.webDisconnected, undefined, 'a page that failed to load is the run\'s own trouble');
    delete executor.webTool;
    // A run that ended without its report: the kind travels to the host, and a lost connection overrides the run's own failure.
    await executor.failed(run, 'Uppdragets tidsgräns nåddes.', 'run');
    assert.deepEqual(exits.at(-1), { message: 'Uppdragets tidsgräns nåddes.', failure: 'run' });
    // At a wake every overdue report arrives at once: whichever comes first, the sleep is the cause.
    const slept = 'Datorn gick i viloläge och körningen avbröts. Det som hann sparas finns kvar.';
    run = watchRun('watch-slept-limit'); run.beatAt = Date.now() - 16 * 60_000;
    await executor.failed(run, 'Uppdragets tidsgräns nåddes.', 'run');
    assert.deepEqual(exits.at(-1), { message: slept, failure: 'disconnected' }, 'a limit that ran out during sleep is not a limit reached, even before any beat has run');
    run = watchRun('watch-slept-worker'); run.beatAt = Date.now(); run.wokeAt = Date.now() - 10_000;
    await executor.failed(run, 'Codex rapporterade ett fel.', 'unavailable');
    assert.deepEqual(exits.at(-1), { message: slept, failure: 'disconnected' }, 'nor is a worker that lost its connection in the sleep it just woke from');
    run = watchRun('watch-awake-limit'); run.beatAt = Date.now() - 20_000;
    await executor.failed(run, 'Uppdragets tidsgräns nåddes.', 'run');
    assert.deepEqual(exits.at(-1), { message: 'Uppdragets tidsgräns nåddes.', failure: 'run' }, 'a computer that stayed awake really reached the limit');
    run = watchRun('watch-violation-after-sleep'); run.beatAt = Date.now(); run.wokeAt = Date.now() - 10_000;
    await executor.failed(run, 'Codex försökte använda ett verktyg utanför assistentens tillåtna uppdrag.', 'run', true);
    assert.deepEqual(exits.at(-1), { message: 'Codex försökte använda ett verktyg utanför assistentens tillåtna uppdrag.', failure: 'run' }, 'a model that broke the tool policy is reported as such, even just after a sleep');
    run = watchRun('watch-long-after-sleep'); run.beatAt = Date.now() - 10_000; run.wokeAt = Date.now() - 5 * 60_000;
    await executor.failed(run, 'Uppdragets tidsgräns nåddes.', 'run');
    assert.deepEqual(exits.at(-1), { message: 'Uppdragets tidsgräns nåddes.', failure: 'run' }, 'a sleep minutes ago does not explain the end of a run that carried on');
    run = watchRun('watch-exit-disconnected'); run.webDisconnected = true;
    await executor.failed(run, 'Den lokala modellen avslutade utan ett verifierat resultat.', 'run');
    assert.equal(exits.at(-1).failure, 'disconnected');
    run = watchRun('watch-exit-unavailable'); run.webDisconnected = true;
    await executor.failed(run, 'Ollama svarar inte på den här datorn.', 'unavailable');
    assert.equal(exits.at(-1).failure, 'unavailable', 'a model that could not run stays unavailable');
    // A tool timeout is marked apart from a lost connection: the host judges it by its own connection state.
    run = watchRun('watch-timeout');
    executor.webTool = async () => { throw new AssistantBrowserError('failed', 'browser-tool', "TIMEOUT: Tool 'navigate' timed out after 35000ms", 'TIMEOUT'); };
    await assert.rejects(executor.dispatch(run, 'web_open', { url: 'https://elpriset.example/' }), /TIMEOUT/);
    assert.deepEqual([run.webTimedOut, run.webDisconnected], [true, undefined], 'a page that hangs times out too');
    await executor.dispatch(run, 'watch_report', { changed: false, summary: 'Sidan svarade inte.', readable: false });
    assert.deepEqual(reports.at(-1), { changed: false, summary: 'Sidan svarade inte.', activity: [], failure: 'run', web: { succeeded: [], timedOut: true } });
    run = watchRun('watch-timeout-exit'); run.webTimedOut = true;
    await executor.failed(run, 'Uppdragets tidsgräns nåddes.', 'run');
    assert.deepEqual([exits.at(-1).failure, details.at(-1)], ['run', { timedOut: true }], 'the end of a timed-out run says so');
    for (const code of ['SESSION_BUSY', 'QUEUE_FULL', 'NO_EXTENSION', 'NO_BRIDGE']) {
      run = watchRun(`watch-${code}`);
      executor.webTool = async () => { throw new AssistantBrowserError('failed', 'browser-tool', `${code}: x`, code); };
      await assert.rejects(executor.dispatch(run, 'web_open', { url: 'https://elpriset.example/' }));
      assert.deepEqual([run.webDisconnected, run.webTimedOut], [true, undefined], `${code} is Tabai's own trouble`);
    }
    // The web tools that succeeded, once each; a value only with a readable result.
    run = watchRun('watch-read');
    executor.webTool = async (_execution, tool) => ({ tabId: 1, tool });
    await executor.dispatch(run, 'web_open', { url: 'https://elpriset.example/' }); await executor.dispatch(run, 'web_read', { tabId: 1 }); await executor.dispatch(run, 'web_read', { tabId: 1, offset: 100 });
    await executor.dispatch(run, 'watch_report', { changed: false, summary: 'Nu 48 öre/kWh.', value: { amount: 48, unit: 'öre/kWh' } });
    assert.deepEqual(reports.at(-1), { changed: false, summary: 'Nu 48 öre/kWh.', activity: [], value: { amount: 48, unit: 'öre/kWh' }, web: { succeeded: ['web_open', 'web_read'] } });
    run = watchRun('watch-value-unreadable');
    await executor.dispatch(run, 'watch_report', { changed: false, summary: 'Felsida.', readable: false, value: { amount: 1, unit: 'kr' } });
    assert.equal(reports.at(-1).value, undefined, 'an unreadable source has no value');
    delete executor.webTool;
    await executor.close();
    // The connection codes from shared/protocol.ts, read from the server's "CODE: message" text.
    for (const code of ['NO_EXTENSION', 'NO_BRIDGE', 'NO_SESSION', 'SW_ERROR', 'TIMEOUT', 'SESSION_BUSY', 'QUEUE_FULL']) assert.equal(assistantBrowserDisconnected(new AssistantBrowserError('failed', 'browser-tool', `${code}: x`, code)), true, code);
    for (const code of ['TOOL_ERROR', 'TAB_NOT_FOUND', 'TAB_NOT_IN_GROUP', 'FOCUS_DISABLED', undefined]) assert.equal(assistantBrowserDisconnected(new AssistantBrowserError('failed', 'browser-tool', 'x', code)), false, String(code));
    assert.equal(assistantBrowserDisconnected(new AssistantBrowserError('failed', 'transport', 'Webbläsaranslutningen svarade inte.')), true);
    assert.equal(assistantBrowserDisconnected(new Error('NO_EXTENSION: plain text is not a code')), false);
    const coded = new AssistantBrowser(directory, directory);
    coded.client = { async callTool() { return { isError: true, content: [{ type: 'text', text: 'NO_BRIDGE: broker still starting (retryable)' }] }; } };
    await assert.rejects(coded.call('navigate', { tabId: 1, url: 'https://elpriset.example/' }), error => error.toolCode === 'NO_BRIDGE' && assistantBrowserDisconnected(error));
    coded.client = { async callTool() { return { isError: true, content: [{ type: 'text', text: 'Sidan svarade inte' }] }; } };
    await assert.rejects(coded.call('navigate', {}), error => error.toolCode === undefined && !assistantBrowserDisconnected(error));
  }
  // Mina uppgifter: only on act, refused while a card waits, and every read is web activity.
  {
    const executor = new AssistantExecutor(directory, directory);
    const lines = [];
    const execution = level => ({ context: { run: { id: randomUUID() }, settings: { accounts: [] }, chat: { messages: [], conversationId: randomUUID(), web: { level, login: false } } },
      callbacks: { chatProfile: async () => ({ profile: { name: 'Kim' } }), chatReply: async () => {}, webActivity: async entries => { lines.push(...entries); } }, chatContextRead: true, webGeneration: 0 });
    await assert.rejects(executor.dispatch(execution('read'), 'chat_profile', {}), /Webbåtkomsten tillåter inte/);
    await assert.rejects(executor.dispatch(execution('off'), 'chat_profile', {}), /Webbåtkomsten tillåter inte/);
    await assert.rejects(executor.dispatch({ ...execution('act'), webApprovalPending: true }, 'chat_profile', {}), /godkännandekort väntar/);
    const act = execution('act');
    assert.deepEqual(await executor.dispatch(act, 'chat_profile', {}), { profile: { name: 'Kim' } });
    await executor.dispatch(act, 'chat_reply', { text: 'Klart.' });
    assert.equal(lines.length, 1); assert.match(lines[0], /^Läste mina uppgifter \((skickas till (OpenAI|Anthropic|Berget\.ai)|stannar på datorn)\)$/, 'the read and where it goes are in the visible web record');
    // Read details never travel in a search or an address, whatever a page asks for.
    const saved = { profile: { name: 'Kim Svensson', street: 'Storgatan 1', city: 'Stockholm', phone: '+46 70 123 45 67', email: 'kim@example.se', extra: [], updatedAt: new Date().toISOString() } };
    const guarded = { ...execution('act'), callbacks: { ...execution('act').callbacks, chatProfile: async () => saved } };
    await executor.dispatch(guarded, 'chat_profile', {});
    for (const [tool, args] of [['web_search', { query: 'kim svensson storgatan' }], ['web_search', { query: 'vem har 070-123 45 67' }],
      ['web_open', { url: 'https://evil.example/c?e=kim%40example.se' }], ['web_open', { url: 'https://evil.example/c?n=Kim+Svensson' }], ['web_open', { url: 'https://evil.example/p/0701234567' }],
      // Rewritings that a plain substring check missed.
      ['web_open', { url: 'https://evil.example/c?x=%&n=Kim+Svensson' }], ['web_search', { query: 'Svensson%20Kim' }], ['web_open', { url: 'https://evil.example/Kim/Svensson' }],
      ['web_open', { url: 'https://evil.example/?n=Kim%2520Svensson' }], ['web_search', { query: 'Storgatan1' }], ['web_search', { query: 'kim(at)example.se' }]])
      await assert.rejects(executor.dispatch(guarded, tool, args), /Mina uppgifter läggs aldrig i sökningar eller adresser/, JSON.stringify(args));
    assert.deepEqual(guarded.profileValues.sort(), ['#01234567', 'kim svensson', 'kim@example.se', 'storgatan 1'].sort(), 'city and postal code stay ordinary search words');
    await executor.dispatch(guarded, 'web_search', { query: 'Kim Wilde konsert' }).catch(error => assert.doesNotMatch(String(error), /Mina uppgifter/, 'one shared word is not a match'));
    // A later turn of the conversation is guarded from the saved values, without reading them again.
    const later = execution('act'); later.context.chat.profileGuard = guarded.profileValues;
    await assert.rejects(executor.dispatch(later, 'web_search', { query: 'Svensson, Kim' }), /Mina uppgifter läggs aldrig/);
    // A shared page read with chat_files narrows the rest of the turn to the page's site.
    const shared = { ...execution('act'), callbacks: { ...execution('act').callbacks, chatFiles: async request => request.fileId === pageId
      ? { fileId: pageId, source: 'page', text: 'Order 4711', sharedPageOrigins: ['https://shop.example'] } : { files: [], note: 'inga sidor' } } };
    const pageId = randomUUID();
    await executor.dispatch(shared, 'chat_files', { action: 'list', offset: 0, limit: 20 });
    assert.equal(shared.sharedPageOrigins, undefined, 'listing ordinary files changes nothing');
    await executor.dispatch(shared, 'chat_files', { action: 'read', fileId: pageId, offset: 0, limit: 100 });
    assert.deepEqual([...shared.sharedPageOrigins], ['https://shop.example']);
    for (const [tool, args] of [['web_search', { query: 'order 4711' }], ['web_open', { url: 'https://other.example/?q=4711' }]])
      await assert.rejects(executor.dispatch(shared, tool, args), /Den här turen har läst en delad sida/, tool);
    await executor.dispatch(shared, 'web_open', { url: 'https://shop.example/order' }).catch(error => assert.doesNotMatch(String(error), /delad sida/, 'the page\'s own site is not refused'));
    await executor.dispatch(execution('act'), 'web_search', { query: 'order 4711' }).catch(error => assert.doesNotMatch(String(error), /delad sida/, 'another turn is not narrowed'));
    // A sender lookup searches only with its domain.
    const lookup = execution('read'); lookup.context.chat.lookup = { domain: 'leverantor.se' };
    await assert.rejects(executor.dispatch(lookup, 'web_search', { query: 'faktura 2026-418 Byggvaror' }), /söker bara med domänen leverantor\.se/);
    await executor.close();
  }
  // Receipts: only the server's own PDF file is read, and it is removed at once.
  {
    const store = join(directory, 'receipts'), folder = join(store, 'browser-store', 'pdfs'); mkdirSync(folder, { recursive: true });
    const executor = new AssistantExecutor(directory, store), conversationId = randomUUID();
    const inside = join(folder, `doc-${randomUUID()}.pdf`); writeFileSync(inside, '%PDF-1.4 kvitto');
    let printed = inside;
    executor.web = { conversationId, key: 'k', session: { receipt: async () => ({ path: printed, bytes: 15 }), close: async () => {} } };
    assert.equal((await executor.webReceipt(conversationId, 41)).toString(), '%PDF-1.4 kvitto');
    assert(!existsSync(inside), "the server's copy is removed");
    const outside = join(directory, `doc-${randomUUID()}.pdf`); writeFileSync(outside, 'annat'); printed = outside;
    await assert.rejects(executor.webReceipt(conversationId, 41), /oväntad plats/);
    assert(existsSync(outside), 'a file outside the store is never read or removed');
    const renamed = join(folder, 'notes.pdf'); writeFileSync(renamed, 'x'); printed = renamed;
    await assert.rejects(executor.webReceipt(conversationId, 41), /oväntad plats/);
    await assert.rejects(executor.webReceipt(randomUUID(), 41), /inte längre öppen/, 'another conversation has no receipt');
    executor.web = undefined; await executor.close();
  }

  // The chat: host-created approval cards, one approval call, failed versus uncertain.
  {
    const approvals = [];
    let outcome = async () => ({ url: 'https://shop.example/tack', title: 'Tack för din order' });
    let receipt = async () => pdf();
    const executor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {},
      async webApprove(conversationId, approval) { approvals.push({ conversationId, approval }); return outcome(); }, async webShow() { return { shown: true }; }, closed: [], async closeWeb(id) { this.closed.push(id); },
      receipts: 0, async webReceipt() { this.receipts++; return receipt(); } };
    const bridge = { agent: () => undefined, current: () => undefined, verifications: () => [], berget: () => ({ configured: false, message: '' }), webAccess: () => ({ level: 'act', login: false }),
      async start() { throw new Error('no tasks'); } };
    const chat = new AssistantChat(process.cwd(), join(directory, 'chat'), bridge, executor); chats.push(chat);
    await chat.send({ id: randomUUID(), text: 'Köp en laddkabel på shop.example', windowId: 3 });
    const { context, callbacks } = executor.starts[0];
    assert.deepEqual(context.chat.web, { level: 'act', login: false }); assert.equal(context.chat.conversationId, chat.view().id); assert.equal(context.windowId, 3);
    const approval = { kind: 'web-action', approvalId: randomUUID(), tabId: 41, url: 'https://shop.example/kassa', site: 'shop.example', page: 'Kassa', action: 'Köp nu', amount: '499 kr', fields: [{ label: 'Namn', value: 'Kim' }], state: 'a'.repeat(64), ref: 'ref_7', documentId: 'doc-1' };
    // The image the host took becomes the conversation's own file; the card names it and stays bound as issued.
    const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic card image'), Buffer.from([0xff, 0xd9])]);
    const { cardId } = await callbacks.webApproval(approval, { bytes: image, mimeType: 'image/jpeg' });
    const shownCard = chat.view().messages.find(entry => entry.card?.id === cardId).card;
    assert.match(shownCard.intent.previewFileId, /^[0-9a-f-]{36}$/, 'the card names its image');
    assert.deepEqual({ ...shownCard.intent, previewFileId: undefined }, { ...approval, previewFileId: undefined }, 'nothing else on the card changes');
    const piece = await chat.approvalPreview(shownCard.intent.previewFileId, 0);
    assert.deepEqual([piece.mimeType, Buffer.from(piece.base64, 'base64').equals(image)], ['image/jpeg', true], 'the panel reads exactly the stored image');
    await assert.rejects(chat.approvalPreview(randomUUID(), 0), /hör inte till det öppna samtalet/, 'only an image on a card in the open conversation is served');
    assert.deepEqual(chat.view().fileDrafts, [], 'the image is never a draft');
    // An image that cannot be saved gives a card without one, never a lost card.
    const plain = await callbacks.webApproval({ ...approval, approvalId: randomUUID() }, { bytes: Buffer.from('not an image'), mimeType: 'image/jpeg' });
    assert.equal(chat.view().messages.find(entry => entry.card?.id === plain.cardId).card.intent.previewFileId, undefined);
    await chat.dismissCard(plain.cardId);
    await callbacks.webActivity(['Öppnade https://shop.example/kassa']);
    await assert.rejects(callbacks.chatPropose(approval), /discriminator|Invalid/i, 'the agent cannot propose a web approval');
    await callbacks.chatReply('Köpet väntar på ditt godkännande.');
    const card = chat.view().messages.find(entry => entry.card?.id === cardId).card;
    assert.equal(card.status, 'pending'); assert.match(card.title, /Godkänn: Köp nu/); assert.match(card.detail, /499 kr[\s\S]*Namn: Kim/);
    const activity = chat.view().messages.find(entry => entry.role === 'system' && entry.webActivity);
    assert.deepEqual(activity?.webActivity, ['Öppnade https://shop.example/kassa'], 'web activity is a typed list of registered lines');
    assert.equal(activity.text, '', 'the lines are not repeated as message text');
    await chat.confirmCard(cardId);
    assert.equal(approvals.length, 1); assert.deepEqual(approvals[0].approval, { ...approval, previewFileId: shownCard.intent.previewFileId }, 'the approval reaches the web session as shown, image id and all');
    assert.equal(chat.view().messages.find(entry => entry.card?.id === cardId).card.status, 'applied', 'applied as soon as the click returns');
    assert(chat.view().messages.some(entry => /Kvittot sparas som PDF i samtalet…/.test(entry.text) || /Kvittot är sparat/.test(entry.text)), 'the receipt follows the recorded click');
    await chat.settled();
    const done = chat.view().messages.find(entry => /Godkänt och utfört: Tabai klickade en gång på ”Köp nu”/.test(entry.text));
    assert(done, 'the approved step is recorded');
    assert.match(done.text, /Kvittot är sparat som PDF i samtalet: Kvitto shop\.example \d{4}-\d{2}-\d{2}\.pdf/);
    assert.equal(done.files?.length, 1); assert.equal(done.files[0].status, 'ready', done.files[0].error); assert.equal(done.files[0].kind, 'pdf');
    assert.match(done.files[0].preview, /KVITTO 4281/, 'the receipt is read by the same reader as uploads');
    assert.deepEqual(chat.view().fileDrafts, [], 'a receipt is never a draft attachment');
    const listed = await chat.files.request(chat.view().id, chat.attachedFiles(), { action: 'list', offset: 0, limit: 20 });
    assert.deepEqual(listed.files.map(file => file.id), [done.files[0].id], 'the agent can read the receipt with chat_files');
    assert.throws(() => chat.files.resolve(chat.view().id, [done.files[0].id]), /hör inte till/, 'a user message cannot attach a host file');
    await assert.rejects(chat.confirmCard(cardId), /redan hanterat/);
    assert.equal(approvals.length, 1, 'a card is approved once');
    // A print that fails never repeats the approved step.
    receipt = async () => { throw new AssistantWebError('Utskriften misslyckades.'); };
    await chat.send({ id: randomUUID(), text: 'Köp igen' });
    const again = executor.starts[1].callbacks;
    const printFails = (await again.webApproval({ ...approval, approvalId: randomUUID() })).cardId;
    await again.chatReply('Kortet väntar.');
    await chat.confirmCard(printFails); await chat.settled();
    assert.equal(approvals.length, 2, 'one click for the second card'); assert.equal(executor.receipts, 2);
    assert.equal(chat.view().messages.find(entry => entry.card?.id === printFails).card.status, 'applied', 'the step is done even without a receipt');
    const noReceipt = chat.view().messages.at(-1);
    assert.match(noReceipt.text, /Steget är utfört, men kvittot kunde inte sparas: Utskriften misslyckades\. Steget görs aldrig om/);
    assert.equal(noReceipt.files, undefined);
    receipt = async () => Buffer.from('inte en pdf');
    await chat.send({ id: randomUUID(), text: 'Köp en till' });
    const next = executor.starts[2].callbacks;
    const failedCard = (await next.webApproval({ ...approval, approvalId: randomUUID() })).cardId;
    const uncertainCard = (await next.webApproval({ ...approval, approvalId: randomUUID() })).cardId;
    await next.chatReply('Två kort väntar.');
    outcome = async () => { throw new AssistantWebError('Sidan har ändrats sedan kortet skapades. Inget har klickats.'); };
    await assert.rejects(chat.confirmCard(failedCard));
    assert.equal(chat.view().messages.find(entry => entry.card?.id === failedCard).card.status, 'failed', 'nothing clicked is a failure, not uncertain');
    outcome = async () => { throw new AssistantWebError('Klicket kan ha skickats.', true); };
    await assert.rejects(chat.confirmCard(uncertainCard));
    assert.equal(chat.view().messages.find(entry => entry.card?.id === uncertainCard).card.status, 'uncertain');
    const id = chat.view().id;
    await chat.remove(id);
    assert.deepEqual(executor.closed, [id], 'deleting a conversation closes its web tabs');
  }

  // "Kolla upp avsändaren": an organization's domain only, never a private mailbox, and only with web access.
  {
    const dir = join(directory, 'lookup');
    const gmail = { id: 'gmail-test', label: 'Testkonto', provider: 'gmail', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/?authuser=owner%40example.test', enabled: true };
    const finding = (threadId, recipient) => ({ accountId: gmail.id, threadId, kind: 'reply', title: `Offert från ${recipient}`, summary: 'En offert.', reason: 'Avsändaren väntar på svar.', priority: 2,
      sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${threadId.replace(/\W/g, '')}`, recipient, sources: [{ observationId: 'read-1', quote: 'Här är offerten.' }] });
    const workflow = { async start(context, callbacks) { this.callbacks = callbacks; }, async stop() {}, async close() {}, async open() {} };
    const chatExecutor = { starts: [], async start(context, callbacks) { this.starts.push({ context, callbacks }); }, async stop() {}, async close() {}, async revokeWeb() {} };
    const controller = new AssistantController(process.cwd(), dir, workflow, { chatExecutor, watchExecutor: { async start() {}, async stop() {}, async close() {} } });
    const request = (operation, input = {}) => controller.request(operation, input);
    try {
      let current = (await request('status')).assistant;
      await request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, accounts: [gmail] }) });
      await request('start', { task: 'check-mail' });
      await workflow.callbacks.finish({ summary: 'Två offerter.', findings: [finding('gmail:thread-org', 'anna@byggfirman.se'), finding('gmail:thread-private', 'kim@gmail.com')], coverage: [{ accountId: gmail.id, status: 'checked', message: 'Kontrollerat.' }] });
      const items = (await request('status')).assistant.items;
      const organization = items.find(item => item.recipient === 'anna@byggfirman.se'), personal = items.find(item => item.recipient === 'kim@gmail.com');
      const conversations = () => controller.chat.conversations.conversations.length;
      const before = conversations();
      await assert.rejects(request('correct', { action: 'chat-sender-lookup', itemId: organization.id, revision: String(organization.revision) }), /Söka och läsa under Inställningar → Webbåtkomst/);
      current = (await request('status')).assistant;
      await request('correct', { action: 'settings', revision: String(current.revision), settings: JSON.stringify({ ...current.settings, web: { level: 'read', login: false } }) });
      await assert.rejects(request('correct', { action: 'chat-sender-lookup', itemId: personal.id, revision: String(personal.revision) }), /privatpersoner/);
      await assert.rejects(request('correct', { action: 'chat-sender-lookup', itemId: organization.id, revision: String(organization.revision + 1) }), /har ändrats/);
      assert.equal(conversations(), before, 'a refused lookup creates no conversation');
      await request('correct', { action: 'chat-sender-lookup', itemId: organization.id, revision: String(organization.revision), windowId: '5' });
      const view = (await request('status')).chat;
      assert.equal(view.title, 'Kolla upp byggfirman.se'); assert.equal(view.context, undefined, 'no mail item reaches the conversation');
      assert.equal(view.messages[0].role, 'user');
      assert.equal(view.messages[0].text, 'Kolla upp organisationen bakom byggfirman.se: vad den gör och om den verkar seriös. Sök med domänen byggfirman.se.');
      const { context } = chatExecutor.starts.at(-1);
      assert.equal(context.chat.conversationId, view.id); assert.equal(context.windowId, 5);
      assert.deepEqual(context.chat.web, { level: 'read', login: false }, 'a lookup only reads, whatever the chat level');
      assert.deepEqual(context.chat.lookup, { domain: 'byggfirman.se' });
      assert.equal(context.chat.selection, undefined, 'no mail text goes to the model');
      assert.doesNotMatch(JSON.stringify(context.chat), /anna@|Offert/, 'neither the person nor the mail reaches the turn');
    } finally { await controller.close(); }
  }

  // javascript_tool world:'isolated' in the extension: a fresh world in the main
  // frame, evaluated by its context id with the same CSP allowance; no fallback.
  {
    const commands = [];
    let createFails = false;
    globalThis.chrome = {
      runtime: {}, tabs: { onRemoved: { addListener() {} }, async get(id) { return { id, status: 'complete', groupId: 500, url: 'https://example.test/' }; }, async query() { return []; } },
      storage: { local: { async get() { return { mcpGroups: { 'sess-1234': 500 } }; }, async set() {} } },
      tabGroups: { async get(id) { if (id !== 500) throw new Error('no group'); return { id, title: 'MCP·sess' }; } },
      scripting: { async executeScript() { return [{ documentId: 'doc-1', result: null }]; } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} }, attach: (_target, _version, callback) => callback(),
        sendCommand: async (_target, method, params) => {
          commands.push({ method, params });
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN-FRAME' } } };
          if (method === 'Page.createIsolatedWorld') { if (createFails) throw new Error('No frame for given id found'); return { executionContextId: 77 }; }
          if (method === 'Runtime.evaluate') return { result: { type: 'object', value: { ok: true, value: 'isolerad' } } };
          return {};
        } },
    };
    const { evaluateInPage, PreDispatchError } = await import('../dist/page-evaluation.mjs');
    const request = world => ({ sessionId: 'sess-1234', tabId: 10, deadline: Date.now() + 5000, expired: () => new Error('expired'), func: () => ({ ok: true }), args: [], awaitPromise: true, ...(world ? { world } : {}) });
    const isolated = await evaluateInPage(request('isolated'));
    assert.deepEqual(isolated.value, { ok: true, value: 'isolerad' });
    assert.deepEqual(commands.map(command => command.method), ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate']);
    assert.deepEqual(commands[1].params, { frameId: 'MAIN-FRAME', worldName: 'tabai-isolated', grantUniveralAccess: false });
    assert.equal(commands[2].params.contextId, 77, 'evaluated in the isolated context');
    assert.equal(commands[2].params.allowUnsafeEvalBlockedByCSP, true, 'the same CSP allowance');
    commands.length = 0;
    await evaluateInPage(request());
    assert.deepEqual(commands.map(command => command.method), ['Runtime.evaluate'], 'the default stays the main world');
    assert.equal(commands[0].params.contextId, undefined);
    commands.length = 0; createFails = true;
    await assert.rejects(evaluateInPage(request('isolated')), error => error instanceof PreDispatchError && /isolated world/.test(error.message));
    assert(!commands.some(command => command.method === 'Runtime.evaluate'), 'nothing runs when the isolated world cannot be created');
    delete globalThis.chrome;
  }
  console.log('assistant-web: isolated host scripts and world, Bing fallback, watch sessions and reports, Mina uppgifter, receipts, address guard, identical per-level tools for every backend, final-step/secret/login gates, incognito fallback, exactly-once approval and host-created chat cards passed');
} finally {
  for (const chat of chats) await chat.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
  stopWatchdog();
}
