// First import: switches zod's string evaluation off before any schema is built.
import "./zod-no-eval";
import { createPanelClient } from "./panel-client";
import { active, duration, node, renderActivityItems, renderHistoryRecord } from "./panel-views";
import { renderParameterFields, collectParameters } from "./recipe-form";
import type {
  PanelCommand,
  PanelRecipe,
  PanelReply,
  PanelRun,
  PanelSession,
  PanelSnapshot,
  PanelLoopPause,
} from "../../shared/control-panel";
import type { RunRecord } from "../../shared/run-record";
import { groupTitle } from "./tab-group-helpers";
import { flushAssistantDrafts } from "./personal-modules";
import { createPanelDebugging } from "./panel-debugging";
import { initAppearance } from "./panel-appearance";
import { createRecipeRecordingView } from './recipe-recording-view';

// Apply the saved palette before the first poll paints the panel contents.
initAppearance();

const request = createPanelClient<PanelCommand>({ missingReplyMessage: "Panelen fick inget svar. Återanslut via inställningarna." });

type Tab = { tabId: number; title?: string; url?: string; active?: boolean };
type View = "activity" | "recipes" | "history";
type SelectOption = { value: string; label: string };

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sessionSelect = el<HTMLSelectElement>("session");
const recipeSelect = el<HTMLSelectElement>("recipe");
const tabSelect = el<HTMLSelectElement>("target-tab");
const startButton = el<HTMLButtonElement>("start");
const resumeSelect = el<HTMLSelectElement>("resume-checkpoint");

let sessionId = "";
let initial = true;
let connected = false;
let polling = false;
// A poll asked for while one runs (a session switch) runs right after it instead of being dropped.
let pollAgain = false;
let recipesFailed = false, recipesLoading = false;
let starting = false;
let awaitingStatus = false;
let generation = 0;
let view: View = "activity";
let recipes: PanelRecipe[] = [];
let tabs: Tab[] = [];
let snapshot: PanelSnapshot = { runs: [], calls: [] };
let recordingSnapshotEpoch = 0;
let activityKey = "";
const debugging = createPanelDebugging(request, () => sessionId, () => connected);
const recording = createRecipeRecordingView(request, loadRecipes);
el('recording-root').append(recording.element);

function message(id: string, text = "") {
  const target = el(id);
  target.textContent = text;
  target.hidden = !text;
}
function options(select: HTMLSelectElement, values: SelectOption[], selected: string) {
  const key = JSON.stringify(values);
  if (select.dataset.options !== key) {
    select.replaceChildren(...values.map(item => new Option(item.label, item.value)));
    select.dataset.options = key;
  }
  select.value = selected;
}

function clearSession() {
  debugging.close();
  generation++;
  connected = false;
  awaitingStatus = false;
  snapshot = { runs: [], calls: [] };
  recipes = [];
  tabs = [];
  activityKey = "";
  el("recipe-form").hidden = true;
  el("history-list").replaceChildren(node("p", "Välj en ansluten session för att läsa historiken.", "muted"));
  message("recipes-message", "Välj en ansluten session för att läsa recepten.");
  // The previous session's "Ansluten" must not stand for the new one until a poll confirms it.
  el("connection").textContent = "Ansluter till vald session…";
  recipesFailed = false;
  message("form-error");
  message("stop-feedback");
  renderActivity();
}

