import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
// Native keyboard defaults, background tabs and simultaneous MCP sessions.
// A real HTTP form ensures a successful key response alone cannot pass a test.
import assert from "node:assert/strict";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


import { watchdog } from "./watchdog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [extensionPort = "9223", clientPort = "9225"] = process.argv.slice(2);
const ccmcpEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("CCMCP_") && typeof value === "string"));
const sessions = [];
const submissions = new Map();
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/submitted") {
    const value = url.searchParams.get("q");
    submissions.set(value, (submissions.get(value) ?? 0) + 1);
    res.end("<!doctype html><title>Submitted</title><h1>Form submitted</h1>");
    return;
  }
  if (url.pathname === "/frames") {
    res.end(`<!doctype html><title>Frame typing</title><label>First named field <input id="first"></label>
      <label>Second named field <input id="second"></label><iframe src="/frame-field" style="width:320px;height:80px"></iframe>`);
    return;
  }
  if (url.pathname === "/frame-field") {
    res.end('<!doctype html><title>Frame field</title><label>Frame typing field <input id="inner"></label>');
    return;
  }
  // Controls that cannot take input, in the main frame (trusted path) and in a
  // sub-frame (synthetic path). A submission names its frame in `q`.
  const lockedForm = where => `<form action="/submitted"><input type="hidden" name="q" value="locked-${where}-enter">
    <label>Disabled ${where} field <input id="disabled" value="disabled-${where}" disabled></label>
    <label>Read-only ${where} field <input id="readonly" value="readonly-${where}" readonly></label>
    <label>Open ${where} field <input id="open"></label></form>`;
  if (url.pathname === "/locked") {
    res.end(`<!doctype html><title>Locked fields</title>${lockedForm("main")}<iframe src="/locked-frame" title="Locked frame host" style="width:420px;height:160px"></iframe>`);
    return;
  }
  if (url.pathname === "/locked-frame") {
    res.end(`<!doctype html><title>Locked frame</title>${lockedForm("frame")}`);
    return;
  }
  res.end(`<!doctype html><title>Keyboard regression</title>
    <form action="/submitted"><label>Keyboard query <input name="q"></label>
    <button>Submit query</button></form>
    <script>
      sessionStorage.removeItem('keyboard-submit');
      const events = [];
      window.keyboardDebug = [];
      for (const type of ['keydown','keypress','keyup','focusin','focusout']) document.addEventListener(type, e => window.keyboardDebug.push({type,key:e.key,code:e.code,keyCode:e.keyCode,target:e.target?.name,focus:document.hasFocus(),trusted:e.isTrusted}),true);
      document.addEventListener('keydown', e => events.push({key:e.key, trusted:e.isTrusted}));
      document.querySelector('form').addEventListener('submit', e => {
        sessionStorage.setItem('keyboard-submit', JSON.stringify({trusted:e.isTrusted, events}));
      });
    </script>`);
});

