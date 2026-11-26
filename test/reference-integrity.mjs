import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { transform } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();

// Run the serialized source functions in small document realms. A DOM attribute
// is deliberately cloneable; node identity and the owning document are separate.
class Element {
  constructor(tag, doc, attrs = {}) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.attrs = { ...attrs };
    this.children = []; this.childNodes = []; this.parentElement = null; this.isConnected = true;
    this.value = ""; this.clicks = 0; this.events = 0;
  }
  get id() { return this.attrs.id || ""; }
  get childElementCount() { return this.children.length; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  hasAttribute(key) { return key in this.attrs; }
  matches(selector) {
    return selector.split(",").some(part => {
      const s = part.trim();
      if (s === "*") return true;
      if (s.startsWith("#")) return this.id === s.slice(1);
      const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
      if (attr) return this.hasAttribute(attr[1]) && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
      return this.tagName.toLowerCase() === s;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, width: 40, height: 20 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  getRootNode() { return this.ownerDocument; }
  appendChild(node) {
    if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1);
    this.children.push(node); this.childNodes = this.children; node.parentElement = this; node.isConnected = true;
    return node;
  }
  remove() {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null; this.isConnected = false;
  }
  scrollIntoView() { this.scrolled = true; }
  focus() { this.ownerDocument.activeElement = this; }
  dispatchEvent() { this.events++; return true; }
  click() { this.clicks++; }
}
class ShadowRoot extends Element {}
const sourceCache = new Map();
async function load(path, context, append = "") {
  const key = path + append;
  if (!sourceCache.has(key)) sourceCache.set(key, (await transform(await readFile(path, "utf8") + append,
    { loader: "ts", format: "cjs", target: "es2022" })).code);
  return vm.runInContext(`(function(){const module={exports:{}};const exports=module.exports;${sourceCache.get(key)};return module.exports;})()`, context);
}
// Chrome rebuilds an injected function from func.toString() in the page, so it
// carries no module scope: an import or a module-level constant it uses is a
// ReferenceError there. Rebuild each one the same way before calling it.
function serialized(func, context) {
  return vm.runInContext(`(${func.toString()})`, context);
}
function serializedExports(exports, context) {
  return Object.fromEntries(Object.entries(exports)
    .filter(([, value]) => typeof value === "function")
    .map(([name, func]) => [name, serialized(func, context)]));
}
async function realm() {
  const document = { nodeType: 9, visibilityState: "visible", hasFocus: () => true };
  document.body = new Element("body", document); document.children = [document.body];
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  document.getElementById = id => document.querySelector(`#${id}`);
  document.elementFromPoint = () => document.body.children[0] || null;
  const field = document.body.appendChild(new Element("input", document, { id: "field", "aria-label": "Fixture field" }));
  const window = { innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 };
  const listeners = new Set(), dependencies = {};
  const cdp = { commands: [], inspections: 0, frameId: 0, documentId: "fixture-document", contexts: [],
    transportAfterMutation: false, changedDocument: false, enabled: false, hook: async () => {} };
  const chrome = { runtime: { id: "reference-fixture" }, debugger: { onEvent: {
    addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
  }, onDetach: { addListener() {} } }, tabs: { onRemoved: { addListener() {} } } };
  const context = vm.createContext({ window, document, Element, ShadowRoot, Node: { TEXT_NODE: 3 }, chrome,
    crypto: webcrypto, Uint32Array, Date, setTimeout, clearTimeout, innerWidth: 800, innerHeight: 600,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    Event: class {}, MouseEvent: class {}, HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    require: path => dependencies[path] || {},
  });
  dependencies["./tool-error"] = await load("extension/src/tool-error.ts", context);
  cdp.contexts = [{ id: 11, origin: "chrome-extension://reference-fixture", auxData: { isDefault: false, frameId: "main-frame" }, context }];
  const { withRuntimeDomain } = await load("extension/src/cdp.ts", context);
  // This fixture uses the real lock and its own transport, bypassing the CDP
  // module's permanent event dispatcher. Count only discovery listeners below.
  listeners.clear();
  dependencies["./tab-group-helpers"] = { assertTabInGroup: async () => ({}) };
  dependencies["./cdp"] = { withRuntimeDomain, cdpSend: async (tabId, method, params, guard) => {
    if (guard) await guard();
    cdp.commands.push({ method, params });
    await cdp.hook(method, params);
    if (method === "Runtime.disable") cdp.enabled = false;
    if (method === "Runtime.enable") cdp.enabled = true;
    if (method === "Runtime.compileScript") {
      assert.equal(cdp.enabled, true, "Runtime must remain enabled throughout predicate compilation");
      return {};
    }
    if (method === "Runtime.enable") for (const description of cdp.contexts) {
      const { context: ignored, ...descriptionOnly } = description;
      for (const listener of listeners) listener({ tabId }, "Runtime.executionContextCreated", { context: descriptionOnly });
    }
    if (method !== "Runtime.evaluate") return {};
    const target = cdp.contexts.find(candidate => candidate.id === params.contextId)?.context;
    if (!target || cdp.contexts.find(candidate => candidate.id === params.contextId)?.destroyed) throw new Error("Execution context was destroyed");
    let value;
    try { value = vm.runInContext(params.expression, target); }
    catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
    if (cdp.transportAfterMutation && params.expression.includes("e.click()")) throw new Error("ambiguous dispatch transport failure");
    return { result: params.returnByValue ? { value } : { objectId: "fixture-node-object" } };
  } };
  dependencies["./diagnostics"] = { executeScript: async injection => {
    cdp.inspections++;
    if (cdp.changedDocument && cdp.inspections > 1) throw new Error("Reference document changed");
    if (injection.target.documentIds && injection.target.documentIds[0] !== cdp.documentId) throw new Error("No document");
    return [{ frameId: cdp.frameId, documentId: cdp.documentId, result: serialized(injection.func, context)(...injection.args) }];
  } };
  // Every function these modules export is injected with chrome.scripting.
  const query = serializedExports(await load("extension/src/injected-page-scripts.ts", context), context);
  const form = serializedExports(await load("extension/src/injected-form-scripts.ts", context), context);
  const interaction = serializedExports(await load("extension/src/injected-interaction-scripts.ts", context), context);
  const perception = serializedExports(await load("extension/src/perception-scripts.ts", context), context);
  const { pointerTargetInPage } = await load("extension/src/browser-pointer.ts", context, "\nexport { pointerTargetInPage };\n");
  const pointer = { pointerTargetInPage: serialized(pointerTargetInPage, context) };
  const refs = await load("extension/src/element-ref.ts", context);
  dependencies["./element-ref"] = refs;
  const computer = await load("extension/src/computer-input.ts", context);
  const pageEvaluation = await load("extension/src/page-evaluation.ts", context);
  return { document, window, field, context, cdp, listeners, ...pageEvaluation, ...computer, ...query, ...form, ...interaction, ...perception, ...pointer, ...refs,
    issue() { this.pageQuery("read", "", "interactive", 100); return field.getAttribute("data-ccmcp-ref"); },
  };
}
function cloneField(r, ref) {
  return r.document.body.appendChild(new Element("input", r.document, { id: "copy", "aria-label": "Fixture copy", "data-ccmcp-ref": ref }));
}
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error.message}`); }
}
await test("document issuers cannot reuse a prior document's reference", async () => {
  const first = await realm(), second = await realm();
  assert.notEqual(first.issue(), second.issue());
});
await test("a stale ref cannot mutate a newly scanned document", async () => {
  const first = await realm(), second = await realm(); const stale = first.issue(); second.issue();
  const result = second.formInputInPage(stale, "wrong-document");
  assert.equal(result.ok, false); assert.match(result.error, /stale|document|not found|No element/i);
  assert.equal(second.field.value, "");
});
await test("actionability samples are synchronous when page clocks and timers are stopped", async () => {
  const r = await realm(), ref = r.issue();
  r.document.visibilityState = "hidden";
  r.context.Date = { now: () => 0 };
  r.context.setTimeout = () => { throw new Error("page timer must not own actionability"); };
  const sample = r.sampleActionableInPage(ref);
  sample?.catch?.(() => {});
  assert.equal(typeof sample?.then, "undefined", "one sample must not wait on a page Promise");
  assert.equal(sample.ok, true, "a hidden browser tab still permits DOM automation");
  assert.deepEqual(JSON.parse(JSON.stringify(sample.rect)), { x: 10, y: 10, w: 40, h: 20 });
  assert.equal(r.field.clicks, 0);
});
await test("one replacement clone cannot impersonate a removed issued node", async () => {
  const r = await realm(), ref = r.issue(); r.field.remove(); const clone = cloneField(r, ref);
  const result = r.formInputInPage(ref, "wrong-node");
  assert.equal(result.ok, false); assert.equal(clone.value, "");
});
await test("all serialized consumers reject duplicate refs before any mutation", async () => {
  for (const kind of ["form", "fill", "select", "click", "actionable", "pointer", "cdp"]) {
    const r = await realm(), ref = r.issue(), clone = cloneField(r, ref);
    if (kind === "form") assert.equal(r.formInputInPage(ref, "x").ok, false, kind);
    if (kind === "fill") assert.equal(r.fillFormInPage([{ ref, value: "x" }]).ok, false, kind);
    if (kind === "select") assert.equal(r.selectOptionInPage(ref, "x").ok, false, kind);
    if (kind === "click") assert.equal(r.pageInteract("left_click", { ref }).ok, false, kind);
    if (kind === "actionable") assert.equal(r.sampleActionableInPage(ref).ok, false, kind);
    if (kind === "pointer") assert.throws(() => r.pointerTargetInPage(ref, null, true), /ambiguous|stale/i);
    if (kind === "cdp") assert.throws(() => vm.runInContext(r.deepByAttrExpr(ref), r.context), /ambiguous|stale/i);
    assert.equal(r.field.value, "", kind); assert.equal(r.field.clicks, 0, kind);
    assert.equal(r.field.scrolled, undefined, kind); assert.equal(clone.value, "", kind);
  }
});
await test("loop observation cannot repair a duplicate ref before an action", async () => {
  const r = await realm(), ref = r.issue(), clone = cloneField(r, ref);
  const observed = r.perceiveInPage({ mode: "scan", filter: "interactive", maxResults: 100, mint: false });
  assert.ok(observed.nodes.length >= 2, "observation still describes the page");
  assert.equal(clone.getAttribute("data-ccmcp-ref"), ref, "observation must leave the duplicate visible to action guards");
  assert.equal(r.window.__ccmcpRefMap[ref], r.field, "observation must not transfer issued identity to the clone");
  await assert.rejects(r.cdpInteract({ tabId: 1, action: "left_click", ref }), /ambiguous|stale/i);
  assert.equal(r.field.clicks, 0); assert.equal(clone.clicks, 0);
  r.perceiveInPage({ mode: "scan", filter: "interactive", maxResults: 100 });
  assert.notEqual(clone.getAttribute("data-ccmcp-ref"), ref, "an explicit scan still assigns the clone a fresh ref");
});
await test("a moved connected node retains its identity", async () => {
  const r = await realm(), ref = r.issue();
  const destination = r.document.body.appendChild(new Element("div", r.document)); destination.appendChild(r.field);
  assert.equal(r.issue(), ref); assert.equal(r.formInputInPage(ref, "still-valid").ok, true);
  assert.equal(r.field.value, "still-valid");
});
await test("MAIN-world attributes cannot substitute for the isolated identity map", async () => {
  const r = await realm(), ref = r.issue(); delete r.window.__ccmcpRefMap; delete r.window.__ccmcpRefState;
  assert.throws(() => vm.runInContext(r.deepByAttrExpr(ref), r.context), /stale|document/i);
});
await test("perception and pageQuery share identity while rejecting transplanted tags", async () => {
  const r = await realm(), ref = r.issue();
  const result = r.perceiveInPage({ mode: "resolve", selector: "#field", mint: true });
  assert.equal(result.nodes[0].ref, ref);
  const other = await realm(); other.field.setAttribute("data-ccmcp-ref", ref);
  const next = other.perceiveInPage({ mode: "resolve", selector: "#field", mint: true }).nodes[0].ref;
  assert.notEqual(next, ref); assert.equal(other.formInputInPage(ref, "no").ok, false);
});
await test("fill preflights later fields and submit before its first write", async () => {
  for (const mode of ["field", "submit", "duplicate"]) {
    const r = await realm(), ref = r.issue(), old = await realm(), stale = old.issue();
    let fields = [{ ref, value: "must-not-change" }], submit;
    if (mode === "field") fields.push({ ref: stale, value: "stale" });
    if (mode === "submit") submit = stale;
    if (mode === "duplicate") {
      const other = r.document.body.appendChild(new Element("input", r.document, { id: "other", "aria-label": "Other" }));
      r.pageQuery("read", "", "interactive", 100);
      const otherRef = other.getAttribute("data-ccmcp-ref"); cloneField(r, otherRef);
      fields.push({ ref: otherRef, value: "ambiguous" });
    }
    const result = r.fillFormInPage(fields, submit);
    assert.equal(result.ok, false, mode); assert.equal(r.field.value, "", mode);
    assert.equal(r.field.events, 0, mode);
  }
});
await test("duplicate refs inside open shadow roots also fail before mutation", async () => {
  const r = await realm(), ref = r.issue();
  const host = r.document.body.appendChild(new Element("div", r.document));
  host.shadowRoot = new ShadowRoot("shadow", r.document);
  const clone = new Element("input", r.document, { "data-ccmcp-ref": ref }); host.shadowRoot.appendChild(clone);
  assert.equal(r.formInputInPage(ref, "x").ok, false); assert.equal(r.field.value, "");
  assert.throws(() => vm.runInContext(r.deepByAttrExpr(ref), r.context), /Ambiguous/);
});
await test("adoption into another document invalidates and prunes an old identity", async () => {
  const first = await realm(), second = await realm(), ref = first.issue();
  first.field.ownerDocument = second.document;
  assert.equal(first.formInputInPage(ref, "no").ok, false);
  first.pageQuery("find", "absent", "interactive", 1);
  assert.equal(first.window.__ccmcpRefMap[ref], undefined);
});
await test("CDP uses the authenticated extension isolated context and cleans listeners", async () => {
  const r = await realm(), ref = r.issue(), other = await realm(); other.issue();
  r.cdp.contexts.unshift({ id: 7, origin: "https://page.invalid", auxData: { isDefault: true }, context: r.context });
  r.cdp.contexts.push({ id: 12, origin: "chrome-extension://reference-fixture", auxData: { isDefault: false }, context: other.context });
  const result = await r.evaluateRefInTab(1, ref, `(()=>{const e=${r.deepByAttrExpr(ref)};e.click();return true})()`);
  assert.equal(result.result.value, true); assert.equal(r.field.clicks, 1); assert.equal(other.field.clicks, 0);
  assert.equal(r.cdp.inspections, 2); assert.equal(r.listeners.size, 0);
  const evaluations = r.cdp.commands.filter(command => command.method === "Runtime.evaluate");
  assert.ok(evaluations.every(command => command.params.contextId !== 7));
  assert.equal(evaluations.at(-1).params.contextId, 11);
});
await test("CDP rejects missing/ambiguous context, wrong frame and replaced document before dispatch", async () => {
  for (const mode of ["missing", "ambiguous", "frame", "document"]) {
    const r = await realm(), ref = r.issue();
    if (mode === "missing") r.cdp.contexts = [];
    if (mode === "ambiguous") r.cdp.contexts.push({ ...r.cdp.contexts[0], id: 12 });
    if (mode === "frame") r.cdp.frameId = 3;
    if (mode === "document") r.cdp.changedDocument = true;
    await assert.rejects(r.evaluateRefInTab(1, ref, `(()=>{const e=${r.deepByAttrExpr(ref)};e.click();return true})()`), /context|frame|document/i, mode);
    assert.equal(r.field.clicks, 0, mode); assert.equal(r.listeners.size, 0, mode);
  }
});
await test("CDP exceptionDetails and uncertain click dispatch are terminal without replay", async () => {
  const ambiguous = await realm(), duplicateRef = ambiguous.issue(); cloneField(ambiguous, duplicateRef);
  await assert.rejects(ambiguous.cdpInteract({ tabId: 1, action: "left_click", ref: duplicateRef }),
    error => error.name === "NoFallbackError" && /Ambiguous/.test(error.message));
  assert.equal(ambiguous.field.clicks, 0); assert.equal(ambiguous.listeners.size, 0);
  const uncertain = await realm(), ref = uncertain.issue(); uncertain.cdp.transportAfterMutation = true;
  await assert.rejects(uncertain.cdpInteract({ tabId: 1, action: "left_click", ref }),
    error => error.name === "NoFallbackError" && /ambiguous dispatch/.test(error.message));
  assert.equal(uncertain.field.clicks, 1);
  assert.equal(uncertain.cdp.commands.filter(command => command.method === "Runtime.evaluate" && command.params.expression.includes("e.click()")).length, 1);
  assert.equal(uncertain.listeners.size, 0);
});
await test("a destroyed unrelated iframe context cannot block the valid reference context", async () => {
  const r = await realm(), ref = r.issue();
  r.cdp.contexts.unshift({ ...r.cdp.contexts[0], id: 12, destroyed: true });
  const result = await r.evaluateRefInTab(1, ref, `(()=>{const e=${r.deepByAttrExpr(ref)};e.click();return true})()`);
  assert.equal(result.result.value, true); assert.equal(r.field.clicks, 1); assert.equal(r.listeners.size, 0);
});
await test("Runtime context discovery and predicate compilation cannot interleave their setup", async () => {
  for (const first of ["compile", "discovery"]) {
    const r = await realm(), ref = r.issue(); let release, entered;
    const entry = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const blockedMethod = first === "compile" ? "Runtime.compileScript" : "Runtime.disable";
    r.cdp.hook = async method => { if (method === blockedMethod) { entered(); await blocked; } };
    const request = { sessionId: "owner", tabId: 1, deadline: Date.now() + 5000, expired: () => new Error("expired") };
    const compile = () => r.validatePredicateInPage(request, "true");
    const discover = () => r.evaluateRefInTab(1, ref, `(()=>{const e=${r.deepByAttrExpr(ref)};return e.id})()`);
    const initial = first === "compile" ? compile() : discover(); await entry;
    const following = first === "compile" ? discover() : compile();
    await new Promise(resolve => setTimeout(resolve, 5));
    if (first === "compile") assert.equal(r.cdp.commands.some(command => command.method === "Runtime.disable"), false);
    else assert.equal(r.cdp.commands.some(command => command.method === "Runtime.compileScript"), false);
    release(); await Promise.all([initial, following]);
    assert.equal(r.listeners.size, 0);
  }
});
await test("every secret-field copy agrees on a table of fields", async () => {
  const table = [
    ["input", { type: "password" }, true],
    ["input", { type: "hidden" }, true],
    ["input", { autocomplete: "current-password" }, true],
    ["input", { autocomplete: "section-login one-time-code" }, true],
    ["input", { autocomplete: "billing cc-number" }, true],
    ["input", { autocomplete: "shipping CC-EXP" }, true],
    ["input", { autocomplete: "username" }, false],
    ["input", { name: "user_password" }, true],
    ["input", { name: "email" }, false],
    ["textarea", { autocomplete: "one-time-code" }, true],
    ["textarea", { id: "cvc-note" }, true],
    ["textarea", { name: "notes" }, false],
  ];
  const drift = [];
  for (const [tag, attrs, secret] of table) {
    const r = await realm();
    r.field.remove();
    const probe = r.document.body.appendChild(new Element(tag, r.document, { "aria-label": "Probe", ...attrs }));
    // The field keeps its own value, so both read-back paths report a rejection.
    Object.defineProperty(probe, "value", { get: () => "held-value", set() {}, configurable: true });
    const read = r.pageQuery("read", "", "interactive", 10);
    const ref = probe.getAttribute("data-ccmcp-ref");
    const perceived = r.perceiveInPage({ mode: "scan", filter: "interactive", maxResults: 10 }).nodes.find(node => node.name === "Probe");
    const form = r.formInputInPage(ref, "written");
    const fill = r.fillFormInPage([{ ref, value: "written" }]).results[0];
    const label = `${tag} ${JSON.stringify(attrs)}`;
    assert.match(read, /"Probe"/, label);
    assert.ok(perceived, label);
    const verdicts = {
      read: /value="•••/.test(read), perception: perceived.value === "•••",
      formReadBack: /secret field/.test(form.error ?? ""), fillReadBack: /secret field/.test(fill.error ?? ""),
    };
    const wrong = Object.entries(verdicts).filter(([, verdict]) => verdict !== secret).map(([copy]) => copy);
    if (secret && /held-value/.test(read + (form.error ?? "") + (fill.error ?? ""))) wrong.push("printed value");
    if (wrong.length) drift.push(`${label} expected ${secret ? "secret" : "plain"}: ${wrong.join(", ")}`);
  }
  assert.deepEqual(drift, []);
});
await test("read_page reaches a control nested 70 levels deep and stops at 20 000 elements", async () => {
  const deep = await realm();
  let node = deep.document.body;
  for (let depth = 0; depth < 70; depth++) node = node.appendChild(new Element("div", deep.document));
  node.appendChild(new Element("button", deep.document, { "aria-label": "Deep target" }));
  const listed = deep.pageQuery("read", "", "interactive", 100);
  assert.match(listed, /button "Deep target"/);
  assert.doesNotMatch(listed, /walk aborted/);
  const wide = await realm();
  for (let index = 0; index < 20_001; index++) wide.document.body.appendChild(new Element("span", wide.document));
  assert.match(wide.pageQuery("read", "", "interactive", 10), /walk aborted/);
});
await test("accessible names in read_page and find are bounded to 500 characters", async () => {
  const r = await realm();
  r.field.setAttribute("aria-label", "n".repeat(5000));
  for (const output of [r.pageQuery("find", "nnn", "all", 5), r.pageQuery("read", "", "interactive", 5)]) {
    const line = output.split("\n").find(entry => entry.includes("textbox"));
    assert.ok(line, output.slice(0, 80));
    assert.ok(line.length <= 500 + 80, `line length ${line.length}`);
  }
});
await test("a coordinate click acts where it is; only a ref click scrolls its target into view", async () => {
  const r = await realm();
  const clicked = r.pageInteract("left_click", { coordinate: [20, 20] });
  assert.equal(clicked.ok, true, clicked.error);
  assert.equal(r.field.clicks, 1);
  assert.equal(r.field.scrolled, undefined, "a coordinate target must not move the page");
  const ref = r.issue();
  assert.equal(r.pageInteract("left_click", { ref }).ok, true);
  assert.equal(r.field.scrolled, true);
});
await test("a coordinate resolves through open shadow roots and refuses a frame element", async () => {
  const r = await realm();
  const host = r.document.body.appendChild(new Element("div", r.document));
  host.shadowRoot = new ShadowRoot("shadow", r.document);
  const inner = host.shadowRoot.appendChild(new Element("button", r.document));
  host.shadowRoot.elementFromPoint = () => inner;
  r.document.elementFromPoint = () => host;
  const shadow = r.pageInteract("left_click", { coordinate: [5, 5] });
  assert.equal(shadow.ok, true, shadow.error);
  assert.equal(inner.clicks, 1);
  assert.equal(host.clicks, 0);
  const frame = r.document.body.appendChild(new Element("iframe", r.document));
  r.document.elementFromPoint = () => frame;
  for (const action of ["left_click", "hover"]) {
    const refused = r.pageInteract(action, { coordinate: [5, 5] });
    assert.equal(refused.ok, false, action);
    assert.match(refused.error, /frame/i, action);
    assert.match(refused.error, /ref_N@frameId/, action);
    assert.match(refused.error, /pointerMode:"browser"/, action);
  }
  assert.equal(frame.clicks, 0);
  assert.equal(frame.events, 0);
});
await test("the naming copies agree and never read a textarea's text through a label", async () => {
  // Text nodes and mixed child lists, which the shared fixture elements do not model.
  const text = value => ({ nodeType: 3, textContent: value });
  const build = (r, tag, attrs, children = []) => {
    const el = new Element(tag, r.document, attrs);
    el.nodeType = 1;
    for (const child of children) if (child instanceof Element) el.appendChild(child);
    el.childNodes = children;
    Object.defineProperty(el, "textContent", { get: () => el.childNodes.map(node => node.textContent ?? "").join("") });
    return el;
  };
  const codes = (r, marker) => build(r, "textarea", { autocomplete: "one-time-code" }, [text(`7311-${marker}-code`)]);
  const cases = {
    "a label that wraps the textarea": r => {
      const area = codes(r, "wrapped");
      r.document.body.appendChild(build(r, "label", {}, [text("Recovery codes "), area]));
      return area;
    },
    "label[for] that also holds the textarea": r => {
      const area = codes(r, "for");
      area.attrs.id = "backup-codes";
      r.document.body.appendChild(build(r, "label", { for: "backup-codes" }, [text("Backup codes "), area]));
      return area;
    },
    "aria-labelledby pointing at an element that contains a textarea": r => {
      r.document.body.appendChild(build(r, "div", { id: "codes-label" }, [text("Recovery codes "), codes(r, "labelled")]));
      return r.document.body.appendChild(build(r, "input", { "aria-labelledby": "codes-label" }));
    },
  };
  const drift = [];
  for (const [label, make] of Object.entries(cases)) {
    const r = await realm();
    r.field.remove();
    r.context.CSS = { escape: value => value };
    const query = r.document.querySelector;
    r.document.querySelector = selector => {
      const forId = /^label\[for="([^"]+)"\]$/.exec(selector)?.[1];
      return forId ? r.document.querySelectorAll("label").find(item => item.getAttribute("for") === forId) ?? null : query(selector);
    };
    const target = make(r);
    const listing = r.pageQuery("read", "", "interactive", 20);
    const ref = target.getAttribute("data-ccmcp-ref");
    const line = listing.split("\n").find(entry => entry.includes(`[${ref}]`)) ?? "";
    const listed = /^\s*\[[^\]]+\] \S+ "([^"]*)"/.exec(line)?.[1] ?? "";
    const perceived = r.perceiveInPage({ mode: "scan", filter: "interactive", maxResults: 20 }).nodes.find(node => node.ref === ref)?.name ?? "";
    if (/-code/.test(listed + perceived)) drift.push(`${label}: a name holds the textarea's text (read_page "${listed}", perception "${perceived}")`);
    else if (!listed || listed !== perceived) drift.push(`${label}: read_page names it "${listed}", perception "${perceived}"`);
  }
  assert.deepEqual(drift, []);
});
stopWatchdog();
console.log(`Reference integrity: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
