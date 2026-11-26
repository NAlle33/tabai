import { openCdpObserver } from "./helpers/cdp-observer.mjs";
// Live popup check inside the harness's disposable browser: the wordmark loads
// from the extension root with an accessible product name, nothing overflows
// the 280 px popup, the operational fields (version, id, status, connection
// controls) still render, and the three status states stay visually distinct.
// The popup document is opened as a tab through the browser's CDP endpoint;
// page-debugger ownership stays with the tools.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchdog } from "./watchdog.mjs";

let observer;
const rpc = (...args) => observer.rpc(...args);


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
let socket;
const stopWatchdog = watchdog(() => socket?.terminate());
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const endpoint = new URL(process.argv[2] ?? "");
assert.equal(endpoint.protocol, "ws:");
assert.equal(endpoint.hostname, "127.0.0.1", "observer must use the harness's loopback browser");
observer = await openCdpObserver(endpoint, { timeoutMs: 5000, timeoutMessage: method => `CDP ${method} timed out`, handshakeTimeout: 5000 });
  socket = observer.socket;

const { targetInfos } = await rpc("Target.getTargets");
const worker = targetInfos.find((target) => target.type === "service_worker" &&
  target.url.startsWith("chrome-extension://") &&
  new URL(target.url).pathname === `/${manifest.background.service_worker}`);
assert.ok(worker, "expected the loaded extension worker");
const extensionId = new URL(worker.url).host;
const artifactDir = process.argv[3];

