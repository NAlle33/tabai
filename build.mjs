// Build script. Server -> dist/server.js (ESM, Node, deps external).
// Extension scripts -> extension/dist/*.js (IIFE, browser, deps bundled).
// Pass --watch to rebuild on change (npm run dev).

import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { buildIdentity, buildIdentityPlugin } from "./scripts/build-identity.mjs";

const watch = process.argv.includes("--watch");

for (const dir of ["dist", "extension/dist"]) {
  rmSync(dir, { recursive: true, force: true });
}

const PORT = process.env.CCMCP_PORT || "9223";
// Broker's client endpoint — its OWN override so the CI harness isolates BOTH
// ports (the old single port 9224 is the CI extension port; must not collide).
const CLIENT_PORT = process.env.CCMCP_CLIENT_PORT || "9225";
const identityConfig = { port: PORT, clientPort: CLIENT_PORT,
  logDir: process.env.CCMCP_LOG_DIR || "", reapGrace: process.env.CCMCP_REAP_GRACE_MS || "",
  moduleDir: process.env.CCMCP_MODULE_CONFIG_DIR || process.env.CCMCP_CONFIG_DIR || "" };
const BUILD_ID = buildIdentity(process.cwd(), identityConfig);
/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  logLevel: "info",
  sourcemap: true,
  plugins: [buildIdentityPlugin(process.cwd(), identityConfig)],
  define: {
    __CCMCP_BUILD_ID__: JSON.stringify(BUILD_ID),
    __CCMCP_PORT__: JSON.stringify(PORT),
    __CCMCP_CLIENT_PORT__: JSON.stringify(CLIENT_PORT),
    // Baked log-dir fallback. CI bakes its isolated dir so a broker respawned
    // from the CI build by ANOTHER local process (e.g. a parallel session that
    // shares the clobbered dist) still logs where the harness looks. Empty in a
    // normal build → falls back to the per-user default at runtime.
    __CCMCP_LOG_DIR__: JSON.stringify(process.env.CCMCP_LOG_DIR || ""),
    // Same rationale as the log dir: CI bakes a short reap grace so a broker
    // respawned from the CI build (clean env, no CCMCP_REAP_GRACE_MS) still reaps
    // fast enough for the test. Empty in a normal build → runtime default (45s).
    __CCMCP_REAP_GRACE_MS__: JSON.stringify(process.env.CCMCP_REAP_GRACE_MS || ""),
    __CCMCP_MODULE_CONFIG_DIR__: JSON.stringify(process.env.CCMCP_MODULE_CONFIG_DIR || process.env.CCMCP_CONFIG_DIR || ""),
  },
};

/** @returns {import("esbuild").BuildOptions} */
function nodeConfig(source, output, external = false, executable = false) {
  return { ...common, entryPoints: [source], outfile: output,
    platform: "node", format: "esm", target: "node20",
    ...(external ? { packages: "external" } : {}),
    ...(executable ? { banner: { js: "#!/usr/bin/env node" } } : {}),
  };
}

/** @returns {import("esbuild").BuildOptions} */
function browserConfig() {
  return { ...common,
    entryPoints: { background: "extension/src/background.ts", offscreen: "extension/src/offscreen.ts",
      popup: "extension/src/popup.ts", sidepanel: "extension/src/sidepanel.ts", content: "extension/src/content.ts" },
    outdir: "extension/dist", platform: "browser", format: "iife", target: "chrome116",
  };
}

