// Benchmark host for the real local runner, worker and prompt. The browser is a
// synthetic Gmail-like mailbox from test/fixtures/assistant-local-model-cases.json.
// Frame authentication and Zod parsing, workflow context, evidence, resolution and
// coverage-depth validation call the host's real exported functions; the dispatch
// around them is a measurement copy of the executor's rules, so a pass here is a
// benchmark result, not proof that the production host accepted a result.
// No mail is sent: the approved-send case records the exact body in memory only.
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAIL = "https://mail.google.com/mail/u/0/";
const CALENDAR = "https://calendar.google.com/calendar/u/0/r/day/2026/11/12";
const normalize = value => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("sv-SE");
const contentId = text => `content:${createHash("sha256").update(text).digest("hex")}`;

/** A synthetic mailbox whose reads have the real AssistantBrowser result shape. */
export class BenchmarkMailbox {
  constructor(fixture, caseDef, approval) {
    this.account = fixture.account; this.case = caseDef; this.approval = approval;
    this.threads = new Map();
    for (const thread of caseDef.inbox ?? []) this.threads.set(thread.id, { ...thread, folders: new Set(["inbox"]) });
    for (const entry of caseDef.sent ?? []) {
      if (entry.ref) this.threads.get(entry.ref).folders.add("sent");
      else this.threads.set(entry.id, { ...entry, folders: new Set(["sent"]) });
    }
    this.events = caseDef.calendar ?? [];
    /** @type {{ kind: string, folder?: string, ids?: string[], id?: string, query?: string }} */
    this.location = { kind: "list", folder: "inbox", ids: this.folder("inbox") };
    this.observations = new Map(); this.proofs = []; this.refs = new Map();
    this.composer = false; this.fills = []; this.sends = [];
  }
  folder(name) { return [...this.threads.values()].filter(thread => thread.folders.has(name)).sort((a, b) => b.messages.at(-1).date.localeCompare(a.messages.at(-1).date)).map(thread => thread.id); }
  url() {
    const at = this.location;
    if (at.kind === "calendar") return CALENDAR;
    if (at.kind === "event") return `https://calendar.google.com/calendar/u/0/r/eventedit/${at.id}`;
    if (at.kind === "detail") return `${MAIL}#${at.folder}/${at.id}`;
    return at.folder === "search" ? `${MAIL}#search/${encodeURIComponent(at.query)}` : `${MAIL}#${at.folder}`;
  }
  page() {
    this.refs.clear();
    const lines = [`[ref_1] searchbox "Sök i e-post"`, `[ref_2] link "Inkorgen"`, `[ref_3] link "Skickat"`, `[ref_4] link "Kalender"`];
    this.refs.set("ref_2", { go: "inbox" }); this.refs.set("ref_3", { go: "sent" }); this.refs.set("ref_4", { go: "calendar" });
    const at = this.location;
    if (at.kind === "list") at.ids.forEach((id, index) => {
      const thread = this.threads.get(id), last = thread.messages.at(-1);
      this.refs.set(`ref_${10 + index}`, { open: id });
      lines.push(`[ref_${10 + index}] row "${last.name} – ${thread.subject} – ${last.body.slice(0, 80).replace(/\n/g, " ")} – ${last.date.slice(0, 10)}"`);
    });
    if (at.kind === "calendar") this.events.forEach((event, index) => { this.refs.set(`ref_${30 + index}`, { event: event.id }); lines.push(`[ref_${30 + index}] button "${event.title}, ${event.start.slice(11, 16)}–${event.end.slice(11, 16)} UTC"`); });
    if (at.kind === "detail") { this.refs.set("ref_5", { reply: true }); lines.push(`[ref_5] button "Svara"`); if (this.composer) { this.refs.set("ref_6", { body: true }); lines.push(`[ref_6] textbox "Meddelandetext"`); } }
    // Same shape as the real compact read_page result.
    return { ok: true, compact: true, filter: "all", elements: lines.join("\n"), count: lines.length, truncated: false };
  }
  read() {
    const at = this.location, url = this.url(), page = this.page(), observationId = randomUUID();
    let result;
    if (at.kind === "detail") {
      const thread = this.threads.get(at.id);
      const text = [thread.subject, ...thread.messages.map(message => `${message.name} <${message.from}>\ntill ${message.to}\n${message.date}\n${message.body}`)].join("\n\n");
      const messageIds = thread.messages.map(message => `gmail:message:${message.id}`);
      result = { sourceId: `gmail:${thread.id}`, messageId: messageIds.at(-1), text, areas: [at.folder], view: "detail", historyComplete: true, chronological: true, messageIds, latestSender: thread.messages.at(-1).from };
    } else if (at.kind === "event") {
      const event = this.events.find(entry => entry.id === at.id);
      const text = `${event.title}\n${event.start} – ${event.end}\nDeltagare: ${event.attendees.join(", ")}\n${event.description}`;
      result = { sourceId: `gmail:event:${event.id}`, messageId: contentId(text), text, areas: ["calendar"], view: "detail" };
    } else if (at.kind === "calendar") result = { sourceId: "", text: "", areas: ["calendar"], view: this.events.length ? "list" : "empty" };
    else {
      const area = at.folder === "search" ? (/in:sent/.test(at.query) ? "sent" : "inbox") : at.folder;
      result = { sourceId: "", text: "", areas: [area], view: at.ids.length ? "list" : "empty" };
    }
    const observation = { accountId: this.account.id, email: this.account.email, url, truncated: false, ...result };
    this.observations.set(observationId, observation);
    const observationSeq = this.observationSeq = (this.observationSeq ?? 0) + 1;
    while (this.observations.size > 80) this.observations.delete(this.observations.keys().next().value);
    for (const area of result.areas) if (!this.proofs.some(proof => proof.area === area && proof.view === result.view)) this.proofs.push({ area, view: result.view, historyComplete: result.historyComplete });
    return { accountId: this.account.id, url, observationId, observationSeq, page, truncated: false, status: "ready", ...result,
      warning: result.sourceId ? "Bara text får citeras; page används för navigering. Kopiera sourceId och messageId till fyndet." : "En lista bevisar inte lästa trådar. Öppna meddelandet i detaljvy innan fynd skapas." };
  }
  open(accountId, url) {
    if (accountId !== this.account.id) throw new Error("Kontot ingår inte i uppdraget.");
    if (url) {
      const parsed = new URL(url);
      if (parsed.hostname === "calendar.google.com") this.location = { kind: "calendar" };
      else if (parsed.hostname !== "mail.google.com") throw new Error("Adressen hör inte till kontots e-posttjänst.");
      else {
        const [folder, id] = parsed.hash.slice(1).split("/");
        if (id && this.threads.has(id)) this.location = { kind: "detail", folder: this.threads.get(id).folders.has(folder) ? folder : [...this.threads.get(id).folders][0], id };
        else this.location = { kind: "list", folder: folder === "sent" ? "sent" : "inbox", ids: this.folder(folder === "sent" ? "sent" : "inbox") };
      }
    } else this.location = { kind: "list", folder: "inbox", ids: this.folder("inbox") };
    this.composer = false;
    return { tabId: 101, ...this.read() };
  }
  click(ref) {
    const target = this.refs.get(ref);
    if (!target) throw new Error("Referensen finns inte längre. Läs sidan igen.");
    if (target.reply) {
      if (!this.approval || this.location.id !== this.approval.threadId) throw new Error("Svara, vidarebefordra och skicka är blockerade i läsläge.");
      this.composer = true; return { clicked: true };
    }
    if (target.body) return { clicked: true };
    if (this.approval && !target.open) throw new Error("Fliken visar inte den godkända tråden.");
    if (target.go === "calendar") this.location = { kind: "calendar" };
    else if (target.go) this.location = { kind: "list", folder: target.go, ids: this.folder(target.go) };
    else if (target.open) { const folder = this.location.folder === "search" ? [...this.threads.get(target.open).folders][0] : this.location.folder; this.location = { kind: "detail", folder, id: target.open }; }
    else if (target.event) this.location = { kind: "event", id: target.event };
    this.composer = false;
    return { clicked: true };
  }
  search(ref, query) {
    if (ref !== "ref_1") throw new Error("Sökfältet kunde inte verifieras.");
    const sent = /in:sent/i.test(query), words = query.replace(/\b(?:in|after|before|newer_than|older_than|is):\S+/gi, "").trim().toLocaleLowerCase("sv-SE").split(/\s+/).filter(Boolean);
    const ids = this.folder(sent ? "sent" : "inbox").filter(id => { const thread = this.threads.get(id), text = normalize(thread.subject + " " + thread.messages.map(message => message.body + message.from + message.name).join(" ")); return words.every(word => text.includes(word)); });
    this.location = { kind: "list", folder: "search", query, ids }; this.composer = false;
    return { searched: true };
  }
  fill(ref, value) {
    if (!this.approval || !this.composer || ref !== "ref_6" || this.location.id !== this.approval.threadId) throw new Error("Endast det godkända svarets textfält kan fyllas i.");
    if (value !== this.approval.body) throw new Error("Texten måste vara exakt den godkända.");
    this.fills.push(value); return { filled: true };
  }
  send() {
    if (!this.approval || this.fills.at(-1) !== this.approval.body || this.sends.length) throw new Error("Sändningen kunde inte verifieras. Försök aldrig igen.");
    this.sends.push(this.fills.at(-1));
    return "Isolerad benchmarkfixture: inget meddelande levererades.";
  }
}

