// CI live-harness: launches a DEDICATED Chromium (Playwright's bundled binary)
// with the freshly-built unpacked extension, then runs e2e-live against it.
// Auto-loads the current build — no manual reload, ever. Fully isolated from
// your everyday Chrome:
//   - own user-data-dir (separate process), and
//   - a DEDICATED bridge port (9224) baked into this build, so the CI extension
//     never collides with an always-on extension on 9223 in your main Chrome.
//
// Launched as a RAW process (not via Playwright's page API) so Playwright never
// CDP-attaches to the extension's tabs (would conflict with chrome.debugger).
//
// Env: CCMCP_HEADLESS=1 → headless=new (extensions supported); default headed.
import { chromium } from "playwright";
import { openCdpObserver } from "./helpers/cdp-observer.mjs";
import { createMcpClient, createMcpTransport, connectMcpClient, callRaw } from "./helpers/mcp-client.mjs";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { killPort } from "./kill-port.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--display-smoke") && process.env.CCMCP_HEADLESS) {
  throw new Error("--display-smoke requires CCMCP_HEADLESS to be unset for a headed browser");
}
// Optional: `--suite <file> [--watchdog-minutes <n>] [-- <suite args>]` runs only that
// suite of test/ in the same launched browser; without it the default list runs.
const suiteFlag = process.argv.indexOf("--suite");
const singleSuite = suiteFlag >= 0 ? process.argv[suiteFlag + 1] : undefined;
if (suiteFlag >= 0 && (!singleSuite || !/^[\w.-]+\.mjs$/.test(singleSuite) || !existsSync(join(root, "test", singleSuite)))) {
  throw new Error("--suite requires the file name of a suite in test/");
}
const watchdogFlag = process.argv.indexOf("--watchdog-minutes");
const singleSuiteWatchdogMs = watchdogFlag >= 0 ? Number(process.argv[watchdogFlag + 1]) * 60_000 : undefined;
if (watchdogFlag >= 0 && (!singleSuite || !Number.isFinite(singleSuiteWatchdogMs) || singleSuiteWatchdogMs <= 0)) {
  throw new Error("--watchdog-minutes requires --suite and a positive number of minutes");
}
const singleSuiteArgs = singleSuite && process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];
const extPath = join(root, "extension");
const CI_PORT = "9224"; // extension <-> broker
const CI_CLIENT_PORT = "9226"; // broker <-> MCP-server clients (own non-colliding pair)
const CI_LOG_DIR = mkdtempSync(join(tmpdir(), "ccmcp-cilog-")); // isolated log dir
const CI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccmcp-config-"));
writeFileSync(join(CI_CONFIG_DIR, "personal-modules.json"), JSON.stringify([{
  id: "test-module", command: process.execPath,
  args: [join(root, "test/fixtures/personal-module.mjs"), join(CI_CONFIG_DIR, "module-state.json")], cwd: root,
}, {
  id: 'workspace-module', command: process.execPath,
  args: [join(root, 'test/fixtures/workspace-module.mjs'), join(CI_CONFIG_DIR, 'workspace-state.json')], cwd: root,
}, {
  id: 'assistant-fixture', command: process.execPath,
  args: [join(root, 'test/assistant-panel-live.mjs'), '--fixture', join(CI_CONFIG_DIR, 'assistant-fixture.json')], cwd: root,
}]), { mode: 0o600 });
const downloadDir = mkdtempSync(join(tmpdir(), "ccmcp-downloads-"));
process.on("exit", () => {
  // Also cover missing binaries, occupied ports and an early build failure.
  for (const path of [CI_CONFIG_DIR, downloadDir]) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* Windows may briefly hold a file */ }
  }
});
// Everything the CI build bakes in (see build.mjs defines). The restore build
// must see NONE of these — a value that leaks into the everyday build would make
// the dev broker log into a deleted temp dir and reap groups 2 s after a
// disconnect. Deleting the keys also drops a CCMCP_* var set in the shell.
const CI_ENV = {
  CCMCP_PORT: CI_PORT,
  CCMCP_CLIENT_PORT: CI_CLIENT_PORT,
  CCMCP_LOG_DIR: CI_LOG_DIR, // any CI-build broker logs here
  CCMCP_REAP_GRACE_MS: "2000", // any CI-build broker reaps fast
  CCMCP_CONFIG_DIR: CI_CONFIG_DIR,
  // Personal modules and the processes they start read this one; a shell value
  // would otherwise point the CI build and the suites' servers at the user's own.
  CCMCP_MODULE_CONFIG_DIR: CI_CONFIG_DIR,
  CCMCP_TEST_DOWNLOAD_DIR: downloadDir,
};
// The restore build gets back the module directory the shell had, as before.
const shellModuleConfigDir = process.env.CCMCP_MODULE_CONFIG_DIR;

