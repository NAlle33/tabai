#!/usr/bin/env node
// Real-model protocol gate for the pinned local model. It talks only to
// Ollama on 127.0.0.1:11434, uses a harmless synthetic tool and never touches
// mail, browser or workspace data. Pulling requires the explicit --pull flag.
//
//   npm run local-model:smoke -- --all [--pull] [--pull-interrupt] [--report <file.md>] [--json <file.json>]
//   npm run local-model:smoke -- --model qwen3.5:4b-q4_K_M
//   npm run local-model:smoke -- --model qwen3.5:4b-q4_K_M --think            (measured variant)
//   npm run local-model:smoke -- --benchmark --all [--profile intent] [--think] [--case-file <json>] [--skip-cold] [--case-timeout <s>] [--judge]
//   npm run local-model:smoke -- --benchmark --backend codex|claude --case-file <json> --reps 1   (cloud control)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = async name => {
  const file = join(root, "dist", name);
  if (!existsSync(file)) { console.error(`Saknar ${file}. Kör npm run build först.`); process.exit(2); }
  return import(pathToFileURL(file).href);
};
const { OllamaClient } = await load("assistant-ollama.mjs");
const local = await load("assistant-local-models.mjs");
const { assistantLocalModels, assistantLocalModel, assistantLocalVariant, assistantChatRequest, assistantLocalProtocolRound, ASSISTANT_PROTOCOL_ROUNDS } = local;

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
// Locked before any real run: three full chains per profile, at most four turns each.
const ROUNDS = ASSISTANT_PROTOCOL_ROUNDS;
const MAX_TURNS = 4;
// A measured variant (another profile or reasoning mode) never changes the catalog;
// production keeps running the catalog profile until the catalog itself changes.
const variant = { ...(option("--profile") ? { profile: option("--profile") } : {}), ...(flag("--think") ? { think: true } : {}), ...(flag("--judge") ? { judge: true } : {}) };
if (variant.profile && !["native", "intent"].includes(variant.profile)) { console.error("--profile måste vara native eller intent."); process.exit(2); }
const measurement = Object.keys(variant).length ? variant : undefined;
// --backend codex|claude runs a cloud control measurement through the production CLI contracts.
const cloudBackend = option("--backend");
if (cloudBackend && !["codex", "claude"].includes(cloudBackend)) { console.error("--backend måste vara codex eller claude."); process.exit(2); }
const selected = cloudBackend ? [{ id: `${cloudBackend}:default`, label: cloudBackend === "codex" ? "Codex (förval)" : "Claude (förval)", profile: cloudBackend, think: false, testedOllama: [], cloud: true }]
  : (flag("--all") ? assistantLocalModels : option("--model") ? [assistantLocalModel(option("--model"))] : []).map(model => assistantLocalVariant(model, variant));
if (!selected.length) { console.error("Ange --all, --model <id> eller --backend codex|claude."); process.exit(2); }
if (cloudBackend && !flag("--benchmark")) { console.error("--backend gäller bara --benchmark."); process.exit(2); }

const client = new OllamaClient();
const metrics = reply => ({ promptTokens: reply.metrics.promptTokens, outputTokens: reply.metrics.outputTokens, loadMs: reply.metrics.loadMs, promptMs: reply.metrics.promptMs, evalMs: reply.metrics.evalMs, totalMs: reply.metrics.totalMs, firstChunkMs: reply.metrics.firstChunkMs });

if (flag("--benchmark")) { process.exitCode = await benchmark(); process.exit(); }

/**
 * Benchmark mode: the same harness drives the real runner, worker and host
 * validators over the locked synthetic cases. Three warm repetitions per case
 * and model with a rotated model order; latency cases also get three runs after
 * an explicit unload. Every attempt is reported, including failures.
 */
