// Live: the extension's broker connection drops and comes back with a session's
// group and tab intact while a mutating call in flight runs at most once; then
// extension_reload acks and the extension actually reloads. Run LAST by the CI
// harness (it tears the extension down), which passes the browser's own CDP
// endpoint. Talks raw ws to the broker's client port.
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { clientWsUrl } from "../scripts/resolve-token.mjs";
import { PROTOCOL_VERSION } from "../dist/protocol.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";
import { watchdog } from "./watchdog.mjs";

if (!process.argv[2]) throw new Error("extension-reload needs the browser's CDP endpoint (run it through test/ci-harness.mjs)");
if (new URL(process.argv[2]).hostname !== "127.0.0.1") throw new Error("the CDP endpoint must be loopback");
const CLIENT_PORT = process.env.CCMCP_CLIENT_PORT || "9226";
const manifest = JSON.parse(readFileSync(join(process.cwd(), "extension", "manifest.json"), "utf8"));
let pass = 0;
let fail = 0;
let skipped = 0;
const check = (n, ok, d = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? " — " + d : ""}`);
  ok ? pass++ : fail++;
};
const skip = (n, reason) => { console.log(`  - ${n} — skipped: ${reason}`); skipped++; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function call(tool, args = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(clientWsUrl(CLIENT_PORT));
    const id = randomUUID();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(v);
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ role: "client", sessionKey: randomUUID(), version: PROTOCOL_VERSION }));
      ws.send(JSON.stringify({ id, tool, args, timeoutMs: 8000 }));
    });
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.id === id) finish(m);
      } catch { /* ignore */ }
    });
    ws.on("error", () => finish(null));
    setTimeout(() => finish(null), 10000);
  });
}

/** One broker client whose connection, and so whose session, outlives the drop. */
async function openSession() {
  const ws = new WebSocket(clientWsUrl(CLIENT_PORT));
  const waiting = new Map();
  const settleAll = () => { for (const settle of waiting.values()) settle(null); waiting.clear(); };
  ws.on("message", data => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    waiting.get(frame.id)?.(frame);
  });
  ws.on("close", settleAll);
  ws.on("error", settleAll);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ role: "client", sessionKey: randomUUID(), version: PROTOCOL_VERSION }));
  return {
    ws,
    /** The broker's own deadline is timeoutMs; null only if it never answers. */
    call(tool, args = {}, timeoutMs = 8000) {
      const id = randomUUID();
      return new Promise(resolve => {
        const timer = setTimeout(() => settle(null), timeoutMs + 5000);
        const settle = frame => { clearTimeout(timer); waiting.delete(id); resolve(frame); };
        waiting.set(id, settle);
        ws.send(JSON.stringify({ id, tool, args, timeoutMs }));
      });
    },
  };
}

const configDir = mkdtempSync(join(tmpdir(), "tabai-reload-evidence-"));
const client = createMcpClient({ name: "reload-evidence", version: "1.0.0" });
// Counts the in-flight call's page action outside the browser, so a replay after
// the reconnect is visible even if no tool ever answers.
let hits = 0;
const fixture = http.createServer((req, res) => {
  if (req.url === "/hit") { hits++; res.writeHead(204); res.end(); return; }
  res.end("<!doctype html><title>Reload evidence</title><p>Ready</p>");
});
let observer, tabId, session, extensionId, cleaned;
const popups = new Set();
const tool = async (name, args = {}) => {
  const result = await callRaw(client, { name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};
const targets = async () => (await observer.rpc("Target.getTargets")).targetInfos;
const extensionTarget = async suffix => (await targets()).find(target => target.url === `chrome-extension://${extensionId}${suffix}`);
/** Opens the popup as a tab: its script asks the worker to ensure the broker
 *  connection, as a user's click would. Returns what the page shows. */
