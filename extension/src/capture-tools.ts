import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { cdpSend, cssViewportClip } from "./cdp";
import { withoutPresence } from "./visual-presence";
import { deepByAttrExpr, parseRef, evaluateRefInTab } from "./element-ref";
import { assertAgentFocusAllowed } from "./agent-focus";
export async function captureComputerScreenshot(sessionId: string, args: { tabId: number; allowFocus?: boolean }) {
      // Prefer CDP Page.captureScreenshot — captures the renderer surface (works
      // even occluded/minimized) and avoids the focus-stealing captureVisibleTab.
      // Retry a transient CDP failure before considering the visible-tab path.
      for (let cdpAttempt = 0; cdpAttempt < 2; cdpAttempt++) {
        try {
          // Clip to the visual viewport in CSS pixels (scale 1) so a coordinate
          // read off this image is the coordinate `computer` clicks use — an
          // unclipped capture is device pixels (2× off on a scaled display).
          const clip = await cssViewportClip(args.tabId);
          // Race against a timeout — CDP captureScreenshot can occasionally hang.
          const shot = await Promise.race([
            cdpSend<{ data: string }>(args.tabId, "Page.captureScreenshot", {
              format: "png",
              ...(clip ? { clip, captureBeyondViewport: true } : { captureBeyondViewport: false }),
            }),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("cdp screenshot timed out")), 6000),
            ),
          ]);
          if (shot?.data) {
            return { kind: "image", base64: shot.data, mimeType: "image/png", source: "cdp" };
          }
        } catch {
          /* retry once, then fall back to captureVisibleTab below */
        }
      }
      // captureVisibleTab needs the target selected in a composited window.
      // Focus changes are opt-in: a failed screenshot must not silently interrupt
      // the user's work. An essential capture can retry with allowFocus:true.
      let dataUrl = "";
      let lastErr = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        const target = await assertTabInGroup(sessionId, args.tabId);
        const window = await chrome.windows.get(target.windowId);
        if (args.allowFocus === true && (!target.active || !window.focused || window.state === "minimized")) {
          await assertAgentFocusAllowed();
          try {
            // Chrome can reject edits transiently while the user drags a tab.
            await chrome.tabs.update(args.tabId, { active: true });
            await chrome.windows.update(target.windowId, {
              focused: true,
              state: "normal",
            });
          } catch (e: any) {
            lastErr = String(e?.message ?? e);
          }
        }
        await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 450));
        const current = await assertTabInGroup(sessionId, args.tabId);
        const win = await chrome.windows.get(current.windowId);
        if (!current.active || !win.focused || win.state === "minimized") {
          if (args.allowFocus !== true) {
            throw new Error("Background screenshot unavailable: CDP capture failed and the visible-tab fallback needs focus. If the screenshot is essential, retry computer screenshot with allowFocus:true; otherwise use read_page or get_page_text.");
          }
          lastErr = "target tab is not visible in a focused window";
          continue;
        }
        try {
          dataUrl = await withoutPresence(args.tabId, () => chrome.tabs.captureVisibleTab(current.windowId, {
            format: "png",
          }));
          if (!dataUrl || !dataUrl.startsWith("data:image")) {
            lastErr = "empty data url";
            continue;
          }
          // captureVisibleTab grabs whatever tab is ACTIVE in the window. If the
          // user switches tabs during capture, the image could be another tab's
          // — never return it as ours.
          const [active] = await chrome.tabs.query({ active: true, windowId: current.windowId });
          if (active?.id !== args.tabId) {
            lastErr = "captured tab was not the target";
            dataUrl = "";
            continue;
          }
          break;
        } catch (e: any) {
          lastErr = String(e?.message ?? e);
        }
      }
      if (!dataUrl || !dataUrl.startsWith("data:image")) {
        throw new Error(`captureVisibleTab failed after retries: ${lastErr}`);
      }
      return {
        kind: "image",
        base64: dataUrl.replace(/^data:image\/[a-z]+;base64,/, ""),
        mimeType: "image/png",
        source: "captureVisibleTab",
      };

}


// ---- screenshot (element / region / full) -----------------------------------

/** Downscale a base64 image to maxWidth via OffscreenCanvas (runs in the SW).
 *  Returns null if it's already ≤ maxWidth (caller keeps the original). */
async function downscaleImage(
  b64: string,
  mime: string,
  maxWidth: number,
  quality: number,
): Promise<string | null> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    if (bmp.width <= maxWidth) return null;
    const w = maxWidth;
    const h = Math.max(1, Math.round((bmp.height * maxWidth) / bmp.width));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({
      type: mime,
      ...(mime === "image/jpeg" ? { quality: quality / 100 } : {}),
    });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return btoa(bin);
  } finally {
    bmp.close();
  }
}


export async function toolScreenshot(args: {
  tabId: number;
  ref?: string;
  region?: [number, number, number, number];
  format?: "png" | "jpeg";
  quality?: number;
  maxWidth?: number;
}) {
  await assertTabInGroup(sessionOf(args), args.tabId);
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (args.region) {
    const [x, y, width, height] = args.region;
    if (
      ![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("screenshot region must be [x, y, width, height] with width > 0 and height > 0");
    }
    clip = { x, y, width, height, scale: 1 };
  } else if (args.ref) {
    const { base, frameId } = parseRef(args.ref);
    if (frameId !== 0) {
      // getBoundingClientRect would be frame-relative but the clip is page-level
      // → wrong region. Reject rather than capture the wrong spot silently.
      throw new Error(
        "screenshot by ref is only supported for main-frame elements; use `region` for sub-frame content",
      );
    }
    // Element rect in PAGE coordinates (viewport rect + scroll) so the clip is
    // correct even when the element is scrolled off-screen (captureBeyondViewport).
    const expr = `(()=>{const e=${deepByAttrExpr(
      base,
    )};if(!e)return null;const r=e.getBoundingClientRect();const sx=window.scrollX||window.pageXOffset||0,sy=window.scrollY||window.pageYOffset||0;return {x:r.left+sx,y:r.top+sy,width:r.width,height:r.height};})()`;
    const rr = await evaluateRefInTab<any>(args.tabId, args.ref, expr);
    const v = rr?.result?.value;
    if (!v) throw new Error(`No element for ${args.ref}. Call read_page/find first.`);
    clip = { x: v.x, y: v.y, width: v.width, height: v.height, scale: 1 };
  } else {
    // Viewport capture in CSS pixels (scale 1) — the coordinate space `computer`
    // clicks use; an unclipped capture is device pixels on a scaled display.
    clip = (await cssViewportClip(args.tabId)) ?? undefined;
  }
  const format = args.format === "png" ? "png" : "jpeg"; // default jpeg — far smaller payloads
  const quality =
    typeof args.quality === "number" ? Math.max(1, Math.min(100, args.quality)) : 80;
  const shot = await cdpSend<{ data: string }>(args.tabId, "Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality } : {}),
    ...(clip ? { clip, captureBeyondViewport: true } : { captureBeyondViewport: false }),
  });
  if (!shot?.data) throw new Error("Page.captureScreenshot returned no data");
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  let base64 = shot.data;
  if (typeof args.maxWidth === "number" && args.maxWidth > 0) {
    try {
      const smaller = await downscaleImage(base64, mimeType, args.maxWidth, quality);
      if (smaller) base64 = smaller;
    } catch {
      /* downscale is best-effort — keep the full-size capture on any failure */
    }
  }
  return { kind: "image", base64, mimeType, source: "cdp" };
}