function build(env) {
  const r = spawnSync(process.execPath, [join(root, "build.mjs")], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`build failed (ports ${env.CCMCP_PORT ?? "default"})`);
}
function devEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(CI_ENV)) delete env[k];
  if (shellModuleConfigDir !== undefined) env.CCMCP_MODULE_CONFIG_DIR = shellModuleConfigDir;
  return env;
}

const exe = chromium.executablePath();
if (!existsSync(exe)) {
  console.error(`✗ Playwright Chromium not installed (${exe}) — run: npx playwright install chromium`);
  process.exit(1);
}

console.log(`building extension + server on dedicated CI ports ${CI_PORT}/${CI_CLIENT_PORT}…`);
// A previous run's broker must be reconciled before starting this harness.
// Never kill an unidentified process just because it occupies the CI port.
for (const port of [CI_PORT, CI_CLIENT_PORT]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`CI port ${port} is already in use; stop its stale owner before retrying`)));
    probe.listen(Number(port), "127.0.0.1", () => probe.close(resolve));
  });
}
const userDataDir = mkdtempSync(join(tmpdir(), "ccmcp-ci-"));
// Keep fixture downloads in a disposable directory. The user's Downloads folder
// can require a macOS permission prompt that a headless run cannot answer.
const args = [
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  `--load-extension=${extPath}`,
  `--disable-extensions-except=${extPath}`,
  "--no-first-run",
  "--no-default-browser-check",
  // Fresh macOS profiles must not wait on an invisible Keychain prompt before
  // the extension's offscreen document can start. Matches Playwright's launcher.
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-background-timer-throttling",
  "about:blank",
];
// Chromium's new-surface capture avoids waiting for a hidden frame's
// presentation callback. It does not select or focus the captured tab.
// Headless macOS never presents that copied frame, so a document that loaded
// in a background tab publishes no first-contentful-paint until it is shown
// and the keyboard paint guard correctly refuses input. There the default
// capture, which waits for a presented frame, is the one that paints.
if (!(process.platform === "darwin" && process.env.CCMCP_HEADLESS)) args.splice(args.length - 1, 0, "--enable-features=CDPScreenshotNewSurface");
if (process.env.CCMCP_HEADLESS) args.unshift("--headless=new");
// GitHub's Ubuntu image blocks user namespaces for the bundled test binary.
// Match Playwright's launcher for this disposable CI browser only.
if (process.platform === "linux" && process.env.GITHUB_ACTIONS === "true") args.unshift("--no-sandbox");

let browser;
let startupBroker;
let startupClient;
const recordBrowserLog = chunk => appendFileSync(join(CI_LOG_DIR, "browser.log"), chunk);
// An async spawn failure (missing/unlaunchable binary) would otherwise surface as
// an uncaught 'error' event and kill the process BEFORE `finally` restores the
// dev build — leaving dist/ on the CI ports and the everyday extension unable
// to connect.
let browserError = null;

