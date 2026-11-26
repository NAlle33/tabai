import { WebSocket } from "ws";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";
import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
// Real-extension lifecycle checks. Observe its isolated world through the
// disposable browser's worker, leaving page debugger ownership with the tools.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env as runtimeEnvironment } from "node:process";
import { fileURLToPath } from "node:url";


import { watchdog } from "./watchdog.mjs";

let observer;
const rpc = (...args) => observer.rpc(...args);
const rejectPending = error => observer?.rejectPending(error);


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
const client = createMcpClient({ name: "ref-map-live", version: "0.0.0" });
let socket;
let workerSession;
let tabId;
let caseId = 0;
let origin;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `<!doctype html><title>Ref lifecycle fixture</title>
<button id="keep" aria-label="fixture keep" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Keep</button>
<input id="field" aria-label="fixture field">
<div id="pool"></div><div id="destination"></div>
<script>addEventListener('message',event=>{if(event.data==='remove-fixture-field')document.getElementById('field')?.remove()})</script>`;
const servers = Array.from({ length: 2 }, () => http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end(fixture);
}));
async function attachObserver() {
  const endpoint = new URL(process.argv[2] ?? "");
  assert.equal(endpoint.protocol, "ws:");
  assert.equal(endpoint.hostname, "127.0.0.1", "observer must use the harness's loopback browser");
  observer = await openCdpObserver(endpoint, { timeoutMs: 5000, timeoutMessage: method => `CDP ${method} timed out`, handshakeTimeout: 5000 });
  socket = observer.socket;
  const { targetInfos } = await rpc("Target.getTargets");
  const workers = targetInfos.filter(target => target.type === "service_worker" &&
    target.url.startsWith("chrome-extension://") &&
    new URL(target.url).pathname === `/${manifest.background.service_worker}`);
  assert.equal(workers.length, 1, "expected exactly one loaded extension worker");
  ({ sessionId: workerSession } = await rpc("Target.attachToTarget", { targetId: workers[0].targetId, flatten: true }));
}
async function observe() {
  const reply = await rpc("Runtime.evaluate", {
    expression: `chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},world:"ISOLATED",func:()=>{
      const map=window.__ccmcpRefMap;
      if(!map||typeof map!=="object")throw new Error("extension ref map is missing");
      return {counter:window.__ccmcpRef,entries:Object.entries(map).map(([ref,node])=>({
        ref,id:node.id,connected:node.isConnected,tag:node.getAttribute("data-ccmcp-ref")
      }))};
    }})`,
    awaitPromise: true,
    returnByValue: true,
  }, workerSession);
  assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails));
  const frames = reply.result?.value;
  assert.ok(Array.isArray(frames) && frames.length > 0, "observer returned no frame results");
  for (const frame of frames) {
    assert.equal(typeof frame.frameId, "number");
    assert.ok(Array.isArray(frame.result?.entries), "observer must return actual map entries");
    assert.equal(typeof frame.result.counter, "number");
    for (const entry of frame.result.entries) assert.equal(typeof entry.connected, "boolean");
  }
  return frames;
}
async function mainMap() {
  const frame = (await observe()).find(frame => frame.frameId === 0);
  assert.ok(frame, "main-frame observation is missing");
  return frame.result;
}
async function ok(name, args = {}) {
  const result = await callRaw(client, { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  assert.notEqual(result.isError, true, text);
  return text;
}
async function rejected(name, args = {}) {
  const result = await callRaw(client, { name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, true, `${name} must reject the reference: ${text}`);
  assert.match(text, /stale|ambiguous|document changed/i);
  return text;
}
const evaluate = text => ok("javascript_tool", { tabId, text });
const read = (args = {}) => ok("read_page", { tabId, filter: "interactive", ...args });
const find = query => ok("find", { tabId, query });
function entryFor(map, id) {
  const entries = map.entries.filter(entry => entry.id === id);
  assert.equal(entries.length, 1, `expected one mapped element with id ${id}`);
  assert.equal(entries[0].connected, true, `${id} must be connected`);
  assert.equal(entries[0].tag, entries[0].ref, `${id} must retain its map identity`);
  return entries[0];
}
function assertClean(map, expectedSize) {
  assert.equal(map.entries.filter(entry => !entry.connected).length, 0, "map retained disconnected elements after a scan");
  assert.equal(map.entries.length, expectedSize, "map size must reflect connected fixture refs");
}
async function fresh() {
  await ok("navigate", { tabId, url: `${origin}/fixture?case=${++caseId}`, waitUntil: "load" });
}
let teardownPromise;
function cleanup() {
  return teardownPromise ??= (async () => {
    if (workerSession && socket?.readyState === WebSocket.OPEN) {
      await rpc("Target.detachFromTarget", { sessionId: workerSession }).catch(() => {});
    }
    rejectPending(new Error("observer cleanup"));
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close").catch(() => {});
      const deadline = setTimeout(() => socket.terminate(), 1000);
      socket.close();
      await closed;
      clearTimeout(deadline);
    }
    try {
      if (tabId) await ok("tabs_close_mcp", { tabId });
    } finally {
      try {
        await client.close();
      } finally {
        for (const server of servers) {
          server.closeAllConnections();
          if (server.listening) await new Promise(resolve => server.close(resolve));
        }
      }
    }
  })();
}
const stopWatchdog = watchdog(cleanup);
let passes = 0;
let failures = 0;
async function test(name, run) {
  try {
    await fresh();
    await run();
    passes++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}
async function churn(register, collect, count = 16, cycles = 20) {
  await register();
  const initial = await mainMap();
  assertClean(initial, 2);
  const keepRef = entryFor(initial, "keep").ref;
  const fieldRef = entryFor(initial, "field").ref;
  let counter = initial.counter;
  const seenRefs = new Set(initial.entries.map(entry => entry.ref));
  const started = Date.now();
  for (let cycle = 0; cycle < cycles; cycle++) {
    await evaluate(`(()=>{for(let i=0;i<${count};i++){const b=document.createElement('button');b.id='transient-'+i;b.setAttribute('aria-label','fixture transient '+i);b.textContent='Transient';document.getElementById('pool').appendChild(b)}return 'created'})()`);
    await register();
    const populated = await mainMap();
    assertClean(populated, count + 2);
    assert.equal(entryFor(populated, "keep").ref, keepRef, "a connected ref changed during a scan");
    assert.equal(entryFor(populated, "field").ref, fieldRef);
    for (let i = 0; i < count; i++) {
      const ref = entryFor(populated, `transient-${i}`).ref;
      assert.equal(seenRefs.has(ref), false, "ref allocator reused an old identity");
      seenRefs.add(ref);
    }
    assert.equal(populated.counter, counter + count, "every new node must advance the allocator");
    counter = populated.counter;
    await evaluate("document.getElementById('pool').replaceChildren(); 'removed'");
    await collect();
    const pruned = await mainMap();
    assertClean(pruned, 2);
    assert.equal(entryFor(pruned, "keep").ref, keepRef);
    assert.equal(entryFor(pruned, "field").ref, fieldRef);
    assert.equal(pruned.counter, counter, "cleanup must preserve the allocator");
  }
  console.log(`    ${cycles} cycles × ${count} elements; retained=2; ${Date.now() - started}ms`);
}

try {
  for (const server of servers) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  origin = `http://127.0.0.1:${servers[0].address().port}`;
  await connectMcpClient(client, createMcpTransport({
    command: process.execPath,
    args: [join(root, "dist/server.js")],
    cwd: root,
    // The harness builds these settings into its isolated server/broker and
    // forwards them at runtime. Do not copy unrelated credentials to a child.
    env: Object.fromEntries([
      "CCMCP_PORT", "CCMCP_CLIENT_PORT", "CCMCP_LOG_DIR", "CCMCP_REAP_GRACE_MS", "CCMCP_CONFIG_DIR",
    ].flatMap(name => typeof runtimeEnvironment[name] === "string" ? [[name, runtimeEnvironment[name]]] : [])),
  }));
  await ok("tabs_context_mcp", {});
  tabId = JSON.parse(await ok("tabs_create_mcp", {})).tabId;
  assert.equal(typeof tabId, "number");
  await attachObserver();

  await test("observer sees known isolated-world refs and a detached element", async () => {
    await read();
    const before = await mainMap();
    assertClean(before, 2);
    entryFor(before, "keep");
    const field = entryFor(before, "field");
    assert.equal(await evaluate("typeof window.__ccmcpRefMap"), "undefined", "MAIN must not substitute for extension state");
    await evaluate("document.getElementById('field').remove(); 'removed'");
    const detached = (await mainMap()).entries.find(entry => entry.ref === field.ref);
    assert.equal(detached?.connected, false, "observer must detect the retained detached element before cleanup");
  });
  await test("read_page bounds detached retention across repeated DOM churn", () => churn(read, read));
  await test("find bounds detached retention across repeated DOM churn", () => churn(() => find("fixture"), () => find("fixture")));
  await test("an empty find still prunes without evicting connected refs", () => churn(read, async () => {
    assert.equal(JSON.parse(await find("   ")).matches, "(no matches)");
  }));
  await test("empty documents release all disconnected refs on either scan route", async () => {
    for (const collect of [read, () => find("absent-marker")]) {
      await fresh();
      await read();
      assertClean(await mainMap(), 2);
      await evaluate("document.body.replaceChildren(); 'empty'");
      await collect();
      assertClean(await mainMap(), 0);
    }
  });
  await test("connected refs survive hidden state, subset scans and DOM moves", async () => {
    await read();
    const before = await mainMap();
    const keep = entryFor(before, "keep").ref;
    const field = entryFor(before, "field").ref;
    await evaluate("(()=>{const k=document.getElementById('keep');k.hidden=true;const f=document.getElementById('field');f.remove();document.getElementById('destination').appendChild(f);return 'moved'})()");
    await read({ maxResults: 1 });
    const after = await mainMap();
    assertClean(after, 2);
    assert.equal(entryFor(after, "keep").ref, keep);
    assert.equal(entryFor(after, "field").ref, field);
    await evaluate("document.getElementById('keep').hidden=false; 'visible'");
    await ok("computer", { tabId, action: "left_click", ref: keep });
    await ok("form_input", { tabId, ref: field, value: "still-valid" });
    assert.equal(await evaluate("document.getElementById('keep').dataset.clicks"), "1");
    assert.equal(await evaluate("document.getElementById('field').value"), "still-valid");
  });
  await test("cloned tags get fresh refs while the original keeps its identity", async () => {
    await read();
    const original = entryFor(await mainMap(), "keep").ref;
    await evaluate("(()=>{const c=document.getElementById('keep').cloneNode(true);c.id='copy';document.body.appendChild(c);return 'cloned'})()");
    await read();
    const map = await mainMap();
    assertClean(map, 3);
    const copy = entryFor(map, "copy").ref;
    assert.notEqual(copy, original);
    assert.equal(entryFor(map, "keep").ref, original);
    await ok("computer", { tabId, action: "left_click", ref: original });
    assert.equal(await evaluate("document.getElementById('keep').dataset.clicks"), "1");
    assert.equal(await evaluate("document.getElementById('copy').dataset.clicks || '0'"), "0");
    await ok("computer", { tabId, action: "left_click", ref: copy });
    assert.equal(await evaluate("document.getElementById('copy').dataset.clicks"), "1");
  });
  await test("navigation invalidates prior refs before a new document can mutate", async () => {
    await read();
    const old = await mainMap();
    const field = entryFor(old, "field").ref;
    const button = entryFor(old, "keep").ref;
    await fresh();
    await read();
    const current = await mainMap();
    assert.notEqual(entryFor(current, "field").ref, field);
    assert.notEqual(entryFor(current, "keep").ref, button);
    await rejected("form_input", { tabId, ref: field, value: "wrong-document" });
    await rejected("computer", { tabId, action: "left_click", ref: button });
    assert.equal(await evaluate("document.getElementById('field').value"), "");
    assert.equal(await evaluate("document.getElementById('keep').dataset.clicks || '0'"), "0");
  });
  await test("duplicate live attributes fail before a scan assigns clone identities", async () => {
    await read();
    const map = await mainMap();
    const button = entryFor(map, "keep").ref;
    const field = entryFor(map, "field").ref;
    await evaluate("(()=>{for(const id of ['keep','field']){const c=document.getElementById(id).cloneNode(true);c.id=id+'-clone';document.body.prepend(c)}return 'cloned'})()");
    await rejected("computer", { tabId, action: "left_click", ref: button });
    await rejected("form_input", { tabId, ref: field, value: "ambiguous" });
    assert.equal(await evaluate("document.getElementById('keep').dataset.clicks || '0'"), "0");
    assert.equal(await evaluate("document.getElementById('keep-clone').dataset.clicks || '0'"), "0");
    assert.equal(await evaluate("document.getElementById('field').value"), "");
    assert.equal(await evaluate("document.getElementById('field-clone').value"), "");
  });
  await test("a sole replacement clone cannot inherit the removed node's ref", async () => {
    await read();
    const map = await mainMap();
    const button = entryFor(map, "keep").ref;
    const field = entryFor(map, "field").ref;
    await evaluate("(()=>{for(const id of ['keep','field']){const old=document.getElementById(id);old.replaceWith(old.cloneNode(true))}return 'replaced'})()");
    await rejected("computer", { tabId, action: "left_click", ref: button });
    await rejected("form_input", { tabId, ref: field, value: "replacement" });
    assert.equal(await evaluate("document.getElementById('keep').dataset.clicks || '0'"), "0");
    assert.equal(await evaluate("document.getElementById('field').value"), "");
  });
  await test("fill_form validates later fields and submit refs before changing a valid field", async () => {
    await read();
    const oldField = entryFor(await mainMap(), "field").ref;
    await fresh(); await read();
    const field = entryFor(await mainMap(), "field").ref;
    await rejected("fill_form", { tabId, fields: [{ ref: field, value: "must-stay-empty" }, { ref: oldField, value: "stale" }] });
    assert.equal(await evaluate("document.getElementById('field').value"), "");
    await rejected("fill_form", { tabId, fields: [{ ref: field, value: "must-stay-empty" }], submitRef: oldField });
    assert.equal(await evaluate("document.getElementById('field').value"), "");
  });
  await test("rediscovery after cleanup allocates a fresh usable ref", async () => {
    await read();
    const before = await mainMap();
    const previous = entryFor(before, "field").ref;
    // This case intentionally retains a page-side node for reinsertion. The
    // assertion measures only the extension map's independent ownership.
    await evaluate("window.savedField=document.getElementById('field');window.savedField.remove(); 'removed'");
    await read();
    assertClean(await mainMap(), 1);
    await evaluate("document.body.appendChild(window.savedField);delete window.savedField; 'reinserted'");
    await read();
    const current = entryFor(await mainMap(), "field").ref;
    assert.notEqual(current, previous, "refs are opaque identities, never numeric values");
    assert.ok((await mainMap()).counter > before.counter, "rediscovery must advance the document counter");
    await ok("form_input", { tabId, ref: current, value: "rediscovered" });
    assert.equal(await evaluate("document.getElementById('field').value"), "rediscovered");
  });
  await test("shadow refs work while connected and release when their host is removed", async () => {
    await evaluate(`(()=>{const h=document.createElement('div');h.id='host';const s=h.attachShadow({mode:'open'});s.innerHTML='<button id=shadow-button onclick="this.dataset.clicked=1">Shadow</button><input id=shadow-field aria-label="shadow field">';document.body.appendChild(h);return 'created'})()`);
    await read();
    const map = await mainMap();
    assertClean(map, 4);
    await ok("computer", { tabId, action: "left_click", ref: entryFor(map, "shadow-button").ref });
    await ok("form_input", { tabId, ref: entryFor(map, "shadow-field").ref, value: "shadow-value" });
    assert.equal(await evaluate("document.getElementById('host').shadowRoot.getElementById('shadow-button').dataset.clicked"), "1");
    assert.equal(await evaluate("document.getElementById('host').shadowRoot.getElementById('shadow-field').value"), "shadow-value");
    await evaluate("document.getElementById('host').remove(); 'removed'");
    await read();
    assertClean(await mainMap(), 2);
  });
  await test("cross-origin frame cleanup preserves main-frame identity and routing", async () => {
    const frameUrl = `http://127.0.0.1:${servers[1].address().port}/frame`;
    await evaluate(`(()=>{const f=document.createElement('iframe');f.id='child';f.onload=()=>window.frameReady=true;f.src=${JSON.stringify(frameUrl)};document.body.appendChild(f);return 'created'})()`);
    await ok("wait_for", { tabId, predicate: "window.frameReady === true", timeoutMs: 3000 });
    const text = await read();
    const frames = await observe();
    assert.equal(frames.length, 2);
    const main = frames.find(frame => frame.frameId === 0).result;
    const child = frames.find(frame => frame.frameId !== 0);
    assertClean(main, 2);
    assertClean(child.result, 2);
    const mainRef = entryFor(main, "field").ref;
    const childRef = `${entryFor(child.result, "field").ref}@${child.frameId}`;
    assert.ok(text.includes(`[${childRef}]`), "MCP must return the observed frame-qualified ref");
    await ok("form_input", { tabId, ref: childRef, value: "frame-value" });
    assert.equal(await evaluate("document.getElementById('field').value"), "");
    const childLine = JSON.parse(await read()).elements.split("\n").find(line => line.includes(`[${childRef}]`));
    assert.match(childLine, /value="frame-value"/, "child-frame write must appear in read_page");
    await evaluate("document.getElementById('child').contentWindow.postMessage('remove-fixture-field','*'); 'requested'");
    let removed = false;
    for (let i = 0; i < 20; i++) {
      const state = (await observe()).find(frame => frame.frameId === child.frameId).result;
      if (state.entries.some(entry => entry.id === "field" && !entry.connected)) { removed = true; break; }
      await sleep(50);
    }
    assert.ok(removed, "fixture child did not remove its field");
    await read();
    const after = await observe();
    assertClean(after.find(frame => frame.frameId === child.frameId).result, 1);
    const mainAfter = after.find(frame => frame.frameId === 0).result;
    assertClean(mainAfter, 2);
    assert.equal(entryFor(mainAfter, "field").ref, mainRef);
  });
  await test("larger fixed DOM churn keeps map size independent of scan history", () => churn(read, read, 128, 5));
} finally {
  try { await cleanup(); }
  finally { stopWatchdog(); }
}
console.log(`\nRef lifecycle: ${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
