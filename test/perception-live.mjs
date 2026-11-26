import { createMcpClient, createMcpTransport, connectMcpClient, callRaw, textContent } from "./helpers/mcp-client.mjs";
// Real-extension perception checks. Run through test:ci with the fresh bundle.
// The injected entry point runs via Chrome's serialized executeScript route;
// imports/closures in any branch therefore fail these browser tests directly.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env as runtimeEnvironment } from "node:process";


import { watchdog } from "./watchdog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = process.argv[2]; // optional fixture-only PNG output directory
const clients = [0, 1].map(index => createMcpClient({ name: `perception-live-${index}`, version: "0.0.0" }));
const tabs = new Set();
const otherSessionTabs = new Set();
let origin;
let frameOrigin;
let tabId;
let caseId = 0;
const fixture = () => `<!doctype html><meta charset="utf-8"><title>Perception fixture</title>
<style>body{margin:20px;font:16px Arial;background:white}button,input{margin:8px;padding:8px}table{border-collapse:collapse}td,th{border:1px solid;padding:4px}iframe{width:300px;height:150px}#long{height:1200px}</style>
<nav><a href="#main">Skip to main</a></nav><main id="main"><h1>Useful heading</h1><p id="message">Original message</p>
<button id="unique" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Unique action</button>
<button class="duplicate">Repeated</button><button class="duplicate">Repeated</button>
<input id="normal" aria-label="Normal field" value="ordinary-value"><input id="password" aria-label="Password" type="password" value="never-print-secret">
<input id="otp" aria-label="Code" autocomplete="section-login one-time-code" value="never-print-otp">
<textarea id="cvv" aria-label="Security code">never-print-cvv</textarea>
<div id="shadow-host"></div><table id="data"><thead><tr><th>Name</th><th colspan="2">Amounts</th></tr></thead><tbody>
<tr><td rowspan="2">Shared</td><td>A</td><td>B</td></tr><tr><td colspan="2">Wide</td></tr></tbody></table>
<iframe id="child" src="${frameOrigin}/frame"></iframe><div id="long"></div>
<button id="bottom" onclick="this.dataset.clicked='yes'">Bottom action</button></main>
<script>const host=document.querySelector('#shadow-host');host.attachShadow({mode:'open'}).innerHTML='<button id="shadow-action">Shadow action</button><input aria-label="Shadow field">';</script>`;
const servers = [http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }); res.end(fixture());
}), http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><button id="frame-button">${req.url.includes("replacement") ? "Replacement frame" : "Frame action"}</button><button>Repeated</button><input aria-label="Frame field"><script>addEventListener('message',event=>{if(event.data==='duplicate-main-name')document.querySelector('#frame-button').textContent='Unique action'})</script>`);
})];
async function call(name, args = {}, client = clients[0]) { return callRaw(client, { name, arguments: args }); }
async function ok(name, args = {}, client = clients[0]) {
  const result = await call(name, args, client);
  assert.notEqual(result.isError, true, textContent(result));
  return result;
}
async function json(name, args = {}, client = clients[0]) {
  const result = await ok(name, args, client);
  return result.structuredContent || JSON.parse(textContent(result));
}
async function evaluate(text) { return textContent(await ok("javascript_tool", { tabId, text })); }
async function fresh() {
  await ok("navigate", { tabId, url: `${origin}/fixture?case=${++caseId}`, waitUntil: "load" });
  await ok("wait_for", { tabId, selector: "#unique", timeoutMs: 3000 });
}
async function rejected(name, args, pattern, client = clients[0]) {
  const result = await call(name, args, client);
  assert.equal(result.isError, true, `Expected ${name} refusal: ${textContent(result)}`);
  assert.match(textContent(result), pattern);
}
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const id of tabs) await call("tabs_close_mcp", { tabId: id }).catch(() => {});
    for (const id of otherSessionTabs) await call("tabs_close_mcp", { tabId: id }, clients[1]).catch(() => {});
    for (const client of clients) await client.close().catch(() => {});
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  })();
}
const stopWatchdog = watchdog(cleanup);
let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await fresh(); await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error.stack || error.message}`); }
}

