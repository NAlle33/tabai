import { executeScript } from "./diagnostics";
import { browserPointer } from "./browser-pointer";
import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { axTreeInPage, evalInPage, extractPageText, pageQuery, readConsoleInPage, readNetworkInPage, storageInPage } from "./injected-page-scripts";
import { waitInTab, waitForActionableRef } from "./page-wait";
import { evaluateInPage } from "./page-evaluation";
import { cdpSend } from "./cdp";
import { NoFallbackError } from "./tool-error";
import { WAIT_TIMEOUT_MAX_MS } from "../../shared/protocol";
import { parseRef, deepByAttrExpr, frameTarget, evaluateRefInTab } from "./element-ref";
import { cdpInteract } from "./computer-input";
import { captureComputerScreenshot } from "./capture-tools";
import { pageInteract } from "./injected-interaction-scripts";
import { formInputInPage, fillFormInPage, selectOptionInPage } from "./injected-form-scripts";
/** documentIds targets must also match the frame suffix supplied by the caller. */
async function assertReferenceFrame(tabId: number, ref: string, documentId?: string): Promise<void> {
  if (documentId === undefined) return;
  const { frameId } = parseRef(ref);
  const results = await executeScript({ target: frameTarget(tabId, frameId, documentId), func: () => true });
  if (results.length !== 1 || results[0]?.frameId !== frameId || results[0]?.documentId !== documentId) {
    throw new Error("Reference frame/document mismatch; resolve the target again before acting");
  }
}

export async function toolReadNetwork(args: {
  tabId: number;
  urlPattern?: string;
  limit?: number;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const [res] = await executeScript({
    target: { tabId: args.tabId },
    world: "MAIN",
    func: readNetworkInPage,
  });
  const r = res?.result as
    | { installed: boolean; requests: any[] }
    | undefined;
  if (!r) return { installed: false, requests: [] };
  let reqs = r.requests;
  if (args.urlPattern) {
    reqs = reqs.filter((q) => String(q.url).includes(args.urlPattern!));
  }
  // A non-positive limit would slice(-0) → everything (or the wrong end); the
  // schema already rejects it, this keeps a batch/raw caller honest too.
  reqs = reqs.slice(-(args.limit && args.limit > 0 ? args.limit : 100));
  return {
    installed: r.installed,
    note: r.installed
      ? undefined
      : "network capture not active on this page — reload the page after loading the extension",
    count: reqs.length,
    requests: reqs,
  };
}


export async function toolGetPageText(args: { tabId: number }) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const [res] = await executeScript({
    target: { tabId: args.tabId },
    func: extractPageText,
  });
  return { text: (res?.result as string) ?? "" };
}


// Bounds how long ONE javascript_tool request may occupy the worker. Above the
// page wrapper's 25 s promise cap so a never-settling expression still reports
// its own diagnostic, and below the 30 s bridge default so the client normally
// receives that message instead of a TIMEOUT. It bounds the worker, not
// end-to-end client time: the bridge timer starts earlier and transport delay
// consumes the margin.
const JAVASCRIPT_WORKER_TIMEOUT_MS = 27_000;