async function openPopup() {
  const { targetId } = await observer.rpc("Target.createTarget", { url: `chrome-extension://${extensionId}/${manifest.action.default_popup}` });
  popups.add(targetId);
  const { sessionId } = await observer.rpc("Target.attachToTarget", { targetId, flatten: true });
  // A new target starts on about:blank; only the committed popup URL (or Chromium's
  // error page for a blocked extension) tells whether extension code runs.
  let view = {};
  for (const until = Date.now() + 5000; (view.ready !== "complete" || view.href === "about:blank") && Date.now() < until; await sleep(100)) {
    const reply = await observer.rpc("Runtime.evaluate", { returnByValue: true,
      expression: "({href:location.href,ready:document.readyState,runtime:typeof chrome!=='undefined'&&!!chrome.runtime?.id,text:(document.body?.innerText??'').slice(0,100)})" }, sessionId).catch(() => undefined);
    view = reply?.result?.value ?? view;
  }
  await observer.rpc("Target.detachFromTarget", { sessionId }).catch(() => {});
  return { targetId, view };
}
async function closePopups() {
  for (const targetId of popups) await observer?.rpc("Target.closeTarget", { targetId }).catch(() => {});
  popups.clear();
}
async function healthWithin(ms) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(300)) {
    const answer = await call("health");
    if (answer?.ok && answer.result?.extVersion === manifest.version) return answer.result;
  }
  return null;
}
const cleanup = () => cleaned ??= (async () => {
  if (tabId !== undefined) await tool("tabs_close_mcp", { tabId }).catch(() => {});
  await closePopups();
  // The extension may be gone after the reload: close the fixture tabs outside it.
  const origin = fixture.listening ? `http://127.0.0.1:${fixture.address().port}/` : undefined;
  if (observer && origin) for (const target of await targets().catch(() => [])) {
    if (target.type === "page" && target.url.startsWith(origin)) await observer.rpc("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }
  session?.ws.terminate();
  await client.close().catch(() => {});
  observer?.rejectPending(new Error("cleanup")); observer?.socket.terminate();
  fixture.closeAllConnections(); if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
  rmSync(configDir, { recursive: true, force: true });
})();
const stopWatchdog = watchdog(cleanup);
try {
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  await connectMcpClient(client, createMcpTransport({ command: process.execPath, args: [join(process.cwd(), "dist/server.js")],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("CCMCP_") && typeof value === "string")), CCMCP_CONFIG_DIR: configDir },
  }));
  tabId = (await tool("tabs_context_mcp", { createIfEmpty: true })).tabs[0].tabId;
  await tool("navigate", { tabId, url: fixtureUrl, waitUntil: "load" });
  const timeout = await callRaw(client, { name: "wait_for", arguments: { tabId, selector: "#reload-incident-missing", timeoutMs: 100 } });
  assert.equal(timeout.isError, true);
  assert.match(timeout.content?.[0]?.text ?? "", /TIMEOUT:/, "fixture must reach a real worker deadline");
  const incident = (await tool("timeout_incidents"))[0];
  assert(incident?.incidentId); assert.equal(incident.diagnosticsAvailable, true);
  await tool("tabs_close_mcp", { tabId }); tabId = undefined;

  // A session that stays connected to the broker throughout, with a tab of its own.
  session = await openSession();
  const before = await session.call("tabs_context_mcp", { createIfEmpty: true });
  const sessionTab = before?.result?.tabs?.[0]?.tabId;
  const groupBefore = before?.result?.groupId;
  assert(Number.isInteger(sessionTab) && Number.isInteger(groupBefore), `the session needs its own group and tab: ${JSON.stringify(before)}`);
  const opened = await session.call("navigate", { tabId: sessionTab, url: fixtureUrl, waitUntil: "load" }, 35000);
  assert.equal(opened?.ok, true, `the session's tab must load the fixture: ${JSON.stringify(opened)}`);
  const keepsGroupAndTab = async () => {
    const context = await session.call("tabs_context_mcp", {});
    const title = await session.call("javascript_tool", { tabId: sessionTab, text: "document.title" });
    return {
      ok: context?.ok === true && context.result?.groupId === groupBefore && context.result?.tabs?.some(tab => tab.tabId === sessionTab) && title?.ok === true && title.result === "Reload evidence",
      detail: `group ${groupBefore} -> ${context?.result?.groupId}; tabs ${JSON.stringify(context?.result?.tabs?.map(tab => tab.tabId) ?? context?.error)}; title ${JSON.stringify(title?.result ?? title?.error)}`,
    };
  };

  observer = await openCdpObserver(process.argv[2], { timeoutMs: 10000, timeoutMessage: method => `${method} timed out` });
  const worker = (await targets()).find(target => target.type === "service_worker" && target.url.endsWith(`/${manifest.background.service_worker}`));
  assert(worker, "the extension's service worker target was not found");
  extensionId = new URL(worker.url).host;

  // --- The broker connection drops while a mutating call runs in the page. The
  // offscreen document that holds the connection is closed through the browser;
  // the popup wakes the extension, which opens a new one. The page counts the
  // call's action first and only then waits, so the call is still running. ---
  const offscreenBefore = await extensionTarget("/offscreen.html");
  assert(offscreenBefore, "the extension's offscreen document was not found");
  const inFlight = session.call("javascript_tool", { tabId: sessionTab,
    text: "(async()=>{await fetch('/hit',{method:'POST'});await new Promise(resolve=>setTimeout(resolve,5000));return 'done'})()" }, 8000);
  let settledEarly = false;
  void inFlight.then(() => { settledEarly = true; });
  for (const until = Date.now() + 10000; hits === 0 && Date.now() < until;) await sleep(50);
  await observer.rpc("Target.closeTarget", { targetId: offscreenBefore.targetId });
  check("a mutating call is running in the page when the extension's connection drops", hits === 1 && !settledEarly, `hits=${hits} settled before the drop=${settledEarly}`);
  const woken = await openPopup();
  const health = await healthWithin(20000);
  const offscreenAfter = await extensionTarget("/offscreen.html");
  check("the woken extension opens a new connection and answers health through the broker",
    Boolean(health) && Boolean(offscreenAfter) && offscreenAfter.targetId !== offscreenBefore.targetId,
    `health ${health ? "answered" : "missing"}; offscreen ${offscreenAfter ? (offscreenAfter.targetId === offscreenBefore.targetId ? "the old document" : "a new document") : "missing"}; popup ${JSON.stringify(woken.view)}`);
  await closePopups();
  const ended = await inFlight;
  check("the call in flight when the connection dropped ends without a result", ended?.ok !== true, JSON.stringify(ended?.error ?? ended).slice(0, 120));
  const across = await keepsGroupAndTab();
  check("the session keeps its group and its tab across the reconnect and still controls the tab", across.ok, across.detail);
  // A replay would have been written when the extension reconnected, well before
  // the call's own deadline above, and it counts as soon as it starts.
  check("the in-flight call ran at most once (page counter)", hits === 1, `hits=${hits}`);

  // --- The real reload, last. ---
  const originalWorker = (await targets()).find(target => target.type === "service_worker" && target.url.endsWith(`/${manifest.background.service_worker}`));
  assert(originalWorker, "the extension's service worker target was not found before the reload");
  const ack = await call("extension_reload");
  check(
    "extension_reload acks reloading",
    !!ack && ack.ok === true && ack.result?.reloading === true,
    JSON.stringify(ack?.result ?? ack),
  );
  let destroyed = false;
  for (const until = Date.now() + 10000; !destroyed && Date.now() < until; await sleep(100)) {
    destroyed = !(await targets()).some(target => target.targetId === originalWorker.targetId);
  }
  check("extension reload actually destroys the original worker", destroyed);
  assert.equal((await tool("timeout_incidents", { incidentId: incident.incidentId })).incidentId, incident.incidentId);
  check("automatic timeout evidence survives actual extension reload", true);
  // Chromium builds that keep an extension disabled after it reloads itself
  // block its pages, so no extension code runs to reconnect. The checks after the
  // reload cannot run there, and say so; wherever the extension runs again they
  // are required.
  let popup;
  for (const until = Date.now() + 10000; Date.now() < until; await sleep(1000)) {
    popup = await openPopup();
    if (popup.view.runtime === true) break;
    await closePopups();
  }
  if (popup?.view.runtime !== true) {
    const reason = `this Chromium keeps an extension that reloaded itself disabled (its popup shows: ${JSON.stringify(popup?.view.text ?? "").slice(0, 80)})`;
    skip("the reloaded extension answers health through the broker", reason);
    skip("the session keeps its group and its tab across the reload", reason);
  } else {
    const reloaded = await healthWithin(20000);
    check("the reloaded extension answers health through the broker", Boolean(reloaded), JSON.stringify(reloaded ?? "no answer").slice(0, 120));
    const afterReload = await keepsGroupAndTab();
    check("the session keeps its group and its tab across the reload", afterReload.ok, afterReload.detail);
  }
} finally { await cleanup(); stopWatchdog(); }

console.log(`\n=== extension-reload: ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
process.exit(fail === 0 ? 0 : 1);