try {
  for (const server of servers) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${servers[0].address().port}`;
  frameOrigin = `http://127.0.0.1:${servers[1].address().port}`;
  for (const client of clients) await connectMcpClient(client, createMcpTransport({
    command: process.execPath, args: [join(root, "dist/server.js")], cwd: root,
    env: Object.fromEntries(Object.entries(runtimeEnvironment).filter(([key, value]) => key.startsWith("CCMCP_") && typeof value === "string")),
  }));
  tabId = (await json("tabs_create_mcp")).tabId;
  tabs.add(tabId);
  // The second session owns a group of its own, so a refusal below can only come
  // from the tab belonging to another session, not from having no group at all.
  otherSessionTabs.add((await json("tabs_create_mcp", {}, clients[1])).tabId);

  await test("unique CSS and semantic targets keep refs compatible with real actions", async () => {
    const target = await json("resolve_target", { tabId, target: { selector: "#unique" } });
    assert.equal(target.frameId, 0);
    assert.equal(typeof target.documentId, "string");
    const semantic = await json("resolve_target", { tabId, target: { role: "button", name: "Unique action" } });
    assert.equal(semantic.ref, target.ref);
    await ok("computer", { tabId, action: "left_click", ref: target.ref });
    assert.equal(await evaluate("document.querySelector('#unique').dataset.clicks"), "1");
    const field = await json("resolve_target", { tabId, target: { selector: "#normal" } });
    await ok("form_input", { tabId, ref: field.ref, value: "written via resolved ref" });
    assert.equal(await evaluate("document.querySelector('#normal').value"), "written via resolved ref");
  });
  await test("ambiguity counts main, open shadow, and cross-origin frames without choosing", async () => {
    await rejected("resolve_target", { tabId, target: { selector: ".duplicate" } }, /ambiguous/);
    await rejected("resolve_target", { tabId, target: { role: "button", name: "Repeated" } }, /ambiguous/);
    await evaluate("document.querySelector('#shadow-host').shadowRoot.querySelector('button').textContent='Unique action'");
    await rejected("resolve_target", { tabId, target: { role: "button", name: "Unique action" } }, /ambiguous/);
    await evaluate("document.querySelector('#shadow-host').shadowRoot.querySelector('button').textContent='Shadow action';document.querySelector('#child').contentWindow.postMessage('duplicate-main-name','*')");
    await ok("wait_for", { tabId, predicate: "true", timeoutMs: 1000 });
    await rejected("resolve_target", { tabId, target: { role: "button", name: "Unique action" } }, /ambiguous/);
    assert.equal((await json("resolve_target", { tabId, target: { selector: "#unique", frameId: 0 } })).frameId, 0);
  });
  await test("open-shadow and explicit child-frame targets resolve to usable refs", async () => {
    const shadow = await json("resolve_target", { tabId, target: { role: "textbox", name: "Shadow field" } });
    await ok("form_input", { tabId, ref: shadow.ref, value: "shadow-written" });
    assert.equal(await evaluate("document.querySelector('#shadow-host').shadowRoot.querySelector('input').value"), "shadow-written");
    const frame = await json("resolve_target", { tabId, target: { role: "textbox", name: "Frame field" } });
    assert.ok(frame.frameId > 0);
    assert.match(frame.ref, /@\d+$/);
    const explicit = await json("resolve_target", { tabId, target: { role: "textbox", name: "Frame field", frameId: frame.frameId } });
    assert.equal(explicit.ref, frame.ref);
    await ok("form_input", { tabId, ref: frame.ref, value: "frame-written" });
    const read = await json("read_page", { tabId, compact: true, frameId: frame.frameId });
    assert.match(read.elements, /frame-written/);
  });
  await test("native headers, rowspans, and colspans expand into rectangular data", async () => {
    const table = await json("extract_table", { tabId });
    assert.deepEqual(table.columns, ["Name", "Amounts", "Amounts"]);
    assert.deepEqual(table.rows, [["Shared", "A", "B"], ["Shared", "Wide", "Wide"]]);
    assert.equal(table.truncated, false);
    const limited = await json("extract_table", { tabId, maxRows: 1, maxColumns: 2 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.columns, ["Name", "Amounts"]);
    assert.deepEqual(limited.rows, [["Shared", "A"]]);
  });
  await test("ARIA grids and nested native tables have explicit ownership", async () => {
    await evaluate(`document.querySelector('#data').insertAdjacentHTML('afterend','<div role="grid" id="grid"><div role="row"><span role="columnheader">Left</span><span role="columnheader">Right</span></div><div role="row"><span role="gridcell" aria-colspan="2">Spanned</span></div></div>')`);
    await rejected("extract_table", { tabId }, /ambiguous/);
    const grid = await json("extract_table", { tabId, selector: "#grid" });
    assert.deepEqual(grid.columns, ["Left", "Right"]);
    assert.deepEqual(grid.rows, [["Spanned", "Spanned"]]);
    await evaluate(`(()=>{const row=document.querySelector('#grid [role="row"]:last-child');row.replaceChildren();const host=document.createElement('div');row.appendChild(host);host.attachShadow({mode:'open'}).innerHTML='<span role="gridcell" aria-colspan="2">Shadow cell</span>'})()`);
    const shadowGrid = await json("extract_table", { tabId, selector: "#grid" });
    assert.deepEqual(shadowGrid.rows, [["Shadow cell", "Shadow cell"]]);
    await evaluate(`document.querySelector('#data tbody td:nth-child(2)').innerHTML='Outer<table id="nested"><tr><td>Nested-only</td></tr></table>'`);
    const outer = await json("extract_table", { tabId, selector: "#data" });
    assert.equal(outer.rows.length, 2);
    assert.equal(outer.rows[0][1], "Outer");
    assert.equal(JSON.stringify(outer.rows).includes("Nested-only"), false);
  });
  await test("oversized spans are bounded and report truncation", async () => {
    await evaluate(`document.querySelector('#data').innerHTML='<tr><td rowspan="999999" colspan="999999">Oversized</td></tr>'`);
    const table = await json("extract_table", { tabId, maxRows: 3, maxColumns: 4 });
    assert.equal(table.truncated, true);
    assert.ok(table.rows.length <= 3 && table.rows.every(row => row.length <= 4));
  });
  await test("compact reads prioritize useful content, retain refs, mask secrets and bound output", async () => {
    await evaluate(`document.querySelector('#normal').setAttribute('aria-labelledby','cvv');document.querySelector('#normal').removeAttribute('aria-label');document.querySelector('#cvv').removeAttribute('aria-label')`);
    const read = await json("read_page", { tabId, compact: true, filter: "all" });
    assert.equal(read.compact, true);
    assert.match(read.elements, /Useful heading|Original message/);
    assert.match(read.elements, /ordinary-value/);
    assert.doesNotMatch(read.elements, /never-print-/);
    assert.match(read.elements, /•••/);
    assert.match(read.elements, /ref_\d+@\d+/);
    const limited = await json("read_page", { tabId, compact: true, filter: "all", maxResults: 2, maxChars: 100 });
    assert.equal(limited.truncated, true);
    assert.ok(limited.count <= 2 && limited.elements.length <= 100);
  });
  await test("full reads and find mask the same secret fields as compact reads", async () => {
    const found = await json("find", { tabId, query: "Code Password Security Normal" });
    assert.match(found.matches, /"Security code"/);
    assert.match(found.matches, /ordinary-value/);
    assert.doesNotMatch(found.matches, /never-print-/);
    // Without a label the secret textarea must not be named after its own text either.
    await evaluate(`document.querySelector('#cvv').removeAttribute('aria-label')`);
    const read = await json("read_page", { tabId, filter: "all" });
    assert.match(read.elements, /ordinary-value/);
    assert.ok((read.elements.match(/•••/g) ?? []).length >= 3, read.elements);
    assert.doesNotMatch(read.elements, /never-print-/);
  });
  await test("diff records changed, added and removed refs with masked values", async () => {
    const baseline = await json("read_page_diff", { tabId, reset: true });
    assert.equal(baseline.baseline, true);
    assert.doesNotMatch(JSON.stringify(baseline), /never-print-/);
    const prior = baseline.added.find(node => node.name === "Unique action");
    assert.ok(prior);
    await evaluate("document.querySelector('#unique').textContent='Changed action';document.querySelector('#message').remove();document.querySelector('main').insertAdjacentHTML('afterbegin','<button>Added action</button>')");
    const diff = await json("read_page_diff", { tabId });
    assert.equal(diff.baseline, false);
    assert.ok(diff.changed.some(change => change.before.ref === prior.ref && change.after.name === "Changed action"));
    assert.ok(diff.added.some(node => node.name === "Added action"));
    assert.ok(diff.removed.some(node => node.name === "Original message"));
    const stable = await json("read_page_diff", { tabId });
    assert.deepEqual(stable.counts, { added: 0, changed: 0, removed: 0 });
  });
  await test("diff resets on main navigation and child-frame-only document replacement", async () => {
    await json("read_page_diff", { tabId, reset: true });
    await fresh();
    const main = await json("read_page_diff", { tabId });
    assert.equal(main.resetReason, "documents_changed");
    const mainDocument = main.frames.find(frame => frame.frameId === 0).documentId;
    await evaluate(`document.querySelector('#child').src=${JSON.stringify(frameOrigin + "/replacement")}`);
    let child;
    for (let i = 0; i < 20; i++) {
      const result = await call("resolve_target", { tabId, target: { role: "button", name: "Replacement frame" } });
      if (!result.isError) { child = JSON.parse(textContent(result)); break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(child, "replacement frame did not load");
    const replaced = await json("read_page_diff", { tabId });
    assert.equal(replaced.resetReason, "documents_changed");
    assert.equal(replaced.frames.find(frame => frame.frameId === 0).documentId, mainDocument);
    assert.deepEqual(replaced.removed, []);
  });
  await test("concurrent diffs cannot overwrite the newest committed snapshot", async () => {
    await json("read_page_diff", { tabId, reset: true });
    await evaluate("document.querySelector('#unique').textContent='Concurrent update'");
    const calls = await Promise.all([json("read_page_diff", { tabId }), json("read_page_diff", { tabId })]);
    assert.ok(calls.some(result => result.ok && result.changed.some(change => change.after.name === "Concurrent update")));
    assert.ok(calls.every(result => result.ok || result.superseded));
    const after = await json("read_page_diff", { tabId });
    assert.deepEqual(after.counts, { added: 0, changed: 0, removed: 0 });
  });
  await test("all perception routes refuse a tab owned by another session", async () => {
    const ownContext = await json("tabs_context_mcp", {}, clients[1]);
    assert.ok(ownContext.tabs.length > 0 && ownContext.tabs.every(tab => otherSessionTabs.has(tab.tabId) && tab.tabId !== tabId),
      `the second session must list only its own tabs: ${JSON.stringify(ownContext.tabs)}`);
    const foreign = new RegExp(`^TAB_NOT_IN_GROUP: Tab ${tabId} is not in your session's MCP tab group`);
    for (const [name, extra] of [["resolve_target", { target: { selector: "#unique" } }], ["extract_table", {}],
      ["read_page", { compact: true }], ["read_page_diff", {}], ["screenshot_marked", {}]]) {
      await rejected(name, { tabId, ...extra }, foreign, clients[1]);
    }
  });
  await test("numbered screenshots refuse target layout drift during capture", async () => {
    // A real page MutationObserver reacts to initial ref tagging. It changes
    // layout after the injected snapshot but before capture, deterministically.
    await evaluate(`(()=>{const target=document.querySelector('#unique');const observer=new MutationObserver(()=>{target.style.transform='translateX(40px)';observer.disconnect()});observer.observe(target,{attributes:true,attributeFilter:['data-ccmcp-ref']});return 'armed'})()`);
    await rejected("screenshot_marked", { tabId, maxTargets: 20 }, /layout changed|viewport changed/i);
    assert.equal(await evaluate("document.querySelector('#unique').style.transform"), "translateX(40px)");
  });
  for (const dpr of [1, 2]) await test(`numbered PNG pixels and ref clicks agree at DPR ${dpr} after scrolling`, async () => {
    await ok("emulate_device", { tabId, width: 800, height: 600, deviceScaleFactor: dpr });
    try {
      await evaluate("document.querySelector('#bottom').scrollIntoView({block:'center'}); 'scrolled'");
      const response = await ok("screenshot_marked", { tabId, maxTargets: 20 });
      const image = response.content.find(item => item.type === "image");
      assert.equal(image?.mimeType, "image/png");
      const metadata = response.structuredContent || JSON.parse(textContent(response));
      const png = Buffer.from(image.data, "base64");
      assert.equal(png.readUInt32BE(16), metadata.width);
      assert.equal(png.readUInt32BE(20), metadata.height);
      assert.equal(metadata.viewport.width, 800, "emulation must use the requested CSS viewport width");
      assert.equal(metadata.viewport.height, 600);
      assert.equal(metadata.width, Math.round(metadata.viewport.visualWidth));
      assert.equal(metadata.height, Math.round(metadata.viewport.visualHeight));
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(artifactDir, `perception-marked-dpr-${dpr}.png`), png);
      }
      assert.equal(metadata.coverage.scope, "main-frame");
      assert.ok(metadata.coverage.excludedFrameCount >= 1);
      assert.ok(metadata.coverage.iframeElementCount >= 1);
      assert.ok(metadata.targets.every(target => !target.ref.includes("@")));
      const bottom = metadata.targets.find(target => target.name === "Bottom action");
      assert.ok(bottom, "visible bottom action was not marked");
      const sample = await evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify("data:image/png;base64," + image.data)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const r=${JSON.stringify(bottom.labelRect)};const pixels=ctx.getImageData(r.x,r.y,r.width,r.height).data;let red=0,white=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]>180&&pixels[i+1]<80&&pixels[i+2]<130)red++;if(pixels[i]>245&&pixels[i+1]>245&&pixels[i+2]>245)white++}return{red,white}})()`);
      const colors = JSON.parse(sample);
      assert.ok(colors.red > 100 && colors.white > 5, `label lacks colored background and white numeral pixels: ${sample}`);
      await ok("computer", { tabId, action: "left_click", ref: bottom.ref });
      assert.equal(await evaluate("document.querySelector('#bottom').dataset.clicked"), "yes");
      assert.equal(await evaluate("document.querySelectorAll('[data-ccmcp-overlay]').length"), "0");
    } finally { await ok("emulate_device", { tabId, reset: true }); }
  });
} finally {
  try { await cleanup(); } finally { stopWatchdog(); }
}
console.log(`\nPerception: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
