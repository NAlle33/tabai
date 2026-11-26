import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
// Document-bound actions and typed observations in a real extension. No browser
// mocks: the fixture counters prove whether a refused action actually mutated.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { env as runtimeEnvironment } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


import { watchdog } from "./watchdog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = mkdtempSync(join(tmpdir(), "tabai-workflow-live-"));
// A real old-format store proves migration compatibility through the SDK.
writeFileSync(join(configDir, "recipes.json"), JSON.stringify({
  "legacy-read": [{ tool: "get_page_text", args: {} }],
}), { mode: 0o600 });
const uploadFixture = join(configDir, "upload-fixture.txt");
writeFileSync(uploadFixture, "Synthetic upload fixture", { mode: 0o600 });
const sessions = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = 9232;
const origin = `http://127.0.0.1:${port}`;
const frameOrigin = `http://localhost:${port}`;
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/frame") {
    res.end(`<!doctype html><title>Frame fields</title>
      <label>Frame field <input id="frame-field" value="${url.searchParams.has("ready") ? "arrived" : "before"}"></label>
      <button id="frame-button" onclick="document.querySelector('#frame-count').textContent=++window.frameCount">Frame button</button>
      <output id="frame-count">0</output><script>window.frameCount=0</script>`);
    return;
  }
  res.end(`<!doctype html><title>Workflow fields</title>
    <label>Workflow field <input id="value" value="original"></label>
    <label>Workflow literal <textarea id="literal">original</textarea></label>
    <label>Workflow number <input id="number" type="number" value="1"></label>
    <label>Workflow check <input id="check" type="checkbox"></label>
    <label>Workflow radio <input id="radio" type="radio"></label>
    <label>Workflow secret <input id="secret" type="password"></label>
    <label>Workflow choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
    <button id="increment" onclick="document.querySelector('#count').textContent=++window.mutations">Increment</button>
    <output id="count">0</output>
    <input type="file" id="reference-file" aria-label="Reference file">
    <div id="shadow-drop-host" style="width:180px;height:60px"></div>
    <section id="post-dialog"><button id="post-close" onclick="window.closeClicks++;setTimeout(()=>document.querySelector('#post-dialog').remove(),160)">Close delayed dialog</button></section>
    <input id="post-field" aria-label="Deferred field"><output id="post-accepted">idle</output>
    <input class="ambiguous" value="same"><input class="ambiguous" value="same">
    <button class="duplicate" onclick="window.mutations++">Duplicate</button><button class="duplicate" onclick="window.mutations++">Duplicate</button>
    <iframe src="${frameOrigin}/frame" title="Cross origin fields"></iframe>
    <script>window.mutations=0;window.pointerEvents=[];window.closeClicks=0;window.fieldEvents=0;window.fileChanges=0;window.shadowDrops=0;
      document.querySelector('#reference-file').addEventListener('change',()=>window.fileChanges++);
      const dropRoot=document.querySelector('#shadow-drop-host').attachShadow({mode:'open'});
      dropRoot.innerHTML='<div id="shadow-drop-inner" role="button" aria-label="Shadow drop" style="width:180px;height:60px;background:#ccc">Drop fixture</div>';
      document.querySelector('#shadow-drop-host').addEventListener('dragover',event=>event.preventDefault());
      document.querySelector('#shadow-drop-host').addEventListener('drop',event=>{event.preventDefault();window.shadowDrops++;});
      document.querySelector('#post-field').addEventListener('input',event=>{
        window.fieldEvents++;
        const value=event.target.value;
        document.querySelector('#post-accepted').textContent='pending';
        setTimeout(()=>{
          if(value==='reject'){event.target.value='';document.querySelector('#post-accepted').textContent='rejected';}
          else document.querySelector('#post-accepted').textContent='accepted:'+value;
        },180);
      });
      document.querySelector('#increment').addEventListener('contextmenu',()=>window.pointerEvents.push('right'));
      document.querySelector('#increment').addEventListener('dblclick',()=>window.pointerEvents.push('double'));
      document.querySelector('#increment').addEventListener('mouseover',()=>window.pointerEvents.push('hover'));
    </script>`);
});

