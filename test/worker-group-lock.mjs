// Exercise the real worker dispatcher while another session holds the group
// write lock (a reap stuck in a Chrome call). Reads and ordinary calls must not
// queue behind it: health has a 1.5 s budget exactly when diagnosis is needed,
// and a session whose name is already stored has nothing to write.
import assert from "node:assert/strict";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const messages = [];
const event = () => ({ addListener() {} });
// A cleanup that gave up before this worker started, on a connection that announced sessions.
const sessionStore = { reapRetry: { sessionOpenSeen: true, sessions: [{ sessionId: "lost", failedAt: Date.now() }] } };
const store = {
  mcpGroups: { real: 42, second: 43, gone: 50, lost: 60, fake: 70 },
  "mcpSessionName:real": "Hej och Hå",
  "mcpSessionName:second": "Andra projektet",
  "mcpGroupIdentity:real": { groupId: 42, targets: { 42: "target:42" } },
  "mcpGroupIdentity:second": { groupId: 43, targets: { 43: "target:43" } },
};
const titles = new Map([[42, "Hej och Hå"], [43, "Andra projektet"], [50, "MCP·gone"], [60, "MCP·lost"], [70, "MCP·fake"]]);
const tabs = new Map([[42, { id: 42, groupId: 42, url: "about:blank" }], [43, { id: 43, groupId: 43, url: "about:blank" }],
  [50, { id: 50, groupId: 50, url: "about:blank" }], [60, { id: 60, groupId: 60, url: "about:blank" }], [70, { id: 70, groupId: 70, url: "about:blank" }]]);
let hold, entered;
const clone = value => value === undefined ? undefined : structuredClone(value);
globalThis.chrome = {
  runtime: { id: "worker-fixture", onMessage: { addListener: fn => messages.push(fn) }, onInstalled: event(), onStartup: event(),
    getManifest: () => ({ version: "0.9.0" }), getURL: path => `chrome-extension://worker-fixture/${path}` },
  offscreen: { hasDocument: async () => true },
  storage: {
    onChanged: event(),
    local: {
      get: async key => Object.fromEntries([key].flat().map(name => [name, clone(store[name])])),
      set: async values => { Object.assign(store, clone(values)); },
      remove: async keys => { for (const key of [keys].flat()) delete store[key]; },
    },
    session: {
      get: async key => Object.fromEntries([key].flat().map(name => [name, clone(sessionStore[name])])),
      set: async values => { Object.assign(sessionStore, clone(values)); },
    },
  },
  tabs: {
    onUpdated: event(), onRemoved: event(), onCreated: event(),
    get: async id => { if (!tabs.has(id)) throw new Error("No tab"); return { ...tabs.get(id) }; },
    query: async ({ groupId }) => [...tabs.values()].filter(tab => tab.groupId === groupId).map(tab => ({ ...tab })),
    remove: async ids => { for (const id of [ids].flat()) tabs.delete(id); },
  },
  tabGroups: {
    onUpdated: event(), update: async () => {}, query: async () => [...titles.keys()].map(id => ({ id })),
    get: async id => {
      if (id === 50 && hold) { entered(); await hold; }
      if (!titles.has(id)) throw new Error("No group");
      return { id, title: titles.get(id), color: "blue" };
    },
  },
  debugger: { onDetach: event(), onEvent: event(), getTargets: async () => [...tabs.keys()].map(tabId => ({ tabId, id: `target:${tabId}`, type: "page" })) },
  downloads: { onCreated: event(), onChanged: event() },
  scripting: {},
};
await import("../dist/background.mjs");
await new Promise(resolve => setTimeout(resolve, 50)); // startup reconciliation settles

const offscreen = { id: "worker-fixture", url: "chrome-extension://worker-fixture/offscreen.html" };
const panel = { id: "worker-fixture", url: "chrome-extension://worker-fixture/sidepanel.html" };
const send = (msg, sender = {}) => new Promise(resolve => { assert.equal(messages[0](msg, sender, resolve), true); });
const control = (event, sessionId, sender = offscreen) => { messages[0]({ type: "broker-control", event, sessionId }, sender, () => {}); };
const settled = async (condition, ms = 1500) => { for (let waited = 0; waited < ms && !condition(); waited += 25) await new Promise(resolve => setTimeout(resolve, 25)); return condition(); };
const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve("waited"), ms))]);
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

check("a worker start alone retries no cleanup that gave up", tabs.has(60) && store.mcpGroups.lost === 60);
// The offscreen document reports a new broker connection: it has announced nothing yet.
await send({ type: "set-status", status: "connected", detail: "ws://127.0.0.1:9223" }, offscreen);

// Hold the group write lock: the reap of an ended session stalls inside its
// ownership inspection.
let release;
hold = new Promise(resolve => { release = resolve; });
const reaping = new Promise(resolve => { entered = resolve; });
control("session-closed", "gone");
await reaping;
// A page-opened tab joins "real": the recorded and live tab sets now differ.
tabs.set(44, { id: 44, groupId: 42, url: "about:blank" });

