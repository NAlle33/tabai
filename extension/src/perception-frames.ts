import { executeScript } from "./diagnostics";
import { assertTabInGroup } from "./tab-group-helpers";
import { perceiveInPage, type PagePerception, type PerceptionOptions } from "./perception-scripts";
export type Frame = { frameId: number; documentId: string; result: PagePerception };


export function bound(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value!))) : fallback;
}

function target(tabId: number, frameId?: number): chrome.scripting.InjectionTarget {
  if (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId < 0)) throw new Error("frameId must be a non-negative integer");
  return frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
}

export function qualify(ref: string, frameId: number): string { return frameId ? `${ref}@${frameId}` : ref; }

export async function inject(sessionId: string, tabId: number, options: PerceptionOptions, frameId?: number, documentId?: string): Promise<Frame[]> {
  await assertTabInGroup(sessionId, tabId);
  const results = await executeScript({
    target: documentId ? { tabId, documentIds: [documentId] } : target(tabId, frameId),
    args: [options], func: perceiveInPage,
  });
  await assertTabInGroup(sessionId, tabId);
  if (!results.length || results.length > 64) throw new Error("Perception requires between 1 and 64 accessible frames; target a frameId explicitly for larger pages.");
  return results.map(r => {
    if (!r.documentId || !r.result || (frameId !== undefined && r.frameId !== frameId)) throw new Error("Page document changed or no perception result was returned.");
    return { frameId: r.frameId, documentId: r.documentId, result: r.result };
  }).sort((a, b) => a.frameId - b.frameId);
}

export function documents(frames: Frame[]): { frameId: number; documentId: string }[] {
  return frames.map(({ frameId, documentId }) => ({ frameId, documentId }));
}

export async function verifyDocuments(sessionId: string, tabId: number, frames: Frame[], frameId?: number): Promise<void> {
  const after = await inject(sessionId, tabId, { mode: "identity" }, frameId);
  if (JSON.stringify(documents(frames)) !== JSON.stringify(documents(after))) {
    throw new Error("Page documents changed during perception. Read the page again to obtain a coherent snapshot.");
  }
}

export function unique(frames: Frame[], what: string): Frame {
  if (frames.some(frame => frame.result.truncated)) throw new Error(`${what}: page traversal was truncated; uniqueness cannot be proved.`);
  const count = frames.reduce((sum, frame) => sum + frame.result.matchCount, 0);
  if (count !== 1) {
    const candidates = frames.flatMap(frame => frame.result.matches.map(({ role, name }) => ({ frameId: frame.frameId, role, name }))).slice(0, 10);
    throw new Error(`${what}: ${count ? `ambiguous (${count} visible matches)` : "no visible match"}. ${JSON.stringify(candidates)}`);
  }
  return frames.find(frame => frame.result.matchCount === 1)!;
}
