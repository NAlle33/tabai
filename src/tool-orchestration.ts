// Server-side orchestration shared by the direct tool handlers and the
// browser_batch / recipe_run path: per-step validation against the SAME Zod
// schemas the registered tools use, the bridge-timeout margins, and the result
// envelope (binary payloads never travel inline as text; PDFs/GIFs are saved
// exactly as the direct tools save them). Pure functions with injected deps so
// the batch semantics are unit-testable without a broker (dist/tool-orchestration.mjs).

import { randomUUID } from "node:crypto";
import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import type { ZodType } from "zod";
import { EXTENSION_TOOLS } from "../shared/tool-names";
import { saveGif, savePdf } from "./artifact-store";
export { saveGif, savePdf } from "./artifact-store";
import { bridgeTimeoutFor } from "./tool-timeouts";
import { actionSchema, expectationSchema, BATCH_MAX_STEPS, type Action } from "../shared/workflow-schema";
export type { Action } from "../shared/workflow-schema";
export { BATCH_MAX_STEPS } from "../shared/workflow-schema";
export type StepResult =
  | { tool: string; ok: true; result: unknown }
  | { tool: string; ok: false; error: string };

// Tools the extension can execute — single source of truth in shared/tool-names.ts
// (asserted against background.ts executeTool by test/tool-names-consistency.mjs).
const BRIDGE_TOOLS = new Set<string>(EXTENSION_TOOLS);

/** Bridge timeout for one step. Mirrors the direct registrations: a long wait
 *  (wait_for / download collect) needs headroom over its own wait so the
 *  extension's graceful timeout payload survives instead of a bridge timeout —
 *  which, being already-sent, would come back non-retryable and abort the rest
 *  of the batch; navigate / tab_reload carry their ~30 s internal budget. Others
 *  use the bridge default (undefined → 30 s). */
export function stepTimeout(tool: string, args: Record<string, unknown>): number | undefined {
  return bridgeTimeoutFor("workflow", tool, args);
}

/** Image results inside a batch: metadata only. The base64 would otherwise land
 *  in the model context as TEXT (1–5 MB per screenshot) — call the screenshot
 *  tool directly for an image block. */
export function summarizeBinary(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { kind?: string; base64?: string; mimeType?: string; source?: string; frames?: number; [key: string]: unknown };
  if (r.kind === "image" && typeof r.base64 === "string") {
    return {
      kind: "image",
      mimeType: r.mimeType ?? "image/png",
      bytes: Buffer.from(r.base64, "base64").length,
      ...(r.source ? { source: r.source } : {}),
      ...("targets" in r ? {
        targets: r.targets, width: r.width, height: r.height, coverage: r.coverage,
        documentId: r.documentId, frameId: r.frameId, viewport: r.viewport, truncated: r.truncated,
      } : {}),
      note: `binary omitted in batch — call ${"targets" in r ? "screenshot_marked" : "screenshot"} directly for an image block`,
    };
  }
  if (r.kind === "pdf" && typeof r.base64 === "string") return savePdf(r.base64);
  if (r.kind === "gif" && typeof r.base64 === "string") return saveGif(r.base64, r.frames);
  return result;
}

/** recipe_run: give every step that lacks a tabId the caller's default (a step
 *  saved without any `args` counts as lacking one). */
export function injectTabId(actions: Action[], tabId: number | undefined): Action[] {
  if (tabId == null) return actions;
  return actions.map((a) => {
    const args = (a.args ?? {}) as Record<string, unknown>;
    return { ...a, args: args.tabId == null ? { ...args, tabId } : args };
  });
}