let exitCode = 1;
let teardownPromise;
let browserControl;
let testProcess;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T"]);
  else child.kill("SIGTERM");
  for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
    await sleep(200);
  }
}
function teardown() {
  return teardownPromise ??= (async () => {
  browserControl?.close();
  console.log("\ntearing down browser…");
  await stopChild(testProcess);
  await stopChild(browser);
  await startupClient?.close().catch(() => {});
  await stopChild(startupBroker);
  browser?.stderr.off("data", recordBrowserLog);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(CI_CONFIG_DIR, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
  } catch {
    /* temp dir may be briefly locked */
  }
  if (exitCode === 0) {
    try {
      rmSync(CI_LOG_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } else {
    // Kept for diagnosis (CI uploads it as an artifact).
    console.log(`CI log dir kept for inspection: ${CI_LOG_DIR}`);
  }
  // Restore the default-port (9223) build so normal `npm start` + your main
  // Chrome keep working on 9223 — with the CI env keys removed.
  console.log("restoring default build (port 9223)…");
  try {
    build(devEnv());
  } catch {
    console.error("✗ restore build failed — run `npm run build` to leave the CI ports");
    exitCode = 1;
  }
  // Restore first: another connected server can respawn the broker as soon as
  // it closes. That respawn must read the default build, not the CI bundle.
  killPort(CI_CLIENT_PORT);
  killPort(CI_PORT);
  await sleep(300);
  })();
}
// Ctrl+C / a CI cancel must still restore the dev build.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await teardown();
    process.exit(130);
  });
}

