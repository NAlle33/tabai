import { randomUUID } from "node:crypto";
import type { PanelRun } from "../shared/control-panel";
import { runWorkflow, type Action, type RunDeps } from "./tool-orchestration";
import { workflowResponse } from "./workflow-report";
import type { RunHistory } from "./run-history";

/** In-memory observation/control only. Durable metadata remains owned by history. */
export class WorkflowControl {
  private runs = new Map<string, { state: PanelRun; stop: boolean }>();

  snapshot(): PanelRun[] {
    return [...this.runs.values()].map(({ state }) => structuredClone(state)).reverse();
  }

  get busy(): boolean {
    return [...this.runs.values()].some(({ state }) => state.status === "running" || state.status === "stopping");
  }

  stop(runId: string): boolean {
    const entry = this.runs.get(runId);
    if (!entry || !["running", "stopping"].includes(entry.state.status)) return false;
    entry.stop = true;
    entry.state.status = "stopping";
    return true;
  }

  start(actions: Action[], deps: RunDeps, history: RunHistory, name: string, captureOnError = false) {
    const runId = randomUUID();
    const entry = {
      stop: false,
      state: {
        runId, name, status: "running", startedAt: new Date().toISOString(), durationMs: 0,
        totalSteps: actions.length, completedSteps: 0, currentStep: 1, stage: "preflight", steps: [],
      } as PanelRun,
    };
    this.runs.set(runId, entry);
    // Bound completed observations without deleting any active workflow.
    const finished = [...this.runs].filter(([, run]) => !["running", "stopping"].includes(run.state.status));
    for (const [id] of finished.slice(0, Math.max(0, finished.length - 20))) this.runs.delete(id);
    const done = (async () => {
      const run = await runWorkflow(actions, {
        ...deps, runId, shouldStop: () => entry.stop,
        onProgress: progress => Object.assign(entry.state, progress),
      });
      const response = await workflowResponse(run, actions, { call: deps.call, history, captureOnError });
      Object.assign(entry.state, {
        status: run.status, durationMs: run.durationMs, completedSteps: run.completedSteps,
        failedStep: run.failedStep, steps: run.steps.map(({ error, actionState: _actionState, ...step }) => ({
          ...step, ...(error ? { error: `${step.stage}.${step.status}` } : {}),
        })), historySaved: response.structuredContent.historySaved,
      });
      return response;
    })();
    return { runId, done };
  }
}
