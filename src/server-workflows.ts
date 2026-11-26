import type { BridgeClient } from "./bridge-client";
import type { RecipeStore } from "./recipe-store";
import type { RunHistory } from "./run-history";
import type { WorkflowControl } from "./workflow-control";
import type { z } from "zod";
import { injectTabId, type Action } from "./tool-orchestration";
import { recipeActions, type Recipe } from "../shared/workflow-schema";
import { MIN_EXTENSION_VERSION, compareVersions } from "../shared/protocol";
import { collectHealth, panelDiagnostics } from "./health";
import type { RecipeCheckpoints } from "./recipe-checkpoints";
import { startCheckpointRecipe } from "./recipe-execution";
import { PANEL_IMAGE_CHUNK_CHARS } from "../shared/panel-image";
import type { PanelStore } from "../shared/control-panel";
import { RecipeRecording } from './recipe-recording';

export interface ServerWorkflowDeps {
  bridge: Pick<BridgeClient, "call" | "configurePanel" | "activity" | "connected" | "pendingCount"> & Partial<Pick<BridgeClient, "brokerBuildId" | "incidents" | "loopGuard">>;
  checkpoints?: RecipeCheckpoints;
  recipes: RecipeStore<Recipe>;
  history: RunHistory;
  workflows: WorkflowControl;
  schemas: Map<string, z.ZodType<Record<string, unknown>>>;
  serverVersion: string;
}

/** Compose workflow and panel services over the server-owned instances. */
export function createServerWorkflows({ bridge, recipes, history, workflows, checkpoints, schemas: TOOL_SCHEMAS, serverVersion: SERVER_VERSION }: ServerWorkflowDeps) {
  const recording = new RecipeRecording((tool, args, timeout) => bridge.call(tool, args, timeout), recipes);
  function runDeps(signal?: AbortSignal) {
    const call = (tool: string, args: Record<string, unknown>, timeoutMs?: number) => bridge.call(tool, args, timeoutMs);
    return {
      call, schemas: TOOL_SCHEMAS, signal,
      observeStep: (action: Action) => recording.before(action),
      ensureCapabilities: async () => {
        const health = await bridge.call("health", {}) as { extVersion?: string };
        if (compareVersions(health?.extVersion ?? "0.0.0", MIN_EXTENSION_VERSION) < 0)
          throw new Error(`Reload the extension: workflow requires ${MIN_EXTENSION_VERSION} before any action can run`);
      },
    };
  }
  function startWorkflow(actions: Action[], signal?: AbortSignal, captureOnError = false, name = "Arbetsflöde") {
    return workflows.start(actions, runDeps(signal), history, name, captureOnError);
  }

  async function executeWorkflow(actions: Action[], signal?: AbortSignal, captureOnError = false, name?: string) {
    return startWorkflow(actions, signal, captureOnError, name).done;
  }

  function prepareRecipe(name: string, parameters?: Record<string, unknown>, tabId?: number) {
    const stored = recipes.load();
    if (!Object.hasOwn(stored, name)) throw new Error(`No recipe named "${name}"`);
    return injectTabId(recipeActions(stored[name], parameters), tabId);
  }
  async function startRecipe(name: string, parameters?: Record<string, unknown>, tabId?: number, signal?: AbortSignal, captureOnError = false, resumable = false, resumeId?: string) {
    const actions = prepareRecipe(name, parameters, tabId);
    if (!resumable && !resumeId) return startWorkflow(actions, signal, captureOnError, name);
    if (!checkpoints || !Number.isSafeInteger(tabId) || tabId! < 0) throw new Error("Resumable recipes require checkpoint storage and an explicit owned tabId");
    return startCheckpointRecipe({ store: checkpoints, workflows, history, deps: runDeps(signal), actions, tabId: tabId!, name, resumeId, captureOnError });
  }

  let panelStarting = false;
  bridge.configurePanel(SERVER_VERSION, async command => {
    switch (command.action) {
      case "snapshot": {
        const health = await collectHealth(bridge, SERVER_VERSION, false);
        // Each helper store is read on its own: an unreadable file empties only
        // its own list and is named, so runs, calls, recording and Stop stay available.
        const storeErrors: PanelStore[] = [];
        const readStore = <T>(store: PanelStore, read: () => T[]): T[] => {
          try { return read(); } catch { storeErrors.push(store); return []; }
        };
        const checkpointList = readStore("checkpoints", () => checkpoints?.list() ?? []);
        const incidents = readStore("incidents", () => bridge.incidents?.list(5) ?? []);
        return { runs: workflows.snapshot(), ...bridge.activity(), diagnostics: panelDiagnostics(health), checkpoints: checkpointList, incidents, loopPauses: bridge.loopGuard?.snapshot() ?? [], debugging: true, recording: recording.status(),
          ...(storeErrors.length ? { storeErrors } : {}) };
      }
      case 'recording-start':
        if (panelStarting || workflows.busy || bridge.activity().calls.length) throw new Error('Vänta tills sessionens pågående steg har avslutats.');
        return recording.start(command.tabId);
      case 'recording-draft': return recording.draft();
      case 'recording-stop': return recording.stop(command.recordingId);
      case 'recording-discard': return recording.discard(command.recordingId);
      case 'recording-save': return recording.save(command.review);
      case "recipes": {
        const entries = Object.entries(recipes.load());
        return { total: entries.length, recipes: entries.slice(0, 100).map(([name, recipe]) => ({
          name, steps: Array.isArray(recipe) ? recipe.length : recipe.actions.length,
          parameters: Array.isArray(recipe) ? {} : recipe.parameters,
          ...(!Array.isArray(recipe) && recipe.description ? { description: recipe.description } : {}),
        })) };
      }
      case "history": return history.list(100);
      case "history-image": {
        const { pngBase64 } = history.get(command.runId);
        if (!pngBase64) throw new Error("Ingen sparad felbild finns kvar för körningen.");
        if (command.offset >= pngBase64.length || command.offset % 4) throw new Error("Ogiltig bildposition.");
        return { mimeType: "image/png", offset: command.offset, total: pngBase64.length,
          base64: pngBase64.slice(command.offset, command.offset + PANEL_IMAGE_CHUNK_CHARS) };
      }
      case "incident": {
        if (!bridge.incidents) throw new Error("Starta om MCP-servern för att läsa timeoutpaket.");
        return bridge.incidents.get(command.incidentId);
      }
      case "stop": return { requested: workflows.stop(command.runId) };
      case "continue-loop": return { continued: bridge.loopGuard?.continue(command.tabId, command.pauseId) ?? false };
      case "resume":
      case "start": {
        if (panelStarting || workflows.busy || bridge.activity().calls.length) throw new Error("Sessionen arbetar redan. Vänta tills den är redo.");
        panelStarting = true;
        try {
          const context = await bridge.call("tabs_context_mcp", {}) as { tabs?: Array<{ tabId: number }> };
          if (!context.tabs?.some(tab => tab.tabId === command.tabId)) throw new Error("Fliken tillhör inte längre sessionen. Välj en aktuell flik.");
          const run = await startRecipe(command.name, command.parameters, command.tabId, undefined, false,
            command.action === "start" && command.resumable, command.action === "resume" ? command.resumeId : undefined);
          // The start ACK is immediate. Polling observes the original execution;
          // neither closing the panel nor losing its response dispatches it again.
          void run.done.catch(() => {});
          return { runId: run.runId };
        } finally { panelStarting = false; }
      }
      default: throw new Error("Unsupported server panel command");
    }
  });

  return { executeWorkflow, prepareRecipe, startRecipe, recording };
}