async function call(session, name, args = {}) {
  const result = await callRaw(session.client, { name, arguments: args });
  return { error: result.isError === true, text: result.content?.[0]?.text ?? "" };
}
async function ok(session, name, args = {}) {
  const result = await call(session, name, args);
  assert.equal(result.error, false, `${name}: ${result.text}`);
  return result.text;
}
async function connect(name) {
  const session = { client: createMcpClient({ name, version: "0.0.0" }), tabs: new Set() };
  sessions.push(session);
  await connectMcpClient(session.client, createMcpTransport({
    command: process.execPath,
    args: [join(root, "dist/server.js")],
    cwd: root,
    // The harness's own directories (config, logs, modules) reach the server too,
    // so it never writes into the user's real store.
    env: { ...ccmcpEnvironment(), CCMCP_PORT: extensionPort, CCMCP_CLIENT_PORT: clientPort },
  }));
  const context = JSON.parse(await ok(session, "tabs_context_mcp", { createIfEmpty: true }));
  for (const tab of context.tabs) session.tabs.add(tab.tabId);
  session.keeper = context.tabs[0].tabId;
  session.target = JSON.parse(await ok(session, "tabs_create_mcp")).tabId;
  session.tabs.add(session.target);
  return session;
}
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const session of sessions) {
      for (const tabId of session.tabs) await call(session, "tabs_close_mcp", { tabId }).catch(() => {});
      await session.client.close();
    }
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
  })();
}
const stopWatchdog = watchdog(cleanup);
let passes = 0;
let failures = 0;
async function test(name, run) {
  try {
    await run();
    passes++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

try {
  // A fixed fixture port fails clearly on collision; never spawn a duplicate.
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(9231, "127.0.0.1", resolve);
  });
  console.log(`keyboard fixture PID ${process.pid}, port 9231, root ${root}`);
  const origin = "http://127.0.0.1:9231";
  const A = await connect("keyboard-A");
  const B = await connect("keyboard-B");
  const evaluate = (session, text) => ok(session, "javascript_tool", { tabId: session.target, text });
  async function prepare(session, value, active = false) {
    const tabId = session.target;
    await ok(session, "navigate", { tabId, url: origin, waitUntil: "load" });
    await ok(session, "tab_switch", { tabId: active ? tabId : session.keeper });
    const found = JSON.parse(await ok(session, "find", { tabId, query: "Keyboard query" })).matches;
    const ref = found.match(/\[(ref_\d+)\] (?:textbox|input) "Keyboard query"/)?.[1];
    assert.ok(ref, found);
    await ok(session, "form_input", { tabId, ref, value });
    await ok(session, "computer", { tabId, ref, action: "left_click" });
  }
  async function assertActive(session, active) {
    const context = JSON.parse(await ok(session, "tabs_context_mcp"));
    assert.equal(context.tabs.find(tab => tab.tabId === session.target)?.active, active);
  }
  async function enterAndVerify(session, value, active = false) {
    const tabId = session.target;
    const input = JSON.parse(await ok(session, "computer", { tabId, action: "key", text: "Enter" }));
    assert.equal(input.via, "cdp", "native defaults must use the trusted CDP route");
    try {
      await ok(session, "wait_for", { tabId, predicate: "location.pathname === '/submitted'", timeoutMs: 2500 });
    } catch (error) {
      console.error("    failed Enter evidence:", await evaluate(session, "({path:location.pathname,active:document.activeElement?.outerHTML,focus:document.hasFocus(),hidden:document.hidden,events:window.keyboardDebug,submitted:sessionStorage.getItem('keyboard-submit')})"));
      throw error;
    }
    const result = JSON.parse(await evaluate(session,
      "({query:new URL(location.href).searchParams.get('q'), submit:JSON.parse(sessionStorage.getItem('keyboard-submit'))})"));
    assert.equal(result.query, value);
    assert.equal(result.submit.trusted, true);
    assert.equal(result.submit.events.filter(event => event.key === "Enter" && event.trusted).length, 1);
    assert.equal(submissions.get(value), 1, "native form submitted exactly once");
    await assertActive(session, active);
  }
  await test("active Enter submits a native form exactly once", async () => {
    await prepare(A, "active-enter", true);
    await enterAndVerify(A, "active-enter", true);
  });
  await test("inactive Enter submits without activating the tab", async () => {
    await prepare(A, "inactive-enter");
    await assertActive(A, false);
    console.log("    page focus:", await evaluate(A, "({hidden:document.hidden,focus:document.hasFocus(),userAgent:navigator.userAgent})"));
    await enterAndVerify(A, "inactive-enter");
  });
  await test("inactive type inserts text and Enter submits the result", async () => {
    await prepare(A, "");
    const typed = JSON.parse(await ok(A, "computer", { tabId: A.target, action: "type", text: "inactive-type" }));
    assert.equal(typed.via, "cdp");
    assert.equal(await evaluate(A, "document.querySelector('input').value"), "inactive-type");
    await enterAndVerify(A, "inactive-type");
  });
  await test("invalid key sequence dispatches no leading Enter", async () => {
    await prepare(A, "invalid-key");
    const result = await call(A, "computer", { tabId: A.target, action: "key", text: "Enter F13" });
    assert.ok(result.error && /unknown key name/.test(result.text), result.text);
    assert.equal(await evaluate(A, "location.pathname"), "/");
    assert.equal(submissions.get("invalid-key"), undefined);
  });
  async function frameFields(session) {
    const tabId = session.target;
    await ok(session, "navigate", { tabId, url: `${origin}/frames`, waitUntil: "load" });
    const listing = JSON.parse(await ok(session, "read_page", { tabId })).elements;
    const refOf = label => listing.match(new RegExp(`\\[(ref_\\d+(?:@\\d+)?)\\] textbox "${label}"`))?.[1];
    const fields = { first: refOf("First named field"), second: refOf("Second named field"), inner: refOf("Frame typing field") };
    assert.ok(fields.first && fields.second && /@\d+$/.test(fields.inner ?? ""), listing);
    return fields;
  }
  const frameDocument = "document.querySelector('iframe').contentDocument";
  await test("type without a ref while focus is inside a frame names the frame-ref route, which then works", async () => {
    const { inner } = await frameFields(A);
    await ok(A, "computer", { tabId: A.target, action: "left_click", ref: inner });
    const refused = await call(A, "computer", { tabId: A.target, action: "type", text: "no-ref" });
    const focus = JSON.parse(await evaluate(A, `(()=>{const d=${frameDocument};const state={top:document.activeElement.tagName,inner:d.activeElement.id,value:d.getElementById('inner').value};d.activeElement.blur();return JSON.stringify(state)})()`));
    assert.deepEqual(focus, { top: "IFRAME", inner: "inner", value: "" }, "fixture: focus is in the frame field and nothing was typed");
    assert.ok(refused.error && /inside a frame/i.test(refused.text) && /ref_N@frameId/.test(refused.text), refused.text);
    // The field's own frame ref focuses and types even after focus left it.
    await ok(A, "computer", { tabId: A.target, action: "type", ref: inner, text: "via-frame-ref" });
    assert.equal(await evaluate(A, `${frameDocument}.getElementById('inner').value`), "via-frame-ref");
  });
  await test("type and key with a main-frame ref act on the named field while another has focus", async () => {
    const { first, second } = await frameFields(A);
    await ok(A, "computer", { tabId: A.target, action: "left_click", ref: first });
    await ok(A, "computer", { tabId: A.target, action: "type", ref: second, text: "into-second" });
    await ok(A, "computer", { tabId: A.target, action: "key", ref: first, text: "z" });
    const values = JSON.parse(await evaluate(A, "JSON.stringify({first:document.getElementById('first').value,second:document.getElementById('second').value})"));
    assert.deepEqual(values, { first: "z", second: "into-second" });
  });
  async function lockedFields(session) {
    const tabId = session.target;
    await ok(session, "navigate", { tabId, url: `${origin}/locked`, waitUntil: "load" });
    const listing = JSON.parse(await ok(session, "read_page", { tabId, filter: "all" })).elements;
    const refOf = (role, label) => listing.match(new RegExp(`\\[(ref_\\d+(?:@\\d+)?)\\] ${role} "${label}"`))?.[1];
    const refs = {};
    for (const where of ["main", "frame"]) {
      refs[where] = { disabled: refOf("textbox", `Disabled ${where} field`), readonly: refOf("textbox", `Read-only ${where} field`), open: refOf("textbox", `Open ${where} field`) };
    }
    refs.host = refOf("iframe", "Locked frame host");
    assert.ok(Object.values(refs.main).every(ref => /^ref_\d+$/.test(ref ?? "")) && Object.values(refs.frame).every(ref => /@\d+$/.test(ref ?? "")) && /^ref_\d+$/.test(refs.host ?? ""), listing);
    return refs;
  }
  const lockedState = session => evaluate(session, `JSON.stringify(Object.fromEntries([['main',document],['frame',document.querySelector('iframe').contentDocument]].map(([where,d])=>[where,{path:d.location.pathname,disabled:d.getElementById('disabled')?.value,readonly:d.getElementById('readonly')?.value,open:d.getElementById('open')?.value}])))`);
  await test("type with a ref to a disabled or read-only field is refused and the value is unchanged, in the main frame and in a frame", async () => {
    const refs = await lockedFields(A);
    const outcomes = {};
    for (const where of ["main", "frame"]) {
      for (const field of ["disabled", "readonly"]) {
        const result = await call(A, "computer", { tabId: A.target, action: "type", ref: refs[where][field], text: "-typed" });
        outcomes[`${where} ${field}`] = result.error ? "refused" : `typed: ${result.text.slice(0, 80)}`;
      }
    }
    const state = JSON.parse(await lockedState(A));
    assert.deepEqual(outcomes, { "main disabled": "refused", "main readonly": "refused", "frame disabled": "refused", "frame readonly": "refused" });
    assert.deepEqual(state, {
      main: { path: "/locked", disabled: "disabled-main", readonly: "readonly-main", open: "" },
      frame: { path: "/locked-frame", disabled: "disabled-frame", readonly: "readonly-frame", open: "" },
    });
  });
  await test("key Enter with a ref to a disabled field submits nothing, in the main frame and in a frame", async () => {
    const refs = await lockedFields(A);
    const outcomes = {};
    for (const where of ["main", "frame"]) {
      const result = await call(A, "computer", { tabId: A.target, action: "key", ref: refs[where].disabled, text: "Enter" });
      outcomes[where] = result.error ? "refused" : `pressed: ${result.text.slice(0, 80)}`;
    }
    // A submission would navigate within this wait; nothing may arrive.
    await new Promise(resolve => setTimeout(resolve, 750));
    const state = JSON.parse(await lockedState(A));
    assert.deepEqual(outcomes, { main: "refused", frame: "refused" });
    assert.deepEqual([state.main.path, state.frame.path], ["/locked", "/locked-frame"]);
    assert.deepEqual([submissions.get("locked-main-enter"), submissions.get("locked-frame-enter")], [undefined, undefined]);
  });
  await test("type and key with a ref to a frame element are refused, name the field's own frame ref, and reach nothing inside the frame", async () => {
    const refs = await lockedFields(A);
    // Focus rests inside the frame, on its open field.
    await ok(A, "computer", { tabId: A.target, action: "left_click", ref: refs.frame.open });
    const results = [];
    for (const args of [{ action: "type", text: "via-host" }, { action: "key", text: "z" }]) results.push(await call(A, "computer", { tabId: A.target, ref: refs.host, ...args }));
    const state = JSON.parse(await lockedState(A));
    for (const result of results) assert.ok(result.error && /frame/i.test(result.text) && /ref_N@frameId/.test(result.text), result.text);
    assert.equal(state.frame.open, "", "nothing was typed into the field focused inside the frame");
  });
  await test("two sessions submit their own inactive tabs concurrently without focus stealing", async () => {
    for (let round = 0; round < 3; round++) {
      const values = [`session-a-${round}`, `session-b-${round}`];
      await prepare(A, values[0]);
      await prepare(B, values[1]);
      await Promise.all([enterAndVerify(A, values[0]), enterAndVerify(B, values[1])]);
    }
  });
  await test("another session cannot type or press Enter in the owner's tab", async () => {
    await prepare(A, "cross-session");
    for (const args of [{ action: "type", text: "intrusion" }, { action: "key", text: "Enter" }]) {
      const result = await call(B, "computer", { tabId: A.target, ...args });
      assert.ok(result.error && /not in your|tab group/i.test(result.text), result.text);
    }
    assert.equal(await evaluate(A, "document.querySelector('input').value"), "cross-session");
    assert.equal(submissions.get("cross-session"), undefined);
    await enterAndVerify(A, "cross-session");
  });
} finally {
  await cleanup();
  stopWatchdog();
}
console.log(`\n=== keyboard-live: ${passes} passed, ${failures} failed ===`);
process.exitCode = failures ? 1 : 0;
