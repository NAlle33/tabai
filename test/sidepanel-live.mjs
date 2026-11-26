import { openCdpObserver } from "./helpers/cdp-observer.mjs";
import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
// Real panel -> offscreen -> broker -> MCP server -> session-owned Chrome tabs.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";


import { watchdog } from "./watchdog.mjs";
import { workspacePanelChecks } from './workspace-panel-live.mjs';
import { assistantPanelChecks } from './assistant-panel-live.mjs';
import { assistantCasesPanelChecks } from './assistant-cases-panel-live.mjs';
import { assistantApprovalCardChecks, assistantChatPanelChecks, assistantCompareCardChecks, assistantPageShareChecks, assistantRoutinePanelChecks, assistantWatchEntryChecks } from './assistant-chat-panel-live.mjs';
import { assistantFeaturePanelChecks } from './assistant-features-panel-live.mjs';

let observer;
const rpc = (...args) => observer.rpc(...args);


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = mkdtempSync(join(tmpdir(), "tabai-panel-"));
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
const sessions = [], targets = [];
let socket, passed = 0, panelObserver;
const panelErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/scroll") {
    res.end(`<!doctype html><title>Scroll progress</title><style>body{height:12000px}#scroller{height:100px;overflow:auto}#scroller div{height:6000px}</style>
      <div id="scroller"><div>Scrollable content</div></div><button>Stable control</button>`);
    return;
  }
  // The page the user shares: visible text, a selection target, filled fields whose values must stay,
  // and text a sighted user never sees, which must stay too.
  if (req.url.split("?")[0] === "/share") {
    res.end(`<!doctype html><title>Delningstest</title><h1>Leveransstatus för order 4711</h1>
      <style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
      <p id="chosen">Paketet lämnade lagret i Borås i morse.</p><p>Beräknad leverans: torsdag.</p>
      <label>Lösenord <input id="secret" type="password" value="Hemligt-Losen-9931"></label>
      <label>Namn <input id="typed"></label><label>Meddelande <textarea id="note">Forifylld-anteckning-5521</textarea></label>
      <div id="composer" contenteditable="true"><p>Osant-meddelande-7720</p></div><div id="rolebox" role="textbox" tabindex="0">Rollruta-7721</div>
      <div id="shadow-editor"></div>
      <div contenteditable="true"><p>Yttre-redigerare-7723</p><div contenteditable="true">Inre-redigerare-7724</div></div>
      <div role="combobox listbox" tabindex="0">Flera-roller-7725</div>
      <div contenteditable="true"><p>Utkast-med-o-7726</p><div contenteditable="false">O-i-redigerare-7727</div></div>
      <div contenteditable="true"><div contenteditable="false"><div contenteditable="true">Redigerare-i-o-7728</div></div></div>
      <p style="display:none">Dold-rad-7310</p>
      <p class="sr-only">Skarmlasartext-6001</p><p style="opacity:0">Genomskinlig-6002</p>
      <p style="position:absolute;left:-10000px">Utanfor-skarmen-6003</p><p style="color:transparent">Osynlig-farg-6004</p>
      <p style="font-size:0">Noll-storlek-6005</p><p aria-hidden="true">Dold-for-alla-6006</p><div inert>Inert-text-6007</div>
      <section style="content-visibility:auto;contain-intrinsic-size:auto 200px;margin-top:3000px"><p>Langt-ner-6008</p></section>
      <script>document.querySelector('#typed').value='Inskrivet-Namn-8842';document.querySelector('#note').value='Skrivet-Utkast-6610';
        document.querySelector('#shadow-editor').attachShadow({mode:'open'}).innerHTML='<div contenteditable="true">Skugg-redigerare-7722</div>';</script>`);
    return;
  }
  // A little ordinary text and a composer holding more text than the page itself.
  if (req.url === "/share-composer") {
    res.end(`<!doctype html><title>Kort sida</title><p id="short">Kort-text-7740</p><div id="composer" contenteditable="true"><p>${"Langt-utkast-7741 ".repeat(5).trim()}</p></div>`);
    return;
  }
  // A page whose only text is in an editor, which is not the whole page.
  if (req.url === "/share-composer-only") {
    res.end(`<!doctype html><title>Bara redigerare</title><div id="composer" contenteditable="true"><p id="draft">Bara-redigerare-7742</p></div>`);
    return;
  }
  // A page that is one large editor: the whole document is the user's own typing.
  if (req.url === "/share-editor") {
    res.end(`<!doctype html><title>Redigerbar sida</title><body contenteditable="true"><h1>Mitt utkast</h1><p id="draft">Hela-sidan-redigerbar-7730</p></body>`);
    return;
  }
  if (req.url === "/share-long") {
    res.end(`<!doctype html><title>Lång sida</title><pre>${"Rad med testtext nummer sju. ".repeat(20000)}</pre><p>Slutet-av-sidan-4410</p>`);
    return;
  }
  if (req.url === "/resume") {
    res.end(`<!doctype html><title>Checkpoint fixture</title>
      <button id="first">First</button><button id="second">Second</button><output id="checkpoint"></output><output id="finished"></output>
      <script>
        const read=k=>Number(localStorage.getItem(k)||0);
        document.querySelector('#checkpoint').textContent=localStorage.getItem('resume-ready')||'';
        document.querySelector('#first').onclick=()=>{localStorage.setItem('resume-first',read('resume-first')+1);setTimeout(()=>{localStorage.setItem('resume-ready','Ready');document.querySelector('#checkpoint').textContent='Ready'},1800)};
        document.querySelector('#second').onclick=()=>{localStorage.setItem('resume-second',read('resume-second')+1);document.querySelector('#finished').textContent='Finish'};
      </script>`);
    return;
  }
  res.end(`<!doctype html><title>Panel testformulär</title>
    <label>Namn <input id="name"></label><label>Antal <input id="count" type="number"></label>
    <label>Aktiv <input id="enabled" type="checkbox"></label>
    <button id="go" onclick="window.clicks++;setTimeout(()=>document.querySelector('#result').textContent='Klart',1800)">Kör</button>
    <button id="loop" onclick="window.loopClicks++">Utan synlig förändring</button>
    <output id="result"></output><script>window.clicks=0;window.loopClicks=0</script>`);
});
function check(name, fn) { fn(); console.log(`  ✓ ${name}`); passed++; }
async function evaluate(sessionId, expression, userGesture = false) {
  const result = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function until(fn, description) {
  for (let i = 0; i < 80; i++) { const result = await fn(); if (result) return result; await sleep(125); }
  throw new Error(`Timed out: ${description}`);
}
async function call(session, name, args = {}) {
  const response = await callRaw(session.client, { name, arguments: args });
  if (response.isError) throw new Error(response.content?.[0]?.text);
  if (response.structuredContent) return response.structuredContent;
  const text = response.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}
async function connect(name) {
  const session = { client: createMcpClient({ name, version: "1.0.0" }) }; sessions.push(session);
  // The harness bakes its ports/log/reap settings into the test bundles. Only
  // the disposable recipe/history directory needs a per-process override.
  await connectMcpClient(session.client, createMcpTransport({ command: process.execPath, args: [join(root, "dist/server.js")], cwd: root,
    env: { CCMCP_CONFIG_DIR: configDir } }));
  const context = await call(session, "tabs_context_mcp", { createIfEmpty: true });
  session.tabId = context.tabs[0].tabId; session.groupId = context.groupId;
  await call(session, "navigate", { tabId: session.tabId, url: "http://127.0.0.1:9234" });
  return session;
}
let cleaned;
function cleanup() {
  return cleaned ??= (async () => {
    for (const targetId of targets) await rpc("Target.closeTarget", { targetId }).catch(() => {});
    for (const session of sessions) {
      if (session.tabId && !session.closed) await call(session, "tabs_close_mcp", { tabId: session.tabId }).catch(() => {});
      await session.client.close();
    }
    socket?.close();
    observer?.rejectPending(new Error("Test cleanup"));
    fixture.closeAllConnections(); if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
    rmSync(configDir, { recursive: true, force: true });
  })();
}
// Five panel suites share this process; the deadline still catches a hang long before the harness's five minutes.
// The suite covers chat, Mejl, routines and approval cards; under load it nears 90 s, so the hang guard allows 150 s.
const stopWatchdog = watchdog(cleanup, 150_000);
let exitCode = 1;
try {
  fixture.listen(9234, "127.0.0.1"); await once(fixture, "listening");
  const endpoint = new URL(process.argv[2]); assert.equal(endpoint.hostname, "127.0.0.1");
  if (!process.argv[3]) console.log("  - skipped: panel screenshots, because no artifact directory was given; every layout check still runs");
  observer = await openCdpObserver(endpoint, { timeoutMs: 20000, timeoutMessage: method => `${method} timed out`, onEvent: result => {
    if (result.sessionId === panelObserver && (result.method === "Runtime.exceptionThrown" ||
        result.method === "Runtime.consoleAPICalled" && result.params.type === "error")) panelErrors.push(result.params);
  } });
  socket = observer.socket;
  const a = await connect("panel-a"), b = await connect("panel-b");
  const { targetInfos } = await rpc("Target.getTargets");
  const worker = targetInfos.find(t => t.type === "service_worker" && t.url.endsWith(`/${manifest.background.service_worker}`));
  assert.ok(worker); const extensionId = new URL(worker.url).hostname;
  const workerSession = (await rpc("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
  const groups = await evaluate(workerSession, 'chrome.storage.local.get("mcpGroups").then(s=>s.mcpGroups)');
  a.id = Object.keys(groups).find(id => groups[id] === a.groupId); b.id = Object.keys(groups).find(id => groups[id] === b.groupId);
  const { targetId } = await rpc("Target.createTarget", { url: `chrome-extension://${extensionId}/sidepanel.html` }); targets.push(targetId);
  const panelSession = (await rpc("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  panelObserver = panelSession;
  await rpc("Runtime.enable", {}, panelSession);
  const ui = expression => evaluate(panelSession, expression);
  const command = value => ui(`chrome.runtime.sendMessage({type:'panel-command',command:${JSON.stringify(value)}})`);
  // Target.createTarget answers before the extension document replaces the initial about:blank one;
  // an evaluation in between finds no chrome.windows, or a context that is being torn down.
  await until(() => ui("location.protocol==='chrome-extension:'&&typeof chrome!=='undefined'&&typeof chrome.windows?.create==='function'").catch(() => false), "side panel page loaded");
  // The developer tools live under the assistant's Settings → Avancerat page.
  const assistantCard = '[data-module-id="assistant-fixture"]';
  const openAdvanced = async () => {
    await until(() => ui(`!!document.querySelector('${assistantCard} .assistant-workspace')`), "assistant workspace for the developer tools");
    await ui(`(()=>{const card=document.querySelector('${assistantCard}');if(card.querySelector('.assistant-workspace').dataset.surface!=='settings')card.querySelector('[data-view="settings"]').click();})()`);
    await until(() => ui(`!document.querySelector('${assistantCard} .assistant-view-settings').hidden`), "settings opened");
    await ui(`document.querySelector('${assistantCard} [data-settings-page="advanced"]').click()`);
    await until(() => ui(`(()=>{const page=document.querySelector('${assistantCard} .assistant-settings-page[data-page="advanced"]'),tools=document.querySelector('#technical-controls');return !!page&&!page.hidden&&page.contains(tools)&&tools.open&&tools.getClientRects().length>0;})()`), "Avancerat holds the developer tools");
  };
  // A second normal window starts with only an ordinary, ungrouped user tab.
  const anchor = await ui('chrome.windows.create({url:"about:blank",focused:false}).then(window=>({id:window.id,tabId:window.tabs[0].id}))');
  const windowSession = { client: createMcpClient({ name: 'panel-window', version: '1.0.0' }) }; sessions.push(windowSession);
  await connectMcpClient(windowSession.client, createMcpTransport({ command: process.execPath, args: [join(root, 'dist/server.js')], cwd: root, env: { CCMCP_CONFIG_DIR: configDir } }));
  const anchored = await call(windowSession, 'tabs_context_mcp', { createIfEmpty: true, createWindowId: anchor.id });
  windowSession.tabId = anchored.tabs[0].tabId; windowSession.groupId = anchored.groupId;
  check('new session group stays in an explicitly selected window with no existing Tabai tabs', () => assert.equal(anchored.tabs.length, 1));
  assert.equal(await ui(`chrome.tabs.get(${windowSession.tabId}).then(tab=>tab.windowId)`), anchor.id);
  assert.equal(await ui(`chrome.tabs.get(${anchor.tabId}).then(tab=>tab.groupId)`), -1);
  const refused = await callRaw(windowSession.client, { name: 'read_page', arguments: { tabId: anchor.tabId } });
  check('same-window group never adopts or controls the ordinary user tab', () => assert.equal(refused.isError, true));
  await call(windowSession, 'tabs_close_mcp', { tabId: windowSession.tabId }); windowSession.closed = true;
  assert.equal(await ui(`chrome.tabs.get(${anchor.tabId}).then(tab=>tab.windowId)`), anchor.id);
  const closedWindow = await callRaw(windowSession.client, { name: 'tabs_context_mcp', arguments: { createIfEmpty: true, createWindowId: 2147483647 } });
  check('a closed target window fails instead of starting work in another window', () => assert.equal(closedWindow.isError, true));
  await ui(`chrome.windows.remove(${anchor.id})`);
  await until(() => ui(`document.querySelector('#session')?.options.length > 2`), "session options");
  await ui(`document.querySelector('#session').value=${JSON.stringify(a.id)};document.querySelector('#session').dispatchEvent(new Event('change'))`);
  await until(() => ui(`document.querySelector('#connection').textContent.includes('Ansluten')`), "selected session connected");
  check("panel lists both authenticated MCP sessions", () => assert.ok(a.id && b.id && a.id !== b.id));
  const diagnosticSnapshots = await Promise.all([command({ action: "snapshot", sessionId: a.id }), command({ action: "snapshot", sessionId: a.id })]);
  const diagnostics = diagnosticSnapshots[0].result.diagnostics;
  check("concurrent diagnostic polling never appears as user work", () => {
    for (const state of diagnosticSnapshots) assert(state.result.calls.every(call => call.tool !== "health"));
  });
  check("panel snapshot identifies matching loaded server and extension builds", () => {
    assert.match(diagnostics.serverBuildId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(diagnostics.extensionBuildId, diagnostics.serverBuildId);
    assert.equal(diagnostics.brokerBuildId, diagnostics.serverBuildId);
    assert.equal(diagnostics.available, true); assert.equal(diagnostics.buildMismatch, false);
  });
  await openAdvanced();
  const advanced = await ui(`(()=>{const page=document.querySelector('${assistantCard} .assistant-settings-page[data-page="advanced"]'),session=page.querySelector('#session'),rect=session?.getBoundingClientRect();return {session:!!session,visible:!!rect&&rect.width>0&&rect.height>0,refresh:page.contains(document.querySelector('#refresh')),views:[...page.querySelectorAll('nav[aria-label="Panelvyer"] [data-view]')].map(button=>button.dataset.view),shellHidden:getComputedStyle(document.querySelector('.technical-home')).display==='none'};})()`);
  check("Settings → Avancerat holds the session picker, manual refresh and the Pågår, Recept and Historik views", () => {
    assert.deepEqual(advanced, { session: true, visible: true, refresh: true, views: ["activity", "recipes", "history"], shellHidden: true });
  });
  await until(() => ui(`document.querySelector('[data-run-id="diagnostics"]')?.textContent.includes(${JSON.stringify(diagnostics.serverBuildId)})`), "visible build diagnostics");
  await ui(`document.querySelector('[data-run-id="diagnostics"]').open=true`);
  {
    // Each diagnostics row is read by its label. The three builds are one build here, so for a
    // moment the panel's snapshot replies carry three distinct IDs: a row that shows another
    // peer's ID, or none, cannot pass for its own.
    const rowsByLabel = () => ui(`Object.fromEntries([...document.querySelectorAll('[data-run-id="diagnostics"] .diagnostic-build')].map(row=>{const text=row.textContent,at=text.indexOf(': ');return [text.slice(0,at),text.slice(at+2)];}))`);
    const distinct = { serverBuildId: `sha256:${"1".repeat(64)}`, brokerBuildId: `sha256:${"2".repeat(64)}`, extensionBuildId: `sha256:${"3".repeat(64)}` };
    const byLabel = ids => ({ Server: ids.serverBuildId, Broker: ids.brokerBuildId, Tillägg: ids.extensionBuildId });
    await ui(`(()=>{const send=chrome.runtime.sendMessage,ids=${JSON.stringify(distinct)};const replace=function(message,...rest){const reply=send.call(chrome.runtime,message,...rest);return message?.command?.action==='snapshot'?Promise.resolve(reply).then(value=>value?.result?.diagnostics?{...value,result:{...value.result,diagnostics:{...value.result.diagnostics,...ids}}}:value):reply;};chrome.runtime.sendMessage=replace;window.__restoreDiagnostics=()=>{chrome.runtime.sendMessage=send;};if(chrome.runtime.sendMessage!==replace)throw new Error('the panel snapshot replies cannot be observed');})()`);
    let shown;
    try {
      shown = await until(async () => { const rows = await rowsByLabel(); return JSON.stringify(rows) === JSON.stringify(byLabel(distinct)) && rows; }, "distinct build IDs in the diagnostics rows").catch(rowsByLabel);
    } finally { await ui("window.__restoreDiagnostics?.();delete window.__restoreDiagnostics"); }
    const real = await until(async () => { const rows = await rowsByLabel(); return JSON.stringify(rows) === JSON.stringify(byLabel(diagnostics)) && rows; }, "real build IDs back in the diagnostics rows").catch(rowsByLabel);
    check("technical diagnostics show the server, broker and extension build each under its own label", () => {
      assert.deepEqual(shown, byLabel(distinct));
      assert.deepEqual(real, byLabel(diagnostics));
    });
  }
  const diagnosticsArtifacts = process.argv[3];
  if (diagnosticsArtifacts) mkdirSync(diagnosticsArtifacts, { recursive: true });
    for (const width of [375, 1440]) {
      await rpc("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, panelSession);
      await ui(`document.querySelector('[data-run-id="diagnostics"]').scrollIntoView({block:'start'})`);
      assert.equal(await ui("document.documentElement.scrollWidth <= innerWidth"), true);
      if (diagnosticsArtifacts) {
        const shot = await rpc("Page.captureScreenshot", { format: "png" }, panelSession);
        writeFileSync(join(diagnosticsArtifacts, `control-panel-diagnostics-${width}.png`), Buffer.from(shot.data, "base64"));
      }
    }
  const options = await ui("chrome.sidePanel.getOptions({})");
  check("sidePanel permission and native default path are active", () => { assert.ok(manifest.permissions.includes("sidePanel")); assert.equal(options.path, "sidepanel.html"); });
  const denied = await evaluate(workerSession, `chrome.runtime.sendMessage({type:'panel-command',command:{action:'sessions'}})`);
  check("non-panel extension senders cannot use the control plane", () => assert.equal(denied.ok, false));
  await until(() => ui(`!!document.querySelector('[data-module-id="test-module"] input[name="subject"]')`), "local module card");
  await ui(`document.querySelector('[data-module-id="test-module"] input[name="subject"]').value='Eget underlag';document.querySelector('[data-module-id="test-module"] button[type="submit"]').click()`);
  await until(() => ui(`!!document.querySelector('[data-module-id="test-module"] textarea[name="answer"]')`), "module question");
  check("private module starts through the native panel without an agent session command", () => {});
  const reviewState = await ui(`(()=>{const card=document.querySelector('.module-review');return {statuses:[...card.querySelectorAll('.review-status')].map(e=>e.textContent),verification:card.querySelector('[data-verification]').dataset.verification,issues:card.querySelector('.review-verification li').textContent,quote:card.querySelector('blockquote').textContent,images:card.querySelectorAll('img,script').length,links:[...card.querySelectorAll('a')].map(e=>({href:e.href,rel:e.rel})),details:card.querySelectorAll('details summary').length}})()`);
  check("review card shows unresolved fields, failures and expandable safe evidence", () => {
    assert.deepEqual(reviewState.statuses, ['Bekräftat', 'Saknas / behöver bekräftas', 'Motstridiga uppgifter']);
    assert.equal(reviewState.verification, 'failed'); assert.match(reviewState.issues, /bekräftas/);
    assert.equal(reviewState.quote, '<img src=x onerror="alert(1)">'); assert.equal(reviewState.images, 0);
    assert.deepEqual(reviewState.links, [{href:'https://example.com/source',rel:'noopener noreferrer'}]); assert.equal(reviewState.details, 2);
  });
  await ui(`document.querySelector('[data-module-id="test-module"] textarea[name="answer"]').value='September'`);
  await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`document.querySelector('[data-module-id="test-module"] textarea[name="answer"]').value==='September'`), "answer preserved during polling");
  await ui(`document.querySelector('[data-module-id="test-module"] textarea[name="answer"]').form.requestSubmit()`);
  await until(() => ui(`document.querySelector('[data-module-id="test-module"]').textContent.includes('Klar för granskning')`), "module review state");
  check("private module answer completes the persisted case", () => {});
  await rpc("Page.reload", {}, panelSession);
  await until(() => ui(`document.querySelector('[data-module-id="test-module"]')?.textContent.includes('September')`), "module state restored after reopening");
  check("private module state survives panel reload without restarting work", () => {});
  const verified = await ui(`document.querySelector('.module-review [data-verification]').dataset.verification`);
  const progress = await ui(`(()=>{const card=document.querySelector('[data-module-id="test-module"]');return {receipt:card.querySelector('.module-receipt').textContent,received:card.querySelector('.module-receipt time').dateTime,step:card.querySelector('.module-step').textContent,updated:card.querySelector('.module-updated time').dateTime}})()`);
  check("reply receipt and progress survive panel reload", () => {
    assert.match(progress.receipt, /Ditt svar är mottaget/); assert.equal(progress.received, '2026-09-28T12:01:00.000Z');
    assert.equal(progress.step, 'Aktuellt steg: Kontrollen är klar'); assert.equal(progress.updated, progress.received);
  });
  check("verified review survives panel reload", () => assert.equal(verified, 'passed'));
  const moduleDenied = await evaluate(workerSession, `chrome.runtime.sendMessage({type:'panel-command',command:{action:'module',moduleId:'test-module',operation:'start',input:{subject:'foreign'}}})`);
  check("non-panel senders cannot start personal executables", () => assert.equal(moduleDenied.ok, false));
  await workspacePanelChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantPanelChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantChatPanelChecks({ ui, until, check, rpc, panelSession, artifactDir: process.argv[3] });
  await assistantPageShareChecks({ ui, until, check, rpc, panelSession, artifactDir: process.argv[3], pageUrl: "http://127.0.0.1:9234/share", query: "?order=4711&q=paket&token=Hemlig-Token-3301#konto" });
  await assistantWatchEntryChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantCasesPanelChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantFeaturePanelChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantApprovalCardChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantRoutinePanelChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3] });
  await assistantCompareCardChecks({ ui, rpc, panelSession, until, check, artifactDir: process.argv[3], base: "http://127.0.0.1:9234" });
  await openAdvanced();
  await ui(`document.querySelector('#session').value=${JSON.stringify(a.id)};document.querySelector('#session').dispatchEvent(new Event('change'))`);
  await until(() => ui(`document.querySelector('#connection').textContent.includes('Ansluten')`), "session restored after module test");
  await ui(`document.querySelector('[data-view="recipes"]').click()`);
  await until(() => ui(`document.querySelector('#recipes-message').textContent.includes('Inga sparade recept')`), "honest empty recipe state").catch(async error => {
    // Say what the panel showed, so a failure names its cause.
    const seen = await ui(`({message:document.querySelector('#recipes-message').textContent,connection:document.querySelector('#connection').textContent,error:document.querySelector('#connection-error')?.textContent??'',recipesView:!document.querySelector('#recipes-view').hidden})`);
    throw new Error(`${error.message}; the panel showed ${JSON.stringify(seen)}`);
  });
  check("empty recipe UI provides the actual creation route", () => {});
  await call(a, "recipe_save", { name: "Fyll testformulär", description: "Live test av text, tal och ja/nej.",
    parameters: { name: { type: "string" }, count: { type: "number", default: 3 }, enabled: { type: "boolean", default: true } },
    actions: [
      { tool: "form_input", args: { value: { $param: "name" } }, target: { selector: "#name" } },
      { tool: "form_input", args: { value: { $param: "count" } }, target: { selector: "#count" } },
      { tool: "form_input", args: { value: { $param: "enabled" } }, target: { selector: "#enabled" } },
    ] });
  await ui(`document.querySelector('#refresh').click()`);
  await until(() => ui(`!!document.querySelector('[data-parameter="name"]')`), "typed fields");
  await ui(`document.querySelector('[data-parameter="name"]').value='Panelvärde';document.querySelector('[data-parameter="count"]').value='7';document.querySelector('[data-parameter="enabled"]').value='false';document.querySelector('#start').click()`);
  await until(async () => (await command({ action: "snapshot", sessionId: a.id })).result.runs.some(r => r.status === "succeeded"), "recipe completion");
  const values = await call(a, "javascript_tool", { tabId: a.tabId, text: "[document.querySelector('#name').value,document.querySelector('#count').value,document.querySelector('#enabled').checked]" });
  check("UI starts a real recipe with correctly typed parameters", () => assert.deepEqual(values, ["Panelvärde", "7", false]));
  const foreign = await command({ action: "start", sessionId: a.id, name: "Fyll testformulär", parameters: { name: "foreign" }, tabId: b.tabId });
  check("foreign target tabs are refused before dispatch", () => assert.equal(foreign.ok, false));
  const bValue = await call(b, "javascript_tool", { tabId: b.tabId, text: "document.querySelector('#name').value" });
  check("the other session's page stays unchanged", () => assert.equal(bValue, ""));
  // An unreadable helper store must not hide the session's running work or its Stop button.
  const checkpointStore = join(configDir, "recipe-checkpoints.json");
  writeFileSync(checkpointStore, "{ not a checkpoint store", { mode: 0o600 });
  const click = { tool: "computer", args: { tabId: a.tabId, action: "left_click" }, target: { selector: "#go" }, expect: { text: "Klart", timeoutMs: 6000 } };
  const running = callRaw(a.client, { name: "browser_batch", arguments: { actions: [click, click] } });
  const observedState = await until(async () => {
    const reply = await command({ action: "snapshot", sessionId: a.id });
    assert.equal(reply.ok, true, `snapshot beside a corrupt checkpoint store: ${reply.error}`);
    return reply.result.runs.some(r => r.status === "running" && r.stage === "expect") && reply.result;
  }, "MCP batch observation");
  const observed = observedState.runs.find(r => r.status === "running" && r.stage === "expect");
  check("a corrupt checkpoint store is named while runs stay listed", () => {
    assert.deepEqual(observedState.storeErrors, ["checkpoints"]); assert.deepEqual(observedState.checkpoints, []);
  });
  await until(() => ui(`document.querySelector('#activity').textContent.includes('Kunde inte läsa sparade kontrollpunkter')`), "store error notice");
  await until(() => ui(`!!document.querySelector('button[data-run-id="${observed.runId}"]')`), "stop button for agent batch");
  const stopState = await ui(`(()=>{const stop=document.querySelector('button[data-run-id="${observed.runId}"]');return {present:!!stop&&stop.getClientRects().length>0,enabled:!!stop&&!stop.disabled,notice:document.querySelector('#activity').textContent.includes('Kunde inte läsa sparade kontrollpunkter')};})()`);
  await ui(`document.querySelector('button[data-run-id="${observed.runId}"]').click()`);
  const stopped = await running;
  check("the store error notice is shown while Stop still works", () => {
    assert.deepEqual(stopState, { present: true, enabled: true, notice: true }, "Stop is shown and enabled beside the store error when it is pressed");
    assert.equal(stopped.structuredContent.status, "cancelled", "pressing Stop stopped the run");
  });
  check("panel stops an agent batch only after its current expectation", () => { assert.equal(stopped.structuredContent.status, "cancelled"); assert.equal(stopped.structuredContent.completedSteps, 1); });
  check("stop does not replay a click or dispatch the next step", () => assert.equal(stopped.structuredContent.failedStep, 2));
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "window.clicks" }), 1);
  rmSync(checkpointStore);
  await until(() => ui(`!document.querySelector('#activity').textContent.includes('Kunde inte läsa sparade kontrollpunkter')`), "store error notice cleared once the store is readable");

  // A parameter with the reserved secret prefix is masked and cannot be sent empty.
  const secretRecipe = "Hemligt fält";
  await call(a, "recipe_save", { name: secretRecipe, parameters: { secret_password: { type: "string" }, secret_pin: { type: "number" } },
    actions: [{ tool: "form_input", args: { value: { $param: "secret_password" } }, target: { selector: "#name" } },
      { tool: "form_input", args: { value: { $param: "secret_pin" } }, target: { selector: "#count" } }] });
  await ui(`document.querySelector('[data-view="recipes"]').click();document.querySelector('#refresh').click()`);
  await until(() => ui(`!![...document.querySelector('#recipe').options].find(item=>item.value===${JSON.stringify(secretRecipe)})`), "secret recipe in picker");
  await ui(`document.querySelector('#recipe').value=${JSON.stringify(secretRecipe)};document.querySelector('#recipe').dispatchEvent(new Event('change'))`);
  const secretField = await until(() => ui(`(()=>{const read=name=>{const field=document.querySelector('[data-parameter="'+name+'"]');return field&&{type:field.type,required:field.required,empty:field.validity.valueMissing};};const text=read('secret_password'),pin=read('secret_pin');if(!text||!pin)return null;const pinField=document.querySelector('[data-parameter="secret_pin"]');pinField.value='12a';const notNumber=pinField.validity.patternMismatch;pinField.value='';return {text,pin,notNumber,form:document.querySelector('#recipe-form').checkValidity()};})()`), "secret parameter fields");
  check("reserved secret parameters of type string and number render as required password fields", () => assert.deepEqual(secretField, {
    text: { type: "password", required: true, empty: true }, pin: { type: "password", required: true, empty: true }, notNumber: true, form: false }));
  await until(() => ui(`!document.querySelector('#start').disabled`), "start enabled for the secret recipe");
  await ui(`document.querySelector('#start').click()`);
  await sleep(1500);
  const afterEmpty = (await command({ action: "snapshot", sessionId: a.id })).result.runs.filter(run => run.name === secretRecipe);
  check("an empty secret cannot start the recipe", () => assert.equal(afterEmpty.length, 0));
  await ui(`document.querySelector('[data-parameter="secret_password"]').value='Hemligt-varde-4471';document.querySelector('[data-parameter="secret_pin"]').value='4471';document.querySelector('#start').click()`);
  await until(async () => (await command({ action: "snapshot", sessionId: a.id })).result.runs.some(run => run.name === secretRecipe && run.status === "succeeded"), "secret recipe completion");
  const secretValue = await call(a, "javascript_tool", { tabId: a.tabId, text: "[document.querySelector('#name').value,document.querySelector('#count').value]" });
  check("filled secrets of type string and number are sent as the recipe parameters", () => assert.deepEqual(secretValue, ["Hemligt-varde-4471", "4471"]));
  await ui(`document.querySelector('[data-view="activity"]').click()`);
  const failed = await callRaw(a.client, { name: "browser_batch", arguments: { captureOnError: true, actions: [{ tool: "form_input", args: { tabId: a.tabId, value: "private-input" }, target: { selector: "#missing" } }] } });
  assert.equal(failed.structuredContent.failedStep, 1);
  await ui(`document.querySelector('[data-view="history"]').click()`);
  await until(() => ui(`document.querySelector('#history-list').textContent.includes('Fel i steg 1')`), "failed step history");
  check("history shows the outcome and failed step without raw inputs", () => {});
  assert.equal(await ui(`document.querySelector('#history-list').textContent.includes('private-input')`), false);
  await ui(`document.querySelector('#history-list details[data-run-id="${failed.structuredContent.runId}"]').open=true;document.querySelector('#history-list details[data-run-id="${failed.structuredContent.runId}"] button').click()`);
  await until(() => ui(`!!document.querySelector('.debug-viewer img')?.naturalWidth`), "real saved failure image in panel");
  await rpc("Emulation.setDeviceMetricsOverride", { width: 375, height: 900, deviceScaleFactor: 1, mobile: false }, panelSession);
  assert.equal(await ui(`document.querySelector('.debug-viewer').scrollWidth <= document.querySelector('.debug-viewer').clientWidth`), true);
  if (process.argv[3]) {
    const imageShot = await rpc("Page.captureScreenshot", { format: "png" }, panelSession);
    writeFileSync(join(process.argv[3], "control-panel-failure-image-375.png"), Buffer.from(imageShot.data, "base64"));
  }
  check("panel opens the actual saved PNG on demand and fits 375 px", () => {});
  await ui(`document.querySelector('#session').value=${JSON.stringify(b.id)};document.querySelector('#session').dispatchEvent(new Event('change'))`);
  assert.equal(await ui(`!!document.querySelector('.debug-viewer')`), false);
  check("changing sessions clears the evidence viewer", () => {});
  await ui(`document.querySelector('#session').value=${JSON.stringify(a.id)};document.querySelector('#session').dispatchEvent(new Event('change'));document.querySelector('[data-view="activity"]').click()`);
  await rpc("Page.reload", {}, panelSession);
  await until(() => ui(`document.querySelector('#session')?.options.length > 2`), "panel reopen");
  await ui(`document.querySelector('#session').value=${JSON.stringify(a.id)};document.querySelector('#session').dispatchEvent(new Event('change'))`);
  const afterReload = await command({ action: "snapshot", sessionId: a.id });
  check("panel reload recovers existing runs without starting again", () => assert.equal(afterReload.result.runs.filter(r => r.name === "Fyll testformulär").length, 1));
  const artifactDir = process.argv[3];
  await until(() => ui(`document.querySelector('#activity').textContent.includes('Fyll testformulär')`), "restored run UI");
  await openAdvanced();
  if (artifactDir) mkdirSync(artifactDir, { recursive: true });
    for (const width of [375, 768, 1440]) {
      await rpc("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, panelSession);
      // One header row per screen: the page header yields to each assistant's own topbar.
      const layout = await ui(`({width:innerWidth,scroll:document.documentElement.scrollWidth,shellHeader:getComputedStyle(document.querySelector('.shell-header')).display,topbars:[...document.querySelectorAll('.assistant-workspace')].map(workspace=>workspace.querySelectorAll(':scope > header').length),broken:[...document.images].some(i=>!i.complete||!i.naturalWidth)})`);
      assert.ok(layout.scroll <= layout.width); assert.equal(layout.broken, false);
      assert.equal(layout.shellHeader, "none"); assert.ok(layout.topbars.length > 0); assert.ok(layout.topbars.every(count => count === 1));
      if (artifactDir) {
        const capture = await rpc("Page.captureScreenshot", { format: "png" }, panelSession);
        writeFileSync(join(artifactDir, `control-panel-${width}.png`), Buffer.from(capture.data, "base64"));
      }
    }
    await rpc("Emulation.setDeviceMetricsOverride", { width: 375, height: 1100, deviceScaleFactor: 1, mobile: false }, panelSession);
    await ui(`document.querySelector('[data-view="recipes"]').click()`);
    await until(() => ui(`!!document.querySelector('[data-parameter="name"]')`), "recipe form after reopen");
    await ui(`document.querySelector('[data-parameter="name"]').value='Värde som bevaras';document.querySelector('#refresh').click()`);
    await until(() => ui(`document.querySelector('#recipes-message').hidden`), "recipe refresh completed");
    assert.equal(await ui(`document.querySelector('[data-parameter="name"]').value`), "Värde som bevaras");
    if (artifactDir) {
      const recipeShot = await rpc("Page.captureScreenshot", { format: "png" }, panelSession);
      writeFileSync(join(artifactDir, "control-panel-recipes.png"), Buffer.from(recipeShot.data, "base64"));
    }
    await ui(`document.querySelector('[data-view="history"]').click()`);
    await until(() => ui(`(()=>{const detail=document.querySelector('#history-list details');if(!detail)return false;detail.open=true;return detail.open;})()`), "history detail opened after refresh");
    if (artifactDir) {
      const historyShot = await rpc("Page.captureScreenshot", { format: "png" }, panelSession);
      writeFileSync(join(artifactDir, "control-panel-history.png"), Buffer.from(historyShot.data, "base64"));
    }
  check("responsive panel has no overflow or missing brand assets", () => {});
  check("panel has no uncaught exceptions or console errors", () => assert.deepEqual(panelErrors, []));
  const windowId = await ui("chrome.windows.getCurrent().then(w=>w.id)");
  await evaluate(panelSession, `chrome.sidePanel.open({windowId:${windowId}})`, true);
  const nativePanel = await until(() => ui("chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).then(c=>c.length>0)"), "native side panel opened");
  check("Chrome opens the native side panel from a user gesture", () => assert.equal(nativePanel, true));
  await ui(`chrome.sidePanel.close({windowId:${windowId}})`);
  const c = await connect("checkpoint-before-restart");
  await call(c, "navigate", { tabId: c.tabId, url: "http://127.0.0.1:9234/resume" });
  const currentGroups = await evaluate(workerSession, 'chrome.storage.local.get("mcpGroups").then(s=>s.mcpGroups)');
  c.id = Object.keys(currentGroups).find(id => currentGroups[id] === c.groupId);
  const resumeName = "Säkert fortsatt recept";
  const resumeActions = [
    { tool: "computer", args: { action: "left_click" }, target: { selector: "#first" }, expect: { text: "Ready", timeoutMs: 6000 } },
    { tool: "computer", args: { action: "left_click" }, target: { selector: "#second" }, expect: { text: "Finish" } },
  ];
  await call(c, "recipe_save", { name: resumeName, actions: resumeActions });
  const checkpointRun = callRaw(c.client, { name: "recipe_run", arguments: { name: resumeName, tabId: c.tabId, resumable: true } });
  const checkpointState = await until(async () => (await command({ action: "snapshot", sessionId: c.id })).result?.runs.find(run => run.name === resumeName && run.stage === "expect"), "first checkpoint expectation");
  assert.equal((await command({ action: "stop", sessionId: c.id, runId: checkpointState.runId })).result.requested, true);
  const checkpointResponse = await checkpointRun;
  assert.equal(checkpointResponse.structuredContent.status, "cancelled");
  const resumeId = checkpointResponse.structuredContent.resumeId;
  assert.equal((await call(c, "recipe_checkpoints")).find(item => item.resumeId === resumeId).resumable, true);
  await c.client.close(); c.closed = true;
  const d = await connect("checkpoint-after-restart");
  const wrongPage = await callRaw(d.client, { name: "recipe_resume", arguments: { resumeId, name: resumeName, tabId: d.tabId } });
  assert.equal(wrongPage.isError, true);
  assert.match(wrongPage.content[0].text, /URL changed/);
  await call(d, "navigate", { tabId: d.tabId, url: "http://127.0.0.1:9234/resume" });
  const resumed = await call(d, "recipe_resume", { resumeId, name: resumeName, tabId: d.tabId });
  assert.equal(resumed.status, "succeeded"); assert.equal(resumed.skippedSteps, 1);
  assert.deepEqual(await call(d, "javascript_tool", { tabId: d.tabId, text: "[Number(localStorage.getItem('resume-first')),Number(localStorage.getItem('resume-second'))]" }), [1, 1]);
  check("recipe resumes after an MCP process restart without repeating the verified click", () => {});

  const dGroups = await evaluate(workerSession, 'chrome.storage.local.get("mcpGroups").then(s=>s.mcpGroups)');
  d.id = Object.keys(dGroups).find(id => dGroups[id] === d.groupId);
  await call(d, "javascript_tool", { tabId: d.tabId, text: "localStorage.removeItem('resume-ready');document.querySelector('#checkpoint').textContent='';document.querySelector('#finished').textContent=''" });
  await ui(`document.querySelector('#session').value=${JSON.stringify(d.id)};document.querySelector('#session').dispatchEvent(new Event('change'));document.querySelector('[data-view="recipes"]').click()`);
  await until(() => ui(`!![...document.querySelector('#recipe').options].find(item=>item.value===${JSON.stringify(resumeName)})`), "resumable recipe in picker");
  await ui(`document.querySelector('#recipe').value=${JSON.stringify(resumeName)};document.querySelector('#recipe').dispatchEvent(new Event('change'));document.querySelector('#resumable').checked=true;document.querySelector('#start').click()`);
  const panelCheckpoint = await until(async () => (await command({ action: "snapshot", sessionId: d.id })).result?.runs.find(run => run.status === "running" && run.stage === "expect"), "panel checkpoint expectation");
  await command({ action: "stop", sessionId: d.id, runId: panelCheckpoint.runId });
  await until(async () => (await command({ action: "snapshot", sessionId: d.id })).result?.checkpoints.some(item => item.resumable), "panel checkpoint persisted");
  await ui(`document.querySelector('[data-view="recipes"]').click();document.querySelector('#refresh').click()`);
  await until(() => ui("document.querySelector('#resume-checkpoint').options.length===2"), "continuation picker");
  await ui("document.querySelector('#resume-checkpoint').selectedIndex=1;document.querySelector('#resume-checkpoint').dispatchEvent(new Event('change'));document.querySelector('#resume-checkpoint').scrollIntoView({block:'center'})");
  assert.equal(await ui("document.querySelector('#start').textContent"), "Återuppta efter kontrollpunkt");
  assert.equal(await ui("document.documentElement.scrollWidth <= innerWidth"), true);
  if (artifactDir) {
    const controls = await rpc("Page.captureScreenshot", { format: "png" }, panelSession);
    writeFileSync(join(artifactDir, "checkpoint-controls.png"), Buffer.from(controls.data, "base64"));
  }
  await ui("document.querySelector('#start').click()");
  await until(async () => (await command({ action: "snapshot", sessionId: d.id })).result?.runs.filter(run => run.status === "succeeded").length === 2, "panel continuation completed");
  assert.deepEqual(await call(d, "javascript_tool", { tabId: d.tabId, text: "[Number(localStorage.getItem('resume-first')),Number(localStorage.getItem('resume-second'))]" }), [2, 2]);
  check("panel starts, stops and resumes a checkpoint with exactly one effect per step", () => {});

  await call(d, "recipe_save", { name: "Ambiguous checkpoint", actions: [{ ...resumeActions[0], expect: { selector: "#private-timeout-secret", timeoutMs: 100 } }, resumeActions[1]] });
  const ambiguousResponse = await callRaw(d.client, { name: "recipe_run", arguments: { name: "Ambiguous checkpoint", tabId: d.tabId, resumable: true } });
  assert.equal(ambiguousResponse.isError, true);
  const ambiguous = ambiguousResponse.structuredContent;
  assert.equal(ambiguous.status, "failed");
  const blockedResume = await callRaw(d.client, { name: "recipe_resume", arguments: { resumeId: ambiguous.resumeId, name: "Ambiguous checkpoint", tabId: d.tabId } });
  assert.equal(blockedResume.isError, true);
  assert.match(blockedResume.content[0].text, /No safe checkpoint/);
  const incidents = await call(d, "timeout_incidents");
  assert(incidents.length > 0); assert.equal(incidents[0].diagnosticsAvailable, true);
  assert.equal(incidents[0].brokerBuildId, diagnostics.serverBuildId);
  assert.equal(incidents[0].extensionBuildId, diagnostics.serverBuildId);
  assert.doesNotMatch(JSON.stringify(incidents), /private-timeout-secret|127\.0\.0\.1|\/resume/);
  check("timeout saves a content-free bundle and an ambiguous click cannot be resumed", () => {});
  await ui(`document.querySelector('[data-view="activity"]').click();document.querySelector('#refresh').click()`);
  await until(() => ui(`[...document.querySelectorAll('#activity button')].some(b=>b.textContent==='Visa timeoutpaket')`), "timeout package button");
  await ui(`document.querySelector('[data-run-id="diagnostics"]').open=true;[...document.querySelectorAll('#activity button')].find(b=>b.textContent==='Visa timeoutpaket').click()`);
  await until(() => ui(`document.querySelector('.debug-viewer')?.textContent.includes(${JSON.stringify(incidents[0].incidentId)})`), "timeout evidence viewer");
  assert.equal(await ui(`document.querySelector('.debug-viewer').textContent.includes('private-timeout-secret')`), false);
  check("saved timeout metadata opens in the panel without page data", () => {});
  await ui(`document.querySelector('.debug-viewer button').click()`);

  await call(a, "navigate", { tabId: a.tabId, url: "http://127.0.0.1:9234" });
  const loopTarget = await call(a, "resolve_target", { tabId: a.tabId, target: { selector: "#loop" } });
  const loopArgs = { tabId: a.tabId, action: "left_click", ref: loopTarget.ref, documentId: loopTarget.documentId };
  for (let i = 0; i < 3; i++) await call(a, "computer", loopArgs);
  const guardedBatch = await callRaw(a.client, { name: "browser_batch", arguments: { actions: [{ tool: "computer", args: loopArgs }] } });
  assert.equal(guardedBatch.isError, true); assert.match(guardedBatch.content[0].text, /LOOP_DETECTED/);
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "window.loopClicks" }), 3);
  for (let i = 0; i < 4; i++) await call(a, "get_page_text", { tabId: a.tabId });
  await ui(`document.querySelector('#session').value=${JSON.stringify(a.id)};document.querySelector('#session').dispatchEvent(new Event('change'))`);
  await until(() => ui(`document.querySelector('#activity').textContent.includes('Loopvakt: kontrollera sidan')`), "loop warning in panel");
  try {
    // The loop control lives on the Avancerat page; open it before requesting focus.
    await openAdvanced();
    await ui(`window.heldContinue=[...document.querySelectorAll('#activity button')].find(b=>b.textContent==='Fortsätt efter kontroll')`);
    assert.equal(await ui(`!!window.heldContinue`), true, "manual continuation exists before focus");
    await ui(`window.heldContinue.focus()`);
    assert.equal(await ui(`document.activeElement===window.heldContinue`), true, "manual continuation acquired focus before refresh");
    await ui(`document.querySelector('#refresh').click()`);
    await until(() => ui(`(()=>{const current=document.querySelector('#activity [data-focus-key^="loop:"]');return !!current&&current!==window.heldContinue;})()`), "refreshed loop control");
    assert.equal(await ui(`document.activeElement===document.querySelector('#activity [data-focus-key^="loop:"]')`), true);
  } catch (error) {
    const focusState = await ui(`(()=>{
      const held=window.heldContinue,current=document.querySelector('#activity [data-focus-key^="loop:"]');
      const describe=element=>{if(!element)return null;const rect=element.getBoundingClientRect();return {tag:element.tagName,id:element.id,key:element.dataset.focusKey,connected:element.isConnected,rect:[rect.x,rect.y,rect.width,rect.height].map(Math.round),rects:element.getClientRects().length,disabled:element.disabled};};
      const details=[];for(let parent=current||held;parent;parent=parent.parentElement){if(parent.tagName==='DETAILS')details.push({id:parent.id,open:parent.open});}
      const activity=document.querySelector('#activity-view');
      return {activity:{hidden:activity.hidden,display:getComputedStyle(activity).display,visibility:getComputedStyle(activity).visibility},technicalOpen:document.querySelector('#technical-controls').open,details,held:describe(held),current:describe(current),active:describe(document.activeElement),visibility:document.visibilityState,documentFocused:document.hasFocus()};
    })()`).catch(() => ({ unavailable: true }));
    if (error instanceof Error) error.message += `\nloopFocusState=${JSON.stringify(focusState)}`;
    throw error;
  }
  check("panel refresh preserves keyboard focus on manual continuation", () => {});
  await ui(`[...document.querySelectorAll('#activity button')].find(b=>b.textContent==='Fortsätt efter kontroll').click()`);
  await until(async () => !(await command({ action: "snapshot", sessionId: a.id })).result.loopPauses.length, "manual guard continuation");
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "window.loopClicks" }), 3, "continuation did not replay the stopped click");
  await call(a, "computer", loopArgs);
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "window.loopClicks" }), 4);
  check("direct calls and batches share a loop fence; reads pass and panel continuation never replays", () => {});

  await call(a, "navigate", { tabId: a.tabId, url: "http://127.0.0.1:9234" });
  await call(a, "recipe_save", { name: "Loop guard regression", actions: Array.from({ length: 4 }, () => ({ tool: "computer", args: { action: "left_click" }, target: { selector: "#loop" } })) });
  const guardedRecipe = await callRaw(a.client, { name: "recipe_run", arguments: { name: "Loop guard regression", tabId: a.tabId } });
  assert.equal(guardedRecipe.isError, true); assert.equal(guardedRecipe.structuredContent.completedSteps, 3);
  assert.match(guardedRecipe.content[0].text, /LOOP_DETECTED/);
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "window.loopClicks" }), 3);
  check("recipes stop before their fourth stagnant mutation", () => {});

  await call(a, "navigate", { tabId: a.tabId, url: "http://127.0.0.1:9234/scroll" });
  const scroller = await call(a, "resolve_target", { tabId: a.tabId, target: { selector: "#scroller" } });
  for (let i = 0; i < 6; i++) await call(a, "computer", { tabId: a.tabId, action: "scroll", scroll_direction: "down", scroll_amount: 1 });
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "scrollY" }), 600);
  for (let i = 0; i < 6; i++) await call(a, "computer", { tabId: a.tabId, action: "scroll", ref: scroller.ref, scroll_direction: "down", scroll_amount: 1 });
  assert.equal(await call(a, "javascript_tool", { tabId: a.tabId, text: "document.querySelector('#scroller').scrollTop" }), 600);
  assert.equal((await command({ action: "snapshot", sessionId: a.id })).result.loopPauses.length, 0);
  check("root and nested scroll progress do not trigger a loop pause", () => {});

  await d.client.close(); d.closed = true;
  const e = await connect("incident-after-restart");
  assert.equal((await call(e, "timeout_incidents", { incidentId: incidents[0].incidentId })).incidentId, incidents[0].incidentId);
  check("timeout evidence survives an MCP process restart", () => {});
  await ui(`document.querySelector('#session').value=${JSON.stringify(b.id)};document.querySelector('#session').dispatchEvent(new Event('change'));document.querySelector('[data-view="history"]').click()`);
  await until(() => ui(`!!document.querySelector('#history-list details[data-run-id="${failed.structuredContent.runId}"] button')`), "shared history after session switch");
  await ui(`document.querySelector('#history-list details[data-run-id="${failed.structuredContent.runId}"]').open=true;document.querySelector('#history-list details[data-run-id="${failed.structuredContent.runId}"] button').click()`);
  await until(() => ui(`!!document.querySelector('.debug-viewer img')?.naturalWidth`), "image before disconnect");
  await b.client.close(); b.closed = true;
  await until(() => ui(`!document.querySelector('.debug-viewer')`), "evidence viewer cleared after disconnect");
  check("disconnect clears the open image viewer", () => {});
  await until(async () => !(await command({ action: "sessions" })).result.some(session => session.sessionId === b.id), "disconnected session removed");
  const disconnected = await command({ action: "snapshot", sessionId: b.id });
  check("disconnected session rejects snapshot requests", () => assert.equal(disconnected.ok, false));
  check("evidence and loop controls produce no uncaught panel errors", () => assert.deepEqual(panelErrors, []));
  exitCode = 0;
} catch (error) { console.error(error.stack); }
finally { await cleanup(); stopWatchdog(); }
console.log(`\n=== sidepanel-live: ${passed} passed, ${exitCode ? 1 : 0} failed ===`);
process.exit(exitCode);
