import { join } from 'node:path';
import * as z from 'zod';
import type { AssistantAccount, AssistantSendApproval } from '../shared/assistant';
import { assistantHtmlText } from './assistant-gmail-print';
import { isMissing, readPrivateFile } from './private-storage';

/**
 * Reads a Zoho mailbox through its REST API, which holds the folders, complete
 * conversations and Sent mail that the web app only renders in a visible tab, and
 * sends approved replies through it. Credentials stay in this host process: errors
 * and results never contain them. Reading and sending use separate grants, each fixed
 * when its private file is created, so a run that only reads holds no token that can send.
 */
const READ_GRANT = 'zoho-mail-oauth.json', SEND_GRANT = 'zoho-mail-oauth-send.json';
const credentialSchema = z.object({
  clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(500), refreshToken: z.string().min(1).max(1000),
  accountsServer: z.string().regex(/^https:\/\/accounts\.zoho\.(?:com|eu|in|com\.au|jp|com\.cn|ca|sa)$/),
}).passthrough();
const THREAD_LIMIT = 200, PAGE_SIZE = 200, PAGE_LIMIT = 25;
// Mail that exists in the conversation. An unsent or unknown item could read as a reply.
const DELIVERED_FOLDERS = new Set(['Inbox', 'Sent', 'Archive', 'Trash', 'Spam', 'Snoozed']);
// Mail moved to Trash or Spam after the approval is no longer something to answer.
const REPLYABLE_FOLDERS = new Set(['Inbox', 'Archive', 'Snoozed']);
const STALE_REPLY = 'Konversationen har ändrats eller kunde inte bekräftas. Kör kontrollen igen och svara direkt i Zoho om samma kort kommer tillbaka.';

export class AssistantZohoApiError extends Error {
  constructor(readonly code: 'account-mismatch' | 'request' | 'unknown-thread' | 'refused' | 'uncertain', message: string) { super(message); this.name = 'AssistantZohoApiError'; }
}
export interface AssistantZohoRow { key: string; version: string; at: string; unread: boolean; label: string }
export interface AssistantZohoInventory { email: string; rows: AssistantZohoRow[]; sentThreads: string[]; complete: boolean }
export interface AssistantZohoMessage { messageId: string; folderId: string; incoming: boolean; sender?: string; from: string; date: string; at: number; recipients: string; addressed: string[]; body: string }
export interface AssistantZohoThread { subject: string; messages: AssistantZohoMessage[]; complete: boolean; replyFrom?: string }

interface Folder { folderId: string; folderType: string }
interface Entry { messageId: string; folderId: string; threadId?: string; receivedTime: string; status?: string; subject?: string; sender?: string; fromAddress?: string; toAddress?: string; ccAddress?: string; hasAttachment?: string }
interface Known { threadId?: string; entries: Entry[] }
interface AccountState { known: Map<string, Known>; folderTypes: Map<string, string> }

const present = (value: string | undefined) => !!value && value !== '0' && value !== 'null';
/** The real addresses of a header. A display name can contain anything, including an address. */
const headerAddresses = (text: string) => text.replace(/"[^"]*"/g, ' ').split(/[,;]/).flatMap(part => {
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(part)?.[1];
  return angled ? [angled] : part.match(/[^\s<>]+@[^\s<>]+/g) ?? [];
}).map(address => address.toLowerCase());
const addressOf = (value: string | undefined) => {
  const text = assistantHtmlText(value ?? '');
  return (/<([^<>\s]+@[^<>\s]+)>\s*$/.exec(text)?.[1] ?? (/^[^\s<>]+@[^\s<>]+$/.test(text) ? text : undefined))?.toLowerCase();
};

export class AssistantZohoApi {
  private readonly tokens = new Map<string, { value: string; until: number }>();
  private readonly remotes = new Map<string, { id: string; base: string; senders: Set<string> }>();
  private readonly states = new Map<string, AccountState>();
  constructor(private readonly dataDir: string, private readonly fetcher: typeof fetch = fetch) {}

