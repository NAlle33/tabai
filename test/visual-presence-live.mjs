import { openCdpObserver } from "./helpers/cdp-observer.mjs";
import { createMcpClient, createMcpTransport, connectMcpClient, callRaw, textContent as text } from "./helpers/mcp-client.mjs";
// Observe actual extension-owned DOM through its isolated world. Browser-level
// CDP attaches only to the worker; Tabai retains the page debugger.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as runtimeEnvironment } from "node:process";


import { watchdog } from "./watchdog.mjs";

let observer;
const rpc = (...args) => observer.rpc(...args);


const client = createMcpClient({ name: "visual-presence-live", version: "0.0.0" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifactDir = process.argv[3];
let socket, workerSession, extensionId, tabId, origin;
let originalFocusPreference;
let focusPreferenceLoaded = false;
const extraTabs = [];
const projectRoot = mkdtempSync(join(tmpdir(), 'tabai-project-name-'));
const projectDirectory = join(projectRoot, 'Hej och Hå');
mkdirSync(projectDirectory);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Tabai presence fixture</title>
    <style>body{margin:0;background:white;color:#173f33;font:18px system-ui}main{margin:80px}
    #under{position:fixed;right:10px;bottom:10px;width:160px;height:65px;opacity:0}</style>
    <main><h1>A calmer browser companion.</h1><p>Your page stays yours.</p><button id="action">Continue</button></main>
    <button id="under" aria-label="Under badge">Under badge</button>`);
});
async function worker(expression) {
  const result = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, workerSession);
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function page(body, id = tabId) {
  const results = await worker(`chrome.scripting.executeScript({target:{tabId:${id}},func:async()=>{${body}}})`);
  return results[0]?.result;
}
async function snapshot(id = tabId) {
  return page(`const s=window.__ccmcpPresence;if(!s||!s.host.isConnected)return null;
    const edge=s.root.querySelector('.edge'),canvas=s.root.querySelector('canvas');
    return {state:s.host.dataset.state,text:s.root.textContent.split('Tabai').pop(),
      display:getComputedStyle(s.host).display,pointer:getComputedStyle(s.host).pointerEvents,
      animation:getComputedStyle(edge).animationName,logo:[...canvas.getContext('2d').getImageData(0,0,48,48).data].some((v,i)=>i%4===3&&v>0),
      hits:document.elementFromPoint(innerWidth-45,innerHeight-35)?.id,
      count:document.querySelectorAll('[data-ccmcp-presence]').length};`, id);
}
async function until(check) {
  for (let i = 0; i < 80; i++) { const value = await check(); if (value) return value; await sleep(50); }
  throw new Error("presence condition did not settle");
}
async function ok(name, args = {}) {
  const result = await callRaw(client, { name, arguments: args });
  assert.notEqual(result.isError, true, text(result));
  return result;
}
async function json(name, args = {}) {
  const result = await ok(name, args);
  return result.structuredContent ?? JSON.parse(text(result));
}
async function cleanPixels(result) {
  const image = result.content.find(item => item.type === "image");
  assert.ok(image, "expected an actual image");
  const count = await page(`const bytes=Uint8Array.from(atob(${JSON.stringify(image.data)}),c=>c.charCodeAt(0));
    const bmp=await createImageBitmap(new Blob([bytes],{type:${JSON.stringify(image.mimeType)}}));
    const canvas=new OffscreenCanvas(bmp.width,bmp.height),cx=canvas.getContext('2d');cx.drawImage(bmp,0,0);bmp.close();
    const data=cx.getImageData(0,0,canvas.width,canvas.height).data;let dirty=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
      if(!(x<2||y<2||x>canvas.width-3||y>canvas.height-3||(x>canvas.width-190&&y>canvas.height-85)))continue;
      const i=(y*canvas.width+x)*4;if(data[i]<245||data[i+1]<245||data[i+2]<245)dirty++;
    }return dirty;`);
  assert.equal(count, 0, "capture includes colored edge or badge pixels");
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ✓ ${name}`); }
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    if (workerSession) await worker("chrome.storage.local.set({showVisualPresence:true})").catch(() => {});
    if (workerSession && focusPreferenceLoaded) await worker(originalFocusPreference === undefined
      ? "chrome.storage.local.remove('allowAgentFocus')"
      : `chrome.storage.local.set({allowAgentFocus:${JSON.stringify(originalFocusPreference)}})`).catch(() => {});
    if (tabId) await ok("tabs_close_mcp", { tabId }).catch(() => {});
    if (extraTabs.length && workerSession) await worker(`chrome.tabs.remove(${JSON.stringify(extraTabs)})`).catch(() => {});
    await client.close().catch(() => {});
    rmSync(projectRoot, { recursive: true, force: true });
    observer?.rejectPending(new Error("cleanup"));
    socket?.terminate();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  })();
}
const stopWatchdog = watchdog(cleanup);
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = new URL(process.argv[2]);
  assert.equal(endpoint.hostname, "127.0.0.1");
  observer = await openCdpObserver(endpoint, { timeoutMs: 10000, timeoutMessage: method => `${method} timed out` });
  socket = observer.socket;
  const targets = (await rpc("Target.getTargets")).targetInfos;
  const target = targets.find(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && new URL(t.url).pathname === "/dist/background.js");
  assert.ok(target); extensionId = new URL(target.url).host;
  workerSession = (await rpc("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  await connectMcpClient(client, createMcpTransport({ command: "npm", args: ["--prefix", process.cwd(), "start", "--silent"],
    cwd: projectDirectory,
    env: Object.fromEntries(Object.entries(runtimeEnvironment).filter(([key, value]) => key.startsWith("CCMCP_") && typeof value === "string")) }));
  await until(async () => (await worker("chrome.storage.local.get('bridgeStatus')")).bridgeStatus === "connected");
  const foreground = await worker("chrome.windows.create({url:'about:blank',focused:true})");
  originalFocusPreference = (await worker("chrome.storage.local.get('allowAgentFocus')")).allowAgentFocus;
  focusPreferenceLoaded = true;
  await worker("chrome.storage.local.remove('allowAgentFocus')");
  extraTabs.push(foreground.tabs[0].id);
  tabId = (await json("tabs_context_mcp", { createIfEmpty: true })).tabs[0].tabId;
  await test("new sessions preserve the user's foreground window", async () => {
    const created = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.windows.get(t.windowId))`);
    assert.notEqual(created.id, foreground.id);
    assert.equal(created.focused, false);
    assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
  });
  await ok("navigate", { tabId, url: origin, waitUntil: "load" });
  await test("navigation, reused sessions and added tabs stay in the background", async () => {
    const reused = await json("tabs_context_mcp", { createIfEmpty: true });
    assert.equal(reused.tabs[0].tabId, tabId);
    const extra = await json("tabs_create_mcp"); extraTabs.push(extra.tabId);
    assert.equal(extra.active, false);
    assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
  });
  await test("tab switching stays in the background without a foreground request", async () => {
    for (const args of [{ tabId: extraTabs.at(-1) }, { tabId, bringToFront: false }]) {
      const switched = await json("tab_switch", args);
      assert.equal(switched.active, true);
      const owned = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.windows.get(t.windowId))`);
      assert.equal(owned.focused, false);
      assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
    }
  });
  await test("agent flags cannot override the user's default background preference", async () => {
    const companion = extraTabs.at(-1);
    await ok("tab_switch", { tabId: companion });
    for (const request of [
      { name: "tab_switch", arguments: { tabId, bringToFront: true } },
      { name: "computer", arguments: { tabId, action: "left_click", pointerMode: "browser", coordinate: [20, 20], allowFocus: true } },
    ]) {
      const failed = await callRaw(client, request);
      assert.equal(failed.isError, true);
      assert.match(text(failed), /FOCUS_DISABLED/);
      assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
      assert.equal((await worker(`chrome.tabs.get(${companion})`)).active, true);
    }
  });
  await test("screenshots capture in the background without taking focus", async () => {
    await cleanPixels(await ok("computer", { tabId, action: "screenshot" }));
    await cleanPixels(await ok("computer", { tabId, action: "screenshot", allowFocus: true }));
    assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
  });
  await test("failed background captures leave the window and selected tab alone", async () => {
    const companion = extraTabs.at(-1);
    await ok("tab_switch", { tabId: companion });
    await worker(`globalThis.savedSend=chrome.debugger.sendCommand;chrome.debugger.sendCommand=(source,method,...args)=>method==='Page.captureScreenshot'?Promise.reject(new Error('fixture capture failure')):savedSend(source,method,...args);`);
    try {
      const failed = await callRaw(client, { name: "computer", arguments: { tabId, action: "screenshot" } });
      assert.equal(failed.isError, true);
      assert.match(text(failed), /background screenshot unavailable/i);
      assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
      assert.equal((await worker(`chrome.tabs.get(${companion})`)).active, true);
      assert.equal((await snapshot()).display, "block");
      const focusRequested = await callRaw(client, { name: "computer", arguments: { tabId, action: "screenshot", allowFocus: true } });
      assert.equal(focusRequested.isError, true);
      assert.match(text(focusRequested), /FOCUS_DISABLED/);
      assert.equal((await worker("chrome.windows.getLastFocused()")).id, foreground.id);
      assert.equal((await worker(`chrome.tabs.get(${companion})`)).active, true);
    } finally { await worker("chrome.debugger.sendCommand=savedSend;delete globalThis.savedSend;"); }
  });
  await test("an essential screenshot can explicitly use the foreground fallback", async () => {
    await worker("chrome.storage.local.set({allowAgentFocus:true})");
    await worker(`globalThis.savedSend=chrome.debugger.sendCommand;chrome.debugger.sendCommand=(source,method,...args)=>method==='Page.captureScreenshot'?Promise.reject(new Error('fixture capture failure')):savedSend(source,method,...args);`);
    try {
      await cleanPixels(await ok("computer", { tabId, action: "screenshot", allowFocus: true }));
      const owned = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.windows.get(t.windowId))`);
      assert.equal(owned.focused, true);
      assert.equal((await worker(`chrome.tabs.get(${tabId})`)).active, true);
    } finally {
      await worker("chrome.debugger.sendCommand=savedSend;delete globalThis.savedSend;");
      await worker("chrome.storage.local.set({allowAgentFocus:false})");
      await worker(`chrome.windows.update(${foreground.id},{focused:true})`);
    }
  });
  await test("explicit foreground switching brings the owned window forward", async () => {
    await worker("chrome.storage.local.set({allowAgentFocus:true})");
    try {
      await ok("tab_switch", { tabId, bringToFront: true });
      const owned = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.windows.get(t.windowId))`);
      assert.equal(owned.focused, true);
      assert.equal((await worker("chrome.windows.getLastFocused()")).id, owned.id);
    } finally { await worker("chrome.storage.local.set({allowAgentFocus:false})"); }
  });

  await test("native group is blue, readable and still distinct", async () => {
    const group = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.tabGroups.get(t.groupId))`);
    assert.equal(group.color, "blue"); assert.equal(group.title, 'Hej och Hå');
  });
  await test("CSP-safe logo and idle badge are isolated and click-through", async () => {
    const state = await snapshot();
    assert.equal(state.state, "idle"); assert.equal(state.logo, true); assert.equal(state.pointer, "none");
    assert.equal(state.hits, "under"); assert.equal(state.count, 1); assert.equal(state.animation, "none");
    await page("document.querySelector('#under').addEventListener('click',()=>document.body.dataset.clicked='yes');return true;");
    const point = await page("return [innerWidth-45,innerHeight-35];");
    await ok("computer", { tabId, action: "left_click", coordinate: point });
    assert.equal(await page("return document.body.dataset.clicked;"), "yes");
  });
  await test("overlapping work and waits show actual activity and then settle", async () => {
    const wait = ok("computer", { tabId, action: "wait", duration: 2 });
    await until(async () => (await snapshot())?.state === "waiting");
    const work = ok("javascript_tool", { tabId, text: "new Promise(resolve=>setTimeout(()=>resolve('done'),800))" });
    await until(async () => (await snapshot())?.state === "working");
    assert.equal((await snapshot()).animation, "flow");
    if (artifactDir) {
      const dataUrl = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.tabs.captureVisibleTab(t.windowId,{format:'png'}))`);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "tabai-presence-working.png"), Buffer.from(dataUrl.split(",")[1], "base64"));
    }
    await work;
    assert.equal((await snapshot()).state, "waiting");
    await wait; assert.equal((await snapshot()).state, "idle");
  });
  await test("reduced motion disables the working animation", async () => {
    await worker(`chrome.debugger.sendCommand({tabId:${tabId}},'Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})`);
    try {
      const work = ok("javascript_tool", { tabId, text: "new Promise(resolve=>setTimeout(()=>resolve('done'),400))" });
      await until(async () => (await snapshot())?.state === "working");
      assert.equal((await snapshot()).animation, "none"); await work;
    } finally { await worker(`chrome.debugger.sendCommand({tabId:${tabId}},'Emulation.setEmulatedMedia',{features:[]})`); }
  });
  await test("page reads and numbered target maps exclude the badge", async () => {
    // The click-through target was deliberately under the badge; remove it so
    // numbered target labels cannot legitimately color this pixel-test region.
    await page("document.querySelector('#under').remove();return true;");
    for (const [name, args] of [["read_page", { filter: "all" }], ["read_page", { compact: true, filter: "all" }],
      ["get_page_text", {}], ["get_accessibility_tree", {}], ["read_page_diff", { reset: true }]]) {
      assert.doesNotMatch(text(await ok(name, { tabId, ...args })), /Arbetar|Väntar|Redo/);
    }
    const marked = await ok("screenshot_marked", { tabId });
    assert.doesNotMatch(JSON.stringify(marked.structuredContent), /Arbetar|Väntar|Redo/);
    await cleanPixels(marked);
  });
  await test("ordinary and computer screenshots omit badge and edge pixels", async () => {
    await cleanPixels(await ok("screenshot", { tabId }));
    await cleanPixels(await ok("computer", { tabId, action: "screenshot" }));
    assert.equal((await snapshot()).display, "block");
  });
  await test("overlapping screenshots stay hidden until both captures finish", async () => {
    const shots = await Promise.all([ok("screenshot", { tabId }), ok("screenshot", { tabId })]);
    for (const shot of shots) await cleanPixels(shot);
    assert.equal((await snapshot()).state, "idle");
    assert.equal((await snapshot()).display, "block");
  });
  await test("capture failures restore presence; native fallback is also clean", async () => {
    await worker(`globalThis.savedSend=chrome.debugger.sendCommand;chrome.debugger.sendCommand=(source,method,...args)=>method==='Page.captureScreenshot'?Promise.reject(new Error('fixture capture failure')):savedSend(source,method,...args);`);
    try {
      const failed = await callRaw(client, { name: "screenshot", arguments: { tabId } });
      assert.equal(failed.isError, true); assert.equal((await snapshot()).display, "block");
      await cleanPixels(await ok("computer", { tabId, action: "screenshot" }));
    } finally { await worker("chrome.debugger.sendCommand=savedSend;delete globalThis.savedSend;"); }
  });
  await test("stalled presence cannot block real commands and refuses an unconfirmed capture", async () => {
    // Faults are confined to the harness's disposable browser, never everyday Chrome.
    assert.equal(runtimeEnvironment.CCMCP_PORT, "9224");
    const companion = await json("tabs_create_mcp"); extraTabs.push(companion.tabId);
    await ok("navigate", { tabId: companion.tabId, url: origin, waitUntil: "load" });
    await worker(`globalThis.presenceFault={script:chrome.scripting.executeScript,send:chrome.debugger.sendCommand,held:true,renders:0,captures:0};
      chrome.scripting.executeScript=(options,...rest)=>{
        if(options.target.tabId===${tabId}&&options.func?.name==='renderPresence'){
          presenceFault.renders++;
          if(presenceFault.held)return new Promise((resolve,reject)=>{presenceFault.release=()=>{if(!presenceFault.held)return;presenceFault.held=false;return presenceFault.script(options,...rest).then(resolve,reject)}});
        }return presenceFault.script(options,...rest);
      };
      chrome.debugger.sendCommand=(source,method,...rest)=>{
        if(source.tabId===${tabId}&&(method==='Page.captureScreenshot'||method==='Page.printToPDF'))presenceFault.captures++;
        return presenceFault.send(source,method,...rest);
      };`);
    try {
      const started = Date.now();
      assert.equal(await json("javascript_tool", { tabId, text: "window.__presenceAction=(window.__presenceAction||0)+1" }), 1);
      assert.equal((await json("tabs_context_mcp", { createIfEmpty: false })).tabs.some(t => t.tabId === tabId), true);
      assert.equal(text(await ok("javascript_tool", { tabId: companion.tabId, text: "document.title" })), "Tabai presence fixture");
      const health = await json("health");
      assert.equal(health.bridgeConnected, true);
      assert.match(health.serverBuildId, /^sha256:[a-f0-9]{64}$/);
      assert.equal(health.extension.buildId, health.serverBuildId);
      assert.equal(health.extension.diagnostics.degraded, true);
      assert.ok(health.extension.diagnostics.active.some(entry => entry.operation === "presence.render" && entry.tabId === tabId && entry.durationMs >= 250));
      for (const name of ["screenshot", "print_to_pdf"]) {
        const rejected = await callRaw(client, { name, arguments: { tabId } });
        assert.equal(rejected.isError, true); assert.match(text(rejected), /presence|capture refused/i);
      }
      assert.ok(Date.now() - started < 10000, "cosmetic faults must settle below the unchanged 30-second transport deadline");
      assert.deepEqual(await worker("({renders:presenceFault.renders,captures:presenceFault.captures})"), { renders: 1, captures: 0 });
      await worker("presenceFault.release()");
      await until(async () => (await snapshot())?.state === "idle");
      assert.ok(await worker("presenceFault.renders<=2"), "late work is coalesced instead of accumulating");
      assert.equal(await json("javascript_tool", { tabId, text: "window.__presenceAction" }), 1, "the mutation was not replayed");
      await cleanPixels(await ok("screenshot", { tabId }));
    } finally {
      await worker("presenceFault.release?.();chrome.scripting.executeScript=presenceFault.script;chrome.debugger.sendCommand=presenceFault.send;delete globalThis.presenceFault;");
    }
  });
  await test("capture hides a stale owner even when the preceding cosmetic paint fails", async () => {
    for (const replacedWorld of [false, true]) {
      // Markers are `<origin token>:<owner token>`; keep this origin's token and retire the owner.
      const marker = await page(`const s=window.__ccmcpPresence;const marker=s.host.getAttribute('data-ccmcp-presence');s.owner='retired-owner';s.host.setAttribute('data-ccmcp-presence',marker.split(':')[0]+':retired-owner');${replacedWorld ? "delete window.__ccmcpPresence;" : ""}return marker;`);
      assert.match(marker, /^[0-9a-f]{32}:[0-9a-f]{32}$/, "the page marker carries only keyed hashes");
      await worker(`globalThis.savedPresenceScript=chrome.scripting.executeScript;
        chrome.scripting.executeScript=(options,...rest)=>options.target.tabId===${tabId}&&options.func?.name==='renderPresence'&&options.args[1]==='working'
          ?Promise.reject(new Error('fixture working paint failed')):savedPresenceScript(options,...rest);`);
      try { await cleanPixels(await ok("screenshot", { tabId })); }
      finally { await worker("chrome.scripting.executeScript=savedPresenceScript;delete globalThis.savedPresenceScript;"); }
      assert.equal((await snapshot()).state, "idle");
    }
  });
  await test("GIF frames and PDF dispatch hide presence", async () => {
    await worker(`globalThis.captureStates=[];globalThis.savedSend=chrome.debugger.sendCommand;chrome.debugger.sendCommand=async(source,method,...args)=>{if(method==='Page.captureScreenshot'||method==='Page.printToPDF'){const r=await chrome.scripting.executeScript({target:{tabId:source.tabId},func:()=>getComputedStyle(window.__ccmcpPresence.host).display});captureStates.push({method,display:r[0].result});}return savedSend(source,method,...args)};`);
    try {
      await ok("gif_creator", { tabId, action: "start_recording" });
      await sleep(650); await ok("gif_creator", { tabId, action: "stop_recording" });
      await ok("print_to_pdf", { tabId });
      const captures = await worker("captureStates");
      assert.ok(captures.filter(c => c.method === "Page.captureScreenshot").length >= 2);
      assert.ok(captures.some(c => c.method === "Page.printToPDF"));
      assert.ok(captures.every(c => c.display === "none"));
    } finally { await worker("chrome.debugger.sendCommand=savedSend;delete globalThis.savedSend;delete globalThis.captureStates;"); }
  });
  await test("popup toggle persists and removes/restores existing page presence", async () => {
    const popup = await rpc("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
    try {
      const session = (await rpc("Target.attachToTarget", { targetId: popup.targetId, flatten: true })).sessionId;
      const evaluate = async expression => (await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session)).result?.value;
      // Static controls precede the script; wait for listeners and saved settings.
      await until(() => evaluate("document.readyState === 'complete' && !!document.getElementById('info')?.textContent && !!document.getElementById('status')?.className"));
      assert.equal(await evaluate("document.getElementById('presence').checked"), true);
      await evaluate("document.getElementById('presence').click()");
      await until(async () => (await snapshot()) === null);
      assert.equal((await worker("chrome.storage.local.get('showVisualPresence')")).showVisualPresence, false);
      await ok("tab_reload", { tabId }); assert.equal(await snapshot(), null);
      await evaluate("document.getElementById('presence').click()");
      await until(async () => (await snapshot())?.state === "idle");
    } finally { await rpc("Target.closeTarget", { targetId: popup.targetId }); }
  });
  await test("navigation and worker restart recreate one idle surface", async () => {
    await ok("navigate", { tabId, url: `${origin}/next`, waitUntil: "load" });
    assert.equal((await snapshot()).count, 1);
    await worker("globalThis.presenceRestartMarker=true");
    // Chrome's documented MV3 termination test: close the worker target, then
    // let an actual extension event start a new worker. Full extension reload
    // is covered separately by extension-reload.mjs (headless wake limitations).
    const prior = (await rpc("Target.getTargets")).targetInfos.find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
    await rpc("Target.closeTarget", { targetId: prior.targetId });
    await ok("health");
    await until(async () => {
      const target = (await rpc("Target.getTargets")).targetInfos.find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
      if (!target) return false;
      try { workerSession = (await rpc("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId; return true; } catch { return false; }
    });
    assert.equal(await worker("globalThis.presenceRestartMarker===undefined"), true);
    await until(async () => (await snapshot())?.state === "idle");
    assert.equal((await snapshot()).count, 1);
  });
  await test("an orphaned surface from a replaced isolated world is retired", async () => {
    // Reproduced with real Chrome extension_reload: the isolated global is gone
    // while the closed-shadow host remains in the document. Exercise that exact
    // renderer boundary without relying on idle headless extension reload wake.
    await page("delete window.__ccmcpPresence;return true;");
    assert.equal(await page("return document.querySelectorAll('[data-ccmcp-presence]').length;"), 1);
    await ok("get_page_text", { tabId });
    assert.equal((await snapshot()).count, 1);
    await page("document.querySelector('#under')?.remove();return true;");
    await cleanPixels(await ok("screenshot", { tabId }));
  });
  await test("moving a tab out removes only Tabai's presentation", async () => {
    const originalGroup = await worker(`chrome.tabs.get(${tabId}).then(t=>t.groupId)`);
    // Keep the group alive so it can be restored for normal tool cleanup.
    const companion = await worker(`chrome.tabs.create({url:'about:blank',active:false}).then(async t=>{await chrome.tabs.group({tabIds:[t.id],groupId:${originalGroup}});return t.id;})`);
    extraTabs.push(companion);
    await worker(`chrome.tabs.ungroup(${tabId})`);
    await until(async () => (await snapshot()) === null);
    assert.equal(await page("return document.querySelector('h1').textContent;"), "A calmer browser companion.");
    await worker(`chrome.tabs.group({tabIds:[${tabId}],groupId:${originalGroup}})`);
    await until(async () => (await snapshot())?.state === "idle");
  });
  await test("a renamed group loses presence and remains outside tool ownership", async () => {
    extraTabs.push(tabId); // the observer owns cleanup once tool access is revoked
    await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.tabGroups.update(t.groupId,{title:'Personal research'}))`);
    await until(async () => (await snapshot()) === null);
    const rejected = await callRaw(client, { name: "get_page_text", arguments: { tabId } });
    assert.equal(rejected.isError, true);
    const title = await worker(`chrome.tabs.get(${tabId}).then(t=>chrome.tabGroups.get(t.groupId)).then(g=>g.title)`);
    assert.equal(title, "Personal research");
  });
} finally { try { await cleanup(); } finally { stopWatchdog(); } }
console.log(`\nVisual presence: ${passed} passed`);
