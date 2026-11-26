// gif_creator — records the tab as frames (CDP screenshots on a timer) and
// encodes them to an animated GIF in the service worker (OffscreenCanvas to
// decode/downscale + gifenc to encode). No Node-side image deps; only the
// finished GIF crosses the bridge.
//
// PER SESSION: recordings are keyed by sessionId, so export/stop/clear act ONLY
// on the caller's own recording and can never read another session's frames.

import { cdpSend } from "./cdp";
import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

const MAX_FRAMES = 60;
const INTERVAL_MS = 500;
const NO_RECORDING = "No frames recorded for this session — recordings live in the service worker's memory and are lost if it idles for 30 s; record and export in one flow";

interface RecState {
  active: boolean;
  frames: string[]; // base64 JPEGs
  timer: ReturnType<typeof setInterval> | null;
  tabId: number;
  groupId: number; // the MCP group the recording tab belonged to (re-checked per frame)
  capture?: Promise<void>;
}
const recordings = new Map<string, RecState>();

async function captureFrame(sessionId: string, state: RecState): Promise<void> {
  if (recordings.get(sessionId) !== state || state.frames.length >= MAX_FRAMES) return;
  if (state.capture) return state.capture;
  const capture = takeFrame(sessionId, state);
  state.capture = capture;
  try { await capture; } finally { if (state.capture === capture) state.capture = undefined; }
}

async function takeFrame(sessionId: string, state: RecState): Promise<void> {
  const { tabId, groupId: recGroup } = state;
  try {
    // Trust-boundary choke point: only capture while the tab is still in the
    // recording's MCP group, with its current session identity still verified.
    const tab = await assertTabInGroup(sessionId, tabId);
    if (tab.groupId !== recGroup || recordings.get(sessionId) !== state) return;
    const shot = await cdpSend<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
    });
    if (shot?.data && recordings.get(sessionId) === state && state.frames.length < MAX_FRAMES) {
      const current = await assertTabInGroup(sessionId, tabId);
      if (current.groupId === recGroup && recordings.get(sessionId) === state) state.frames.push(shot.data);
    }
  } catch {
    /* skip a frame if the tab left the group / closed / capture transiently fails */
  }
}

export async function toolGifCreator(args: {
  action: string;
  tabId: number;
  maxWidth?: number;
  delayMs?: number;
}): Promise<unknown> {
  const sessionId = sessionOf(args);
  switch (args.action) {
    case "start_recording": {
      // Trust boundary: gif_creator attaches the debugger + screenshots the tab,
      // so the recording target must be THIS session's MCP-group tab. (export/
      // stop/clear touch no tab but ARE session-scoped below.) captureFrame
      // re-checks current session ownership before and after every frame.
      const recTab = await assertTabInGroup(sessionId, args.tabId);
      const prev = recordings.get(sessionId);
      if (prev?.timer) clearInterval(prev.timer);
      const state: RecState = {
        active: true,
        frames: [],
        timer: null,
        tabId: args.tabId,
        groupId: recTab.groupId,
      };
      recordings.set(sessionId, state);
      await captureFrame(sessionId, state);
      if (recordings.get(sessionId) !== state || !state.active) return { ok: true, recording: false };
      state.timer = setInterval(() => {
        if (recordings.get(sessionId) !== state || !state.active) return;
        if (state.frames.length >= MAX_FRAMES) {
          // Cap reached — stop the capture loop. Otherwise a forgotten recording
          // keeps the 500ms timer firing forever, pinning the MV3 service worker
          // awake and holding the debugger attachment.
          if (state.timer) clearInterval(state.timer);
          state.timer = null;
          state.active = false;
          return;
        }
        void captureFrame(sessionId, state);
      }, INTERVAL_MS);
      return { ok: true, recording: true };
    }
    case "stop_recording": {
      const state = recordings.get(sessionId);
      if (!state) throw new Error(NO_RECORDING);
      if (state?.timer) clearInterval(state.timer);
      if (state) {
        state.active = false;
        state.timer = null;
        await state.capture;
        await captureFrame(sessionId, state); // final frame (from the recording tab)
      }
      return { ok: true, frames: state?.frames.length ?? 0 };
    }
    case "clear": {
      const state = recordings.get(sessionId);
      if (state?.timer) clearInterval(state.timer);
      recordings.delete(sessionId);
      return { ok: true, cleared: true };
    }
    case "export": {
      const state = recordings.get(sessionId);
      if (!state || state.frames.length === 0) {
        throw new Error(NO_RECORDING);
      }
      const maxW = args.maxWidth ?? 640;
      const delay = args.delayMs ?? INTERVAL_MS;
      const enc = GIFEncoder();
      let encoded = 0;
      for (const b64 of state.frames) {
        let bmp: ImageBitmap | undefined;
        try {
          const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
          bmp = await createImageBitmap(blob);
          const w = Math.min(bmp.width, maxW);
          const h = Math.round((bmp.height * w) / bmp.width);
          const canvas = new OffscreenCanvas(w, h);
          const cx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
          cx.drawImage(bmp, 0, 0, w, h);
          const { data } = cx.getImageData(0, 0, w, h);
          const palette = quantize(data, 256);
          const index = applyPalette(data, palette);
          enc.writeFrame(index, w, h, { palette, delay });
          encoded++;
        } catch {
          /* skip a corrupt/undecodable frame instead of aborting the whole GIF */
        } finally {
          bmp?.close(); // free the bitmap on every path (was leaked on a throw)
        }
        // Encoding is synchronous CPU work; yield so control/event messages can
        // run between frames instead of blocking the worker for the whole GIF.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (encoded === 0) throw new Error("No frames could be encoded into a GIF.");
      enc.finish();
      const bytes = enc.bytes();
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { kind: "gif", base64: btoa(bin), frames: encoded };
    }
    default:
      throw new Error(`Unknown gif_creator action: ${args.action}`);
  }
}

/** Stop + drop a session's recording when its session is reaped (clears the
 *  capture timer so it doesn't keep spinning after the session is gone). */
export function reapGifState(sessionId: string): void {
  const s = recordings.get(sessionId);
  if (s?.timer) clearInterval(s.timer);
  recordings.delete(sessionId);
}
