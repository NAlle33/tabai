// Exercise the real coordinator and ownership helpers at the Chrome API boundary.
// No page or production extension is changed by these deliberately stalled APIs.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { setTimeout as delay } from "node:timers/promises";
import { createHmac } from "node:crypto";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const bundle = await build({ entryPoints: ["extension/src/visual-presence.ts"], bundle: true,
  write: false, platform: "node", format: "esm", logLevel: "silent" });
let fixtureNumber = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise, message, ms = 1800) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture({ startup, render, update } = {}) {
  const calls = [], listeners = {}, identityWrites = [], stored = {};
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const groups = { aaaa: 1, bbbb: 2 };
  const tabs = new Map([[11, { id: 11, groupId: 1, url: "https://fixture.test" }],
    [12, { id: 12, groupId: 1, url: "https://fixture.test" }],
    [21, { id: 21, groupId: 2, url: "https://fixture.test" }]]);
  globalThis.chrome = {
    runtime: { id: "fixture", getURL: () => "data:image/png;base64,", onStartup: event("startup") },
    storage: { local: { get: async key => key === "showVisualPresence"
      ? (startup ? startup.promise : { showVisualPresence: true })
      : key in stored ? { [key]: stored[key] } : { mcpGroups: { ...groups } },
      set: async values => {
        if (values.mcpGroups) Object.assign(groups, values.mcpGroups);
        for (const key of Object.keys(values)) {
          if (key.startsWith("mcpGroupIdentity:")) identityWrites.push(key);
          else if (key !== "mcpGroups") stored[key] = values[key];
        }
      } },
      onChanged: event("storage") },
    tabs: { get: async id => tabs.get(id), query: async ({ groupId }) => [...tabs.values()].filter(t => t.groupId === groupId),
      onUpdated: event("tab"), onRemoved: event("removed"), onCreated: event("created") },
    tabGroups: { get: async id => ({ title: `MCP·${id === 1 ? "aaaa" : "bbbb"}` }),
      update: async (...args) => update?.(...args), onUpdated: event("group") },
    debugger: { getTargets: async () => [...tabs.keys()].map(tabId => ({ tabId, id: `target:${tabId}`, type: 'page' })) },
    scripting: { executeScript: async args => {
      calls.push({ tabId: args.target.tabId, mode: args.args[1], owner: args.args[0], args: args.args });
      return render ? render(args, calls) : [{ result: !["hidden", "remove"].includes(args.args[1]) }];
    } },
  };
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}#${++fixtureNumber}`);
  return { ...module, calls, listeners, groups, tabs, identityWrites, stored };
}
/** The page sees only keyed hashes: of the origin, and of origin plus session. */
function presenceToken(f, ...parts) {
  const key = f.stored.presenceMarkerKey;
  assert.equal(typeof key, "string", "the marker key is persisted in extension storage");
  return createHmac("sha256", Buffer.from(key, "base64")).update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
let passed = 0;
async function test(name, run) { await run(); console.log(`  ✓ ${name}`); passed++; }

await test("stalled rendering cannot hold commands or completed context replies", async () => {
  const gate = deferred();
  const f = await fixture({ render: args => args.target.tabId === 11 ? gate.promise : [{ result: true }] });
  let actions = 0;
  try {
    const work = f.withPresence("aaaa", "javascript_tool", { tabId: 11 }, async () => ++actions);
    await flush();
    assert.equal(await bounded(f.withPresence("bbbb", "javascript_tool", { tabId: 21 }, async () => "other"), "other session blocked"), "other");
    assert.equal(await bounded(work, "cosmetics blocked the actual handler"), 1);
    assert.equal(actions, 1);
    assert.equal(await bounded(f.withPresence("aaaa", "tabs_context_mcp", {}, async () => "context"), "completed context reply blocked"), "context");
    for (let i = 0; i < 30; i++) f.listeners.tab?.(11, { status: "complete" });
    assert.equal(f.calls.filter(c => c.tabId === 11).length, 1, "one in-flight render per tab");
  } finally { gate.resolve([{ result: true }]); await flush(); }
});

await test("initial reconciliation cannot stall health or another session", async () => {
  const gate = deferred();
  const f = await fixture({ render: args => args.target.tabId === 11 ? gate.promise : [{ result: true }] });
  f.initializePresence();
  try {
    assert.equal(await bounded(f.withPresence("bbbb", "health", {}, async () => "healthy"), "startup reconciliation held health"), "healthy");
    assert.equal(await bounded(f.withPresence("bbbb", "javascript_tool", { tabId: 21 }, async () => "ok"), "startup held another session"), "ok");
  } finally { gate.resolve([{ result: true }]); await flush(); }
});

await test("an unresolved preferences read cannot hold tool dispatch", async () => {
  const gate = deferred();
  const f = await fixture({ startup: gate });
  f.initializePresence();
  try {
    assert.equal(await bounded(f.withPresence("bbbb", "health", {}, async () => "ok"), "preferences held health"), "ok");
  } finally { gate.resolve({ showVisualPresence: true }); await flush(); }
});

await test("a stalled cosmetic group update does not hold ownership writes", async () => {
  const gate = deferred();
  const f = await fixture({ update: () => gate.promise });
  try {
    const context = f.withPresence("aaaa", "tabs_context_mcp", {}, async () => "context");
    await flush();
    // Dropping a stale mapping takes the real helpers' ownership write lock.
    f.groups.bbbb = 99;
    chrome.tabGroups.get = async id => ({ title: id === 99 ? "Personal" : "MCP·aaaa" });
    assert.equal(await bounded(f.withPresence("bbbb", "javascript_tool", { tabId: 21 }, async () => "handler"), "cosmetic update held ownership lock"), "handler");
    assert.equal(await bounded(context, "group appearance held context reply"), "context");
  } finally { gate.resolve(); await flush(); }
});

await test("rejected cosmetics preserve the exact handler result/error without retry", async () => {
  const f = await fixture({ render: async () => { throw new Error("render rejected"); } });
  const result = { ok: true }, failure = new Error("original action failed");
  let count = 0;
  assert.equal(await f.withPresence("aaaa", "javascript_tool", { tabId: 11 }, async () => { count++; return result; }), result);
  await assert.rejects(f.withPresence("aaaa", "javascript_tool", { tabId: 11 }, async () => { count++; throw failure; }), error => error === failure);
  assert.equal(count, 2);
});

await test("an unconfirmed first render refuses capture and coalesces late work", async () => {
  const gate = deferred();
  let held = true, captured = false;
  const f = await fixture({ render: args => held && args.target.tabId === 11 ? gate.promise : [{ result: args.args[1] !== "hidden" }] });
  try {
    await bounded(f.withPresence("aaaa", "get_page_text", { tabId: 11 }, async () => "done"), "first render held tool");
    await assert.rejects(bounded(f.withoutPresence(11, async () => { captured = true; }), "capture suppression never settled"), /presence|hid|capture refused/i);
    assert.equal(captured, false, "no capture while an earlier paint may still execute");
    f.initializePresence();
    await flush();
    for (let i = 0; i < 100; i++) f.listeners.tab(11, { status: "complete" });
    const before = f.calls.filter(c => c.tabId === 11).length;
    held = false; gate.resolve([{ result: true }]); await delay(30);
    assert.ok(f.calls.filter(c => c.tabId === 11).length - before <= 1, "only one coalesced repaint after release");
  } finally { held = false; gate.resolve([{ result: true }]); await flush(); }
});

await test("capture waits for late paint, stays hidden across overlap and restores without blocking", async () => {
  const first = deferred(), captureA = deferred(), captureB = deferred(), restore = deferred();
  let mode = "idle", hold = true, restoring = false;
  const f = await fixture({ render: async args => {
    if (hold) { hold = false; await first.promise; }
    if (restoring && args.args[1] !== "hidden") await restore.promise;
    mode = args.args[1]; return [{ result: mode !== "hidden" }];
  } });
  const work = f.withPresence("aaaa", "javascript_tool", { tabId: 11 }, async () => "done");
  await flush();
  let started = 0;
  const shot = gate => f.withoutPresence(11, async () => { assert.equal(mode, "hidden"); started++; return gate.promise; });
  const a = shot(captureA), b = shot(captureB);
  try {
    await flush(); assert.equal(started, 0);
    first.resolve(); await flush(); await flush();
    assert.equal(started, 2);
    captureA.resolve("a"); assert.equal(await bounded(a, "first capture did not return"), "a");
    assert.equal(mode, "hidden");
    restoring = true; captureB.resolve("b");
    assert.equal(await bounded(b, "restore blocked finished capture"), "b");
    await bounded(work, "restore blocked finished action");
  } finally { first.resolve(); captureA.resolve(); captureB.resolve(); restore.resolve(); await flush(); }
});

await test("failed hiding refuses capture even when visibility was not confirmed", async () => {
  const f = await fixture({ render: async () => { throw new Error("cannot hide presence"); } });
  await f.withPresence("aaaa", "get_page_text", { tabId: 11 }, async () => "ok");
  let captures = 0;
  await assert.rejects(f.withoutPresence(11, async () => { captures++; }), /cannot hide presence/);
  assert.equal(captures, 0);
});
await test("missing presence state cannot authorize a capture during startup", async () => {
  const f = await fixture();
  let captured = false;
  await assert.rejects(f.withoutPresence(11, async () => { captured = true; }), /ownership.*capture refused/);
  assert.equal(captured, false);
});
await test("retired owners retain the original queue and capture suppression", async () => {
  const gate = deferred();
  let holding = false;
  const f = await fixture({ render: async args => {
    if (args.args[1] === "remove" && holding) await gate.promise;
    return [{ result: !["hidden", "remove"].includes(args.args[1]) }];
  } });
  await f.withPresence("aaaa", "get_page_text", { tabId: 11 }, async () => "ok");
  holding = true;
  f.reapPresence("aaaa"); await flush();
  f.tabs.get(11).groupId = 2;
  try {
    assert.equal(await bounded(f.withPresence("bbbb", "get_page_text", { tabId: 11 }, async () => "new owner"), "old owner blocked new handler"), "new owner");
    let captures = 0;
    await assert.rejects(f.withoutPresence(11, async () => { captures++; }), /capture refused/);
    assert.equal(captures, 0);
    holding = false; gate.resolve(); await flush();
    await f.withoutPresence(11, async () => {
      assert.equal(f.calls.at(-1).owner, presenceToken(f, "owner", "https://fixture.test", "bbbb"));
      assert.equal(f.calls.at(-1).mode, "hidden");
    });
  } finally { holding = false; gate.resolve(); await flush(); }
});
await test("regrouping restores presence while another tab's rendering is stalled", async () => {
  const gate = deferred();
  const f = await fixture({ render: args => args.target.tabId === 12 ? gate.promise
    : [{ result: !["hidden", "remove"].includes(args.args[1]) }] });
  await f.withPresence("aaaa", "get_page_text", { tabId: 11 }, async () => "ok");
  f.initializePresence(); await flush();
  try {
    f.tabs.get(11).groupId = -1;
    f.listeners.tab(11, { groupId: -1 }); await flush();
    assert.equal(f.calls.filter(c => c.tabId === 11).at(-1).mode, "remove");
    f.tabs.get(11).groupId = 1;
    f.listeners.tab(11, { groupId: 1 }); await flush();
    assert.equal(f.calls.filter(c => c.tabId === 11).at(-1).mode, "idle");
  } finally { gate.resolve([{ result: true }]); await flush(); }
});
await test("hiding retires an older Tabai surface on this origin in both retained and replaced worlds", async () => {
  const renderer = await build({ entryPoints: ["extension/src/presence-script.ts"], bundle: true,
    write: false, platform: "node", format: "esm", logLevel: "silent" });
  const { renderPresence } = await import(`data:text/javascript;base64,${Buffer.from(renderer.outputFiles[0].text).toString("base64")}`);
  const node = marker => ({ visible: true, getAttribute: () => marker, remove() { this.visible = false; } });
  try {
    // Markers are `<origin token>:<owner token>`; the leftover belongs to another session.
    const retained = node("origin-token:old-owner");
    globalThis.window = { __ccmcpPresence: { owner: "old-owner", host: retained } };
    globalThis.document = { querySelectorAll: () => [retained] };
    assert.equal(await renderPresence("new-owner", "hidden", "", "origin-token"), false);
    assert.equal(retained.visible, false, "a previous owner's badge cannot remain in a capture");
    const orphan = node("origin-token:old-owner"), unrelated = node("another-token:owner");
    globalThis.window = {};
    globalThis.document = { querySelectorAll: () => [orphan, unrelated] };
    assert.equal(await renderPresence("new-owner", "hidden", "", "origin-token"), false);
    assert.equal(orphan.visible, false, "a leftover surface from another session is retired");
    assert.equal(unrelated.visible, true, "do not remove a marker this key did not produce");
    // A surface from a version that wrote `<extension id>:<session id>` is this extension's
    // too. It is retired when the tab is painted, hidden for a capture or released; the
    // same marker under another extension's ID is left alone.
    const previousChrome = globalThis.chrome;
    try {
      for (const mode of ["hidden", "remove"]) {
        const legacy = node("this-extension:sess-old"), foreign = node("other-extension:sess-old");
        globalThis.chrome = { runtime: { id: "this-extension" } };
        globalThis.window = {};
        globalThis.document = { querySelectorAll: () => [legacy, foreign] };
        assert.equal(await renderPresence("new-owner", mode, "", "origin-token"), false);
        assert.equal(legacy.visible, false, `a surface in the earlier marker format is retired (${mode})`);
        assert.equal(foreign.visible, true, "another extension's surface stays");
      }
    } finally { globalThis.chrome = previousChrome; }
  } finally { delete globalThis.window; delete globalThis.document; }
});
await test("the page marker carries neither the session nor the extension ID and differs per origin", async () => {
  const f = await fixture();
  const session = "sess-zz-0123";
  f.groups[session] = 3;
  f.tabs.set(31, { id: 31, groupId: 3, url: "https://one.test/a" });
  f.tabs.set(32, { id: 32, groupId: 3, url: "https://two.test/b" });
  chrome.tabGroups.get = async id => ({ title: id === 3 ? "MCP·sess" : `MCP·${id === 1 ? "aaaa" : "bbbb"}` });
  for (const tabId of [31, 32]) await f.withPresence(session, "get_page_text", { tabId }, async () => "ok");
  const painted = tabId => f.calls.filter(call => call.tabId === tabId && call.mode === "idle").at(-1);
  const [one, two] = [painted(31), painted(32)];
  assert.ok(one && two, "both tabs were painted");
  for (const call of f.calls) {
    const text = JSON.stringify(call.args);
    assert.ok(!text.includes(session), "the session ID never reaches the page");
    assert.ok(!text.includes(chrome.runtime.id), "the extension ID never reaches the page");
  }
  assert.match(one.args[0], /^[0-9a-f]{32}$/); assert.match(one.args[3], /^[0-9a-f]{32}$/);
  assert.equal(one.args[3], presenceToken(f, "origin", "https://one.test"));
  assert.equal(one.args[0], presenceToken(f, "owner", "https://one.test", session));
  assert.notEqual(one.args[0], two.args[0], "owner markers differ between origins");
  assert.notEqual(one.args[3], two.args[3], "origin markers differ between origins");
});
await test("the marker key rotates at browser start, so an origin's token changes", async () => {
  const f = await fixture();
  f.initializePresence(); await delay(50); // the startup reconciliation settles first
  const originToken = () => f.calls.filter(call => call.tabId === 11 && call.mode === "idle").at(-1)?.args[3];
  await f.withPresence("aaaa", "get_page_text", { tabId: 11 }, async () => "ok");
  const before = originToken(), keyBefore = f.stored.presenceMarkerKey;
  assert.equal(before, presenceToken(f, "origin", "https://fixture.test"));
  assert.equal(typeof f.listeners.startup, "function", "a browser-start listener is registered");
  f.listeners.startup(); await delay(20);
  assert.equal(typeof f.stored.presenceMarkerKey, "string");
  assert.notEqual(f.stored.presenceMarkerKey, keyBefore, "a new key is stored at browser start");
  await f.withPresence("aaaa", "get_page_text", { tabId: 11 }, async () => "ok");
  const after = originToken();
  assert.notEqual(after, before, "the same origin gets a different token after a browser start");
  assert.equal(after, presenceToken(f, "origin", "https://fixture.test"), "the new token comes from the stored new key");
});
await test("a tab created inside a mapped group is recorded, once more when it completes", async () => {
  const f = await fixture();
  f.initializePresence(); await delay(50); // the startup reconciliation settles first
  const before = f.identityWrites.length;
  f.tabs.set(13, { id: 13, groupId: 1, url: "https://fixture.test/opened" });
  f.listeners.created({ id: 13, groupId: 1 }); await delay(20);
  assert.equal(f.identityWrites.length, before + 1, "creation inside a mapped group refreshes that session's identity");
  assert.equal(f.identityWrites.at(-1), "mcpGroupIdentity:aaaa");
  f.listeners.tab(13, { status: "complete" }); await delay(20);
  assert.equal(f.identityWrites.length, before + 2, "the first completion refreshes once more");
  f.listeners.tab(13, { status: "complete" }); await delay(20);
  assert.equal(f.identityWrites.length, before + 2, "later completions do not");
  f.tabs.set(14, { id: 14, groupId: -1, url: "https://fixture.test" });
  f.listeners.created({ id: 14, groupId: -1 }); await delay(20);
  assert.equal(f.identityWrites.length, before + 2, "an ungrouped tab refreshes nothing");
});
await test("ownership changes notify the release hook", async () => {
  const f = await fixture();
  let changes = 0;
  f.initializePresence(() => { changes++; }); await flush();
  f.listeners.tab(11, { groupId: -1 });
  assert.equal(changes, 1, "a tab changing group");
  f.listeners.storage({ mcpGroups: { newValue: {} } }, "local");
  assert.equal(changes, 2, "a group mapping change");
  f.listeners.tab(11, { status: "complete" });
  assert.equal(changes, 2, "a page load is not an ownership change");
});
stopWatchdog();
console.log(`\nVisual presence coordination: ${passed} passed`);
