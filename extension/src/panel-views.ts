import type { PanelRun, PanelSnapshot, PanelLoopPause, PanelStore } from "../../shared/control-panel";
import type { RunRecord } from "../../shared/run-record";

const storeNames: Record<PanelStore, string> = { checkpoints: "kontrollpunkter", incidents: "timeoutpaket" };


const statusText = {
  running: "Arbetar",
  stopping: "Stoppar efter pågående steg",
  succeeded: "Klar",
  failed: "Misslyckades",
  cancelled: "Stoppad",
};

const stages: Record<string, string> = {
  preflight: "Validerar",
  resolve: "Hittar klickmål",
  dispatch: "Utför",
  expect: "Kontrollerar resultat",
  artifact: "Sparar resultat",
  complete: "Klart",
};

export const active = (run: PanelRun) => run.status === "running" || run.status === "stopping";

export const duration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;


export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const result = document.createElement(tag);
  result.textContent = text;
  result.className = className;
  return result;
}


function renderRunSteps(run: PanelRun) {
  const detail = node("details");
  detail.dataset.runId = run.runId;
  const list = node("ol", "", "steps");
  detail.append(node("summary", "Visa stegresultat"));
  for (const step of run.steps) {
    const item = node("li", step.tool);
    item.value = step.index;
    item.append(node(
      "span",
      `${statusText[step.status]} · ${duration(step.durationMs)} · ${stages[step.stage ?? ""] ?? step.stage ?? ""}`,
      "step-detail",
    ));
    list.append(item);
  }
  detail.append(list);
  return detail;
}


function renderRun(run: PanelRun, tabName: (id?: number) => string, stopButton: (run: PanelRun) => HTMLButtonElement) {
  const article = node("article", "", "run");
  const heading = node("div", "", "run-heading");
  const time = node("time", duration(run.durationMs));
  if (active(run)) time.dataset.started = run.startedAt;
  heading.append(node("h3", run.name), time);
  article.append(heading, node("p", statusText[run.status], `run-status${run.status === "failed" ? " error" : ""}`));
  article.append(node(
    "p",
    active(run)
      ? `Steg ${run.currentStep} av ${run.totalSteps} · ${stages[run.stage] ?? run.stage}`
      : `${run.completedSteps} av ${run.totalSteps} steg klara`,
    "muted",
  ));
  if (run.tool) {
    article.append(node("p", `${run.tool}${run.tabId !== undefined ? ` · ${tabName(run.tabId)}` : ""}`, "muted"));
  }
  if (run.failedStep) {
    article.append(node("p", `${run.status === "cancelled" ? "Stopp före eller under" : "Fel i"} steg ${run.failedStep}.`, "muted"));
  }
  if (run.historySaved === false) {
    article.append(node("p", "Körningen är avslutad men kunde inte sparas i historiken.", "notice error"));
  }
  if (run.steps.length) article.append(renderRunSteps(run));
  if (active(run)) article.append(stopButton(run));
  return article;
}


