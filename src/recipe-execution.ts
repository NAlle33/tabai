import type { Action } from "../shared/workflow-schema";
import type { RunDeps } from "./tool-orchestration";
import type { WorkflowControl } from "./workflow-control";
import type { RunHistory } from "./run-history";
import { fingerprint, type RecipeCheckpoint, type RecipeCheckpoints } from "./recipe-checkpoints";

type Call = RunDeps["call"];
const STORED_TARGET_KEYS = ["ref", "documentId", "coordinate", "start_coordinate"] as const;
const RESUME_EXPECTATION_TIMEOUT_MS = 1_500;

/** fill_form carries its document-bound refs inside each field and in submitRef. */
function storedFormRefs(action: Action): boolean {
  if (action.tool !== "fill_form") return false;
  const fields = Array.isArray(action.args?.fields) ? action.args.fields : [];
  return action.args?.submitRef !== undefined
    || fields.some(field => !field || typeof field !== "object" || (field as Record<string, unknown>).ref !== undefined);
}

/** Rebinding requires explicit fresh targets. A persisted raw ref, coordinate or
 * fixed tab ID is not portable to a new document/session. */
export function checkpointFingerprint(actions: Action[], tabId: number): string {
  for (const action of actions) {
    if (action.args?.tabId !== tabId) throw new Error("Resumable recipes require a single owned tab");
    if (STORED_TARGET_KEYS.some(key => action.args?.[key] !== undefined) || storedFormRefs(action))
      throw new Error("Resumable recipes require fresh targets, not stored refs or coordinates");
    if (action.expect?.predicate) throw new Error("Resumable checkpoints require declarative expectations, not executable predicates");
  }
  if (!actions.some(action => action.expect)) throw new Error("Resumable recipes require at least one declarative expectation");
  // The caller supplies the new owned tab; all other data must match exactly.
  return fingerprint(actions.map(action => ({ ...action, args: { ...action.args, tabId: 0 } })));
}

async function pageHash(call: Call, tabId: number): Promise<string> {
  const context = await call("tabs_context_mcp", {}) as { tabs?: Array<{ tabId: number; url?: string }> };
  const tab = context.tabs?.find(item => item.tabId === tabId);
  if (!tab || typeof tab.url !== "string") throw new Error("Target tab is not owned or its page identity is unavailable");
  return fingerprint(tab.url);
}

async function validateResume(record: RecipeCheckpoint, actions: Action[], tabId: number, call: Call): Promise<void> {
  if (await pageHash(call, tabId) !== record.urlHash) {
    throw new Error("Page URL changed since the checkpoint; resume blocked");
  }
  const expect = actions[record.cursor - 1]?.expect;
  if (!expect || expect.predicate) throw new Error("Checkpoint has no safe expectation");
  const timeoutMs = Math.min(expect.timeoutMs ?? RESUME_EXPECTATION_TIMEOUT_MS, RESUME_EXPECTATION_TIMEOUT_MS);
  // A stability window as long as the timeout can never be met: the first
  // sample starts the window, so half the budget stays for sampling it. The
  // state was already verified once; this only confirms that it still holds.
  const stability = expect.stableForMs === undefined ? {} : { stableForMs: Math.min(expect.stableForMs, Math.floor(timeoutMs / 2)) };
  const result = await call("wait_for", { ...expect, ...stability, tabId, timeoutMs }, 3_000) as { ok?: boolean };
  if (result?.ok !== true) throw new Error("Checkpoint expectation no longer holds; resume blocked");
}

export async function startCheckpointRecipe(options: {
  store: RecipeCheckpoints; workflows: WorkflowControl; history: RunHistory; deps: RunDeps;
  actions: Action[]; tabId: number; name: string; resumeId?: string; captureOnError?: boolean;
}) {
  const { store, workflows, history, deps, actions, tabId, name, resumeId } = options;
  const hash = checkpointFingerprint(actions, tabId);
  let record: RecipeCheckpoint;
  if (resumeId) {
    record = await store.claim(resumeId, hash);
    try {
      if (record.name !== name) throw new Error("Recipe name changed; checkpoint cannot be resumed");
      await validateResume(record, actions, tabId, deps.call);
    } catch (error) {
      await store.change(record, {}, true);
      throw error;
    }
  } else {
    await pageHash(deps.call, tabId); // Ownership before creating a durable run.
    record = await store.create(name, hash, actions.length);
  }
  const offset = record.cursor;
  const run = workflows.start(actions.slice(offset), {
    ...deps,
    beforeDispatch: async index => {
      // Runs after fresh target resolution, so navigation during validation
      // cannot send the first continued action to another URL.
      if (resumeId && index === 0 && await pageHash(deps.call, tabId) !== record.urlHash)
        throw new Error("Page URL changed before dispatch; resume blocked");
      await store.change(record, { phase: "dispatching" });
    },
    afterStep: async index => {
      const action = actions[offset + index];
      if (action.expect) await store.change(record, { phase: "verified", cursor: offset + index + 1, urlHash: await pageHash(deps.call, tabId) });
      else await store.change(record, { phase: "unverified" });
    },
  }, history, name, options.captureOnError);
  const done = run.done.then(async response => {
    let checkpointError: string | undefined;
    let removed = false;
    try {
      removed = await store.change(record, response.structuredContent.status === "succeeded" ? { phase: "complete", cursor: actions.length } : {}, true) === true;
    } catch (error) {
      // The browser work already happened: hiding its result would invite a
      // retry. An unreleased record stays owned, which blocks a resume until
      // this process is gone.
      checkpointError = `Could not record the final checkpoint; the workflow result is unchanged. ${error instanceof Error ? error.message : String(error)}`;
    }
    // A run that dispatched nothing removed its record: a resumeId would name
    // a checkpoint that no longer exists.
    return { ...response, structuredContent: { ...response.structuredContent, ...(removed ? {} : { resumeId: record.resumeId }), skippedSteps: offset,
      ...(checkpointError ? { checkpointError } : {}) } };
  }, async error => {
    // The run's own failure is the outcome the caller needs; a failed release
    // only leaves the record owned until this process is gone.
    await store.change(record, {}, true).catch(() => {});
    throw error;
  });
  return { runId: run.runId, resumeId: record.resumeId, done };
}