export async function toolJavascript(args: { text: string; tabId: number; world?: "main" | "isolated" }) {
  // Started BEFORE the first asynchronous ownership lookup: a slow gate must not
  // buy the evaluation a fresh budget afterwards.
  const deadline = Date.now() + JAVASCRIPT_WORKER_TIMEOUT_MS;
  const expired = () =>
    new Error(`javascript_tool did not finish within ${JAVASCRIPT_WORKER_TIMEOUT_MS}ms`);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const abandoned = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      reject(expired());
    }, JAVASCRIPT_WORKER_TIMEOUT_MS);
  });

  const run = async () => {
    const sessionId = sessionOf(args);
    await assertTabInGroup(sessionId, args.tabId);
    const evaluated = await evaluateInPage<
      { ok: true; value: unknown } | { ok: false; error: string }
    >({
      sessionId,
      tabId: args.tabId,
      deadline,
      isStopped: () => stopped,
      expired,
      func: evalInPage,
      args: [args.text],
      awaitPromise: true,
      world: args.world === "isolated" ? "isolated" : "main",
    });
    // The script already ran once. Re-running it in the replacement document
    // could repeat a mutation, so report the uncertainty instead. Say plainly
    // that it ran: an agent told only that the call "failed" would retry it.
    if (evaluated.status !== "ok") {
      throw new Error(
        "the page's document changed while this script was evaluating, so its result could not be tied to the document it ran in — the script DID run and may have completed, and it was NOT re-run. Check the page state before retrying.",
      );
    }
    const r = evaluated.value;
    if (!r) throw new Error("No result returned from page.");
    if (!r.ok) throw new Error(`Page JS error: ${r.error}`);
    return r.value;
  };

  try {
    // A late browser result may settle this promise but can no longer be
    // accepted, probe again, or dispatch the supplied script.
    return await Promise.race([run(), abandoned]);
  } finally {
    stopped = true;
    clearTimeout(timer!);
  }
}


// ---- DOM reading / interaction (Core tier) ---------------------------------

// Merge per-frame pageQuery results: main frame first, sub-frame refs rewritten
// `ref_N` -> `ref_N@<frameId>` so they resolve back to the right frame.
function mergeFrameResults(results: chrome.scripting.InjectionResult[]): string {
  const parts: string[] = [];
  const sorted = results
    .slice()
    .sort((a: any, b: any) =>
      a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId,
    );
  for (const r of sorted as any[]) {
    const text = (r.result as string) || "";
    if (!text) continue;
    if (r.frameId === 0) {
      parts.push(text);
    } else {
      parts.push(`-- frame ${r.frameId} --`);
      parts.push(text.replace(/\[(ref_\d+)\]/g, `[$1@${r.frameId}]`));
    }
  }
  return parts.join("\n");
}

// Bound a merged listing at a line end, so no partial ref is ever printed. When
// even the first line is longer, the cut still falls after its ref, which ends
// within the first 100 characters (the schema's minimum of maxChars).
function truncateListing(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lineEnd = text.lastIndexOf("\n", maxChars);
  return text.slice(0, lineEnd > 0 ? lineEnd : maxChars) + "\n…(truncated)";
}


export async function toolReadPage(args: {
  tabId: number;
  filter?: "interactive" | "all";
  maxResults?: number;
  maxChars?: number;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const filter = args.filter ?? "interactive";
  const maxResults = args.maxResults ?? 200;
  const results = await executeScript({
    target: { tabId: args.tabId, allFrames: true },
    args: ["read", "", filter, maxResults],
    func: pageQuery,
  });
  const text = truncateListing(mergeFrameResults(results), args.maxChars ?? 12_000);
  return { filter, elements: text || "(no matching elements)" };
}


export async function toolFind(args: { query: string; tabId: number }) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const results = await executeScript({
    target: { tabId: args.tabId, allFrames: true },
    args: ["find", args.query, "all", 20],
    func: pageQuery,
  });
  // Each frame returns up to 20 bounded lines; bound the merged listing as well.
  const text = truncateListing(mergeFrameResults(results), 12_000);
  return { query: args.query, matches: text || "(no matches)" };
}