const health = await within(send({ type: "tool-call", tool: "health", args: {}, sessionId: "real", sessionName: "Hej och Hå" }), 400);
check("health answers while the group lock is held", health !== "waited" && health.ok === true, health === "waited" ? "waited for the lock" : "");
check("health inspects the group without waiting for the lock", health !== "waited" && health.result?.inspection === "available" && health.result?.groupId === 42,
  health === "waited" ? "" : JSON.stringify({ inspection: health.result?.inspection, groupId: health.result?.groupId }));
const second = await within(send({ type: "tool-call", tool: "dialog", args: { action: "get", tabId: 43 }, sessionId: "second", sessionName: "Andra projektet" }), 1000);
check("a second session's call with a stored name does not wait for the lock", second !== "waited" && second.ok === true,
  second === "waited" ? "waited for the lock" : JSON.stringify(second.error ?? ""));
const stale = await within(send({ type: "tool-call", tool: "dialog", args: { action: "get", tabId: 44 }, sessionId: "real", sessionName: "Hej och Hå" }), 1000);
check("a call on a page-opened tab does not wait for the identity refresh", stale !== "waited" && stale.ok === true,
  stale === "waited" ? "waited for the lock" : JSON.stringify(stale.error ?? ""));
// "second" has recorded exactly its live tabs: there is nothing to record, so
// listing them must not queue behind another session's stuck cleanup.
const listed = await within(send({ type: "tool-call", tool: "tabs_context_mcp", args: {}, sessionId: "second", sessionName: "Andra projektet" }), 1000);
check("tabs_context_mcp with current recorded tabs does not wait for the lock", listed !== "waited" && listed.ok === true && listed.result?.groupId === 43,
  listed === "waited" ? "waited for the lock" : JSON.stringify(listed.error ?? ""));
// Closing one of those tabs has nothing to record first either.
const closed = await within(send({ type: "tool-call", tool: "tabs_close_mcp", args: { tabId: 43 }, sessionId: "second", sessionName: "Andra projektet" }), 1000);
check("tabs_close_mcp with current recorded tabs closes its tab without waiting for the lock",
  closed !== "waited" && closed.ok === true && closed.result?.closed === 43 && !tabs.has(43),
  closed === "waited" ? "waited for the lock" : JSON.stringify(closed.error ?? ""));

release(); hold = undefined;
await new Promise(resolve => setTimeout(resolve, 50));
check("the identity refresh runs once the lock is free", Boolean(store["mcpGroupIdentity:real"]?.targets?.[44]));
const named = await send({ type: "tool-call", tool: "health", args: {}, sessionId: "fresh", sessionName: "Nytt projekt" });
check("health records no session name", named.ok === true && store["mcpSessionName:fresh"] === undefined);
const remembered = await send({ type: "tool-call", tool: "dialog", args: { action: "get", tabId: 42 }, sessionId: "fresh", sessionName: "Nytt projekt" });
check("an ordinary call still records a new session name", remembered.ok === false && store["mcpSessionName:fresh"] === "Nytt projekt");

// A cleanup that gave up is tried again only by a session-closed frame, and only on a
// broker connection that has announced a session: an older broker announces none, and a
// reconnected idle session would otherwise look exactly like an ended one.
await new Promise(resolve => setTimeout(resolve, 100));
check("a session-closed frame on a connection that announced nothing retries no cleanup", tabs.has(60) && store.mcpGroups.lost === 60);
control("session-open", "real", {});
control("session-closed", "ended-before-announcement");
await new Promise(resolve => setTimeout(resolve, 100));
check("an announcement that does not come from the offscreen document is ignored", tabs.has(60) && sessionStore.reapRetry.sessionOpenSeen === false);
control("session-open", "real");
await settled(() => sessionStore.reapRetry.sessionOpenSeen === true);
check("the announcement alone starts no cleanup", tabs.has(60));
// Only the offscreen document relays the broker's frames: the same frame from
// another extension page reaps nothing and retries nothing.
control("session-closed", "fake", panel);
await new Promise(resolve => setTimeout(resolve, 100));
check("a session-closed frame that does not come from the offscreen document starts no cleanup",
  tabs.has(70) && store.mcpGroups.fake === 70 && tabs.has(60) && store.mcpGroups.lost === 60,
  JSON.stringify({ groupKept: tabs.has(70), failedCleanupRetried: !tabs.has(60) }));
control("session-closed", "ended-after-announcement");
check("the next session-closed frame on an announcing connection retries the cleanup",
  await settled(() => !tabs.has(60) && store.mcpGroups.lost === undefined && sessionStore.reapRetry.sessions.length === 0),
  JSON.stringify({ tab: tabs.has(60), mapping: store.mcpGroups.lost, retry: sessionStore.reapRetry }));
check("the announced session keeps its group", tabs.has(42) && store.mcpGroups.real === 42);

console.log(`\n=== worker-group-lock: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