function updateStart() {
  const busy = snapshot.runs.some(active) || snapshot.calls.length > 0;
  recording.update(sessionId, connected, snapshot.recording, tabs, busy, recordingSnapshotEpoch);
  startButton.disabled = starting || awaitingStatus || !connected || busy || !tabs.length || !recipes.length;
  el("start-help").textContent = !connected ? "Sessionen är inte ansluten." : awaitingStatus ? "Hämtar aktuell körstatus innan en ny start tillåts." : busy ? "Sessionen arbetar. Du kan starta när den är redo." : !tabs.length ? "Be agenten öppna en Tabai-flik i den här sessionen först." : "Receptets åtgärder utförs i webbläsaren när du startar.";
  startButton.textContent = resumeSelect.value ? "Återuppta efter kontrollpunkt" : "Starta recept";
  // A resumable start must write a checkpoint, which an unreadable store refuses.
  el<HTMLInputElement>("resumable").disabled = !!resumeSelect.value || !snapshot.checkpoints || !!snapshot.storeErrors?.includes("checkpoints");
}
function renderCheckpoints() {
  const checkpoints = snapshot.checkpoints?.filter(item => item.name === recipeSelect.value) ?? [];
  const ready = checkpoints.filter(item => item.resumable);
  const selected = ready.some(item => item.resumeId === resumeSelect.value) ? resumeSelect.value : "";
  options(resumeSelect, [{ value: "", label: "Ny körning" }, ...ready.map(item => ({ value: item.resumeId,
    label: `Fortsätt efter steg ${item.completedSteps} av ${item.totalSteps} · ${new Date(item.updatedAt).toLocaleString("sv-SE")}`,
  }))], selected);
  const blocked = checkpoints.filter(item => !item.resumable && item.phase !== "complete").length;
  el("checkpoint-help").textContent = `${blocked ? `${blocked} körning(ar) saknar säker fortsättningspunkt eller arbetar fortfarande. ` : ""}Återupptagning kräver samma parametrar och verifierar sidan. Åtgärder med oklart utfall upprepas aldrig.`;
}
function tabName(id?: number) {
  if (id === undefined) return "";
  return tabs.find(tab => tab.tabId === id)?.title || `Flik ${id}`;
}

function stopButton(run: PanelRun) {
  const stop = node("button", run.status === "stopping" ? "Stopp begärt" : "Stoppa efter pågående steg");
  stop.type = "button";
  stop.disabled = run.status === "stopping";
  stop.dataset.runId = run.runId;
  stop.dataset.focusKey = `run:${run.runId}`;
  stop.addEventListener("click", async () => {
    stop.disabled = true;
    const at = generation;
    try {
      const result = await request<{ requested: boolean }>({ action: "stop", sessionId, runId: run.runId });
      if (at === generation) {
        message("stop-feedback", result.requested
          ? "Stopp begärt. Det pågående steget får slutföras."
          : "Körningen har redan avslutats.");
      }
    } catch (error) {
      if (at === generation) {
        message("stop-feedback", String(error));
        stop.disabled = false;
      }
    }
    void poll();
  });
  return stop;
}