try {
  // Signals and teardown are installed before the first build can replace the
  // bundles. Even cancellation while spawnSync builds must restore defaults.
  build({ ...process.env, ...CI_ENV });
  // Start the owned broker before Chrome. Otherwise offscreen's exponential
  // redial can outlast the broker's cold-start grace on a loaded machine.
  startupBroker = spawn(process.execPath, [join(root, "dist/broker.js")], {
    cwd: root, env: { ...process.env, ...CI_ENV }, stdio: ["ignore", "ignore", "pipe"],
  });
  startupBroker.stderr.on("data", chunk => appendFileSync(join(CI_LOG_DIR, "startup-broker.log"), chunk));
  startupBroker.on("error", error => { browserError = error; });
  console.log(`launching Chromium (${process.env.CCMCP_HEADLESS ? "headless" : "headed"}) with extension`);
  browser = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.on("data", recordBrowserLog);
  browser.on("error", error => { browserError = error; });
  await new Promise((r) => setTimeout(r, 3000));
  if (browserError) throw new Error(`Chromium failed to launch: ${browserError.message}`);
  if (browser.exitCode !== null || browser.signalCode !== null) throw new Error("Chromium exited before the live suite started");
  // Configure the disposable browser's downloads at browser scope. This never
  // attaches a debugger to any page, leaving chrome.debugger free for the tools.
  const activePort = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 240 && !existsSync(activePort); i++) {
    if (browserError || browser.exitCode !== null || browser.signalCode !== null) throw new Error("Chromium failed during startup");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!existsSync(activePort)) throw new Error("Chromium did not expose its startup endpoint; see browser.log");
  const [debugPort, debugPath] = readFileSync(activePort, "utf8").trim().split("\n");
  const downloadDeadline = Date.now() + 35000;
  const downloadControl = await openCdpObserver(`ws://127.0.0.1:${debugPort}${debugPath}`, {
    timeoutMs: 35000, handshakeTimeout: 30000,
    timeoutMessage: () => "download configuration timed out",
    closedMessage: "browser disconnected during download configuration",
  });
  // Retain this socket: Chrome resets download behavior when its session closes.
  browserControl = downloadControl.socket;
  await downloadControl.rpc("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir }, undefined,
    Math.max(1, downloadDeadline - Date.now()));

  // Poll only a read, never a browser mutation. Readiness means the freshly
  // built extension answered through both bridge hops, not just a fixed sleep.
  startupClient = createMcpClient({ name: "ci-readiness", version: "1.0.0" });
  await connectMcpClient(startupClient, createMcpTransport({ command: process.execPath,
    args: [join(root, "dist/server.js")], cwd: root, env: CI_ENV }));
  const readyDeadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const response = await callRaw(startupClient, { name: "health", arguments: {} });
    if (!response.isError) {
      const health = JSON.parse(response.content?.[0]?.text ?? "{}");
      if (health.extension?.extVersion === JSON.parse(readFileSync(join(extPath, "manifest.json"), "utf8")).version
        && health.extension.buildId === health.serverBuildId && health.brokerBuildId === health.serverBuildId) { ready = true; break; }
    } else if (!/NO_EXTENSION|TIMEOUT/.test(response.content?.[0]?.text ?? "")) {
      throw new Error(`Extension readiness failed: ${response.content?.[0]?.text}`);
    }
    await sleep(250);
  }
  if (!ready) throw new Error("Fresh extension did not answer health within the startup deadline; see CI logs");
  await startupClient.close(); startupClient = undefined;
  console.log("fresh extension connected through the CI broker");

  const runTest = (file) =>
    new Promise((res) => {
      console.log(`\nrunning ${file} against the launched browser…\n`);
      const testArgs = [join(root, "test", file)];
      if (file === "smoke-real-chrome.mjs") testArgs.push("--require-scaled-display");
      // Observer-style suites read the extension through the browser's own CDP
      // endpoint instead of a page debugger the tools may hold.
      if (["recipe-recording-live.mjs", "settings-save-live.mjs", "assistant-reading-live.mjs", "ref-map-live.mjs", "popup-live.mjs", "visual-presence-live.mjs", "sidepanel-live.mjs", "extension-reload.mjs", "two-session-isolation.mjs", "e2e-live.mjs"].includes(file)) testArgs.push(`ws://127.0.0.1:${debugPort}${debugPath}`);
      if (["keyboard-live.mjs", "browser-pointer-live.mjs"].includes(file)) testArgs.push(CI_PORT, CI_CLIENT_PORT);
      if (file === "browser-pointer-live.mjs") testArgs.push(`ws://127.0.0.1:${debugPort}${debugPath}`);
      const artifactIndex = process.argv.indexOf("--artifact-dir");
      if (["perception-live.mjs", "visual-presence-live.mjs", "sidepanel-live.mjs", "popup-live.mjs"].includes(file) && artifactIndex >= 0) {
        const artifactDir = process.argv[artifactIndex + 1];
        if (!artifactDir) throw new Error("--artifact-dir requires a directory");
        testArgs.push(artifactDir);
      }
      if (file === singleSuite) testArgs.push(...singleSuiteArgs);
      const p = spawn(process.execPath, testArgs, {
        cwd: root,
        env: { ...process.env, ...CI_ENV },
        stdio: "inherit",
      });
      testProcess = p;
      const watchdogMs = file === singleSuite && singleSuiteWatchdogMs ? singleSuiteWatchdogMs : 300_000;
      const watchdog = setTimeout(async () => {
        console.error(`✗ ${file} exceeded its ${watchdogMs === 300_000 ? "five-minute" : `${watchdogMs / 60_000}-minute`} watchdog`);
        await stopChild(p);
        res(1);
      }, watchdogMs);
      p.on("error", error => { clearTimeout(watchdog); console.error(error.message); res(1); });
      p.on("exit", (c) => { clearTimeout(watchdog); testProcess = undefined; res(c ?? 1); });
    });
  exitCode = 0;
  const suites = process.argv.includes("--display-smoke") ? ["smoke-real-chrome.mjs"]
    : singleSuite ? [singleSuite]
    : ["recipe-recording-live.mjs", "settings-save-live.mjs", "assistant-reading-live.mjs", "assistant-web-live.mjs", "sidepanel-live.mjs", "visual-presence-live.mjs", "workflow-live.mjs", "perception-live.mjs", "keyboard-live.mjs", "browser-pointer-live.mjs", "ref-map-live.mjs", "navigation-live.mjs", "e2e-live.mjs", "two-session-isolation.mjs", "popup-live.mjs", "extension-reload.mjs"];
  for (const f of suites) {
    const c = await runTest(f);
    if (c !== 0) {
      exitCode = c;
      break;
    }
  }
} catch (e) {
  console.error(`✗ ${e?.message ?? e}`);
  exitCode = 1;
} finally {
  await teardown();
}
process.exit(exitCode);