  private credential(grant: string) {
    try { return credentialSchema.parse(JSON.parse(readPrivateFile(join(this.dataDir, grant), 8192).toString('utf8'))); }
    catch (error) { if (isMissing(error)) return undefined; throw new AssistantZohoApiError('request', 'Zohos API-uppgifter kunde inte läsas.'); }
  }
  /** Only a credential from the same Zoho region as the configured account may be used. */
  private holds(account: AssistantAccount, grant: string): boolean {
    if (account.provider !== 'zoho') return false;
    try {
      const credential = this.credential(grant);
      return !!credential && new URL(credential.accountsServer).hostname.replace(/^accounts\./, 'mail.') === new URL(account.url).hostname;
    } catch { return false; }
  }
  available(account: AssistantAccount): boolean { return this.holds(account, READ_GRANT); }
  /** Sending also reads the conversation, so it needs both grants. */
  canSend(account: AssistantAccount): boolean { return this.available(account) && this.holds(account, SEND_GRANT); }
  private async request(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json() };
    } catch { throw new AssistantZohoApiError('request', 'Zohos API svarade inte.'); }
  }
  private async access(grant = READ_GRANT): Promise<string> {
    const cached = this.tokens.get(grant);
    if (cached && cached.until > Date.now()) return cached.value;
    const credential = this.credential(grant);
    if (!credential) throw new AssistantZohoApiError('request', 'Zohos API-uppgifter saknas.');
    const { body } = await this.request(`${credential.accountsServer}/oauth/v2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: credential.clientId, client_secret: credential.clientSecret, refresh_token: credential.refreshToken }) });
    if (typeof body?.access_token !== 'string') throw new AssistantZohoApiError('request', 'Zoho godkände inte API-uppgifterna.');
    this.tokens.set(grant, { value: body.access_token, until: Date.now() + Math.max(0, Number(body.expires_in ?? 3600) - 60) * 1000 });
    return body.access_token;
  }
  private async get<T>(base: string, path: string): Promise<T> {
    const { status, body } = await this.request(`${base}${path}`, { headers: { Authorization: `Zoho-oauthtoken ${await this.access()}`, Accept: 'application/json' } });
    if (status !== 200 || body?.status?.code !== 200) throw new AssistantZohoApiError('request', 'Zohos API kunde inte läsa kontot.');
    return body.data as T;
  }
  private async account(account: AssistantAccount): Promise<{ id: string; base: string; senders: Set<string> }> {
    const email = account.email.toLowerCase(), cached = this.remotes.get(account.id);
    if (cached) return cached;
    const base = new URL(account.url).origin;
    const accounts = await this.get<{ accountId: string; primaryEmailAddress?: string; incomingUserName?: string; sendMailDetails?: { fromAddress?: string; status?: boolean }[] }[]>(base, '/api/accounts');
    const match = accounts.find(entry => [entry.primaryEmailAddress, entry.incomingUserName].some(value => value?.toLowerCase() === email));
    if (!match) throw new AssistantZohoApiError('account-mismatch', `Zohos API är kopplat till ett annat konto än ${account.email}.`);
    const senders = (match.sendMailDetails ?? []).filter(item => item.status === true).map(item => addressOf(item.fromAddress)).filter((address): address is string => !!address);
    const remote = { id: match.accountId, base, senders: new Set(senders) };
    this.remotes.set(account.id, remote);
    return remote;
  }
  private async listFolder(remote: { id: string; base: string }, folderId: string, sinceMs: number, includeArchive = false): Promise<{ entries: Entry[]; complete: boolean }> {
    const entries: Entry[] = [];
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const data = await this.get<Entry[]>(remote.base, `/api/accounts/${remote.id}/messages/view?folderId=${folderId}&start=${page * PAGE_SIZE + 1}&limit=${PAGE_SIZE}&sortorder=false&includeto=true${includeArchive ? '&includearchive=true' : ''}`);
      entries.push(...data.filter(entry => Number(entry.receivedTime) >= sinceMs));
      if (data.length < PAGE_SIZE || data.some(entry => Number(entry.receivedTime) < sinceMs)) return { entries, complete: true };
    }
    return { entries, complete: false };
  }
  /** Every incoming folder, including custom folders for other addresses, and Sent. */
  async inventory(account: AssistantAccount, sinceMs: number): Promise<AssistantZohoInventory> {
    const remote = await this.account(account);
    const folders = await this.get<Folder[]>(remote.base, `/api/accounts/${remote.id}/folders`);
    // Without these two the list would be empty rather than read.
    if (!folders.some(folder => folder.folderType === 'Inbox') || !folders.some(folder => folder.folderType === 'Sent')) throw new AssistantZohoApiError('request', 'Zohos mappar kunde inte tolkas.');
    const state: AccountState = { known: new Map(), folderTypes: new Map(folders.map(folder => [folder.folderId, folder.folderType])) };
    this.states.set(account.id, state);
    let complete = true;
    const threadKey = (entry: Entry) => `zoho:${present(entry.threadId) ? entry.threadId : entry.messageId}`;
    const remember = (entry: Entry) => {
      const key = threadKey(entry), known = state.known.get(key) ?? { ...(present(entry.threadId) ? { threadId: entry.threadId } : {}), entries: [] };
      if (!known.entries.some(item => item.messageId === entry.messageId)) known.entries.push(entry);
      state.known.set(key, known);
      return key;
    };
    const rows = new Map<string, Entry>();
    for (const folder of folders.filter(entry => entry.folderType === 'Inbox')) {
      const listed = await this.listFolder(remote, folder.folderId, sinceMs);
      complete &&= listed.complete;
      for (const entry of listed.entries) {
        const key = remember(entry), latest = rows.get(key);
        if (!latest || Number(entry.receivedTime) > Number(latest.receivedTime)) rows.set(key, entry);
      }
    }
    const sentThreads = new Set<string>();
    for (const folder of folders.filter(entry => entry.folderType === 'Sent')) {
      const listed = await this.listFolder(remote, folder.folderId, sinceMs);
      complete &&= listed.complete;
      for (const entry of listed.entries) sentThreads.add(remember(entry));
    }
    return { email: account.email, complete, sentThreads: [...sentThreads],
      rows: [...rows.entries()].sort((first, second) => Number(second[1].receivedTime) - Number(first[1].receivedTime)).map(([key, entry]) => ({
        key, version: `zoho:message:${entry.messageId}`, at: new Date(Number(entry.receivedTime)).toISOString(), unread: entry.status === '0',
        label: `${assistantHtmlText(entry.sender ?? entry.fromAddress ?? '')} ${assistantHtmlText(entry.subject ?? '')}`.trim().slice(0, 200) })) };
  }
  canRead(accountId: string, threadId: string): boolean { return this.states.get(accountId)?.known.has(threadId) === true; }
  /** A conversation in thread order, complete only when nothing seen is missing and every message has a body. */
  async readThread(account: AssistantAccount, threadId: string): Promise<AssistantZohoThread> {
    const state = this.states.get(account.id), known = state?.known.get(threadId);
    if (!state || !known) throw new AssistantZohoApiError('unknown-thread', 'Tråden har inte visats i den här kontrollen.');
    const remote = await this.account(account);
    let entries = known.entries, listComplete = true;
    if (known.threadId) {
      // A failed read is reported as an incomplete thread, which still names the web address.
      try {
        entries = await this.get<Entry[]>(remote.base, `/api/accounts/${remote.id}/messages/view?threadId=${known.threadId}&limit=${THREAD_LIMIT}&includeto=true&includesent=true&includearchive=true&sortorder=true`);
        listComplete = entries.length < THREAD_LIMIT && entries.every(entry => entry.threadId === known.threadId) && known.entries.every(seen => entries.some(entry => entry.messageId === seen.messageId));
      } catch (error) {
        if (!(error instanceof AssistantZohoApiError)) throw error;
        entries = known.entries; listComplete = false;
      }
    }
    const ordered = [...entries].sort((first, second) => Number(first.receivedTime) - Number(second.receivedTime));
    listComplete &&= ordered.every(entry => DELIVERED_FOLDERS.has(state.folderTypes.get(entry.folderId) ?? ''));
    const messages: AssistantZohoMessage[] = [];
    for (const entry of ordered) {
      let body = '';
      if (listComplete) {
        try { body = assistantHtmlText((await this.get<{ content?: string }>(remote.base, `/api/accounts/${remote.id}/folders/${entry.folderId}/messages/${entry.messageId}/content`)).content ?? ''); }
        catch (error) { if (!(error instanceof AssistantZohoApiError)) throw error; }
      }
      const to = assistantHtmlText(entry.toAddress ?? ''), cc = assistantHtmlText(entry.ccAddress ?? '');
      const sender = addressOf(entry.fromAddress);
      messages.push({ messageId: entry.messageId, folderId: entry.folderId, incoming: state.folderTypes.get(entry.folderId) !== 'Sent', ...(sender ? { sender } : {}),
        from: assistantHtmlText(`${entry.sender ?? ''} &lt;${entry.fromAddress ?? ''}&gt;`), date: new Date(Number(entry.receivedTime)).toISOString(), at: Number(entry.receivedTime),
        recipients: [to && to !== 'Not Provided' ? `Till: ${to}` : '', cc && cc !== 'Not Provided' ? `Kopia: ${cc}` : ''].filter(Boolean).join('\n'),
        addressed: [...headerAddresses(to), ...headerAddresses(cc)], body });
    }
    // A reply goes out from the permitted address whoever wrote last used, when that is unambiguous.
    const lastIncoming = [...messages].reverse().find(message => message.incoming);
    const replyFrom = [...new Set(lastIncoming?.addressed ?? [])].filter(address => remote.senders.has(address));
    return { subject: assistantHtmlText(ordered.at(-1)?.subject ?? ''), messages, complete: listComplete && messages.length > 0 && messages.every(message => !!message.sender && !!message.body),
      ...(replyFrom.length === 1 ? { replyFrom: replyFrom[0] } : {}) };
  }
  private async folderTypes(remote: { id: string; base: string }): Promise<Map<string, string>> {
    const folders = await this.get<Folder[]>(remote.base, `/api/accounts/${remote.id}/folders`);
    return new Map(folders.map(folder => [folder.folderId, folder.folderType]));
  }
  private async conversation(remote: { id: string; base: string }, id: string, types: Map<string, string>): Promise<{ ordered: Entry[]; complete: boolean }> {
    const entries = await this.get<Entry[]>(remote.base, `/api/accounts/${remote.id}/messages/view?threadId=${id}&limit=${THREAD_LIMIT}&includeto=true&includesent=true&includearchive=true&sortorder=true`);
    const ordered = [...entries].sort((first, second) => Number(first.receivedTime) - Number(second.receivedTime));
    return { ordered, complete: ordered.length > 0 && ordered.length < THREAD_LIMIT && ordered.every(entry => entry.threadId === id && DELIVERED_FOLDERS.has(types.get(entry.folderId) ?? '')) };
  }
  private async answeredSince(remote: { id: string; base: string }, types: Map<string, string>, message: Entry, recipient: string): Promise<boolean> {
    for (const [folderId, type] of types) {
      if (type !== 'Sent' && type !== 'Archive') continue;
      // An archived answer is still sent. Archiving moves a sent message into the Archive
      // folder, out of every Sent listing, so that folder is read too: later mail to the
      // recipient there is the same doubt. A Sent folder is read both ways, because Zoho
      // lists it without its other mail when asked for archived mail.
      for (const archived of type === 'Sent' ? [false, true] : [false]) {
        const { entries, complete } = await this.listFolder(remote, folderId, Number(message.receivedTime), archived);
        if (!complete || entries.some(entry => headerAddresses(assistantHtmlText(`${entry.toAddress ?? ''},${entry.ccAddress ?? ''}`)).includes(recipient))) return true;
      }
    }
    return false;
  }
  /** The approved message, while it is still the newest of its conversation and something to answer. */
  private async approvedNewest(remote: { id: string; base: string }, approval: AssistantSendApproval, messageId: string): Promise<Entry | undefined> {
    const id = approval.threadId.slice('zoho:'.length), types = await this.folderTypes(remote);
    let newest: Entry | undefined;
    if (id === messageId) {
      // A message without a thread may still have been answered, so Sent is asked directly.
      const folderId = /#mail\/folder\/(\d+)\/p\/\d+$/.exec(approval.sourceUrl)?.[1];
      if (!folderId) return undefined;
      newest = await this.get<Entry>(remote.base, `/api/accounts/${remote.id}/folders/${folderId}/messages/${messageId}/details`);
      if (!newest || present(newest.threadId) || await this.answeredSince(remote, types, newest, approval.recipient.toLowerCase())) return undefined;
    } else {
      const { ordered, complete } = await this.conversation(remote, id, types);
      if (!complete) return undefined;
      newest = ordered.at(-1);
    }
    return newest?.messageId === messageId && REPLYABLE_FOLDERS.has(types.get(newest.folderId) ?? '') ? newest : undefined;
  }
  /**
   * Sends one approved reply. Every check and the send token come first, so any doubt
   * leaves nothing sent. `intent` then records the attempt and the POST runs once: a
   * failure after that is uncertain and is never repeated.
   */
  async reply(approval: AssistantSendApproval, approvedMessage: string, intent: () => Promise<void>): Promise<string> {
    const { account } = approval, sender = (approval.sender ?? account.email).toLowerCase();
    const messageId = /^zoho:message:(\d+)$/.exec(approvedMessage)?.[1];
    if (!messageId || !/^zoho:\d+$/.test(approval.threadId)) throw new AssistantZohoApiError('refused', STALE_REPLY);
    if (!this.canSend(account)) throw new AssistantZohoApiError('refused', 'Zoho-svar kräver att sändningsbehörigheten har godkänts.');
    // Permitted senders can have changed since the conversation was read.
    this.remotes.delete(account.id);
    const remote = await this.account(account);
    if (!remote.senders.has(sender)) throw new AssistantZohoApiError('refused', 'Zoho tillåter inte den avsändaren.');
    const newest = await this.approvedNewest(remote, approval, messageId);
    if (!newest || addressOf(newest.fromAddress) !== approval.recipient.toLowerCase()) throw new AssistantZohoApiError('refused', STALE_REPLY);
    const token = await this.access(SEND_GRANT);
    await intent();
    // The sender wrote this subject and the card does not show it: a line break must not reach the outgoing headers.
    const subject = assistantHtmlText(newest.subject ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
    const unconfirmed = 'Zoho bekräftade inte utskicket. Kontrollera Skickat i Zoho; Tabai försöker inte igen.';
    const answer = await this.request(`${remote.base}/api/accounts/${remote.id}/messages/${messageId}`, {
      method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ fromAddress: sender, toAddress: approval.recipient, action: 'reply', subject: /^(?:re|sv|aw|vs)\s*:/i.test(subject) ? subject : `Re: ${subject}`.trim(), content: approval.body, mailFormat: 'plaintext' }),
    }).catch(() => { throw new AssistantZohoApiError('uncertain', unconfirmed); });
    if (answer.status !== 200 || answer.body?.status?.code !== 200) throw new AssistantZohoApiError('uncertain', unconfirmed);
    return `${sender}: Zoho bekräftade utskicket.`;
  }
}