async function benchmark() {
  const { readFileSync } = await import("node:fs");
  const { runBenchmarkCase, gradeBenchmarkCase } = await import("./assistant-local-benchmark-host.mjs");
  const agent = await load("assistant-agent.mjs"), browser = await load("assistant-browser.mjs");
  // Run every case from a private snapshot of the runner and worker bundles, so a
  // concurrent rebuild of the shared output cannot change or remove the code under test.
  const { mkdtempSync, copyFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const snapshot = mkdtempSync(join(tmpdir(), "tabai-bench-")), snapshotDist = join(snapshot, "dist");
  mkdirSync(snapshotDist);
  for (const name of ["assistant-local-runner.mjs", "assistant-worker.mjs"]) copyFileSync(join(root, "dist", name), join(snapshotDist, name));
  symlinkSync(join(root, "node_" + "modules"), join(snapshot, "node_" + "modules"), process.platform === "win32" ? "junction" : "dir");
  const caseFile = option("--case-file") ?? "test/fixtures/assistant-local-model-cases.json";
  const fixture = JSON.parse(readFileSync(resolve(root, caseFile), "utf8"));
  const only = option("--cases")?.split(",");
  const cases = fixture.cases.filter(entry => !only || only.includes(entry.id));
  const reps = Number(option("--reps") ?? 3), locked = reps === 3 && !only;
  const version = await client.version(), startedAt = new Date().toISOString();
  // --include-ungated measures a model whose protocol gate failed. Its runs are
  // labelled and never count as support; the production runner still refuses it.
  const ungated = selected.filter(model => !model.cloud && !model.testedOllama.includes(version));
  if (ungated.length && !flag("--include-ungated")) { console.error(`Ej godkända i protokollgaten för Ollama ${version}: ${ungated.map(model => model.id).join(", ")}. Lägg till --include-ungated för att ändå mäta dem.`); return 2; }
  const verified = ungated.map(model => ({ model: model.id, digest: model.digest, ollamaVersion: version, profile: model.profile, verifiedAt: new Date().toISOString() }));
  const runs = [];
  const loadedOthers = async model => ((await client.ps()).models ?? []).filter(entry => entry.name !== model.id).map(entry => entry.name);
  const unload = async model => { await client.unload(model.id); for (let i = 0; i < 40 && ((await client.ps()).models ?? []).some(entry => entry.name === model.id); i++) await new Promise(resolve => setTimeout(resolve, 250)); };
  const one = async (model, caseDef, rep, mode) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!model.cloud) for (const other of assistantLocalModels) if (other.id !== model.id) { try { await client.unload(other.id); } catch { /* Not pulled. */ } }
      if (mode === "cold" && !model.cloud) await unload(model);
      const contaminated = !model.cloud && ((await loadedOthers(model)).length > 0 || mode === "cold" && ((await client.ps()).models ?? []).length > 0);
      if (contaminated && attempt === 0) { console.log(`  kontaminerad cell (annan modell laddad), kör om`); continue; }
      // --case-timeout (seconds) lets a larger mailbox use the full production task deadline.
      const timeoutMs = option("--case-timeout") ? Number(option("--case-timeout")) * 1000 : undefined;
      // Cloud controls run with each backend's default model and effort.
      const cloud = model.cloud ? { backend: cloudBackend } : undefined;
      const record = await runBenchmarkCase({ root: snapshot, fixture, caseDef, model, verified, measurement, cloud, agent, browser, prompt: agent.ASSISTANT_PROMPT, ...(timeoutMs ? { timeoutMs } : {}) });
      const grade = gradeBenchmarkCase(caseDef, record);
      // Judgment assessments are reported apart from model turns.
      const turns = record.metrics.filter(turn => turn.phase !== "judge"), judged = record.metrics.filter(turn => turn.phase === "judge");
      const run = { model: model.id, gated: model.testedOllama.includes(version), profile: model.profile, think: model.think, case: caseDef.id, type: caseDef.type, rep, mode, contaminated, pass: grade.pass, failures: grade.failures, end: record.end, status: record.status.filter(code => code !== "ready"),
        timedOut: record.timedOut, totalMs: record.totalMs, firstCallMs: record.firstCallMs, hostCalls: record.calls.length, rejected: record.rejected.length, turns: turns.length,
        loadMs: turns[0]?.loadMs, firstPromptMs: turns[0]?.promptMs, firstChunkMs: turns[0]?.firstChunkMs, promptTokensMax: Math.max(0, ...turns.map(turn => turn.promptTokens ?? 0)),
        judgeTurns: judged.length, judgeDropped: judged.filter(turn => turn.dropped).length, judgeMs: judged.reduce((sum, turn) => sum + (turn.totalMs ?? 0), 0),
        outputTokens: turns.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0), evalMs: turns.reduce((sum, turn) => sum + (turn.evalMs ?? 0), 0), peakBytes: record.peakBytes,
        texts: { summary: record.result?.summary, findings: record.findings.map(finding => ({ kind: finding.kind, title: finding.title, summary: finding.summary, draft: finding.draft, question: finding.question })), question: record.question },
        callSequence: record.calls.slice(0, 60), callArgs: record.callArgs, modelTurns: turns.map(turn => turn.tools ?? (turn.calls ? "call" : "prose")).slice(0, 60),
        rejectedTools: record.rejected.map(entry => `${entry.tool}: ${entry.message}`).slice(0, 8) };
      runs.push(run);
      console.log(`  ${model.label} ${caseDef.id} ${mode} ${rep + 1}: ${run.pass ? "PASS" : "FAIL"} ${Math.round(run.totalMs / 100) / 10} s, ${run.hostCalls} anrop${run.pass ? "" : ` – ${run.failures.join("; ")}`}`);
      return;
    }
  };
  for (let rep = 0; rep < reps; rep++) {
    const order = selected.map((_, index) => selected[(index + rep) % selected.length]);
    for (const model of order) {
      console.log(`\n== repetition ${rep + 1}: ${model.id}`);
      // A warm-up turn loads the model so warm cells measure steady state.
      if (!model.cloud) await client.chat(assistantChatRequest(model, model.profile, [{ role: "user", content: "Hej" }], []), { timeoutMs: 180_000 }).catch(() => {});
      for (const caseDef of cases) await one(model, caseDef, rep, "warm");
    }
  }
  // Cold runs only measure load latency; --skip-cold leaves them out of a pass-rate run.
  if (!flag("--skip-cold")) for (const model of selected) for (const caseDef of cases.filter(entry => fixture.latencyCases.includes(entry.id))) for (let rep = 0; rep < reps; rep++) await one(model, caseDef, rep, "cold");
  const report = { startedAt, finishedAt: new Date().toISOString(), version, hardware: hardware(), locked, reps, caseFile, variant: measurement, cases: cases.map(entry => entry.id), runs };
  const json = option("--json");
  if (json) { mkdirSync(dirname(resolve(json)), { recursive: true }); writeFileSync(resolve(json), JSON.stringify(report, null, 2) + "\n"); }
  // Blind style review: random ids and no model names in the sheet; the key is kept apart.
  const sheet = option("--style-sheet"), key = option("--style-key");
  if (sheet && key) {
    const { randomUUID } = await import("node:crypto");
    const entries = [], mapping = {};
    for (const run of runs) {
      const texts = [run.texts.summary, run.texts.question, ...run.texts.findings.flatMap(finding => [finding.summary, finding.draft, finding.question])].filter(text => typeof text === "string" && text.trim());
      if (!texts.length) continue;
      const id = randomUUID().slice(0, 8), caseDef = fixture.cases.find(entry => entry.id === run.case);
      mapping[id] = { model: run.model, case: run.case, rep: run.rep, mode: run.mode };
      entries.push({ id, case: run.case, type: run.type, source: [...(caseDef.inbox ?? []), ...(caseDef.sent ?? []).filter(entry => !entry.ref)].map(thread => ({ subject: thread.subject, messages: thread.messages.map(message => `${message.name}: ${message.body}`) })),
        calendar: (caseDef.calendar ?? []).map(event => `${event.title}, ${event.start}–${event.end}, ${event.attendees.join(", ")}: ${event.description}`), texts });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(resolve(sheet), JSON.stringify({ rubric: fixture.styleRubric, entries }, null, 2) + "\n");
    writeFileSync(resolve(key), JSON.stringify(mapping, null, 2) + "\n");
  }
  rmSync(snapshot, { recursive: true, force: true });
  const failed = runs.filter(run => !run.pass).length;
  console.log(`\n${runs.length - failed}/${runs.length} körningar passerade${locked ? "" : " (ej låst upplägg)"}.`);
  return failed ? 1 : 0;
}