async function call(session, name, args = {}) {
  const result = await callRaw(session.client, { name, arguments: args });
  return { ...result, isError: result.isError === true, text: result.content?.find(item => item.type === "text")?.text ?? "" };
}
async function ok(session, name, args = {}) {
  const began = Date.now();
  if (runtimeEnvironment.CCMCP_TRACE_TEST) console.log(`  start ${name}`);
  const result = await call(session, name, args);
  if (runtimeEnvironment.CCMCP_TRACE_TEST) console.log(`  finish ${name} ${Date.now()-began}ms`);
  assert.equal(result.isError, false, `${name}: ${result.text}`);
  return result.text;
}
async function connect(name) {
  const session = { client: createMcpClient({ name, version: "0.0.0" }), tabs: new Set() };
  sessions.push(session);
  await connectMcpClient(session.client, createMcpTransport({
    command: process.execPath,
    args: [join(root, "dist/server.js")],
    cwd: root,
    env: {
      ...Object.fromEntries(Object.entries(runtimeEnvironment).filter(
        ([name, value]) => name.startsWith("CCMCP_") && typeof value === "string",
      )),
      CCMCP_CONFIG_DIR: configDir,
    },
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
    rmSync(configDir, { recursive: true, force: true });
  })();
}
let stopWatchdog = watchdog(cleanup);
let passes = 0;
let failures = 0;
async function test(name, run) {
  // Bound each independently named check. The CI harness bounds the whole
  // suite; adding checks must not consume the next check's hang deadline.
  stopWatchdog();
  stopWatchdog = watchdog(cleanup);
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
  // One deterministic fixture port; collision fails instead of spawning copies.
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(port, "127.0.0.1", resolve);
  });
  console.log(`workflow fixture PID ${process.pid}, port ${port}, root ${root}`);
  const A = await connect("workflow-owner");
  const B = await connect("workflow-other");
  const tabId = A.target;
  const navigate = () => ok(A, "navigate", { tabId, url: origin, waitUntil: "load" });
  const evaluate = text => ok(A, "javascript_tool", { tabId, text });
  const resolve = async selector => JSON.parse(await ok(A, "resolve_target", { tabId, target: { selector } }));
  const bound = target => ({ tabId, ref: target.ref, documentId: target.documentId });
  async function assertInactive() {
    const context = JSON.parse(await ok(A, "tabs_context_mcp"));
    assert.equal(context.tabs.find(tab => tab.tabId === tabId)?.active, false, "action activated the target tab");
  }
  async function prepare() {
    await navigate();
    await ok(A, "tab_switch", { tabId: A.keeper });
  }

  await test("resolved input, select and click survive a concurrent ref read without tab activation", async () => {
    await prepare();
    const input = await resolve("#value");
    const choice = await resolve("#choice");
    const button = await resolve("#increment");
    assert.equal(typeof input.documentId, "string");
    assert.equal(input.frameId, 0);
    await Promise.all([
      ok(A, "read_page", { tabId }),
      ok(A, "find", { tabId, query: "Duplicate" }),
    ]);
    await ok(A, "form_input", { ...bound(input), value: "bound input" });
    await ok(A, "select_option", { ...bound(choice), value: "b" });
    await ok(A, "computer", { ...bound(button), action: "left_click" });
    const result = JSON.parse(await evaluate("({value:document.querySelector('#value').value,choice:document.querySelector('#choice').value,count:window.mutations})"));
    assert.deepEqual(result, { value: "bound input", choice: "b", count: 1 });
    await assertInactive();
  });

  await test("all document-bound pointer actions use the selected document", async () => {
    await prepare();
    const button = await resolve("#increment");
    for (const action of ["right_click", "double_click", "hover", "scroll_to", "triple_click"]) {
      await ok(A, "computer", { ...bound(button), action });
    }
    assert.deepEqual(JSON.parse(await evaluate("window.pointerEvents")), ["right", "double", "hover"]);
    assert.equal(await evaluate("window.mutations"), "5", "double and triple click dispatch exactly their ordinary click counts");
    await assertInactive();
  });

  await test("a same-URL reload makes old document handles fail without ref alias mutation", async () => {
    await prepare();
    const input = await resolve("#value");
    const choice = await resolve("#choice");
    const button = await resolve("#increment");
    await ok(A, "tab_reload", { tabId, waitUntil: "load" });
    const freshInput = await resolve("#value");
    const freshChoice = await resolve("#choice");
    const freshButton = await resolve("#increment");
    assert.notEqual(freshInput.documentId, input.documentId);
    assert.notEqual(freshInput.ref, input.ref, "document namespaces must prevent numeric counter aliasing");
    assert.notEqual(freshChoice.ref, choice.ref);
    assert.notEqual(freshButton.ref, button.ref);
    for (const [name, args] of [
      ["form_input", { ...bound(input), value: "stale write" }],
      ["select_option", { ...bound(choice), value: "b" }],
      ["computer", { ...bound(button), action: "left_click" }],
    ]) {
      const result = await call(A, name, args);
      assert.equal(result.isError, true, `${name}: ${result.text}`);
    }
    assert.deepEqual(JSON.parse(await evaluate("({value:document.querySelector('#value').value,choice:document.querySelector('#choice').value,count:window.mutations})")),
      { value: "original", choice: "a", count: 0 });
    await assertInactive();
  });

  await test("unsupported and mixed-coordinate bound actions fail before mutation", async () => {
    await prepare();
    const button = await resolve("#increment");
    for (const args of [
      { action: "key", text: "Enter" }, { action: "type", text: "wrong" },
      { action: "left_click", coordinate: [20, 20] },
      { action: "left_click", start_coordinate: [20, 20] },
    ]) {
      const result = await call(A, "computer", { ...bound(button), ...args });
      assert.equal(result.isError, true, result.text);
    }
    assert.equal(await evaluate("window.mutations"), "0");
    await assertInactive();
  });

  await test("typed waits preserve string data, numeric values, booleans, and secret redaction", async () => {
    await prepare();
    const literal = "quotes '\" \\ newline\n${window.mutations++} {{literal}}";
    for (const [selector, value] of [["#literal", literal], ["#number", 42], ["#check", true], ["#radio", true]]) {
      await ok(A, "form_input", { ...bound(await resolve(selector)), value });
      await ok(A, "wait_for", { tabId, fieldValue: { selector, value }, timeoutMs: 1500 });
    }
    const secret = "not-for-error-output-593824";
    await ok(A, "form_input", { ...bound(await resolve("#secret")), value: secret });
    await ok(A, "wait_for", { tabId, fieldValue: { selector: "#secret", value: secret }, timeoutMs: 1000 });
    const mismatch = await call(A, "wait_for", { tabId, fieldValue: { selector: "#secret", value: "other-secret-54321" }, timeoutMs: 200 });
    assert.equal(mismatch.isError, true, mismatch.text);
    assert.doesNotMatch(mismatch.text, /not-for-error-output-593824|other-secret-54321/);
    assert.equal(await evaluate("window.mutations"), "0");
  });

  await test("ambiguous fields and malformed wait criteria are terminal", async () => {
    await prepare();
    const started = Date.now();
    const ambiguous = await call(A, "wait_for", { tabId, fieldValue: { selector: ".ambiguous", value: "same" }, timeoutMs: 5000 });
    assert.ok(ambiguous.isError && /ambiguous/i.test(ambiguous.text), ambiguous.text);
    assert.ok(Date.now() - started < 2000, "ambiguous field waited for the timeout");
    for (const args of [
      { selector: "#value", text: "Workflow" },
      { fieldValue: { selector: "#check", value: "true" } },
      { fieldValue: { selector: "[", value: "x" } },
      { fieldValue: { selector: "#increment", value: "x" } },
      { predicate: "true", frameId: 0 }, { url: origin + "/", frameId: 0 },
    ]) {
      const result = await call(A, "wait_for", { tabId, timeoutMs: 500, ...args });
      assert.equal(result.isError, true, result.text);
    }
  });

  await test("URL waits match exact href and follow a replacement document", async () => {
    await prepare();
    const destination = origin + "/arrived?value=quoted%22#complete";
    const pending = call(A, "wait_for", { tabId, url: destination, timeoutMs: 4000 });
    try {
      await evaluate(`setTimeout(()=>location.assign(${JSON.stringify(destination)}),250); 'scheduled'`);
      const result = await pending;
      assert.equal(result.isError, false, result.text);
      const mismatch = await call(A, "wait_for", { tabId, url: origin + "/arrived", timeoutMs: 200 });
      assert.equal(mismatch.isError, true, mismatch.text);
    } finally { await pending; }
    await assertInactive();
  });

  await test("cross-origin frame field waits follow child navigation and reject old frame actions", async () => {
    await prepare();
    const field = await resolve("#frame-field");
    const button = await resolve("#frame-button");
    assert.ok(field.frameId > 0, "fixture must resolve a child-frame ref");
    const main = await resolve("#value");
    const mismatched = await call(A, "form_input", { ...bound(main), ref: `${main.ref}@${field.frameId}`, value: "wrong frame" });
    assert.equal(mismatched.isError, true, mismatched.text);
    assert.match(mismatched.text, /frame\/document mismatch/i);
    assert.equal(await evaluate("document.querySelector('#value').value"), "original", "a forged suffix must not change the document-bound main field");
    await ok(A, "form_input", { ...bound(field), value: "child bound value" });
    await ok(A, "wait_for", { tabId, frameId: field.frameId, fieldValue: { selector: "#frame-field", value: "child bound value" }, timeoutMs: 1500 });
    await ok(A, "wait_for", { tabId, frameId: field.frameId, selector: "#frame-field", timeoutMs: 1000 });
    await ok(A, "wait_for", { tabId, frameId: field.frameId, text: "Frame button", timeoutMs: 1000 });
    const pending = call(A, "wait_for", { tabId, frameId: field.frameId, fieldValue: { selector: "#frame-field", value: "arrived" }, timeoutMs: 4000 });
    try {
      await evaluate(`setTimeout(()=>document.querySelector('iframe').src=${JSON.stringify(frameOrigin + "/frame?ready=1")},250); 'scheduled'`);
      const result = await pending;
      assert.equal(result.isError, false, result.text);
    } finally { await pending; }
    const freshField = await resolve("#frame-field");
    const freshButton = await resolve("#frame-button");
    assert.equal(freshField.frameId, field.frameId);
    assert.notEqual(freshField.documentId, field.documentId);
    for (const [name, args] of [
      ["form_input", { ...bound(field), value: "stale child" }],
      ["computer", { ...bound(button), action: "left_click" }],
    ]) assert.equal((await call(A, name, args)).isError, true);
    await ok(A, "wait_for", { tabId, frameId: freshField.frameId, fieldValue: { selector: "#frame-field", value: "arrived" }, timeoutMs: 1000 });
    await ok(A, "wait_for", { tabId, frameId: freshButton.frameId, text: "0", timeoutMs: 1000 });
    await assertInactive();
  });

  await test("field waits retain one deadline through navigation", async () => {
    await prepare();
    const started = Date.now();
    const pending = call(A, "wait_for", { tabId, fieldValue: { selector: "#value", value: "never-present" }, timeoutMs: 1600 });
    try {
      await sleep(600);
      await ok(A, "tab_reload", { tabId, waitUntil: "load" });
      const result = await pending;
      assert.ok(result.isError && /timed out after 1600ms/.test(result.text), result.text);
      assert.ok(Date.now() - started < 2300, "navigation restarted the observation deadline");
    } finally { await pending; }
  });

  await test("another session cannot observe or mutate document-bound targets", async () => {
    await prepare();
    const input = await resolve("#value");
    const button = await resolve("#increment");
    for (const [name, args] of [
      ["form_input", { ...bound(input), value: "intrusion" }],
      ["computer", { ...bound(button), action: "left_click" }],
      ["wait_for", { tabId, url: origin + "/", timeoutMs: 1000 }],
      ["wait_for", { tabId, fieldValue: { selector: "#value", value: "original" }, timeoutMs: 1000 }],
    ]) {
      const result = await call(B, name, args);
      assert.ok(result.isError && /not in your|tab group/i.test(result.text), result.text);
    }
    assert.equal(await evaluate("window.mutations"), "0");
    assert.equal(await evaluate("document.querySelector('#value').value"), "original");
  });

  await test("workflow dynamic targets verify fields and click only once", async () => {
    await prepare();
    const result = await call(A, "browser_batch", { actions: [
      { tool: "form_input", args: { tabId, value: "workflow filled" }, target: { selector: "#value" }, expect: { fieldValue: { selector: "#value", value: "workflow filled" } } },
      { tool: "computer", args: { tabId, action: "left_click" }, target: { role: "button", name: "Increment" }, expect: { text: "never emitted", timeoutMs: 200 } },
      { tool: "computer", args: { tabId, action: "left_click" }, target: { selector: "#increment" } },
    ] });
    assert.equal(result.isError, true, result.text);
    assert.equal(result.structuredContent?.status, "failed");
    assert.equal(result.structuredContent?.failedStep, 2);
    assert.equal(result.structuredContent?.completedSteps, 1);
    assert.equal(result.structuredContent?.historySaved, true);
    assert.equal(result.structuredContent?.screenshotSaved, false);
    const saved = await call(A, "run_history", { runId: result.structuredContent.runId, includeScreenshot: true });
    assert.equal(saved.isError, false, saved.text);
    assert.equal(saved.content.some(item => item.type === "image"), false, "screenshots require capture opt-in");
    assert.equal(await evaluate("document.querySelector('#value').value"), "workflow filled");
    assert.equal(await evaluate("window.mutations"), "1", "a failed expectation must neither replay nor continue the mutation");
    await assertInactive();
  });

  await test("direct click waits for dialog removal without replay", async () => {
    await prepare();
    const target = await resolve("#post-close");
    const result = JSON.parse(await ok(A, "computer", { ...bound(target), action: "left_click",
      expect: { selector: "#post-dialog", state: "detached", stableForMs: 100, timeoutMs: 3000 } }));
    assert.equal(result.outcome.status, "verified");
    assert.equal(await evaluate("window.closeClicks"), "1");
    assert.equal(await evaluate("!!document.querySelector('#post-dialog')"), "false");
    await assertInactive();
  });

  await test("direct failed outcome is explicit and never repeats click", async () => {
    await prepare();
    const target = await resolve("#increment");
    const result = await call(A, "computer", { ...bound(target), action: "left_click",
      expect: { text: "never emitted", timeoutMs: 250 } });
    assert.equal(result.isError, true, result.text);
    const payload = JSON.parse(result.text);
    assert.equal(payload.code, "OUTCOME_UNVERIFIED");
    assert.equal(payload.actionState, "completed");
    assert.equal(payload.outcome.status, "unverified");
    assert.equal(await evaluate("window.mutations"), "1");
  });

  await test("input value and deferred app acceptance are separate observations", async () => {
    await prepare();
    const target = await resolve("#post-field");
    const result = JSON.parse(await ok(A, "form_input", { ...bound(target), value: "approve",
      expect: { text: "accepted:approve", stableForMs: 100, timeoutMs: 3000 } }));
    assert.equal(result.actionResult.ok, true);
    assert.equal(result.outcome.status, "verified");
    assert.equal(await evaluate("window.fieldEvents"), "1");
    const rejected = await call(A, "form_input", { ...bound(target), value: "reject",
      expect: { text: "accepted:reject", timeoutMs: 500 } });
    assert.equal(rejected.isError, true, rejected.text);
    assert.equal(JSON.parse(rejected.text).actionResult.ok, true, "immediate field readback does not certify app acceptance");
    assert.equal(await evaluate("document.querySelector('#post-field').value"), '');
    assert.equal(await evaluate("window.fieldEvents"), "2");
  });

  await test("native file references authenticate uploads and composed shadow drop targets", async () => {
    await prepare();
    const input = await resolve("#reference-file");
    await ok(A, "file_upload", { tabId, ref: input.ref, paths: [uploadFixture] });
    assert.equal(await evaluate("document.querySelector('#reference-file').files.length"), "1");
    assert.equal(await evaluate("window.fileChanges"), "1");
    await ok(A, "tab_switch", { tabId });
    for (const selector of ["#shadow-drop-inner", "#shadow-drop-host"]) {
      const target = await resolve(selector);
      await ok(A, "file_drop", { tabId, ref: target.ref, path: uploadFixture });
    }
    assert.equal(await evaluate("window.shadowDrops"), "2", "each native drop dispatches once across shadow boundaries");
  });

  await test("invalid direct outcome fails before input", async () => {
    await prepare();
    const target = await resolve("#increment");
    const result = await call(A, "computer", { ...bound(target), action: "left_click",
      expect: { predicate: "true", state: "hidden" } });
    assert.equal(result.isError, true);
    assert.equal(await evaluate("window.mutations"), "0");
  });

  await test("ambiguous dynamic targets fail before a click", async () => {
    await prepare();
    const result = await call(A, "browser_batch", { actions: [
      { tool: "computer", args: { tabId, action: "left_click" }, target: { selector: ".duplicate" } },
    ] });
    assert.equal(result.isError, true, result.text);
    assert.equal(await evaluate("window.mutations"), "0");
    await assertInactive();
  });

  await test("batch values stay literal and a capable extension admits a trusted pointer step", async () => {
    await prepare();
    const literal = "Hej {{first_name}}";
    const batch = await call(A, "browser_batch", { actions: [
      { tool: "form_input", args: { tabId, value: literal }, target: { selector: "#literal" }, expect: { fieldValue: { selector: "#literal", value: literal } } },
    ] });
    assert.equal(batch.isError, false, batch.text);
    assert.equal(await evaluate("document.querySelector('#literal').value"), literal);
    const pointer = await call(A, "browser_batch", { actions: [
      { tool: "computer", args: { tabId, action: "left_click", pointerMode: "browser" }, target: { selector: "#increment" } },
    ] });
    assert.equal(pointer.isError, true, pointer.text);
    assert.match(pointer.text, /allowFocus:true/, "the step reached the extension, which refused background focus itself");
    assert.doesNotMatch(pointer.text, /trusted browser pointer support/);
    assert.equal(await evaluate("window.mutations"), "0");
    await assertInactive();
  });

  await test("saved recipes bind typed values, defaults and non-recursive string templates", async () => {
    await prepare();
    await ok(A, "recipe_save", {
      name: "typed-fields",
      description: "SDK workflow fixture",
      parameters: {
        value: { type: "string" }, amount: { type: "number", default: 17 }, enabled: { type: "boolean", default: true },
      },
      actions: [
        { tool: "form_input", args: { value: { $param: "value" } }, target: { selector: "#value" }, expect: { fieldValue: { selector: "#value", value: { $param: "value" } } } },
        { tool: "form_input", args: { value: { $param: "amount" } }, target: { selector: "#number" }, expect: { fieldValue: { selector: "#number", value: { $param: "amount" } } } },
        { tool: "form_input", args: { value: { $param: "enabled" } }, target: { selector: "#check" }, expect: { fieldValue: { selector: "#check", value: { $param: "enabled" } } } },
        { tool: "form_input", args: { value: "prefix {{value}} #{{amount}}" }, target: { selector: "#value" }, expect: { fieldValue: { selector: "#value", value: "prefix {{value}} #{{amount}}" } } },
      ],
    });
    const value = "private-parameter-74821 {{amount}}";
    for (const parameters of [{ value }, { value, amount: 29, enabled: false }]) {
      const result = await call(A, "recipe_run", { name: "typed-fields", tabId, parameters });
      assert.equal(result.isError, false, result.text);
      const summary = result.structuredContent;
      assert.equal(summary.status, "succeeded");
      assert.equal(summary.completedSteps, 4);
      assert.equal(summary.totalSteps, 4);
      assert.equal(summary.failedStep, undefined);
      assert.equal(summary.historySaved, true);
      assert.ok(summary.durationMs >= 0);
      assert.deepEqual(summary.steps.map(step => step.index), [1, 2, 3, 4]);
      assert.ok(summary.steps.every(step => step.durationMs >= 0));
      assert.equal(JSON.parse(result.text).length, 4, "legacy text step array remains available");
      const amount = parameters.amount ?? 17;
      assert.deepEqual(JSON.parse(await evaluate("({value:document.querySelector('#value').value,number:document.querySelector('#number').value,checked:document.querySelector('#check').checked})")),
        { value: `prefix ${value} #${amount}`, number: String(amount), checked: parameters.enabled ?? true });
      const history = await ok(B, "run_history", { runId: summary.runId });
      assert.doesNotMatch(history, /private-parameter-74821|prefix|\$param|selector/);
      assert.equal(JSON.parse(history).status, summary.status);
    }
    const listed = JSON.parse(await ok(A, "recipe_list"));
    assert.equal(listed.find(recipe => recipe.name === "typed-fields").parameters.amount.default, 17);
    assert.equal(listed.find(recipe => recipe.name === "legacy-read").steps, 1);
    const legacy = await call(A, "recipe_run", { name: "legacy-read", tabId });
    assert.equal(legacy.isError, false, legacy.text);
    assert.equal(legacy.structuredContent.status, "succeeded");
    assert.equal(JSON.parse(legacy.text)[0].tool, "get_page_text");
    await assertInactive();
  });

  await test("unknown, missing and wrongly typed recipe parameters dispatch no leading mutation", async () => {
    await prepare();
    await ok(A, "recipe_save", {
      name: "parameter-preflight", parameters: { value: { type: "string" } },
      actions: [
        { tool: "computer", args: { action: "left_click" }, target: { selector: "#increment" } },
        { tool: "form_input", args: { value: { $param: "value" } }, target: { selector: "#value" } },
      ],
    });
    for (const parameters of [{}, { value: "valid", unknown: "unaccepted" }, { value: 9 }]) {
      const result = await call(A, "recipe_run", { name: "parameter-preflight", tabId, parameters });
      assert.equal(result.isError, true, result.text);
      assert.equal(await evaluate("window.mutations"), "0");
      assert.equal(await evaluate("document.querySelector('#value').value"), "original");
    }
    await assertInactive();
  });

  await test("run history retains metadata and opt-in PNG without raw inputs or page errors", async () => {
    await prepare();
    const privateInput = "raw-input-private-918234";
    const pageError = "raw-page-error-private-519327";
    const result = await call(A, "browser_batch", { captureOnError: true, actions: [
      { tool: "form_input", args: { tabId, value: privateInput }, target: { selector: "#value" } },
      { tool: "javascript_tool", args: { tabId, text: `throw new Error(${JSON.stringify(pageError)})` } },
      { tool: "computer", args: { tabId, action: "left_click" }, target: { selector: "#increment" } },
    ] });
    assert.equal(result.isError, true, result.text);
    const summary = result.structuredContent;
    assert.equal(summary.status, "failed");
    assert.equal(summary.failedStep, 2);
    assert.equal(summary.completedSteps, 1);
    assert.equal(summary.historySaved, true);
    assert.equal(summary.screenshotSaved, true);
    assert.equal(await evaluate("window.mutations"), "0");
    assert.equal(await evaluate("document.querySelector('#value').value"), privateInput);
    const metadata = await call(B, "run_history", { runId: summary.runId });
    assert.equal(metadata.isError, false, metadata.text);
    assert.equal(metadata.content.some(item => item.type === "image"), false);
    const record = JSON.parse(metadata.text);
    assert.equal(record.status, summary.status);
    assert.equal(record.failedStep, 2);
    assert.equal(record.screenshot, true);
    assert.deepEqual(record.steps.map(step => step.index), [1, 2]);
    assert.match(record.steps[1].error, /^[A-Za-z][A-Za-z0-9_.:-]*$/);
    assert.equal(metadata.text.includes(privateInput), false);
    assert.equal(metadata.text.includes(pageError), false);
    assert.doesNotMatch(metadata.text, /base64|\"args\"|\"result\"/);
    const withImage = await call(B, "run_history", { runId: summary.runId, includeScreenshot: true });
    assert.equal(withImage.isError, false, withImage.text);
    const image = withImage.content.find(item => item.type === "image");
    assert.equal(image?.mimeType, "image/png");
    const png = Buffer.from(image.data, "base64");
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    assert.equal(withImage.text, metadata.text, "image bytes stay out of text metadata");
    const listed = JSON.parse(await ok(A, "run_history", { limit: 100 }));
    assert.ok(listed.some(run => run.runId === summary.runId));
    assert.equal(JSON.stringify(listed).includes(privateInput), false);
    assert.equal(JSON.stringify(listed).includes(pageError), false);
    await assertInactive();
  });
} finally {
  await cleanup();
  stopWatchdog();
}
console.log(`\n=== workflow-live: ${passes} passed, ${failures} failed ===`);
process.exitCode = failures ? 1 : 0;