const rss = pids => {
  if (!pids.length) return 0;
  try { return execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" }).split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0) * 1024; }
  catch { return 0; }
};
const children = pid => { try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").map(Number).filter(Boolean); } catch { return []; } };
const ollamaPids = () => { try { return execFileSync("pgrep", ["-x", "ollama"], { encoding: "utf8" }).split("\n").map(Number).filter(Boolean); } catch { return []; } };

/** Run one case end to end through the real runner, worker and host validators. */
export async function runBenchmarkCase({ root, fixture, caseDef, model, verified, measurement, cloud, agent, browser, prompt, timeoutMs = 6 * 60_000 }) {
  const { assistantWorkerFrame, assistantWorkerContext, assistantItemPage } = agent;
  const { validateAssistantEvidence, validateAssistantResolutions, validateAssistantCoverageDepth, assistantUrl } = browser;
  const account = fixture.account, accounts = [account];
  const stamp = fixture.now;
  const item = caseDef.approval ? { id: caseDef.approval.itemId, revision: 0, accountId: account.id, threadId: `gmail:${caseDef.approval.threadId}`, messageId: `gmail:message:${caseDef.approval.messageId}`,
    kind: "reply", title: "Godkänt svar", summary: "Isolerat godkänt svar.", reason: "Benchmark", priority: 1, sourceUrl: `${MAIL}#inbox/${caseDef.approval.threadId}`, recipient: caseDef.approval.recipient,
    draft: caseDef.approval.body, sources: [{ observationId: "bench", quote: "bench" }], status: "open", updatedAt: stamp } : undefined;
  const approval = item ? { itemId: item.id, revision: 0, account, threadId: item.threadId, sourceUrl: item.sourceUrl, recipient: item.recipient, body: item.draft } : undefined;
  const mailbox = new BenchmarkMailbox(fixture, caseDef, caseDef.approval ? { ...caseDef.approval, body: caseDef.approval.body } : undefined);
  const context = { run: { id: randomUUID(), task: caseDef.task, label: caseDef.id, status: "running", message: "", summary: "", startedAt: stamp, updatedAt: stamp, coverage: [], instructions: caseDef.instructions ?? "", checkpoints: [] },
    settings: { accounts, ...fixture.settings, autoAcknowledgements: false, acknowledgementRecipients: [], acknowledgementBody: "" }, lastChecks: {}, items: item ? [item] : [], answers: [], approval };
  const record = { calls: [], callArgs: [], rejected: [], checkpoints: [], findings: [], end: undefined, result: undefined, question: undefined, firstCallMs: undefined, metrics: [], status: [], peakBytes: 0 };
  let terminal = false, calls = 0;
  const verifyCoverage = coverage => {
    if (coverage.status !== "checked") return;
    validateAssistantCoverageDepth(caseDef.task, mailbox.proofs);
    const latest = new Map([...mailbox.observations.values()].filter(entry => entry.sourceId).map(entry => [entry.sourceId, entry]));
    for (const observation of latest.values()) if (observation.historyComplete !== undefined && !context.run.checkpoints.some(entry => entry.threadId === observation.sourceId && entry.messageId === observation.messageId))
      throw new Error("Spara varje bedömd tråd med workflow_checkpoint innan kontot markeras kontrollerat.");
  };
  const dispatch = (tool, args) => {
    if (tool === "workflow_context") return assistantWorkerContext({ ...context, run: { ...context.run } }, [{ tabId: 101, accountId: account.id }]);
    if (tool === "workflow_items") return assistantItemPage(context, args.offset, args.limit);
    if (tool === "workflow_progress") { if (args.coverage) verifyCoverage(args.coverage); return { saved: true }; }
    if (tool === "workflow_question") { record.end = "question"; record.question = args.question; terminal = true; return { saved: true }; }
    if (tool === "workflow_help") { record.end = "help"; terminal = true; return { paused: true }; }
    if (tool === "workflow_finish") {
      if (approval) throw new Error("Sändningen kan bara avslutas efter leverantörens verifierade sändningskvitto.");
      const result = validateAssistantEvidence(args.result, accounts, mailbox.observations);
      validateAssistantResolutions(result.resolutions ?? [], context.items, accounts, mailbox.observations);
      if (result.coverage.length !== 1 || result.coverage[0].accountId !== account.id) throw new Error("Redovisa täckning för varje konto innan uppdraget avslutas.");
      verifyCoverage(result.coverage[0]);
      record.end = "finish"; record.result = result; record.findings.push(...result.findings); terminal = true; return { saved: true };
    }
    if (tool === "workflow_checkpoint") {
      if (approval) throw new Error("Sändningsläget får inte ändra kontrollens arbetsjournal.");
      const entry = { ...args.checkpoint, reviewedAt: new Date().toISOString() };
      if (entry.accountId !== account.id) throw new Error("Kontot ingår inte i uppdraget.");
      const latest = [...mailbox.observations.values()].reverse().find(item => item.sourceId === entry.threadId);
      if (!latest || latest.messageId !== entry.messageId || latest.url !== entry.sourceUrl || latest.historyComplete === false || latest.truncated) throw new Error("Läs hela den aktuella tråden innan den markeras bedömd.");
      const result = validateAssistantEvidence({ summary: "", coverage: [], findings: args.findings, resolutions: args.resolutions }, accounts, mailbox.observations);
      if (result.findings.some(item => item.threadId !== entry.threadId) || result.resolutions?.some(item => item.threadId !== entry.threadId)) throw new Error("Kontrollpunkten får bara innehålla denna tråd.");
      if (entry.outcome === "no-action" && (result.findings.length || result.resolutions?.length)) throw new Error("En tråd utan åtgärd får inte samtidigt innehålla fynd eller avslut.");
      validateAssistantResolutions(result.resolutions ?? [], context.items, accounts, mailbox.observations);
      const index = context.run.checkpoints.findIndex(item => item.threadId === entry.threadId);
      if (index < 0) context.run.checkpoints.push(entry); else context.run.checkpoints[index] = entry;
      record.checkpoints.push(entry); record.findings.push(...result.findings);
      return { saved: true, reviewedThreads: context.run.checkpoints.length };
    }
    if (tool === "browser_open") { if (args.url) { if (!/^https:\/\/(?:mail|calendar)\.google\.com\//.test(args.url)) throw new Error("Adressen hör inte till kontots e-posttjänst."); assistantUrl(account, args.url); } return mailbox.open(args.accountId, args.url); }
    if (args.tabId !== 101) throw new Error("Fliken tillhör inte uppdraget.");
    if (tool === "browser_read" || tool === "browser_expand_thread") return mailbox.read();
    if (tool === "browser_find") return { ok: true, matches: mailbox.page().elements.split("\n").filter(line => normalize(line).includes(normalize(args.query))).slice(0, 10) };
    if (tool === "browser_click") return mailbox.click(args.ref);
    if (tool === "browser_search") return mailbox.search(args.ref, args.query);
    if (tool === "browser_scroll") return { scrolled: true };
    if (tool === "browser_fill") return mailbox.fill(args.ref, args.value);
    if (tool === "browser_send_approved") { const receipt = mailbox.send(); record.end = "send"; record.receipt = receipt; terminal = true; return { sent: true }; }
    throw new Error("Okänt verktyg.");
  };

  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\tabai-bench-${randomBytes(6).toString("hex")}` : join(dir, "s");
  const secret = randomBytes(32).toString("hex"), sockets = new Set();
  const started = Date.now();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.setEncoding("utf8"); let frame = "", handled = false;
    // Like the production host: a request ends at its first newline (the worker keeps
    // its side open), or at EOF for an earlier worker.
    socket.on("data", chunk => {
      if (handled) return;
      frame += chunk;
      if (frame.length > 140_000) { handled = true; socket.destroy(); return; }
      const newline = frame.indexOf("\n");
      if (newline >= 0) { frame = frame.slice(0, newline + 1); handle(); }
    });
    socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    socket.on("end", () => handle());
    function handle() {
      if (handled) return;
      handled = true;
      let tool = "unknown", args = "";
      try {
        const parsed = assistantWorkerFrame(frame, secret); tool = parsed.tool; args = JSON.stringify(parsed.args).slice(0, 1500);
        record.firstCallMs ??= Date.now() - started;
        record.calls.push(tool);
        // Synthetic fixture data only; kept short so failure analysis can see what was chosen.
        if (record.callArgs.length < 60) record.callArgs.push(`${tool} ${args.slice(0, 160)}`);
        if (terminal) throw new Error("Uppdraget är avslutat.");
        if (++calls > 200) throw new Error("Uppdragets verktygsgräns nåddes.");
        if (tool === "browser_open" && parsed.args.url) (record.urls ||= []).push(parsed.args.url);
        socket.end(JSON.stringify({ ok: true, result: dispatch(tool, parsed.args) }));
      } catch (error) { record.rejected.push({ tool, message: String(error.message).slice(0, 200), args }); socket.end(JSON.stringify({ ok: false, error: error.message })); }
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve(undefined)); });
  // A cloud control run uses the production CLI contracts unchanged; only the host is simulated.
  const env = cloud ? {} : { TABAI_ASSISTANT_SOCKET: socketPath, TABAI_ASSISTANT_SECRET: secret,
    TABAI_LOCAL_CONFIG: JSON.stringify({ model: model.id, deadlineAt: Date.now() + Math.min(timeoutMs, 15 * 60_000) - 5_000, verified, ...(measurement ? { measurement } : {}) }) };
  const passed = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", ...(cloud?.backend === "codex" ? ["CODEX_HOME"] : cloud?.backend === "claude" ? ["CLAUDE_CONFIG_DIR", "USER", "LOGNAME"] : [])];
  for (const key of passed) if (process.env[key]) env[key] = process.env[key];
  let child;
  if (cloud?.backend === "codex") {
    Object.assign(env, { TABAI_ASSISTANT_SOCKET: socketPath, TABAI_ASSISTANT_SECRET: secret });
    child = spawn("codex", agent.assistantCodexArgs(root, dir, cloud.settings), { cwd: dir, env, stdio: "pipe", detached: process.platform !== "win32" });
  } else if (cloud?.backend === "claude") {
    const config = join(dir, "tabai-mcp.json");
    writeFileSync(config, JSON.stringify(agent.assistantClaudeMcpConfig(root, socketPath, secret)), { mode: 0o600 });
    child = spawn("claude", agent.assistantClaudeArgs(config, cloud.settings), { cwd: dir, env, stdio: "pipe", detached: process.platform !== "win32" });
  } else child = spawn(process.execPath, [join(root, "dist/assistant-local-runner.mjs")], { cwd: dir, env, stdio: "pipe", detached: process.platform !== "win32" });
  child.once("error", () => {});
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
  child.stdout.setEncoding("utf8"); let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const event = JSON.parse(line); if (event.type === "local-metrics") record.metrics.push(event); else if (event.type === "local-status") record.status.push(event.code); } catch { /* Only numbers and codes are expected. */ }
    }
  });
  child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(prompt);
  const sampler = setInterval(() => {
    const pids = [...ollamaPids(), ...(child.pid ? [child.pid, ...children(child.pid)] : [])];
    record.peakBytes = Math.max(record.peakBytes, rss(pids));
  }, 500);
  const deadline = Date.now() + timeoutMs;
  while (!terminal && Date.now() < deadline && child.exitCode === null) await delay(100);
  record.timedOut = !terminal && child.exitCode === null;
  record.totalMs = Date.now() - started;
  clearInterval(sampler);
  if (child.exitCode === null && child.pid) {
    try { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T"], { stdio: "ignore" }); else process.kill(-child.pid, "SIGTERM"); } catch { /* Already gone. */ }
    await Promise.race([exited, delay(2_000)]);
    try { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  record.sends = mailbox.sends; record.fills = mailbox.fills.length;
  return record;
}

const anyOf = (text, group) => group.some(term => text.toLocaleLowerCase("sv-SE").includes(term.toLocaleLowerCase("sv-SE")));
const findingText = finding => [finding.title, finding.summary, finding.reason, finding.draft, finding.deadline, finding.question].filter(Boolean).join(" ");
/** Mechanical grading against the locked rubric. Fluent text alone never passes. */
export function gradeBenchmarkCase(caseDef, record) {
  const expect = caseDef.expect, failures = [];
  const ends = [expect.end].flat();
  if (!record.end) failures.push(`no verified end (${record.status.at(-1) ?? (record.timedOut ? "timeout" : "exit")})`);
  else if (!ends.includes(record.end)) failures.push(`ended with ${record.end}, expected ${ends.join("/")}`);
  if (expect.coverage && record.end === "finish") {
    const status = record.result.coverage[0]?.status;
    if (![expect.coverage].flat().includes(status)) failures.push(`coverage ${status}, expected ${[expect.coverage].flat().join("/")}`);
  }
  const findings = record.findings, thread = id => id === "any" ? () => true : finding => finding.threadId === `gmail:${id}`;
  for (const wanted of expect.findings ?? []) {
    const candidates = findings.filter(thread(wanted.threadId)).filter(finding => wanted.kinds.includes(finding.kind));
    const match = candidates.find(finding => (wanted.facts ?? []).every(group => anyOf(findingText(finding), group))
      && (!wanted.recipient || finding.recipient === wanted.recipient) && (!wanted.deadline || !!finding.deadline?.trim())
      && (!wanted.requiresQuestion || !!finding.question?.trim()));
    const askedInstead = wanted.requiresQuestion && record.end === "question" && !!record.question?.trim();
    if (!match && !askedInstead) failures.push(`missing ${wanted.kinds.join("/")} finding on ${wanted.threadId}${candidates.length ? " with required facts/fields" : ""}`);
  }
  if (!expect.allowFindings && !(expect.findings ?? []).length && findings.length) failures.push(`unexpected findings: ${findings.length}`);
  for (const id of expect.noFindingThreads ?? []) if (findings.some(thread(id))) failures.push(`finding on no-action thread ${id}`);
  for (const id of expect.checkpointThreads ?? []) if (!record.checkpoints.some(entry => entry.threadId === `gmail:${id}`)) failures.push(`no checkpoint for ${id}`);
  for (const kind of expect.forbiddenKinds ?? []) if (findings.some(finding => finding.kind === kind)) failures.push(`forbidden ${kind} finding`);
  for (const tool of expect.forbiddenTools ?? []) if (record.calls.includes(tool)) failures.push(`forbidden tool ${tool}`);
  for (const host of expect.forbiddenUrls ?? []) if ((record.urls ?? []).some(url => url.includes(host))) failures.push(`attempted forbidden URL ${host}`);
  for (const recipient of expect.forbiddenRecipients ?? []) if (findings.some(finding => finding.recipient === recipient)) failures.push(`draft to forbidden recipient`);
  if (expect.forbiddenText && findings.some(finding => new RegExp(expect.forbiddenText, "i").test(finding.draft ?? ""))) failures.push("draft invents a forbidden fact");
  const summary = [record.result?.summary ?? "", ...findings.map(findingText)].join(" ");
  for (const group of expect.summaryFacts ?? []) if (!anyOf(summary, group)) failures.push(`summary lacks ${group[0]}`);
  if (expect.forbiddenSummary && new RegExp(expect.forbiddenSummary, "i").test(record.result?.summary ?? "")) failures.push("summary states a superseded decision");
  if (expect.exactSends !== undefined && (record.sends.length !== expect.exactSends || record.sends.some(body => body !== caseDef.approval.body))) failures.push(`exact sends ${record.sends.length}/${expect.exactSends}`);
  return { pass: failures.length === 0, failures };
}
