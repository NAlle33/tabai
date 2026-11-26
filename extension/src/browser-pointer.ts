import { cdpSend } from "./cdp";
import { executeScript, traceOperation } from "./diagnostics";
import { waitForActionableRef } from "./page-wait";
import { assertTabInGroup } from "./tab-group-helpers";
import { assertAgentFocusAllowed } from "./agent-focus";

export interface BrowserPointerArgs {
  action: string;
  tabId: number;
  ref?: string;
  coordinate?: [number, number];
  documentId?: string;
  allowFocus?: boolean;
  modifiers?: string;
}

// Serialized by Chrome. Resolve only this document, including open shadow roots.
function pointerTargetInPage(ref: string | null, coordinate: [number, number] | null, scroll: boolean) {
  const resolve = (r: string): Element => {
    if (!/^ref_\d+$/.test(r)) throw new Error("invalid ref");
    const w = window as any;
    const state = w.__ccmcpRefState;
    if (state?.document !== document || !/^ref_\d{50}$/.test(r) || r.slice(4, 44) !== state.namespace)
      throw new Error(`Stale ref ${r}; read the page again`);
    const el = w.__ccmcpRefMap?.[r];
    if (!el?.isConnected || el.ownerDocument !== document || el.getAttribute("data-ccmcp-ref") !== r)
      throw new Error(`Stale ref ${r}; read the page again`);
    let matches = 0;
    const visit = (root: any): void => {
      for (const candidate of root.querySelectorAll(`[data-ccmcp-ref="${r}"]`)) {
        if (candidate.isConnected && candidate.ownerDocument === document) {
          if (candidate !== el || ++matches > 1) throw new Error(`Ambiguous ref ${r}; read the page again`);
        }
      }
      for (const node of root.querySelectorAll("*")) if (node.shadowRoot) visit(node.shadowRoot);
    };
    visit(document);
    if (matches !== 1) throw new Error(`Stale ref ${r}; read the page again`);
    return el;
  };
  if (ref && !/^ref_\d+$/.test(ref)) throw new Error("Browser pointer requires a main-frame ref");
  const element = ref ? resolve(ref) : null;
  if (scroll && element) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element?.getBoundingClientRect();
  const x = coordinate ? coordinate[0] : rect!.left + rect!.width / 2;
  const y = coordinate ? coordinate[1] : rect!.top + rect!.height / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
    throw new Error("Browser pointer coordinates are outside the CSS viewport");
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || (element && hit !== element && !element.contains(hit)))
    throw new Error("Browser pointer target is covered or no longer at this point");
  if (element) {
    const style = getComputedStyle(element);
    if (!rect!.width || !rect!.height || style.visibility !== "visible" ||
        element.matches(":disabled") || element.getAttribute("aria-disabled") === "true")
      throw new Error("Browser pointer target is not actionable");
  }
  return { x, y, visible: document.visibilityState === "visible", focused: document.hasFocus() };
}

/** Explicit trusted pointer route. Never fall back to a synthetic event or replay
 *  after an ambiguous dispatch. CDP uses CSS pixels, independent of display DPR. */
export async function browserPointer(sessionId: string, args: BrowserPointerArgs) {
  const clicks = { left_click: 1, right_click: 1, double_click: 2, triple_click: 3 };
  const count = clicks[args.action as keyof typeof clicks];
  if (!count) throw new Error("pointerMode browser supports left/right/double/triple click only");
  if ((args.ref !== undefined) === (args.coordinate !== undefined))
    throw new Error("Browser pointer requires exactly one ref or coordinate");
  if (args.ref !== undefined && !/^ref_\d+(?:@0)?$/.test(args.ref))
    throw new Error("Browser pointer supports main-frame refs only; child frames are unsupported");
  if (args.coordinate !== undefined && (args.coordinate.length !== 2 || !args.coordinate.every(Number.isFinite)))
    throw new Error("Browser pointer coordinate must contain two finite CSS pixels");
  if (args.modifiers) throw new Error("Browser pointer modifiers are unsupported");
  if (args.documentId !== undefined && !args.documentId.trim()) throw new Error("documentId must be non-empty");
  const ref = args.ref?.replace(/@0$/, "") ?? null;
  const tab = await assertTabInGroup(sessionId, args.tabId);
  const window = await chrome.windows.get(tab.windowId);
  if (!tab.active || !window.focused || window.state === "minimized") {
    if (args.allowFocus !== true)
      throw new Error("Browser pointer needs a visible tab in a focused window; allowFocus:true explicitly permits activation");
    await assertAgentFocusAllowed();
    await traceOperation(sessionId, "tabs.update", () => chrome.tabs.update(args.tabId, { active: true }), { tabId: args.tabId });
    await traceOperation(sessionId, "windows.update", () => chrome.windows.update(tab.windowId,
      { focused: true, ...(window.state === "minimized" ? { state: "normal" as const } : {}) }), { tabId: args.tabId });
  }
  let documentId = args.documentId;
  const probe = async (scroll = false) => {
    const [result] = await executeScript({
      target: documentId ? { tabId: args.tabId, documentIds: [documentId] } : { tabId: args.tabId, frameIds: [0] },
      func: pointerTargetInPage, args: [ref, args.coordinate ?? null, scroll],
    });
    if (result?.frameId !== 0 || !result.documentId || (documentId && result.documentId !== documentId) || !result.result)
      throw new Error("Browser pointer document changed; read the page again");
    documentId = result.documentId;
    if (!result.result.visible || !result.result.focused) throw new Error("Browser pointer document is not visible and focused");
    return result.result;
  };
  await probe(true);
  if (ref) documentId = await waitForActionableRef(sessionId, args.tabId, ref, 5000, documentId);
  const point = await probe();
  const guard = async (geometry: boolean) => {
    const current = await assertTabInGroup(sessionId, args.tabId);
    const win = await chrome.windows.get(current.windowId);
    if (!current.active || !win.focused || win.state === "minimized") throw new Error("Browser pointer focus changed before dispatch");
    if (geometry) {
      const fresh = await probe();
      if (Math.abs(fresh.x - point.x) > 0.5 || Math.abs(fresh.y - point.y) > 0.5)
        throw new Error("Browser pointer target moved before dispatch");
    } else {
      // A mousedown handler may move/remove its own element. Release the button
      // at the same point only while the original document still owns the tab.
      const [same] = await executeScript({ target: { tabId: args.tabId, documentIds: [documentId!] },
        func: () => document.visibilityState === "visible" && document.hasFocus() });
      if (same?.frameId !== 0 || same.documentId !== documentId || same.result !== true)
        throw new Error("Browser pointer document changed before release");
    }
  };
  const button = args.action === "right_click" ? "right" : "left";
  let dispatched = false;
  const mouse = (type: string, clickCount: number) => cdpSend(args.tabId, "Input.dispatchMouseEvent",
    { type, x: point.x, y: point.y, button, clickCount, buttons: type === "mousePressed" ? (button === "right" ? 2 : 1) : 0 },
    async () => { await guard(type !== "mouseReleased"); dispatched = true; });
  try {
    await mouse("mouseMoved", 0);
    for (let click = 1; click <= count; click++) {
      await mouse("mousePressed", click);
      await mouse("mouseReleased", click);
    }
  } catch (error) {
    if (!dispatched) throw error;
    throw new Error(`Browser pointer stopped after dispatch; outcome may be partial. No fallback or replay was attempted. ${String((error as Error)?.message ?? error)}`);
  }
  return { ok: true, via: "browser-pointer", action: args.action, coordinate: [point.x, point.y], documentId };
}
