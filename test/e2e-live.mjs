import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";
// Comprehensive live end-to-end test against the REAL Chrome extension.
// Spawns the MCP server, waits for the (reloaded) extension to connect, then
// exercises every Core-tier tool deterministically by injecting a form into
// a local HTTP fixture via javascript_tool and driving it.
//
// Prereq: extension RELOADED in Chrome (↻ on the card) after the latest build;
// nothing else bound to :9223. The CI harness also passes its browser's CDP
// endpoint; a direct run has none and shows the checks that need it as skipped.
import http from "node:http";
import { once } from "node:events";


import { fileURLToPath } from "node:url";
import { dirname, join, relative, isAbsolute } from "node:path";
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Real HTTP navigation and subframes without depending on an external site.
const fixtureUrl = "http://127.0.0.1:9238/example";
// The same server answers as http://localhost:9238, a different site, so a
// frame loaded from there runs out of process like a real third-party frame.
const crossSiteFrameUrl = "http://localhost:9238/cross-site-frame";
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">';
const fixturePages = {
  // A long list: a click that scrolls the page moves the rows under later coordinates.
  "/rows": `${head}<title>Rows</title><style>body{margin:0}.row{height:40px;border-bottom:1px solid #ccc;box-sizing:border-box}</style><div id="rows"></div><script>window.__ccRows=[];const list=document.getElementById('rows');for(let i=0;i<120;i++){const row=document.createElement('div');row.className='row';row.id='row-'+i;row.textContent='Row '+i;row.addEventListener('click',()=>window.__ccRows.push(row.id));list.appendChild(row);}</script>`,
  "/pointer-targets": `${head}<title>Pointer targets</title><style>body{margin:0}#host{position:absolute;left:20px;top:20px}#frame{position:absolute;left:20px;top:120px;width:300px;height:150px;border:0}</style><div id="host"></div><iframe id="frame" src="/example"></iframe><script>const root=document.getElementById('host').attachShadow({mode:'open'});root.innerHTML='<button id="inner" style="width:160px;height:40px">Shadow target</button>';window.__ccShadowHits=0;root.getElementById('inner').addEventListener('click',()=>window.__ccShadowHits++);</script>`,
  // The page itself cannot scroll; only the pane can. The label sits outside it.
  "/inner-scroll": `${head}<title>Inner scroll</title><style>html,body{margin:0;height:100%;overflow:hidden}#pane{position:absolute;inset:0;overflow:auto}#pane-content{height:5000px}#static{position:fixed;left:0;top:0;width:160px;height:40px;background:#eee;z-index:2}</style><div id="static">Static label</div><div id="pane"><div id="pane-content"><p id="item" style="margin:200px 0 0 20px">Pane item</p></div></div>`,
  "/smooth": `${head}<title>Smooth page</title><style>html{scroll-behavior:smooth}body{margin:0;height:5000px}</style><p>Smooth scrolling page</p>`,
  // A short scrollable block fixed under the viewport centre of a long page.
  "/fixed-block": `${head}<title>Fixed block</title><style>body{margin:0;height:5000px}#block{position:fixed;left:50%;top:50%;width:240px;height:120px;margin:-60px 0 0 -120px;overflow:auto;background:#eef}#block-content{height:400px}</style><div id="block"><div id="block-content">Short scrollable block</div><button>Block button</button></div>`,
  "/cross-site-frame": `${head}<title>Cross-site frame</title><input type="file" aria-label="cross site upload"><script>const input=document.querySelector('input');input.addEventListener('change',()=>parent.postMessage({ccCrossFile:input.files[0]?input.files[0].name:''},'*'));parent.postMessage({ccCrossReady:true},'*');</script>`,
};
const serveFixture = (request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  const page = fixturePages[new URL(request.url, "http://127.0.0.1").pathname];
  response.end(page ?? '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabai test page</title><h1>Tabai test page</h1><p>Browser interaction fixture.</p><a href="/example">Example link</a>');
};
const fixture = http.createServer(serveFixture);
fixture.listen(9238, "127.0.0.1");
await once(fixture, "listening");
// localhost may resolve to ::1 first; answer there too when the host has IPv6.
const fixtureV6 = http.createServer(serveFixture);
fixtureV6.on("error", () => {});
fixtureV6.listen(9238, "::1");
console.log(`e2e fixture PID ${process.pid}, port 9238`);
process.once("exit", () => {
  for (const server of [fixture, fixtureV6]) { server.closeAllConnections(); if (server.listening) server.close(); }
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browserEndpoint = process.argv[2];
// The harness (which sets the test download directory) always passes it.
if (process.env.CCMCP_TEST_DOWNLOAD_DIR && !browserEndpoint) throw new Error("the CI harness must pass its browser's CDP endpoint to e2e-live");
if (browserEndpoint && new URL(browserEndpoint).hostname !== "127.0.0.1") throw new Error("the CDP endpoint must be loopback");
const ownConfig = !process.env.CCMCP_CONFIG_DIR;
const configDir = process.env.CCMCP_CONFIG_DIR || mkdtempSync(join(tmpdir(), "ccmcp-live-config-"));
const recipesFile = join(configDir, "recipes.json");
const fixtureRecipes = ["ccmcp-test-recipe", "ccmcp-test-recipe-noargs"];
const originalRecipes = existsSync(recipesFile) ? JSON.parse(readFileSync(recipesFile, "utf8")) : {};
process.on("exit", () => {
  if (ownConfig) { rmSync(configDir, { recursive: true, force: true }); return; }
  if (!existsSync(recipesFile)) return;
  const recipes = JSON.parse(readFileSync(recipesFile, "utf8"));
  for (const name of fixtureRecipes) {
    if (Object.hasOwn(originalRecipes, name)) recipes[name] = originalRecipes[name];
    else delete recipes[name];
  }
  writeFileSync(recipesFile, JSON.stringify(recipes, null, 2));
});
const expectedVersion = JSON.parse(
  readFileSync(join(root, "extension", "manifest.json"), "utf8"),
).version;
const transport = createMcpTransport({
  command: process.execPath,
  args: [join(root, "dist", "server.js")],
  cwd: root,
  // Propagate runtime env (CCMCP_* ports + reap grace) to the server, which
  // forwards it to the broker it auto-spawns.
  env: { ...process.env, CCMCP_CONFIG_DIR: configDir },
});
const client = createMcpClient({ name: "e2e-live", version: "0.0.0" });
await connectMcpClient(client, transport);
console.log("server up; waiting for the (reloaded) extension to connect…");

let pass = 0;
let fail = 0;
let skipped = 0;
// Every check call site in this file must run, or a block that silently skips
// its checks would leave the suite green. The expected sites are read from this
// file's own source, so the count cannot drift from the checks that exist.
const checkSites = new Map();
readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").forEach((line, index) => {
  const calls = line.match(/(?<![\w.$])check\(/g)?.length ?? 0;
  if (!calls || /^\s*function check\(/.test(line)) return;
  if (calls > 1) throw new Error(`e2e-live.mjs:${index + 1} holds ${calls} check calls; keep one per line so every site is counted`);
  checkSites.set(index + 1, line.trim());
});
const ranSites = new Set();
/** A check that cannot run here: shown as skipped and never counted as passed. */
const skip = reason => ({ skipped: reason });
function check(name, ok, detail = "") {
  const site = /e2e-live\.mjs:(\d+):\d+/.exec(new Error().stack?.split("\n")[2] ?? "")?.[1];
  if (site) ranSites.add(Number(site));
  if (ok && typeof ok === "object" && "skipped" in ok) {
    console.log(`  - ${name} — skipped: ${ok.skipped}`);
    skipped++;
    return;
  }
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}
/** The else branch of a conditional block: its checks did not run, which fails. */
function missing(name, detail) {
  console.log(`  ✗ ${name} — not run: ${detail}`);
  fail++;
}
async function call(name, args = {}) {
  const res = await callRaw(client, { name, arguments: args });
  return { isError: res.isError === true, content: res.content ?? [], text: res.content?.[0]?.text ?? "" };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const extensionWorker = targets => targets.find(target => target.type === "service_worker"
  && target.url.startsWith("chrome-extension://") && new URL(target.url).pathname === "/dist/background.js");
/** One browser-level CDP socket for the duration of `run`; never a page debugger. */
async function withBrowser(run) {
  const observer = await openCdpObserver(browserEndpoint, { timeoutMs: 10_000, timeoutMessage: method => `CDP ${method} timed out` });
  try { return await run(observer); }
  finally { observer.rejectPending(new Error("CDP observer closed")); observer.socket.terminate(); }
}
/** Stop the extension's service worker as Chrome does when it idles; the next
 *  tool call starts a fresh one. True once the old worker is gone. */
async function restartExtensionWorker() {
  return withBrowser(async observer => {
    const worker = extensionWorker((await observer.rpc("Target.getTargets")).targetInfos);
    if (!worker) return false;
    await observer.rpc("Target.closeTarget", { targetId: worker.targetId });
    for (const until = Date.now() + 10_000; Date.now() < until; await sleep(100)) {
      if (!(await observer.rpc("Target.getTargets")).targetInfos.some(target => target.targetId === worker.targetId)) return true;
    }
    return false;
  });
}

// Wait until the EXACT current build is loaded (reload the card if this waits).
// The manifest version cannot tell a stale bundle from this build, so every peer
// must report the build ID of the server this suite just started.
console.log(`waiting for extension version ${expectedVersion} and this build on the extension and broker (reload the card if this waits)…`);
const deadline = Date.now() + 150_000;
let ctx = null;
let lastPeers = "";
while (Date.now() < deadline) {
  const h = await call("health");
  let health = null;
  try { health = h.isError ? null : JSON.parse(h.text); } catch { /* not ready */ }
  const extension = health && typeof health.extension === "object" ? health.extension : {};
  if (health && extension.extVersion === expectedVersion && extension.buildId === health.serverBuildId && health.brokerBuildId === health.serverBuildId) {
    const r = await call("tabs_context_mcp", { createIfEmpty: true });
    if (!r.isError) {
      ctx = JSON.parse(r.text);
      break;
    }
  }
  const peers = !health ? "." : `[extension ${extension.extVersion ?? "?"}: ${extension.buildId === health.serverBuildId ? "this build" : "another build"}; broker: ${health.brokerBuildId === health.serverBuildId ? "this build" : "another build"}]`;
  if (peers !== lastPeers || peers === ".") process.stdout.write(peers);
  lastPeers = peers;
  await new Promise((res) => setTimeout(res, 2000));
}
if (!ctx) {
  console.error(`\n✗ the extension and broker never both ran this build (${expectedVersion}) — reload the card (↻), or remove+re-add on permission changes; restart the broker with npm run kill-broker when health lists it under refresh.`);
  await client.close();
  process.exit(1);
}
const tabId = ctx.tabs?.[0]?.tabId;
console.log(`\n✓ connected. version=${ctx.version} tabId=${tabId}\n`);

// --- Security boundary red-path: these MUST be refused ---
const bogusTab = (tabId ?? 0) + 999999; // not in the MCP group
const rpOg = await call("read_page", { tabId: bogusTab });
check("read_page rejects out-of-group tab", rpOg.isError && /tab group|not found/i.test(rpOg.text), rpOg.text.slice(0, 80));
const rpFile = await call("navigate", { url: "file:///etc/passwd", tabId });
check("navigate rejects file:// scheme", rpFile.isError && /non-http|refus/i.test(rpFile.text), rpFile.text.slice(0, 80));
const rpChrome = await call("navigate", { url: "chrome://settings", tabId });
check("navigate rejects chrome:// scheme", rpChrome.isError && /non-http|refus/i.test(rpChrome.text), rpChrome.text.slice(0, 80));
const rpGif = await call("gif_creator", { action: "start_recording", tabId: bogusTab });
check("gif_creator rejects out-of-group tab", rpGif.isError && /tab group|not found/i.test(rpGif.text), rpGif.text.slice(0, 80));

const initialNav = await call("navigate", { url: fixtureUrl, tabId });
check("navigate local HTTP fixture", !initialNav.isError, initialNav.isError ? initialNav.text : "");

// Inject a deterministic form to drive.
const inject = await call("javascript_tool", {
  tabId,
  text: `(()=>{const d=document.createElement('div');d.innerHTML='<input id="ccin" placeholder="Email address"><button id="ccbtn" onclick="window.__ccClicked=true">Submit Now</button>';document.body.appendChild(d);return 'injected';})()`,
});
check("javascript_tool inject form", inject.text.includes("injected"), inject.text);

// find -> ref of the input
const found = await call("find", { query: "Email address", tabId });
const inRef = found.text.match(/\[(ref_\d+)\][^\n]*Email/i)?.[1] ?? found.text.match(/\[(ref_\d+)\]/)?.[1];
check("find Email input", Boolean(inRef), inRef ? `${inRef}` : found.text);

// form_input -> set value
if (inRef) {
  const fi = await call("form_input", { ref: inRef, value: "hi@ccmcp.dev", tabId });
  check("form_input set value", !fi.isError, fi.text);
  const readback = await call("javascript_tool", { tabId, text: `document.getElementById('ccin').value` });
  check("value persisted in DOM", readback.text.includes("hi@ccmcp.dev"), readback.text);
  // computer type must land in the focused input (ref-click focuses it first).
  await call("computer", { action: "left_click", ref: inRef, tabId });
  await call("computer", { action: "type", text: "Z", tabId });
  const rb2 = await call("javascript_tool", { tabId, text: `document.getElementById('ccin').value` });
  check("computer type lands in focused input", rb2.text.includes("hi@ccmcp.devZ"), rb2.text);
} else missing("form_input and computer type checks", "find returned no ref for the Email input");

// find button -> computer left_click -> verify side effect
const foundBtn = await call("find", { query: "Submit Now", tabId });
const btnRef = foundBtn.text.match(/\[(ref_\d+)\][^\n]*Submit/i)?.[1] ?? foundBtn.text.match(/\[(ref_\d+)\]/)?.[1];
check("find Submit button", Boolean(btnRef), btnRef ?? foundBtn.text);
if (btnRef) {
  const clicked = await call("computer", { action: "left_click", ref: btnRef, tabId });
  check("computer left_click", !clicked.isError, clicked.text);
  const sideEffect = await call("javascript_tool", { tabId, text: `window.__ccClicked === true` });
  check("click side-effect fired", sideEffect.text.trim() === "true", sideEffect.text);
} else missing("computer left_click checks", "find returned no ref for the Submit button");

// fill_form: set a field + submit in ONE call (reuses inRef + btnRef).
if (inRef && btnRef) {
  await call("javascript_tool", {
    tabId,
    text: `(()=>{document.getElementById('ccin').value='';window.__ccClicked=false;return 'reset';})()`,
  });
  const ffr = await call("fill_form", {
    tabId,
    fields: [{ ref: inRef, value: "batch@ccmcp.dev" }],
    submitRef: btnRef,
  });
  check("fill_form set + submit", !ffr.isError && /"submitted":\s*true/.test(ffr.text), ffr.text.slice(0, 80));
  const ffv = await call("javascript_tool", { tabId, text: `document.getElementById('ccin').value` });
  check("fill_form value persisted", ffv.text.includes("batch@ccmcp.dev"), ffv.text);
  const ffs = await call("javascript_tool", { tabId, text: `window.__ccClicked === true` });
  check("fill_form submit fired", ffs.text.trim() === "true", ffs.text);
  // honest-miss: a TOTAL failure (every field bad) now THROWS — consistent with
  // form_input/select_option — never a silent success. (Partial success still
  // returns per-field detail.)
  const ffbad = await call("fill_form", { tabId, fields: [{ ref: "ref_999999", value: "x" }] });
  check("fill_form throws when all fields fail", ffbad.isError && /field\(s\) failed/.test(ffbad.text), ffbad.text.slice(0, 80));
} else missing("fill_form checks", "find returned no ref for the Email input or the Submit button");

// --- Phase 4: storage, accessibility tree, tab_reload, tab_duplicate ---
// storage round-trips local; clear empties it.
const stSet = await call("storage", { tabId, area: "local", action: "set", key: "ccmcp_k", value: "ccmcp_v" });
check("storage set", !stSet.isError && /"ok":\s*true/.test(stSet.text), stSet.text.slice(0, 60));
const stGet = await call("storage", { tabId, area: "local", action: "get", key: "ccmcp_k" });
check("storage get returns value", stGet.text.includes("ccmcp_v"), stGet.text.slice(0, 60));
const stClear = await call("storage", { tabId, area: "local", action: "clear" });
check("storage clear", !stClear.isError && /"ok":\s*true/.test(stClear.text), stClear.text.slice(0, 60));
const stGet2 = await call("storage", { tabId, area: "local", action: "get", key: "ccmcp_k" });
check("storage cleared (null)", /"value":\s*null/.test(stGet2.text), stGet2.text.slice(0, 60));
// the real use case: storage (isolated world) must read what the PAGE (MAIN world) wrote.
await call("javascript_tool", { tabId, text: `localStorage.setItem('cc_page','from_page')` });
const stPage = await call("storage", { tabId, area: "local", action: "get", key: "cc_page" });
check("storage reads page-written value", stPage.text.includes("from_page"), stPage.text.slice(0, 60));

// get_accessibility_tree: a non-empty hierarchical outline.
const ax = await call("get_accessibility_tree", { tabId, maxNodes: 50 });
check("a11y tree non-empty", !ax.isError && /"nodes":\s*[1-9]/.test(ax.text) && /"role"/.test(ax.text), ax.text.slice(0, 80));

// tab_reload: reloads + the URL persists.
const trl = await call("tab_reload", { tabId });
check("tab_reload ok", !trl.isError, trl.text.slice(0, 60));
const urlAfter = await call("javascript_tool", { tabId, text: `location.host` });
check("tab_reload URL persists", urlAfter.text.trim() === new URL(fixtureUrl).host, urlAfter.text.slice(0, 60));

// tab_duplicate: the copy joins the caller's group (read_page on it succeeds).
const dup = await call("tab_duplicate", { tabId });
const dupId = Number(dup.text.match(/"tabId":\s*(\d+)/)?.[1]);
check("tab_duplicate returns a new tab", dupId > 0 && dupId !== tabId, dup.text.slice(0, 80));
if (dupId) {
  // Verify group membership via the group listing (toolTabDuplicate groups the
  // copy before returning), not read_page — the dupe loads async, so read_page
  // would race a not-yet-scriptable document ("cannot access contents").
  const ctxDup = await call("tabs_context_mcp", {});
  check("duplicated tab is in the caller's group", !ctxDup.isError && JSON.parse(ctxDup.text).tabs.some(tab => tab.tabId === dupId), ctxDup.text.slice(0, 120));
  await call("tabs_close_mcp", { tabId: dupId });
} else missing("duplicated tab group check", "tab_duplicate returned no tab");

// --- Phase 5: screenshot format/downscale + structured errors ---
// Cover the viewport in random noise so lossy JPEG materially beats lossless PNG
// (JPEG-vs-PNG size is content-dependent; flat pages compress smaller as PNG).
await call("javascript_tool", {
  tabId,
  text: `(()=>{const c=document.createElement('canvas');c.id='ccnoise';c.width=innerWidth;c.height=innerHeight;c.style.cssText='position:fixed;inset:0;z-index:99999';const x=c.getContext('2d');const d=x.createImageData(c.width,c.height);for(let i=0;i<d.data.length;i+=4){d.data[i]=Math.random()*255;d.data[i+1]=Math.random()*255;d.data[i+2]=Math.random()*255;d.data[i+3]=255;}x.putImageData(d,0,0);document.body.appendChild(c);return 'noise';})()`,
});
const shotPng = await call("screenshot", { tabId, format: "png" });
const shotJpg = await call("screenshot", { tabId }); // default jpeg
const pngLen = shotPng.content?.[0]?.data?.length ?? 0;
const jpgLen = shotJpg.content?.[0]?.data?.length ?? 0;
check("screenshot default JPEG smaller than PNG", jpgLen > 0 && pngLen > 0 && jpgLen < pngLen, `jpeg=${jpgLen} png=${pngLen}`);
check("screenshot JPEG mimeType", shotJpg.content?.[0]?.mimeType === "image/jpeg", String(shotJpg.content?.[0]?.mimeType));
const shotSmall = await call("screenshot", { tabId, maxWidth: 200 });
check("screenshot maxWidth downscales", (shotSmall.content?.[0]?.data?.length ?? 0) < jpgLen, `small=${shotSmall.content?.[0]?.data?.length} full=${jpgLen}`);
// remove the noise overlay so it doesn't cover later interaction tests (file_drop).
await call("javascript_tool", { tabId, text: `document.getElementById('ccnoise')?.remove(); 'cleaned'` });
// structured error: an out-of-group/bogus tab carries a machine-readable CODE prefix.
const codedErr = await call("read_page", { tabId: bogusTab });
check("tool error carries a structured code prefix", codedErr.isError && /^(TAB_NOT_FOUND|TAB_NOT_IN_GROUP):/.test(codedErr.text), codedErr.text.slice(0, 50));

// read_console_messages: emit a marker then read it back
await call("javascript_tool", { tabId, text: `console.log('ccmcp-console-marker-42'); 1` });
const logs = await call("read_console_messages", { tabId, pattern: "ccmcp-console-marker" });
check("read_console_messages captured marker", logs.text.includes("ccmcp-console-marker-42"), logs.text.slice(0, 120));

// read_page sanity
const page = await call("read_page", { tabId, filter: "interactive" });
check("read_page returns refs", /\[ref_\d+\]/.test(page.text), page.text.slice(0, 100).replace(/\s+/g, " "));

// read_page must never print a secret field's value (password type, or a
// current-password autocomplete on a plain text input) — only a masked length.
await call("javascript_tool", {
  tabId,
  text: `(()=>{const d=document.createElement('div');d.id='ccsecrets';d.innerHTML='<input type="password" id="ccpw" value="s3cr3t-x"><input type="text" autocomplete="current-password" id="ccpw2" value="s3cr3t-y">';document.body.appendChild(d);return 'ok'})()`,
});
const secretPage = await call("read_page", { tabId, filter: "interactive" });
check(
  "read_page masks secret field values",
  secretPage.text.includes("•••") && !secretPage.text.includes("s3cr3t-x") && !secretPage.text.includes("s3cr3t-y"),
  secretPage.text.match(/\[ref_\d+\][^\n]*•••[^\n]*/g)?.join(" | ") ?? secretPage.text.slice(0, 120),
);
await call("javascript_tool", { tabId, text: `document.getElementById('ccsecrets')?.remove(); 'cleaned'` });

// screenshot -> image content
const shot = await call("computer", { action: "screenshot", tabId });
const img = shot.content.find((c) => c.type === "image");
check(
  "computer screenshot returns image",
  Boolean(img?.data?.length),
  img ? `${img.data.length} b64 chars` : `no image — ${shot.text || JSON.stringify(shot.content).slice(0, 200)}`,
);

// --- Advanced tier ---
const sized = await call("resize_window", { width: 900, height: 700, tabId });
const sz = sized.isError ? null : JSON.parse(sized.text);
check("resize_window", Boolean(sz?.ok), sized.isError ? sized.text : `${sz?.width}x${sz?.height}`);

await call("javascript_tool", { tabId, text: `fetch(location.href).catch(()=>{}); 'started'` });
await call("computer", { action: "wait", duration: 1, tabId });
const net = await call("read_network_requests", { tabId, urlPattern: "example" });
check(
  "read_network_requests captured fetch",
  /"url"/.test(net.text) && /example/i.test(net.text),
  net.text.slice(0, 120).replace(/\s+/g, " "),
);

const created = await call("tabs_create_mcp", {});
const newTab = created.isError ? null : JSON.parse(created.text);
check("tabs_create_mcp", Boolean(newTab?.tabId), created.isError ? created.text : `tabId=${newTab?.tabId}`);
if (newTab?.tabId) {
  const closed = await call("tabs_close_mcp", { tabId: newTab.tabId });
  check("tabs_close_mcp", !closed.isError && /"ok":\s*true/.test(closed.text), closed.text.slice(0, 80));
} else missing("tabs_close_mcp", "tabs_create_mcp returned no tab to close");

// file_upload (debugger tier): inject a file input, upload a real local file.
await call("javascript_tool", {
  tabId,
  text: `(()=>{let i=document.getElementById('ccfile');if(!i){i=document.createElement('input');i.type='file';i.id='ccfile';i.setAttribute('aria-label','upload file here');document.body.appendChild(i);}return 'ok'})()`,
});
const ff = await call("find", { query: "upload file here", tabId });
const fileRef = ff.text.match(/\[(ref_\d+)\]/)?.[1];
check("find file input", Boolean(fileRef), fileRef ?? ff.text);
if (fileRef) {
  const up = await call("file_upload", {
    ref: fileRef,
    paths: [join(root, "package.json")],
    tabId,
  });
  check("file_upload", !up.isError, up.isError ? up.text : up.text.slice(0, 70));
  const fname = await call("javascript_tool", {
    tabId,
    text: `(()=>{const f=document.getElementById('ccfile').files[0];return f?f.name:'(none)'})()`,
  });
  check("file appears in input", fname.text.includes("package.json"), fname.text);
} else missing("file_upload checks", "find returned no ref for the file input");

// --- Phase 2: reliability ---
// auto-wait: a button disabled until 700ms — the click must wait for enabled.
await call("javascript_tool", {
  tabId,
  text: `(()=>{const b=document.createElement('button');b.id='ccwait';b.textContent='Delayed';b.disabled=true;b.setAttribute('aria-label','delayed action btn');b.onclick=()=>{window.__ccWaitClicked=true};document.body.appendChild(b);setTimeout(()=>{b.disabled=false},700);return 'ok'})()`,
});
const fw = await call("find", { query: "delayed action btn", tabId });
const waitRef = fw.text.match(/\[(ref_\d+)\]/)?.[1];
check("find delayed button", Boolean(waitRef), waitRef ?? fw.text);
if (waitRef) {
  const wc = await call("computer", { action: "left_click", ref: waitRef, tabId });
  check("auto-wait click (waited for enabled)", !wc.isError, wc.isError ? wc.text : wc.text.slice(0, 60));
  const we = await call("javascript_tool", { tabId, text: `window.__ccWaitClicked === true` });
  check("auto-wait click fired after enable", we.text.trim() === "true", we.text);
} else missing("auto-wait click checks", "find returned no ref for the delayed button");

// wait_for text: text injected after 500ms
await call("javascript_tool", {
  tabId,
  text: `setTimeout(()=>{const d=document.createElement('div');d.textContent='ccmcp-late-text-99';document.body.appendChild(d)},500); 'scheduled'`,
});
const wt = await call("wait_for", { tabId, text: "ccmcp-late-text-99", timeoutMs: 5000 });
check("wait_for text", !wt.isError, wt.isError ? wt.text : wt.text.slice(0, 60));

// wait_for network_idle: fire a fetch, then wait for idle
await call("javascript_tool", { tabId, text: `fetch(location.href).catch(()=>{}); 'fired'` });
const wn = await call("wait_for", { tabId, networkIdle: true, timeoutMs: 8000 });
check("wait_for network_idle", !wn.isError, wn.isError ? wn.text : wn.text.slice(0, 60));
const xhrThrow = await call("javascript_tool", {
  tabId,
  text: `(()=>{const xhr=new XMLHttpRequest();xhr.open('GET','/?ccmcp-xhr-throw');xhr.send();try{xhr.send();return false}catch{return true}})()`,
});
check("second XMLHttpRequest.send throws", !xhrThrow.isError && xhrThrow.text === "true");
const xhrIdleStart = Date.now();
const xhrIdle = await call("wait_for", { tabId, networkIdle: true, idleMs: 100, timeoutMs: 1500 });
check("XHR synchronous throw does not strand the network-idle counter", !xhrIdle.isError && Date.now() - xhrIdleStart < 1500, xhrIdle.text.slice(0, 80));

// select_option (native <select>)
await call("javascript_tool", {
  tabId,
  text: `(()=>{const s=document.createElement('select');s.id='ccsel';s.setAttribute('aria-label','pick color sel');['Red','Green','Blue'].forEach(t=>{const o=document.createElement('option');o.value=t.toLowerCase();o.textContent=t;s.appendChild(o)});document.body.appendChild(s);return 'ok'})()`,
});
const fsel = await call("find", { query: "pick color sel", tabId });
const selRef = fsel.text.match(/\[(ref_\d+)\]/)?.[1];
check("find select", Boolean(selRef), selRef ?? fsel.text);
if (selRef) {
  const so = await call("select_option", { ref: selRef, value: "Green", tabId });
  check("select_option", !so.isError, so.isError ? so.text : so.text.slice(0, 60));
  const sv = await call("javascript_tool", { tabId, text: `document.getElementById('ccsel').value` });
  check("select_option applied value", sv.text.includes("green"), sv.text);
} else missing("native select_option checks", "find returned no ref for the select");

// --- Page-interaction correctness: ok only when the state really changed ---
// checkbox: a string "false" leaves it unchecked; true toggles via a REAL click
// (frameworks listen for click, not a property write); a page handler that
// reverts the toggle is reported, never a false ok.
await call("javascript_tool", {
  tabId,
  text: `(()=>{const c=document.createElement('input');c.type='checkbox';c.id='cccb';c.setAttribute('aria-label','agree terms box');window.__ccCbClicks=0;c.addEventListener('click',()=>{window.__ccCbClicks++});document.body.appendChild(c);const r=document.createElement('input');r.type='checkbox';r.id='ccrev';r.setAttribute('aria-label','reverting box');r.addEventListener('click',e=>{e.preventDefault()});document.body.appendChild(r);return 'ok'})()`,
});
const fcb = await call("find", { query: "agree terms box", tabId });
const cbRef = fcb.text.match(/\[(ref_\d+)\][^\n]*agree/i)?.[1];
check("find checkbox", Boolean(cbRef), cbRef ?? fcb.text.slice(0, 60));
if (cbRef) {
  const f1 = await call("form_input", { ref: cbRef, value: "false", tabId });
  const s1 = await call("javascript_tool", { tabId, text: `document.getElementById('cccb').checked` });
  check('form_input "false" leaves the checkbox unchecked', !f1.isError && s1.text.trim() === "false", `${f1.text.slice(0, 40)} checked=${s1.text.trim()}`);
  const f2 = await call("form_input", { ref: cbRef, value: true, tabId });
  const s2 = await call("javascript_tool", { tabId, text: `JSON.stringify({checked:document.getElementById('cccb').checked,clicks:window.__ccCbClicks})` });
  check("form_input true checks via a real click (page click handler ran once)", !f2.isError && /"checked":true/.test(s2.text) && /"clicks":1/.test(s2.text), s2.text);
} else missing("checkbox form_input checks", "find returned no ref for the checkbox");
const frev = await call("find", { query: "reverting box", tabId });
const revRef = frev.text.match(/\[(ref_\d+)\][^\n]*reverting/i)?.[1];
if (revRef) {
  const f3 = await call("form_input", { ref: revRef, value: true, tabId });
  check("form_input reports a checkbox the page reverted (no false ok)", f3.isError && /did not change/.test(f3.text), f3.text.slice(0, 80));
} else missing("form_input reports a checkbox the page reverted", "find returned no ref for the reverting checkbox");
// read-back: UA sanitization, disabled fields and page normalization are
// reported; a secret field's value never appears in the error text.
await call("javascript_tool", {
  tabId,
  text: `(()=>{const n=document.createElement('input');n.type='number';n.id='ccnum';n.setAttribute('aria-label','amount number field');document.body.appendChild(n);const d=document.createElement('input');d.id='ccdis';d.disabled=true;d.setAttribute('aria-label','disabled locked field');document.body.appendChild(d);const p=document.createElement('input');p.type='password';p.id='ccpwn';p.setAttribute('aria-label','normalizing secret field');p.addEventListener('input',()=>{p.value='x'});document.body.appendChild(p);return 'ok'})()`,
});
const fnum = await call("find", { query: "amount number field", tabId });
const numRef = fnum.text.match(/\[(ref_\d+)\][^\n]*amount/i)?.[1];
if (numRef) {
  const fn = await call("form_input", { ref: numRef, value: "12,5", tabId });
  check("form_input reports a value the field sanitized away (type=number)", fn.isError && /rejected by the field/.test(fn.text), fn.text.slice(0, 80));
} else missing("form_input reports a sanitized number", "find returned no ref for the number field");
const fdis = await call("find", { query: "disabled locked field", tabId });
const disRef = fdis.text.match(/\[(ref_\d+)\][^\n]*locked/i)?.[1];
if (disRef) {
  const fd = await call("fill_form", { tabId, fields: [{ ref: disRef, value: "x" }] });
  check("fill_form reports a disabled field", fd.isError && /disabled/.test(fd.text), fd.text.slice(0, 80));
} else missing("fill_form reports a disabled field", "find returned no ref for the disabled field");
const fpwn = await call("find", { query: "normalizing secret field", tabId });
const pwnRef = fpwn.text.match(/\[(ref_\d+)\][^\n]*normalizing/i)?.[1];
if (pwnRef) {
  const fp = await call("form_input", { ref: pwnRef, value: "supersecret-value", tabId });
  check("form_input read-back error on a secret field carries no value", fp.isError && /secret field; length 1/.test(fp.text) && !fp.text.includes("supersecret"), fp.text.slice(0, 80));
} else missing("form_input read-back on a secret field", "find returned no ref for the normalizing secret field");
// key: modifiers + chords + the key table on the CDP (main-frame) path. Fresh
// fixtures: the tab_reload check above wiped the ones injected earlier.
await call("javascript_tool", {
  tabId,
  text: `(()=>{const e=document.createElement('input');e.id='cckeys';e.setAttribute('aria-label','keys probe field');e.value='hello';window.__ccKeys=[];e.addEventListener('keydown',ev=>{window.__ccKeys.push((ev.ctrlKey?'ctrl+':'')+(ev.metaKey?'meta+':'')+(ev.shiftKey?'shift+':'')+ev.key)});document.body.appendChild(e);return 'ok'})()`,
});
const fkeys = await call("find", { query: "keys probe field", tabId });
const keysRef = fkeys.text.match(/\[(ref_\d+)\][^\n]*keys probe/i)?.[1];
check("find keys probe field", Boolean(keysRef), keysRef ?? fkeys.text.slice(0, 60));
if (keysRef) {
  await call("computer", { action: "left_click", ref: keysRef, tabId });
  const k1 = await call("computer", { action: "key", text: "a", modifiers: "ctrl", tabId });
  const k1s = await call("javascript_tool", { tabId, text: `JSON.stringify({keys:window.__ccKeys,value:document.getElementById('cckeys').value})` });
  check('key "a" + modifiers "ctrl" fires ctrl+a and inserts nothing', !k1.isError && /"ctrl\+a"/.test(k1s.text) && /"value":"hello"/.test(k1s.text), k1s.text);
  // Select-all is a platform shortcut. On Linux/Windows Ctrl+A is a renderer
  // editing command, so the chord must trigger Chrome's default action; on
  // macOS Cmd+A is a browser-process menu accelerator that CDP-synthesized key
  // events cannot reach (a documented Chrome limitation), so only the parsed
  // modifier is asserted there.
  const mac = process.platform === "darwin";
  const selectAll = mac ? "cmd+a" : "ctrl+a";
  const k2 = await call("computer", { action: "key", text: selectAll, tabId });
  const k2s = await call("javascript_tool", { tabId, text: `(()=>{const e=document.getElementById('cckeys');return JSON.stringify({start:e.selectionStart,end:e.selectionEnd,last:window.__ccKeys[window.__ccKeys.length-1]})})()` });
  check(
    mac ? 'key chord "cmd+a" parses (meta flag on the event)' : 'key chord "ctrl+a" parses and selects all (trusted default action)',
    !k2.isError && (mac ? /"last":"meta\+a"/.test(k2s.text) : /"start":0,"end":5/.test(k2s.text)),
    k2s.text,
  );
  const k3 = await call("computer", { action: "key", text: "End Space", tabId });
  const k3s = await call("javascript_tool", { tabId, text: `document.getElementById('cckeys').value` });
  check('key "End Space" moves the caret and inserts a space (key table)', !k3.isError && k3s.text.includes("hello "), JSON.stringify(k3s.text));
  const k4 = await call("computer", { action: "key", text: "F13", tabId });
  check('key "F13" is an error (unknown key name) on the CDP path', k4.isError && /unknown key name/.test(k4.text), k4.text.slice(0, 80));
  // triple_click on a text control selects all of it.
  await call("javascript_tool", { tabId, text: `(()=>{const e=document.getElementById('cckeys');e.value='hello world';return 'ok'})()` });
  const tc = await call("computer", { action: "triple_click", ref: keysRef, tabId });
  const tcs = await call("javascript_tool", { tabId, text: `(()=>{const e=document.getElementById('cckeys');return e.selectionEnd-e.selectionStart})()` });
  check("triple_click selects an input's text", !tc.isError && tcs.text.trim() === "11", `${tc.text.slice(0, 40)} selected=${tcs.text.trim()}`);
  // type with nothing focused is an error, not a silent no-op.
  await call("javascript_tool", { tabId, text: `document.activeElement && document.activeElement.blur(); 'blurred'` });
  const tn = await call("computer", { action: "type", text: "zzz", tabId });
  check("type with no focused editable is an error", tn.isError && /focused editable/.test(tn.text), tn.text.slice(0, 80));
} else missing("key, triple_click and focused-type checks", "find returned no ref for the keys probe field");
// a cloned tagged element must get its OWN ref (duplicate-ref writes hit the wrong element).
await call("javascript_tool", { tabId, text: `(()=>{const b=document.createElement('button');b.id='ccorig';b.textContent='Clone Source';document.body.appendChild(b);return 'ok'})()` });
const forig = await call("find", { query: "Clone Source", tabId });
const origRef = forig.text.match(/\[(ref_\d+)\][^\n]*Clone Source/i)?.[1];
if (origRef) {
  await call("javascript_tool", { tabId, text: `(()=>{const b=document.getElementById('ccorig');const c=b.cloneNode(true);c.id='ccclone';c.textContent='Clone Copy';document.body.appendChild(c);return 'ok'})()` });
  const fclone = await call("find", { query: "Clone Copy", tabId });
  const cloneRef = fclone.text.match(/\[(ref_\d+)\][^\n]*Clone Copy/i)?.[1];
  check("a cloned tagged element gets its own ref", Boolean(cloneRef) && cloneRef !== origRef, `clone=${cloneRef} original=${origRef}`);
} else missing("a cloned tagged element gets its own ref", "find returned no ref for the clone source");
// controls under aria-hidden are not listed (a click would go through the overlay).
await call("javascript_tool", { tabId, text: `(()=>{const d=document.createElement('div');d.setAttribute('aria-hidden','true');d.innerHTML='<button aria-label="hidden decoy btn">Decoy</button>';document.body.appendChild(d);return 'ok'})()` });
const fdecoy = await call("find", { query: "hidden decoy btn", tabId });
let decoyMatches = "";
try {
  decoyMatches = JSON.parse(fdecoy.text).matches ?? "";
} catch {
  decoyMatches = fdecoy.text;
}
check("find omits a control under aria-hidden", !/decoy/i.test(decoyMatches), decoyMatches.slice(0, 80));
// get_page_text: two <article>s → neither is "the" content; both are returned.
await call("javascript_tool", { tabId, text: `(()=>{for(const t of ['ccart-one','ccart-two']){const a=document.createElement('article');a.id=t;a.textContent=t;document.body.appendChild(a)}return 'ok'})()` });
const gpt = await call("get_page_text", { tabId });
check("get_page_text with two <article>s returns both", gpt.text.includes("ccart-one") && gpt.text.includes("ccart-two"), gpt.text.slice(-160).replace(/\s+/g, " "));
await call("javascript_tool", { tabId, text: `document.getElementById('ccart-one').remove();document.getElementById('ccart-two').remove();'cleaned'` });
// wait_for networkIdle: a missing counter on an http(s) page is "not active", not idle.
await call("javascript_tool", { tabId, text: `delete window.__ccmcpInflight; 'deleted'` });
const wnNo = await call("wait_for", { tabId, networkIdle: true, timeoutMs: 3000 });
check("wait_for networkIdle reports capture-not-active instead of idle", wnNo.isError && /not active/.test(wnNo.text), wnNo.text.slice(0, 80));
await call("javascript_tool", { tabId, text: `window.__ccmcpInflight = 0; 'restored'` });
// … while a non-http document (the session's about:blank tab) counts as idle.
const tb = await call("tabs_create_mcp", {});
const tbId = tb.isError ? null : JSON.parse(tb.text).tabId;
if (tbId) {
  const wnBlank = await call("wait_for", { tabId: tbId, networkIdle: true, timeoutMs: 3000 });
  check("wait_for networkIdle on about:blank succeeds with a note", !wnBlank.isError && /no network capture/.test(wnBlank.text), wnBlank.text.slice(0, 80));
  await call("tabs_close_mcp", { tabId: tbId });
} else missing("wait_for networkIdle on about:blank", `tabs_create_mcp returned no tab: ${tb.text.slice(0, 80)}`);
// select_option (custom): a decoy visibility:hidden menu is never the scope;
// the option is activated with mousedown/click and the choice verified.
await call("javascript_tool", {
  tabId,
  text: `(()=>{const decoy=document.createElement('ul');decoy.setAttribute('role','menu');decoy.style.visibility='hidden';decoy.innerHTML='<li>Green</li>';document.body.appendChild(decoy);const box=document.createElement('div');box.setAttribute('role','combobox');box.setAttribute('aria-label','custom color picker');box.tabIndex=0;box.textContent='pick';const list=document.createElement('ul');list.setAttribute('role','listbox');list.style.display='none';for(const t of ['Red','Green']){const li=document.createElement('li');li.setAttribute('role','option');li.textContent=t;li.addEventListener('mousedown',()=>{window.__ccPicked=t;li.setAttribute('aria-selected','true');box.textContent=t;list.style.display='none'});list.appendChild(li)}box.addEventListener('click',()=>{list.style.display='block'});document.body.appendChild(box);document.body.appendChild(list);window.__ccPicked='';return 'ok'})()`,
});
const fcombo = await call("find", { query: "custom color picker", tabId });
const comboRef = fcombo.text.match(/\[(ref_\d+)\][^\n]*custom color/i)?.[1];
check("find custom combobox", Boolean(comboRef), comboRef ?? fcombo.text.slice(0, 60));
if (comboRef) {
  const so2 = await call("select_option", { ref: comboRef, value: "Green", tabId });
  const picked = await call("javascript_tool", { tabId, text: `window.__ccPicked` });
  check("select_option picks the combobox's own option (decoy ignored) and verifies", !so2.isError && /"verified":\s*true/.test(so2.text) && picked.text.includes("Green"), `${so2.text.slice(0, 80)} picked=${picked.text.trim()}`);
} else missing("custom combobox select_option", "find returned no ref for the custom combobox");
// javascript_tool: promises are awaited; non-serializable results are explained.
const pr = await call("javascript_tool", { tabId, text: `Promise.resolve(41+1)` });
check("javascript_tool awaits a promise result", pr.text.trim() === "42", pr.text);
const pnode = await call("javascript_tool", { tabId, text: `document.body` });
check("javascript_tool rejects a DOM node result with a clear error", pnode.isError && /DOM node/.test(pnode.text), pnode.text.slice(0, 80));
// screenshots are CSS-pixel sized: a coordinate read off the image is a click
// coordinate. CI's browser runs at DPR 1, where device and CSS pixels agree, so
// the same checks also run with an emulated device scale factor of 2.
const pngWidth = (b64) => Buffer.from(b64, "base64").readUInt32BE(16);
for (const emulatedScale of [undefined, 2]) {
  const scale = emulatedScale ? `emulated DPR ${emulatedScale}` : "the window's own DPR";
  const emulated = emulatedScale ? await call("emulate_device", { tabId, width: 640, height: 480, deviceScaleFactor: emulatedScale }) : null;
  try {
    const viewport = JSON.parse((await call("javascript_tool", { tabId, text: `JSON.stringify({width:document.documentElement.clientWidth,dpr:devicePixelRatio})` })).text || "{}");
    check(`screenshot scale fixture: ${scale} is in effect`, !emulated?.isError && (!emulatedScale || viewport.dpr === emulatedScale), `${emulated?.text.slice(0, 60) ?? ""} ${JSON.stringify(viewport)}`);
    const shotCss = await call("screenshot", { tabId, format: "png" });
    const shotCssImg = shotCss.content?.find((c) => c.type === "image");
    check(`screenshot viewport is CSS-pixel sized at ${scale} (PNG width = clientWidth)`, Boolean(shotCssImg) && pngWidth(shotCssImg.data) === viewport.width, `png=${shotCssImg ? pngWidth(shotCssImg.data) : "?"} clientWidth=${viewport.width} dpr=${viewport.dpr}`);
    // The batch reports which capture path ran; only the CDP capture is clipped
    // to CSS pixels, so a fallback capture cannot stand in for it.
    const bsrc = await call("browser_batch", { actions: [{ tool: "computer", args: { tabId, action: "screenshot" } }] });
    const csrc = bsrc.text.match(/"source":\s*"([^"]+)"/)?.[1];
    const shotCmp = await call("computer", { action: "screenshot", tabId });
    const cmpImg = shotCmp.content?.find((c) => c.type === "image");
    check(`computer screenshot comes from CDP and is CSS-pixel sized at ${scale}`, csrc === "cdp" && Boolean(cmpImg) && pngWidth(cmpImg.data) === viewport.width, `source=${csrc} png=${cmpImg ? pngWidth(cmpImg.data) : "?"} clientWidth=${viewport.width}`);
  } finally {
    if (emulatedScale) await call("emulate_device", { tabId, reset: true });
  }
}
// same-document navigation (fragment) resolves at once — no 25 s timeout note.
const sdT0 = Date.now();
const sdNav = await call("navigate", { url: `${fixtureUrl}#section`, tabId });
check("navigate same-document (#fragment) returns promptly without the timeout note", !sdNav.isError && Date.now() - sdT0 < 3000 && !/did not reach/.test(sdNav.text), `${Date.now() - sdT0}ms ${sdNav.text.slice(0, 60)}`);

// --- Phase 2b: shadow DOM piercing ---
await call("javascript_tool", {
  tabId,
  text: `(()=>{const host=document.createElement('div');host.id='cchost';const sr=host.attachShadow({mode:'open'});const b=document.createElement('button');b.textContent='Shadow Btn';b.setAttribute('aria-label','shadow action btn');b.onclick=()=>{window.__ccShadowClicked=true};sr.appendChild(b);document.body.appendChild(host);return 'ok'})()`,
});
const fsh = await call("find", { query: "shadow action btn", tabId });
const shRef = fsh.text.match(/\[(ref_\d+)\]/)?.[1];
check("find element inside shadow DOM", Boolean(shRef), shRef ?? fsh.text.slice(0, 80));
if (shRef) {
  const sc = await call("computer", { action: "left_click", ref: shRef, tabId });
  check("click shadow-DOM element", !sc.isError, sc.isError ? sc.text : sc.text.slice(0, 50));
  const se = await call("javascript_tool", { tabId, text: `window.__ccShadowClicked === true` });
  check("shadow-DOM click fired", se.text.trim() === "true", se.text);
} else missing("shadow-DOM click checks", "find returned no ref inside the shadow root");

// --- Phase 3: browser_batch ---
const batch = await call("browser_batch", {
  actions: [
    { tool: "javascript_tool", args: { tabId, text: `1+1` } },
    { tool: "read_page", args: { tabId, filter: "interactive" } },
  ],
});
const okCount = (batch.text.match(/"ok":\s*true/g) || []).length;
check("browser_batch ran both steps", !batch.isError && okCount >= 2, `${okCount} ok steps`);
// Binary envelope: a screenshot step returns metadata, never the base64 payload.
const batchShot = await call("browser_batch", {
  actions: [
    { tool: "navigate", args: { tabId, url: fixtureUrl } },
    { tool: "computer", args: { tabId, action: "screenshot" } },
  ],
});
check(
  "browser_batch screenshot step returns metadata, no base64",
  !batchShot.isError && batchShot.text.length < 4000 && /"bytes":\s*[1-9]/.test(batchShot.text) && !/"base64"/.test(batchShot.text),
  `${batchShot.text.length} chars`,
);
// pdf inside a batch is saved exactly like the direct tool (path under pdfs/).
const batchPdf = await call("browser_batch", { actions: [{ tool: "print_to_pdf", args: { tabId } }] });
check("browser_batch print_to_pdf step returns a saved path", !batchPdf.isError && /pdfs[\\/]doc-[^"]+\.pdf/.test(batchPdf.text), batchPdf.text.slice(0, 120));
// Every step is schema-validated like a direct call — a bad arg fails closed.
const batchBad = await call("browser_batch", {
  actions: [{ tool: "wait_for", args: { tabId, timeoutMs: "5000" } }, { tool: "javascript_tool", args: { tabId, text: "1" } }],
});
check("browser_batch validates step args (string timeoutMs rejected, batch stops)", /"ok":\s*false/.test(batchBad.text) && /timeoutMs/.test(batchBad.text) && !/"ok":\s*true/.test(batchBad.text), batchBad.text.slice(0, 120));
const batchTooLong = await call("browser_batch", {
  actions: Array.from({ length: 51 }, () => ({ tool: "javascript_tool", args: { tabId, text: "1" } })),
});
check("browser_batch rejects 51 steps", batchTooLong.isError, batchTooLong.text.slice(0, 80));

// --- Phase 3: upload_image (screenshot → temp file → file input) ---
await call("javascript_tool", {
  tabId,
  text: `(()=>{const i=document.createElement('input');i.type='file';i.id='ccimg';i.setAttribute('aria-label','image upload field');document.body.appendChild(i);return 'ok'})()`,
});
const fimg = await call("find", { query: "image upload field", tabId });
const imgRef = fimg.text.match(/\[(ref_\d+)\]/)?.[1];
check("find image input", Boolean(imgRef), imgRef ?? fimg.text.slice(0, 60));
if (imgRef) {
  const ui = await call("upload_image", { ref: imgRef, tabId });
  check("upload_image (screenshot)", !ui.isError, ui.isError ? ui.text : ui.text.slice(0, 50));
  const iname = await call("javascript_tool", {
    tabId,
    text: `(()=>{const f=document.getElementById('ccimg').files[0];return f?f.name:'(none)'})()`,
  });
  check("uploaded screenshot present", iname.text.includes(".png"), iname.text);
} else missing("upload_image checks", "find returned no ref for the image input");

// --- Phase 3: recipes (save → list → run with tabId injection) ---
const rsave = await call("recipe_save", {
  name: "ccmcp-test-recipe",
  actions: [{ tool: "javascript_tool", args: { text: `window.__ccRecipeRan=(window.__ccRecipeRan||0)+1` } }],
});
check("recipe_save", !rsave.isError, rsave.isError ? rsave.text : rsave.text.slice(0, 50));
const rlist = await call("recipe_list", {});
check("recipe_list shows it", rlist.text.includes("ccmcp-test-recipe"), rlist.text.slice(0, 60));
const rrun = await call("recipe_run", { name: "ccmcp-test-recipe", tabId });
check("recipe_run", !rrun.isError, rrun.isError ? rrun.text : rrun.text.slice(0, 50));
const rv = await call("javascript_tool", { tabId, text: `window.__ccRecipeRan >= 1` });
check("recipe_run executed step (tabId injected)", rv.text.trim() === "true", rv.text);
// A step saved with NO args at all must still get the default tabId.
await call("recipe_save", { name: "ccmcp-test-recipe-noargs", actions: [{ tool: "get_page_text" }] });
const rrun2 = await call("recipe_run", { name: "ccmcp-test-recipe-noargs", tabId });
check("recipe_run injects tabId into an arg-less step", !rrun2.isError && /"ok":\s*true/.test(rrun2.text) && /"text"/.test(rrun2.text), rrun2.text.slice(0, 80));

// --- Phase 2b: sub-frame / cross-origin iframe (allFrames + @frameId refs) ---
// Real HTTP sub-frame (same machinery as cross-origin; same-origin lets us
// inject a probe + read the result deterministically).
await call("javascript_tool", {
  tabId,
  text: `(()=>{if(!document.getElementById('ccifr')){const f=document.createElement('iframe');f.id='ccifr';f.src=${JSON.stringify(fixtureUrl)};document.body.appendChild(f);}return 'ok'})()`,
});
const frameReady = await call("wait_for", {
  tabId,
  // Wait for the iframe's HTTP document to FULLY load (readyState complete + its
  // <h1>), else a button injected into the transient about:blank gets wiped.
  predicate: `(()=>{try{const f=document.getElementById('ccifr');const d=f&&f.contentDocument;return !!(d&&d.readyState==='complete'&&d.querySelector('h1'))}catch(e){return false}})()`,
  timeoutMs: 10000,
});
if (!frameReady.isError) {
  await call("javascript_tool", {
    tabId,
    text: `(()=>{const d=document.getElementById('ccifr').contentDocument;const b=d.createElement('button');b.setAttribute('aria-label','iframe inner btn');b.onclick=()=>{parent.__ccFrameClicked=true};d.body.appendChild(b);return 'ok'})()`,
  });
  const ffr = await call("find", { query: "iframe inner btn", tabId });
  const frRef = ffr.text.match(/\[(ref_\d+@\d+)\]/)?.[1];
  check("find element inside sub-frame (allFrames @frameId)", Boolean(frRef), frRef ?? ffr.text.slice(0, 90));
  if (frRef) {
    const fc = await call("computer", { action: "left_click", ref: frRef, tabId });
    check("click sub-frame element", !fc.isError, fc.isError ? fc.text : fc.text.slice(0, 50));
    const fe = await call("javascript_tool", { tabId, text: `window.__ccFrameClicked === true` });
    check("sub-frame click fired", fe.text.trim() === "true", fe.text);
    // chord parsing + unknown-key rejection on the synthetic (sub-frame) path too.
    await call("javascript_tool", {
      tabId,
      text: `(()=>{const d=document.getElementById('ccifr').contentDocument;d.defaultView.__ccFrameKey='';d.addEventListener('keydown',e=>{d.defaultView.__ccFrameKey=(e.ctrlKey?'ctrl+':'')+e.key});return 'ok'})()`,
    });
    const fk = await call("computer", { action: "key", text: "ctrl+a", ref: frRef, tabId });
    const fkv = await call("javascript_tool", { tabId, text: `document.getElementById('ccifr').contentWindow.__ccFrameKey` });
    check('key chord "ctrl+a" parses on a sub-frame ref (synthetic path)', !fk.isError && fkv.text.includes("ctrl+a"), `${fk.text.slice(0, 40)} got=${fkv.text.trim()}`);
    const fk13 = await call("computer", { action: "key", text: "F13", ref: frRef, tabId });
    check('key "F13" is an error on the sub-frame path too', fk13.isError && /unknown key name/.test(fk13.text), fk13.text.slice(0, 80));
  } else missing("sub-frame click and key checks", "find returned no @frameId ref for the iframe button");
} else {
  missing("sub-frame checks", "the iframe did not become ready (framing blocked?)");
}

// --- Phase 3: gif_creator (record → encode → saved .gif) ---
await call("gif_creator", { action: "start_recording", tabId });
await call("computer", { action: "scroll", scroll_direction: "down", tabId });
await call("computer", { action: "wait", duration: 1, tabId });
await call("computer", { action: "scroll", scroll_direction: "up", tabId });
await call("gif_creator", { action: "stop_recording", tabId });
const gex = await call("gif_creator", { action: "export", tabId, maxWidth: 400 });
let gifOk = false;
let gifDetail = gex.isError ? gex.text : gex.text.slice(0, 80);
try {
  const gpath = JSON.parse(gex.text).path;
  if (gpath) {
    const buf = readFileSync(gpath);
    gifOk = buf.length > 0 && buf.subarray(0, 4).toString() === "GIF8";
    gifDetail = `${buf.length} bytes, header=${buf.subarray(0, 6).toString()}`;
  }
} catch {
  /* keep gifDetail */
}
check("gif_creator export (valid GIF file)", gifOk, gifDetail);

// --- New tools: health, dialog, print_to_pdf, cookies, screenshot, emulate_device,
//     tab_switch, file_drop, download ---
const hres = await call("health", {});
check("health reports connected", !hres.isError && /"bridgeConnected":\s*true/.test(hres.text), hres.text.slice(0, 80));

// Exercise the omitted behavior: the safe default must never accept a confirm.
await call("dialog", { action: "arm", tabId });
await call("javascript_tool", { tabId, text: `setTimeout(()=>{window.__ccConfirm=confirm('proceed?')},50); 'armed'` });
await call("computer", { action: "wait", duration: 1, tabId });
const stillResp = await call("javascript_tool", { tabId, text: `1+1` });
check("dialog: page responsive after confirm (auto-dismissed)", !stillResp.isError && stillResp.text.includes("2"), stillResp.text);
const dlg = await call("dialog", { action: "get", tabId });
check("dialog: captured the confirm", /proceed/.test(dlg.text), dlg.text.slice(0, 80));
const dismissed = await call("javascript_tool", { tabId, text: "window.__ccConfirm" });
check("dialog defaults to dismiss", !dismissed.isError && dismissed.text === "false");
await call("dialog", { action: "arm", tabId, behavior: "accept" });
await call("javascript_tool", { tabId, text: `setTimeout(()=>{window.__ccConfirm=confirm('accept fixture?')},50); 'armed'` });
await call("computer", { action: "wait", duration: 1, tabId });
const accepted = await call("javascript_tool", { tabId, text: "window.__ccConfirm" });
check("dialog accepts only when explicitly armed to accept", !accepted.isError && accepted.text === "true");
// Tabai hears about a dialog only while the Page domain is enabled, which only an
// arm does. An accept arm lives in the worker's memory alone: a worker restart
// loses it while the debugger and its Page domain stay. The next dialog then
// reaches a worker with no arm, which must dismiss it, never accept it.
let afterRestart = skip("needs the harness's CDP endpoint to restart the extension's worker");
let afterRestartDetail = "";
if (browserEndpoint) {
  const restarted = await restartExtensionWorker();
  await call("javascript_tool", { tabId, text: `window.__ccConfirm=null;setTimeout(()=>{window.__ccConfirm=confirm('after a worker restart?')},50); 'scheduled'` });
  await call("computer", { action: "wait", duration: 1, tabId });
  const answered = await call("javascript_tool", { tabId, text: "window.__ccConfirm" });
  afterRestart = restarted && !answered.isError && answered.text === "false";
  afterRestartDetail = `worker restarted=${restarted} confirm returned ${answered.text.slice(0, 60)}`;
}
check("dialog: an accept arm lost in a worker restart leaves the next dialog dismissed", afterRestart, afterRestartDetail);
await call("dialog", { action: "disarm", tabId });

// print_to_pdf
const pdf = await call("print_to_pdf", { tabId });
let pdfOk = false;
let pdfDetail = pdf.isError ? pdf.text : pdf.text.slice(0, 80);
try {
  const p = JSON.parse(pdf.text).path;
  if (p) {
    const b = readFileSync(p);
    pdfOk = b.subarray(0, 5).toString() === "%PDF-";
    pdfDetail = `${b.length} bytes`;
  }
} catch {
  /* keep detail */
}
check("print_to_pdf writes a %PDF file", pdfOk, pdfDetail);

// cookies get
await call("javascript_tool", { tabId, text: `document.cookie="ccmcptest=1"; 'set'` });
const cg = await call("cookies", { action: "get", tabId });
check("cookies get returns the cookie", !cg.isError && /ccmcptest/.test(cg.text), cg.text.slice(0, 80));

// screenshot region
const sr = await call("screenshot", { tabId, region: [0, 0, 120, 120] });
const srImg = sr.content?.find?.((c) => c.type === "image");
check("screenshot region returns an image", Boolean(srImg?.data?.length), srImg ? `${srImg.data.length} b64` : (sr.text || "").slice(0, 80));

// emulate_device + reset
const em = await call("emulate_device", { tabId, width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
check("emulate_device", !em.isError && /"ok":\s*true/.test(em.text), em.text.slice(0, 60));
const iw = await call("javascript_tool", { tabId, text: `innerWidth` });
check("emulate_device applied width", iw.text.trim() === "390", iw.text);
await call("emulate_device", { tabId, reset: true });

// tab_switch (open a 2nd tab, switch back, close it) + coordinate-click on a
// BACKGROUNDED tab. Real-Chrome bug (260607): CDP Input.dispatchMouseEvent is
// silently dropped when the source tab is document.hidden, so coordinate clicks
// must take the synthetic page path. Opening t2 backgrounds tabId → reproduces it
// (a naive coord test on a visible tab would pass even with the bug present).
const t2 = await call("tabs_create_mcp", {});
const t2id = t2.isError ? null : JSON.parse(t2.text).tabId;
if (t2id) {
  // tabId is now hidden (t2 is active). Inject a clean input, read its center.
  const ci = await call("javascript_tool", {
    tabId,
    text: `(()=>{let e=document.getElementById('cccoord');if(!e){e=document.createElement('input');e.id='cccoord';e.style.cssText='position:fixed;top:120px;left:30px;width:280px;height:34px;z-index:99999';document.body.appendChild(e);}e.value='';if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();const r=e.getBoundingClientRect();return JSON.stringify({hidden:document.hidden,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`,
  });
  let coord = null;
  try { coord = JSON.parse(ci.text); } catch {}
  if (coord) {
    await call("computer", { action: "left_click", coordinate: [coord.x, coord.y], tabId });
    await call("computer", { action: "type", text: "Xco", tabId });
    const rbc = await call("javascript_tool", { tabId, text: `document.getElementById('cccoord').value` });
    // In a real browser tabId is now document.hidden (genuine regression case);
    // headless Chromium keeps it visible, so the label notes which condition ran.
    const label = coord.hidden
      ? "coordinate-click + type lands on a BACKGROUNDED tab (document.hidden)"
      : "coordinate-click + type lands (tab visible; headless can't background)";
    check(label, rbc.text.includes("Xco"), rbc.text);
  } else missing("coordinate-click + type", `the coordinate fixture was unreadable: ${ci.text.slice(0, 80)}`);
  const sw = await call("tab_switch", { tabId });
  check("tab_switch activates", !sw.isError && /"active":\s*true/.test(sw.text), sw.text.slice(0, 80));
  await call("tabs_close_mcp", { tabId: t2id });
} else missing("background-tab coordinate click and tab_switch", `tabs_create_mcp returned no tab: ${t2.text.slice(0, 80)}`);

// file_drop: inject a dropzone, drop a local file, assert it received a File
await call("javascript_tool", {
  tabId,
  text: `(()=>{const d=document.createElement('div');d.setAttribute('aria-label','drop zone here');d.style.cssText='width:240px;height:240px;background:#eee';window.__ccDropped='';d.addEventListener('dragover',e=>e.preventDefault());d.addEventListener('drop',e=>{e.preventDefault();window.__ccDropped=(e.dataTransfer.files[0]||{}).name||''});document.body.appendChild(d);return 'ok'})()`,
});
const fdz = await call("find", { query: "drop zone here", tabId });
const dropRef = fdz.text.match(/\[(ref_\d+)\]/)?.[1];
check("find dropzone", Boolean(dropRef), dropRef ?? fdz.text.slice(0, 60));
if (dropRef) {
  const fdr = await call("file_drop", { ref: dropRef, path: join(root, "package.json"), tabId });
  check("file_drop", !fdr.isError, fdr.isError ? fdr.text : fdr.text.slice(0, 60));
  const dn = await call("javascript_tool", { tabId, text: `window.__ccDropped` });
  check("file_drop delivered the file", dn.text.includes("package.json"), dn.text);
} else missing("file_drop checks", "find returned no ref for the drop zone");

// download: arm, trigger a blob download, collect
await call("download", { action: "arm", tabId });
await call("javascript_tool", {
  tabId,
  text: `(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['hi'],{type:'text/plain'}));a.download='ccmcp-dl.txt';document.body.appendChild(a);a.click();return 'clicked'})()`,
});
const dl = await call("download", { action: "collect", tabId, timeoutMs: 8000 });
let dlOk = false;
let dlDetail = dl.isError ? dl.text : dl.text.slice(0, 80);
try {
  const j = JSON.parse(dl.text);
  dlOk = j.state === "completed" && !!j.path && readFileSync(j.path, "utf8") === "hi";
  if (dlOk && process.env.CCMCP_TEST_DOWNLOAD_DIR) {
    const rel = relative(process.env.CCMCP_TEST_DOWNLOAD_DIR, j.path);
    dlOk = !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  }
  dlDetail = dlOk ? j.path : JSON.stringify(j);
  if (dlOk) rmSync(j.path);
} catch {
  /* keep detail */
}
check("download captured a file", dlOk, dlDetail);

// javascript_tool world:'isolated': the same DOM, none of the page's own JavaScript.
{
  const isoNav = await call("navigate", { url: fixtureUrl, tabId });
  check("navigate before the isolated-world checks", !isoNav.isError, isoNav.isError ? isoNav.text : "");
  await call("javascript_tool", {
    tabId,
    text: `(()=>{window.__ccIsolation='page';window.__ccOwnInnerText=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText');Object.defineProperty(HTMLElement.prototype,'innerText',{configurable:true,get(){return this.id==='cciso'?'patched':window.__ccOwnInnerText.get.call(this)}});const b=document.createElement('button');b.id='cciso';b.textContent='real text';document.body.appendChild(b);return 'set'})()`,
  });
  const mainView = await call("javascript_tool", { tabId, text: `[typeof window.__ccIsolation, document.getElementById('cciso').innerText]` });
  check("javascript_tool main world sees the page's own JavaScript", !mainView.isError && mainView.text.includes('"string"') && mainView.text.includes("patched"), mainView.text);
  const isoView = await call("javascript_tool", { tabId, world: "isolated", text: `[typeof window.__ccIsolation, document.getElementById('cciso').innerText]` });
  check("javascript_tool world:'isolated' shares the DOM but not the page's JavaScript", !isoView.isError && isoView.text.includes('"undefined"') && isoView.text.includes("real text") && !isoView.text.includes("patched"), isoView.text);
  const isoPromise = await call("javascript_tool", { tabId, world: "isolated", text: `new Promise(resolve => setTimeout(() => resolve(document.title), 10))` });
  check("javascript_tool world:'isolated' awaits a promise", !isoPromise.isError && isoPromise.text.includes("Tabai test page"), isoPromise.text);
  const isoGate = await call("javascript_tool", { tabId: bogusTab, world: "isolated", text: "1" });
  check("javascript_tool world:'isolated' keeps the tab-group gate", isoGate.isError && /tab group|not found/i.test(isoGate.text), isoGate.text.slice(0, 80));
  const isoBad = await call("javascript_tool", { tabId, world: "other", text: "1" });
  check("javascript_tool rejects an unknown world", isoBad.isError, isoBad.text.slice(0, 80));
  await call("javascript_tool", { tabId, text: `(()=>{Object.defineProperty(HTMLElement.prototype,'innerText',window.__ccOwnInnerText);document.getElementById('cciso')?.remove();delete window.__ccIsolation;delete window.__ccOwnInnerText;return 'cleaned'})()` });
}

// --- Page actions report what they did: coordinate targets, scrolling, reads and form predicates ---
{
  const openFixture = async (path, label) => {
    const opened = await call("navigate", { url: new URL(path, fixtureUrl).href, tabId });
    check(`navigate ${label}`, !opened.isError, opened.isError ? opened.text : "");
  };
  const pageJson = async (text) => {
    const result = await call("javascript_tool", { tabId, text });
    try { return JSON.parse(result.text); } catch { return { unreadable: result.text.slice(0, 160) }; }
  };
  const pageNumber = async (text) => Number((await call("javascript_tool", { tabId, text })).text);
  const resultField = (result, key) => {
    try { return String(JSON.parse(result.text)[key] ?? ""); } catch { return result.text; }
  };
  const flat = (text) => text.replace(/\s+/g, " ").slice(0, 200);

  // Coordinates read from one screenshot stay valid for the whole batch.
  await openFixture("/rows", "row list fixture");
  const rowPlan = await pageJson(`(()=>{const at=f=>{const y=Math.round(innerHeight*f);return {id:document.elementFromPoint(40,y)?.id??null,x:40,y}};return JSON.stringify({first:at(0.6),second:at(0.85),scrollY,scrollable:document.documentElement.scrollHeight>innerHeight*2})})()`);
  const rowsPlanned = /^row-\d+$/.test(rowPlan.first?.id ?? "") && /^row-\d+$/.test(rowPlan.second?.id ?? "") &&
    rowPlan.first.id !== rowPlan.second.id && rowPlan.scrollable === true;
  check("row fixture: two different rows under their points on a scrollable page", rowsPlanned, JSON.stringify(rowPlan));
  const rowBatch = await call("browser_batch", {
    actions: [rowPlan.first, rowPlan.second].map(point => ({ tool: "computer", args: { tabId, action: "left_click", coordinate: [point?.x ?? 0, point?.y ?? 0] } })),
  });
  const rowsHit = await pageJson(`JSON.stringify({rows:window.__ccRows,scrollY})`);
  check(
    "two coordinate clicks in one batch hit the intended rows and leave the page where it was",
    rowsPlanned && !rowBatch.isError && JSON.stringify(rowsHit.rows) === JSON.stringify([rowPlan.first.id, rowPlan.second.id]) && rowsHit.scrollY === rowPlan.scrollY,
    `${JSON.stringify(rowsHit)} expected ${rowPlan.first?.id},${rowPlan.second?.id} at scrollY ${rowPlan.scrollY}`,
  );

  // A focusable control across the viewport's bottom edge: focusing it must not
  // scroll the page, or the next coordinate read off the same view misses.
  await openFixture("/rows", "row list fixture with controls across the viewport's edge");
  const edgePlan = await pageJson(`(()=>{window.__ccEdge=[];const place=(tag,left)=>{const el=document.createElement(tag);el.style.cssText='position:absolute;left:'+left+'px;top:'+(innerHeight-12)+'px;width:120px;height:48px;z-index:5';if(tag==='button')el.textContent='Edge button';else el.value='edge text';el.addEventListener('click',()=>window.__ccEdge.push(tag));document.body.appendChild(el);const r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+5);return {x,y,crosses:r.top<innerHeight&&r.bottom>innerHeight,hit:document.elementFromPoint(x,y)===el}};const row=f=>{const y=Math.round(innerHeight*f);return {x:40,y,id:document.elementFromPoint(40,y)?.id??null}};return JSON.stringify({button:place('button',200),input:place('input',360),first:row(0.5),second:row(0.6),scrollY})})()`);
  const edgeReady = Boolean(edgePlan.button?.crosses && edgePlan.button?.hit && edgePlan.input?.crosses && edgePlan.input?.hit &&
    /^row-\d+$/.test(edgePlan.first?.id ?? "") && /^row-\d+$/.test(edgePlan.second?.id ?? "") && edgePlan.first.id !== edgePlan.second.id);
  check("edge fixture: a button and a field cross the viewport's bottom edge above two rows", edgeReady, JSON.stringify(edgePlan));
  const point = target => [target?.x ?? 0, target?.y ?? 0];
  const edgeClicks = await call("browser_batch", { actions: [edgePlan.button, edgePlan.first].map(target => ({ tool: "computer", args: { tabId, action: "left_click", coordinate: point(target) } })) });
  const afterEdgeClick = await pageJson(`JSON.stringify({edge:window.__ccEdge,rows:window.__ccRows,scrollY})`);
  check("a coordinate click on a button across the viewport's edge leaves the page where it was, so the next coordinate hits",
    edgeReady && !edgeClicks.isError && afterEdgeClick.edge?.includes("button") && JSON.stringify(afterEdgeClick.rows) === JSON.stringify([edgePlan.first.id]) && afterEdgeClick.scrollY === edgePlan.scrollY,
    `${JSON.stringify(afterEdgeClick)} expected ${edgePlan.first?.id} at scrollY ${edgePlan.scrollY}`);
  const edgeSelect = await call("browser_batch", { actions: [
    { tool: "computer", args: { tabId, action: "triple_click", coordinate: point(edgePlan.input) } },
    { tool: "computer", args: { tabId, action: "left_click", coordinate: point(edgePlan.second) } },
  ] });
  const afterEdgeSelect = await pageJson(`JSON.stringify({edge:window.__ccEdge,rows:window.__ccRows,scrollY,focused:document.activeElement?.tagName})`);
  check("a coordinate triple click on a field across the viewport's edge focuses it without moving the page",
    edgeReady && !edgeSelect.isError && afterEdgeSelect.edge?.includes("input") && afterEdgeSelect.focused === "INPUT" &&
      JSON.stringify(afterEdgeSelect.rows) === JSON.stringify([edgePlan.first.id, edgePlan.second.id]) && afterEdgeSelect.scrollY === edgePlan.scrollY,
    `${JSON.stringify(afterEdgeSelect)} expected ${edgePlan.first?.id},${edgePlan.second?.id} at scrollY ${edgePlan.scrollY}`);

  await openFixture("/pointer-targets", "pointer target fixture");
  const points = await pageJson(`(()=>{const centre=r=>[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];const button=centre(document.getElementById('host').shadowRoot.getElementById('inner').getBoundingClientRect());const frame=centre(document.getElementById('frame').getBoundingClientRect());return JSON.stringify({button,frame,buttonHit:document.elementFromPoint(...button)?.id,frameHit:document.elementFromPoint(...frame)?.tagName})})()`);
  const pointsReady = points.buttonHit === "host" && points.frameHit === "IFRAME";
  check("pointer fixture: the shadow host and the frame are under their points", pointsReady, JSON.stringify(points));
  const shadowClick = await call("computer", { tabId, action: "left_click", coordinate: points.button ?? [0, 0] });
  const shadowHits = (await call("javascript_tool", { tabId, text: "window.__ccShadowHits" })).text.trim();
  check("a coordinate click over an open shadow root reaches the inner button",
    pointsReady && !shadowClick.isError && /clicked button/.test(shadowClick.text) && shadowHits === "1", `${flat(shadowClick.text)} hits=${shadowHits}`);
  const frameClick = await call("computer", { tabId, action: "left_click", coordinate: points.frame ?? [0, 0] });
  check("a coordinate click over a frame is refused and names the frame-ref and browser-pointer routes",
    pointsReady && frameClick.isError && /frame/i.test(frameClick.text) && /ref_N@frameId/.test(frameClick.text) && /pointerMode/.test(frameClick.text), flat(frameClick.text));
  const frameScroll = await call("computer", { tabId, action: "scroll", coordinate: points.frame ?? [0, 0], scroll_direction: "down" });
  check("a scroll at a point over a frame is not an error and reports whether anything moved",
    pointsReady && !frameScroll.isError && /"moved":\s*(true|false)/.test(frameScroll.text), flat(frameScroll.text));

  await openFixture("/inner-scroll", "inner scroll fixture");
  const pane = await pageJson(`(()=>{const r=document.getElementById('item').getBoundingClientRect();const x=Math.round(r.x+5),y=Math.round(r.y+r.height/2);return JSON.stringify({x,y,hit:document.elementFromPoint(x,y)?.id,label:document.elementFromPoint(80,20)?.id})})()`);
  const paneReady = pane.hit === "item" && pane.label === "static";
  check("inner scroll fixture: the pane item and the static label are under their points", paneReady, JSON.stringify(pane));
  const paneTop = () => pageNumber("document.getElementById('pane').scrollTop");
  const pointScroll = await call("computer", { tabId, action: "scroll", coordinate: [pane.x ?? 0, pane.y ?? 0], scroll_direction: "down" });
  const afterPoint = await paneTop();
  check("scroll at a point inside an inner container scrolls that container and reports moved:true",
    paneReady && !pointScroll.isError && /"moved":\s*true/.test(pointScroll.text) && afterPoint > 0, `${flat(pointScroll.text)} scrollTop=${afterPoint}`);
  const centreScroll = await call("computer", { tabId, action: "scroll", scroll_direction: "down" });
  const afterCentre = await paneTop();
  check("scroll without a target scrolls the container under the viewport centre",
    paneReady && !centreScroll.isError && /"moved":\s*true/.test(centreScroll.text) && afterCentre > afterPoint, `${flat(centreScroll.text)} scrollTop=${afterCentre}`);
  const stillScroll = await call("computer", { tabId, action: "scroll", coordinate: [80, 20], scroll_direction: "down" });
  const afterStill = await paneTop();
  check("scroll at a point with nothing scrollable stays ok and reports moved:false with a reason",
    paneReady && !stillScroll.isError && /"moved":\s*false/.test(stillScroll.text) && /"reason":\s*"[^"]+"/.test(stillScroll.text) && afterStill === afterCentre,
    `${flat(stillScroll.text)} scrollTop=${afterStill}`);

  await openFixture("/smooth", "smooth scrolling fixture");
  const smooth = await call("computer", { tabId, action: "scroll", scroll_direction: "down" });
  const smoothY = await pageNumber("scrollY");
  check("a real scroll on a smooth-scrolling page reports moved:true", !smooth.isError && /"moved":\s*true/.test(smooth.text) && smoothY > 0, `${flat(smooth.text)} scrollY=${smoothY}`);
  const bottomY = await pageNumber("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}); scrollY");
  const atEnd = await call("computer", { tabId, action: "scroll", scroll_direction: "down" });
  const endY = await pageNumber("scrollY");
  check("scroll past the end of the page stays ok and reports moved:false with a reason",
    bottomY > 0 && !atEnd.isError && /"moved":\s*false/.test(atEnd.text) && /"reason":\s*"[^"]*end/.test(atEnd.text) && endY === bottomY, `${flat(atEnd.text)} scrollY=${endY}/${bottomY}`);

  // A container already at its end hands the scroll on, ending at the page, as a wheel does.
  await openFixture("/fixed-block", "fixed block fixture");
  const block = await pageJson(`(()=>{const b=document.getElementById('block');b.scrollTop=b.scrollHeight;return JSON.stringify({atEnd:b.scrollTop>0&&Math.ceil(b.scrollTop+b.clientHeight)>=b.scrollHeight,centre:document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('#block')?.id??null,top:b.scrollTop,scrollY})})()`);
  const blockReady = block.atEnd === true && block.centre === "block" && block.scrollY === 0;
  check("fixed block fixture: a short scrollable block at its end lies under the viewport centre", blockReady, JSON.stringify(block));
  const handOn = await call("computer", { tabId, action: "scroll", scroll_direction: "down" });
  const handOnState = await pageJson(`JSON.stringify({scrollY,top:document.getElementById('block').scrollTop})`);
  check("a scroll without a target passes a container at its end on to the page and reports moved:true",
    blockReady && !handOn.isError && /"moved":\s*true/.test(handOn.text) && handOnState.scrollY > 0 && handOnState.top === block.top, `${flat(handOn.text)} ${JSON.stringify(handOnState)}`);
  // A ref names what to scroll: its own container at its end is the answer, and the page behind it stays.
  const blockFound = await call("find", { tabId, query: "Block button" });
  const blockRef = blockFound.text.match(/\[(ref_\d+)\][^\n]*Block button/i)?.[1];
  const byRef = await call("computer", { tabId, action: "scroll", scroll_direction: "down", ref: blockRef });
  const byRefState = await pageJson(`JSON.stringify({scrollY,top:document.getElementById('block').scrollTop})`);
  check("a scroll with a ref stays in that ref's container: at its end it reports moved:false and the page behind it does not move",
    blockReady && !!blockRef && !byRef.isError && /"moved":\s*false/.test(byRef.text) && /"reason":\s*"div#block is already at its end/.test(byRef.text)
      && byRefState.scrollY === handOnState.scrollY && byRefState.top === block.top, `${blockRef} ${flat(byRef.text)} ${JSON.stringify(byRefState)} before ${JSON.stringify(handOnState)}`);
  const pageEndY = await pageNumber("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}); scrollY");
  const bothEnd = await call("computer", { tabId, action: "scroll", scroll_direction: "down" });
  const bothEndState = await pageJson(`JSON.stringify({scrollY,top:document.getElementById('block').scrollTop})`);
  check("with that container and the page both at their end, the scroll stays ok and reports moved:false with a reason",
    blockReady && pageEndY > 0 && !bothEnd.isError && /"moved":\s*false/.test(bothEnd.text) && /"reason":\s*"[^"]*end/.test(bothEnd.text) && bothEndState.scrollY === pageEndY && bothEndState.top === block.top,
    `${flat(bothEnd.text)} ${JSON.stringify(bothEndState)} page end ${pageEndY}`);

  await openFixture("/example?case=reads", "fresh page for read and form checks");
  await call("javascript_tool", {
    tabId,
    text: `(()=>{const d=document.createElement('div');d.innerHTML='<input aria-label="prefixed card field" autocomplete="billing cc-number" value="4111-leak-card"><input aria-label="prefixed code field" autocomplete="section-login one-time-code" value="9876-leak-code"><textarea aria-label="code text area" autocomplete="one-time-code">5555-leak-area</textarea>';document.body.appendChild(d);let n=document.body;for(let i=0;i<70;i++){const w=document.createElement('div');n.appendChild(w);n=w;}const b=document.createElement('button');b.textContent='Deep nested target';n.appendChild(b);return 'ok'})()`,
  });
  const listing = resultField(await call("read_page", { tabId, filter: "interactive" }), "elements");
  const secretMatches = resultField(await call("find", { tabId, query: "prefixed card code text area" }), "matches");
  for (const [tool, output] of [["read_page", listing], ["find", secretMatches]]) {
    const listed = ["prefixed card field", "prefixed code field", "code text area"].every(name => output.includes(`"${name}"`));
    check(`${tool} masks fields with prefixed autocomplete tokens and a secret textarea`,
      listed && !/-leak-/.test(output) && (output.match(/•••/g) ?? []).length >= 3,
      output.split("\n").filter(line => /prefixed|code text/.test(line)).map(line => line.trim()).join(" | ").slice(0, 300));
  }
  const deepMatches = resultField(await call("find", { tabId, query: "Deep nested target" }), "matches");
  check("read_page lists a control nested 70 levels deep",
    /\[ref_\d+\] button "Deep nested target"/.test(listing) && !/walk aborted/.test(listing), flat(listing.slice(-200)));
  check("find returns a ref for a control nested 70 levels deep", /\[ref_\d+\] button "Deep nested target"/.test(deepMatches), flat(deepMatches));

  // A label never names a field after the text of a textarea inside it: that text is a value.
  await call("javascript_tool", {
    tabId,
    text: `(()=>{const d=document.createElement('div');d.innerHTML='<label>Wrapped recovery codes <textarea autocomplete="one-time-code">7311-nameleak-a</textarea></label><label for="ccforcodes">For-labelled backup codes <textarea id="ccforcodes" autocomplete="one-time-code">7312-nameleak-b</textarea></label><div id="cccodeslabel">Labelled-by recovery codes <textarea autocomplete="one-time-code" aria-label="inner codes area">7313-nameleak-c</textarea></div><input aria-labelledby="cccodeslabel">';document.body.appendChild(d);return 'ok'})()`,
  });
  const labelListing = resultField(await call("read_page", { tabId, filter: "interactive" }), "elements");
  const labelMatches = resultField(await call("find", { tabId, query: "wrapped labelled backup recovery codes" }), "matches");
  for (const [tool, output] of [["read_page", labelListing], ["find", labelMatches]]) {
    const named = ["Wrapped recovery codes", "For-labelled backup codes", "Labelled-by recovery codes"].every(name => output.includes(`"${name}"`));
    check(`${tool} never names a field after the text of a textarea inside its label`, named && !/nameleak/.test(output),
      output.split("\n").filter(line => /codes/.test(line)).map(line => line.trim()).join(" | ").slice(0, 300));
  }

  await call("javascript_tool", {
    tabId,
    text: `(()=>{const f=document.createElement('fieldset');f.disabled=true;f.innerHTML='<legend><input aria-label="legend allowed field"></legend><input aria-label="fieldset locked field">';document.body.appendChild(f);return 'ok'})()`,
  });
  const fieldsetMatches = resultField(await call("find", { tabId, query: "legend allowed fieldset locked" }), "matches");
  const lockedRef = fieldsetMatches.match(/\[(ref_\d+)\][^\n]*fieldset locked field/)?.[1];
  const legendRef = fieldsetMatches.match(/\[(ref_\d+)\][^\n]*legend allowed field/)?.[1];
  check("find the fields of a disabled fieldset", Boolean(lockedRef && legendRef), flat(fieldsetMatches));
  const lockedFill = await call("fill_form", { tabId, fields: [{ ref: lockedRef ?? "ref_0", value: "must-not-write" }] });
  check("fill_form refuses a control inside <fieldset disabled>", Boolean(lockedRef) && lockedFill.isError && /disabled/.test(lockedFill.text), flat(lockedFill.text));
  const lockedInput = await call("form_input", { tabId, ref: lockedRef ?? "ref_0", value: "must-not-write" });
  check("form_input waits for and refuses a control inside <fieldset disabled>", Boolean(lockedRef) && lockedInput.isError && /disabled/.test(lockedInput.text), flat(lockedInput.text));
  const legendInput = await call("form_input", { tabId, ref: legendRef ?? "ref_0", value: "legend ok" });
  const fieldsetValues = await pageJson(`JSON.stringify({legend:document.querySelector('fieldset legend input').value,locked:document.querySelector('fieldset > input').value})`);
  check("a control in the fieldset's first legend stays enabled and the locked one is unchanged",
    Boolean(legendRef) && !legendInput.isError && fieldsetValues.legend === "legend ok" && fieldsetValues.locked === "", `${flat(legendInput.text)} ${JSON.stringify(fieldsetValues)}`);

  await call("javascript_tool", {
    tabId,
    text: `(()=>{const s=document.createElement('select');s.id='ccshade';s.setAttribute('aria-label','shade picker sel');for(const [v,t] of [['r','Red'],['dg','Dark green'],['lg','Light green']]){const o=document.createElement('option');o.value=v;o.textContent=t;s.appendChild(o)}document.body.appendChild(s);const box=document.createElement('div');box.setAttribute('role','combobox');box.setAttribute('aria-label','inner list picker');box.tabIndex=0;box.innerHTML='<span>Choose</span><ul role="listbox"><li role="option">Alpha</li><li role="option">Beta</li></ul>';document.body.appendChild(box);return 'ok'})()`,
  });
  const pickerMatches = resultField(await call("find", { tabId, query: "shade picker sel inner list picker" }), "matches");
  const shadeRef = pickerMatches.match(/\[(ref_\d+)\][^\n]*shade picker sel/)?.[1];
  const innerRef = pickerMatches.match(/\[(ref_\d+)\][^\n]*inner list picker/)?.[1];
  check("find the select_option fixtures", Boolean(shadeRef && innerRef), flat(pickerMatches));
  const shadeValue = async () => (await call("javascript_tool", { tabId, text: "document.getElementById('ccshade').value" })).text.trim();
  const ambiguous = await call("select_option", { tabId, ref: shadeRef ?? "ref_0", value: "green" });
  const afterAmbiguous = await shadeValue();
  check("select_option refuses a substring that matches several options and lists them",
    Boolean(shadeRef) && ambiguous.isError && /Dark green/.test(ambiguous.text) && /Light green/.test(ambiguous.text) && afterAmbiguous === "r", `${flat(ambiguous.text)} value=${afterAmbiguous}`);
  const exactText = await call("select_option", { tabId, ref: shadeRef ?? "ref_0", value: "Light green" });
  const afterExact = await shadeValue();
  check("select_option prefers the exact text over a substring", Boolean(shadeRef) && !exactText.isError && afterExact === "lg", `${flat(exactText.text)} value=${afterExact}`);
  const innerPick = await call("select_option", { tabId, ref: innerRef ?? "ref_0", value: "Beta" });
  check("select_option does not verify a custom option from the control's own text",
    Boolean(innerRef) && !innerPick.isError && /"verified":\s*false/.test(innerPick.text), flat(innerPick.text));

  // A different site runs in its own renderer process, out of the tab debugger's reach.
  await call("javascript_tool", {
    tabId,
    text: `(()=>{window.__ccCross={ready:false,file:''};addEventListener('message',e=>{const d=e.data||{};if(d.ccCrossReady)window.__ccCross.ready=true;if(typeof d.ccCrossFile==='string')window.__ccCross.file=d.ccCrossFile});const f=document.createElement('iframe');f.src=${JSON.stringify(crossSiteFrameUrl)};f.style.cssText='width:320px;height:120px';document.body.appendChild(f);return 'ok'})()`,
  });
  const crossReady = await call("wait_for", { tabId, predicate: "window.__ccCross && window.__ccCross.ready === true", timeoutMs: 10000 });
  check("cross-site frame fixture loaded", !crossReady.isError, flat(crossReady.text));
  const crossMatches = resultField(await call("find", { tabId, query: "cross site upload" }), "matches");
  const crossRef = crossMatches.match(/\[(ref_\d+@\d+)\][^\n]*cross site upload/)?.[1];
  check("find the file input inside the cross-site frame", Boolean(crossRef), flat(crossMatches));
  const crossUpload = await call("file_upload", { tabId, ref: crossRef ?? "ref_0@1", paths: [join(root, "package.json")] });
  console.log(`    file_upload into a cross-site frame ${crossUpload.isError ? "was refused" : "succeeded"}: ${flat(crossUpload.text)}`);
  // Whether Chrome keeps the frame in its own process decides which outcome is
  // correct, so both outcomes are one check site.
  let crossOutcome;
  if (crossRef && !crossUpload.isError) {
    const crossFile = await call("wait_for", { tabId, predicate: "window.__ccCross.file === 'package.json'", timeoutMs: 5000 });
    crossOutcome = ["file_upload into a cross-site frame sets the file", !crossFile.isError, flat(crossFile.text)];
  } else {
    crossOutcome = ["file_upload into a cross-site frame names the frame instead of a stale ref",
      Boolean(crossRef) && /cross-site/i.test(crossUpload.text) && !/stale|read the page again/i.test(crossUpload.text), flat(crossUpload.text)];
  }
  check(...crossOutcome);
}

// A never-settling page promise errors after the in-page 25 s cap — a message,
// not a bridge TIMEOUT (the one slow check in the suite).
const pnever = await call("javascript_tool", { tabId, text: `new Promise(()=>{})` });
check("javascript_tool: a never-settling promise errors after 25s (not a bridge timeout)", pnever.isError && /25s/.test(pnever.text), pnever.text.slice(0, 80));

// Lost ownership: a tab moved out of every session's group is the user's again.
// Tabai releases it (Page domain off, emulation cleared, debugger detached), so
// its later dialogs are outside Tabai: this checks the release, and opens none.
// Kept last: the session's tab leaves its group here.
let released = skip("needs the harness's CDP endpoint to move the tab out of its group");
let releasedDetail = "";
if (browserEndpoint) {
  const releaseUrl = `${fixtureUrl}?case=release`;
  const releaseNav = await call("navigate", { url: releaseUrl, tabId });
  const releaseArm = await call("dialog", { action: "arm", tabId, behavior: "accept" });
  released = await withBrowser(async observer => {
    const pageTarget = async () => (await observer.rpc("Target.getTargets")).targetInfos.find(target => target.type === "page" && target.url === releaseUrl);
    const before = await pageTarget();
    const worker = extensionWorker((await observer.rpc("Target.getTargets")).targetInfos);
    if (releaseNav.isError || releaseArm.isError || !before?.attached || !worker) {
      releasedDetail = `navigate=${releaseNav.text.slice(0, 40)} arm=${releaseArm.text.slice(0, 40)} attached before=${before?.attached} worker=${Boolean(worker)}`;
      return false;
    }
    // Ungroup inside the extension's own worker, as a user dragging the tab out would.
    const { sessionId } = await observer.rpc("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    const ungrouped = await observer.rpc("Runtime.evaluate", { expression: `chrome.tabs.ungroup(${tabId}).then(() => true)`, awaitPromise: true, returnByValue: true }, sessionId);
    await observer.rpc("Target.detachFromTarget", { sessionId }).catch(() => {});
    let after = before;
    for (const until = Date.now() + 10_000; after?.attached && Date.now() < until; await sleep(100)) after = await pageTarget();
    const gate = await call("dialog", { action: "get", tabId });
    releasedDetail = `ungrouped=${ungrouped.result?.value ?? ungrouped.exceptionDetails?.text} debugger attached after=${after?.attached} dialog get: ${gate.text.slice(0, 70)}`;
    await observer.rpc("Target.closeTarget", { targetId: before.targetId }).catch(() => {});
    return ungrouped.result?.value === true && after?.attached === false && gate.isError && /^TAB_NOT_IN_GROUP:/.test(gate.text);
  });
}
check("dialog: a tab moved out of every group is released (debugger detached, its arm unusable)", released, releasedDetail);

const notRun = [...checkSites].filter(([line]) => !ranSites.has(line));
for (const [line, text] of notRun) console.log(`  ✗ check site never ran — e2e-live.mjs:${line}: ${text.slice(0, 100)}`);
console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped; ${checkSites.size - notRun.length} of ${checkSites.size} check sites ran ===`);
await client.close();
for (const server of [fixture, fixtureV6]) {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
process.exit(fail === 0 && notRun.length === 0 ? 0 : 1);