async function plainText(model) {
  const started = Date.now();
  try {
    const reply = await client.chat(assistantChatRequest(model, "native", [{ role: "user", content: "Skriv en kort mening på svenska om hösten i Stockholm." }], []), { timeoutMs: 180_000 });
    return { pass: !!reply.content.trim() && (model.think || !reply.thinking.trim()) && !/<\/?think>/i.test(reply.content), text: reply.content.trim().slice(0, 300), thinkingChars: reply.thinking.length, wallMs: Date.now() - started, ...metrics(reply) };
  } catch (error) { return { pass: false, error: `${error.code || "error"}: ${error.message}`, wallMs: Date.now() - started }; }
}

async function pull(model, interrupt) {
  const log = { interrupted: false, resumed: false, events: 0, startedAt: new Date().toISOString() };
  let last = 0;
  const report = event => {
    log.events++;
    const now = Date.now();
    if (event.total && now - last > 5_000) { last = now; process.stdout.write(`  ${model.id}: ${event.status} ${Math.round(100 * (event.completed || 0) / event.total)}%\n`); }
  };
  if (interrupt) {
    const controller = new AbortController();
    try {
      await client.pull(model.id, { signal: controller.signal, onProgress: event => { report(event); if (event.total && event.completed > event.total * 0.05) controller.abort(); } });
    } catch (error) {
      if (error.code !== "aborted") throw error;
      log.interrupted = true;
      const tags = await client.tags();
      log.listedAfterAbort = (tags.models ?? []).some(entry => entry.name === model.id);
      process.stdout.write(`  ${model.id}: avbruten; listad efter avbrott = ${log.listedAfterAbort}\n`);
    }
  }
  await client.pull(model.id, { onProgress: report });
  log.resumed = log.interrupted;
  log.finishedAt = new Date().toISOString();
  return log;
}

