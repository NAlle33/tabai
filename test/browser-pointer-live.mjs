// Fresh stdio server -> real extension -> browser-dispatched pointer events.
// CI checks emulated DPR 1/2; default ports retain the real display's own DPR.
import assert from "node:assert/strict";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { watchdog } from "./watchdog.mjs";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [extensionPort = "9223", clientPort = "9225", browserEndpoint] = process.argv.slice(2);
const ccmcpEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("CCMCP_") && typeof value === "string"));
let observer, workerSession, originalFocusPreference, focusPreferenceLoaded = false;
async function worker(expression) {
  const reply = await observer.rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, workerSession);
  assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails));
  return reply.result?.value;
}
const sessions = [];
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  if (req.url === "/frame") return res.end('<button>Frame pointer</button>');
  res.end(`<!doctype html><title>Browser pointer fixture</title><style>
    #trusted{position:fixed;left:50px;top:80px;width:120px;height:45px}
    #native{position:fixed;left:260px;top:85px;width:24px;height:24px}iframe{position:fixed;top:230px}
    </style><button id="trusted">Trusted pointer</button>
    <input id="native" aria-label="Native toggle" type="checkbox"><iframe src="/frame"></iframe>
    <script>window.events=[];window.accepted=0;window.changes=[];window.pointerEvents=[];
    trusted.addEventListener('pointerdown',e=>pointerEvents.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY}));
    for(const type of ['click','dblclick','contextmenu'])trusted.addEventListener(type,e=>{
      events.push({type,trusted:e.isTrusted,detail:e.detail,x:e.clientX,y:e.clientY});
      if(type==='contextmenu')e.preventDefault();if(type==='click'&&e.isTrusted)accepted++;
    });native.addEventListener('change',e=>changes.push(e.isTrusted));</script>`);
});
function text(result) { return (result.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n"); }
const call = (s, name, args = {}) => s.client.callTool({ name, arguments: args });
async function ok(s, name, args = {}) {
  const result = await call(s, name, args); assert.notEqual(result.isError, true, `${name}: ${text(result)}`);
  try { return JSON.parse(text(result)); } catch { return text(result); }
}
async function reject(s, args, pattern) {
  const result = await call(s, "computer", args); assert.equal(result.isError, true, text(result)); assert.match(text(result), pattern);
}
async function connect(name) {
  const session = { client: new Client({ name, version: "1.0.0" }), tabs: [] }; sessions.push(session);
  // The harness's own directories (config, logs, modules) reach the server too,
  // so it never writes into the user's real store.
  await session.client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/server.js")], cwd: root,
    env: { ...ccmcpEnvironment(), CCMCP_PORT: extensionPort, CCMCP_CLIENT_PORT: clientPort } }));
  const context = await ok(session, "tabs_context_mcp", { createIfEmpty: true });
  session.tabs.push(...context.tabs.map(t => t.tabId)); session.keeper = context.tabs[0].tabId;
  session.target = (await ok(session, "tabs_create_mcp")).tabId; session.tabs.push(session.target);
  return session;
}
let cleaned;
function cleanup() { return cleaned ??= (async () => {
  if (focusPreferenceLoaded) await worker(originalFocusPreference === undefined
    ? "chrome.storage.local.remove('allowAgentFocus')"
    : `chrome.storage.local.set({allowAgentFocus:${JSON.stringify(originalFocusPreference)}})`).catch(() => {});
  for (const s of sessions) {
    for (const tabId of s.tabs) await call(s, "tabs_close_mcp", { tabId }).catch(() => {});
    await s.client.close();
  }
  fixture.closeAllConnections(); if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
  observer?.socket.terminate();
})(); }
const stopWatchdog = watchdog(cleanup);
let passes = 0;
async function test(name, run) { await run(); passes++; console.log(`  ✓ ${name}`); }
try {
  // Only the harness's disposable browser grants focus permission for this suite.
  // A real-profile run requires the user's own popup opt-in.
  if (browserEndpoint) {
    assert.equal(new URL(browserEndpoint).hostname, "127.0.0.1");
    observer = await openCdpObserver(browserEndpoint, { timeoutMs: 5000, timeoutMessage: method => `${method} timed out` });
    const target = (await observer.rpc("Target.getTargets")).targetInfos.find(t =>
      t.type === "service_worker" && t.url.startsWith("chrome-extension://") && new URL(t.url).pathname === "/dist/background.js");
    assert.ok(target, "expected the disposable extension worker");
    workerSession = (await observer.rpc("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    originalFocusPreference = (await worker("chrome.storage.local.get('allowAgentFocus')")).allowAgentFocus;
    focusPreferenceLoaded = true;
    await worker("chrome.storage.local.set({allowAgentFocus:true})");
  }
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(9237, "127.0.0.1", resolve); });
  console.log(`browser pointer fixture PID ${process.pid}, port 9237, root ${root}`);
  const a = await connect("pointer-owner"), b = await connect("pointer-other");
  const tabId = a.target;
  const evaluate = source => ok(a, "javascript_tool", { tabId, text: source });
  const navigate = () => ok(a, "navigate", { tabId, url: "http://127.0.0.1:9237", waitUntil: "load" });
  const click = extra => ok(a, "computer", { tabId, action: "left_click", pointerMode: "browser", coordinate: [110, 100], ...extra });
  const active = async () => (await ok(a, "tabs_context_mcp")).tabs.find(t => t.tabId === tabId).active;
  async function assertNativePoint(event) {
    const pointer = (await evaluate("window.pointerEvents")).at(-1);
    assert.equal(pointer.trusted, true);
    assert.ok(Math.abs(pointer.x - 110) < 0.001 && Math.abs(pointer.y - 100) < 0.001,
      `native pointer missed requested CSS point: ${JSON.stringify(pointer)}`);
    // At real fractional browser zoom, 110 can round-trip as 109.999992 in a
    // PointerEvent. Chrome floors legacy click coordinates to 109; use the
    // precise event to check alignment, then verify the click's own conversion.
    assert.deepEqual(event, { type: "click", trusted: true, detail: 1, x: Math.floor(pointer.x), y: Math.floor(pointer.y) });
  }
  const health = await ok(a, "health");
  assert.equal(health.extension.buildId, health.serverBuildId); assert.equal(health.extension.capabilities.browserPointer, 1);
  await navigate();
  console.log(`    initial display DPR: ${await evaluate("devicePixelRatio")}`);
  await test("default coordinate input stays synthetic and in the background", async () => {
    await ok(a, "tab_switch", { tabId: a.keeper });
    await ok(a, "computer", { tabId, action: "left_click", coordinate: [110, 100] });
    assert.equal(await evaluate("window.accepted"), 0);
    assert.equal((await evaluate("window.events"))[0].trusted, false);
    assert.equal(await active(), false);
  });
  await test("browser input refuses background focus without explicit permission", async () => {
    await reject(a, { tabId, action: "left_click", pointerMode: "browser", coordinate: [110, 100] }, /allowFocus:true/);
    assert.equal(await active(), false); assert.equal(await evaluate("window.accepted"), 0);
  });
  let documentId;
  await test("focus opt-in produces one trusted effect with CSS coordinates", async () => {
    const result = await click({ allowFocus: true }); documentId = result.documentId;
    assert.equal(result.via, "browser-pointer"); assert.equal(await active(), true);
    assert.equal(await evaluate("window.accepted"), 1);
    console.log(`    focused display DPR: ${await evaluate("devicePixelRatio")}`);
    const event = (await evaluate("window.events")).at(-1);
    await assertNativePoint(event);
  });
  await test("native checkbox defaults respond once to a ref click", async () => {
    const found = (await ok(a, "find", { tabId, query: "Native toggle" })).matches;
    const ref = found.match(/\[(ref_\d+)\]/)?.[1]; assert.ok(ref, found);
    await ok(a, "computer", { tabId, action: "left_click", pointerMode: "browser", ref });
    assert.deepEqual(await evaluate("({checked:native.checked,changes:window.changes})"), { checked: true, changes: [true] });
  });
  await test("foreign sessions and child frames cannot receive browser clicks", async () => {
    await reject(b, { tabId, action: "left_click", pointerMode: "browser", coordinate: [110, 100], allowFocus: true }, /not in your|tab group/);
    const found = (await ok(a, "find", { tabId, query: "Frame pointer" })).matches;
    const ref = found.match(/\[(ref_\d+@\d+)\]/)?.[1]; assert.ok(ref, found);
    await reject(a, { tabId, action: "left_click", pointerMode: "browser", ref }, /main-frame|child frames/);
    assert.equal(await evaluate("window.accepted"), 1);
  });
  await test("a replaced document fails without clicking its replacement", async () => {
    await navigate();
    await reject(a, { tabId, action: "left_click", pointerMode: "browser", coordinate: [110, 100], documentId, allowFocus: true }, /document|frame/i);
    assert.equal(await evaluate("window.accepted"), 0);
  });
  const scales = extensionPort === "9224" ? [1, 2] : [null];
  for (const scale of scales) await test(`trusted coordinate clicks retain CSS alignment at DPR ${scale ?? "of this display"}`, async () => {
    if (scale) await ok(a, "emulate_device", { tabId, width: 800, height: 600, deviceScaleFactor: scale });
    await navigate();
    if (scale) assert.equal(await evaluate("devicePixelRatio"), scale);
    await click({ allowFocus: true });
    assert.equal(await evaluate("window.accepted"), 1);
    await assertNativePoint((await evaluate("window.events"))[0]);
  });
  await test("double, triple and right clicks use native click counts", async () => {
    for (const [action, details] of [["double_click", [1, 2]], ["triple_click", [1, 2, 3]], ["right_click", []]]) {
      await evaluate("window.events=[];window.accepted=0");
      await click({ action });
      const events = await evaluate("window.events");
      assert.deepEqual(events.filter(e => e.type === "click").map(e => e.detail), details);
      assert(events.every(e => e.trusted));
      if (action === "double_click") assert.equal(events.filter(e => e.type === "dblclick").length, 1);
      if (action === "right_click") assert.equal(events.filter(e => e.type === "contextmenu").length, 1);
    }
  });
} finally { await cleanup(); stopWatchdog(); }
console.log(`\n=== browser-pointer-live: ${passes} passed ===`);
