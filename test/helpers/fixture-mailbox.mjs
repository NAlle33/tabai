// A local Gmail-shaped mailbox for host tests: an inbox list, threads and Sent,
// served through a real AssistantBrowser whose transport and page functions are
// replaced. No real mailbox, extension or browser is involved. The page side
// returns what the host's page functions would report for this mailbox: rows
// with their native thread and last-message ids, read state and full date,
// and complete, ordered threads with each message's sender.

const HOUR = 3_600_000, DAY = 86_400_000;
export const fixtureTime = { HOUR, DAY };

/**
 * `threads`: { id (route token, 12+ chars), legacy, subject, at (ms), unread?, folder?: 'inbox' | 'sent',
 * chronological?: false (the page cannot show the messages in order),
 * messages: [{ id, from, body, complete?: false (a collapsed message) }] }. Rows are listed newest first, like an inbox.
 * Options: `rows` replaces the native row fields (for layouts that expose less).
 */
export function attachFixtureMailbox(browser, account, threads, options = {}) {
  const tabId = options.tabId ?? 1;
  let created = false, current = 'about:blank', searchQuery = '', searchFocused = false;
  const refs = new Map();
  const base = () => { const url = new URL(current.startsWith('https:') ? current : account.url); url.hash = ''; return url.href; };
  const route = () => {
    const hash = current.startsWith('https:') ? decodeURIComponent(new URL(current).hash.slice(1)) : '';
    const [folder, id] = hash.split('/');
    return { folder: folder || 'inbox', id };
  };
  const listed = folder => threads.filter(thread => (thread.folder ?? 'inbox') === folder || folder === 'sent' && thread.messages.some(message => message.from === account.email))
    .sort((first, second) => second.at - first.at);
  // A folder list, or a search such as "in:sent newer_than:1h" (Gmail's own operators).
  const listing = () => {
    const { folder, id } = route();
    if (folder !== 'search') return { folder, threads: listed(folder) };
    const area = /\bin:sent\b/.test(id) ? 'sent' : 'inbox', window = /\bnewer_than:(\d+)([hd])\b/.exec(id);
    const since = window ? Date.now() - Number(window[1]) * (window[2] === 'h' ? HOUR : DAY) : -Infinity;
    return { folder: area, threads: listed(area).filter(thread => thread.at >= since) };
  };
  const time = at => new Date(at).toISOString().slice(11, 16);
  const rowFields = (thread, index) => {
    const last = thread.messages.at(-1);
    const native = { ref: `ref_${20 + index}`, thread: thread.legacy, last: last.id, unread: thread.unread ?? false, at: new Date(thread.at).toISOString(),
      text: `${thread.messages[0].from} ${thread.subject} - ${last.body.slice(0, 40)} ${time(thread.at)}` };
    return options.rows ? options.rows(native, thread) : native;
  };
  const page = () => {
    const { folder, id } = route(), nav = '[ref_1] searchbox "Sök i e-post"\n[ref_2] link "Inkorgen"\n[ref_3] link "Skickat"';
    if (id && folder !== 'search') return { elements: `${nav}\n[ref_5] button "Svara"` };
    refs.clear();
    const shown = listing();
    const lines = shown.threads.map((thread, index) => { const ref = `ref_${20 + index}`; refs.set(ref, { thread, folder: shown.folder }); return `[${ref}] row "${thread.subject}"`; });
    return { elements: [nav, ...lines].join('\n') };
  };
  const metadata = () => {
    const { folder, id } = route();
    if (!id || folder === 'search') {
      const shown = listing(), areas = [shown.folder === 'sent' ? 'sent' : 'inbox'], rows = shown.threads.map(rowFields);
      return { nativeThread: null, nativeMessage: null, scopeText: '', areas, view: rows.length ? 'list' : 'empty', truncated: false, historyComplete: false, messages: [], chronological: false, rows };
    }
    const areas = [folder === 'sent' ? 'sent' : 'inbox'], thread = threads.find(entry => entry.id === id);
    if (!thread) throw new Error(`Fixture thread ${id} is missing`);
    const messages = thread.messages.map(message => ({ nativeId: message.id, sender: message.from, body: message.body, complete: message.complete ?? true }));
    const scopeText = `${thread.subject}\n${thread.messages.map(message => `Från: ${message.from}\nTill: ${message.from === account.email ? thread.messages[0].from : account.email}\n${message.body}`).join('\n')}\nE-postadresser i meddelandets rubrik: ${[...new Set(thread.messages.map(message => message.from))].join(', ')}`;
    // As the page function reports it: the history is complete only when every message is, and only a complete history is ordered.
    const historyComplete = messages.every(message => message.complete);
    return { nativeThread: null, nativeMessage: thread.messages.at(-1).id, scopeText, areas, view: 'detail', truncated: false, historyComplete, messages, chronological: historyComplete && thread.chronological !== false };
  };
  browser.call = async (name, args = {}) => {
    if (name === 'tabs_context_mcp') return { tabs: created ? [{ tabId, url: current }] : [] };
    if (name === 'tabs_create_mcp') { created = true; return { tabId }; }
    if (name === 'navigate') { current = args.url; return {}; }
    if (name === 'tab_switch' || name === 'wait_for') return {};
    if (name === 'read_page') return page();
    if (name === 'resolve_target') return { ref: /data-ccmcp-ref="([^"]+)"/.exec(args.target.selector)?.[1], documentId: 'fixture-document' };
    if (name === 'form_input' && args.ref === 'ref_1') { searchQuery = args.value; return {}; }
    if (name === 'computer' && args.action === 'scroll') return {};
    if (name === 'computer' && args.action === 'key' && args.text === 'Enter' && searchFocused) {
      const url = new URL(base()); url.hash = `search/${encodeURIComponent(searchQuery)}`; current = url.href;
      return {};
    }
    if (name === 'computer' && args.action === 'left_click') {
      if (args.ref === 'ref_1') { searchFocused = true; return {}; }
      searchFocused = false;
      if (args.ref === 'ref_2' || args.ref === 'ref_3') {
        const url = new URL(base()); url.hash = args.ref === 'ref_2' ? 'inbox' : 'sent'; current = url.href;
        return {};
      }
      const row = refs.get(args.ref);
      if (!row) throw new Error(`Fixture click on unknown ref ${args.ref}`);
      // Opening a thread marks it read, as the provider does.
      row.thread.unread = false;
      const url = new URL(base()); url.hash = `${row.folder}/${row.thread.id}`; current = url.href;
      return {};
    }
    throw new Error(`Unexpected fixture mailbox call ${name}`);
  };
  browser.script = async (_tabId, fn, args = []) => {
    if (fn.name === 'loadingScript') return false;
    if (fn.name === 'identityScript') return [account.email];
    if (fn.name === 'identityMenuScript') return false;
    if (fn.name === 'messageMetadataScript') return metadata();
    if (!fn.name && args[0] === 'ref_1') return searchFocused;
    if (fn.name === 'elementScript') {
      const row = refs.get(args[0]);
      if (args[0] === 'ref_1') return { visible: true, label: 'Sök i e-post', text: '', type: 'INPUT', role: 'searchbox', href: null, row: false, body: false, search: true, messageContent: false, readingControl: false, bodyContent: false };
      if (args[0] === 'ref_2' || args[0] === 'ref_3') {
        const folder = args[0] === 'ref_2' ? 'inbox' : 'sent', label = folder === 'inbox' ? 'Inkorgen' : 'Skickat';
        const url = new URL(base()); url.hash = folder;
        return { visible: true, label, text: label, type: 'A', role: 'link', href: url.href, row: false, body: false, search: false, messageContent: false, readingControl: false, bodyContent: false };
      }
      return row ? { visible: true, label: '', text: row.thread.subject, type: 'TR', role: 'row', href: null, row: true, body: false, search: false, messageContent: false, readingControl: false, bodyContent: false }
        : { visible: true, label: 'Inkorgen', text: 'Inkorgen', type: 'A', role: 'link', href: null, row: false, body: false, search: false, messageContent: false, readingControl: false, bodyContent: false };
    }
    throw new Error(`Unexpected fixture mailbox page function ${fn.name}`);
  };
  return {
    tabId,
    /** The URL of a thread in a folder, as the provider routes it. */
    url: (thread, folder = 'inbox') => { const url = new URL(base()); url.hash = thread ? `${folder}/${thread.id}` : folder; return url.href; },
    /** A search results route, for example "in:sent newer_than:1h". */
    search: query => { const url = new URL(base()); url.hash = `search/${encodeURIComponent(query)}`; return url.href; },
    /** The current row ref of a thread in the latest list read. */
    ref: thread => [...refs].find(([, row]) => row.thread === thread)?.[0],
  };
}