export interface DebugActions { image: (runId: string) => void; incident: (incidentId: string) => void }
function debugButton(label: string, action: () => void, focusKey?: string) {
  const button = node("button", label); button.type = "button";
  if (focusKey) button.dataset.focusKey = focusKey;
  button.addEventListener("click", action); return button;
}
export function renderHistoryRecord(record: RunRecord, debug?: DebugActions) {
  const details = node("details");
  details.dataset.runId = record.runId;
  const summary = node(
    "summary",
    `${statusText[record.status]} · ${new Date(record.startedAt).toLocaleString("sv-SE")} · ${duration(record.durationMs)}`,
  );
  const list = node("ol", "", "steps");
  for (const step of record.steps) {
    const item = node("li", step.tool);
    item.value = step.index;
    item.append(node(
      "span",
      `${statusText[step.status]} · ${duration(step.durationMs)}${step.stage ? ` · ${stages[step.stage] ?? step.stage}` : ""}`,
      "step-detail",
    ));
    list.append(item);
    if (step.error) item.append(node("span", `Felklass: ${step.error}`, "step-detail"));
    if (step.incidentId && debug) item.append(debugButton("Visa stegets timeoutpaket", () => debug.incident(step.incidentId!)));
  }
  details.append(
    summary,
    node(
      "p",
      `${record.completedSteps} av ${record.totalSteps} steg klara${record.failedStep ? ` · ${record.status === "cancelled" ? "Stopp vid" : "Fel i"} steg ${record.failedStep}` : ""}`,
      "muted",
    ),
    list,
  );
  if (record.screenshot) {
    if (debug) details.append(debugButton("Visa sparad felbild", () => debug.image(record.runId)));
    else details.append(node("p", "Starta om MCP-servern med aktuell build för att visa den sparade felbilden här.", "muted"));
  }
  details.append(node("p", `Körnings-ID: ${record.runId}`, "muted"));
  return details;
}
export function renderActivityItems(snapshot: PanelSnapshot, connected: boolean, tabName: (id?: number) => string, stopButton: (run: PanelRun) => HTMLButtonElement, debug?: DebugActions, continueLoop?: (pause: PanelLoopPause) => void): HTMLElement[] {
  const items: HTMLElement[] = [];
  if (!connected) items.push(node("p", "Välj en ansluten session för att se dess arbete.", "muted"));
  else {
    for (const pause of snapshot.loopPauses ?? []) {
      const warning = node("article", "", "notice error");
      warning.append(node("h3", "Loopvakt: kontrollera sidan"), node("p", `${pause.repetitions} likadana åtgärder (${pause.tool}) utan observerad sidförändring i ${tabName(pause.tabId)}. Nästa inmatning eller klick stoppades före utskick. Läsning är fortfarande tillåten.`),
        node("p", "Kontrollera resultatet i fliken. Fortsättning släpper spärren; den upprepar ingen åtgärd och startar inget avbrutet recept."));
      if (continueLoop) warning.append(debugButton("Fortsätt efter kontroll", () => continueLoop(pause), `loop:${pause.pauseId}`));
      items.push(warning);
    }
    for (const run of [...snapshot.runs.filter(active), ...snapshot.runs.filter(run => !active(run)).slice(0, 5)]) {
      items.push(renderRun(run, tabName, stopButton));
    }
    if (!snapshot.runs.some(active)) {
      for (const call of snapshot.calls) {
        const item = node("article", "", "run"), time = node("time", "", "muted");
        time.dataset.started = new Date(call.startedAt).toISOString();
        item.append(node("h3", call.tool), node("p", tabName(call.tabId), "muted"), time);
        items.unshift(item);
      }
      if (!snapshot.calls.length && !snapshot.loopPauses?.length) items.unshift(node("p", "Sessionen är redo.", "muted"));
    }
    if (snapshot.lastError) items.push(node("p", `Senaste verktygsfel: ${snapshot.lastError.tool} (${snapshot.lastError.error}).`, "notice error"));
    if (snapshot.storeErrors?.length) {
      const names = snapshot.storeErrors.map(store => storeNames[store]).join(" och ");
      items.push(node("p", `Kunde inte läsa sparade ${names}. Den lokala filen är skadad eller oläslig, så listan visas tom. Pågående körningar och Stopp påverkas inte.`, "notice error"));
    }
    if (snapshot.diagnostics) {
      const diagnostics = snapshot.diagnostics;
      const detail = node("details", "", "run");
      detail.dataset.runId = "diagnostics";
      detail.append(node("summary", "Teknisk diagnostik"));
      const build = (label: string, id?: string) => {
        const item = node("p", `${label}: ${id ?? "okänd build"}`, "muted diagnostic-build");
        item.style.overflowWrap = "anywhere";
        return item;
      };
      detail.append(build("Server", diagnostics.serverBuildId), build("Broker", diagnostics.brokerBuildId), build("Tillägg", diagnostics.extensionBuildId));
      if (diagnostics.refresh?.length) detail.append(node("p", `Avviker från servern eller saknar byggstatus: ${diagnostics.refresh.map(peer => peer === "broker" ? "broker (starta om)" : "tillägg (ladda om)").join(", ")}. Använd samma avsedda build för alla tre; starta även om MCP-servern om den är äldre.`, "notice error"));
      if (!diagnostics.available) detail.append(node("p", "Tilläggets diagnostik är inte tillgänglig. Kontrollera anslutningen och den laddade versionen.", "notice"));
      if (diagnostics.operations?.degraded) items.push(node("p", "Sidans statusmarkering väntar på Chrome. Verktygen fortsätter; bildfångst kräver fortfarande säker döljning.", "notice"));
      const operations = diagnostics.operations;
      if (operations) {
        const list = node("ul", "", "steps");
        for (const entry of [...operations.active, ...operations.recent].slice(0, 12)) {
          const status = entry.status === "overdue" ? "Väntar över kosmetisk tidsgräns" : entry.status === "pending" ? "Pågår" : entry.status === "failed" ? "Misslyckades" : "Klar";
          list.append(node("li", `${entry.operation} · ${status} · ${entry.durationMs} ms${entry.tabId === undefined ? "" : ` · flik ${entry.tabId}`}${entry.errorCode ? ` · ${entry.errorCode}` : ""}`));
        }
        if (!list.children.length) detail.append(node("p", "Inga observerade Chrome-operationer ännu.", "muted"));
        else detail.append(list);
        if (operations.dropped) detail.append(node("p", `${operations.dropped} diagnostikposter utelämnades vid kapacitetsgränsen. Verktygen kördes ändå.`, "muted"));
      }
      for (const incident of snapshot.incidents ?? []) {
        detail.append(node("p", `Sparat timeoutpaket (lokal diagnostik): ${incident.tool} · ${new Date(incident.capturedAt).toLocaleString("sv-SE")}${incident.diagnosticsAvailable ? "" : " · Chrome-diagnostik otillgänglig"}.`, "muted"));
        if (debug) detail.append(debugButton("Visa timeoutpaket", () => debug.incident(incident.incidentId), `incident:${incident.incidentId}`));
      }
      items.push(detail);
    }
  }
  return items;
}
