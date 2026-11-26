export interface AssistantMailFolder {
  id: string;
  name: string;
  url: string;
  kind: 'inbox' | 'sent' | 'custom';
  listRead: boolean;
}

/** Serialized into the page: only Zoho's own folder tree supplies navigation. */
export function assistantZohoFoldersScript(mode: 'read' | 'arm' = 'read') {
  const bodies = '.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"]';
  const visible = (e: Element) => {
    const rect = e.getBoundingClientRect(), style = getComputedStyle(e);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const roots = [...document.querySelectorAll('#zmlTree[role="group"]')].filter(e => !e.closest(bodies));
  const unavailable = (reason: string) => ({ folders: [], currentId: undefined, listReady: false, state: 'unknown-layout' as const, reason });
  if (roots.length !== 1) return unavailable(roots.length ? 'ambiguous-folder-tree' : 'missing-folder-tree');
  const folders: { id: string; name: string; url: string; kind: 'inbox' | 'sent' | 'custom' }[] = [];
  let currentId: string | undefined;
  for (const e of roots[0].querySelectorAll('.zmTreeNode[data-testid="lhs-tree-node"][role="treeitem"][id]')) {
    if (e.closest(bodies) || !/^\d{8,30}$/.test(e.id) || document.querySelectorAll(`[id="${e.id}"]`).length !== 1) continue;
    const name = (e.querySelector('.jsZmTreeText')?.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 200);
    if (!name) continue;
    const kind = /^(inbox|inkorg|inkorgen)$/i.test(name) ? 'inbox'
      : /^(sent|sent items|sänt|skickat|skickade objekt)$/i.test(name) ? 'sent' : 'custom';
    if (/^(drafts?|utkast|templates?|mallar|snoozed|uppskjutet|spam|junk|skräppost|trash|deleted items|borttaget|papperskorg|archive|arkivera|arkiv|outbox|utkorg)$/i.test(name)) continue;
    folders.push({ id: e.id, name, kind, url: `${location.origin}/zm/#mail/folder/${e.id}` });
    // Zoho keeps its native tree selected when the user collapses the sidebar.
    // Route, unique native identity and fresh list nodes still certify the folder.
    if (e.getAttribute('aria-selected') === 'true') {
      const route = location.hash.match(/^#mail\/folder\/([^/]+)(?:\/|$)/)?.[1];
      if (route === e.id || route === kind && kind !== 'custom') currentId = e.id;
    }
  }
  // Zoho selects the destination before replacing the old rows. Keep native
  // node identities in the isolated world; the route alone cannot certify them.
  const host = globalThis as typeof globalThis & { __ccmcpZohoFolderList?: { id?: string; nodes: Element[] } };
  const panes = [...document.querySelectorAll('#jstab-zm_Container[role="tabpanel"]')].filter(e => !e.closest(bodies));
  const pane = panes.length === 1 ? panes[0] : undefined;
  if (!pane || !folders.length) return unavailable(!pane ? 'missing-mail-pane' : 'unknown-folder-nodes');
  const nodes = [...(pane?.querySelectorAll('div.zmList[role="option"][data-ty][aria-controls],.zmNoMail,[data-testid="empty-message-list"]') ?? [])]
    .filter(e => !e.closest(bodies) && visible(e));
  if (mode === 'arm' && !host.__ccmcpZohoFolderList) host.__ccmcpZohoFolderList = { id: currentId, nodes };
  const previous = host.__ccmcpZohoFolderList;
  const oldListRemains = previous && previous.id !== currentId && previous.nodes.some(e => e.isConnected);
  // The native loading line can have zero dimensions while still aria-busy.
  const busy = [...(pane?.querySelectorAll('[aria-busy="true"]') ?? [])].some(e => !e.closest(bodies));
  const listReady = !!currentId && nodes.length > 0 && !busy && !oldListRemains;
  if (listReady) host.__ccmcpZohoFolderList = { id: currentId, nodes };
  const state = listReady ? 'ready' as const : busy || !nodes.length ? 'loading' as const : 'selection-transition' as const;
  return { folders, currentId, listReady, state,
    reason: listReady ? 'ready' : busy ? 'busy' : !currentId ? 'selection-route-mismatch' : oldListRemains ? 'previous-list' : 'list-not-rendered' };
}
