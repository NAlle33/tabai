import assert from "node:assert/strict";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
let active = true, focused = true, allowed = true, documentId = "document-a", move = false, failSend = false;
const commands = [], activations = [];
let probes = 0, actionabilityHook;
globalThis.pointerFixture = {
  async assertTabInGroup(session, tabId) {
    if (session !== "owner" || !allowed) throw new Error("TAB_NOT_IN_GROUP");
    return { id: tabId, windowId: 7, active };
  },
  async cdpSend(tabId, method, params, guard) {
    await guard(); commands.push({ tabId, method, params });
    if (failSend && params.type === "mousePressed") throw new Error("ambiguous transport failure");
  },
};
globalThis.chrome = {
  storage: { local: { async get() { return { allowAgentFocus: true }; } } },
  tabs: { async update(_id, value) { activations.push(value); active = true; } },
  windows: { async get() { return { focused, state: "normal" }; }, async update(_id, value) { activations.push(value); focused = true; } },
  scripting: { async executeScript(injection) {
    if (injection.target.documentIds && injection.target.documentIds[0] !== documentId) throw new Error("No document with id");
    let result;
    if (injection.func.name === "pointerTargetInPage") {
      probes++;
      result = { x: move && probes > 2 ? 120 : 100, y: 50, visible: true, focused: true };
    } else if (injection.func.name === "sampleActionableInPage") {
      await actionabilityHook?.();
      result = { ok: true, rect: { x: 10, y: 20, w: 40, h: 30 } };
    }
    else result = true;
    return [{ frameId: 0, documentId, result }];
  } },
};
const bundle = await build({ entryPoints: ["extension/src/browser-pointer.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "pointer-boundaries", setup(build) {
    build.onResolve({ filter: /^\.\/(cdp|tab-group-helpers)$/ }, args => ({ path: args.path, namespace: "pointer-test" }));
    build.onLoad({ filter: /.*/, namespace: "pointer-test" }, args => ({ contents: args.path === "./cdp"
      ? "export const cdpSend = (...args) => globalThis.pointerFixture.cdpSend(...args); export const withRuntimeDomain=(_tab,operation)=>operation();"
      : "export const assertTabInGroup = (...args) => globalThis.pointerFixture.assertTabInGroup(...args);" }));
  } }] });
const { browserPointer } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const args = { action: "left_click", tabId: 12, ref: "ref_1" };
try {
  assert.equal((await browserPointer("owner", args)).via, "browser-pointer");
  assert.deepEqual(commands.map(c => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert(commands.every(c => c.params.x === 100 && c.params.y === 50), "CSS points are never multiplied by DPR");
  commands.length = 0;
  active = false;
  await assert.rejects(browserPointer("owner", args), /allowFocus:true/);
  assert.equal(activations.length, 0); assert.equal(commands.length, 0);
  focused = false;
  await browserPointer("owner", { ...args, allowFocus: true });
  assert.deepEqual(activations, [{ active: true }, { focused: true }]);
  commands.length = 0;
  for (const invalid of [{ ref: "ref_1@2" }, { action: "hover" }, { coordinate: [NaN, 2], ref: undefined }, { ref: "ref_1", coordinate: [1, 2] }])
    await assert.rejects(browserPointer("owner", { ...args, ...invalid }));
  await assert.rejects(browserPointer("foreign", args), /TAB_NOT_IN_GROUP/);
  await assert.rejects(browserPointer("owner", { ...args, documentId: "replaced-document" }), /No document/);
  assert.equal(commands.length, 0);
  probes = 0; move = true;
  await assert.rejects(browserPointer("owner", args), /target moved/);
  assert.equal(commands.length, 0, "geometry drift fails before any dispatch");
  move = false; failSend = true;
  await assert.rejects(browserPointer("owner", args), /No fallback or replay/);
  assert.equal(commands.filter(c => c.params.type === "mousePressed").length, 1);
  assert(commands.every(c => c.method === "Input.dispatchMouseEvent"), "no evaluator/synthetic fallback");
  commands.length = 0; failSend = false;
  const actualNow = Date.now;
  let clock = 1000;
  try {
    Date.now = () => clock;
    actionabilityHook = () => { clock += 6000; };
    await assert.rejects(browserPointer("owner", args), error => error.code === "TIMEOUT");
    assert.equal(commands.length, 0, "a late ref sample must not dispatch trusted pointer input");
  } finally { Date.now = actualNow; actionabilityHook = undefined; }
  actionabilityHook = () => { documentId = "replacement-document"; };
  await assert.rejects(browserPointer("owner", args), /mismatch|No document/);
  assert.equal(commands.length, 0, "document replacement must not dispatch trusted pointer input");
  actionabilityHook = () => { allowed = false; };
  await assert.rejects(browserPointer("owner", args), /TAB_NOT_IN_GROUP/);
  assert.equal(commands.length, 0, "ownership loss during actionability must block trusted input");
  allowed = true; actionabilityHook = undefined;
  pointerFixture.cdpSend = async (_tab, _method, params, guard) => {
    if (params.type === "mousePressed") allowed = false;
    await guard(); commands.push(params);
  };
  await assert.rejects(browserPointer("owner", args), /TAB_NOT_IN_GROUP/);
  assert.equal(commands.length, 1, "lost ownership blocks the press after mouse movement");
  console.log("Browser pointer: explicit focus, unsupported targets, document/geometry/ownership guards and no replay passed");
} finally { delete globalThis.chrome; delete globalThis.pointerFixture; stopWatchdog(); }
