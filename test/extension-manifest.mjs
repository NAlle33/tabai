// The extension's static load-time contract: every manifest icon path exists
// under the extension root at its declared pixel size, the action shares those
// icons, the product name is set, and the popup wordmark is a real file with an
// accessible name. Chrome refuses to load an extension whose icon paths are
// missing, so this guards `Load unpacked` without a browser.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const manifest = JSON.parse(readFileSync(join(extRoot, "manifest.json"), "utf8"));
for (const page of ["popup.html", "sidepanel.html"]) {
  assert.match(readFileSync(join(extRoot, page), "utf8"), /<link\s+rel="icon"\s+href="icons\/tabai-32\.png"/,
    `${page} must explicitly load the same branded favicon as the toolbar`);
}
let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (error) {
    console.log(`  ✗ ${name} — ${error.message}`);
    fail++;
  }
}

function pngSize(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString("latin1", 1, 4), "PNG", `${path} is not a PNG`);
  assert.equal(buf.toString("latin1", 12, 16), "IHDR", `${path} has no IHDR chunk`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

check("manifest carries the product name on the card and the toolbar action", () => {
  assert.equal(manifest.name, "Tabai");
  assert.equal(manifest.action?.default_title, "Tabai");
});

check("every declared icon exists under the extension root at its declared size", () => {
  const sizes = ["16", "32", "48", "128"];
  assert.deepEqual(Object.keys(manifest.icons ?? {}).sort((a, b) => a - b), sizes);
  for (const size of sizes) {
    const rel = manifest.icons[size];
    assert.ok(!rel.startsWith("/") && !rel.includes(".."), `${rel} must be extension-relative`);
    const path = join(extRoot, rel);
    assert.ok(existsSync(path), `${rel} missing`);
    assert.deepEqual(pngSize(path), { width: Number(size), height: Number(size) }, rel);
  }
});

check("new Chrome access stays optional: the required permissions are unchanged, so a reload is enough", () => {
  assert.deepEqual(manifest.permissions, ["tabs", "tabGroups", "scripting", "offscreen", "storage", "debugger", "downloads", "sidePanel"]);
  assert.deepEqual(manifest.optional_permissions, ["notifications", "contextMenus"]);
  assert.equal(manifest.commands?.["share-page"]?.suggested_key?.default, "Alt+Shift+D");
});

check("the action reuses the manifest icons", () => {
  assert.deepEqual(manifest.action?.default_icon, manifest.icons);
});

check("the popup wordmark is a real extension-root PNG with an accessible product name", () => {
  const html = readFileSync(join(extRoot, "popup.html"), "utf8");
  const img = /<h1>\s*<img\b([^>]*)>/.exec(html);
  assert.ok(img, "popup <h1> must contain the wordmark image");
  const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(img[1])?.[1];
  assert.equal(attr("alt"), "Tabai");
  const src = attr("src");
  assert.ok(src && !src.startsWith("/") && !src.includes(".."), "src must be extension-relative");
  const { width, height } = pngSize(join(extRoot, src));
  assert.equal(String(width), attr("width"), "intrinsic width attribute keeps the aspect ratio");
  assert.equal(String(height), attr("height"), "intrinsic height attribute keeps the aspect ratio");
});

console.log(`\n=== extension-manifest: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(fail === 0 ? 0 : 1);
