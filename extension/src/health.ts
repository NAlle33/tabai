import { BUILD_ID } from "../../shared/build-info";
import { attachedTabIds } from "./cdp";
import { diagnosticSnapshot } from "./diagnostics";
import { lookupGroupId, tabsInGroup } from "./tab-group-helpers";

type Inspection = { groupId: number | null; tabsInGroup: number; attachedTabs: number[] };
const inspections = new Map<string, Promise<Inspection | undefined>>();
export function reapHealth(sessionId: string): void { inspections.delete(sessionId); }

/** One read-only inspection per session, even if Chrome never answers. Health
 *  must still expose the pending operation rather than waiting behind it. */
function inspect(sessionId: string): Promise<Inspection | undefined> {
  const existing = inspections.get(sessionId);
  if (existing) return existing;
  if (inspections.size >= 128) return Promise.resolve(undefined);
  const actual = (async () => {
    // Read-only: health neither records tabs nor waits for the group write lock.
    const groupId = await lookupGroupId(sessionId);
    const tabs = groupId == null ? [] : await tabsInGroup(groupId, sessionId);
    const ownTabs = new Set(tabs.map(tab => tab.id));
    return { groupId, tabsInGroup: tabs.length, attachedTabs: attachedTabIds().filter(id => ownTabs.has(id)) };
  })();
  let timer: ReturnType<typeof setTimeout>;
  const bounded = Promise.race([actual, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 500); })])
    .catch(() => undefined).finally(() => clearTimeout(timer));
  inspections.set(sessionId, bounded);
  const clear = () => { if (inspections.get(sessionId) === bounded) inspections.delete(sessionId); };
  void actual.then(clear, clear);
  return bounded;
}

export async function extensionHealth(sessionId: string) {
  const inspection = await inspect(sessionId);
  return {
    extVersion: chrome.runtime.getManifest().version,
    buildId: BUILD_ID,
    capabilities: { diagnostics: 1, browserPointer: 1 },
    ...(inspection ?? { groupId: null, tabsInGroup: 0, attachedTabs: [] }),
    inspection: inspection ? "available" : "unavailable",
    diagnostics: diagnosticSnapshot(sessionId),
  };
}
