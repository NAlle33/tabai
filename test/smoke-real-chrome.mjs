import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
// Real-Chrome smoke driver — for the things the CI harness CAN'T verify
// (your actual scaled display → DPR-sensitive coordinate clicks).
//
// Unlike ci-harness.mjs, this does NOT launch its own browser. It spawns the
// server on the DEFAULT port (9223) and waits for the extension loaded in YOUR
// everyday Chrome to connect — so clicks run on your real display/DPI.
//
// Prereq (see docs/smoke-runbook.md):
//   1. npm run build
//   2. Load/reload the extension to the current version in your main Chrome
//      (popup → "Reload extension", or remove + Load unpacked from extension/).
//   3. Nothing else listening on 9223 (don't run `npm start` at the same time).
//   4. node test/smoke-real-chrome.mjs   (a window opens in YOUR Chrome)


import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = JSON.parse(
  readFileSync(join(root, "extension", "manifest.json"), "utf8"),
).version;

const transport = createMcpTransport({
  command: process.execPath,
  args: [join(root, "dist", "server.js")], // default port 9223
  cwd: root,
  ...(process.argv.includes("--require-scaled-display") ? {
    env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("CCMCP_") && typeof value === "string")),
  } : {}),
});
const client = createMcpClient({ name: "smoke-real", version: "0.0.0" });
await connectMcpClient(client, transport);
let tabId;
try {
  if (process.argv.includes("--require-scaled-display")) {
    console.log(`Fresh display smoke on harness ports ${process.env.CCMCP_PORT}/${process.env.CCMCP_CLIENT_PORT}, expected extension v${expected}`);
  } else {
    console.log(`\nserver up on 9223. In your main Chrome, make sure the extension is loaded`);
    console.log(`and reloaded to v${expected} (popup → Reload extension)…\n`);
  }

  async function call(name, args = {}) {
    const res = await callRaw(client, { name, arguments: args });
    return { isError: res.isError === true, text: res.content?.[0]?.text ?? "" };
  }

  // Wait for YOUR extension. Warn (don't gate) if it's an older version.
  const deadline = Date.now() + 120_000;
  let ctx = null;
  while (Date.now() < deadline) {
    const r = await call("tabs_context_mcp", { createIfEmpty: true });
    if (!r.isError) {
      ctx = JSON.parse(r.text);
      break;
    }
    process.stdout.write(".");
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (!ctx) {
    console.error("\n✗ extension never connected. Is it loaded in your Chrome?");
    throw new Error("Extension never connected");
  }
  tabId = ctx.tabs?.[0]?.tabId;
  console.log(`\n✓ connected. extension v${ctx.version ?? "?"} (expected ${expected})`);
  if (ctx.version !== expected) {
    console.log(`  ⚠ version mismatch — reload your extension to v${expected} for an accurate smoke.`);
  }

  await call("navigate", { url: "example.com", tabId });

  const dprRes = await call("javascript_tool", { tabId, text: `window.devicePixelRatio` });
  const zoomRes = await call("javascript_tool", {
    tabId,
    text: `Math.round((window.outerWidth/window.innerWidth)*100)/100`,
  });
  console.log(`\n--- display ---`);
  console.log(`devicePixelRatio = ${dprRes.text.trim()}   (1 = no OS scaling)`);
  console.log(`approx zoom ratio = ${zoomRes.text.trim()}`);
  if (process.argv.includes("--require-scaled-display") && !(Number(dprRes.text.trim()) > 1)) throw new Error("Display smoke requires actual devicePixelRatio > 1 without emulation");

  // Coordinate clicks resolve CSS-pixel positions through the synthetic page
  // path. This display smoke checks landing on a scaled display, not isTrusted.
  await call("javascript_tool", {
    tabId,
    text: `(()=>{const b=document.createElement('button');b.id='ccdpr';b.textContent='DPR target';b.style.cssText='position:fixed;left:220px;top:160px;width:180px;height:64px;z-index:99999';b.onclick=()=>{window.__ccDpr=true};document.body.appendChild(b);window.__ccDpr=false;return 'ok'})()`,
  });
  const centerRes = await call("javascript_tool", {
    tabId,
    text: `(()=>{const r=document.getElementById('ccdpr').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`,
  });
  const center = JSON.parse(centerRes.text);
  const clicked = await call("computer", {
    action: "left_click",
    coordinate: [center.x, center.y],
    tabId,
  });
  const fired = await call("javascript_tool", { tabId, text: `window.__ccDpr===true` });

  console.log(`\n--- CSS-pixel coordinate-click test ---`);
  console.log(`button center (CSS px) = ${center.x},${center.y}`);
  console.log(`computer left_click(coordinate) -> ${clicked.isError ? clicked.text : clicked.text.slice(0, 60)}`);
  const ok = fired.text.trim() === "true";
  console.log(ok ? "✓ coordinate click LANDED on the button" : "✗ coordinate click MISSED — inspect the CSS coordinates and target");

  console.log(`\n=== verdict ===`);
  if (ok) {
    console.log("Synthetic coordinate clicks land on this display.");
  } else {
    console.log("Coordinate clicks miss on this display. Ref clicks still work (el.click).");
    console.log("Check the viewport coordinates against the target's current bounds and the display/zoom values above.");
  }


  if (!ok) process.exitCode = 1;
} finally {
  try {
    if (tabId) {
      const closed = await callRaw(client, { name: "tabs_close_mcp", arguments: { tabId } });
      if (closed.isError) throw new Error(`Display smoke tab cleanup failed: ${closed.content?.[0]?.text ?? "tool refusal"}`);
    }
  } finally { await client.close(); }
}
console.log("\nsmoke done. (Ref-based clicks/fills were validated in CI; this checked the display-dependent path.)");