export interface RunDeps {
  runId?: string;
  /** A panel stop is observed only BETWEEN complete steps, including expectations. */
  shouldStop?: () => boolean;
  onProgress?: (progress: { currentStep: number; tool?: string; tabId?: number; stage: string; completedSteps: number }) => void;
  /** The bridge call (tool, args, bridge timeout). */
  call: (tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  /** name → z.object(inputSchema) for every registered tool. */
  schemas: Map<string, ZodType<Record<string, unknown>>>;
  /** The MCP request's abort signal: a cancelled batch stops before its next step. */
  signal?: AbortSignal;
  /** Checked once before any action in a workflow using new extension features. */
  ensureCapabilities?: () => Promise<void>;
  /** Durable intent is committed before dispatch; failed writes block actions. */
  beforeDispatch?: (index: number) => Promise<void>;
  afterStep?: (index: number) => Promise<void>;
  /** Optional recording observes logical steps, not internal resolve/wait calls.
   * It cannot change whether an action was dispatched or invite a retry. */
  observeStep?: (action: Action) => Promise<(success: boolean) => Promise<void>>;
}

function issueText(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.length ? i.path.map(String).join(".") : "(args)"}: ${i.message}`).join("; ");
}

/** Run steps in order, stopping at the first failure. Every step is parsed with
 *  its tool's own registered schema — exactly what a direct call gets — and a
 *  tool with no recorded schema FAILS (never runs unvalidated). */
export async function runActions(actions: Action[], deps: RunDeps): Promise<StepResult[]> {
  return (await runWorkflow(actions, deps)).results;
}

type Stage = "preflight" | "resolve" | "dispatch" | "expect" | "artifact" | "complete";
export interface WorkflowStep {
  index: number;
  tool: string;
  status: "succeeded" | "failed" | "cancelled";
  durationMs: number;
  stage: Stage;
  actionState: "not-started" | "dispatched" | "completed";
  error?: string;
  incidentId?: string;
}
export interface WorkflowRun {
  runId: string;
  ok: boolean;
  status: "succeeded" | "failed" | "cancelled";
  startedAt: string;
  durationMs: number;
  totalSteps: number;
  completedSteps: number;
  failedStep?: number;
  steps: WorkflowStep[];
  results: StepResult[];
}

const pointerActions = new Set(["left_click", "right_click", "double_click", "triple_click", "hover", "scroll_to"]);
const targetTools = new Set(["form_input", "select_option", "computer"]);
const advancedTools = new Set(["resolve_target", "extract_table", "read_page_diff", "screenshot_marked"]);

function parsedArgs(tool: string, args: object, deps: RunDeps): Record<string, unknown> {
  if (!BRIDGE_TOOLS.has(tool)) throw new Error(`Unknown or non-batchable tool: ${tool}`);
  const schema = deps.schemas.get(tool);
  if (!schema) throw new Error(`no input schema registered for ${tool}`);
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid args — ${issueText(parsed.error.issues)}`);
  return parsed.data;
}
function assertResult(tool: string, result: unknown): void {
  if (tool === "javascript_tool" || !result || typeof result !== "object") return;
  const outcome = result as { ok?: unknown; armed?: unknown; error?: unknown; note?: unknown; reason?: unknown };
  // An arm that was not granted stops the run although the call itself is ok: the next step
  // is the trigger, and a download started without the arm is not this session's capture.
  if (outcome.ok === false || (tool === "download" && outcome.armed === false))
    throw new Error(String(outcome.error ?? outcome.note ?? outcome.reason ?? "tool reported failure"));
}

/** Static errors anywhere in a workflow are caught before the first dispatch.
 * Dynamic lookup and observations are separate calls; only actions dispatch
 * once. A timeout, cancellation or failed observation never triggers replay. */
