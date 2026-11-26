import assert from 'node:assert/strict';
import { assistantComposerScript, verifyAssistantComposer, assistantElementScript, assistantGmailOpenThreadScript, assistantMessageMetadataScript, assistantGmailRowTargetsScript, assistantLoadingScript, assistantIdentityMenuScript, assistantZohoFoldersScript, guardAssistantElement } from '../dist/assistant-browser.mjs';
import { build } from 'esbuild';
import { openCdpObserver } from './helpers/cdp-observer.mjs';
import { watchdog } from './watchdog.mjs';

let observer, targetId;
const cleanup = async () => { if (targetId) await observer?.rpc('Target.closeTarget', { targetId }).catch(() => {}); observer?.socket.close(); };
const stop = watchdog(cleanup);
try {
  observer = await openCdpObserver(new URL(process.argv[2]), { timeoutMs: 10000, timeoutMessage: method => `${method} timed out` });
  ({ targetId } = await observer.rpc('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = await observer.rpc('Target.attachToTarget', { targetId, flatten: true });
  const { frameTree } = await observer.rpc('Page.getFrameTree', {}, sessionId);
  const { executionContextId } = await observer.rpc('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'tabai-zoho-readiness-test' }, sessionId);
  const evaluate = async (expression, contextId) => {
    const result = await observer.rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const run = (fn, ...args) => evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`, fn === assistantZohoFoldersScript ? executionContextId : undefined);
  const set = html => evaluate(`document.body.innerHTML=${JSON.stringify(html)}`);
  const compiled = await build({ entryPoints: ['extension/src/perception-scripts.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const { perceiveInPage } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const account = { id: 'fixture', provider: 'gmail', label: 'Isolerat test', email: 'owner@example.test', url: 'https://mail.google.com/mail/u/0/', enabled: true };
  // Gmail can retain the search in its route while the native search input is empty.
  await set('<input aria-label="Search mail" value=""><main role="main"><table role="grid"><tbody><tr class="zA" role="row"><td class="a4W" role="gridcell">Native fixture subject</td></tr></tbody></table></main>');
  for (const [hash, area, scoped] of [
    ['#search/in%3Ainbox', 'inbox', false],
    ['#search/in%3Asent+newer_than%3A7d', 'sent', true],
    ['#search/in%3Ainbox%20newer_than%3A7d', 'inbox', true],
    ['#search/in%3Asent/FMfcgzFixtureABC123', 'sent', true],
  ]) {
    await evaluate(`location.hash=${JSON.stringify(hash)}`);
    const navigation = await run(perceiveInPage, { mode: 'scan', filter: 'all', maxResults: 500 });
    const openingRef = navigation.nodes.find(node => node.role === 'gridcell').ref;
    const search = await run(assistantMessageMetadataScript, 'gmail', '');
    assert.deepEqual(search.areas, [area], 'an unambiguous Gmail search route identifies its native list even with an empty search input');
    assert.equal(search.view, 'list');
    assert.equal(search.rows[0].ref, openingRef);
    assert.equal(search.inboxSearchScoped, scoped);
    assert.notEqual(search.historyComplete, true, 'a scoped list search is navigation, not a complete content read');
  }
  await set('<nav role="navigation"><span aria-current="page">Inbox</span></nav><input aria-label="Search mail" value=""><main role="main"><table role="grid"><tbody><tr class="zA" role="row"><td class="a4W" role="gridcell">Fixture subject</td></tr></tbody></table></main>');
  await evaluate('location.hash="#search/in%3Asent"');
  assert.deepEqual((await run(assistantMessageMetadataScript, 'gmail', '')).areas, ['sent'], 'a recognized search route overrides an unchanged sidebar folder');
  for (const hash of ['#search/in%3Ainbox+from%3Afixture', '#search/in%3Ainbox/p2', '#search/in%3Ainbox%ZZ', '#search%252Fin%3Ainbox']) {
    await evaluate(`location.hash=${JSON.stringify(hash)}`);
    const scoped = await run(assistantMessageMetadataScript, 'gmail', '');
    assert.equal(scoped.inboxSearchScoped, true, 'sidebar fallback cannot turn unknown, paged or malformed search routes into inbox inventory');
  }
  for (const query of ['-in:inbox', '"in:inbox"', 'in:inbox OR in:sent', '(in:inbox)', 'in:inbox in:sent', 'in:inbox from:fixture', 'in%3Ainbox', '%ZZ']) {
    await evaluate('document.querySelector("nav")?.remove()');
    await evaluate(`location.hash=${JSON.stringify('#search/' + encodeURIComponent(query))}`);
    assert.deepEqual((await run(assistantMessageMetadataScript, 'gmail', '')).areas, [], 'ambiguous, encoded-again or unsupported route queries cannot establish a mail area');
  }
  await evaluate('location.hash=""');
  const unreferencedRows = Array.from({ length: 15 }, (_, i) => `<tr role="row" class="zA"><td class="a4W" role="gridcell">Fixture subject ${i}</td></tr>`).join('');
  await set(`<main role="main">${'<button>Competing control</button>'.repeat(501)}<table role="grid"><tbody>${unreferencedRows}</tbody></table></main>`);
  const limited = await run(perceiveInPage, { mode: 'scan', filter: 'all', maxResults: 500 });
  assert.equal(limited.nodes.length, 500); assert.equal(limited.truncated, true);
  assert((await run(assistantMessageMetadataScript, 'gmail', '')).rows.every(row => row.ref === null));
  const nativeTargets = await run(assistantGmailRowTargetsScript);
  assert.equal(nativeTargets.length, 12);
  assert((await run(assistantMessageMetadataScript, 'gmail', '')).rows.every(row => row.ref === null), 'discovery never writes reference attributes or maps');
  for (const selector of nativeTargets) {
    const before = await run(perceiveInPage, { mode: 'resolve', selector });
    assert.equal(before.matchCount, 1); assert.equal(before.nodes.length, 0);
    const resolved = await run(perceiveInPage, { mode: 'resolve', selector, mint: true });
    assert.equal(resolved.matchCount, 1); assert.equal(resolved.nodes[0].role, 'gridcell');
    const stable = await run(perceiveInPage, { mode: 'resolve', selector });
    assert.equal(stable.matchCount, 1); assert.equal(stable.matches[0].ref, resolved.nodes[0].ref);
    const element = await run(assistantElementScript, resolved.nodes[0].ref, 'gmail');
    assert.equal(element.nativeGmailSubject, true);
    assert.doesNotThrow(() => guardAssistantElement('click', element, account, account.url));
  }
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows.filter(row => row.ref).length, 12);
  assert.equal((await run(assistantGmailRowTargetsScript)).length, 3, 'existing native references are reused');
  for (const style of ['visibility:hidden', 'visibility:collapse', 'opacity:0']) {
    await set(`<main role="main"><div style="${style}"><table role="grid"><tbody>${unreferencedRows}</tbody></table></div><table role="grid"><tbody><tr class="zA" role="row"><td class="a4W" role="gridcell">Visible subject</td></tr></tbody></table></main>`);
    assert.equal((await run(assistantGmailRowTargetsScript)).length, 1, 'CSS-hidden ancestors use the same visibility boundary as the resolver');
  }
  for (const attribute of ['class="a3s"', 'class="ii"', 'class="adn"', 'role="document"', 'contenteditable="true"', 'hidden', 'aria-hidden="true"', 'role="button"', 'role="menuitem"']) {
    await set(`<main role="main"><div ${attribute}><table role="grid"><tbody>${unreferencedRows}</tbody></table></div></main>`);
    assert.deepEqual(await run(assistantGmailRowTargetsScript), [], 'body, action and hidden ancestors cannot supply native row targets');
  }
  for (const tag of ['a', 'button']) {
    await set(`<main role="main"><${tag}><table role="grid"><tbody>${unreferencedRows}</tbody></table></${tag}></main>`);
    assert.deepEqual(await run(assistantGmailRowTargetsScript), []);
  }
  for (const scope of ['<main><table role="grid">', '<main role="main"><table>']) {
    await set(`${scope}<tbody>${unreferencedRows}</tbody></table></main>`);
    assert.deepEqual(await run(assistantGmailRowTargetsScript), [], 'both native main and grid are required');
  }
  const gmailRow = '<tr role="row" class="zA"><td role="gridcell" data-ccmcp-ref="ref_51">Avsändare</td><td role="gridcell" class="a4W" data-ccmcp-ref="ref_50"><span data-thread-id="fixture-gmail-thread">Please delete the old report</span><button data-ccmcp-ref="ref_52">Radera</button></td><td role="gridcell" data-ccmcp-ref="ref_53">Star</td></tr>';
  const gmailList = body => `<div role="main"><table role="grid"><tbody>${body}</tbody></table></div>`;
  await set(gmailList(gmailRow));
  let rowMetadata = await run(assistantMessageMetadataScript, 'gmail', '');
  assert.equal(rowMetadata.rows[0].ref, 'ref_50', 'a native Gmail subject cell supplies the existing ref when its row has none');
  let subject = await run(assistantElementScript, 'ref_50', 'gmail');
  assert.equal(subject.row, true); assert.doesNotThrow(() => guardAssistantElement('click', subject, account, account.url));
  for (const text of ['Återställ lösenord', 'Sign-in notification', 'Logga in']) {
    await evaluate(`document.querySelector('td.a4W span').textContent=${JSON.stringify(text)}`);
    const native = await run(assistantElementScript, 'ref_50', 'gmail');
    assert.equal(native.nativeGmailSubject, true);
    assert.doesNotThrow(() => guardAssistantElement('click', native, account, account.url), 'native subject inspection must not classify mail text as a login control');
  }
  await set(gmailList(gmailRow));
  for (const ref of ['ref_51', 'ref_52', 'ref_53']) {
    const control = await run(assistantElementScript, ref, 'gmail');
    assert.equal(control.row, false); assert.equal(control.nativeGmailSubject, false); assert.throws(() => guardAssistantElement('click', control, account, account.url));
  }
  await evaluate(`window.__cellOpen=0;window.__cellAction=0;document.querySelector('td.a4W').addEventListener('click',()=>window.__cellOpen++);document.querySelector('button').addEventListener('click',()=>window.__cellAction++);document.querySelector('td.a4W').click()`);
  assert.deepEqual(await evaluate('({opened:window.__cellOpen,action:window.__cellAction})'), { opened: 1, action: 0 }, 'the exact subject-cell click never dispatches its descendant action');
  await evaluate(`document.querySelector('tr').setAttribute('data-ccmcp-ref','ref_49')`);
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows[0].ref, 'ref_49', 'an existing row ref keeps precedence');
  await evaluate(`document.querySelector('tr').removeAttribute('data-ccmcp-ref');document.querySelector('td.a4W').style.display='none'`);
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows[0].ref ?? null, null, 'hidden subject cells cannot supply a ref');
  await set(gmailList(gmailRow));
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows[0].draft, false);
  await set(gmailList(gmailRow.replace('<td role="gridcell" data-ccmcp-ref="ref_51">Avsändare</td>', '<td role="gridcell" data-ccmcp-ref="ref_51">Avsändare<font class="boq">Utkast</font></td>')));
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows[0].draft, true, "Gmail's draft marker keeps a thread out of the session read");
  for (const boundary of ['class="a3s"', 'class="ii"', 'class="adn"', 'role="document"', 'contenteditable="true"']) {
    await set(gmailList(`<tr><td><div ${boundary}><table role="grid"><tbody>${gmailRow}</tbody></table></div></td></tr>`));
    assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows.length, 0, 'body tables cannot become inbox rows');
    assert.deepEqual(await run(assistantGmailRowTargetsScript), [], 'body tables cannot supply resolver targets');
    subject = await run(assistantElementScript, 'ref_50', 'gmail');
    assert.equal(subject.row, false); assert.equal(subject.nativeGmailSubject, false); assert.throws(() => guardAssistantElement('click', subject, account, account.url));
  }
  for (const html of [gmailList(gmailRow).replace('role="main"', ''), gmailList(gmailRow).replace('role="grid"', ''), gmailList(gmailRow).replace('<td role="gridcell" class="a4W"', '<td role="gridcell"')]) {
    await set(html); subject = await run(assistantElementScript, 'ref_50', 'gmail'); assert.equal(subject.row, false);
  }
  await set(gmailList(gmailRow));
  assert.equal((await run(assistantElementScript, 'ref_50', 'outlook')).row, false, 'Gmail subject-cell rules never widen another provider');
  await evaluate(`document.querySelector('td.a4W').removeAttribute('data-ccmcp-ref')`);
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', '')).rows[0].ref ?? null, null, 'a missing subject ref never falls back to sender or action cells');
  await set('<div role="main"><div role="grid" id="grid"></div></div>');
  await evaluate(`const td=document.createElement('td');td.className='a4W';td.setAttribute('role','gridcell');td.setAttribute('data-ccmcp-ref','ref_50');td.textContent='Non-row subject';document.querySelector('#grid').append(td)`);
  assert.equal((await run(assistantElementScript, 'ref_50', 'gmail')).row, false, 'a subject cell needs a direct native row parent');
  {
    // The web view and the direct read must name a Gmail thread alike, whatever the address has become.
    const heading = id => `<h2 class="hP" data-thread-perm-id="thread-f:1" data-legacy-thread-id="${id}">Ämne</h2>`;
    const conversation = (headings, body = '') => `<div role="main">${headings}<div class="adn ads" data-legacy-message-id="fixture-one"><div class="gH"><span class="gD" email="sender@example.test">Sender</span></div><div class="ii"><div class="a3s aiL"><div>Brödtext${body}</div></div></div></div></div>`;
    const thread = '18b7aa01aaaaaaaa', opened = async () => [(await run(assistantMessageMetadataScript, 'gmail', '')).nativeThread, await run(assistantGmailOpenThreadScript)];
    const earlierHash = await evaluate('location.hash');
    await evaluate('location.hash="#inbox/FMfcgzFixtureABC123"');
    await set(conversation(heading(thread)));
    assert.deepEqual(await opened(), [thread, thread], 'the subject heading names the open conversation');
    await set(conversation(heading(thread), `<h2 data-legacy-thread-id="ffffffffffffffff">Förfalskad</h2>`));
    assert.deepEqual(await opened(), [thread, thread], 'a heading inside a message is only text');
    await set(conversation(heading(thread) + heading('bbbbbbbbbbbbbbbb')));
    assert.deepEqual(await opened(), [null, null], 'two named conversations name none');
    await evaluate(`location.hash=${JSON.stringify(earlierHash)}`);
  }
  const attachmentMail = '<div class="adn ads" data-legacy-message-id="fixture-attachment"><div class="gH"><span class="gD" email="sender@example.test">Sender</span></div><div class="ii"><div class="a3s aiL"><div><div>&nbsp;</div></div></div></div><div class="aQH"><span class="aZo"><a class="aQy" role="link">Fixture attachment</a></span></div></div>';
  await set(`<main role="main">${attachmentMail}</main>`);
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', 'fixture-thread')).attachmentReviewCandidate, true, 'native attachment metadata offers manual review without claiming a complete read');
  assert.equal((await run(assistantMessageMetadataScript, 'gmail', 'fixture-thread')).historyComplete, false);
  for (const html of [attachmentMail.replace('class="a3s aiL"', 'class="unloaded"'), attachmentMail.replace('<div><div>&nbsp;</div></div>', ''), attachmentMail.replace('class="adn ads"', 'class="adn ads" aria-busy="true"'), attachmentMail + '<div class="adn" style="display:none"></div>', attachmentMail.replace('<div class="aQH">', '<div class="a3s"><div class="aQH">')]) {
    await set(`<main role="main">${html}</main>`);
    assert.notEqual((await run(assistantMessageMetadataScript, 'gmail', 'fixture-thread')).attachmentReviewCandidate, true, 'unloaded, collapsed or body-authored attachment shapes never qualify');
  }
  await set(`<main><input aria-label="Sök i e-post" value="in:sent"><div data-thread-id="fixture-thread">
    <div class="adn" data-message-id="original"><div class="gH"><span class="gD" email="sender@example.test">Avsändare</span><button data-ccmcp-ref="ref_1" aria-expanded="false">Visa äldre meddelande</button></div></div>
    <div class="adn" data-message-id="reply"><div class="gH"><span class="gD" email="owner@example.test">Jag</span></div><div class="a3s">Mitt svar<div class="gmail_quote" style="display:none">Tidigare citerat underlag</div><div class="gH"><button aria-expanded="false" data-ccmcp-ref="ref_2">Inbox</button></div></div></div>
    </div></main>`);
  let metadata = await run(assistantMessageMetadataScript, 'gmail', 'fixture-thread');
  assert.equal(metadata.historyComplete, false, 'a collapsed older message is not a complete conversation');
  const native = await run(assistantElementScript, 'ref_1', 'gmail');
  assert.equal(native.readingControl, true); assert.doesNotThrow(() => guardAssistantElement('click', native, account, account.url));
  const decoy = await run(assistantElementScript, 'ref_2', 'gmail');
  assert.equal(decoy.readingControl, false); assert.equal(decoy.bodyContent, true);
  assert.throws(() => guardAssistantElement('click', decoy, account, account.url), /meddelandetexten/);
  await evaluate(`document.querySelector('.adn').insertAdjacentHTML('beforeend','<div class="a3s">Originalets hela text</div>')`);
  metadata = await run(assistantMessageMetadataScript, 'gmail', 'fixture-thread');
  assert.equal(metadata.historyComplete, true);
  assert.equal(metadata.chronological, true);
  assert.deepEqual(metadata.messages.map(message => message.nativeId), ['original', 'reply']);
  assert.equal(metadata.messages.at(-1).sender, account.email);
  assert(metadata.scopeText.includes('Tidigare citerat underlag'), 'hidden native quoted text is retained without clicking email content');
  assert.deepEqual(metadata.areas, ['sent']);
  await set(`<div role="main" class="Mq3cC"><div data-app-section="MailReadCompose"><span role="heading"><span role="button" aria-label="Owner &lt;owner@example.test&gt;">Jag</span></span><div role="document" class="BIZfh">Läst mejl<span role="heading"><button role="button" aria-expanded="false" data-ccmcp-ref="ref_3">Inbox</button></span></div></div></div>`);
  metadata = await run(assistantMessageMetadataScript, 'outlook', 'fixture-thread');
  assert.equal(metadata.historyComplete, true); assert.equal(metadata.messages[0].sender, undefined, 'an address in the header of an Outlook message can be a display name, so it never names the sender');
  assert.equal(metadata.chronological, false, 'one Outlook read pane alone cannot certify an ordered multi-message conversation');
  const outlookDecoy = await run(assistantElementScript, 'ref_3', 'outlook'); assert.equal(outlookDecoy.readingControl, false);
  assert.throws(() => guardAssistantElement('click', outlookDecoy, { ...account, provider: 'outlook' }, 'https://outlook.live.com/mail/0/'), /meddelandetexten/);
  await set('<div role="treeitem" aria-selected="true">&#xebE1;&#xebE2;<span>Inkorg</span><span>markerad</span><span>29512</span><span>olästa</span></div><div role="listbox" style="width:200px;height:100px">Native lista</div>');
  assert.deepEqual((await run(assistantMessageMetadataScript, 'outlook', '')).areas,['inbox'],'Outlook built-in folder labels exclude decorative icons and localized unread metadata');
  await set('<div class="zmWrapper" style="width:300px;height:300px"><div class="zmUserInfo" data-name="profile">Profil</div></div>');
  assert.equal(await run(assistantLoadingScript, 'zoho'), true, 'a signed-in Zoho shell without a spinner is not a loaded mailbox');
  await evaluate(`document.querySelector('.zmWrapper').insertAdjacentHTML('beforeend','<div class="zmList" role="option" data-ty="mail" aria-controls="native-detail" style="width:200px;height:40px" data-ccmcp-ref="ref_4">Isolerat mejl</div>')`);
  assert.equal(await run(assistantLoadingScript, 'zoho'), false);
  const zohoRow = await run(assistantElementScript, 'ref_4', 'zoho');
  assert.equal(zohoRow.row, true, 'native rows remain readable without the transient focus class');
  await set('<div class="zmPVMail" style="width:300px"><header class="zmMailHeader">Native rubrik</header><div class="zmMailContent"><div role="document" class="jsConTent">Hela Zoho-texten<div style="display:none">Tidigare citerat svar</div><button aria-expanded="false" data-ccmcp-ref="ref_5">Inbox</button></div></div></div>');
  metadata = await run(assistantMessageMetadataScript, 'zoho', 'fixture-native-message');
  assert.equal(metadata.historyComplete, true); assert(metadata.scopeText.includes('Tidigare citerat svar'));
  const zohoDecoy = await run(assistantElementScript, 'ref_5', 'zoho'); assert.equal(zohoDecoy.bodyContent, true);
  assert.throws(() => guardAssistantElement('click', zohoDecoy, { ...account, provider: 'zoho' }, 'https://mail.zoho.eu/zm/'), /meddelandetexten/);
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div class="zmPVMail" style="width:300px;height:40px">Äldre hopfällt meddelande</div>')`);
  assert.equal((await run(assistantMessageMetadataScript, 'zoho', 'fixture-native-message')).historyComplete, false, 'collapsed Zoho native messages cannot be silently omitted');
  await set('<div class="zmPVMail" role="listitem" id="native-older"><div class="zmMailHeader zmTMailList" data-ccmcp-ref="ref_6">Subject: please delete the old report <button aria-expanded="false" data-ccmcp-ref="ref_7">Flagga</button><span role="button" class="jsCollDisp" data-ccmcp-ref="ref_8">Avsändare</span></div><div class="zmMailContent"><div role="document" class="jsConTent"></div></div></div>');
  const header = await run(assistantElementScript, 'ref_6', 'zoho');
  assert.equal(header.readingControl, true);
  assert.doesNotThrow(() => guardAssistantElement('click', header, { ...account, provider: 'zoho' }, 'https://mail.zoho.eu/zm/'));
  assert.equal((await run(assistantElementScript, 'ref_7', 'zoho')).readingControl, false, 'a flag/menu in the native header is not a reading disclosure');
  assert.equal((await run(assistantElementScript, 'ref_8', 'zoho')).readingControl, false, 'a sender profile control does not expand mail');
  assert.equal((await run(assistantMessageMetadataScript, 'zoho', 'fixture-native-message')).historyComplete, false, 'an empty mounted body is still incomplete');
  await set('<div class="zmUserInfo" data-name="profile" style="width:20px;height:20px" onclick="document.querySelector(\'section\').classList.add(\'zmup--show\')"></div><section class="zmprofilemenu-wrapper-test zmup--show" style="width:200px;height:100px"><div class="zmprofilemenu__close__test"><button onclick="this.closest(\'section\').classList.remove(\'zmup--show\')">Stäng</button></div></section>');
  assert.equal(await run(assistantIdentityMenuScript, 'zoho', 'close'), true);
  assert.equal(await evaluate(`document.querySelector('section').classList.contains('zmup--show')`), false, 'Zoho closes via its dedicated native button rather than reopening the profile trigger');
  assert.equal(await run(assistantIdentityMenuScript, 'zoho', 'open'), true);
  assert.equal(await evaluate(`document.querySelector('section').classList.contains('zmup--show')`), true);
  // Split inboxes are native folders of the same account, not other profile identities.
  await set(`<div role="navigation"><div id="zmlTree" role="group">
    <div class="zmTreeNode" data-testid="lhs-tree-node" role="treeitem" id="10000001" data-ccmcp-ref="ref_70"><span class="jsZmTreeText">Inkorg</span></div>
    <div class="zmTreeNode" data-testid="lhs-tree-node" role="treeitem" id="10000002"><span class="jsZmTreeText">Sänt</span></div>
    <div class="zmTreeNode" data-testid="lhs-tree-node" role="treeitem" id="10000003" aria-selected="true" data-ccmcp-ref="ref_71"><span class="jsZmTreeText">Projektkontoret</span></div>
    <div class="zmTreeNode" data-testid="lhs-tree-node" role="treeitem" id="10000004"><span class="jsZmTreeText">Skräppost</span></div>
    <button data-ccmcp-ref="ref_72">Projektkontoret</button>
  </div></div><div class="zmMailContent"><div role="document">
    <div class="zmTreeNode" data-testid="lhs-tree-node" role="treeitem" id="10000005" data-ccmcp-ref="ref_73">Projektkontoret</div>
  </div></div><div id="jstab-zm_Container" role="tabpanel"><div class="zmList" role="option" data-ty="lt" aria-controls="native-detail" style="width:200px;height:40px">Identical rendered row</div></div>`);
  await evaluate(`location.hash='#mail/folder/10000003'`);
  let folders = await run(assistantZohoFoldersScript);
  assert.deepEqual(folders.folders.map(folder => [folder.id, folder.kind]), [['10000001','inbox'],['10000002','sent'],['10000003','custom']]);
  assert.equal(folders.currentId, '10000003');
  assert.equal(folders.listReady, true);
  await evaluate(`document.getElementById('zmlTree').style.visibility='hidden';document.getElementById('zmlTree').style.width='0px'`);
  folders = await run(assistantZohoFoldersScript);
  assert.equal(folders.listReady, true, 'a collapsed native sidebar does not invalidate a selected folder with its rendered rows');
  assert.equal(folders.state, 'ready');
  await evaluate(`document.getElementById('zmlTree').removeAttribute('style')`);
  assert(folders.folders[2].url.endsWith('/zm/#mail/folder/10000003'));
  const zohoAccount = { ...account, provider: 'zoho', url: 'https://mail.zoho.eu/zm/' };
  const folderControl = await run(assistantElementScript, 'ref_71', 'zoho');
  assert.equal(folderControl.folder, true);
  assert.doesNotThrow(() => guardAssistantElement('click', folderControl, zohoAccount, zohoAccount.url));
  for (const ref of ['ref_72','ref_73']) {
    const control = await run(assistantElementScript, ref, 'zoho');
    assert.equal(control.folder, false);
    assert.throws(() => guardAssistantElement('click', control, zohoAccount, zohoAccount.url));
  }
  await evaluate(`document.querySelector('[aria-selected="true"]').removeAttribute('aria-selected');document.getElementById('10000001').setAttribute('aria-selected','true');location.hash='#mail/folder/10000001';globalThis.__ccmcpZohoFolderList={id:'10000001',nodes:[]}`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, false, 'new selection and hash cannot certify old rows, and page globals cannot overwrite isolated bookkeeping');
  assert.equal((await run(assistantZohoFoldersScript)).state, 'selection-transition');
  assert.equal((await run(assistantZohoFoldersScript, 'arm')).listReady, false, 'arming during an existing transition cannot relabel old nodes as the destination');
  await evaluate(`document.querySelector('.zmList').remove();document.getElementById('jstab-zm_Container').innerHTML='<div aria-busy="true" style="width:0;height:0"></div><div class="zmList" role="option" data-ty="lt" aria-controls="native-detail" style="width:200px;height:40px">Identical rendered row</div>'`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, false, 'the native zero-size busy marker blocks even replaced rows');
  assert.equal((await run(assistantZohoFoldersScript)).state, 'loading');
  await evaluate(`document.querySelector('[aria-busy]').remove()`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, true, 'fresh native nodes certify the list even when rendered text is identical');
  await run(assistantZohoFoldersScript, 'arm');
  await evaluate(`document.getElementById('10000001').removeAttribute('aria-selected');document.getElementById('10000003').setAttribute('aria-selected','true');location.hash='#mail/folder/10000003'`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, false, 'arming a supplied-URL navigation retains the prior native list');
  await evaluate(`document.getElementById('jstab-zm_Container').innerHTML='<div class="zmNoMail" style="width:200px;height:40px">Empty</div>'`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, true, 'a fresh explicit empty state certifies an empty destination');
  await evaluate(`document.getElementById('10000003').removeAttribute('aria-selected');document.getElementById('10000001').setAttribute('aria-selected','true');location.hash='#mail/folder/10000001'`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, false, 'a retained empty-state node cannot certify another folder');
  await evaluate(`document.getElementById('jstab-zm_Container').innerHTML='<div class="zmNoMail" style="width:200px;height:40px">Empty</div>'`);
  assert.equal((await run(assistantZohoFoldersScript)).listReady, true);
  await evaluate(`document.getElementById('10000001').removeAttribute('aria-selected');document.getElementById('10000003').setAttribute('aria-selected','true')`);
  await evaluate(`location.hash='#mail/folder/10000001'`);
  assert.equal((await run(assistantZohoFoldersScript)).currentId, undefined, 'a mismatched route and selected folder do not certify a list read');
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="10000003"></div>')`);
  assert.equal((await run(assistantZohoFoldersScript)).folders.some(folder => folder.id === '10000003'), false, 'duplicate native ids are ambiguous');
  assert.equal((await run(assistantElementScript, 'ref_71', 'zoho')).folder, false);
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div class="zmMailContent"><div id="zmlTree" role="group"><div class="zmTreeNode" data-testid="lhs-tree-node" role="treeitem" id="10000006">False folder</div></div></div>')`);
  assert.equal((await run(assistantZohoFoldersScript)).folders.some(folder => folder.id === '10000006'), false);
  await set('<div role="treeitem" aria-selected="true">Sänt</div>');
  assert.equal((await run(assistantZohoFoldersScript)).state, 'unknown-layout', 'an unrecognised folder tree is not reported as a spinner');
  await evaluate(`location.hash='#mail/folder/10000002'`);
  assert.deepEqual((await run(assistantMessageMetadataScript, 'zoho', '')).areas, ['sent'], 'Zoho Sent is recognised by its Swedish native label on a numeric folder route');
  await evaluate(`location.hash=''`);
  // Inbox rows: the provider's thread and latest-message ids, read state and full date when rendered; nothing guessed.
  await set(`<div role="main"><table class="F"><tbody>
    <tr class="zA yO" role="row" data-ccmcp-ref="ref_30"><td class="yX"><span email="erik@kund.example.test">Erik</span></td><td><span class="bog"><span data-thread-id="#thread-f:1781" data-legacy-thread-id="18b7aa01" data-legacy-last-message-id="18b7f2" data-legacy-last-non-draft-message-id="18b7f1">Flytta mötet?</span></span> - Kan vi flytta</td><td class="xW"><span title="tis 3 nov. 2026 09:20">09:20</span></td></tr>
    <tr class="zA zE" role="row" data-ccmcp-ref="ref_31"><td>Lisa</td><td><span data-legacy-thread-id="18b7bb02" data-legacy-last-message-id="18b7o1">Offert</span></td><td class="xW"><span title="Tue, Nov 3, 2026, 7:05 PM">19:05</span></td></tr>
    <tr class="zA" role="row"><td>Nyhetsbrev</td><td><div title="Bilaga">Veckobrev</div></td><td class="xW"><span>2 nov.</span></td></tr>
    </tbody></table><div class="a3s"><table><tbody><tr class="zA yO" role="row"><td>Citerad rad i ett mejl</td></tr></tbody></table></div></div>`);
  const gmailRows = (await run(assistantMessageMetadataScript, 'gmail', '')).rows;
  const local = (...parts) => evaluate(`new Date(${parts.join(',')}).toISOString()`);
  assert.deepEqual(gmailRows.map(row => [row.ref, row.thread, row.last, row.unread, row.at]), [
    ['ref_30', '18b7aa01', '18b7f1', false, await local(2026, 10, 3, 9, 20)],
    ['ref_31', '18b7bb02', '18b7o1', true, await local(2026, 10, 3, 19, 5)],
    [null, null, null, undefined, undefined]], 'native ids, read state and Swedish or English full dates; a short date or a non-date title gives none');
  assert.match(gmailRows[0].text, /Erik Flytta mötet\? - Kan vi flytta 09:20/);
  await set(`<div role="listbox" style="width:300px"><div role="option" aria-label="Oläst Erik Lund Flytta mötet? 09:20" data-convid="AAQkAD1" data-ccmcp-ref="ref_40">Erik Lund Flytta mötet? <time datetime="2026-11-03T08:20:00Z">09:20</time></div><div role="option" aria-label="Lisa Offert">Lisa Offert 2026-11-02 14:30</div></div>`);
  const outlookRows = (await run(assistantMessageMetadataScript, 'outlook', '')).rows;
  assert.deepEqual(outlookRows.map(row => [row.ref, row.thread, row.unread, row.at]), [['ref_40', 'AAQkAD1', true, '2026-11-03T08:20:00.000Z'], [null, null, undefined, undefined]],
    'an unread marker is read, its absence is not taken as read, and dates come only from date attributes');
  // Gmail's reply box as measured on the service: To, Cc and Bcc rows hidden with their recipients in them, a one-line summary, no From field.
  const chip = address => `<div class="afV" data-hovercard-id="${address}"></div>`;
  const gmailReply = ({ summary = '<span class="aDr" email="recipient@example.test" data-hovercard-id="recipient@example.test">Mottagare</span>', to = chip('recipient@example.test'), cc = '', bcc = '', rows = 'display:none', toLabel = 'Till', from = '<input type="hidden" name="from" value="">', send = 'Skicka \u202a(\u2318Enter)\u202c', box = 'M9', body = '<br>', toInput = '', bccInput = '', extra = '', bccRow = true, participants = '<input type="hidden" name="uet" value="recipient@example.test owner@example.test">' } = {}) => `<div class="${box}" style="width:600px">${from}${participants}
    <table class="IG" role="presentation"><tbody><tr><td class="Iy"><div class="aoD hl" style="width:500px"><div class="oL" style="min-height:20px">${summary}</div></div></td></tr></tbody></table>
    <div aria-label="${toLabel}" style="${rows}">${to}<input role="combobox" aria-label="Till mottagare" value="${toInput}"></div>
    <div aria-label="Kopia" style="${rows}">${cc}</div>${bccRow ? `<div aria-label="Hemlig kopia" style="${rows}">${bcc}${bccInput}</div>` : ''}
    <span role="link" aria-label="Kopia – välj kontakter" style="${rows}">Kopia</span>${extra}
    <div contenteditable="true" role="textbox" aria-label="Meddelandetext" data-ccmcp-ref="ref_61" style="width:400px;min-height:40px">${body}</div>
    <div role="button" aria-label="${send}" data-ccmcp-ref="ref_60" style="width:80px;height:30px">Skicka</div><div role="button" aria-label="Fler alternativ för att skicka" style="width:20px;height:30px"></div></div>`;
  const readReply = async options => { await set(gmailReply(options)); return run(assistantComposerScript); };
  const approved = read => ({ itemId: 'item', revision: 0, account, threadId: 'gmail:18b7aa01', sourceUrl: read.url, recipient: 'recipient@example.test', body: read.body });
  let reply = await readReply();
  assert.deepEqual([reply.from, reply.fromImplicit, reply.to, reply.cc, reply.bcc, reply.fieldsVerified, reply.unknownRecipients, reply.sendRef, reply.bodyRef], [[], true, ['recipient@example.test'], [], [], true, [], 'ref_60', 'ref_61'], 'the shape Gmail really shows is read, with an invisible direction mark in the Send label');
  assert.deepEqual(verifyAssistantComposer(reply, approved(reply)), reply);
  // Measured too: a summary with only a name, and a To row that stands for a Reply-To address the thread's sender is not.
  reply = await readReply({ summary: 'Anna Lund' });
  assert.deepEqual([reply.fromImplicit, reply.to], [true, ['recipient@example.test']], 'the rows decide, whatever the summary line says');
  assert.deepEqual(verifyAssistantComposer(reply, approved(reply)), reply);
  reply = await readReply({ summary: 'Anna Lund', to: chip('reply-to@example.test') });
  assert.deepEqual([reply.fromImplicit, reply.to, reply.unknownRecipients], [true, ['reply-to@example.test'], []]);
  assert.throws(() => verifyAssistantComposer(reply, approved(reply)), /avviker/, 'a reply Gmail would send to someone else than the approved recipient stops');
  reply = await readReply({ toLabel: 'Till\u200e' });
  assert.equal(reply.fromImplicit, true, 'an invisible mark in a row label does not hide the row');
  reply = await readReply({ summary: '<span data-email="Recipient@Example.Test">Mottagare</span>', to: chip('Recipient@Example.Test'), body: '<span email="quoted@example.test" data-hovercard-id="quoted@example.test">citat</span>' });
  assert.deepEqual([reply.fromImplicit, reply.to, reply.unknownRecipients], [true, ['recipient@example.test'], []], 'case does not matter, and an address written in the text is not a recipient');
  for (const [label, options] of [
    ['two recipients in the To row', { to: chip('recipient@example.test') + chip('other@example.test') }],
    ['an empty To row', { to: '', summary: 'Anna' }],
    ['a hidden Cc', { cc: chip('other@example.test') }],
    ['a hidden Bcc', { bcc: chip('other@example.test') }],
    ['a Bcc known only by its hovercard', { bcc: '<span data-hovercard-id="other@example.test">x</span>' }],
  ]) {
    reply = await readReply(options);
    assert.equal(reply.fromImplicit, true, `${label} is still Gmail's form`);
    assert.throws(() => verifyAssistantComposer(reply, approved(reply)), /avviker/, `${label} stops the send`);
  }
  const refused = [
    ['a summary counting more people', { summary: 'Anna och 3 till' }],
    ['a summary listing people', { summary: 'Anna, Bo' }],
    ['two people shown in the summary', { summary: '<span email="recipient@example.test">A</span><span email="other@example.test">B</span>', to: chip('recipient@example.test') + chip('other@example.test') }],
    ['someone shown in the summary who is not in the row', { summary: '<span data-hovercard-id="other@example.test">B</span>' }],
    ['open recipient rows', { rows: '' }],
    ['a typed but unfinished recipient', { toInput: 'other' }],
    ['a shown sender choice', { extra: '<div aria-label="Från" style="width:100px;height:20px">Konto</div>' }],
    ['a sender row labelled only by its text', { extra: '<div style="width:100px;height:20px">Från</div>' }],
    ['a sender named with its address in one element', { extra: '<label style="display:block;width:100px;height:20px">Från: Alias</label>' }],
    ['a sender already filled in', { from: '<input type="hidden" name="from" value="alias@example.test">' }],
    ['a sender field holding something other than an address', { from: '<input type="hidden" name="from" value="Mitt alias">' }],
    ['a sender field that is not hidden', { from: '<input type="text" name="from" value="">' }],
    ['no sender field at all', { from: '' }],
    ['two summary lines', { extra: '<div class="aoD"><div class="oL" style="min-height:20px">Bo</div></div>' }],
    ['a missing Bcc row', { bccRow: false }],
    ['a duplicated Cc row', { extra: '<div aria-label="Kopia" style="display:none"></div>' }],
    ['a value typed in the Bcc row', { bccInput: '<input value="other">' }],
    ['names separated by a semicolon', { summary: 'Anna; Bo' }],
    ['an address as text in the To row', { to: chip('recipient@example.test') + '<span>other@example.test</span>' }],
    ['an address as text in the Cc row', { cc: '<span>other@example.test</span>' }],
    ['an address as text in the Bcc row', { bcc: '<span>other@example.test</span>' }],
    ['a Cc chip naming its address only in a label', { cc: '<span aria-label="other@example.test">x</span>' }],
    ['a Cc chip with no readable address', { cc: '<div class="afV">Grupp</div>' }],
    ['a Bcc option with no readable address', { bcc: '<div role="option">Grupp</div>' }],
    ['a further To chip with no readable address', { to: chip('recipient@example.test') + '<div class="afV">Grupp</div>' }],
    ['no summary line', { summary: '', extra: '<style>.oL{display:none}</style>' }],
    ['another service\'s composer', { box: 'zmCompose' }],
  ];
  for (const [label, options] of refused) {
    reply = await readReply(options);
    assert.equal(reply.fromImplicit, false, `${label} is not Gmail's summary form`);
    assert.throws(() => verifyAssistantComposer(reply, approved(reply)), /stöds inte|avviker/, `${label} stops the send`);
  }
  reply = await readReply({ extra: '<input type="hidden" name="extra" value="other@example.test">' });
  assert.deepEqual(reply.unknownRecipients, ['other@example.test'], 'an address in any other hidden field is unknown');
  assert.throws(() => verifyAssistantComposer(reply, approved(reply)), /stöds inte/, 'and stops the send');
  reply = await readReply({ extra: '<span data-hovercard-id="other@example.test">x</span>' });
  assert.deepEqual(reply.unknownRecipients, ['other@example.test'], 'a person known only by a hovercard outside the rows is unknown');
  assert.throws(() => verifyAssistantComposer(reply, approved(reply)), /stöds inte/);
  reply = await readReply({ body: '<div>Från</div><div>kund@example.test</div>' });
  assert.deepEqual([reply.fromImplicit, reply.unknownRecipients], [true, []], 'words and addresses in the reply text are text');
  reply = await readReply({ rows: '', participants: '<input type="hidden" name="uet" value="other@example.test">' });
  assert.deepEqual(reply.unknownRecipients.includes('other@example.test'), true, 'outside that form a participant list still counts as an unknown address');
  assert.equal(await readReply({ send: 'Skicka senare' }), null, 'a control that only starts like Send does not count');
  // Outlook as measured on the service: a From row with only a display name, To and Cc rows holding addresses, and the sender's address in the selected list row.
  const outlookMail = ({ fromLabel = 'Från: Anna Lund', fromRows = 1, toButton = 'Owner &lt;owner@example.test&gt;', subject = '<div role="heading">Fråga om bokning</div>', row = '<span title="anna@example.test">Anna Lund</span><span>Fråga om bokning</span>', selected = 'true', rowStyle = 'width:300px', extra = '', body = 'Hej, kan du svara på det här?' } = {}) => `<div role="listbox"><div role="option" aria-selected="${selected}" style="${rowStyle}">${row}</div></div><div role="main" class="Mq3cC"><div data-app-section="MailReadCompose">${subject}${('<span role="heading"><span role="button" aria-label="' + fromLabel + '">Anna</span></span>').repeat(fromRows)}<span role="heading" aria-label="Till: Owner"><span role="button" aria-label="${toButton}">Owner</span></span>${extra}<div role="document" class="BIZfh">${body}</div></div></div>`;
  const outlookRead = async options => { await set(outlookMail(options)); return run(assistantMessageMetadataScript, 'outlook', 'fixture-thread'); };
  let outlookMessage = await outlookRead();
  assert.equal(outlookMessage.messages[0].sender, 'anna@example.test', 'the address of the sender comes from the selected list row');
  assert(outlookMessage.scopeText.includes('anna@example.test'), 'and is in the evidence, so a reply card can name its recipient');
  outlookMessage = await outlookRead({ row: '<span title=" ANNA@example.test ">  anna   LUND </span><span>FRÅGA om  bokning</span>' });
  assert.equal(outlookMessage.messages[0].sender, 'anna@example.test', 'case and spacing do not matter');
  outlookMessage = await outlookRead({ row: '<span title="anna@mail.bröd.se">Anna Lund</span><span>Fråga om bokning</span>' });
  assert.equal(outlookMessage.messages[0].sender, 'anna@mail.bröd.se', 'an address is taken whole, also with letters outside English');
  outlookMessage = await outlookRead({ row: '<span title="owner@example.test">Anna Lund</span><span>Fråga om bokning</span>' });
  assert.equal(outlookMessage.messages[0].sender, 'owner@example.test', 'the account itself is the sender only when the row says so');
  outlookMessage = await outlookRead({ fromLabel: 'Från: boss@example.test', row: '<span title="evil@example.test">boss@example.test</span><span>Fråga om bokning</span>' });
  assert.equal(outlookMessage.messages[0].sender, 'evil@example.test', 'a display name that looks like an address is only a name; the row says who really wrote');
  for (const [label, options] of [
    ['no row is selected', { selected: 'false' }],
    ['the selected row is hidden', { rowStyle: 'display:none' }],
    ['a display name looks like an address and no row confirms it', { fromLabel: 'Från: boss@example.test', selected: 'false' }],
    ['a display name holds an address in brackets and no row confirms it', { fromLabel: 'Från: Anna &lt;anna@example.test&gt;', selected: 'false' }],
    ['the To row holds the only address', { row: '<span>Anna Lund</span><span>Fråga om bokning</span>' }],
    ['the Cc row holds another address', { row: '<span>Anna Lund</span><span>Fråga om bokning</span>', extra: '<span role="heading" aria-label="Kopia: Bo"><span role="button" aria-label="Bo &lt;bo@example.test&gt;">Bo</span></span>' }],
    ['the row lists two addresses', { row: '<span title="anna@example.test">Anna Lund</span><span title="bo@example.test">Bo</span><span>Fråga om bokning</span>' }],
    ['one title holds two addresses', { row: '<span title="anna@example.test; bo@example.test">Anna Lund</span><span>Fråga om bokning</span>' }],
    ['a title is a name and an address', { row: '<span title="Anna &lt;anna@example.test&gt;">Anna Lund</span><span>Fråga om bokning</span>' }],
    ['the name on the row is someone else', { row: '<span title="bo@example.test">Bo Berg</span><span>Fråga om bokning</span>' }],
    ['the address is on the subject, not the sender', { row: '<span>Anna Lund</span><span title="Skriv till info@example.test">Fråga om bokning</span>' }],
    ['the row belongs to another subject', { row: '<span title="anna@example.test">Anna Lund</span><span>Något helt annat</span>' }],
    ['the message shows no subject', { subject: '' }],
    ['the row can be expanded into several messages', { row: '<button aria-expanded="false">Visa</button><span title="anna@example.test">Anna Lund</span><span>Fråga om bokning</span>' }],
    ['several messages are open', { fromRows: 2 }],
  ]) {
    outlookMessage = await outlookRead(options);
    assert.equal(outlookMessage.messages[0].sender, undefined, `${label}: the sender stays unknown`);
    assert.equal(outlookMessage.scopeText.includes('E-postadresser i meddelandets rubrik'), false, `${label}: and no address is presented as the sender's`);
  }
  await set(`<div role="listbox"><div role="option" aria-selected="true"><span title="anna@example.test">Anna Lund</span><span>Fråga om bokning</span></div><div role="option" aria-selected="true"><span title="bo@example.test">Anna Lund</span><span>Fråga om bokning</span></div></div><div role="main" class="Mq3cC"><div data-app-section="MailReadCompose"><div role="heading">Fråga om bokning</div><span role="heading"><span role="button" aria-label="Från: Anna Lund">Anna</span></span><div role="document" class="BIZfh">Hej, kan du svara på det här?</div></div></div>`);
  assert.equal((await run(assistantMessageMetadataScript, 'outlook', 'fixture-thread')).messages[0].sender, undefined, 'two selected rows cannot name the message');
  await set(`<div role="option" aria-selected="true" style="width:300px"><span title="anna@example.test">Anna Lund</span><span>Fråga om bokning</span></div><div role="main" class="Mq3cC"><div data-app-section="MailReadCompose"><div role="heading">Fråga om bokning</div><span role="heading"><span role="button" aria-label="Från: Anna Lund">Anna</span></span><div role="document" class="BIZfh">Hej, kan du svara på det här?</div></div></div>`);
  assert.equal((await run(assistantMessageMetadataScript, 'outlook', 'fixture-thread')).messages[0].sender, undefined, 'a selected option outside Outlook\'s list is not its list row');
  outlookMessage = await outlookRead({ selected: 'false', body: '<div role="listbox"><div role="option" aria-selected="true"><span title="evil@example.test">Anna Lund</span><span>Fråga om bokning</span></div></div>' });
  assert.equal(outlookMessage.messages[0].sender, undefined, 'a list written inside the mail itself is not Outlook\'s list');
  // A target is found on a page nested as deeply as Gmail's reply box, and the traversal stays bounded.
  const nest = depth => `(() => { let host = document.body; host.innerHTML = ''; for (let i = 0; i < ${depth}; i++) host = host.appendChild(document.createElement('div')); const end = host.appendChild(document.createElement('button')); end.id = 'deep'; end.textContent = 'Djup'; })()`;
  await evaluate(nest(70));
  let deep = await run(perceiveInPage, { mode: 'resolve', selector: '#deep' });
  assert.deepEqual([deep.truncated, deep.matchCount], [false, 1], 'a page as deep as a real mail app is searched to the end');
  await evaluate(nest(600));
  deep = await run(perceiveInPage, { mode: 'resolve', selector: '#deep' });
  assert.equal(deep.truncated, true, 'a deeper page is reported as cut off, so no uniqueness is claimed');
  console.log('Assistant native reading: collapsed/quoted history, scoped controls, delayed Zoho mailbox readiness and inbox rows passed');
} finally { await cleanup(); stop(); }