function hardware() {
  const info = { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30) };
  if (platform() === "darwin") {
    try { info.macos = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(); } catch { /* Optional detail. */ }
    try { info.gpu = execFileSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).split("\n").filter(line => /Chipset|Cores|Metal/.test(line)).map(line => line.trim()).join("; "); } catch { /* Optional detail. */ }
  }
  return info;
}

const report = { startedAt: new Date().toISOString(), rounds: ROUNDS, maxTurns: MAX_TURNS, hardware: hardware(), models: [] };
report.ollamaVersion = await client.version();
console.log(`Ollama ${report.ollamaVersion} på ${report.hardware.cpu}, ${report.hardware.memoryGiB} GiB`);

for (const model of selected) {
  console.log(`\n== ${model.id}`);
  const entry = { id: model.id, catalogDigest: model.digest, think: model.think, sampling: model.sampling, numCtx: model.numCtx, numPredict: model.numPredict };
  report.models.push(entry);
  let tags = await client.tags();
  if (!(tags.models ?? []).some(item => item.name === model.id)) {
    if (!flag("--pull")) { entry.error = "model not pulled (run with --pull)"; console.log("  saknas; kör med --pull"); continue; }
    entry.pull = await pull(model, flag("--pull-interrupt"));
    tags = await client.tags();
  }
  const tag = (tags.models ?? []).find(item => item.name === model.id);
  entry.tagDigest = tag?.digest; entry.sizeBytes = tag?.size; entry.digestMatches = tag?.digest === model.digest;
  const show = await client.show(model.id);
  entry.details = show.details; entry.capabilities = show.capabilities;
  entry.contextLength = Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
  entry.templateMentionsTools = typeof show.template === "string" ? /tools|tool_call/i.test(show.template) : undefined;
  entry.parameters = typeof show.parameters === "string" ? show.parameters.slice(0, 600) : undefined;
  if (!entry.digestMatches) { console.log(`  digest mismatch: ${tag?.digest}`); entry.error = "digest mismatch"; continue; }
  // Measure each model alone: unload the others first so timings are not shared.
  for (const other of assistantLocalModels) if (other.id !== model.id) { try { await client.unload(other.id); } catch { /* Not loaded or not pulled. */ } }
  entry.plain = await plainText(model);
  console.log(`  text${model.think ? " (thinking på)" : " utan thinking"}: ${entry.plain.pass ? "ok" : "FEL"} (${entry.plain.wallMs} ms) ${entry.plain.text ?? entry.plain.error}`);
  entry.profiles = {};
  for (const profile of ["native", "intent"]) {
    const attempts = [];
    for (let index = 0; index < ROUNDS; index++) {
      const attempt = await assistantLocalProtocolRound(client, model, profile, index);
      attempts.push(attempt);
      console.log(`  ${profile} runda ${index + 1}: ${attempt.pass ? "PASS" : "FAIL"} – ${attempt.reason}`);
    }
    entry.profiles[profile] = { attempts, passes: attempts.filter(item => item.pass).length, gate: attempts.length === ROUNDS && attempts.every(item => item.pass) };
  }
  // Production runs one fixed profile per model; only that profile can certify the runtime.
  entry.passingProfiles = Object.entries(entry.profiles).filter(([, profile]) => profile.gate).map(([name]) => name);
  // A measured variant reports its own profile's gate next to the catalog profile.
  entry.catalogProfile = assistantLocalModel(model.id).profile;
  entry.variant = measurement;
  entry.gate = entry.profiles[model.profile].gate;
  // The CPU path is measured per request (num_gpu 0); global Ollama settings stay untouched.
  // Unload returns before memory is released, so wait until /api/ps no longer lists it.
  await client.unload(model.id);
  for (let i = 0; i < 80 && ((await client.ps()).models ?? []).some(item => item.name === model.id); i++) await new Promise(done => setTimeout(done, 250));
  const cpu = await assistantLocalProtocolRound(client, model, model.profile, 0, undefined, true);
  entry.cpu = { profile: model.profile, pass: cpu.pass, reason: cpu.reason, turns: cpu.turns.map(turn => ({ wallMs: turn.wallMs, ...turn.metrics })) };
  entry.cpu.ps = (await client.ps()).models?.filter(item => item.name === model.id).map(item => ({ size: item.size, sizeVram: item.size_vram }));
  console.log(`  CPU-väg (${model.profile}): ${cpu.pass ? "PASS" : "FAIL"} – ${cpu.turns.map(turn => `${turn.wallMs} ms`).join(", ")}; VRAM ${entry.cpu.ps?.[0]?.sizeVram ?? "?"} av ${entry.cpu.ps?.[0]?.size ?? "?"} byte`);
  await client.unload(model.id);
  entry.psBeforeUnload = (await client.ps()).models?.map(item => ({ name: item.name, sizeVram: item.size_vram, size: item.size, contextLength: item.context_length, expiresAt: item.expires_at }));
  await client.unload(model.id);
  entry.loadedAfterUnload = ((await client.ps()).models ?? []).some(item => item.name === model.id);
  console.log(`  gate för katalogprofilen ${model.profile}: ${entry.gate ? "PASS" : "FAIL"} (native ${entry.profiles.native.passes}/${ROUNDS}, intent ${entry.profiles.intent.passes}/${ROUNDS}; godkända profiler: ${entry.passingProfiles.join(", ") || "inga"}); laddad efter unload = ${entry.loadedAfterUnload}`);
}
report.finishedAt = new Date().toISOString();
report.allGates = report.models.length === selected.length && report.models.every(model => model.gate);

