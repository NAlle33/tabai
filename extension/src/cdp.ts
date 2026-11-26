// chrome.debugger / Chrome DevTools Protocol helper.
//
// Attaches lazily per tab and KEEPS the attachment (so the yellow "… is
// debugging this browser" banner stays up steadily instead of flickering on
// every call). Detaches when the tab closes or Chrome detaches us.
//
// Powers: reliable screenshots (Page.captureScreenshot — works even when the
// window is occluded), file_upload (DOM.setFileInputFiles), and trusted input
// (Input.dispatch* — isTrusted events native widgets respond to).

import { withoutPresence } from "./visual-presence";
import { traceTab } from "./diagnostics";

const PROTOCOL = "1.3";
const attached = new Set<number>();

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// ---- CDP event dispatch (for event-driven tools: dialog, download) ----------
type CdpEventHandler = (tabId: number, params: any) => void;
const eventHandlers = new Map<string, CdpEventHandler>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  const h = eventHandlers.get(method);
  if (h) {
    try {
      h(source.tabId, params);
    } catch {
      /* one bad event must not break the listener */
    }
  }
});

/** Register a single handler for a CDP event method (e.g. "Page.javascriptDialogOpening"). */
export function onCdpEvent(method: string, handler: CdpEventHandler): void {
  eventHandlers.set(method, handler);
}

// Runtime.disable invalidates the enable prerequisite of compileScript. Keep
// those short setup sequences together without serializing page evaluations.
const runtimeDomainWork = new Map<number, Promise<unknown>>();
export async function withRuntimeDomain<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = runtimeDomainWork.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  runtimeDomainWork.set(tabId, current);
  try { return await current; }
  finally { if (runtimeDomainWork.get(tabId) === current) runtimeDomainWork.delete(tabId); }
}

/** Tab ids the debugger is currently attached to. */
export function attachedTabIds(): number[] {
  return [...attached];
}

/** Release primitives act only on an attachment this extension already holds
 *  and never attach: releasing a tab must not attach it just to release it.
 *  Chrome refuses a command or a detach without that attachment ("not
 *  attached"). The attachment survives a worker restart and the in-memory set
 *  does not, so the set is not consulted here. */
export async function sendIfAttached(tabId: number, method: string): Promise<void> {
  await traceTab(tabId, "debugger.sendCommand", () => chrome.debugger.sendCommand({ tabId }, method));
}

/** Our own detach fires no onDetach event, so the cache is updated here. */
export async function detachTab(tabId: number): Promise<void> {
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId });
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await traceTab(tabId, "debugger.attach", () => new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Already attached (e.g. by us in a prior worker generation) is fine.
        if (/already attached/i.test(err.message || "")) {
          attached.add(tabId);
          resolve();
          return;
        }
        reject(
          new Error(
            `debugger attach failed: ${err.message}. (Close DevTools on that tab — only one debugger can attach.)`,
          ),
        );
        return;
      }
      attached.add(tabId);
      resolve();
    });
  }));
}

/** Optional gate for dispatching USER code: runs after attachment and again
 *  immediately before every send, including the one safe resend below. Throwing
 *  from it sends nothing, so an expired request or a tab that left its session's
 *  group cannot reach the page. Other callers pass nothing and keep their
 *  existing lazy-attachment behaviour. */
export type DispatchGuard = () => Promise<void> | void;

export async function cdpSend<T = any>(
  tabId: number,
  method: string,
  params?: object,
  guard?: DispatchGuard,
): Promise<T> {
  const send = () => sendCommand<T>(tabId, method, params, guard);
  return method === "Page.captureScreenshot" || method === "Page.printToPDF"
    ? withoutPresence(tabId, send) : send();
}

async function sendCommand<T>(tabId: number, method: string, params?: object, guard?: DispatchGuard): Promise<T> {
  await ensureAttached(tabId);
  if (guard) await guard();
  try {
    return (await traceTab(tabId, "debugger.sendCommand", () => chrome.debugger.sendCommand({ tabId }, method, params))) as T;
  } catch (error) {
    // Chrome can lose an attachment without delivering onDetach to this worker.
    // Only this pre-execution failure is safe to retry; never replay a command
    // after a generic transport error that may follow a completed mutation.
    if (!/not attached/i.test(String((error as Error)?.message ?? error))) throw error;
    attached.delete(tabId);
    await ensureAttached(tabId);
    if (guard) await guard();
    try {
      return (await traceTab(tabId, "debugger.sendCommand", () => chrome.debugger.sendCommand({ tabId }, method, params))) as T;
    } catch (retryError) {
      if (!/not attached/i.test(String((retryError as Error)?.message ?? retryError))) throw retryError;
      // "Already attached" may describe another debugger, not this extension.
      // A failed probe must not leave that foreign attachment in our cache.
      attached.delete(tabId);
      throw new Error(`Debugger is not attached to tab ${tabId}. Close DevTools or the other debugger on that tab, then retry.`);
    }
  }
}

/** The visual viewport as a Page.captureScreenshot clip: page coordinates
 *  (pageX/pageY are the scroll offsets), CSS-pixel size (clientWidth excludes a
 *  classic scrollbar), and scale 1/devicePixelRatio. A clip's `scale` multiplies
 *  the DEVICE-pixel rendering (verified on a DPR-2 display: scale 1 still gave
 *  2× the CSS width), so dividing by the ratio yields one image pixel per CSS
 *  pixel — the coordinate space `computer` clicks use. null when layout metrics
 *  are unavailable (caller falls back to an unclipped capture). */
export async function cssViewportClip(
  tabId: number,
): Promise<{ x: number; y: number; width: number; height: number; scale: number } | null> {
  const [m, dprRes] = await Promise.all([
    cdpSend<{
      cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
    }>(tabId, "Page.getLayoutMetrics"),
    cdpSend<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    }),
  ]);
  const vv = m?.cssVisualViewport;
  if (!vv || !(vv.clientWidth! > 0) || !(vv.clientHeight! > 0)) return null;
  const dpr = Number(dprRes?.result?.value);
  const scale = Number.isFinite(dpr) && dpr > 0 ? 1 / dpr : 1;
  return { x: vv.pageX ?? 0, y: vv.pageY ?? 0, width: vv.clientWidth!, height: vv.clientHeight!, scale };
}
