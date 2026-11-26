import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { cdpSend, cssViewportClip } from "./cdp";
import { type PerceptionRect } from "./perception-scripts";
import { bound, inject, verifyDocuments } from "./perception-frames";
function near(a: number, b: number): boolean { return Math.abs(a - b) <= 1; }

export async function toolScreenshotMarked(args: { tabId: number; maxTargets?: number }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const gate = async () => { await assertTabInGroup(sessionId, args.tabId); };
  const frameIds = await inject(sessionId, args.tabId, { mode: "identity" });
  const maxTargets = bound(args.maxTargets, 50, 100);
  const [before] = await inject(sessionId, args.tabId, { mode: "marked", maxResults: maxTargets }, 0);
  const clip = await cssViewportClip(args.tabId);
  if (!clip) throw new Error("Cannot determine screenshot CSS viewport; numbered capture was not made.");
  const viewport = before.result.viewport;
  if (!near(clip.x, viewport.scrollX + viewport.visualX) || !near(clip.y, viewport.scrollY + viewport.visualY) ||
    !near(clip.width, viewport.visualWidth) || !near(clip.height, viewport.visualHeight) || viewport.scale !== 1) {
    throw new Error("Screenshot viewport changed or is pinch-zoomed; numbered capture requires a stable CSS viewport.");
  }
  const shot = await cdpSend<{ data: string }>(args.tabId, "Page.captureScreenshot", {
    format: "png", clip, captureBeyondViewport: true,
  }, gate);
  await gate();
  const [after] = await inject(sessionId, args.tabId, { mode: "marked", maxResults: maxTargets }, 0);
  const afterClip = await cssViewportClip(args.tabId);
  if (before.documentId !== after.documentId || JSON.stringify(before.result) !== JSON.stringify(after.result) || JSON.stringify(clip) !== JSON.stringify(afterClip)) {
    throw new Error("Document, viewport, or target layout changed during screenshot capture; no numbered image was returned. Wait for the page to settle.");
  }
  await verifyDocuments(sessionId, args.tabId, frameIds);
  if (!shot?.data) throw new Error("Page.captureScreenshot returned no image.");
  const bytes = Uint8Array.from(atob(shot.data), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    if (!near(bitmap.width, clip.width) || !near(bitmap.height, clip.height)) throw new Error("Screenshot pixels did not match the CSS viewport; mapping was discarded.");
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Cannot annotate screenshot: OffscreenCanvas 2D context unavailable.");
    ctx.drawImage(bitmap, 0, 0);
    ctx.font = "bold 14px sans-serif";
    ctx.textBaseline = "middle";
    const targets = before.result.nodes.map((node, index) => {
      const number = index + 1;
      const rect = node.rect!;
      const x = Math.max(0, rect.x - viewport.visualX);
      const y = Math.max(0, rect.y - viewport.visualY);
      const imageRect: PerceptionRect = { x, y, width: Math.max(0, Math.min(width, rect.x - viewport.visualX + rect.width) - x),
        height: Math.max(0, Math.min(height, rect.y - viewport.visualY + rect.height) - y) };
      const labelWidth = Math.ceil(ctx.measureText(String(number)).width) + 12;
      const labelRect = { x: Math.max(0, Math.min(width - labelWidth, Math.floor(x))), y: Math.max(0, Math.min(height - 22, Math.floor(y))), width: labelWidth, height: 22 };
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#e11d48";
      ctx.strokeRect(imageRect.x + 1, imageRect.y + 1, Math.max(0, imageRect.width - 2), Math.max(0, imageRect.height - 2));
      ctx.fillStyle = "#e11d48";
      ctx.fillRect(labelRect.x, labelRect.y, labelRect.width, labelRect.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(number), labelRect.x + 6, labelRect.y + 11);
      return { number, ref: node.ref, role: node.role, name: node.name, rect, imageRect, labelRect };
    });
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let i = 0; i < png.length; i += 8192) binary += String.fromCharCode(...png.subarray(i, i + 8192));
    await gate();
    const excluded = frameIds.filter(frame => frame.frameId !== 0).map(({ frameId, documentId }) => ({ frameId, documentId }));
    return { kind: "image", base64: btoa(binary), mimeType: "image/png", source: "cdp", width, height, targets,
      frameId: 0, documentId: before.documentId, viewport, truncated: before.result.truncated,
      coverage: { scope: "main-frame", includedFrames: [0], excludedFrames: excluded, excludedFrameCount: excluded.length,
        iframeElementCount: before.result.iframeCount, markedTargets: targets.length, visibleTargetCount: before.result.matchCount,
        note: "Child-frame targets are excluded: their local rectangles are not top-level screenshot coordinates." } };
  } finally { bitmap.close(); }
}