/** @type {import("esbuild").BuildOptions[]} */
const configs = [
  // Node shims bundle dependencies unless explicitly marked external below.
  nodeConfig("extension/src/background.ts", "dist/background.mjs"),
  nodeConfig("extension/src/offscreen.ts", "dist/offscreen.mjs"),
  nodeConfig("src/server-panel-channel.ts", "dist/server-panel-channel.mjs", true),
  nodeConfig("src/auth.ts", "dist/auth.mjs"),
  ...["download-state", "cdp", "page-evaluation", "page-wait", "assistant-page-share", "assistant-context-menu"].map(name => nodeConfig(`extension/src/${name}.ts`, `dist/${name}.mjs`)),
  ...["tool-timeouts", "env", "pending-calls", "bridge-client", "loop-guard", "recipe-store", "run-history", "workflow-report", "workflow-control", "panel-router", "personal-modules", "assistant-pulse"].map(name => nodeConfig(`src/${name}.ts`, `dist/${name}.mjs`, true)),
  nodeConfig("src/server.ts", "dist/server.js", true, true),
  nodeConfig("src/tool-catalog.ts", "dist/tool-catalog.mjs", true),
  nodeConfig("shared/workflow-schema.ts", "dist/workflow-schema.mjs", true),
  nodeConfig("shared/stable-schemas.ts", "dist/stable-schemas.mjs", true),
  nodeConfig("shared/url-guard.ts", "dist/url-guard.mjs"),
  nodeConfig("shared/assistant-page.ts", "dist/assistant-page.mjs"),
  nodeConfig("shared/tool-names.ts", "dist/tool-names.mjs"),
  nodeConfig("src/bridge.ts", "dist/bridge.mjs", true),
  nodeConfig("src/session-reaper.ts", "dist/session-reaper.mjs"),
  nodeConfig("src/tool-orchestration.ts", "dist/tool-orchestration.mjs", true),
  nodeConfig("extension/src/tab-group-helpers.ts", "dist/tab-group-helpers.mjs"),
  nodeConfig("shared/protocol.ts", "dist/protocol.mjs"),
  nodeConfig("src/broker.ts", "dist/broker.js", true, true),
  nodeConfig("src/assistant-main.ts", "dist/assistant.js", true, true),
  nodeConfig("src/assistant-worker.ts", "dist/assistant-worker.mjs", true, true),
  nodeConfig('src/assistant-berget-runner.ts', 'dist/assistant-berget-runner.mjs', true, true),
  nodeConfig("src/assistant-local-runner.ts", "dist/assistant-local-runner.mjs", true, true),
  nodeConfig("src/assistant-controller.ts", "dist/assistant-controller.mjs", true),
  nodeConfig('src/assistant-chat.ts', 'dist/assistant-chat.mjs', true),
  nodeConfig('src/assistant-file-reader.ts', 'dist/assistant-file-reader.mjs', true),
  nodeConfig('src/assistant-berget-agent.ts', 'dist/assistant-berget-agent.mjs', true),
  nodeConfig("src/assistant-browser.ts", "dist/assistant-browser.mjs", true),
  nodeConfig("src/assistant-mcp-browser.ts", "dist/assistant-mcp-browser.mjs", true),
  nodeConfig("src/assistant-web.ts", "dist/assistant-web.mjs", true),
  nodeConfig("src/assistant-watches.ts", "dist/assistant-watches.mjs", true),
  nodeConfig("src/assistant-routines.ts", "dist/assistant-routines.mjs", true),
  nodeConfig("src/assistant-profile.ts", "dist/assistant-profile.mjs", true),
  nodeConfig("src/assistant-tools.ts", "dist/assistant-tools.mjs", true),
  nodeConfig("src/assistant-agent.ts", "dist/assistant-agent.mjs", true),
  // The real-model smoke harness imports these; the runner bundles its own copy.
  nodeConfig("src/assistant-local-models.ts", "dist/assistant-local-models.mjs", true),
  nodeConfig("src/assistant-ollama.ts", "dist/assistant-ollama.mjs", true),
  browserConfig(),
];

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log(
    "✓ watching for changes (Ctrl+C to stop). Click ↻ in chrome://extensions after each rebuild.",
  );
} else {
  for (const c of configs) await esbuild.build(c);
  console.log("✓ build complete");
}
