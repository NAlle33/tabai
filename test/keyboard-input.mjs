import assert from "node:assert/strict";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
let commands, paints, captureError, inputError, paintReadHook, syntheticCalls = 0;
const probe = Symbol.for("tabai-keyboard-input-test");
globalThis[probe] = async (method, params) => {
  commands.push({ method, params });
  if (method === "Runtime.evaluate") {
    paintReadHook?.();
    return { result: { value: paints.length > 1 ? paints.shift() : paints[0] } };
  }
  if (method === "Page.captureScreenshot" && captureError) throw captureError;
  if (inputError && (params?.type === "keyUp" || method === "Input.insertText")) throw inputError;
  return {};
};
try {
  globalThis[Symbol.for("tabai-keyboard-synthetic-test")] = async () => { syntheticCalls++; return [{ result: { ok: true } }]; };
  const source = await build({ entryPoints: ["extension/src/browser-tools.ts"], bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "cdp-boundary", setup(plugin) {
      const modules = {
        "./cdp": "export const cdpSend=(_tab,method,params)=>globalThis[Symbol.for('tabai-keyboard-input-test')](method,params);export const withRuntimeDomain=(_tab,operation)=>operation()",
        "./diagnostics": "export const executeScript=(...args)=>globalThis[Symbol.for('tabai-keyboard-synthetic-test')](...args)",
        "./tab-group-helpers": "export const sessionOf=()=> 'owner';export const assertTabInGroup=async()=>({})",
        "./browser-pointer": "export const browserPointer=()=>{throw new Error('Unexpected pointer path')}",
        "./page-evaluation": "export const evaluateInPage=()=>{}; export const validatePredicateInPage=()=>{}; export class PreDispatchError extends Error {}",
        "./capture-tools": "export const captureComputerScreenshot=()=>{}",
      };
      plugin.onResolve({ filter: /^\.\// }, args => modules[args.path] ? { path: args.path, namespace: "boundary" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents: modules[args.path] }));
    } }],
  });
  const { toolComputer, toolFormInput, toolSelectOption, toolFind, toolReadPage } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString("base64")}`);
  const run = (states, error, text = "Enter") => {
    commands = []; paints = [...states]; captureError = error; inputError = undefined;
    return toolComputer({ tabId: 1, action: "key", text });
  };
  const ready = { document: 10, painted: true }, deferred = { document: 10, painted: false };
  const keys = () => commands.filter(command => command.method === "Input.dispatchKeyEvent");
  await run([ready]);
  assert.equal(commands.some(command => command.method === "Page.captureScreenshot"), false);
  assert.deepEqual(keys().map(command => command.params.type), ["keyDown", "keyUp"]);
  await run([deferred, ready]);
  assert.deepEqual(commands.map(command => command.method), ["Runtime.evaluate", "Page.captureScreenshot", "Runtime.evaluate", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
  const capture = commands[1].params;
  assert.equal(capture.captureBeyondViewport, false); assert.equal(capture.clip, undefined);
  assert.equal(capture.quality, 0);
  await run([deferred, deferred, ready]);
  assert.equal(commands.filter(command => command.method === "Page.captureScreenshot").length, 1);
  assert.deepEqual(commands.map(command => command.method), [
    "Runtime.evaluate", "Page.captureScreenshot", "Runtime.evaluate", "Runtime.evaluate",
    "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
  ], "the key waits for a later same-document paint marker without capturing again");
  assert.deepEqual(keys().map(command => command.params.type), ["keyDown", "keyUp"]);
  const originalNow = Date.now;
  let now = 1000, paintReads = 0;
  try {
    Date.now = () => now;
    paintReadHook = () => { if (++paintReads === 2) now += 251; };
    await assert.rejects(run([deferred, ready]), /first paint.*250ms/);
    assert.equal(keys().length, 0, "a ready response arriving after the observation deadline cannot authorize input");
    assert.equal(commands.filter(command => command.method === "Page.captureScreenshot").length, 1);
  } finally { Date.now = originalNow; paintReadHook = undefined; }
  for (const [states, error, expected] of [
    [[deferred], new Error("capture unavailable"), /capture unavailable/],
    [[deferred, { ...ready, document: 11 }], undefined, /Page changed/],
    [[deferred, deferred], undefined, /first paint.*250ms/],
    [[undefined], undefined, /readiness unavailable/],
  ]) {
    await assert.rejects(run(states, error), expected);
    assert.equal(keys().length, 0, "failed readiness never dispatches or retries a key");
    assert.ok(commands.filter(command => command.method === "Page.captureScreenshot").length <= 1);
  }
  await assert.rejects(run([], undefined, "Enter F13"), /unknown key name/);
  assert.deepEqual(commands, [], "whole-sequence validation precedes readiness and input");
  commands = []; paints = [ready]; inputError = new Error("ambiguous key-up failure");
  await assert.rejects(toolComputer({ tabId: 1, action: "key", text: "Enter" }), /ambiguous key-up/);
  assert.deepEqual(keys().map(command => command.params.type), ["keyDown", "keyUp"], "a dispatched key is never repeated after an uncertain release");
  commands = []; paints = [true];
  await assert.rejects(toolComputer({ tabId: 1, action: "type", text: "once" }), /ambiguous key-up/);
  assert.equal(commands.filter(command => command.method === "Input.insertText").length, 1);
  assert.equal(syntheticCalls, 0, "trusted keyboard errors never fall back to synthetic events or submit");
  // Each check below reports on its own, so one failure cannot hide another.
  const failures = [];
  const check = async (name, run) => {
    try { await run(); console.log(`  ✓ ${name}`); }
    catch (error) { failures.push(name); console.error(`  ✗ ${name}: ${error.message}`); }
  };
  const injected = [];
  globalThis[Symbol.for("tabai-keyboard-synthetic-test")] = async injection => { injected.push(injection.func?.name); return [{ result: { ok: true } }]; };
  const inputs = () => commands.filter(command => command.method.startsWith("Input."));
  await check("type without a ref while focus is inside a frame names the frame-ref route", async () => {
    commands = []; paints = ["frame"]; inputError = undefined; injected.length = 0;
    await assert.rejects(toolComputer({ tabId: 1, action: "type", text: "lost" }),
      error => /inside a frame/i.test(error.message) && /ref_N@frameId/.test(error.message) || assert.fail(error.message));
    assert.deepEqual(inputs(), [], "no text is inserted into an unknown frame");
    assert.deepEqual(injected, [], "the refusal never falls back to synthetic typing");
  });
  for (const action of ["type", "key"]) {
    await check(`${action} with a main-frame ref authenticates and focuses the ref before any input`, async () => {
      commands = []; paints = action === "type" ? [true] : [ready]; inputError = undefined; injected.length = 0;
      await assert.rejects(toolComputer({ tabId: 1, action, ref: "ref_1", text: "a" }),
        error => error.name === "NoFallbackError" && /Reference|ref/i.test(error.message) || assert.fail(`${error.name}: ${error.message}`));
      assert.deepEqual(inputs(), [], "an unauthenticated ref dispatches no keyboard input");
      assert.ok(!injected.includes("pageInteract"), "trusted keyboard input never falls back to synthetic events");
    });
  }
  await check("find bounds its total output and marks the cut", async () => {
    globalThis[Symbol.for("tabai-keyboard-synthetic-test")] = async () => [
      { frameId: 0, result: Array.from({ length: 20 }, (_, index) => `[ref_${index}] button "${"x".repeat(1500)}"`).join("\n") },
      { frameId: 3, result: '[ref_1] button "frame match"' },
    ];
    const found = await toolFind({ tabId: 1, query: "x" });
    assert.ok(found.matches.length <= 12_000 + 20, `matches length ${found.matches.length}`);
    assert.match(found.matches, /…\(truncated\)$/);
  });
  assert.deepEqual(failures, [], "keyboard focus and find bound checks");
  const actualNow = Date.now;
  let nowForActionability = 1000, lateProbes = 0, mutations = 0;
  try {
    Date.now = () => nowForActionability;
    globalThis[Symbol.for("tabai-keyboard-synthetic-test")] = async injection => {
      if (injection.func.name === "sampleActionableInPage") {
        lateProbes++;
        nowForActionability += 6000;
        return [{ frameId: 0, documentId: "document-a", result: { ok: true, rect: { x: 0, y: 0, w: 10, h: 10 } } }];
      }
      mutations++;
      return [{ frameId: 0, documentId: "document-a", result: { ok: true } }];
    };
    for (const act of [
      () => toolComputer({ tabId: 1, action: "left_click", ref: "ref_1", documentId: "document-a" }),
      () => toolFormInput({ tabId: 1, ref: "ref_1", value: "must-not-write" }),
      () => toolSelectOption({ tabId: 1, ref: "ref_1", value: "must-not-select" }),
    ]) {
      commands = [];
      await assert.rejects(act(), error => error.code === "TIMEOUT");
      assert.equal(mutations, 0, "a late actionability observation never reaches a mutating injection");
      assert.deepEqual(commands, [], "a late actionability observation never dispatches CDP input");
    }
    assert.equal(lateProbes, 3);
  } finally { Date.now = actualNow; }
  {
    // A small fake DOM shows what each keyboard path decides about the named
    // control before anything is dispatched. focus() moves the active element
    // unless the control is disabled, as a browser does.
    const { default: vm } = await import("node:vm");
    const keyboardFailures = [];
    const keyboardCheck = async (name, run) => {
      try { await run(); console.log(`  ✓ ${name}`); }
      catch (error) { keyboardFailures.push(name); console.error(`  ✗ ${name}: ${error.message}`); }
    };
    await keyboardCheck("read_page cuts its listing at a line end and marks the cut", async () => {
      const line = index => `[ref_${String(index).padStart(50, "0")}] button "${"y".repeat(80)}"`;
      globalThis[Symbol.for("tabai-keyboard-synthetic-test")] = async () => [
        { frameId: 0, result: Array.from({ length: 40 }, (_, index) => line(index)).join("\n") },
      ];
      const listed = await toolReadPage({ tabId: 1, maxChars: 1000 });
      const lines = listed.elements.split("\n");
      assert.equal(lines.pop(), "…(truncated)");
      assert.ok(lines.length > 0 && listed.elements.length <= 1000 + 20, `elements length ${listed.elements.length}`);
      lines.forEach((entry, index) => assert.equal(entry, line(index), "every listed line is whole, so no ref is cut"));
    });
    const page = () => {
      const document = { activeElement: null };
      const make = (tagName, props = {}) => ({
        tagName, disabled: false, readOnly: false, isContentEditable: false, parentElement: null, shadowRoot: null,
        value: "held", events: [], focusCalls: 0, ownerDocument: document, isConnected: true, attrs: {},
        getAttribute(key) { return this.attrs[key] ?? null; },
        matches(selector) { return selector === ":disabled" ? this.disabled : false; },
        getRootNode() { return document; }, contains(node) { return node === this; },
        focus() { this.focusCalls++; if (!this.disabled) document.activeElement = this; },
        dispatchEvent(event) { this.events.push(event.type); return true; },
        ...props,
      });
      document.activeElement = make("BODY");
      return { document, make };
    };
    const bundle = async (entry, modules) => {
      const output = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
        plugins: [{ name: "keyboard-dom-boundary", setup(plugin) {
          plugin.onResolve({ filter: /^\.\// }, args => modules[args.path] ? { path: args.path, namespace: "keyboard-dom" } : undefined);
          plugin.onLoad({ filter: /.*/, namespace: "keyboard-dom" }, args => ({ contents: modules[args.path] }));
        } }] });
      return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
    };
    const trusted = Symbol.for("tabai-keyboard-trusted-test");
    const { cdpInteract } = await bundle("extension/src/computer-input.ts", {
      "./cdp": "export const cdpSend=(_tab,method,params)=>globalThis[Symbol.for('tabai-keyboard-trusted-test')].cdp(method,params)",
      "./element-ref": "export const parseRef=ref=>({base:ref.split('@')[0],frameId:Number(ref.split('@')[1]??0)});export const deepByAttrExpr=()=>'globalThis.__target';export const evaluateRefInTab=(_tab,_ref,expression)=>globalThis[Symbol.for('tabai-keyboard-trusted-test')].evaluate(expression)",
    });
    // The trusted path's focus check runs as the real expression against the fake page.
    const trustedRun = async (tagName, props, action, text) => {
      const { document, make } = page();
      const target = make(tagName, props);
      const context = vm.createContext({ document, __target: target });
      const inputs = [];
      globalThis[trusted] = {
        cdp: async (method, params) => {
          if (method === "Runtime.evaluate") return { result: { value: { document: 1, painted: true } } };
          inputs.push(method);
          return {};
        },
        evaluate: async expression => ({ result: { value: vm.runInContext(expression, context) } }),
      };
      let error;
      try { await cdpInteract({ tabId: 1, action, ref: "ref_1", text }); } catch (caught) { error = caught; }
      return { error, inputs, target };
    };
    const { pageInteract } = await bundle("extension/src/injected-interaction-scripts.ts", {});
    // The synthetic path runs serialized, as Chrome rebuilds it in the page.
    const syntheticRun = (props, action, text) => {
      const { document, make } = page();
      const namespace = "1".repeat(40), ref = `ref_${namespace}${"0".repeat(9)}1`, submits = [];
      const target = make("INPUT", { attrs: { "data-ccmcp-ref": ref }, form: { requestSubmit: () => submits.push(ref) }, ...props });
      document.querySelectorAll = selector => selector === `[data-ccmcp-ref="${ref}"]` || selector === "*" ? [target] : [];
      const event = class { constructor(type) { this.type = type; } };
      const context = vm.createContext({ document, window: { __ccmcpRefState: { document, namespace }, __ccmcpRefMap: { [ref]: target } },
        Event: event, KeyboardEvent: event, MouseEvent: event, HTMLInputElement: class {}, HTMLTextAreaElement: class {} });
      const result = vm.runInContext(`(${pageInteract.toString()})`, context)(action, { ref, text });
      return { result, target, submits };
    };
    for (const [label, props, pattern] of [["read-only", { readOnly: true }, /not an editable field/], ["disabled", { disabled: true }, /keyboard focus|not an editable field/]]) {
      await keyboardCheck(`trusted type with a ref to a ${label} field is refused before any text is inserted`, async () => {
        const { error, inputs } = await trustedRun("INPUT", props, "type", "abc");
        assert.ok(error?.name === "NoFallbackError" && pattern.test(error.message), String(error?.message ?? "typed"));
        assert.deepEqual(inputs, [], "no text is inserted");
      });
    }
    for (const action of ["type", "key"]) {
      await keyboardCheck(`trusted ${action} with a ref to a frame element is refused and names the field's own frame ref`, async () => {
        const { error, inputs, target } = await trustedRun("IFRAME", {}, action, "z");
        assert.ok(error?.name === "NoFallbackError" && /frame/i.test(error.message) && /ref_N@frameId/.test(error.message), String(error?.message ?? `${action} dispatched`));
        assert.deepEqual(inputs, [], "nothing reaches whatever is focused inside the frame");
        assert.equal(target.focusCalls, 0, "the frame element is not focused either");
      });
    }
    await keyboardCheck("trusted type with a ref to an ordinary field still inserts the text", async () => {
      const { error, inputs } = await trustedRun("INPUT", {}, "type", "abc");
      assert.equal(error, undefined, error?.message);
      assert.deepEqual(inputs, ["Input.insertText"]);
    });
    for (const [label, props, pattern] of [["read-only", { readOnly: true }, /read-only/], ["disabled", { disabled: true }, /disabled/]]) {
      await keyboardCheck(`synthetic type with a ref to a ${label} field is refused before anything is dispatched`, () => {
        const { result, target } = syntheticRun(props, "type", "abc");
        assert.ok(result.ok === false && pattern.test(result.error), JSON.stringify(result));
        assert.equal(target.value, "held", "the value is unchanged");
        assert.deepEqual([target.events, target.focusCalls], [[], 0], "no focus and no input event");
      });
    }
    await keyboardCheck("synthetic key Enter with a ref to a disabled field submits nothing", () => {
      const { result, target, submits } = syntheticRun({ disabled: true }, "key", "Enter");
      assert.ok(result.ok === false && /disabled/.test(result.error), JSON.stringify(result));
      assert.deepEqual(submits, [], "the form is not submitted");
      assert.deepEqual([target.events, target.focusCalls], [[], 0], "no focus and no key event");
    });
    await keyboardCheck("synthetic type and key Enter with a ref to an ordinary field still act", () => {
      const typed = syntheticRun({}, "type", "abc");
      assert.equal(typed.result.ok, true, typed.result.error);
      assert.equal(typed.target.value, "heldabc");
      const pressed = syntheticRun({}, "key", "Enter");
      assert.equal(pressed.result.ok, true, pressed.result.error);
      assert.equal(pressed.submits.length, 1);
    });
    delete globalThis[trusted];
    assert.deepEqual(keyboardFailures, [], "keyboard checks against a fake DOM");
  }
  console.log("Actionability handlers: late page samples cannot dispatch clicks, form values or selection");
  console.log("Keyboard readiness: painted fast path, one hidden capture, navigation/failure fences and no key replay passed");
} finally { delete globalThis[probe]; delete globalThis[Symbol.for("tabai-keyboard-synthetic-test")]; stopWatchdog(); }
