import assert from "node:assert/strict";
import { build } from "esbuild";
import { watchdog } from "./watchdog.mjs";

// A six-second capture timer keeps this file running past its checks.
const stopWatchdog = watchdog(undefined, 90_000);
let preference, storageFailure = false, captureWorks = false;
let active = false, focused = false;
const mutations = [];
globalThis.chrome = {
  storage: { local: { async get() {
    if (storageFailure) throw new Error("storage unavailable");
    return { allowAgentFocus: preference };
  } } },
  tabs: {
    async get(id) { return { id, windowId: 7, active }; },
    async update(id, changes) { mutations.push({ tab: id, ...changes }); active = changes.active; },
    async captureVisibleTab() { return "data:image/png;base64,visible-image"; },
    async query() { return [{ id: 12, active }]; },
  },
  windows: {
    async get() { return { focused, state: "normal" }; },
    async update(id, changes) { mutations.push({ window: id, ...changes }); },
  },
};
globalThis.focusFixture = {
  async assertTabInGroup(session, id) {
    assert.equal(session, "owner");
    return chrome.tabs.get(id);
  },
  async cdpSend() {
    if (captureWorks) return { data: "background-image" };
    throw new Error("capture unavailable");
  },
};
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export { toolTabSwitch } from './extension/src/tab-tools.ts';
  export { browserPointer } from './extension/src/browser-pointer.ts';
  export { captureComputerScreenshot } from './extension/src/capture-tools.ts';
` }, bundle: true, write: false, platform: "node", format: "esm", plugins: [{
  name: "focus-boundaries", setup(build) {
    build.onResolve({ filter: /^\.\/(tab-group-helpers|cdp|diagnostics|visual-presence|page-wait)$/ }, args =>
      ({ path: args.path, namespace: "focus-test" }));
    build.onLoad({ filter: /.*/, namespace: "focus-test" }, args => ({ contents: {
      "./tab-group-helpers": `export const assertTabInGroup=(...args)=>globalThis.focusFixture.assertTabInGroup(...args);
        export const sessionOf=()=>"owner",tabSummary=t=>({tabId:t.id,active:t.active});
        export const createMcpGroup=()=>{},dropGroupIfStale=()=>{},getGroupId=()=>{},tabsInGroup=()=>{};
        export const refreshGroupIdentity=()=>{throw new Error("unexpected group mutation")};
        export const ensureGroupIdentityCurrent=()=>{throw new Error("unexpected group mutation")};`,
      "./cdp": `export const cdpSend=(...args)=>globalThis.focusFixture.cdpSend(...args),cssViewportClip=async()=>null;
        export const withRuntimeDomain=(_tab,operation)=>operation();`,
      "./diagnostics": `export const traceOperation=(_s,_n,run)=>run(),executeScript=()=>{throw new Error("unexpected page input")};`,
      "./visual-presence": `export const withoutPresence=(_id,run)=>run();`,
      "./page-wait": `export const waitInTab=()=>{};
        export const waitForActionableRef=()=>{throw new Error("unexpected ref wait")};`,
    }[args.path] }));
  },
}] });
const { toolTabSwitch, browserPointer, captureComputerScreenshot } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const tabId = 12;
try {
  for (preference of [undefined, false, "true"]) {
    await assert.rejects(toolTabSwitch({ tabId, bringToFront: true }), /FOCUS_DISABLED|Tillåt att agenter tar fram Chrome/);
    await assert.rejects(browserPointer("owner", { tabId, action: "left_click", coordinate: [10, 10], allowFocus: true }),
      /FOCUS_DISABLED|Tillåt att agenter tar fram Chrome/);
    await assert.rejects(captureComputerScreenshot("owner", { tabId, allowFocus: true }),
      /FOCUS_DISABLED|Tillåt att agenter tar fram Chrome/);
    assert.deepEqual(mutations, [], "blocked focus requests must not select a tab or focus a window");
  }
  captureWorks = true;
  assert.equal((await captureComputerScreenshot("owner", { tabId, allowFocus: true })).source, "cdp");
  assert.deepEqual(mutations, [], "background screenshots need no focus permission");
  captureWorks = false; active = true; focused = true;
  assert.equal((await captureComputerScreenshot("owner", { tabId, allowFocus: true })).source, "captureVisibleTab");
  assert.deepEqual(mutations, [], "an already visible fallback needs no focus permission or activation");
  await toolTabSwitch({ tabId });
  assert.deepEqual(mutations.splice(0), [{ tab: tabId, active: true }], "background selection remains available");
  preference = true;
  await toolTabSwitch({ tabId, bringToFront: true });
  assert.deepEqual(mutations.splice(0), [{ tab: tabId, active: true }, { window: 7, focused: true }]);
  storageFailure = true;
  await assert.rejects(toolTabSwitch({ tabId, bringToFront: true }), /storage unavailable/);
  assert.deepEqual(mutations, [], "unavailable preferences must fail closed before any focus mutation");
  console.log("Agent focus: default denial, explicit user opt-in, background capture and fail-closed storage passed");
} finally {
  delete globalThis.chrome;
  delete globalThis.focusFixture;
  stopWatchdog();
}
