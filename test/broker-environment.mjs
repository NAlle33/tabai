// Chrome-free test for what the detached broker takes from the client that
// spawns it, and for its orderly shutdown:
//   - its module store is the per-user default, not a client's disposable
//     CCMCP_CONFIG_DIR; a CCMCP_CONFIG_DIR that already holds the assistant's
//     stored state or the module registry is kept, so an installation relying
//     on it keeps its data, also when the client gave it as a relative path;
//   - its working directory is its bundle directory, not the client's project;
//   - on SIGTERM it refuses upgrades with HTTP 503 and closes its sockets while
//     the client port stays bound, a second broker loses the election in that
//     window, and the port is released only after the module process has exited.
// Everything runs in a temporary home on ports of its own; only processes this
// test started are stopped, by PID.
import { openSocket, waitOpen, closeSockets, stopChild, ownChild, stopChildren } from "./helpers/socket-fixture.mjs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { killPort } from "./kill-port.mjs";
import { allocatePorts } from "./free-port.mjs";
import { PROTOCOL_VERSION } from "../dist/protocol.mjs";
import { watchdog } from "./watchdog.mjs";

const sockets = new Set();
const children = new Set();
const brokerPids = new Set();
const ports = [];
const stopWatchdog = watchdog(cleanup, 90_000);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brokerPath = join(root, "dist", "broker.js");
const home = mkdtempSync(join(tmpdir(), "tabai-broker-environment-"));
const defaultDir = join(home, ".claude-chrome-mcp");
Object.assign(process.env, { HOME: home, USERPROFILE: home });
for (const key of ["CCMCP_CONFIG_DIR", "CCMCP_MODULE_CONFIG_DIR", "CCMCP_LOG_DIR", "BRIDGE_TOKEN"]) delete process.env[key];

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const EXT = { headers: { Origin: "chrome-extension://ccmcp-test" } };

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
async function waitUntil(predicate, timeoutMs) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}
async function stopPid(pid) {
  if (!pid || !isAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  if (!await waitUntil(() => !isAlive(pid), 10_000)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function cleanup() {
  await closeSockets(sockets);
  await stopChildren(children);
  for (const pid of brokerPids) await stopPid(pid);
  for (const port of ports) killPort(port);
  rmSync(home, { recursive: true, force: true });
}

// A module that records the store it was given. "linger" ignores SIGTERM and the
// end of its input, so only the broker's forced stop ends it.
const moduleScript = join(home, "environment-module.mjs");
writeFileSync(moduleScript, `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const [stateFile, mode] = process.argv.slice(2);
writeFileSync(stateFile, JSON.stringify({ pid: process.pid, moduleConfigDir: process.env.CCMCP_MODULE_CONFIG_DIR ?? null }));
const view = { title: "Environment probe", description: "Reports its store", startLabel: "Start", fields: [] };
const input = createInterface({ input: process.stdin });
input.on("line", line => process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, ok: true, result: view }) + "\\n"));
if (mode === "linger") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else input.on("close", () => process.exit(0));
`);
function register(dir, stateFile, mode = "") {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "personal-modules.json"), JSON.stringify([
    { id: "probe", command: process.execPath, args: [moduleScript, stateFile, ...(mode ? [mode] : [])], cwd: home },
  ]), { mode: 0o600 });
}

async function connectWs(url, opts) {
  for (let i = 0; i < 75; i++) {
    try { return await waitOpen(openSocket(sockets, url, opts)); } catch { await wait(200); }
  }
  throw new Error(`never connected: ${url}`);
}
function upgradeStatus(url, opts) {
  return new Promise(resolve => {
    const ws = openSocket(sockets, url, opts);
    const timer = setTimeout(() => finish("timeout"), 3000);
    const finish = value => { clearTimeout(timer); resolve(value); };
    ws.on("error", e => finish(/Unexpected server response: (\d+)/.exec(e.message)?.[1] ?? e.message));
    ws.on("open", () => { ws.close(); finish("open"); });
  });
}
// Start the probe module through the extension's panel channel.
function startProbe(ext) {
  return new Promise(resolve => {
    const id = randomUUID();
    const timer = setTimeout(() => resolve({ ok: false, error: "no panel response" }), 20_000);
    ext.on("message", data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "panel-response" && frame.id === id) { clearTimeout(timer); resolve(frame); }
    });
    ext.send(JSON.stringify({ type: "panel-request", id, command: { action: "module", moduleId: "probe", operation: "start", input: {} } }));
  });
}
function readState(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
// The detached broker is not our child: its PID comes from its own boot log,
// identified by the client port it bound.
function brokerPidFrom(logDir, clientPort) {
  if (!existsSync(logDir)) return undefined;
  for (const name of readdirSync(logDir)) {
    const pid = /^broker-\d{8}-(\d+)\.log$/.exec(name)?.[1];
    if (!pid) continue;
    const events = readFileSync(join(logDir, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (events.some(event => event.event === "client-endpoint-up" && event.port === Number(clientPort))) return Number(pid);
  }
  return undefined;
}
function workingDirectory(pid) {
  if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
  if (process.platform === "darwin") {
    const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout || "";
    return out.split("\n").find(line => line.startsWith("n"))?.slice(1);
  }
  return undefined;
}

// A session's MCP server (BridgeClient) started from a project directory spawns
// the broker, exactly as in production.
async function brokerSpawnedBy(label, configDir, project = mkdtempSync(join(home, `project-${label}-`))) {
  const [extPort, clientPort] = await allocatePorts(2);
  ports.push(extPort, clientPort);
  const logDir = join(home, `logs-${label}`);
  const client = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e",
    `import { BridgeClient } from ${JSON.stringify(pathToFileURL(join(root, "dist", "bridge-client.mjs")).href)}; new BridgeClient();`], {
    cwd: project,
    env: { ...process.env, CCMCP_CONFIG_DIR: configDir, CCMCP_LOG_DIR: logDir, CCMCP_PORT: extPort, CCMCP_CLIENT_PORT: clientPort },
    stdio: "ignore",
  }));
  const ext = await connectWs(`ws://127.0.0.1:${extPort}`, EXT);
  await waitUntil(() => brokerPidFrom(logDir, clientPort) !== undefined, 5000);
  const pid = brokerPidFrom(logDir, clientPort);
  if (pid) brokerPids.add(pid);
  return { client, ext, pid };
}
async function stopSpawned({ client, ext, pid }) {
  // The client first: it would otherwise respawn the broker we stop.
  await stopChild(client);
  ext.close();
  await stopPid(pid);
}

