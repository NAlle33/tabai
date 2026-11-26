import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";
// Live two-session isolation: two MCP servers share ONE broker + extension, each
// gets its OWN tab group, and neither can see/control the other's tabs. This is
// the core Phase 3 guarantee. Run by the CI harness against the launched Chromium
// AFTER e2e-live (broker + extension already up). The harness also passes the
// browser's own CDP endpoint: tabs are closed and observed through it, outside
// every Tabai tool.


import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("two-session-isolation needs the browser's CDP endpoint (run it through test/ci-harness.mjs)");
const endpoint = new URL(process.argv[2]);
if (endpoint.hostname !== "127.0.0.1") throw new Error("the CDP endpoint must be loopback");
const env = {
  ...process.env,
  CCMCP_PORT: process.env.CCMCP_PORT || "9224",
  CCMCP_CLIENT_PORT: process.env.CCMCP_CLIENT_PORT || "9226",
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

function connectClient(name) {
  const t = createMcpTransport({
    command: process.execPath,
    args: [join(root, "dist", "server.js")],
    cwd: root,
    env,
  });
  const c = createMcpClient({ name, version: "0.0.0" });
  return connectMcpClient(c, t).then(() => c);
}
async function call(c, name, args = {}) {
  const r = await callRaw(c, { name, arguments: args });
  return { isError: r.isError === true, text: r.content?.[0]?.text ?? "", summary: r.structuredContent };
}
// The server auto-spawns the broker; wait until a session can get a group.
async function ctxWithRetry(c) {
  for (let i = 0; i < 60; i++) {
    const r = await call(c, "tabs_context_mcp", { createIfEmpty: true });
    if (!r.isError) {
      try {
        const j = JSON.parse(r.text);
        if (j.groupId && j.tabs?.[0]?.tabId) return j;
      } catch {
        /* not ready */
      }
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("session never got a group");
}

// Every page comes from this local fixture; nothing depends on an external site.
// Session A's page holds state that each refused cross-session call would change.
const ownPage = `<!doctype html><title>Session A page</title>
<input id="field" aria-label="Cross-session field">
<button id="button" onclick="window.__crossSessionClicks=(window.__crossSessionClicks||0)+1">Cross-session button</button>
<select id="choice" aria-label="Cross-session choice"><option value="a">First</option><option value="b">Second</option></select>
<input id="upload" type="file" aria-label="Cross-session upload">
<div id="drop" aria-label="Cross-session drop zone" style="width:160px;height:60px;background:#eee" ondragover="event.preventDefault()"
  ondrop="event.preventDefault();window.__crossSessionDropped=event.dataTransfer.files.length"></div>
<div style="height:3000px"></div>`;
const fixture = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  const name = encodeURIComponent(url.searchParams.get("case") ?? "");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (url.pathname === "/own") return response.end(ownPage);
  if (url.pathname === "/ready") return response.end('<!doctype html><title>Ready</title><p id="ready">Ready</p>');
  response.end(url.pathname === "/opened"
    ? "<!doctype html><title>Opened step</title><p>Opened by the page.</p>"
    : `<!doctype html><title>Start</title><a href="/opened?case=${name}" target="_blank">Open the next step</a>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const observer = await openCdpObserver(endpoint, { timeoutMs: 10000, timeoutMessage: method => `${method} timed out` });
const pageTargets = async () => (await observer.rpc("Target.getTargets")).targetInfos.filter(target => target.type === "page");

const A = await connectClient("session-A");
const B = await connectClient("session-B");
const ga = await ctxWithRetry(A);
const gb = await ctxWithRetry(B);
const tabA = ga.tabs[0].tabId;
const tabB = gb.tabs[0].tabId;
check("two sessions get DISTINCT groups", ga.groupId !== gb.groupId, `${ga.groupId} vs ${gb.groupId}`);
check("two sessions get DISTINCT tabs", tabA !== tabB, `${tabA} vs ${tabB}`);

const na = await call(A, "navigate", { url: `${origin}/own`, tabId: tabA, waitUntil: "load" });
check("A controls its OWN tab", !na.isError, na.text.slice(0, 60));

const cross = await call(B, "read_page", { tabId: tabA });
check("B CANNOT read A's tab (isolation)", cross.isError && /not in your|tab group/i.test(cross.text), cross.text.slice(0, 80));

const cross2 = await call(A, "read_page", { tabId: tabB });
check("A CANNOT read B's tab (isolation)", cross2.isError && /not in your|tab group/i.test(cross2.text), cross2.text.slice(0, 80));

for (const direction of ["back", "forward"]) {
  const crossHistory = await call(B, "navigate", { tabId: tabA, url: direction });
  check(`B CANNOT traverse A's history ${direction}`, crossHistory.isError && /not in your|tab group/i.test(crossHistory.text));
}
const crossWait = await call(B, "wait_for", { tabId: tabA, selector: "body", timeoutMs: 1000 });
check("B CANNOT wait on A's page", crossWait.isError && /not in your|tab group/i.test(crossWait.text));

// Arbitrary evaluation is the strongest capability either session has. The gate
// must refuse it BEFORE the page runs anything, so the owner reads an untouched
// counter afterwards — a refusal message alone would not prove zero mutation.
const seeded = await call(A, "javascript_tool", { tabId: tabA, text: "window.__crossSessionCounter = 0" });
check("A seeds its own evaluation counter", !seeded.isError, seeded.text.slice(0, 80));
const crossEval = await call(B, "javascript_tool", { tabId: tabA, text: "window.__crossSessionCounter = (window.__crossSessionCounter||0)+1" });
check("B CANNOT evaluate JavaScript in A's tab", crossEval.isError && /not in your|tab group/i.test(crossEval.text), crossEval.text.slice(0, 80));
const crossPredicate = await call(B, "wait_for", {
  tabId: tabA,
  predicate: "window.__crossSessionCounter = (window.__crossSessionCounter||0)+1",
  timeoutMs: 1000,
});
check("B CANNOT run a predicate in A's tab", crossPredicate.isError && /not in your|tab group/i.test(crossPredicate.text), crossPredicate.text.slice(0, 80));
const ownerCounter = await call(A, "javascript_tool", { tabId: tabA, text: "window.__crossSessionCounter" });
check("A's counter is unchanged by both refusals", !ownerCounter.isError && ownerCounter.text.trim() === "0", ownerCounter.text.slice(0, 80));

// storage is the most sensitive new tool (auth tokens) — confirm the same gate.
const crossSt = await call(B, "storage", { tabId: tabA, area: "local", action: "get" });
check("B CANNOT read A's storage (isolation)", crossSt.isError && /not in your|tab group/i.test(crossSt.text), crossSt.text.slice(0, 80));

// --- Every tool that takes a tabId refuses B on A's real tab. The list comes from
// the server's own catalog, so a new tool with a tabId fails here until it gets
// arguments. Calls that need a ref get A's own valid ref: only the session gate
// stands between B and A's page, and A's page state must come out unchanged. ---
const refOf = async selector => {
  const resolved = await call(A, "resolve_target", { tabId: tabA, target: { selector } });
  try { return JSON.parse(resolved.text).ref; } catch { return undefined; }
};
const refs = { field: await refOf("#field"), button: await refOf("#button"), choice: await refOf("#choice"), upload: await refOf("#upload"), drop: await refOf("#drop") };
check("A resolves its own refs for the cross-session matrix", Object.values(refs).every(ref => /^ref_\d+$/.test(ref ?? "")), JSON.stringify(refs));
const seededState = await call(A, "javascript_tool", { tabId: tabA,
  text: `(()=>{window.__crossSessionToken=${JSON.stringify(randomUUID())};window.__crossSessionClicks=0;window.__crossSessionDropped=0;localStorage.setItem('cross-session-marker','kept');document.cookie='cross-session=kept';return true})()` });
check("A seeds the page state the matrix must leave unchanged", !seededState.isError && seededState.text.trim() === "true", seededState.text.slice(0, 80));
const pageStateA = async () => (await call(A, "javascript_tool", { tabId: tabA,
  text: `JSON.stringify({token:window.__crossSessionToken,href:location.href,title:document.title,counter:window.__crossSessionCounter,clicks:window.__crossSessionClicks,field:document.getElementById('field').value,choice:document.getElementById('choice').value,files:document.getElementById('upload').files.length,dropped:window.__crossSessionDropped,stored:localStorage.getItem('cross-session-marker'),cookie:document.cookie,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollY:Math.round(scrollY)})` })).text;
const stateBefore = await pageStateA();
const targetsOfA = async () => (await pageTargets()).filter(target => target.url === `${origin}/own`).map(target => target.targetId);
const targetsBefore = await targetsOfA();
// B's own recipes, so the recipe tools reach A's tab through B's own steps. The
// resumable one stops before its second step dispatches, leaving B a verified
// checkpoint that recipe_resume can then aim at A's tab.
const runProbe = `cross-session-run-${randomUUID()}`, resumeProbe = `cross-session-resume-${randomUUID()}`;
const savedRun = await call(B, "recipe_save", { name: runProbe, actions: [{ tool: "javascript_tool", args: { text: "window.__crossSessionCounter = (window.__crossSessionCounter||0)+1" } }] });
const savedResume = await call(B, "recipe_save", { name: resumeProbe, actions: [
  { tool: "navigate", args: { url: `${origin}/ready` }, expect: { selector: "#ready" } },
  { tool: "computer", args: { action: "left_click" }, target: { selector: "#absent" }, expect: { selector: "#ready" } },
] });
const ownResume = await call(B, "recipe_run", { name: resumeProbe, tabId: tabB, resumable: true });
const resumeId = ownResume.summary?.resumeId;
const checkpoints = await call(B, "recipe_checkpoints", {});
let resumable = false;
try { resumable = JSON.parse(checkpoints.text).some(entry => entry.resumeId === resumeId && entry.resumable === true); } catch { /* keep false */ }
check("B holds recipes of its own and a verified checkpoint on its own tab", !savedRun.isError && !savedResume.isError && resumable,
  `${savedRun.text.slice(0, 40)} ${savedResume.text.slice(0, 40)} resumeId=${resumeId} ${ownResume.text.replace(/\s+/g, " ").slice(0, 120)}`);
const crossArgs = {
  resize_window: { width: 500, height: 400 },
  read_network_requests: {},
  navigate: { url: `${origin}/elsewhere` },
  get_page_text: {},
  javascript_tool: { text: "window.__crossSessionCounter = (window.__crossSessionCounter||0)+1" },
  read_page: {},
  resolve_target: { target: { selector: "#field" } },
  extract_table: {},
  read_page_diff: { reset: true },
  screenshot_marked: {},
  find: { query: "Cross-session field" },
  form_input: { ref: refs.field, value: "written by B" },
  fill_form: { fields: [{ ref: refs.field, value: "written by B" }], submitRef: refs.button },
  computer: { action: "left_click", ref: refs.button },
  file_upload: { ref: refs.upload, paths: [join(root, "package.json")] },
  read_console_messages: {},
  wait_for: { predicate: "window.__crossSessionCounter = (window.__crossSessionCounter||0)+1", timeoutMs: 1000 },
  select_option: { ref: refs.choice, value: "Second" },
  upload_image: { ref: refs.upload },
  recipe_run: { name: runProbe },
  recipe_resume: { resumeId: resumeId ?? randomUUID(), name: resumeProbe },
  recipe_record: { action: "start" },
  gif_creator: { action: "start_recording" },
  tab_switch: { bringToFront: true },
  tab_reload: {},
  tab_duplicate: {},
  storage: { area: "local", action: "clear" },
  get_accessibility_tree: {},
  file_drop: { ref: refs.drop, path: join(root, "package.json") },
  download: { action: "arm" },
  print_to_pdf: {},
  cookies: { action: "clear" },
  screenshot: {},
  emulate_device: { width: 320, height: 480, deviceScaleFactor: 2 },
  dialog: { action: "arm", behavior: "accept" },
  tabs_close_mcp: {}, // last: a broken gate here would end the matrix's page
};
// Recording and resuming check the calling session's own tab list in the server
// and refuse there, before any extension call, with their own message.
const serverRefusals = { recipe_record: /Fliken tillhör inte den valda sessionen/, recipe_resume: /Target tab is not owned/ };
const gateRefusal = `TAB_NOT_IN_GROUP: Tab ${tabA} is not in your session's MCP tab group`;
const tabTools = (await B.listTools()).tools.filter(tool => tool.inputSchema?.properties?.tabId).map(tool => tool.name);
check("every catalog tool with a tabId has cross-session arguments, and no stale entry remains",
  tabTools.every(name => Object.hasOwn(crossArgs, name)) && Object.keys(crossArgs).every(name => tabTools.includes(name)),
  `without arguments: ${tabTools.filter(name => !Object.hasOwn(crossArgs, name)).join(", ") || "none"}; not in the catalog: ${Object.keys(crossArgs).filter(name => !tabTools.includes(name)).join(", ") || "none"}`);
for (const name of Object.keys(crossArgs).filter(tool => tabTools.includes(tool))) {
  const refused = await call(B, name, { ...crossArgs[name], tabId: tabA });
  const expected = serverRefusals[name];
  check(`B's ${name} on A's tab is refused`, refused.isError && (expected ? expected.test(refused.text) : refused.text.includes(gateRefusal)), refused.text.replace(/\s+/g, " ").slice(0, 120));
}
const stateAfter = await pageStateA();
check("A's page state is unchanged by every refused call", stateBefore.startsWith("{") && stateAfter === stateBefore, `before ${stateBefore.slice(0, 160)} after ${stateAfter.slice(0, 160)}`);
const targetsAfter = await targetsOfA();
check("A's tab is still the one page at its address (not closed, reloaded into another target or duplicated)",
  targetsBefore.length === 1 && JSON.stringify(targetsAfter) === JSON.stringify(targetsBefore), `${JSON.stringify(targetsBefore)} -> ${JSON.stringify(targetsAfter)}`);
const groupsAfter = [await call(A, "tabs_context_mcp", {}), await call(B, "tabs_context_mcp", {})].map(r => { try { return JSON.parse(r.text).tabs.map(tab => tab.tabId); } catch { return null; } });
check("each session's group still holds exactly its own tab", JSON.stringify(groupsAfter) === JSON.stringify([[tabA], [tabB]]), JSON.stringify(groupsAfter));

const recA = await call(A, "gif_creator", { action: "start_recording", tabId: tabA });
check("A starts its own recording", !recA.isError);
// B's refused export below proves isolation only while A holds frames to take.
const stopA = await call(A, "gif_creator", { action: "stop_recording", tabId: tabA });
let framesA = 0;
try { framesA = JSON.parse(stopA.text).frames; } catch { /* keep 0 */ }
check("A's recording holds at least one frame", !stopA.isError && framesA >= 1, stopA.text.slice(0, 80));
const gifB = await call(B, "gif_creator", { action: "export", tabId: tabB });
check("B cannot export A's recording", gifB.isError && /No frames recorded for this session/.test(gifB.text));
await call(A, "gif_creator", { action: "clear", tabId: tabA });
const armA = await call(A, "download", { action: "arm", tabId: tabA });
check("A arms a download", !armA.isError && JSON.parse(armA.text).armed === true);
const armB = await call(B, "download", { action: "arm", tabId: tabB });
check("B cannot take a fresh download arm", !armB.isError && JSON.parse(armB.text).ok === false);
const refusedBatch = await call(B, "browser_batch", { actions: [
  { tool: "download", args: { action: "arm", tabId: tabB } },
  { tool: "tabs_create_mcp", args: {} },
] });
const refusedSteps = JSON.parse(refusedBatch.text);
check("B batch stops after its refused download arm", refusedBatch.isError && refusedSteps.length === 1 && refusedSteps[0].ok === false && refusedBatch.summary?.failedStep === 1 && refusedBatch.summary?.completedSteps === 0);
const contextB = await call(B, "tabs_context_mcp", {});
check("B batch never runs the dependent tab creation", !contextB.isError && JSON.parse(contextB.text).tabs.length === 1);
const triggerA = await call(A, "javascript_tool", {
  tabId: tabA,
  text: `(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['session-a'],{type:'text/plain'}));a.download='ccmcp-session-a.txt';document.body.appendChild(a);a.click();return true})()`,
});
check("A triggers its armed download", !triggerA.isError && triggerA.text.trim() === "true");
const collectB = await call(B, "download", { action: "collect", tabId: tabB, timeoutMs: 100 });
check("B collect cannot receive A's capture", !collectB.isError && JSON.parse(collectB.text).state === "timeout");
const collectA = await call(A, "download", { action: "collect", tabId: tabA, timeoutMs: 8000 });
let capturedA = false;
try {
  const result = JSON.parse(collectA.text);
  capturedA = !collectA.isError && result.state === "completed" && readFileSync(result.path, "utf8") === "session-a";
  if (capturedA) rmSync(result.path);
} catch { /* retain failed assertion */ }
check("A receives its own completed file after B's collect", capturedA);

// --- A tab the page opens itself (target=_blank) joins the group unrecorded.
// Closing the first tab must not cost the session its group: once outside
// Tabai through the browser's CDP endpoint, once with tabs_close_mcp. ---
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(probe, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await sleep(100);
  }
}
const workerTarget = (await observer.rpc("Target.getTargets")).targetInfos.find(target => target.type === "service_worker"
  && target.url.startsWith("chrome-extension://") && new URL(target.url).pathname === "/dist/background.js");
if (!workerTarget) throw new Error("the extension's service worker target was not found");
const workerSession = (await observer.rpc("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: true })).sessionId;
// Observation only: whether the worker has recorded a page target as part of a
// session's group identity. Waiting on it keeps the test free of fixed delays.
async function recordedInIdentity(targetId) {
  const result = await observer.rpc("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
    expression: `chrome.storage.local.get(null).then(all => Object.entries(all).some(([key, value]) => key.startsWith("mcpGroupIdentity:") && Object.values(value?.targets ?? {}).includes(${JSON.stringify(targetId)})))` }, workerSession);
  return result.result?.value === true;
}
async function openFromPage(c, tabId, name) {
  const loaded = await call(c, "navigate", { tabId, url: `${origin}/start?case=${name}`, waitUntil: "load" });
  check(`${name}: the start page loads`, !loaded.isError, loaded.text.slice(0, 80));
  const found = await call(c, "find", { tabId, query: "Open the next step link" });
  const ref = found.text.match(/\[(ref_\d+)\]/)?.[1];
  const clicked = ref ? await call(c, "computer", { tabId, action: "left_click", ref }) : { isError: true, text: found.text };
  check(`${name}: the target=_blank link is clicked by ref`, !clicked.isError, clicked.text.slice(0, 80));
  return poll(async () => (await pageTargets()).find(target => target.url === `${origin}/opened?case=${name}`), 10000);
}
const contextOf = async c => { const r = await call(c, "tabs_context_mcp", {}); try { return r.isError ? null : JSON.parse(r.text); } catch { return null; } };

const openedA = await openFromPage(A, tabA, "cdp");
check("cdp: the link opens a second tab", Boolean(openedA));
if (openedA) {
  // The creation hook must have recorded the page-opened tab before the first
  // tab closes; otherwise the check below could pass only by luck of timing.
  check("cdp: the page-opened tab is recorded before the first tab closes", await poll(() => recordedInIdentity(openedA.targetId), 5000));
  const first = (await pageTargets()).find(target => target.url === `${origin}/start?case=cdp`);
  await observer.rpc("Target.closeTarget", { targetId: first.targetId });
  await poll(async () => !(await pageTargets()).some(target => target.targetId === first.targetId), 5000);
  const context = await contextOf(A);
  const remaining = context?.tabs?.length === 1 && context.tabs[0].url === openedA.url ? context.tabs[0].tabId : undefined;
  check("cdp: the session keeps its group after the first tab closes outside Tabai", remaining !== undefined, JSON.stringify(context ?? {}).slice(0, 160));
  const title = remaining === undefined ? null : await call(A, "javascript_tool", { tabId: remaining, text: "document.title" });
  check("cdp: the session still controls the page-opened tab", title?.isError === false && title.text.trim() === "Opened step", title?.text.slice(0, 80));
}

const openedB = await openFromPage(B, tabB, "close");
check("close: the link opens a second tab", Boolean(openedB));
const listedB = await poll(async () => { const context = await contextOf(B); return context?.tabs?.length === 2 ? context : null; }, 10000);
check("close: tabs_context_mcp lists both tabs in the group", Boolean(listedB), JSON.stringify(listedB ?? {}).slice(0, 160));
const closedB = await call(B, "tabs_close_mcp", { tabId: tabB });
check("close: tabs_close_mcp closes the first tab", !closedB.isError, closedB.text.slice(0, 80));
{
  const context = await contextOf(B);
  const remaining = context?.tabs?.length === 1 && openedB && context.tabs[0].url === openedB.url ? context.tabs[0].tabId : undefined;
  check("close: the session keeps its group after tabs_close_mcp closes the first tab", remaining !== undefined, JSON.stringify(context ?? {}).slice(0, 160));
  const title = remaining === undefined ? null : await call(B, "javascript_tool", { tabId: remaining, text: "document.title" });
  check("close: the session still controls the page-opened tab", title?.isError === false && title.text.trim() === "Opened step", title?.text.slice(0, 80));
}

// --- reaping: ending a session reaps its group. Close both servers, let the
// broker's grace timer fire, and verify it logged a reap (the extension then
// closes the orphaned group's tabs). ---
const reapStart = Date.now();
await A.close();
await B.close();
const graceMs = Number(process.env.CCMCP_REAP_GRACE_MS || 2000);
const logDir = process.env.CCMCP_LOG_DIR || join(homedir(), ".claude-chrome-mcp", "logs");
// POLL the log until the reap appears — robust against the server-exit + grace
// timing (a single fixed-delay read raced the actual reap).
const deadline = Date.now() + graceMs + 15000; // generous: absorbs server-exit lag under CI load
let reaped = false;
while (Date.now() < deadline && !reaped) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    for (const f of readdirSync(logDir)) {
      // The reap is logged by the broker (broker-*.log); per-call events live in
      // server-*.log. Scan every current log file and match on the event itself.
      if (!f.endsWith(".log")) continue;
      for (const line of readFileSync(join(logDir, f), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.event === "session-reaped" && e.ts >= reapStart) reaped = true;
        } catch {
          /* skip non-JSON */
        }
      }
    }
  } catch {
    /* log dir may not exist yet */
  }
}
if (!reaped) {
  // On failure, summarize the log we polled — distinguishes "broker logged
  // elsewhere" from "reap never fired" (the two failure modes this test has hit).
  console.log("reap not seen — events in", logDir, ":");
  try {
    for (const f of readdirSync(logDir)) {
      const lines = readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean);
      const events = {};
      for (const line of lines) {
        try {
          events[JSON.parse(line).event] = (events[JSON.parse(line).event] || 0) + 1;
        } catch {
          /* skip non-JSON */
        }
      }
      console.log(`  ${f} (${lines.length} lines):`, JSON.stringify(events));
    }
  } catch (e) {
    console.log("  (log read failed:", e.message, ")");
  }
}
check("session reap fires when a session's server ends", reaped);
// The log line alone does not prove cleanup: the tabs that remained in each
// group, including the page-opened ones, must actually be gone.
const leftovers = () => pageTargets().then(targets => targets.filter(target => target.url.startsWith(`${origin}/`)).map(target => target.url));
const gone = await poll(async () => (await leftovers()).length === 0, graceMs + 15000);
check("the session's end closes the tabs that remained in its group", gone, gone ? "" : JSON.stringify(await leftovers()));
observer.socket.terminate();
fixture.closeAllConnections(); fixture.close();

console.log(`\n=== two-session-isolation: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
