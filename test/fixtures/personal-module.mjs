// A real local module used to exercise process transport and panel controls.
// All state belongs to the disposable test directory passed by the harness.
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const file = process.argv[2];
let state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { starts: 0 };
state.moduleConfigDir = process.env.CCMCP_MODULE_CONFIG_DIR;
const review = {
  title: "Granskningsunderlag", summary: "Kontrollera uppgifter och källor.",
  verification: { state: "failed", message: "Kontrollen hittade en avvikelse.", checkedAt: "2026-09-28T12:00:00.000Z", issues: ["Ett fält behöver bekräftas."] },
  sections: [{ title: "Uppgifter", items: [
    { label: "Ämne", value: "Eget underlag", status: "confirmed", sources: [{ label: "Källa", quote: '<img src=x onerror="alert(1)">', url: "https://example.com/source" }] },
    { label: "Period", value: "Saknas", status: "missing", sources: [] },
    { label: "Omfattning", value: "Två olika uppgifter", status: "conflict", note: "Behöver klarläggas.", sources: [{ label: "Osäker länk", quote: "Underlag", url: "javascript:alert(1)" }] },
  ] }],
};
const view = () => ({ title: "Personligt testflöde", description: "Lokalt underlag", startLabel: "Skapa underlag",
  fields: [{ name: "subject", label: "Ämne", required: true }], ...(state.run ? { run: state.run } : {}) });
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line), operation = request.operation;
  if (operation === "start") {
    if (!state.run) {
      state.starts++;
      state.run = {
        id: "local-case", status: "waiting", message: "Behöver svar", step: "Väntar på ditt svar",
        updatedAt: "2026-09-28T12:00:00.000Z", question: "Vilken period?", summary: request.input.subject, review,
      };
    }
  }
  if (operation === "reply") {
    state.run.replyReceivedAt = "2026-09-28T12:01:00.000Z";
    state.run.updatedAt = state.run.replyReceivedAt;
    state.run.step = "Kontrollen är klar";
    state.run.review.verification = { state: "passed", message: "Kontrollerat efter omladdning.", checkedAt: state.run.updatedAt, issues: [] };
    state.run.review.sections[0].items.forEach(item => item.status = "confirmed");
    state.run.status = "review";
    state.run.message = "Klar för granskning";
    state.run.summary += ` · ${request.input.answer}`;
    delete state.run.question;
  }
  if (operation === "stop") {
    state.run.status = "paused";
    state.run.message = "Stoppad";
    state.run.canResume = true;
    delete state.run.question;
  }
  if (operation !== "status") writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  // A status with `contract` shows the archive and mail-start fields, valid or naming a field the form lacks.
  const contract = request.input?.contract;
  const result = !contract ? view() : { ...view(), run: { ...(state.run || { id: "local-case", status: "running", message: "Arbetar" }), stopAndArchive: true, archiveBlocked: "Publiceringen pågår." },
    mailStart: { label: "Skapa underlag", mailField: contract === "valid" || contract === "same" || contract === "cleared" ? "subject" : "missing", ...(contract === "same" ? { accountField: "subject" } : {}), ...(contract === "cleared" ? { clearFields: ["subject"] } : {}), keywords: ["förfrågan"], providers: ["zoho", "outlook"] },
    mailRuns: [{ link: "https://mail.zoho.eu/zm/#mail/folder/inbox/p/1", runId: "local-case", label: "Arbetar", handled: false }] };
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
});
input.on("close", () => process.exit(0));
