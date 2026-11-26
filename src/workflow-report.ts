import type { Action, WorkflowRun, RunDeps } from "./tool-orchestration";
import type { RunHistory } from "./run-history";
import type { RunRecord } from "../shared/run-record";

/** History is a local diagnostic index, not a transcript. Raw browser errors
 * can contain field values and page text, so only classifications are saved. */
export async function workflowResponse(
  run: WorkflowRun,
  actions: Action[],
  deps: { history: Pick<RunHistory, "save">; call: RunDeps["call"]; captureOnError?: boolean },
) {
  let screenshot: string | undefined;
  let screenshotError: string | undefined;
  if (!run.ok && run.status !== "cancelled" && deps.captureOnError) {
    const tabId = actions[(run.failedStep ?? 1) - 1]?.args?.tabId;
    if (typeof tabId === "number") {
      try {
        const shot = await deps.call("screenshot", { tabId, format: "png" }) as { base64?: string; mimeType?: string };
        if (!shot?.base64 || shot.mimeType !== "image/png") throw new Error("Screenshot did not return a PNG");
        screenshot = shot.base64;
      } catch {
        screenshotError = "Failure screenshot unavailable; workflow outcome is unchanged";
      }
    } else {
      screenshotError = "Failed step has no tabId for a screenshot";
    }
  }
  const record: RunRecord = {
    runId: run.runId, startedAt: run.startedAt, durationMs: run.durationMs,
    status: run.status, totalSteps: run.totalSteps, completedSteps: run.completedSteps,
    ...(run.failedStep !== undefined ? { failedStep: run.failedStep } : {}),
    steps: run.steps.map(step => ({
      index: step.index, tool: step.tool, status: step.status, durationMs: step.durationMs,
      stage: step.stage, ...(step.error ? { error: `${step.stage}.${step.status}` } : {}),
      ...(step.incidentId ? { incidentId: step.incidentId } : {}),
    })),
  };
  let historyError: string | undefined;
  try {
    await deps.history.save(record, screenshot);
  } catch {
    historyError = "Could not persist run history; workflow outcome is unchanged";
  }
  const { results, ...summary } = run;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    structuredContent: {
      ...summary, historySaved: !historyError, screenshotSaved: !!screenshot && !historyError,
      ...(historyError ? { historyError } : {}), ...(screenshotError ? { screenshotError } : {}),
    },
    isError: !run.ok,
  };
}
