import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
// Zoho's API is replaced at the fetch boundary; all data is invented.
const dir = mkdtempSync(join(tmpdir(), 'tabai-zoho-api-'));
try {
  await build({ entryPoints: ['src/assistant-zoho-api.ts'], outdir: dir, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { AssistantZohoApi, AssistantZohoApiError } = await import(pathToFileURL(join(dir, 'assistant-zoho-api.mjs')).href);

  const account = { id: 'z', provider: 'zoho', label: 'Zoho', email: 'owner@example.test', url: 'https://mail.zoho.eu/zm/', enabled: true };
  const secrets = { clientId: 'client-id-value', clientSecret: 'client-secret-value', refreshToken: 'refresh-token-value', accountsServer: 'https://accounts.zoho.eu' };
  const data = mkdtempSync(join(dir, 'data-'));
  const save = value => { const path = join(data, 'zoho-mail-oauth.json'); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); };
  save(secrets);

  const now = Date.UTC(2026, 10, 8, 12), day = 86_400_000, since = now - 7 * day;
  const entry = (messageId, folderId, age, extra = {}) => ({ messageId, folderId, receivedTime: String(now - age * day), status: '1', subject: 'Ämne &amp; rubrik', sender: 'Kund', fromAddress: 'kund@example.test', toAddress: '&lt;owner@example.test&gt;', ccAddress: 'Not Provided', hasAttachment: '0', ...extra });
  const folders = [{ folderId: 'in', folderType: 'Inbox' }, { folderId: 'custom', folderType: 'Inbox' }, { folderId: 'sent', folderType: 'Sent' }, { folderId: 'trash', folderType: 'Trash' }, { folderId: 'spam', folderType: 'Spam' }, { folderId: 'drafts', folderType: 'Drafts' }, { folderId: 'arch', folderType: 'Archive' }];
  const lists = {
    in: [entry('100', 'in', 1, { threadId: '900', status: '0' }), entry('101', 'in', 2), entry('old', 'in', 30)],
    custom: [entry('200', 'custom', 3, { threadId: '900' }), entry('201', 'custom', 4, { hasAttachment: '1' })],
    sent: [entry('300', 'sent', 0.5, { threadId: '900', fromAddress: 'owner@example.test', sender: 'Ägare' })],
    trash: [entry('999', 'trash', 0)], spam: [entry('998', 'spam', 0)], drafts: [entry('997', 'drafts', 0)], arch: [entry('996', 'arch', 0)],
  };
  const setup = ({ thread = [lists.custom[0], lists.in[0], lists.sent[0]], contents = {}, accounts = [{ accountId: 'A', primaryEmailAddress: account.email }], tokenBody = { access_token: 'access-token-value', expires_in: 3600 } } = {}) => {
    const calls = [];
    const fetcher = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const { pathname, searchParams } = new URL(url);
      const json = body => ({ status: 200, json: async () => body });
      if (pathname === '/oauth/v2/token') return json(tokenBody);
      assert.equal(init.headers.Authorization, 'Zoho-oauthtoken access-token-value');
      const ok = value => json({ status: { code: 200 }, data: value });
      if (pathname === '/api/accounts') return ok(accounts);
      if (pathname === '/api/accounts/A/folders') return ok(folders);
      if (pathname === '/api/accounts/A/messages/view') {
        // As documented: archived mail is left out of a conversation unless asked for.
        if (searchParams.get('threadId')) return ok(searchParams.get('includearchive') === 'true' ? thread : thread.filter(item => item.folderId !== 'arch'));
        const start = Number(searchParams.get('start'));
        return ok((lists[searchParams.get('folderId')] ?? []).slice(start - 1, start - 1 + Number(searchParams.get('limit'))));
      }
      const content = /\/messages\/([^/]+)\/content$/.exec(pathname)?.[1];
      if (content) return ok({ messageId: content, content: contents[content] ?? `<div>Text ${content}</div>` });
      throw new Error(`unexpected ${pathname}`);
    };
    return { api: new AssistantZohoApi(data, fetcher), calls };
  };
  const coded = code => error => error instanceof AssistantZohoApiError && error.code === code;

  assert.equal(new AssistantZohoApi(mkdtempSync(join(dir, 'none-'))).available(account), false, 'no private file means the web route');
  assert.equal(setup().api.available(account), true);
  assert.equal(setup().api.available({ ...account, url: 'https://mail.zoho.com/zm/' }), false, 'a credential is bound to its own Zoho region');
  assert.equal(setup().api.available({ ...account, provider: 'gmail' }), false);

  // Inventory: only incoming folders inside the period, grouped into conversations.
  {
    const { api, calls } = setup();
    const inventory = await api.inventory(account, since);
    assert.equal(inventory.complete, true);
    assert.deepEqual(inventory.rows.map(row => row.key), ['zoho:900', 'zoho:101', 'zoho:201'], 'newest first, one row per conversation');
    const thread = inventory.rows[0];
    assert.equal(thread.version, 'zoho:message:100', 'a conversation row carries its newest incoming message');
    assert.equal(thread.unread, true);
    assert.equal(inventory.rows[1].unread, false);
    assert.match(thread.label, /Kund Ämne & rubrik/);
    assert.deepEqual(inventory.sentThreads, ['zoho:900']);
    for (const key of ['zoho:999', 'zoho:998', 'zoho:997', 'zoho:996', 'zoho:old']) assert.equal(api.canRead(account.id, key), false);
    assert.equal(api.canRead('another-account', 'zoho:900'), false, 'an inventory belongs to its own account');
    assert.equal(calls.filter(call => call.url.includes('/oauth/v2/token')).length, 1, 'one refresh serves the whole run');
    const text = JSON.stringify(inventory);
    for (const value of [...Object.values(secrets), 'access-token-value']) if (value !== secrets.accountsServer) assert.equal(text.includes(value), false);
  }

  // Paging continues while the period continues, and stops at the first older page.
  {
    const saved = lists.custom;
    lists.custom = Array.from({ length: 200 }, (_, index) => entry(`p${index}`, 'custom', 1)).concat(entry('last', 'custom', 2), entry('older', 'custom', 40));
    const inventory = await setup().api.inventory(account, since);
    assert.equal(inventory.rows.some(row => row.key === 'zoho:last'), true, 'the next page of the period is read');
    assert.equal(inventory.rows.some(row => row.key === 'zoho:older'), false);
    lists.custom = Array.from({ length: 200 * 26 }, (_, index) => entry(`q${index}`, 'custom', 1));
    assert.equal((await setup().api.inventory(account, since)).complete, false, 'stopping at the page limit is not a complete inventory');
    lists.custom = saved;
  }

  // A conversation across Inbox, a custom folder and Sent, in thread order.
  {
    const { api } = setup();
    await api.inventory(account, since);
    const thread = await api.readThread(account, 'zoho:900');
    assert.equal(thread.complete, true);
    assert.deepEqual(thread.messages.map(message => message.messageId), ['200', '100', '300']);
    assert.deepEqual(thread.messages.map(message => message.incoming), [true, true, false]);
    assert.deepEqual(thread.messages.map(message => message.sender), ['kund@example.test', 'kund@example.test', 'owner@example.test']);
    assert.equal(thread.messages[0].body, 'Text 200');
    assert.match(thread.messages[0].recipients, /Till: <owner@example\.test>/);
    assert.equal(thread.messages[0].recipients.includes('Not Provided'), false);
    assert.deepEqual(thread.messages[0].addressed, ['owner@example.test']);
    assert.equal(thread.subject, 'Ämne & rubrik');
    const single = await api.readThread(account, 'zoho:101');
    assert.equal(single.complete, true); assert.equal(single.messages.length, 1);
  }

  // Anything that could hide part of a conversation leaves it incomplete.
  {
    const missing = setup({ thread: [lists.custom[0], lists.sent[0]] });
    await missing.api.inventory(account, since);
    assert.equal((await missing.api.readThread(account, 'zoho:900')).complete, false, 'a message seen in a folder must be in the conversation');
    const foreign = setup({ thread: [lists.custom[0], lists.in[0], lists.sent[0], { ...entry('x', 'in', 1), threadId: '111' }] });
    await foreign.api.inventory(account, since);
    assert.equal((await foreign.api.readThread(account, 'zoho:900')).complete, false, 'a message of another conversation is not part of this one');
    const full = setup({ thread: Array.from({ length: 200 }, (_, index) => entry(String(index), 'in', 1, { threadId: '900' })).concat() });
    await full.api.inventory(account, since);
    assert.equal((await full.api.readThread(account, 'zoho:900')).complete, false, 'a full page cannot prove the end of the conversation');
    const drafted = setup({ thread: [lists.custom[0], lists.in[0], lists.sent[0], entry('d1', 'drafts', 0.1, { threadId: '900', fromAddress: 'owner@example.test' })] });
    await drafted.api.inventory(account, since);
    const draftRead = await drafted.api.readThread(account, 'zoho:900');
    assert.equal(draftRead.complete, false, 'a draft in the conversation could read as a reply');
    assert.equal(draftRead.messages.length, 4, 'the incomplete result still names the messages for the web route');
    assert.equal(draftRead.messages.every(message => !message.body), true, 'no body is fetched for a thread already known to be incomplete');
    const unknownFolder = setup({ thread: [lists.custom[0], lists.in[0], lists.sent[0], entry('u1', 'somewhere', 0.1, { threadId: '900' })] });
    await unknownFolder.api.inventory(account, since);
    assert.equal((await unknownFolder.api.readThread(account, 'zoho:900')).complete, false);
    const attachmentOnly = setup({ contents: { 201: '' } });
    await attachmentOnly.api.inventory(account, since);
    assert.equal((await attachmentOnly.api.readThread(account, 'zoho:201')).complete, false, 'an attachment-only message stays incomplete');
    const unnamed = setup({ thread: [lists.custom[0], lists.in[0], { ...lists.sent[0], fromAddress: '' }] });
    await unnamed.api.inventory(account, since);
    assert.equal((await unnamed.api.readThread(account, 'zoho:900')).complete, false, 'every message needs a sender address');
  }

  // Only threads this inventory listed, on the verified account.
  {
    const { api } = setup();
    await assert.rejects(api.readThread(account, 'zoho:900'), coded('unknown-thread'));
    await api.inventory(account, since);
    await assert.rejects(api.readThread(account, 'zoho:12345678'), coded('unknown-thread'));
    await assert.rejects(setup({ accounts: [{ accountId: 'B', primaryEmailAddress: 'other@example.test' }] }).api.inventory(account, since), coded('account-mismatch'));
    const saved = folders.splice(2, 1);
    await assert.rejects(setup().api.inventory(account, since), coded('request'), 'a folder list without Sent is not an empty mailbox');
    folders.splice(2, 0, ...saved);
    assert.deepEqual((await setup({ accounts: [{ accountId: 'A', incomingUserName: 'OWNER@example.test' }] }).api.inventory(account, since)).rows.length, 3, 'the login name also identifies the account');
  }

  // Failures fall back without exposing a credential.
  {
    await assert.rejects(setup({ tokenBody: { error: 'invalid_client' } }).api.inventory(account, since), error => coded('request')(error) && !error.message.includes(secrets.clientSecret));
    const down = new AssistantZohoApi(data, async () => { throw new TypeError(`network ${secrets.refreshToken}`); });
    await assert.rejects(down.inventory(account, since), error => coded('request')(error) && !error.message.includes(secrets.refreshToken));
    const denied = new AssistantZohoApi(data, async url => String(url).includes('/oauth/') ? { status: 200, json: async () => ({ access_token: 'access-token-value' }) } : { status: 400, json: async () => ({ status: { code: 400 }, data: { errorCode: 'X' } }) });
    await assert.rejects(denied.inventory(account, since), coded('request'));
    save({ ...secrets, accountsServer: 'https://accounts.evil.test' });
    assert.equal(new AssistantZohoApi(data).available(account), false, 'a credential cannot point the refresh at another host');
    save(secrets);
    {
      const broken = setup();
      await broken.api.inventory(account, since);
      const original = broken.api.get;
      broken.api.get = async function (base, path) { if (path.includes('/content')) throw new AssistantZohoApiError('request', 'x'); return original.call(this, base, path); };
      const partial = await broken.api.readThread(account, 'zoho:900');
      assert.equal(partial.complete, false, 'an unreadable message leaves the thread incomplete');
      assert.equal(partial.messages.length, 3, 'instead of ending the read without a web address');
      broken.api.get = async function (base, path) { if (path.includes('threadId=')) throw new AssistantZohoApiError('request', 'x'); return original.call(this, base, path); };
      const listless = await broken.api.readThread(account, 'zoho:900');
      assert.equal(listless.complete, false); assert(listless.messages.length > 0, 'a failed conversation listing still names what the inventory saw');
    }
    const { calls, api } = setup();
    await api.inventory(account, since);
    assert(calls.every(call => call.init.redirect === 'error' && call.init.signal), 'no request follows a redirect or runs without a deadline');
  }

  // The reply address: the one permitted address whoever wrote last used, and nothing else.
  {
    const listed = (senders, status = true) => [{ accountId: 'A', primaryEmailAddress: account.email, sendMailDetails: senders.map(fromAddress => ({ fromAddress, status })) }];
    const replyFrom = async (accounts, toAddress, ccAddress = 'Not Provided') => {
      const { api } = setup({ accounts, thread: [lists.custom[0], { ...lists.in[0], toAddress, ccAddress }, lists.sent[0]] });
      await api.inventory(account, since);
      return (await api.readThread(account, 'zoho:900')).replyFrom;
    };
    const alias = 'alias@example.test', other = 'annan@example.test';
    assert.equal(await replyFrom(listed([account.email, alias]), `&lt;${alias.toUpperCase()}&gt;`), alias, 'the address the customer used');
    assert.equal(await replyFrom(listed([account.email, alias]), `&lt;${account.email}&gt;`), account.email, 'the main address stays the main address');
    assert.equal(await replyFrom(listed([account.email]), `&lt;${alias}&gt;`), undefined, 'an address Zoho does not list as a sender');
    assert.equal(await replyFrom(listed([account.email, alias, other]), `&lt;${alias}&gt;`, `&lt;${other}&gt;`), undefined, 'two possible senders name none');
    assert.equal(await replyFrom(listed([alias], false), `&lt;${alias}&gt;`), undefined, 'a disabled sender');
    assert.equal(await replyFrom(undefined, `&lt;${alias}&gt;`), undefined, 'an account without a sender list');
    assert.equal(await replyFrom(listed([alias]), `&quot;${alias}&quot; &lt;someone@elsewhere.example.test&gt;`), undefined, 'an address in a quoted display name is only text');
    assert.equal(await replyFrom(listed([alias]), `${alias} &lt;someone@elsewhere.example.test&gt;`), undefined, 'and in an unquoted one');
    assert.equal(await replyFrom(listed([alias]), `&lt;someone@elsewhere.example.test&gt;`, `&quot;${alias}&quot; &lt;third@elsewhere.example.test&gt;`), undefined, 'and in a copy line');
    assert.equal(await replyFrom(listed([alias]), `&quot;Kund, Avdelning&quot; &lt;someone@elsewhere.example.test&gt;, &lt;${alias}&gt;`), alias, 'a comma inside a name does not split the list');
  }

  // Sending one approved reply: the send grant is used for the POST and nothing else.
  {
    const sendData = mkdtempSync(join(dir, 'send-'));
    const write = (name, value) => { const path = join(sendData, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); };
    write('zoho-mail-oauth.json', { ...secrets, refreshToken: 'read-refresh' });
    write('zoho-mail-oauth-send.json', { ...secrets, refreshToken: 'send-refresh' });
    const alias = 'alias@example.test', customer = 'kund@example.test';
    const incoming = entry('100', '111', 1, { threadId: '900', subject: 'Fr&aring;ga' });
    const typed = [{ folderId: '111', folderType: 'Inbox' }, { folderId: '222', folderType: 'Sent' }, { folderId: '333', folderType: 'Trash' }, { folderId: '444', folderType: 'Spam' }, { folderId: '555', folderType: 'Drafts' }, { folderId: '666', folderType: 'Archive' }];
    const senders = [{ fromAddress: account.email, status: true }, { fromAddress: alias, status: true }];
    const approval = { itemId: 'i', revision: 1, account, threadId: 'zoho:900', sourceUrl: 'https://mail.zoho.eu/zm/#mail/folder/111/p/100', recipient: customer, body: 'Hej!\nTack för ditt mejl.', sender: alias };
    const replies = ({ thread = [incoming], sent = [], archived = [], moved = [], details = entry('100', '111', 1, { subject: 'SV: Fråga' }), postStatus = 200, postBody = { status: { code: 200 }, data: {} }, postThrows = false, tokens = {}, sendersList = senders, data = sendData } = {}) => {
      const calls = [];
      const fetcher = async (url, init = {}) => {
        const { pathname, searchParams } = new URL(url);
        calls.push({ pathname, init });
        const json = (body, status = 200) => ({ status, json: async () => body });
        const ok = value => json({ status: { code: 200 }, data: value });
        if (pathname === '/oauth/v2/token') {
          const refresh = init.body.get('refresh_token');
          return json(tokens[refresh] ?? { access_token: `access-${refresh}`, expires_in: 3600 });
        }
        if (init.method === 'POST') {
          assert.equal(init.headers.Authorization, 'Zoho-oauthtoken access-send-refresh', 'only the POST holds the send grant');
          if (postThrows) throw new Error('connection lost');
          return json(postBody, postStatus);
        }
        assert.equal(init.headers.Authorization, 'Zoho-oauthtoken access-read-refresh', 'reads never use the send grant');
        if (pathname === '/api/accounts') return ok([{ accountId: 'A', primaryEmailAddress: account.email, sendMailDetails: typeof sendersList === 'function' ? sendersList() : sendersList }]);
        if (pathname === '/api/accounts/A/folders') return ok(typed);
        // As measured on a real account: a folder listing that asks for archived mail comes back
        // without the folder's other mail. As documented: a plain listing leaves archived mail out.
        if (pathname === '/api/accounts/A/messages/view') return ok(searchParams.get('threadId') ? thread : searchParams.get('folderId') === '222' ? searchParams.get('includearchive') === 'true' ? archived : sent
          : searchParams.get('folderId') === '666' && searchParams.get('includearchive') !== 'true' ? moved : []);
        if (pathname.endsWith('/details')) return ok(details);
        throw new Error(`unexpected ${pathname}`);
      };
      return { api: new AssistantZohoApi(data, fetcher), calls, posts: () => calls.filter(call => call.init.method === 'POST' && call.pathname !== '/oauth/v2/token') };
    };
    const noIntent = async () => { throw new Error('intent must not run'); };

    assert.equal(replies().api.canSend(account), true);
    assert.equal(setup().api.canSend(account), false, 'a read grant alone cannot send');
    assert.equal(replies().api.canSend({ ...account, url: 'https://mail.zoho.com/zm/' }), false, 'the send grant is bound to its region');

    {
      const { api, posts } = replies();
      const order = [];
      const receipt = await api.reply(approval, 'zoho:message:100', async () => { order.push(`intent:${posts().length}`); });
      assert.deepEqual(order, ['intent:0'], 'the attempt is recorded before the POST');
      assert.equal(posts().length, 1);
      assert.equal(posts()[0].pathname, '/api/accounts/A/messages/100', 'the reply answers the approved message');
      assert.deepEqual(JSON.parse(posts()[0].init.body), { fromAddress: alias, toAddress: customer, action: 'reply', subject: 'Re: Fråga', content: 'Hej!\nTack för ditt mejl.', mailFormat: 'plaintext' });
      assert.equal(receipt, `${alias}: Zoho bekräftade utskicket.`);
      assert.doesNotMatch(receipt, /access-|refresh/);
    }
    {
      const { api, posts } = replies({ thread: [entry('100', '111', 1, { threadId: '900', subject: 'SV: Fråga' })] });
      await api.reply({ ...approval, sender: undefined }, 'zoho:message:100', async () => {});
      const sent = JSON.parse(posts()[0].init.body);
      assert.equal(sent.fromAddress, account.email, 'a card without a named sender uses the account address');
      assert.equal(sent.subject, 'SV: Fråga', 'a reply subject is not prefixed twice');
    }
    {
      const lone = { ...approval, threadId: 'zoho:100' };
      const { api, posts } = replies();
      await api.reply(lone, 'zoho:message:100', async () => {});
      assert.equal(posts().length, 1, 'a message standing alone has no thread to list');
      const joined = replies({ details: entry('100', '111', 1, { threadId: '900' }) });
      await assert.rejects(joined.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'a message that has gained a thread must be read again');
      await assert.rejects(replies().api.reply({ ...lone, sourceUrl: 'https://mail.zoho.eu/zm/#mail/folder/inbox/p/100' }, 'zoho:message:100', noIntent), coded('refused'), 'the folder must be known');
      const answered = replies({ sent: [entry('300', '222', 0.5, { toAddress: `&lt;${customer}&gt;` })] });
      await assert.rejects(answered.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'an answer in Sent that has not joined the message');
      assert.equal(answered.posts().length, 0);
      // An answer the user archived in Zoho stays in Sent, hidden from a plain listing.
      const archived = replies({ archived: [entry('304', '222', 0.5, { toAddress: `&lt;${customer}&gt;` })] });
      await assert.rejects(archived.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'an archived answer in Sent is still an answer');
      assert.equal(archived.posts().length, 0);
      // As measured on a real account: archiving a sent message moves it into the Archive folder,
      // out of the Sent listing with and without the parameter.
      const moved = replies({ moved: [entry('305', '666', 0.5, { toAddress: `&lt;${customer}&gt;` })] });
      await assert.rejects(moved.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'an answer moved to the Archive folder is still an answer');
      assert.equal(moved.posts().length, 0);
      const movedElsewhere = replies({ moved: [entry('306', '666', 0.5, { toAddress: 'annan@example.test' }), entry('307', '666', 2, { toAddress: customer })] });
      await movedElsewhere.api.reply(lone, 'zoho:message:100', async () => {});
      assert.equal(movedElsewhere.posts().length, 1, 'archived mail to someone else, or older archived mail to the customer, is not an answer');
      const copied = replies({ sent: [entry('301', '222', 0.5, { toAddress: 'annan@example.test', ccAddress: customer })] });
      await assert.rejects(copied.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'a copy to the customer is mail to them too');
      const unrelated = replies({ sent: [entry('302', '222', 0.5, { toAddress: 'annan@example.test' }), entry('303', '222', 2, { toAddress: customer })] });
      await unrelated.api.reply(lone, 'zoho:message:100', async () => {});
      assert.equal(unrelated.posts().length, 1, 'mail to someone else, or older mail to the customer, is not an answer');
      const flooded = replies({ sent: Array.from({ length: 200 }, (_, index) => entry(String(400 + index), '222', 0.5, { toAddress: 'annan@example.test' })) });
      await assert.rejects(flooded.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'Sent too long to prove nothing went out');
      const empty = replies({ details: undefined, postStatus: 200 });
      empty.api.get = async (base, path) => path.endsWith('/details') ? undefined : AssistantZohoApi.prototype.get.call(empty.api, base, path);
      await assert.rejects(empty.api.reply(lone, 'zoho:message:100', noIntent), coded('refused'), 'an empty answer proves nothing');
    }
    {
      const { api, posts } = replies({ thread: [entry('100', '111', 1, { threadId: '900', subject: 'Offert&#13;&#10;Bcc: extra@example.test' })] });
      await api.reply(approval, 'zoho:message:100', async () => {});
      assert.equal(JSON.parse(posts()[0].init.body).subject, 'Re: Offert Bcc: extra@example.test', 'a subject cannot carry a line break into the request');
    }
    {
      let permitted = senders;
      const { api, posts } = replies({ sendersList: () => permitted });
      await api.reply(approval, 'zoho:message:100', async () => {});
      permitted = [{ fromAddress: account.email, status: true }];
      await assert.rejects(api.reply(approval, 'zoho:message:100', noIntent), coded('refused'), 'permitted senders are read again for each send');
      assert.equal(posts().length, 1);
    }

    // Each doubt stops before the attempt is recorded, and nothing is posted.
    for (const [why, options, input = approval, message = 'zoho:message:100'] of [
      ['a newer message arrived', { thread: [incoming, entry('101', '111', 0.5, { threadId: '900' })] }],
      ['the user answered in Zoho', { thread: [incoming, entry('300', '222', 0.5, { threadId: '900', fromAddress: account.email })] }],
      ['a draft joined the conversation', { thread: [incoming, entry('301', '555', 0.5, { threadId: '900' })] }],
      ['an older draft sits in the conversation', { thread: [entry('301', '555', 2, { threadId: '900' }), incoming] }],
      ['another conversation is mixed in', { thread: [entry('302', '111', 2, { threadId: '901' }), incoming] }],
      ['the listing is full', { thread: [...Array.from({ length: 199 }, (_, index) => entry(String(500 + index), '111', 3, { threadId: '900' })), incoming] }],
      ['the message went to Trash', { thread: [entry('100', '333', 1, { threadId: '900' })] }],
      ['the message went to Spam', { thread: [entry('100', '444', 1, { threadId: '900' })] }],
      ['Zoho listed nothing', { thread: [] }],
      ['another sender wrote it', { thread: [entry('100', '111', 1, { threadId: '900', fromAddress: 'other@example.test' })] }],
      ['the sender is no longer permitted', { sendersList: [{ fromAddress: account.email, status: true }, { fromAddress: alias, status: false }] }],
      ['the card names no native message', {}, approval, 'zoho:hash:abc'],
      ['the card names no native thread', {}, { ...approval, threadId: 'zoho:abc' }],
    ]) {
      const { api, posts } = replies(options);
      await assert.rejects(api.reply(input, message, noIntent), coded('refused'), why);
      assert.equal(posts().length, 0, why);
    }
    {
      const bad = replies({ tokens: { 'send-refresh': { error: 'invalid_code' } } });
      await assert.rejects(bad.api.reply(approval, 'zoho:message:100', noIntent), coded('request'), 'a send grant Zoho refuses stops before the attempt');
      assert.equal(bad.posts().length, 0);
      const readOnly = mkdtempSync(join(dir, 'read-only-'));
      writeFileSync(join(readOnly, 'zoho-mail-oauth.json'), JSON.stringify({ ...secrets, refreshToken: 'read-refresh' }), { mode: 0o600 });
      chmodSync(join(readOnly, 'zoho-mail-oauth.json'), 0o600);
      await assert.rejects(replies({ data: readOnly }).api.reply(approval, 'zoho:message:100', noIntent), error => error.code === 'refused' && /sändningsbehörighet/.test(error.message));
    }

    // After the attempt is recorded a failure is uncertain, and the POST is never repeated.
    for (const [why, options] of [['the connection dropped', { postThrows: true }], ['Zoho refused it', { postStatus: 400, postBody: { status: { code: 400 } } }], ['Zoho answered 200 with an error', { postBody: { status: { code: 500 } } }], ['an error status carried a success body', { postStatus: 500, postBody: { status: { code: 200 } } }]]) {
      const { api, posts } = replies(options);
      let intents = 0;
      await assert.rejects(api.reply(approval, 'zoho:message:100', async () => { intents++; }), coded('uncertain'), why);
      assert.equal(intents, 1, why);
      assert.equal(posts().length, 1, `${why}: one POST and no retry`);
    }
    {
      const { api, posts } = replies();
      await assert.rejects(api.reply(approval, 'zoho:message:100', async () => { throw new Error('approval changed'); }), /approval changed/);
      assert.equal(posts().length, 0, 'an intent that fails sends nothing');
    }
  }
  console.log('PASS assistant-zoho-api');
} finally {
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
