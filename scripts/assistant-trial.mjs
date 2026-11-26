#!/usr/bin/env node
// `npm run trial`: the same assistant tasks against every model backend this
// computer has, in the CI harness's own Chromium on ports 9224/9226, never the
// everyday browser. Real model calls cost quota or money, so this runs only on
// request and never in `npm test` or CI. The table is printed and the result
// saved as JSON in ~/.claude-chrome-mcp/trials/, without replies, page text or
// keys. Usage: docs/model-trial.md.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TRIAL_TURN_LIMIT_MS, TRIAL_USAGE, formatTrialTable, parseTrialArgs, selectTrialBackends, trialTasks } from "./assistant-trial-tasks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let options;
try { options = parseTrialArgs(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(2); }
if (options.help) { console.log(TRIAL_USAGE); process.exit(0); }

// The assistant's own folder, as the panel's assistant process resolves it.
const configDir = process.env.CCMCP_MODULE_CONFIG_DIR || join(homedir(), ".claude-chrome-mcp");
const assistantDir = join(configDir, "assistant");

// The local catalog and the Ollama check come from the build; build once if it is missing.
const bundle = name => join(root, "dist", name);
if (!["assistant-agent.mjs", "assistant-local-models.mjs", "assistant-ollama.mjs"].every(name => existsSync(bundle(name)))
  && spawnSync(process.execPath, [join(root, "build.mjs")], { cwd: root, stdio: "inherit" }).status !== 0) {
  console.error("Bygget misslyckades; provet kördes inte.");
  process.exit(1);
}
const { assistantLocalModels } = await import(pathToFileURL(bundle("assistant-local-models.mjs")).href);
const { OllamaClient, readAssistantLocalStatus } = await import(pathToFileURL(bundle("assistant-ollama.mjs")).href);

/** A CLI is available when `<command> --version` answers; the run itself shows whether it is logged in. */
function cli(command, name) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 20_000, shell: false });
  return result.status === 0 ? { ok: true, version: String(result.stdout).trim().split("\n")[0].slice(0, 80) }
    : { ok: false, reason: `${name} CLI svarar inte (${command} --version). Installera det och logga in.` };
}
// Self-tests this computer passed admit an Ollama release the catalog has not pinned.
let localVerifications = [];
try { localVerifications = JSON.parse(readFileSync(join(assistantDir, "local-models.json"), "utf8")).verifications ?? []; }
catch { /* No self-test saved: only catalog-tested Ollama releases run. */ }
const status = await readAssistantLocalStatus(new OllamaClient(), localVerifications)
  .catch(error => ({ reachable: false, message: error.message, models: [] }));
const found = {
  codex: cli("codex", "Codex"),
  claude: cli("claude", "Claude Code"),
  // Only whether a key is saved: the trial never reads it. A run with Berget reads it the way the panel does.
  berget: existsSync(join(assistantDir, "berget-api-key")) ? { ok: true } : { ok: false, reason: "Ingen Berget-nyckel är sparad i inställningarna." },
  local: assistantLocalModels.map(model => {
    const entry = status.models.find(item => item.id === model.id);
    const ok = status.reachable && entry?.state === "ready";
    const reason = ok ? undefined : !status.reachable ? `Ollama svarar inte: ${status.message ?? "okänt fel"}`
      : entry?.state === "missing" ? "Modellen är inte hämtad i Ollama." : entry?.message ?? "Modellen är inte redo i Ollama.";
    return { id: model.id, label: model.label, ok, reason };
  }),
};
const { selected, skipped } = selectTrialBackends(options.backends, found);

console.log(`Modellprov: uppgift ${options.tasks.join(", ")}${options.tasks.includes("E") ? " (E söker på den riktiga webben)" : " (offline mot loopback)"}`);
for (const backend of selected) console.log(`  ✓ ${backend.label}${found[backend.kind]?.version ? ` – ${found[backend.kind].version}` : ""}`);
for (const backend of skipped) console.log(`  – hoppas över: ${backend.label}: ${backend.reason}`);
if (!selected.length) { console.error("Ingen av modellerna kan köras på den här datorn."); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "tabai-trial-run-"));
const configPath = join(work, "config.json"), resultsPath = join(work, "results.json");
writeFileSync(configPath, JSON.stringify({ backends: selected, tasks: options.tasks, assistantDir, localVerifications, resultsPath }), { mode: 0o600 });
// Every turn has its own limit; the harness's watchdog leaves room for all of them plus startup.
const turns = selected.length * trialTasks("http://127.0.0.1").filter(task => options.tasks.includes(task.id)).reduce((sum, task) => sum + task.turns.length, 0);
const minutes = Math.ceil(turns * (TRIAL_TURN_LIMIT_MS + 10_000) / 60_000) + 5;

const env = { ...process.env };
if (options.headed) delete env.CCMCP_HEADLESS; else env.CCMCP_HEADLESS = "1";
const startedAt = new Date().toISOString();
const harness = spawn(process.execPath, [join(root, "test", "ci-harness.mjs"), "--suite", "assistant-trial-live.mjs", "--watchdog-minutes", String(minutes), "--", configPath],
  { cwd: root, env, stdio: "inherit" });
// Ctrl+C reaches the harness too; wait for its teardown, which restores the default build.
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.on(signal, () => { harness.kill(signal); });
const code = await new Promise(resolve => {
  harness.once("error", () => resolve(1));
  harness.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
});

let results = [];
try { results = JSON.parse(readFileSync(resultsPath, "utf8")); } catch { /* The suite saved no result. */ }
rmSync(work, { recursive: true, force: true });
if (results.length) {
  console.log(`\n${formatTrialTable(results)}`);
  const folder = join(configDir, "trials");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `trial-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, startedAt, finishedAt: new Date().toISOString(), tasks: options.tasks,
    backends: selected.map(({ id, label }) => ({ id, label })), skipped, harnessExitCode: code, results }, null, 2), { mode: 0o600 });
  console.log(`\n${results.filter(result => result.pass).length} av ${results.length} godkända. Resultatet sparades i ${file}`);
}
if (code !== 0) console.error(`\nProvets webbläsarkörning avslutades med kod ${code}; resultatet ovan kan vara ofullständigt.`);
process.exit(code);