export async function toolFormInput(args: {
  ref: string;
  value: string | boolean | number;
  tabId: number;
  documentId?: string;
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const documentId = await waitForActionableRef(sessionId, args.tabId, args.ref, 5000, args.documentId);
  const { base, frameId } = parseRef(args.ref);
  await assertTabInGroup(sessionId, args.tabId);
  const [res] = await executeScript({
    target: frameTarget(args.tabId, frameId, documentId),
    args: [base, args.value],
    func: formInputInPage,
  });
  const r = res?.result as { ok: boolean; error?: string } | undefined;
  if (!r?.ok) throw new Error(r?.error ?? "form_input failed");
  return r;
}


export async function toolFillForm(args: {
  tabId: number;
  fields: { ref: string; value: string | boolean | number }[];
  submitRef?: string;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    throw new Error("fill_form needs a non-empty fields array");
  }
  // Refs are PER-FRAME counters (ref_N exists independently in each frame), so a
  // multi-frame fill could resolve the WRONG element. Require all refs in ONE
  // frame + reject loudly otherwise (vs a silent wrong-write).
  const frameId = parseRef(args.fields[0].ref).frameId;
  const mismatched = [
    ...args.fields.filter((f) => parseRef(f.ref).frameId !== frameId).map((f) => f.ref),
    ...(args.submitRef && parseRef(args.submitRef).frameId !== frameId ? [args.submitRef] : []),
  ];
  if (mismatched.length) {
    throw new Error(
      `fill_form: all refs must be in one frame (field[0] is frame ${frameId}; mismatched: ${mismatched.join(", ")}). Use form_input per-field across frames.`,
    );
  }
  // Within that frame, the in-page resolver pierces shadow DOM + same-origin iframes.
  const fields = args.fields.map((f) => ({ ref: parseRef(f.ref).base, value: f.value }));
  const submitBase = args.submitRef ? parseRef(args.submitRef).base : undefined;
  const [res] = await executeScript({
    target: frameTarget(args.tabId, frameId),
    args: [fields, submitBase ?? null], // executeScript args must be JSON-serializable (no undefined)
    func: fillFormInPage,
  });
  const r = res?.result as
    | { ok: boolean; results?: { ok: boolean; error?: string }[]; submitted?: boolean }
    | undefined;
  if (!r) throw new Error("fill_form failed");
  // Consistency with form_input/select_option (which throw on failure): a TOTAL
  // failure (no field set) throws so a caller checking only for thrown errors
  // can't mistake it for success. Partial success still returns per-field detail.
  const results = r.results ?? [];
  if (results.length > 0 && results.every((f) => !f.ok)) {
    throw new Error(
      `fill_form: all ${results.length} field(s) failed — ${results
        .map((f, i) => `#${i}: ${f.error ?? "?"}`)
        .join("; ")}`,
    );
  }
  return r;
}


export async function toolWaitFor(args: {
  tabId: number;
  selector?: string;
  text?: string;
  predicate?: string;
  networkIdle?: boolean;
  url?: string;
  fieldValue?: { selector: string; value: string | number | boolean };
  frameId?: number;
  timeoutMs?: number;
  idleMs?: number;
  state?: "attached" | "visible" | "hidden" | "detached";
  stableForMs?: number;
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const criteria = ["selector", "text", "predicate", "networkIdle", "url", "fieldValue"] as const;
  const selected = criteria.filter(key => args[key] !== undefined);
  if (selected.length !== 1) {
    throw new Error("wait_for needs exactly one of: selector, text, predicate, networkIdle, url, fieldValue");
  }
  const criterion = selected[0];
  const kind = criterion === "networkIdle" ? "network_idle" : criterion === "fieldValue" ? "field_value" : criterion;
  if (criterion === "networkIdle") {
    if (args.networkIdle !== true) throw new Error("wait_for networkIdle must be true");
  } else if (criterion === "fieldValue") {
    const field = args.fieldValue;
    if (!field || typeof field.selector !== "string" || !field.selector.trim() ||
        !["string", "number", "boolean"].includes(typeof field.value) ||
        (typeof field.value === "number" && !Number.isFinite(field.value))) {
      throw new Error("wait_for fieldValue needs a selector and a string, finite number, or boolean value");
    }
  } else if (typeof args[criterion] !== "string" || !args[criterion]!.trim()) {
    throw new Error(`wait_for ${criterion} must be a non-empty string`);
  }
  if (args.frameId !== undefined &&
      (!Number.isInteger(args.frameId) || args.frameId < 0 ||
       !["selector", "text", "fieldValue"].includes(criterion))) {
    throw new Error("wait_for frameId must be a non-negative integer and is only supported for selector, text, or fieldValue");
  }
  if (args.state !== undefined && (criterion !== "selector" || !["attached", "visible", "hidden", "detached"].includes(args.state))) {
    throw new Error("wait_for state requires a selector and must be attached, visible, hidden, or detached");
  }
  if (args.stableForMs !== undefined && (!Number.isInteger(args.stableForMs) || args.stableForMs < 0 || args.stableForMs > WAIT_TIMEOUT_MAX_MS)) {
    throw new Error("wait_for stableForMs must be an integer from 0 to 270000");
  }
  const value = args.fieldValue ?? args.url ?? args.selector ?? args.text ?? args.predicate ?? "";
  const timeoutMs = Number.isFinite(args.timeoutMs)
    ? Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(1, args.timeoutMs!)) : 15_000;
  return waitInTab(sessionId, args.tabId, kind, value, timeoutMs, args.idleMs ?? 500, args.frameId,
    args.state === undefined && args.stableForMs === undefined ? undefined : { state: args.state, stableForMs: args.stableForMs });
}


export async function toolSelectOption(args: {
  ref: string;
  value: string;
  tabId: number;
  documentId?: string;
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const documentId = await waitForActionableRef(sessionId, args.tabId, args.ref, 5000, args.documentId);
  const { base, frameId } = parseRef(args.ref);
  await assertTabInGroup(sessionId, args.tabId);
  const [res] = await executeScript({
    target: frameTarget(args.tabId, frameId, documentId),
    args: [base, args.value],
    func: selectOptionInPage,
  });
  const r = res?.result as { ok: boolean; error?: string } | undefined;
  if (!r?.ok) throw new Error(r?.error ?? "select_option failed");
  return r;
}


/** file_upload: set files on a file input (resolved by ref) via CDP. */
export async function toolFileUpload(args: {
  ref: string;
  paths: string[];
  tabId: number;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const { base, frameId } = parseRef(args.ref);
  const evalRes = await evaluateRefInTab<any>(args.tabId, args.ref, deepByAttrExpr(base), false);
  const objectId = evalRes?.result?.objectId;
  if (!objectId) {
    throw new Error(
      `No element for ${args.ref}. Call read_page/find first; it must be a <input type=file>.`,
    );
  }
  const guard = async () => {
    await assertTabInGroup(sessionOf(args), args.tabId);
    await evaluateRefInTab(args.tabId, args.ref, `${deepByAttrExpr(base)}.isConnected`);
  };
  // Enable the domain before the single file mutation; an uncertain response
  // must never replay a completed upload.
  await cdpSend(args.tabId, "DOM.enable", {}, guard);
  await cdpSend(args.tabId, "DOM.setFileInputFiles", { files: args.paths, objectId }, guard);
  return { ok: true, ref: args.ref, files: args.paths };
}


export async function toolComputer(args: {
  action: string;
  tabId: number;
  coordinate?: [number, number];
  ref?: string;
  documentId?: string;
  text?: string;
  scroll_direction?: string;
  scroll_amount?: number;
  duration?: number;
  start_coordinate?: [number, number];
  modifiers?: string;
  repeat?: number;
  allowFocus?: boolean;
  pointerMode?: "synthetic" | "browser";
}) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  if (args.pointerMode !== undefined && args.pointerMode !== "synthetic" && args.pointerMode !== "browser")
    throw new Error("Unknown pointerMode");
  if (args.ref && args.pointerMode !== "browser" && !["left_click", "right_click", "double_click"].includes(args.action))
    await assertReferenceFrame(args.tabId, args.ref, args.documentId);
  if (args.pointerMode === "browser") return browserPointer(sessionId, args);
  if (args.documentId !== undefined) {
    if (!args.ref || args.coordinate !== undefined || args.start_coordinate !== undefined ||
        !["left_click", "right_click", "double_click", "triple_click", "hover", "scroll_to"].includes(args.action)) {
      throw new Error("document-bound computer actions require a pointer ref action without coordinates");
    }
    frameTarget(args.tabId, parseRef(args.ref).frameId, args.documentId);
  }
  switch (args.action) {
    case "screenshot": return captureComputerScreenshot(sessionId, args);
    case "wait": {
      const ms = Math.min((args.duration ?? 1) * 1000, 10_000);
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, info: `waited ${ms}ms` };
    }
    case "zoom":
      throw new Error("zoom is not implemented in the Core tier yet");
    default: {
      const { base, frameId } = args.ref
        ? parseRef(args.ref)
        : { base: undefined as string | undefined, frameId: 0 };
      let documentId = args.documentId;
      // Auto-wait: ref-based clicks wait until the element is actionable.
      const CLICKS = ["left_click", "right_click", "double_click"];
      if (args.ref && CLICKS.includes(args.action)) {
        documentId = await waitForActionableRef(sessionId, args.tabId, args.ref, 5000, args.documentId);
      }
      // CDP path (main frame only). Two sub-cases both survive a backgrounded tab:
      //   ref clicks → reliable JS click (focus + el.click()) via Runtime.evaluate
      //   type/key   → Input.insertText / Input.dispatchKeyEvent into the focused node
      // The ONE thing that does NOT survive a hidden tab is a *coordinate* pointer
      // click: it relies on Input.dispatchMouseEvent, which the compositor silently
      // drops when document.hidden (no surface to hit-test) — and our tabs are
      // usually backgrounded. So coordinate clicks skip CDP and take the synthetic
      // page path below (elementFromPoint + dispatched MouseEvents), which is
      // visibility- and devicePixelRatio-independent.
      const coordPointer = !args.ref && CLICKS.includes(args.action);
      const CDP_ACTIONS = ["left_click", "right_click", "double_click", "type", "key"];
      if (args.documentId === undefined && frameId === 0 && CDP_ACTIONS.includes(args.action) && !coordPointer) {
        try {
          return await cdpInteract(args);
        } catch (e) {
          // Once trusted keyboard input is selected, neither readiness failure
          // nor an uncertain dispatch may replay it as synthetic input/submit.
          if (e instanceof NoFallbackError || args.action === "key" || args.action === "type") throw e;
        }
      }
      await assertTabInGroup(sessionId, args.tabId);
      const [res] = await executeScript({
        target: frameTarget(args.tabId, frameId, documentId),
        args: [
          args.action,
          {
            ref: base,
            coordinate: args.coordinate,
            text: args.text,
            scroll_direction: args.scroll_direction,
            scroll_amount: args.scroll_amount,
            start_coordinate: args.start_coordinate,
            modifiers: args.modifiers,
            repeat: args.repeat,
          },
        ],
        func: pageInteract,
      });
      const r = res?.result as { ok: boolean; error?: string } | undefined;
      if (!r?.ok) throw new Error(r?.error ?? "computer action failed");
      return r;
    }
  }
}


export async function toolReadConsole(args: {
  tabId: number;
  pattern?: string;
  onlyErrors?: boolean;
  limit?: number;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const [res] = await executeScript({
    target: { tabId: args.tabId },
    world: "MAIN",
    func: readConsoleInPage,
  });
  const r = res?.result as
    | { installed: boolean; messages: { level: string; text: string }[] }
    | undefined;
  if (!r) return { installed: false, messages: [] };
  let msgs = r.messages;
  if (args.onlyErrors) msgs = msgs.filter((m) => m.level === "error");
  if (args.pattern) {
    try {
      const re = new RegExp(args.pattern, "i");
      msgs = msgs.filter((m) => re.test(m.text));
    } catch {
      /* invalid regex: ignore filter */
    }
  }
  msgs = msgs.slice(-(args.limit && args.limit > 0 ? args.limit : 100));
  return {
    installed: r.installed,
    note: r.installed
      ? undefined
      : "console capture not active on this page — reload the page after loading the extension",
    count: msgs.length,
    messages: msgs.map((m) => ({ level: m.level, text: m.text })),
  };
}


/** storage: read/write the tab's localStorage or sessionStorage (same-origin). */
export async function toolStorage(args: {
  tabId: number;
  area: "local" | "session";
  action: "get" | "set" | "remove" | "clear";
  key?: string;
  value?: string;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const [res] = await executeScript({
    target: { tabId: args.tabId },
    // executeScript args must be JSON-serializable (no undefined).
    args: [args.area, args.action, args.key ?? null, args.value ?? null],
    func: storageInPage,
  });
  return res?.result ?? { ok: false, error: "no result from page" };
}


/** get_accessibility_tree: a bounded hierarchical role/name/text outline. */
export async function toolAccessibilityTree(args: { tabId: number; maxNodes?: number }) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const [res] = await executeScript({
    target: { tabId: args.tabId },
    args: [args.maxNodes ?? null],
    func: axTreeInPage,
  });
  return res?.result ?? { ok: false, error: "no result from page" };
}


/** file_drop: resolve the target, then use CDP's native dragEnter/dragOver/drop
 *  pipeline to attach the local path as a browser-provided File. */
export async function toolFileDrop(args: { ref: string; tabId: number; path: string }) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  const { base, frameId } = parseRef(args.ref);
  if (frameId !== 0) {
    throw new Error("file_drop is main-frame only; the dropzone must be in the top frame");
  }
  // Resolve the dropzone's viewport-center coordinate (CDP drag dispatches at x,y).
  const rr = await evaluateRefInTab<any>(args.tabId, args.ref,
    `(()=>{const e=${deepByAttrExpr(base)};if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`);
  const pt = rr?.result?.value;
  if (!pt) throw new Error(`No element for ${args.ref}. Call read_page/find first.`);
  // Native drag-drop via CDP: the browser attaches the real OS file, so the page's
  // drop handler gets a populated dataTransfer.files. (Synthetic DOM DragEvents
  // can't carry files — Chrome drops them for security.) dragEnter → over → drop.
  const data = { items: [], files: [args.path], dragOperationsMask: 1 };
  const guard = async () => {
    await assertTabInGroup(sessionOf(args), args.tabId);
    const checked = await evaluateRefInTab<any>(args.tabId, args.ref,
      `(()=>{const e=${deepByAttrExpr(base)};const b=e.getBoundingClientRect();let hit=document.elementFromPoint(${pt.x},${pt.y});while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(${pt.x},${pt.y});if(!inner||inner===hit)break;hit=inner;}let inside=false;for(let n=hit;n;n=n.parentElement||n.getRootNode()?.host){if(n===e){inside=true;break;}}return Math.abs(b.left+b.width/2-${pt.x})<1&&Math.abs(b.top+b.height/2-${pt.y})<1&&inside;})()`);
    if (checked.result?.value !== true) throw new NoFallbackError("File-drop target moved or was covered; an already dispatched drag event was not repeated");
  };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdpSend(args.tabId, "Input.dispatchDragEvent", { type, x: pt.x, y: pt.y, data }, guard);
  }
  // The drop events were dispatched at the dropzone, but whether the page's drop
  // handler accepted the file is page-specific and not observable from here —
  // report honestly rather than implying confirmed delivery.
  return {
    ok: true,
    ref: args.ref,
    path: args.path,
    dispatched: true,
    note: "dragEnter/dragOver/drop dispatched at the dropzone; delivery to the page's handler is not verified — check the page state to confirm.",
  };
}