let targetId, popupSession, originalFocusPreference, focusPreferenceLoaded = false;
let originalBridgeUrl, bridgeUrlLoaded = false;
const evaluate = async (expression) => {
  const reply = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, popupSession);
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result.value;
};
/** Puts the harness's own bridge URL back; a popup save may have reconnected to a test value, so it reconnects too. */
const restoreBridgeUrl = async (reconnect = true) => {
  const stored = await evaluate("chrome.storage.local.get('bridgeUrl').then(s=>s.bridgeUrl ?? null)");
  if (stored === originalBridgeUrl) return;
  await evaluate(originalBridgeUrl === null ? "chrome.storage.local.remove('bridgeUrl')" : `chrome.storage.local.set({bridgeUrl:${JSON.stringify(originalBridgeUrl)}})`);
  if (reconnect) await evaluate("chrome.runtime.sendMessage({type:'reconnect'}).catch(()=>{})");
};
try {
  ({ targetId } = await rpc("Target.createTarget", { url: `chrome-extension://${extensionId}/${manifest.action.default_popup}` }));
  ({ sessionId: popupSession } = await rpc("Target.attachToTarget", { targetId, flatten: true }));
  const snapshot = `(() => {
    const img = document.querySelector("h1 img");
    const status = document.getElementById("status");
    // Before the popup script has rendered, report only readiness and keep polling.
    if (!img || !status || !document.body) return { ready: document.readyState, complete: false, info: "", statusClass: "" };
    const body = document.body.getBoundingClientRect();
    const bodyStyle = getComputedStyle(document.body);
    // Children must stay inside the body's content box, not merely its padding.
    const contentRight = body.right - parseFloat(bodyStyle.paddingRight) - parseFloat(bodyStyle.borderRightWidth);
    const rightEdge = Math.max(0, ...[...document.body.querySelectorAll("*")].map((el) => el.getBoundingClientRect().right));
    const colours = {};
    const original = status?.className ?? "";
    for (const state of ["ok", "warn", "err"]) {
      status.className = state;
      colours[state] = getComputedStyle(status).backgroundColor;
    }
    status.className = original;
    return {
      ready: document.readyState,
      title: document.title,
      alt: img?.alt ?? null,
      complete: !!img && img.complete,
      naturalWidth: img?.naturalWidth ?? 0,
      renderedWidth: img ? img.getBoundingClientRect().width : 0,
      bodyRight: contentRight,
      rightEdge,
      info: document.getElementById("info")?.textContent ?? "",
      extid: document.getElementById("extid")?.textContent ?? "",
      status: status?.textContent ?? "",
      statusClass: original,
      colours,
      controls: ["url", "token", "save", "reconnect", "reloadext"].filter((id) => !document.getElementById(id)),
      urlValue: document.getElementById("url")?.value ?? "",
      agentFocus: document.getElementById("agent-focus")?.checked,
    };
  })()`;
  let state;
  for (let i = 0; i < 50; i++) {
    state = await evaluate(snapshot);
    if (state.ready === "complete" && state.complete && state.info && state.statusClass) break;
    await sleep(200);
  }
  check("popup document is titled with the product name", state.title === "Tabai", state.title);
  check("wordmark loaded from the extension root", state.complete && state.naturalWidth > 0, `naturalWidth=${state.naturalWidth}`);
  check("wordmark carries the accessible product name", state.alt === "Tabai", String(state.alt));
  check("wordmark renders at header size inside the popup", state.renderedWidth > 0 && state.renderedWidth <= 252, `${state.renderedWidth}px`);
  check("nothing overflows the popup content box", state.rightEdge <= state.bodyRight + 0.5, `right edge ${state.rightEdge} vs content box ${state.bodyRight}`);
  check("version and session counts render", new RegExp(`^v${manifest.version.replace(/\./g, "\\.")} · \\d+ sessions? · \\d+ MCP tabs?$`).test(state.info), state.info);
  check("extension id renders for the pin command", state.extid === `id ${extensionId}`, state.extid);
  check("status line renders a known state", /^Status: /.test(state.status) && ["ok", "warn", "err"].includes(state.statusClass), `${state.statusClass}: ${state.status}`);
  check("connected, connecting and error states are visually distinct", new Set(Object.values(state.colours)).size === 3, JSON.stringify(state.colours));
  check("connection controls are present", state.controls.length === 0, state.controls.join(","));
  check("bridge URL field is populated", /^ws:\/\/127\.0\.0\.1:\d+$/.test(state.urlValue), state.urlValue);
  originalFocusPreference = await evaluate("chrome.storage.local.get('allowAgentFocus').then(s=>s.allowAgentFocus)");
  focusPreferenceLoaded = true;
  check("agent foreground permission is off by default", state.agentFocus === false);
  if (artifactDir) {
    const height = await evaluate("Math.ceil(document.body.getBoundingClientRect().height)");
    const shot = await rpc("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 308, height, scale: 1 } }, popupSession);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "agent-focus-popup.png"), Buffer.from(shot.data, "base64"));
  }
  await evaluate("document.getElementById('agent-focus').click()");
  let saved = false;
  for (let i = 0; i < 50; i++) {
    saved = await evaluate("chrome.storage.local.get('allowAgentFocus').then(s=>s.allowAgentFocus===true)");
    if (saved) break;
    await sleep(50);
  }
  check("popup saves the user's foreground permission", saved);
  await rpc("Target.closeTarget", { targetId });
  ({ targetId } = await rpc("Target.createTarget", { url: `chrome-extension://${extensionId}/${manifest.action.default_popup}` }));
  ({ sessionId: popupSession } = await rpc("Target.attachToTarget", { targetId, flatten: true }));
  let reopened = false;
  for (let i = 0; i < 50; i++) {
    reopened = await evaluate("document.getElementById('agent-focus')?.checked === true");
    if (reopened) break;
    await sleep(50);
  }
  check("foreground permission survives reopening the popup", reopened);
  // The bridge address: only a ws:// address on this computer is saved or handed to the offscreen
  // socket, and the token field hides what is typed. Refused addresses use the documentation
  // range, so nothing outside this computer is ever contacted even if one were used.
  originalBridgeUrl = await evaluate("chrome.storage.local.get('bridgeUrl').then(s=>s.bridgeUrl ?? null)");
  bridgeUrlLoaded = true;
  const tokenType = await evaluate("document.getElementById('token').type");
  check("the token field is a password field", tokenType === "password", tokenType);
  // A query or a fragment is refused too: the offscreen document appends ?token=… to the address, and a
  // socket refuses a fragment. Those addresses use port 1, which Chrome itself never contacts.
  for (const refused of ["ws://192.0.2.1:9223", "wss://127.0.0.1:9223", "ws://127.0.0.1.example:9223", "http://127.0.0.1:9223", "ws://127.0.0.1:1#a", "ws://127.0.0.1:1?x=1"]) {
    await evaluate(`(()=>{document.getElementById('url-error')?.replaceChildren();document.getElementById('url').value=${JSON.stringify(refused)};document.getElementById('save').click();})()`);
    let shown = "";
    for (let i = 0; i < 50 && !shown; i++) { shown = await evaluate("document.getElementById('url-error')?.textContent ?? ''"); if (!shown) await sleep(50); }
    const stored = await evaluate("chrome.storage.local.get('bridgeUrl').then(s=>s.bridgeUrl ?? null)");
    if (stored !== originalBridgeUrl) await restoreBridgeUrl();
    check(`popup refuses ${refused} and keeps the stored bridge URL`, stored === originalBridgeUrl && shown === "Ange en ws://-adress på den här datorn: 127.0.0.1, localhost eller [::1]. Inget har ändrats.", `stored ${stored}, shown "${shown}"`);
  }
  const handed = {};
  for (const url of ["ws://192.0.2.1:9223", "ws://localhost:9224", "ws://[::1]:9224", "ws://127.0.0.1:1#a", "ws://127.0.0.1:1?x=1"]) {
    await evaluate(`chrome.storage.local.set({bridgeUrl:${JSON.stringify(url)}})`);
    handed[url] = (await evaluate("chrome.runtime.sendMessage({type:'get-config'})"))?.url;
    // Only the stored value changed; the open socket keeps its address, so nothing reconnects.
    await restoreBridgeUrl(false);
  }
  check("the worker hands the offscreen socket a loopback bridge URL without query or fragment only", JSON.stringify(handed) === JSON.stringify({ "ws://192.0.2.1:9223": "", "ws://localhost:9224": "ws://localhost:9224", "ws://[::1]:9224": "ws://[::1]:9224", "ws://127.0.0.1:1#a": "", "ws://127.0.0.1:1?x=1": "" }), JSON.stringify(handed));
} finally {
  if (targetId && bridgeUrlLoaded) await restoreBridgeUrl().catch(() => {});
  if (targetId && focusPreferenceLoaded) await evaluate(originalFocusPreference === undefined
    ? "chrome.storage.local.remove('allowAgentFocus')"
    : `chrome.storage.local.set({allowAgentFocus:${JSON.stringify(originalFocusPreference)}})`).catch(() => {});
  if (targetId) await rpc("Target.closeTarget", { targetId }).catch(() => {});
  socket.close();
}

console.log(`\n=== popup-live: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