let exitCode = 1;
try {
  const defaultState = join(home, "state-default.json");
  register(defaultDir, defaultState);

  // --- A client with a fresh, disposable store does not move the broker's store. ---
  const disposable = mkdtempSync(join(home, "disposable-store-"));
  const fresh = await brokerSpawnedBy("fresh", disposable);
  const freshStart = await startProbe(fresh.ext);
  check("a client's empty CCMCP_CONFIG_DIR is not adopted: the broker loads the per-user registry", freshStart.ok === true, JSON.stringify(freshStart));
  check("the module is given the per-user default store", readState(defaultState)?.moduleConfigDir === defaultDir, JSON.stringify(readState(defaultState)));
  check("nothing is written into the client's disposable store", readdirSync(disposable).length === 0, readdirSync(disposable).join(","));
  const cwd = fresh.pid ? workingDirectory(fresh.pid) : undefined;
  if (process.platform === "win32") console.log("  - broker working directory: not inspectable on Windows");
  else check("the broker runs in its bundle directory, not the spawning client's project", !!cwd && realpathSync(cwd) === realpathSync(join(root, "dist")), String(cwd));
  await stopSpawned(fresh);

  // --- A store that already holds the assistant's data keeps being used. ---
  const existing = mkdtempSync(join(home, "existing-store-"));
  mkdirSync(join(existing, "assistant"), { mode: 0o700 });
  writeFileSync(join(existing, "assistant", "workspace.json"), "{}", { mode: 0o600 });
  const existingState = join(home, "state-existing.json");
  register(existing, existingState);
  const kept = await brokerSpawnedBy("existing", existing);
  const keptStart = await startProbe(kept.ext);
  check("a CCMCP_CONFIG_DIR holding the assistant's stored state stays the broker's store",
    keptStart.ok === true && readState(existingState)?.moduleConfigDir === existing, JSON.stringify({ keptStart, state: readState(existingState) }));
  await stopSpawned(kept);

  // --- A store that holds only the module registry is existing data too. ---
  const registryOnly = mkdtempSync(join(home, "registry-store-"));
  const registryState = join(home, "state-registry.json");
  register(registryOnly, registryState);
  const registryKept = await brokerSpawnedBy("registry", registryOnly);
  const registryStart = await startProbe(registryKept.ext);
  check("a CCMCP_CONFIG_DIR holding only the module registry stays the broker's store",
    registryStart.ok === true && readState(registryState)?.moduleConfigDir === registryOnly, JSON.stringify({ registryStart, state: readState(registryState) }));
  await stopSpawned(registryKept);

  // --- A relative CCMCP_CONFIG_DIR names the same directory for the broker as
  // for the client: the broker runs in its bundle directory, not the client's.
  const relativeProject = mkdtempSync(join(home, "project-relative-"));
  const relativeStore = join(relativeProject, "relative-store");
  mkdirSync(join(relativeStore, "assistant"), { recursive: true, mode: 0o700 });
  writeFileSync(join(relativeStore, "assistant", "workspace.json"), "{}", { mode: 0o600 });
  const relativeState = join(home, "state-relative.json");
  register(relativeStore, relativeState);
  const relative = await brokerSpawnedBy("relative", "relative-store", relativeProject);
  const relativeStart = await startProbe(relative.ext);
  const relativeUsed = readState(relativeState)?.moduleConfigDir;
  check("a relative CCMCP_CONFIG_DIR holding the assistant's state is resolved against the spawning client's directory",
    relativeStart.ok === true && typeof relativeUsed === "string" && isAbsolute(relativeUsed) && realpathSync(relativeUsed) === realpathSync(relativeStore),
    JSON.stringify({ relativeStart, relativeUsed }));
  await stopSpawned(relative);

  // --- Orderly shutdown: the client port is the lock until the modules have exited. ---
  if (process.platform === "win32") {
    console.log("  - orderly shutdown: POSIX signals only");
  } else {
    const [extPort, clientPort] = await allocatePorts(2);
    ports.push(extPort, clientPort);
    const env = { ...process.env, CCMCP_PORT: extPort, CCMCP_CLIENT_PORT: clientPort };
    const lingerState = join(home, "state-linger.json");
    register(defaultDir, lingerState, "linger");
    const broker = ownChild(children, spawn(process.execPath, [brokerPath], {
      env: { ...env, CCMCP_LOG_DIR: join(home, "logs-shutdown") }, stdio: "ignore",
    }));
    const brokerExited = once(broker, "exit");
    // The second broker is loaded only when told to, so its start-up cost falls outside the window.
    const loserLogs = join(home, "logs-loser");
    const loser = ownChild(children, spawn(process.execPath, ["--input-type=module", "-e",
      `process.stdin.once("data", () => import(${JSON.stringify(pathToFileURL(brokerPath).href)}));`], {
      env: { ...env, CCMCP_LOG_DIR: loserLogs }, stdio: ["pipe", "ignore", "ignore"],
    }));
    const loserExited = once(loser, "exit");
    const ext = await connectWs(`ws://127.0.0.1:${extPort}`, EXT);
    const started = await startProbe(ext);
    const modulePid = readState(lingerState)?.pid;
    check("the shutdown fixture's module is running", started.ok === true && !!modulePid && isAlive(modulePid), JSON.stringify(started));
    const clientUrl = `ws://127.0.0.1:${clientPort}`;
    const client = await connectWs(clientUrl);
    const acknowledged = once(client, "message");
    client.send(JSON.stringify({ role: "client", sessionKey: "shutdown-test", version: PROTOCOL_VERSION, buildStatusVersion: 1 }));
    await acknowledged;
    const clientClosed = once(client, "close");
    const extClosed = once(ext, "close");

    broker.kill("SIGTERM");
    let refused;
    for (let i = 0; i < 40 && refused !== "503"; i++) {
      refused = await upgradeStatus(clientUrl);
      if (refused !== "503") await wait(25);
    }
    const moduleAliveWhileRefused = !!modulePid && isAlive(modulePid);
    check("after SIGTERM the client port refuses upgrades with HTTP 503", refused === "503", `got=${refused}`);
    const extRefused = await upgradeStatus(`ws://127.0.0.1:${extPort}`, EXT);
    check("after SIGTERM the extension port refuses upgrades with HTTP 503", extRefused === "503", `got=${extRefused}`);
    // 1001 is the broker closing them; a socket that only dies with the process ends with 1006.
    const codes = await Promise.race([Promise.all([clientClosed, extClosed]).then(events => events.map(([code]) => code)), wait(10_000).then(() => [])]);
    check("after SIGTERM the broker closes the open client and extension sockets itself", codes.length === 2 && codes.every(code => code === 1001), `codes=${codes.join(",")}`);

    loser.stdin.write("start\n");
    const loserExit = await Promise.race([loserExited.then(([code]) => code), wait(15_000).then(() => "timeout")]);
    const loserEvents = existsSync(loserLogs) ? readdirSync(loserLogs).map(name => readFileSync(join(loserLogs, name), "utf8")).join("") : "";
    check("a broker started while the first shuts down loses the election and exits 0",
      loserExit === 0 && loserEvents.includes('"client-port-busy-exit"'), `exit=${loserExit}`);
    check("the module was still running while the port refused upgrades", moduleAliveWhileRefused);

    const brokerExit = await Promise.race([brokerExited.then(() => true), wait(15_000).then(() => false)]);
    check("the shutting-down broker exits", brokerExit);
    check("the broker exits only after its module process has exited", brokerExit && !!modulePid && !isAlive(modulePid));
    const portFree = await new Promise(resolve => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(Number(clientPort), "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    check("the client port is free once the broker has exited", portFree);
  }

  exitCode = fail === 0 ? 0 : 1;
} finally {
  await cleanup();
}
console.log(`\n=== broker-environment: ${pass} passed, ${fail} failed ===`);
stopWatchdog();
process.exit(exitCode);
