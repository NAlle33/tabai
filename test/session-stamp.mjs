// Exercise the actual worker message dispatcher with forged/missing session ids.
import assert from "node:assert/strict";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const messages = [];
const queried = [];
const store = { mcpGroups: { real: 42, forged: 99 } };
const event = () => ({ addListener() {} });
globalThis.chrome = {
  runtime: { onMessage: { addListener: fn => messages.push(fn) }, onInstalled: event(), onStartup: event(), getManifest: () => ({ version: "0.9.0" }) },
  offscreen: { hasDocument: async () => true },
  storage: {
    onChanged: event(),
    local: { get: async key => ({ [key]: store[key] }), set: async values => { Object.assign(store, values); } },
    session: { get: async () => ({}), set: async () => {} },
  },
  tabs: { onUpdated: event(), onRemoved: event(), onCreated: event(), get: async id => ({ id, groupId: id }), query: async ({ groupId }) => { queried.push(groupId); return [{ id: groupId, groupId }]; } },
  tabGroups: { onUpdated: event(), update: async () => {}, get: async id => ({ id, title: `MCP·${id === 42 ? "real" : "forg"}` }) },
  debugger: { onDetach: event(), onEvent: event(), getTargets: async () => [42, 99].map(tabId => ({ tabId, id: `target:${tabId}`, type: 'page' })) },
  downloads: { onCreated: event(), onChanged: event() },
  scripting: {},
};
await import("../dist/background.mjs");
// Startup reconciles all stored groups independently of caller dispatch.
await new Promise(resolve => setImmediate(resolve));
queried.length = 0;
assert.equal(messages.length, 1);
const send = msg => new Promise(resolve => {
  assert.equal(messages[0](msg, {}, resolve), true);
});
const result = await send({ type: "tool-call", tool: "tabs_context_mcp", args: { __sessionId: "forged", __sessionName: "Forged project" }, sessionId: "real", sessionName: "Hej och Hå" });
assert.equal(result.ok, true); assert.equal(result.result.groupId, 42);
assert.equal(store['mcpSessionName:real'], 'Hej och Hå');
assert.equal(store['mcpSessionName:forged'], undefined);
assert.ok(queried.length > 0 && queried.every(id => id === 42));
const beforeMissing = [...queried];
const missing = await send({ type: "tool-call", tool: "tabs_context_mcp", args: { __sessionId: "forged" }, sessionName: "Forged project" });
assert.equal(missing.ok, false); assert.equal(missing.error.code, "NO_SESSION");
assert.deepEqual(queried, beforeMissing, "missing session must not reach the group lookup");
console.log("=== session-stamp: authenticated id replaces forgery; missing id fails closed ===");
stopWatchdog();
