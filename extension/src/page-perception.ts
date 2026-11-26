import { assertTabInGroup, sessionOf } from "./tab-group-helpers";
import { type PerceptionOptions } from "./perception-scripts";
import { bound, qualify, inject, documents, verifyDocuments, unique } from "./perception-frames";
import { snapshot, trimNodes, MAX_NODES, MAX_CHARS, type ReadArgs } from "./perception-snapshots";
import { parseRef } from './element-ref';
export async function toolResolveTarget(args: { tabId: number; target?: { selector?: string; role?: string; name?: string; frameId?: number }; describeRef?: string; documentId?: string }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  if (args.describeRef !== undefined) {
    if (args.target !== undefined) throw new Error('Choose target or describeRef, not both.');
    const { base, frameId } = parseRef(args.describeRef);
    const [before] = await inject(sessionId, args.tabId, { mode: 'describe', describeRef: base, mint: false }, frameId, args.documentId);
    const description = before.result.recordingTarget;
    if (!description) throw new Error('Recording target could not be described.');
    let target: { selector: string } | { role: string; name: string } | undefined;
    let matchedDocuments: ReturnType<typeof documents> | undefined;
    for (const candidate of description.candidates) {
      try {
        const frames = await inject(sessionId, args.tabId, { mode: 'resolve', ...candidate, mint: false });
        const match = unique(frames, 'recording target');
        if (match.documentId === before.documentId && match.frameId === frameId && match.result.matches[0]?.ref === base) {
          target = candidate; matchedDocuments = documents(frames); break;
        }
      } catch { /* an ambiguous candidate is not a reusable target */ }
    }
    const [after] = await inject(sessionId, args.tabId, { mode: 'describe', describeRef: base, mint: false }, frameId, before.documentId);
    if (JSON.stringify(description) !== JSON.stringify(after.result.recordingTarget)) throw new Error('Recording target changed during inspection.');
    if (target) {
      const frames = await inject(sessionId, args.tabId, { mode: 'resolve', ...target, mint: false });
      const match = unique(frames, 'recording target');
      if (JSON.stringify(documents(frames)) !== JSON.stringify(matchedDocuments) || match.documentId !== before.documentId
        || match.frameId !== frameId || match.result.matches[0]?.ref !== base) throw new Error('Recording target changed during inspection.');
    }
    return { ok: true, ref: args.describeRef, frameId, documentId: before.documentId,
      recordingTarget: { ...(target ? { target } : {}), sensitive: description.sensitive,
        role: description.role, name: description.name, ...(description.fieldType ? { fieldType: description.fieldType } : {}),
        ...(frameId === 0 && target && 'selector' in target && description.fieldSelectors.includes(target.selector) ? { fieldSelector: target.selector } : {}) } };
  }
  if (args.documentId !== undefined) throw new Error('documentId is only accepted with describeRef.');
  const query = args.target;
  if (!query || (query.selector !== undefined ? !query.selector.trim() || query.role !== undefined || query.name !== undefined : !query.role || typeof query.name !== "string")) {
    throw new Error("resolve_target needs either a non-empty selector or an exact role and name, never both.");
  }
  const options: PerceptionOptions = { mode: "resolve", ...(query.selector !== undefined ? { selector: query.selector } : { role: query.role, name: query.name }) };
  const frames = await inject(sessionId, args.tabId, options, query.frameId);
  const match = unique(frames, "resolve_target");
  const [resolved] = await inject(sessionId, args.tabId, { ...options, mint: true }, match.frameId, match.documentId);
  if (resolved.documentId !== match.documentId || !resolved.result.nodes[0] || resolved.result.matchCount !== 1) throw new Error("Target changed during resolution; resolve it again.");
  // Recheck global uniqueness after minting. A late replacement must not turn
  // this response into a ref to an element that was never uniquely matched.
  const after = await inject(sessionId, args.tabId, options, query.frameId);
  const stable = unique(after, "resolve_target");
  const node = resolved.result.nodes[0];
  if (JSON.stringify(documents(frames)) !== JSON.stringify(documents(after)) || stable.documentId !== match.documentId ||
    stable.frameId !== match.frameId || stable.result.matches[0]?.ref !== node.ref) throw new Error("Target or document changed during resolution; resolve it again.");
  return { ok: true, ref: qualify(node.ref, match.frameId), frameId: match.frameId, documentId: match.documentId, role: node.role, name: node.name };
}


export async function toolExtractTable(args: { tabId: number; selector?: string; frameId?: number; maxRows?: number; maxColumns?: number }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const options: PerceptionOptions = { mode: "table", ...(args.selector === undefined ? {} : { selector: args.selector }),
    maxRows: bound(args.maxRows, 100, 1000), maxColumns: bound(args.maxColumns, 30, 100) };
  const frames = await inject(sessionId, args.tabId, options, args.frameId);
  const match = unique(frames, "extract_table");
  const [extracted] = await inject(sessionId, args.tabId, { ...options, mint: true }, match.frameId, match.documentId);
  if (extracted.documentId !== match.documentId || !extracted.result.table || !extracted.result.nodes[0]) throw new Error("Table changed during extraction; extract it again.");
  await verifyDocuments(sessionId, args.tabId, frames, args.frameId);
  return { ok: true, ...extracted.result.table, ref: qualify(extracted.result.nodes[0].ref, match.frameId), frameId: match.frameId, documentId: match.documentId,
    spans: "expanded", note: "One leading header row is used for columns; absent headers receive Column N names. Native and ARIA spans repeat cell text." };
}

export async function toolReadPageCompact(args: ReadArgs & { filter?: "interactive" | "all" }) {
  const sessionId = sessionOf(args);
  await assertTabInGroup(sessionId, args.tabId);
  const current = await snapshot(sessionId, args, args.filter ?? "interactive");
  const nodes = trimNodes(current.nodes, bound(args.maxResults, 200, MAX_NODES), bound(args.maxChars, 12_000, MAX_CHARS));
  return { ok: true, compact: true, filter: args.filter ?? "interactive", elements: nodes.map(node => node.text).join("\n") || "(no matching elements)",
    count: nodes.length, frames: current.frames, scrollPositions: current.scrollPositions,
    truncated: current.truncated || nodes.length < current.nodes.length };
}
