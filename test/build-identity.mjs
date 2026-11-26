import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "esbuild";
import { buildIdentity, buildIdentityPlugin } from "../scripts/build-identity.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog(() => rmSync(root, { recursive: true, force: true }));
const root = mkdtempSync(join(tmpdir(), "tabai-build-id-"));
try {
  for (const directory of ["src", "shared", "extension/src", "scripts", "extension/assets", "extension/icons"]) mkdirSync(join(root, directory), { recursive: true });
  for (const file of ["build.mjs", "package.json", "package-lock.json", "extension/manifest.json", "tsconfig.json", "src/tool.ts",
    "extension/popup.html", "extension/offscreen.html", "extension/sidepanel.html", "extension/sidepanel.css"]) writeFileSync(join(root, file), file.endsWith(".json") ? "{}\n" : "fixture\n");
  writeFileSync(join(root, "shared/build-info.ts"), "export const BUILD_ID = 'unbundled';");
  const first = buildIdentity(root, { port: "9223" });
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(buildIdentity(root, { port: "9223" }), first);
  assert.notEqual(buildIdentity(root, { port: "9224" }), first);
  writeFileSync(join(root, "src/tool.ts"), "changed source\n");
  assert.notEqual(buildIdentity(root, { port: "9223" }), first);
  const builder = await context({ entryPoints: [join(root, "shared/build-info.ts")], bundle: true, write: false,
    plugins: [buildIdentityPlugin(root, { port: "9223" })] });
  try {
    const before = (await builder.rebuild()).outputFiles[0].text;
    writeFileSync(join(root, "extension/sidepanel.css"), "changed UI\n");
    assert.notEqual((await builder.rebuild()).outputFiles[0].text, before, "rebuilds must recompute loaded identity, including static UI");
  } finally { await builder.dispose(); }
  console.log("Build identity: deterministic inputs, source/config/UI changes and rebuild freshness passed");
} finally { rmSync(root, { recursive: true, force: true }); stopWatchdog(); }