const json = option("--json"), markdown = option("--report");
if (json) { mkdirSync(dirname(resolve(json)), { recursive: true }); writeFileSync(resolve(json), JSON.stringify(report, null, 2) + "\n"); }
if (markdown) {
  const lines = [`# Protokollprov för lokala modeller`, "", `Kört ${report.startedAt} – ${report.finishedAt}. Ollama ${report.ollamaVersion}.`,
    `Hårdvara: ${report.hardware.cpu}, ${report.hardware.cores} kärnor, ${report.hardware.memoryGiB} GiB, macOS ${report.hardware.macos ?? report.hardware.release}; ${report.hardware.gpu ?? ""}.`,
    `Låst upplägg: ${ROUNDS} rundor per profil, högst ${MAX_TURNS} turer, syntetiskt ofarligt verktyg, \`think:${selected[0].think}\`, sampling ${JSON.stringify(selected[0].sampling)}.`,
    "Detta är ett protokollprov, inte ett kvalitets- eller hastighetsbevis.", "",
    "| Modell | Digest stämmer | Fritext | Native | Intent | Katalogprofil | Gate | Unload |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const model of report.models) lines.push(`| \`${model.id}\` | ${model.digestMatches ? "ja" : model.error ?? "nej"} | ${model.plain?.pass ? "ok" : "fel"} | ${model.profiles?.native.passes ?? "–"}/${ROUNDS} | ${model.profiles?.intent.passes ?? "–"}/${ROUNDS} | ${model.catalogProfile ?? "–"} | ${model.gate ? "**PASS**" : "FAIL"} | ${model.loadedAfterUnload === false ? "ok" : "–"} |`);
  lines.push("", "CPU-vägen mättes per begäran med `num_gpu: 0` (en runda med modellens valda profil) utan att ändra Ollamas globala inställningar:", "");
  for (const model of report.models) if (model.cpu) lines.push(`- \`${model.id}\` (${model.cpu.profile}): ${model.cpu.pass ? "PASS" : "FAIL"}, ${model.cpu.turns.map(turn => `${turn.wallMs} ms`).join(" + ")}, VRAM ${model.cpu.ps?.[0]?.sizeVram ?? "?"} av ${model.cpu.ps?.[0]?.size ?? "?"} byte.`);
  lines.push("", "## Samtliga försök", "");
  for (const model of report.models) {
    lines.push(`### ${model.id}`, "", `Digest \`${model.tagDigest}\`, kvantisering ${model.details?.quantization_level}, familj ${model.details?.family}, kontext i modellen ${model.contextLength}, capabilities ${JSON.stringify(model.capabilities)}.`, "");
    for (const [profile, result] of Object.entries(model.profiles ?? {})) for (const [index, attempt] of result.attempts.entries())
      lines.push(`- ${profile} ${index + 1} (${attempt.orderId}): ${attempt.pass ? "PASS" : "FAIL"} – ${attempt.reason}; turer ${attempt.turns.length}; ${attempt.turns.map(turn => `${turn.wallMs} ms/${turn.metrics.promptTokens ?? "?"}+${turn.metrics.outputTokens ?? "?"} tok`).join(", ")}`);
    lines.push("");
  }
  mkdirSync(dirname(resolve(markdown)), { recursive: true });
  writeFileSync(resolve(markdown), lines.join("\n") + "\n");
}
console.log(`\nAlla gater: ${report.allGates ? "PASS" : "FAIL"}`);
process.exitCode = report.allGates ? 0 : 1;