function renderActivity() {
  const key = JSON.stringify({ snapshot, connected, tabs });
  if (key === activityKey) { updateStart(); return; }
  activityKey = key;
  const items = renderActivityItems(snapshot, connected, tabName, stopButton, snapshot.debugging ? debugging : undefined, continueLoop);
  const openDetails = new Set([...el("activity").querySelectorAll<HTMLDetailsElement>("details[open]")].map(detail => detail.dataset.runId));
  const focusedKey = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.focusKey : undefined;
  el("activity").replaceChildren(...items);
  el("activity").querySelectorAll<HTMLDetailsElement>("details").forEach(detail => { detail.open = openDetails.has(detail.dataset.runId); });
  if (focusedKey) el("activity").querySelector<HTMLButtonElement>(`button[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
  updateStart();
  tick();
}

async function continueLoop(pause: PanelLoopPause) {
  const at = generation;
  try {
    const result = await request<{ continued: boolean }>({ action: "continue-loop", sessionId, tabId: pause.tabId, pauseId: pause.pauseId });
    if (at === generation) message("stop-feedback", result.continued ? "Spärren är släppt. Ingen åtgärd har upprepats." : "Spärren har ändrats. Hämta aktuell status och kontrollera sidan.");
  } catch (error) { if (at === generation) message("stop-feedback", String(error)); }
  void poll();
}

function tick() {
  document.querySelectorAll<HTMLElement>("[data-started]").forEach(item => item.textContent = duration(Math.max(0, Date.now() - Date.parse(item.dataset.started!))));
}

function renderParameters() {
  const recipe = recipes.find(item => item.name === recipeSelect.value);
  const fields = el("parameter-fields");
  fields.replaceChildren();
  message("form-error");
  el("recipe-description").textContent = recipe ? `${recipe.steps} steg${recipe.description ? ` · ${recipe.description}` : ""}` : "";
  el("parameters").hidden = !recipe || !Object.keys(recipe.parameters).length;
  renderParameterFields(recipe, fields);
  renderCheckpoints();
  updateStart();
}

async function loadRecipes() {
  if (!connected || recipesLoading) return;
  recipesLoading = true;
  try { await readRecipes(); } finally { recipesLoading = false; }
}
async function readRecipes() {
  const at = generation;
  message("recipes-message", "Hämtar recept…");
  try {
    const result = await request<{ recipes: PanelRecipe[]; total: number }>({ action: "recipes", sessionId });
    if (at !== generation) return;
    const previous = recipes.find(recipe => recipe.name === recipeSelect.value);
    recipes = result.recipes;
    const selected = recipes.some(recipe => recipe.name === recipeSelect.value)
      ? recipeSelect.value
      : recipes[0]?.name ?? "";
    options(recipeSelect, recipes.map(recipe => ({ value: recipe.name, label: recipe.name })), selected);
    el("recipe-form").hidden = !recipes.length;
    recipesFailed = false;
    message("recipes-message", !recipes.length ? "Inga sparade recept. Be agenten spara ett arbetsflöde med recipe_save." : result.total > recipes.length ? `Visar ${recipes.length} av ${result.total} recept.` : "");
    if (JSON.stringify(previous) !== JSON.stringify(recipes.find(recipe => recipe.name === selected))) renderParameters();
    else updateStart();
  } catch (error) {
    // The next poll tries again, so a slow answer does not leave the list empty until a manual refresh.
    if (at === generation) { recipesFailed = true; message("recipes-message", `Kunde inte läsa recepten. ${String(error)}`); }
  }
}

async function loadHistory() {
  if (!connected) return;
  const at = generation;
  el("history-list").replaceChildren(node("p", "Hämtar historik…", "muted"));
  try {
    const records = await request<RunRecord[]>({ action: "history", sessionId });
    if (at !== generation) return;
    el("history-list").replaceChildren(...records.map(record => renderHistoryRecord(record, snapshot.debugging ? debugging : undefined)));
    if (!records.length) el("history-list").append(node("p", "Inga körningar ännu. Starta ett sparat recept eller låt agenten köra ett arbetsflöde.", "muted"));
  } catch (error) {
    if (at === generation) {
      el("history-list").replaceChildren(node("p", `Kunde inte läsa historiken. ${String(error)}`, "notice error"));
    }
  }
}
async function poll() {
  if (polling) { pollAgain = true; return; }
  polling = true;
  const at = generation;
  try {
    const sessions = await request<PanelSession[]>({ action: "sessions" });
    if (at !== generation) return;
    if (initial && sessions.length) {
      sessionId = sessions.find(session => session.supported)?.sessionId ?? sessions[0].sessionId;
      initial = false;
    }
    const current = sessions.find(session => session.sessionId === sessionId);
    const values = sessions.map(session => ({
      value: session.sessionId,
      label: `${groupTitle(session.sessionId, session.sessionName)}${session.supported ? "" : " (uppdatera servern)"}`,
    }));
    values.unshift({ value: "", label: sessions.length ? "Välj session" : "Ingen ansluten session" });
    if (sessionId && !current) values.push({ value: sessionId, label: "Sessionen är frånkopplad" });
    options(sessionSelect, values, sessionId);

    const wasConnected = connected;
    connected = !!current?.supported;
    message("connection-error");
    el("connection").textContent = connected ? "Ansluten till vald session." : current ? "Starta om MCP-servern för att aktivera panelstödet." : "Öppna en Tabai-session i din agent för att ansluta.";
    if (connected) {
      const verifyingStatus = awaitingStatus;
      const recordingEpoch = recording.snapshotEpoch();
      const [state, context] = await Promise.all([
        request<PanelSnapshot>({ action: "snapshot", sessionId }),
        // Bounded like every panel request: an unanswered message would stop polling for good.
        Promise.race([
          chrome.runtime.sendMessage({ type: "panel-tabs", sessionId }) as Promise<PanelReply>,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Flikarna svarade inte i tid.")), 10000)),
        ]),
      ]);
      if (at !== generation) return;
      snapshot = state;
      recordingSnapshotEpoch = recordingEpoch;
      renderCheckpoints();
      if (verifyingStatus && !starting) awaitingStatus = false;
      tabs = context.ok ? context.result as Tab[] : [];
      const selectedTab = tabs.some(tab => String(tab.tabId) === tabSelect.value)
        ? tabSelect.value
        : String(tabs.find(tab => tab.active)?.tabId ?? tabs[0]?.tabId ?? "");
      options(
        tabSelect,
        tabs.map(tab => ({ value: String(tab.tabId), label: tab.title || tab.url || `Flik ${tab.tabId}` })),
        selectedTab,
      );
      if (!wasConnected) {
        if (view === "recipes") void loadRecipes();
        if (view === "history") void loadHistory();
      } else if (recipesFailed && view === "recipes" && !recipesLoading) void loadRecipes();
    } else {
      debugging.close();
      snapshot = { runs: [], calls: [] };
    }
    renderActivity();
  } catch (error) {
    if (at === generation) {
      connected = false;
      debugging.close();
      message("connection-error", String(error));
      renderActivity();
    }
  } finally {
    polling = false;
    if (pollAgain) { pollAgain = false; void poll(); }
  }
}

async function setView(next: View) {
  if (next === view || !await flushAssistantDrafts()) return;
  debugging.close();
  view = next;
  for (const name of ["activity", "recipes", "history"] as const) {
    el(`${name}-view`).hidden = name !== view;
  }
  document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Panelvyer"] [data-view]').forEach(button => {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (view === "recipes" && !recipes.length) void loadRecipes();
  if (view === "history") void loadHistory();
  window.scrollTo({ top: 0, behavior: "instant" });
}

document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Panelvyer"] [data-view]').forEach(button => {
  button.addEventListener("click", () => void setView(button.dataset.view as View));
});
sessionSelect.addEventListener("change", () => {
  sessionId = sessionSelect.value;
  initial = false;
  clearSession();
  void poll();
});
recipeSelect.addEventListener("change", renderParameters);
resumeSelect.addEventListener("change", updateStart);
el("refresh").addEventListener("click", async () => {
  await poll();
  if (view === "recipes") await loadRecipes();
  if (view === "history") await loadHistory();
});
el<HTMLFormElement>("recipe-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (startButton.disabled) return;
  const recipe = recipes.find(item => item.name === recipeSelect.value); if (!recipe) return;
  const parameters = collectParameters(recipe, el("parameter-fields"));
  const at = generation;
  starting = true;
  updateStart();
  message("form-error");
  try {
    const common = { sessionId, name: recipe.name, tabId: Number(tabSelect.value), parameters };
    await request(resumeSelect.value ? { action: "resume", ...common, resumeId: resumeSelect.value }
      : { action: "start", ...common, ...(el<HTMLInputElement>("resumable").checked ? { resumable: true } : {}) });
    if (at === generation) setView("activity");
  } catch (error) {
    if (at === generation) {
      awaitingStatus = true;
      message("form-error", `${String(error)} Kontrollera Pågår och Historik innan du försöker igen.`);
    }
  } finally {
    starting = false;
    updateStart();
    void poll();
  }
});

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  void chrome.runtime.sendMessage({ type: "ensure-connection" }).catch(() => {});
  void poll();
  setInterval(() => { if (!document.hidden) void poll(); }, 1000);
  setInterval(tick, 500);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
} else {
  message("connection-error", "Öppna kontrollpanelen från Tabai i Chrome.");
  el("connection").textContent = "Ingen anslutning utanför Chrome-tillägget.";
  options(sessionSelect, [{ value: "", label: "Öppna i Chrome" }], "");
  updateStart();
}
