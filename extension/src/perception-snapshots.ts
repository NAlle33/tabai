import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { type PageNode } from "./perception-scripts";
import { bound, qualify, inject, documents, verifyDocuments } from "./perception-frames";
export type ReadArgs = { tabId: number; frameId?: number; maxResults?: number; maxChars?: number; mintRefs?: boolean };

type SnapshotNode = PageNode & { frameId: number; documentId: string; text: string };

type Snapshot = { frames: { frameId: number; documentId: string }[]; nodes: SnapshotNode[]; truncated: boolean;
  scrollPositions: { frameId: number; x: number; y: number; elements: number[][] }[] };

type DiffState = { sessionId: string; tabId: number; generation: number; snapshot?: Snapshot };

const baselines = new Map<string, DiffState>();

const MAX_BASELINES = 64;

export const MAX_NODES = 500;

export const MAX_CHARS = 80_000;



chrome.tabs.onRemoved.addListener(tabId => {
  for (const [key, state] of baselines) if (state.tabId === tabId) baselines.delete(key);
});
export function reapPerceptionState(sessionId: string): void {
  for (const [key, state] of baselines) if (state.sessionId === sessionId) baselines.delete(key);
}


function textOf(node: PageNode): string {
  return `[${node.ref}] ${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ""}${node.value !== undefined ? ` value=${JSON.stringify(node.value)}` : ""}` +
    `${node.checked === undefined ? "" : ` checked=${node.checked}`}${node.disabled ? " disabled" : ""}`;
}

export async function snapshot(sessionId: string, args: ReadArgs, filter: "interactive" | "all"): Promise<Snapshot> {
  const frames = await inject(sessionId, args.tabId, {
    mode: "scan", filter, maxResults: MAX_NODES, mint: args.mintRefs !== false,
  }, args.frameId);
  await verifyDocuments(sessionId, args.tabId, frames, args.frameId);
  const nodes: SnapshotNode[] = [];
  let chars = 0;
  let truncated = frames.some(frame => frame.result.truncated);
  // Round-robin frames so a large main document cannot hide every child frame.
  const depth = Math.max(...frames.map(frame => frame.result.nodes.length));
  for (let i = 0; i < depth; i++) for (const frame of frames) {
    const source = frame.result.nodes[i];
    if (!source) continue;
    const node = { ...source, ref: qualify(source.ref, frame.frameId) };
    const text = textOf(node);
    if (nodes.length >= MAX_NODES || chars + text.length > MAX_CHARS) { truncated = true; continue; }
    chars += text.length;
    nodes.push({ ...node, frameId: frame.frameId, documentId: frame.documentId, text });
  }
  return { frames: documents(frames), nodes, truncated, scrollPositions: frames.map(frame => ({
    frameId: frame.frameId, x: frame.result.viewport.scrollX, y: frame.result.viewport.scrollY,
    elements: frame.result.scrollPositions ?? [],
  })) };
}

export function trimNodes(nodes: SnapshotNode[], maxResults: number, maxChars: number): SnapshotNode[] {
  const selected: SnapshotNode[] = [];
  let chars = 0;
  for (const node of nodes) {
    if (selected.length >= maxResults || chars + node.text.length + 1 > maxChars) break;
    selected.push(node);
    chars += node.text.length + 1;
  }
  return selected;
}

export async function toolReadPageDiff(args: ReadArgs & { reset?: boolean }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const key = JSON.stringify([sessionId, args.tabId, args.frameId ?? "all"]);
  let state = baselines.get(key);
  if (!state) {
    state = { sessionId, tabId: args.tabId, generation: 0 };
    baselines.set(key, state);
  } else {
    baselines.delete(key);
    baselines.set(key, state); // bounded least-recently-used baseline cache
  }
  while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value!);
  const generation = ++state.generation;
  const previous = state.snapshot;
  const current = await snapshot(sessionId, args, "all");
  // Deletion by cleanup also invalidates pending calls; never resurrect a
  // reaped session or allow an older concurrent read to replace a newer one.
  if (baselines.get(key) !== state || generation !== state.generation) {
    return { ok: false, superseded: true, baseline: false, added: [], removed: [], changed: [], truncated: false,
      message: "A newer diff read or lifecycle cleanup superseded this snapshot; baseline was not changed." };
  }
  const resetReason = args.reset ? "requested" : !previous ? "initial" : JSON.stringify(previous.frames) !== JSON.stringify(current.frames) ? "documents_changed" : undefined;
  const nodeKey = (node: SnapshotNode) => `${node.frameId}/${node.documentId}/${node.ref}`;
  const oldNodes = new Map((resetReason ? [] : previous!.nodes).map(node => [nodeKey(node), node]));
  const newNodes = new Map(current.nodes.map(node => [nodeKey(node), node]));
  const added = current.nodes.filter(node => !oldNodes.has(nodeKey(node)));
  const changed = current.nodes.flatMap(node => {
    const before = oldNodes.get(nodeKey(node));
    return before && before.text !== node.text ? [{ before, after: node }] : [];
  });
  // Absence from a truncated snapshot does not prove removal.
  const removed = resetReason || current.truncated ? [] : previous!.nodes.filter(node => !newNodes.has(nodeKey(node)));
  const maxResults = bound(args.maxResults, 200, MAX_NODES);
  const maxChars = bound(args.maxChars, 12_000, MAX_CHARS);
  let used = 0;
  let chars = 0;
  const take = <T>(entries: T[]) => entries.filter(entry => {
    const size = JSON.stringify(entry).length;
    if (used >= maxResults || chars + size > maxChars) return false;
    used++; chars += size; return true;
  });
  const resultAdded = take(added);
  const resultChanged = take(changed);
  const resultRemoved = take(removed);
  state.snapshot = current;
  return { ok: true, baseline: !!resetReason, ...(resetReason ? { resetReason } : {}), generation, frames: current.frames,
    added: resultAdded, changed: resultChanged, removed: resultRemoved,
    truncated: current.truncated || resultAdded.length < added.length || resultChanged.length < changed.length || resultRemoved.length < removed.length,
    snapshotTruncated: current.truncated, previousSnapshotTruncated: previous?.truncated ?? false,
    removedOmitted: !resetReason && current.truncated,
    counts: { added: added.length, changed: changed.length, removed: removed.length } };
}