export async function runWorkflow(actions: Action[], deps: RunDeps): Promise<WorkflowRun> {
  const started = Date.now();
  const run: WorkflowRun = {
    runId: deps.runId ?? randomUUID(), ok: false, status: "failed", startedAt: new Date(started).toISOString(),
    durationMs: 0, totalSteps: actions.length, completedSteps: 0, steps: [], results: [],
  };
  let index = 0;
  let stepStarted = started;
  let stage: Stage = "preflight";
  let actionState: WorkflowStep["actionState"] = "not-started";
  let stopped = false;
  let finishObservation: ((success: boolean) => Promise<void>) | undefined;
  const finishObserved = async (success: boolean) => {
    const finish = finishObservation; finishObservation = undefined;
    try { await finish?.(success); } catch { /* recording must not change the action outcome */ }
  };
  const progress = () => {
    const action = actions[index];
    try {
      deps.onProgress?.({ currentStep: index + 1, tool: action?.tool,
        tabId: typeof action?.args?.tabId === "number" ? action.args.tabId : undefined,
        stage, completedSteps: run.completedSteps });
    } catch { /* observation must never alter or replay a browser action */ }
  };
  const checkCancellation = () => {
    if (deps.signal?.aborted) {
      throw new Error("cancelled by the client; an already dispatched action is not replayed");
    }
  };
  try {
    checkCancellation();
    if (!actions.length || actions.length > BATCH_MAX_STEPS) {
      throw new Error(`Workflow needs 1-${BATCH_MAX_STEPS} steps`);
    }
    const prepared = actions.map((input, i) => {
      index = i;
      const action = actionSchema.parse(input);
      const args = action.args ?? {};
      let parsed: Record<string, unknown>;
      if (action.target) {
        if (!targetTools.has(action.tool)) {
          throw new Error("target is supported by form_input, select_option and computer pointer actions");
        }
        if (action.tool === "computer" && !pointerActions.has(String(args.action))) {
          throw new Error("target needs a computer pointer action");
        }
        if (["ref", "documentId", "coordinate", "start_coordinate"].some((key) => args[key] !== undefined)) {
          throw new Error("target cannot be mixed with ref, documentId or coordinates");
        }
        parsed = parsedArgs(action.tool, { ...args, ref: "ref_0", documentId: "pending-target" }, deps);
        if (parsed.ref !== "ref_0" || parsed.documentId !== "pending-target") {
          throw new Error("Tool schema does not preserve document-bound targets");
        }
        parsedArgs("resolve_target", { tabId: parsed.tabId, target: action.target }, deps);
      } else {
        parsed = parsedArgs(action.tool, args, deps);
      }
      let wait: Record<string, unknown> | undefined;
      if (action.expect !== undefined && parsed.expect !== undefined) {
        throw new Error("Specify expect on the action or in args, not both");
      }
      if (parsed.expect !== undefined && action.tool === "computer" && ["screenshot", "wait"].includes(String(parsed.action))) {
        throw new Error("args.expect requires a computer input action, not screenshot or wait");
      }
      const declaredExpectation = action.expect ?? parsed.expect;
      delete parsed.expect;
      if (declaredExpectation !== undefined) {
        const expect = expectationSchema.parse(declaredExpectation);
        wait = parsedArgs("wait_for", { tabId: parsed.tabId, ...expect }, deps);
        if (typeof parsed.tabId !== "number") {
          throw new Error("expect requires a tabId on the action");
        }
      }
      return { action, args: parsed, wait };
    });
    index = 0;
    const pointer = prepared.some(({ action, args }) => action.tool === "computer" && args.pointerMode === "browser");
    const advanced = pointer || prepared.some(({ action, args, wait }) => action.target || wait ||
      advancedTools.has(action.tool) ||
      args.documentId || (action.tool === "read_page" && args.compact) ||
      (action.tool === "wait_for" && (args.url || args.fieldValue || args.frameId !== undefined || args.state !== undefined || args.stableForMs !== undefined)));
    if (advanced) await deps.ensureCapabilities?.();
    if (pointer) {
      // Checked before ANY step, like the direct call: an extension without the
      // capability would ignore pointerMode and send a synthetic click instead.
      const health = await deps.call("health", {}, 1500) as { capabilities?: { browserPointer?: unknown } } | undefined;
      if (health?.capabilities?.browserPointer !== 1) throw new Error("Reload the extension: trusted browser pointer support is required before dispatch");
    }
    checkCancellation();
    for (index = 0; index < prepared.length; index++) {
      stepStarted = Date.now();
      actionState = "not-started";
      stage = "resolve";
      progress();
      const preparedAction = prepared[index];
      const { action, wait } = preparedAction;
      let { args } = preparedAction;
      checkCancellation();
      if (deps.shouldStop?.()) {
        stopped = true;
        throw new Error("Stopped before the next step; completed actions remain applied");
      }
      if (action.target) {
        const target = await deps.call("resolve_target", { tabId: args.tabId, target: action.target }) as { ref?: unknown; documentId?: unknown };
        assertResult("resolve_target", target);
        if (typeof target?.ref !== "string" || !/^ref_\d+(?:@\d+)?$/.test(target.ref) ||
            typeof target.documentId !== "string" || !target.documentId) {
          throw new Error("resolve_target did not return a document-bound reference");
        }
        args = parsedArgs(action.tool, { ...args, ref: target.ref, documentId: target.documentId }, deps);
      }
      checkCancellation();
      stage = "dispatch";
      progress();
      try { finishObservation = await deps.observeStep?.({ ...action, args,
        ...(action.expect ?? action.args?.expect ? { expect: (action.expect ?? action.args?.expect) as Action['expect'] } : {}) }); }
      catch { /* optional recording cannot authorize or replay a dispatch */ }
      await deps.beforeDispatch?.(index);
      checkCancellation();
      actionState = "dispatched";
      const result = await deps.call(action.tool, args, stepTimeout(action.tool, args));
      assertResult(action.tool, result);
      actionState = "completed";
      checkCancellation();
      if (wait) {
        stage = "expect";
        progress();
        const observed = await deps.call("wait_for", wait, stepTimeout("wait_for", wait));
        assertResult("wait_for", observed);
        checkCancellation();
      }
      stage = "artifact";
      const summary = summarizeBinary(result);
      await deps.afterStep?.(index);
      await finishObserved(true);
      run.results.push({ tool: action.tool, ok: true, result: summary });
      run.steps.push({ index: index + 1, tool: action.tool, status: "succeeded", durationMs: Date.now() - stepStarted, stage: "complete", actionState });
      run.completedSteps++;
      progress();
    }
    run.ok = true;
    run.status = "succeeded";
  } catch (error) {
    await finishObserved(false);
    run.status = deps.signal?.aborted || stopped ? "cancelled" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    if (stage === "dispatch" && ["LOOP_DETECTED", "LOOP_GUARD_CAPACITY", "FILE_REFUSED"].includes(String((error as { code?: unknown })?.code))) actionState = "not-started";
    const tool = actions[index]?.tool ?? "workflow";
    run.failedStep = index + 1;
    const incidentId = (error as { incidentId?: unknown })?.incidentId;
    run.steps.push({ index: index + 1, tool, status: run.status, durationMs: Date.now() - stepStarted, stage, actionState, error: message,
      ...(typeof incidentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incidentId) ? { incidentId } : {}) });
    run.results.push({ tool, ok: false, error: message });
  }
  run.durationMs = Date.now() - started;
  return run;
}

/** The local paths a tool hands to the page; every other tool names none. */
function localPaths(tool: string, args: Record<string, unknown> | undefined): unknown[] {
  if (tool === "file_upload") return Array.isArray(args?.paths) ? args.paths : [args?.paths];
  if (tool === "file_drop") return [args?.path];
  return [];
}

function fileRefused(reason: string): Error {
  return Object.assign(new Error(`FILE_REFUSED: ${reason} Nothing was given to the page.`), { code: "FILE_REFUSED", retryable: false });
}

/** A Windows share or device-namespace path (`\\server\share\…`, `\\?\…`, `\\.\…`). */
const windowsNamespacePath = (path: string): boolean => process.platform === "win32" && /^[\\/]{2}/.test(path);

/**
 * Throws unless `path` is an absolute path to an existing regular file that lies outside `denyRoot`.
 * Names alone cannot prove that: macOS also names every directory of its data volume under
 * `/System/Volumes/Data` without a link to resolve, and a Windows share or device path can name a
 * local directory. So no directory above the file's real path may be the deny root itself, compared
 * by device and inode, and anything that cannot be checked is refused.
 */
export function assertLocalFileAllowed(path: unknown, denyRoot: string): void {
  // The browser resolves a relative path against its own working directory, not this server's.
  if (typeof path !== "string" || !isAbsolute(path)) throw fileRefused("Only an absolute path to an existing regular file can be given to a page.");
  const namespaceRefusal = () => fileRefused("A network share or device path cannot be given to a page; use the file's local drive path.");
  if (windowsNamespacePath(path)) throw namespaceRefusal();
  let real: string;
  try {
    // The native call resolves links and returns the stored letter case, so neither hides the target.
    real = realpathSync.native(path);
    if (!statSync(real).isFile()) throw new Error("not a regular file");
  } catch {
    throw fileRefused("Only an existing regular file can be given to a page; a directory would give the page everything beneath it.");
  }
  // A mapped drive resolves to the share it names.
  if (windowsNamespacePath(real)) throw namespaceRefusal();
  const privateRefusal = () => fileRefused("Files in Tabai's private data directory cannot be given to a page.");
  let root: string, rootId: BigIntStats;
  try { root = realpathSync.native(denyRoot); rootId = statSync(root, { bigint: true }); }
  catch { throw fileRefused("Tabai's private data directory could not be checked, so no file can be given to a page."); }
  const below = relative(root, real);
  if (below === "" || !isAbsolute(below) && below !== ".." && !below.startsWith(`..${sep}`)) throw privateRefusal();
  for (let directory = dirname(real); ; directory = dirname(directory)) {
    let id: BigIntStats;
    try { id = statSync(directory, { bigint: true }); }
    catch { throw fileRefused("A directory above the file could not be checked, so it cannot be given to a page."); }
    if (id.dev === rootId.dev && id.ino === rootId.ino) throw privateRefusal();
    if (dirname(directory) === directory) return;
  }
}

/**
 * A server started with a deny root (the daily assistant's own server, whose root is the
 * per-user data directory) gives a page only regular files outside it. The check runs on the
 * bound arguments at the bridge call that direct tools, upload_image, batch steps and recipe
 * steps all share, so a path a recipe assembles from parameters is checked as it is sent and
 * before anything is written to the socket. Directories are refused: a directory input would
 * receive everything beneath it, including the private directory when it is a parent. Without
 * a deny root the bridge is returned unchanged.
 */
export function guardLocalFiles<T extends { call(tool: string, args: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> }>(bridge: T, denyRoot: string | undefined): T {
  if (!denyRoot) return bridge;
  const call = async (tool: string, args: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    for (const path of localPaths(tool, args)) assertLocalFileAllowed(path, denyRoot);
    return bridge.call(tool, args, ...rest);
  };
  return new Proxy(bridge, {
    get(target, key) {
      if (key === "call") return call;
      // Getters and methods run against the real client, whose state they own.
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
