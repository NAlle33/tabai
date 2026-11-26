import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isRetryable } from "../shared/protocol";
import { ASSISTANT_PROVIDER_ORIGINS, assistantResultSchema, type AssistantAccount, type AssistantResult, type AssistantSendApproval, type AssistantTask, type AssistantResolution, type AssistantItem, type AssistantReview, type AssistantHelp } from "../shared/assistant";
import { assistantZohoFoldersScript, type AssistantMailFolder } from './assistant-zoho-folders';
import { assistantParseGmailPrint, assistantThreadText } from './assistant-gmail-print';
import { AssistantZohoApi } from './assistant-zoho-api';
export { assistantZohoFoldersScript } from './assistant-zoho-folders';

const origins: Record<AssistantAccount["provider"], Set<string>> = {
  gmail: new Set(ASSISTANT_PROVIDER_ORIGINS.gmail),
  outlook: new Set(ASSISTANT_PROVIDER_ORIGINS.outlook),
  zoho: new Set(ASSISTANT_PROVIDER_ORIGINS.zoho),
};
export class AssistantBrowserError extends Error {
  /** A failed tool's protocol code (shared/protocol.ts), read from the "CODE: message" text the server returns. */
  readonly toolCode?: string;
  constructor(readonly status: "login" | "unsupported" | "failed", readonly code: string, message: string, toolCode?: string) { super(message); this.name = "AssistantBrowserError"; if (toolCode) this.toolCode = toolCode; }
}
/**
 * Whether a browser call failed because Tabai's own connection did: the server,
 * broker or extension could not be reached or the extension's worker stopped.
 * A page that loaded with an error is not such a failure.
 */
export function assistantBrowserDisconnected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, toolCode } = error as Partial<AssistantBrowserError>;
  return code === "transport" || typeof toolCode === "string" && (isRetryable(toolCode) || toolCode === "NO_SESSION" || toolCode === "SW_ERROR");
}
export function assistantAccessError(account: AssistantAccount, value: string): AssistantBrowserError | undefined {
  const url = new URL(value);
  const loginHosts = account.provider === "gmail" ? ["accounts.google.com"] : account.provider === "outlook"
    ? ["login.live.com", "login.microsoftonline.com", "login.microsoft.com", "login.windows.net"]
    : ASSISTANT_PROVIDER_ORIGINS.zoho.map(origin => new URL(origin).hostname.replace(/^(mail|calendar)\./, "accounts."));
  // Google lists an account whose session has expired in its profile menu too, so
  // this page must say what is needed rather than read as a plain signed-out state.
  if (url.protocol === "https:" && loginHosts.includes(url.hostname)) return new AssistantBrowserError("login", "login-required", account.provider === 'gmail' && url.pathname.endsWith('/signin/confirmidentifier')
    ? `Google vill att du bekräftar din identitet för ${account.email}, även om kontot syns i profilmenyn. Slutför bekräftelsen i assistentfliken och fortsätt sedan.`
    : `Logga in som ${account.email} i assistentfliken och fortsätt sedan.`);
  try { assistantUrl(account, value); }
  catch { return new AssistantBrowserError("unsupported", "unsupported-route", "Kontot visar en adress som assistenten inte kan läsa säkert. Öppna kontots e-post eller kalender manuellt."); }
  return undefined;
}
export function assistantUrl(account: AssistantAccount, value: string): string {
  const url = new URL(value);
  if (!origins[account.provider].has(url.origin) || url.username || url.password) throw new Error("Adressen tillhör inte kontots tillåtna e-post- eller kalendertjänst.");
  if (account.provider === "gmail" && url.hostname === "mail.google.com" && !url.pathname.startsWith("/mail/")) throw new Error("Endast Gmail-vyn får öppnas.");
  if (account.provider === "outlook" && !/^\/(mail|calendar|owa)(\/|$)/.test(url.pathname)) throw new Error("Endast Outlooks e-post och kalender får öppnas.");
  if (/\b(compose|send|delete|remove|unsubscribe|logout|signout)\b|[?&]view=cm(?:&|$)/i.test(url.pathname + url.search + url.hash)) throw new Error("Adressen kan ändra kontot och får inte öppnas.");
  return url.href;
}
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
export function assistantThreadId(provider: AssistantAccount["provider"], value: string): string | undefined {
  const url = new URL(value);
  const hash = url.hash.slice(1).split("/").map(part => { try { return decodeURIComponent(part); } catch { return ""; } });
  if (provider === "gmail" && url.hostname === "mail.google.com") {
    const last = hash.at(-1) || "";
    if (hash.length >= (hash[0] === "search" ? 3 : 2) && /^[A-Za-z0-9_-]{12,250}$/.test(last)) return `gmail:${last}`;
  }
  const event = url.searchParams.get("eid") || url.searchParams.get("eventid") || url.pathname.match(/\/(?:event|eventedit|item)\/([^/]+)/i)?.[1];
  if (event && event.length <= 450) return `${provider}:event:${event}`;
  if (provider === "outlook") {
    const id = url.pathname.match(/\/id\/([^/]+)/i)?.[1] || url.searchParams.get("ItemID") || url.searchParams.get("itemid");
    if (id && id.length <= 450) return `outlook:${id}`;
  }
  if (provider === "zoho") {
    const id = url.hash.match(/\/(?:m|message|maildetail)\/([A-Za-z0-9_-]{8,450})(?:\/|$)/i)?.[1]
      || url.hash.match(/\/p\/([0-9]{8,450})(?:\/|$)/)?.[1];
    if (id) return `zoho:${id}`;
  }
  return undefined;
}
export type AssistantView = "list" | "empty" | "detail" | "unsupported";
export interface AssistantReadingProof { area: string; view: AssistantView; historyComplete?: boolean; attachmentReview?: boolean }
export interface AssistantObservation { accountId: string; email: string; url: string; sourceId: string; messageId?: string; replyFrom?: string; areas?: string[]; view?: AssistantView; text: string; historyComplete?: boolean; truncated?: boolean; messageIds?: string[]; latestSender?: string; chronological?: boolean; tabId?: number; attachmentReviewAvailable?: boolean }
/** Areas whose reading the task requires before coverage may be checked, minus the ones already proven. */
export function assistantMissingCoverageAreas(task: AssistantTask, proofs: readonly AssistantReadingProof[]): string[] {
  const required = task === "check-mail" ? ["inbox", "sent"] : task === "follow-ups" ? ["sent"] : ["my-day", "prepare-meeting"].includes(task) ? ["inbox", "sent", "calendar"] : [];
  return required.filter(area => !proofs.some(proof => {
    if (proof.area !== area) return false;
    if (proof.view === 'empty') return true;
    return proof.view === 'detail' && (proof.historyComplete !== false || task === 'check-mail' && proof.attachmentReview === true);
  }));
}
/**
 * One native inbox row as the host keeps it. `key` names the conversation and `version` its
 * latest message: the provider's own ids when the row renders them, otherwise a fingerprint of
 * the row's text without dates, times or unread markers, which a new message changes.
 */
export interface AssistantInboxRow { key: string; version: string; native: boolean; unread?: boolean; at?: string; ref?: string }
/** A row seen in this run: its read state when first seen in this version, and where it was listed. */
export interface AssistantSeenRow extends AssistantInboxRow { firstUnread?: boolean; tabId: number; order: number; folderUrl?: string }
const ROW_ID = /^[^\s\0]{1,450}$/;
const ROW_MONTHS = "jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec";
const ROW_VOLATILE = [
  /\b\d{1,2}[:.]\d{2}(?:\s*[ap]\.?\s?m\.?)?/gi, /\b\d{4}-\d{2}-\d{2}\b/g, /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g,
  new RegExp(`\\b\\d{1,2}\\.?\\s+(?:${ROW_MONTHS})[a-zåäö]*\\.?(?:,?\\s+\\d{4})?`, "gi"), new RegExp(`\\b(?:${ROW_MONTHS})[a-zåäö]*\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?`, "gi"),
  /\b(?:mån|tis|ons|tors?|fre|lör|sön|mon|tue|wed|thu|fri|sat|sun)[a-zåäö]*\.?(?=[\s,]|$)/gi, /\b(?:i ?dag|i ?går|today|yesterday|olästa?|unread)\b/gi,
];
/** Validates a page function's raw row; page data never becomes an identity it did not render. */
export function assistantInboxRow(provider: AssistantAccount["provider"], raw: unknown, now = Date.now()): AssistantInboxRow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const text = typeof value.text === "string" ? value.text.slice(0, 500) : "";
  const thread = typeof value.thread === "string" && ROW_ID.test(value.thread) ? value.thread : undefined;
  const last = typeof value.last === "string" && ROW_ID.test(value.last) ? value.last : undefined;
  let stripped = normalize(text).toLowerCase();
  for (const pattern of ROW_VOLATILE) stripped = stripped.replace(pattern, " ");
  stripped = stripped.replace(/\s+/g, " ").trim();
  if (!thread && !last && !stripped) return undefined;
  const fingerprint = `row:${createHash("sha256").update(`${provider}\n${stripped}`).digest("hex")}`;
  const at = typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) <= now + 86_400_000 ? new Date(Date.parse(value.at)).toISOString() : undefined;
  const ref = typeof value.ref === "string" && /^ref_\d+$/.test(value.ref) ? value.ref : undefined;
  return { key: thread ? `${provider}:${thread}` : fingerprint, version: last ? `${provider}:message:${last}` : fingerprint, native: !!last,
    ...(typeof value.unread === "boolean" ? { unread: value.unread } : {}), ...(at ? { at } : {}), ...(ref ? { ref } : {}) };
}
/** Inbox rows a check must give an outcome, at most this many per account and check. */
export const ASSISTANT_INBOX_LIMIT = 30;
/**
 * Whether a review covers the row as it is now: the review was bound to this row at the same
 * version, or was made a minute or more after the row's latest message, or reviewed the very
 * message the row's native id names.
 */
export function assistantRowReviewed(row: AssistantInboxRow, reviews: readonly AssistantReview[], scanStartedAt?: string): boolean {
  const after = (review: AssistantReview) => !!row.at && Date.parse(review.reviewedAt) >= Date.parse(row.at) + 60_000;
  return reviews.some(review => {
    if (review.outcome === 'attachment-review') {
      if (row.native) return review.messageId === row.version;
      // A list fingerprint cannot identify a new message. Retain only this
      // logical scan's flag; every new check must inspect the native detail again.
      const started = Date.parse(scanStartedAt || ''), at = Date.parse(row.at || ''), reviewed = Date.parse(review.reviewedAt);
      return Number.isFinite(started) && Number.isFinite(at) && reviewed >= started && reviewed >= at
        && review.rows.some(entry => entry.key === row.key && entry.version === row.version);
    }
    return row.native && review.messageId === row.version
      || review.rows.some(entry => entry.key === row.key && (entry.version === row.version || after(review)))
      || review.threadId === row.key && after(review);
  });
}
export interface AssistantInboxGap {
  /** Rows inside lookbackDays without a covering review, newest first. */
  due: AssistantSeenRow[];
  /** Rows given an outcome in this check. */
  handled: number;
  /** Rows inside lookbackDays that a review already covers. */
  reviewed: number;
  limitReached: boolean;
  /** Rows the list showed without a readable date; they cannot be placed in the period. */
  undated: number;
  /** Rows whose read state the list does not show. */
  unknownRead: number;
  seen: number;
}
export function assistantInboxGap(rows: Iterable<AssistantSeenRow>, reviews: readonly AssistantReview[], options: { now: number; lookbackDays: number; scanStartedAt: string }): AssistantInboxGap {
  const all = [...rows], since = options.now - options.lookbackDays * 86_400_000;
  const current = reviews.filter(review => review.reviewedAt >= options.scanStartedAt);
  const inside = all.filter(row => row.at && Date.parse(row.at) >= since);
  const due = inside.filter(row => !assistantRowReviewed(row, reviews, options.scanStartedAt))
    .sort((first, second) => Date.parse(second.at!) - Date.parse(first.at!) || first.order - second.order);
  const handled = all.filter(row => assistantRowReviewed(row, current, options.scanStartedAt)).length;
  return { due, handled, reviewed: inside.length - due.length, limitReached: due.length > 0 && handled >= ASSISTANT_INBOX_LIMIT, undated: all.filter(row => !row.at).length,
    unknownRead: all.filter(row => row.firstUnread === undefined).length, seen: all.length };
}
/** The latest read shows the account's own message last in a complete, ordered conversation. */
export function assistantOwnLatest(observation: AssistantObservation | undefined, account: AssistantAccount): boolean {
  return !!observation && observation.historyComplete === true && !observation.truncated && observation.chronological === true
    && observation.latestSender?.toLowerCase() === account.email.toLowerCase();
}
export function validateAssistantCoverageDepth(task: AssistantTask, proofs: AssistantReadingProof[]): void {
  if (assistantMissingCoverageAreas(task, proofs).length) throw new Error("Kontot är bara delvis kontrollerat: läs relevanta hela trådar/händelser eller verifiera en uttryckligen tom sökning i Inkorg, Skickat och uppdragets kalender. En mapplista räcker inte för checked.");
}

export function validateAssistantResolutions(resolutions: AssistantResolution[], items: AssistantItem[], accounts: AssistantAccount[], observations: Map<string, AssistantObservation>): void {
  if (new Set(resolutions.map(item => item.itemId)).size !== resolutions.length) throw new Error("Ett ärende får bara avslutas en gång i samma resultat.");
  for (const resolution of resolutions) {
    const item = items.find(item => item.id === resolution.itemId), account = accounts.find(account => account.id === resolution.accountId);
    const latest = [...observations.values()].reverse().find(entry => entry.accountId === resolution.accountId && entry.sourceId === resolution.threadId);
    if (!item || !account || item.revision !== resolution.revision || item.accountId !== resolution.accountId || item.threadId !== resolution.threadId || !["open", "snoozed"].includes(item.status)
      || !item.messageId || latest?.messageId !== resolution.messageId || latest.url !== resolution.sourceUrl || latest.historyComplete !== true || latest.truncated
      || latest.latestSender?.toLowerCase() !== account.email.toLowerCase() || !latest.chronological
      || !latest.messageIds?.includes(item.messageId) || latest.messageIds.indexOf(item.messageId) >= latest.messageIds.indexOf(resolution.messageId)) throw new Error("Ärendet kan inte avslutas automatiskt: läs en komplett, ordnad konversation som visar det ursprungliga meddelandet och ditt senare skickade svar.");
    if (!resolution.sources.some(source => {
      const observed = observations.get(source.observationId);
      return observed === latest && normalize(observed.text).includes(normalize(source.quote));
    }) || resolution.sources.some(source => {
      const observed = observations.get(source.observationId);
      return !observed || observed.accountId !== account.id || observed.sourceId !== item.threadId || !normalize(observed.text).includes(normalize(source.quote));
    })) throw new Error("Avslutet saknar färskt underlag från samma konto och konversation.");
  }
}

export function validateAssistantEvidence(value: unknown, accounts: AssistantAccount[], observations: Map<string, AssistantObservation>): AssistantResult {
  const result = assistantResultSchema.parse(value);
  const ids = new Set(accounts.map(account => account.id));
  if (new Set(result.coverage.map(item => item.accountId)).size !== result.coverage.length) throw new Error("Kontotäckningen innehåller dubbletter.");
  for (const coverage of result.coverage) {
    if (!ids.has(coverage.accountId)) throw new Error("Resultatet hänvisar till ett okänt konto.");
    if (coverage.status === "checked" && ![...observations.values()].some(item => item.accountId === coverage.accountId)) throw new Error("Kontot kan inte markeras kontrollerat utan läst underlag.");
  }
  for (const finding of result.findings) {
    if (finding.unreadAttachment) throw new Error('Bilagegranskning sparas endast genom workflow_review_attachment, aldrig som ett påhittat läsresultat.');
    const account = accounts.find(item => item.id === finding.accountId);
    if (!account) throw new Error("Fyndet hänvisar till ett okänt konto.");
    assistantUrl(account, finding.sourceUrl);
    const latest = [...observations.values()].reverse().find(item => item.accountId === account.id && item.sourceId === finding.threadId);
    if (!latest?.messageId) throw new Error("Fyndet saknar det senast lästa meddelandets stabila identitet. Läs hela tråden igen och ange messageId.");
    // Name the field and the value already observed in this thread, so an agent can correct the finding itself.
    if (finding.messageId !== latest.messageId) throw new Error(`Fyndet hänvisar inte till det senast lästa meddelandet. Varje fynd måste ha fältet messageId med exakt senaste browser_read.messageId för tråden: ${latest.messageId}`);
    if (latest.historyComplete === false || latest.truncated) throw new Error("Hela trådhistoriken måste läsas innan ett svarsförslag sparas. Öppna konversationen eller be om manuell hjälp.");
    if (finding.kind === "reply" && assistantOwnLatest(latest, account)) throw new Error("Det senaste meddelandet i tråden är ditt eget svar, så ett svarsförslag behövs inte. Spara tråden med utfallet already-replied.");
    let bound = false;
    let recipientObserved = !finding.recipient;
    for (const source of finding.sources) {
      const observation = observations.get(source.observationId);
      if (!observation || observation.accountId !== account.id || observation.email.toLowerCase() !== account.email.toLowerCase() || observation.sourceId !== finding.threadId
        || !normalize(observation.text).includes(normalize(source.quote))) throw new Error("Källcitatet saknas i kontots verifierade underlag. Läs källan igen.");
      if (observation.url === finding.sourceUrl && observation.sourceId && observation.messageId === finding.messageId) bound = true;
      if (finding.recipient && observation.text.toLowerCase().includes(finding.recipient.toLowerCase())) recipientObserved = true;
    }
    if (!bound) throw new Error("Fyndets tråd och adress måste motsvara en citerad, läst källa.");
    if (!recipientObserved) throw new Error("Mottagaradressen måste synas i det citerade trådunderlaget. Visa hela meddelandehuvudet och läs igen.");
    // Only the host's own read decides the reply address, whatever the finding says.
    delete finding.replyFrom;
    if (latest.replyFrom && finding.recipient && (finding.kind === 'reply' || finding.kind === 'followup')) finding.replyFrom = latest.replyFrom;
  }
  return result;
}

// Every page function is host-authored and self-contained. Page text never becomes code.
function identityScript(provider: string) {
  const selectors = provider === "gmail"
    ? ['a[aria-label^="Google Account"]', 'a[aria-label^="Google-konto"]', '[data-email][role="button"]', 'meta[name="email"]']
    : provider === "outlook"
      ? ['#mectrl_headerPicture', '#mectrl_currentAccount_secondary', '[aria-label^="Account manager"]', '[aria-label^="Kontohanterare"]']
      : ['section[class*="zmprofilemenu-wrapper"] [class*="zmprofilemenu__email__"]', '.zmTopbarAcc', '[data-testid="user-profile"]', '#ztb-profile'];
  const emails: string[] = [];
  for (const selector of selectors) for (const element of document.querySelectorAll(selector)) {
    const text = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-email"), element.getAttribute("content"), element.textContent].join(" ");
    for (const email of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) emails.push(email.toLowerCase());
  }
  return [...new Set(emails)];
}

function identityMenuScript(provider: string, mode: "open" | "close") {
  const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const menu = provider === "outlook" ? '#mectrl_main_body' : provider === "zoho" ? 'section[class*="zmprofilemenu-wrapper"]' : '';
  const control = provider === "outlook" ? '#owa-me-control-container > button, #mectrl_main_trigger' : provider === "zoho" ? 'div.zmUserInfo[data-name="profile"]' : '';
  if (!menu || !control) return false;
  const isOpen = [...document.querySelectorAll(menu)].some(e => visible(e) && (provider !== 'zoho' || e.classList.contains('zmup--show')));
  if ((mode === "open" && isOpen) || (mode === "close" && !isOpen)) return false;
  if (provider === 'zoho' && mode === 'close') {
    const close = [...document.querySelectorAll<HTMLElement>('section[class*="zmprofilemenu-wrapper"].zmup--show [class*="zmprofilemenu__close__"] > button')].filter(visible);
    if (close.length !== 1) return false;
    close[0].click(); return true;
  }
  const buttons = [...document.querySelectorAll<HTMLElement>(control)].filter(visible);
  if (buttons.length !== 1) return false;
  buttons[0].click(); return true;
}
export { identityMenuScript as assistantIdentityMenuScript };

// The session key and active address exist only in the page's own globals. A
// redirect means the session is no longer valid and is never followed.
async function gmailPrintScript(thread: string, email: string): Promise<{ error?: 'account-mismatch' | 'session-unavailable' | 'fetch-failed'; html?: string; truncated?: boolean }> {
  const globals = (window as unknown as { GLOBALS?: unknown[] }).GLOBALS;
  const key = globals?.[9], active = globals?.[10];
  if (typeof active !== 'string' || active.toLowerCase() !== email) return { error: 'account-mismatch' };
  if (typeof key !== 'string' || !/^[\w-]{4,64}$/.test(key) || !/^\/mail\/u\/\d+\/$/.test(location.pathname)) return { error: 'session-unavailable' };
  try {
    const response = await fetch(`${location.pathname}?ik=${key}&view=pt&search=all&th=${thread}`, { credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) return { error: 'fetch-failed' };
    const html = await response.text();
    return { html: html.slice(0, 1_000_000), truncated: html.length > 1_000_000 };
  } catch { return { error: 'fetch-failed' }; }
}
export { gmailPrintScript as assistantGmailPrintScript };

/** The conversation Gmail itself says is open: the ID on its subject heading, outside every message. */
export function assistantGmailOpenThreadScript(): string | null {
  const named = [...new Set([...document.querySelectorAll('h2[data-legacy-thread-id]')].filter(e => e.getBoundingClientRect().width > 0 && !e.closest('.adn,.ii,.a3s')).map(e => e.getAttribute('data-legacy-thread-id')))];
  return named.length === 1 ? named[0] : null;
}
function loadingScript(provider: string) {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
  };
  if (provider === 'zoho') {
    const body = '.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"]';
    const rows = [...document.querySelectorAll('div.zmList[role="option"][data-ty][aria-controls]')].some(e => visible(e) && !e.closest(body));
    const detail = [...document.querySelectorAll<HTMLElement>('.zmMailMsgBody,.zmMailContent [role="document"].jsConTent,[data-testid="message-body"]')].some(e => visible(e) && !!e.textContent?.trim());
    const empty = [...document.querySelectorAll('.zmNoMail,[data-testid="empty-message-list"]')].some(visible);
    const calendar = /calendar\.zoho\.|\/calendar(?:\/|$)/i.test(location.href) && [...document.querySelectorAll('[role="grid"],[role="treegrid"],.zcl-calendar,.zcl-event-details')].some(visible);
    if (rows || detail || empty || calendar) return false;
    // Zoho removes its initial spinner while the signed-in shell is still
    // mounting Mail. A profile header alone is not a ready mailbox.
    if ([...document.querySelectorAll('.zmWrapper')].some(visible)) return true;
  }
  if (provider === 'outlook') {
    const appHeader = [...document.querySelectorAll('#owa-me-control-container > button,#mectrl_main_trigger')].some(visible);
    const listboxes = [...document.querySelectorAll('[role="listbox"]')].filter(visible);
    const options = [...document.querySelectorAll('[role="listbox"] [role="option"]')].filter(visible);
    const detail = [...document.querySelectorAll<HTMLElement>('[data-app-section="MailReadCompose"] [aria-label="Message body"],[data-app-section="MailReadCompose"] [aria-label="Meddelandetext"]')].some(e => visible(e) && !!e.innerText.trim());
    const empty = listboxes.length > 0 && options.length === 0 && [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="status"],[role="listbox"] [data-testid="empty-message-list"]')].some(e => visible(e) && /^(no (?:conversations|messages|results|items)(?: found| to display| to show)?[.!]?|there are no items to show[.!]?|you have no messages[.!]?|inga (?:konversationer|meddelanden|resultat|objekt)(?: hittades| att visa)?[.!]?|det finns inga objekt att visa[.!]?)$/i.test(e.innerText.trim()));
    const calendar = /\/calendar(?:\/|$)/i.test(location.pathname) && [...document.querySelectorAll('[data-app-section="CalendarEventPeek"],[data-testid="event-details"],[role="grid"],[role="treegrid"]')].some(visible);
    // Outlook retains #loadingScreen as a full-size app container after startup.
    // Native rendered content overrides it; an unpainted empty list does not.
    if (appHeader && (options.length > 0 || detail || empty || calendar)) return false;
  }
  const selectors = provider === "zoho" ? '#ms_load.zm-initial-loader-wrapper' : provider === "outlook" ? '#loadingScreen' : '';
  if (!selectors) return false;
  return [...document.querySelectorAll<HTMLElement>(selectors)].some(visible);
}
export { loadingScript as assistantLoadingScript };

function messageMetadataScript(provider: string, urlThreadId: string) {
  const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const outsideList = (e: Element) => !e.closest('[role="grid"],[role="listbox"],[role="tree"]');
  const calendar = /calendar\.google\.|calendar\.zoho\.|\/calendar(?:\/|$)/i.test(location.href);
  const mailRoots = provider === "gmail" ? '.adn[data-message-id],.adn[data-legacy-message-id],.adn' : provider === "outlook"
    ? '[data-app-section="MailReadCompose"],[data-testid="reading-pane"],.ReadingPaneContents,[aria-label="Message body"],[aria-label="Meddelandetext"]'
    : '.zmPVMail,.zmReadMailView,.zmMailContent,.zmMailMsgBody,[data-testid="mail-detail"]';
  const calendarRoots = provider === "gmail" ? '#xDetDlg,[role="dialog"],[data-testid="event-details"]' : provider === "outlook"
    ? '[data-app-section="CalendarEventPeek"],[data-testid="event-details"],[role="dialog"]' : '.zcl-event-details,.zclEventDetails,[data-testid="event-details"],[role="dialog"][data-eventid]';
  const all = [...document.querySelectorAll<HTMLElement>(calendar ? calendarRoots : mailRoots)].filter(e => visible(e) && outsideList(e));
  const containers = all.filter(e => !all.some(parent => parent !== e && parent.contains(e)));
  const ids: string[] = [];
  for (const root of containers) {
    const elements = [root, ...root.querySelectorAll('[data-message-id],[data-legacy-message-id],[data-mailid],[data-itemid]')];
    for (const e of elements) {
      const id = e.getAttribute('data-legacy-message-id') || e.getAttribute('data-message-id') || e.getAttribute('data-mailid') || e.getAttribute('data-itemid');
      if (id && id.length <= 450 && !ids.includes(id)) ids.push(id);
    }
  }
  const nativeThreads = containers.map(e => e.closest('[data-legacy-thread-id],[data-thread-id],[data-conversation-id]')).filter(Boolean)
    .map(e => e!.getAttribute('data-legacy-thread-id') || e!.getAttribute('data-thread-id') || e!.getAttribute('data-conversation-id')).filter(Boolean);
  // Gmail names the open conversation on its subject heading, which no message sits inside.
  const headingThreads = provider === 'gmail' && !calendar && containers.length ? [...document.querySelectorAll('h2[data-legacy-thread-id]')].filter(e => visible(e) && !e.closest('.adn,.ii,.a3s')).map(e => e.getAttribute('data-legacy-thread-id')).filter(Boolean) : [];
  const uniqueThreads = [...new Set([...nativeThreads, ...headingThreads])];
  const eventIds = calendar ? [...new Set(containers.flatMap(root => [root, ...root.querySelectorAll('[data-eventid],[data-event-id]')]).map(e => e.getAttribute('data-eventid') || e.getAttribute('data-event-id')).filter(Boolean))] : [];
  const headerEmails = containers.flatMap(root => [...root.querySelectorAll<HTMLElement>('[email],[data-email]')].map(e => e.getAttribute('email') || e.getAttribute('data-email') || '')).filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const nativeBodies = provider === 'gmail' ? '.a3s' : provider === 'outlook' ? '[role="document"].BIZfh,[aria-label="Message body"],[aria-label="Meddelandetext"]' : '.zmMailMsgBody,.zmMailContent [role="document"].jsConTent,[data-testid="message-body"]';
  let bodyBudget = 60000, bodyWasTruncated = false;
  const messages = containers.map(root => {
    const bodies = [...root.querySelectorAll<HTMLElement>(nativeBodies)];
    if (root.matches?.(nativeBodies)) bodies.unshift(root);
    const outerBodies = bodies.filter(body => !bodies.some(parent => parent !== body && parent.contains(body)));
    const rawBody = outerBodies.map(element => {
      const clone = element.cloneNode?.(true) as HTMLElement | undefined;
      if (!clone) return element.innerText || '';
      for (const node of clone.querySelectorAll('script,style,template,form,[contenteditable="true"],[data-app-section="MailCompose"]')) node.remove();
      // Hidden quoted mail is still evidence. No click is sent into mail content.
      return clone.textContent || '';
    }).join('\n');
    const body = rawBody.slice(0, bodyBudget); bodyBudget -= body.length;
    const truncated = body.length < rawBody.length; bodyWasTruncated ||= truncated;
    const headers = provider === 'gmail' ? [...root.querySelectorAll<HTMLElement>('.gD[email]')] : provider === 'outlook' ? [] : [...root.querySelectorAll<HTMLElement>('.zmMailHdr [data-email],.zmMailHeader [email]')];
    const outsideBody = headers.filter(element => !element.closest(nativeBodies + ',[contenteditable="true"]'));
    const senderText = outsideBody.map(element => element.getAttribute('email') || element.getAttribute('data-email') || element.getAttribute('aria-label') || '').join(' ');
    const senders = [...new Set((senderText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(value => value.toLowerCase()))];
    const nativeId = root.getAttribute('data-legacy-message-id') || root.getAttribute('data-message-id') || root.getAttribute('data-mailid') || root.getAttribute('data-itemid');
    return { nativeId, sender: senders.length === 1 ? senders[0] : undefined, body, complete: outerBodies.length > 0 && !!body.trim() && !truncated };
  });
  // Outlook's header shows only a display name, which the sender chooses, so an address there proves nothing. The selected list row holds the real
  // address in the title of the sender's name. It counts only for one visible row outside the message, in a conversation the row does not expand,
  // with exactly one such name, the name on the one From row showing, and the subject of the open message.
  if (provider === 'outlook' && containers.length === 1) {
    const clean = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const from = [...containers[0].querySelectorAll<HTMLElement>('[role="heading"] [role="button"][aria-label]')].flatMap(e => /^(?:från|from)\s*:?\s*(.+)$/i.exec(e.getAttribute('aria-label') || '')?.[1] ?? []);
    const rows = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"][aria-selected="true"]')].filter(e => visible(e) && !containers[0].contains(e));
    const titled = rows.length === 1 && !rows[0].querySelector('[aria-expanded]') ? [...rows[0].querySelectorAll<HTMLElement>('[title]')].filter(e => (e.getAttribute('title') || '').includes('@')) : [];
    const address = titled.length === 1 ? (titled[0].getAttribute('title') || '').trim() : '';
    const subject = clean([...containers[0].querySelectorAll('[role="heading"]')].find(e => !e.querySelector('[role="button"][aria-label]'))?.textContent);
    if (from.length === 1 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) && clean(titled[0].textContent) === clean(from[0]) && subject && clean(rows[0].textContent).includes(subject)) {
      messages[0].sender = address.toLowerCase(); headerEmails.push(address.toLowerCase());
    }
  }
  const rawScope = containers.map(e => e.innerText).join('\n') + (headerEmails.length ? '\nE-postadresser i meddelandets rubrik: ' + [...new Set(headerEmails)].join(', ') : '')
    + messages.filter(message => message.body).map(message => '\nFullständig meddelandetext, inklusive citerad historik:\n' + message.body).join('\n');
  const scopeText = rawScope.slice(0, 60000);
  const selected = [...document.querySelectorAll<HTMLElement>('[role="treeitem"][aria-selected="true"],[role="navigation"] [aria-current="page"],[role="navigation"] [aria-selected="true"]')].map(e => {
    const clone = e.cloneNode(true) as HTMLElement;
    for (const child of clone.querySelectorAll('[role="treeitem"]')) child.remove();
    return (e.getAttribute('aria-label') || clone.textContent || '').replace(/[\uE000-\uF8FF]/g, '')
      .replace(/\s*(?:markerad|selected)?\s*\d+\s*(?:olästa|unread)\s*$/i, '').replace(/\s*(?:markerad|selected)\s*$/i, '').trim();
  });
  const queries = [...document.querySelectorAll<HTMLInputElement>('input[aria-label*="Search"],input[aria-label*="Sök"],input[placeholder*="Search"],input[placeholder*="Sök"]')].filter(visible).map(e => e.value);
  let route = location.pathname + location.hash;
  try { route = decodeURIComponent(route); } catch { /* Keep the observed route. */ }
  let gmailSearch: { area: string; filtered: boolean; suffix: boolean } | undefined;
  if (provider === 'gmail' && !calendar) {
    // Gmail may render an empty search input while retaining its query in the route.
    const match = /^#search\/([^/]+)(?:\/([A-Za-z0-9_-]{12,250}))?$/i.exec(location.hash);
    if (match) try {
      const query = decodeURIComponent(match[1].replace(/\+/g, ' '));
      const parsed = !/[\u0000-\u001f\u007f]/.test(query)
        && /^in:(inbox|sent)(?: +newer_than:([1-9]\d{0,3})[dmy])?$/i.exec(query.trim());
      if (parsed) gmailSearch = { area: parsed[1].toLowerCase(), filtered: !!parsed[2], suffix: !!match[2] };
    } catch { /* Malformed or double-encoded queries establish no route area. */ }
  }
  // Unknown, filtered and suffix-bearing searches cannot establish an inbox inventory,
  // even when a native input or the sidebar independently identifies an area.
  const inboxSearchScoped = provider === 'gmail' && (/#search(?:\/|$|%)/i.test(route) || /^#search(?:\/|$|%)/i.test(location.hash))
    && !(gmailSearch?.area === 'inbox' && !gmailSearch.filtered && !gmailSearch.suffix);
  const areas: string[] = [];
  if (gmailSearch) areas.push(gmailSearch.area);
  else {
    if (!calendar && (/#inbox(?:\/|$)|\/inbox(?:\/|$)/i.test(route) || queries.some(query => /(?:^|\s)(?:in|folder):inbox(?:\s|$)/i.test(query)) || selected.some(text => /^(inbox|inkorg|inkorgen)(?:\s*\(?\d+\)?\s*)?$/i.test(text.trim())))) areas.push('inbox');
    if (!calendar && (/#sent(?:\/|$)|\/(?:sent|sentitems)(?:\/|$)/i.test(route) || queries.some(query => /(?:^|\s)(?:in|folder):sent(?:\s|$)/i.test(query)) || selected.some(text => /^(sent|sent items|sänt|skickat|skickade objekt)(?:\s*\(?\d+\)?\s*)?$/i.test(text.trim())))) areas.push('sent');
  }
  if (calendar) areas.push('calendar');
  const listSelectors = calendar ? '[role="grid"],[role="treegrid"],[data-testid="calendar-grid"],.zcl-calendar' : provider === 'gmail' ? '[role="main"] [role="grid"],table.F' : provider === 'outlook' ? '[role="listbox"],[data-testid="message-list"]' : '.zmMailList,[data-testid="mail-list"],[role="grid"]';
  const nativeZohoList = !calendar && provider === 'zoho' && [...document.querySelectorAll('div.zmList[role="option"][data-ty][aria-controls]')]
    .some(e => visible(e) && !!e.getAttribute('aria-controls') && !e.closest('.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"],button,a,[role="button"],[role="menuitem"]'));
  const list = nativeZohoList || [...document.querySelectorAll(listSelectors)].some(visible);
  const emptySelectors = calendar ? '[role="status"],[data-testid="empty-agenda"],.zcl-empty' : provider === 'outlook'
    ? '[role="listbox"] [role="status"],[role="listbox"] [data-testid="empty-message-list"]'
    : '[role="main"] [role="status"],[role="main"] [role="alert"],.TC,.zmNoMail,[data-testid="empty-message-list"]';
  const outlookEmptyList = provider !== 'outlook' || calendar || list && ![...document.querySelectorAll('[role="listbox"] [role="option"]')].some(visible);
  const empty = !containers.length && outlookEmptyList && [...document.querySelectorAll<HTMLElement>(emptySelectors)].some(e => visible(e) && /^(no (?:conversations|messages|results|items|events)(?: found| to display| to show)?[.!]?|there are no (?:items|events) to show[.!]?|you have no messages[.!]?|inga (?:konversationer|meddelanden|resultat|objekt|händelser)(?: hittades| att visa)?[.!]?|det finns inga (?:objekt|händelser) att visa[.!]?)$/i.test(e.innerText.trim()));
  const nativeThread = calendar ? eventIds.length === 1 ? `event:${eventIds[0]}` : null : uniqueThreads.length === 1 ? uniqueThreads[0] : null;
  const detail = !!(nativeThread || urlThreadId) && !!scopeText.trim() && containers.length > 0;
  const view = detail ? 'detail' : empty ? 'empty' : list ? 'list' : 'unsupported';
  const historyComplete = detail && (calendar || messages.length > 0 && messages.every(message => message.complete));
  // The visible native list rows, so the host knows which mail a check must give an outcome.
  // Only what the provider renders is reported: an absent read state or date stays absent.
  const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, dec: 11 };
  const fullDate = (value: string) => {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) { const parsed = Date.parse(text); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined; }
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
    const named = /\b(\d{1,2})\.?\s+([A-Za-zÅÄÖåäö]{3,})\.?,?\s+(\d{4})\b/.exec(text) || /\b([A-Za-zÅÄÖåäö]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(text);
    let year: number, month: number, day: number, rest: string;
    if (iso) { year = Number(iso[1]); month = Number(iso[2]) - 1; day = Number(iso[3]); rest = text.slice(iso.index + iso[0].length); }
    else if (named) {
      const dayFirst = /^\d/.test(named[1]), name = (dayFirst ? named[2] : named[1]).toLowerCase().slice(0, 3);
      if (!Object.hasOwn(months, name)) return undefined;
      year = Number(named[3]); month = months[name]; day = Number(dayFirst ? named[1] : named[2]); rest = text.slice(named.index + named[0].length);
    } else return undefined;
    const clock = /(\d{1,2})[:.](\d{2})(?:\s*([AaPp])\.?\s?[Mm]\.?)?/.exec(rest);
    let hours = clock ? Number(clock[1]) : 0;
    const minutes = clock ? Number(clock[2]) : 0;
    if (clock?.[3]) hours = hours % 12 + (/p/i.test(clock[3]) ? 12 : 0);
    if (hours > 23 || minutes > 59) return undefined;
    // A date without a time is read as the end of that day, so it never ends before the mail arrived.
    const date = clock ? new Date(year, month, day, hours, minutes) : new Date(year, month, day, 23, 59, 59, 999);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.toISOString() : undefined;
  };
  // The provider's time element when the row has one; otherwise the latest readable date of its
  // titles. A title the sender controls can then only pull a row into the look-back window and
  // force a review, never date it out. A date beyond tomorrow is never a row date.
  const rowDate = (values: (string | null)[]) => {
    let latest: string | undefined;
    for (const value of values) {
      const parsed = value ? fullDate(value) : undefined;
      if (parsed && Date.parse(parsed) <= Date.now() + 86_400_000 && (!latest || Date.parse(parsed) > Date.parse(latest))) latest = parsed;
    }
    return latest;
  };
  const rowSelector = provider === 'gmail' ? '[role="main"] tr[role="row"].zA' : provider === 'outlook' ? '[role="listbox"] [role="option"]' : 'div.zmList[role="option"][data-ty][aria-controls]';
  const rowBodies = '.a3s,.ii,.adn,.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"]';
  const threadAttribute = '[data-legacy-thread-id],[data-thread-id],[data-convid],[data-conversation-id]';
  const lastAttribute = '[data-legacy-last-non-draft-message-id],[data-legacy-last-message-id]';
  const listRows = () => calendar ? [] : [...document.querySelectorAll<HTMLElement>(rowSelector)].filter(row => visible(row) && !row.closest(rowBodies)).slice(0, 100).map(row => {
    const threadNode = row.matches(threadAttribute) ? row : row.querySelector(threadAttribute);
    const lastNode = row.matches(lastAttribute) ? row : row.querySelector(lastAttribute);
    const label = (row.getAttribute('aria-label') || '').trim();
    // Gmail issues refs on its subject cells rather than on their structural TR.
    // Reuse that exact native cell; other cells may toggle selection or actions.
    const subject = provider === 'gmail' && row.closest('[role="main"] [role="grid"]') && !row.closest('button,a,[role="button"],[role="menuitem"]')
      ? [...row.children].find(cell => cell.matches('td.a4W[role="gridcell"][data-ccmcp-ref]') && visible(cell)) : undefined;
    const unread = provider === 'gmail' && row.classList.contains('zE') ? true : provider === 'gmail' && row.classList.contains('yO') ? false : /^(unread|oläst)\b/i.test(label) ? true : undefined;
    const at = rowDate([row, ...row.querySelectorAll('time[datetime]')].map(element => element.getAttribute('datetime')))
      ?? rowDate([row, ...row.querySelectorAll('[title]')].map(element => element.getAttribute('title')));
    return { ref: row.getAttribute('data-ccmcp-ref') || subject?.getAttribute('data-ccmcp-ref') || null, unread, at,
      thread: threadNode?.getAttribute('data-legacy-thread-id') || threadNode?.getAttribute('data-thread-id') || threadNode?.getAttribute('data-convid') || threadNode?.getAttribute('data-conversation-id') || null,
      last: lastNode?.getAttribute('data-legacy-last-non-draft-message-id') || lastNode?.getAttribute('data-legacy-last-message-id') || null,
      draft: provider === 'gmail' && (!!row.querySelector('.boq') || (() => {
        const attribute = (name: string) => (row.matches(`[${name}]`) ? row : row.querySelector(`[${name}]`))?.getAttribute(name);
        const real = attribute('data-legacy-last-non-draft-message-id'), newest = attribute('data-legacy-last-message-id');
        return !!real && !!newest && real !== newest;
      })()),
      text: (row.innerText || row.textContent || label).replace(/\s+/g, ' ').trim().slice(0, 500) };
  });
  // Rows only add to what a read proves; a layout they cannot be read from leaves the read itself intact.
  let rows: ReturnType<typeof listRows> = [];
  try { rows = listRows(); } catch { rows = []; }
  return { nativeThread, nativeMessage: ids.at(-1) || null, scopeText: detail ? scopeText : '', areas, view, truncated: bodyWasTruncated || rawScope.length > scopeText.length,
    historyComplete, messages: detail ? messages : [], chronological: provider === 'gmail' && historyComplete, rows, inboxSearchScoped,
    attachmentReviewCandidate: provider === 'gmail' && detail && !bodyWasTruncated && containers.length === 1 && (() => {
      const root = containers[0], body = root.querySelector<HTMLElement>('.a3s.aiL');
      const boundary = '.a3s,.ii,[role="document"],[contenteditable="true"]';
      const native = [...document.querySelectorAll('.adn')].filter(e => outsideList(e) && !e.closest(boundary));
      return native.length === 1 && !!(root.getAttribute('data-message-id') || root.getAttribute('data-legacy-message-id'))
        && !!body?.children.length && !body.textContent?.trim()
        && [...body.querySelectorAll('*')].every(e => /^(DIV|SPAN|BR)$/.test(e.tagName))
        && !root.closest('[aria-busy="true"]') && ![...root.querySelectorAll('[aria-busy="true"],[role="progressbar"],.gH [aria-expanded="false"]')].some(visible)
        && [...root.querySelectorAll('.aQH .aZo > a.aQy[role="link"]')].some(e => visible(e) && !e.closest(boundary) && e.closest('.adn') === root);
    })() };
}
export { messageMetadataScript as assistantMessageMetadataScript };

/** Native Gmail opening targets omitted by the bounded general page scan. */
function gmailRowTargetsScript(): string[] {
  const targets: string[] = [];
  const excluded = '.a3s,.ii,.adn,.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"],button,a,[role="button"],[role="menuitem"],[hidden],[aria-hidden="true"],[inert]';
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  for (const row of document.querySelectorAll('[role="main"] [role="grid"] tr.zA[role="row"]')) {
    if (row.closest(excluded) || /^ref_\d+$/.test(row.getAttribute('data-ccmcp-ref') || '')) continue;
    const cell = [...row.children].find(e => e.matches('td.a4W[role="gridcell"]'));
    if (!cell || cell.closest(excluded) || /^ref_\d+$/.test(cell.getAttribute('data-ccmcp-ref') || '')) continue;
    if (!visible(cell)) continue;
    const parts: string[] = [];
    let current: Element | null = cell;
    while (current && parts.length < 60) {
      const parent: Element | null = current.parentElement;
      const siblings = parent ? [...parent.children].filter(e => e.tagName === current!.tagName) : [current];
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = parent;
    }
    if (!current) targets.push(parts.join(' > '));
    if (targets.length === 12) break;
  }
  return targets;
}
export { gmailRowTargetsScript as assistantGmailRowTargetsScript };

export interface AssistantElement { visible: boolean; label: string; text: string; type: string; role: string; href: string | null; row: boolean; body: boolean; search: boolean; messageContent?: boolean; readingControl?: boolean; bodyContent?: boolean; readingContainerId?: string; folder?: boolean; nativeGmailSubject?: boolean }
function elementScript(ref: string, provider: string): AssistantElement | null {
  const e = document.querySelector(`[data-ccmcp-ref="${ref}"]`) as HTMLElement | null;
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const label = e.getAttribute("aria-label") || e.getAttribute("title") || (e as HTMLInputElement).placeholder || "";
  const role = e.getAttribute("role") || "";
  const type = (e as HTMLInputElement).type || e.tagName;
  const messageContent = !!e.closest('.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"],.adn,[data-app-section="MailReadCompose"]');
  const actionControl = !!e.closest('button,a,[role="button"],[role="menuitem"]');
  const nativeZohoRow = provider === 'zoho' && e.matches('div.zmList[role="option"][data-ty][aria-controls]') && !!e.getAttribute('aria-controls');
  const bodyRoot = '.a3s,.ii,[role="document"],.zmMailMsgBody,[data-testid="message-body"],[contenteditable="true"]';
  const bodyContent = !!e.closest(bodyRoot);
  const nativeGmailSubject = provider === 'gmail' && !messageContent && !actionControl && !bodyContent && e.matches('td.a4W[role="gridcell"]')
    && !!e.parentElement?.matches('tr.zA[role="row"]') && !!e.parentElement.closest('[role="main"] [role="grid"]');
  const header = provider === 'gmail' ? '.adn .gH,.adn .aju,.adn .ady' : provider === 'outlook' ? '[data-app-section="MailReadCompose"] [role="heading"],[role="main"].Mq3cC [role="heading"]' : '.zmMailHdr,.zmMailHeader,.zmConversationHeader';
  const zohoRoot = e.parentElement?.matches('.zmPVMail[role="listitem"][id]') ? e.parentElement : undefined;
  const nativeZohoDisclosure = provider === 'zoho' && e.matches('.zmMailHeader.zmTMailList') && !!zohoRoot && ![...zohoRoot.querySelectorAll('.zmMailContent [role="document"].jsConTent,.zmMailMsgBody')].some(body => !!body.textContent?.trim());
  const readingControl = !bodyContent && !e.closest('a') && (provider === 'zoho' ? nativeZohoDisclosure : (role === 'button' || e.tagName === 'BUTTON') && e.getAttribute('aria-expanded') === 'false' && !!e.closest(header));
  return { visible: r.width > 0 && r.height > 0, label, text: (e.innerText || "").slice(0, 1000), type, role,
    href: e.closest("a")?.href || null,
    row: !messageContent && !actionControl && (/^(row|option|listitem)$/.test(role) && (!!e.closest('[role="grid"],[role="listbox"]') || nativeZohoRow) || nativeGmailSubject),
    nativeGmailSubject,
    messageContent,
    folder: provider === 'zoho' && !messageContent && !actionControl && e.matches('.zmTreeNode[data-testid="lhs-tree-node"][role="treeitem"]')
      && /^\d{8,30}$/.test(e.id) && document.querySelectorAll(`[id="${e.id}"]`).length === 1
      && document.querySelectorAll('#zmlTree[role="group"]').length === 1 && !!e.closest('#zmlTree[role="group"]'),
    readingControl,
    readingContainerId: nativeZohoDisclosure ? e.closest('.zmPVMail')?.id : undefined,
    bodyContent,
    body: e.isContentEditable && /message body|message content|meddelandetext|meddelandets brödtext|meddelandeinnehåll/i.test(label),
    search: /search|sök/i.test(label) && e.matches('input:not([type="password"]):not([type="hidden"]),[role="searchbox"]'),
  };
}
export { elementScript as assistantElementScript };

/** Labels of controls that change mail or calendar; refused unless the control is a native row. */
export const ASSISTANT_CHANGING_CONTROL = /\b(send|skicka|delete|radera|remove|archive|arkivera|move|flytta|mark|markera|unsubscribe|avprenumerera|forward|vidarebefordra|new message|nytt meddelande|compose|skriv|save|spara|accept|acceptera|decline|avböj|join|anslut)\b/i;
/** Reply controls; opened only in approved-send mode. */
export const ASSISTANT_REPLY_CONTROL = /^(reply|svara)(\s*\(.*\))?$/i;
export function guardAssistantElement(operation: "click" | "search" | "fill", element: AssistantElement | null, account: AssistantAccount, url: string, approval?: AssistantSendApproval): void {
  assistantUrl(account, url);
  if (!element?.visible) throw new Error("Kontrollen är dold eller saknas. Läs sidan igen.");
  if (element.messageContent && /^(row|option|listitem)$/.test(element.role)) throw new Error("En rad inuti meddelandetexten får inte användas som inkorgens native meddelanderad.");
  const label = normalize(element.label || element.text);
  const nativeSubjectClick = operation === 'click' && account.provider === 'gmail' && element.row && element.nativeGmailSubject === true;
  // Mail subjects may discuss sign-ins; this DOM-derived exception never applies to login controls.
  if (!nativeSubjectClick && /password|lösenord|sign.?in|log.?in|logga in/i.test(element.type + " " + label)) throw new Error("Inloggning hanteras av dig i webbläsaren.");
  if (element.href) assistantUrl(account, element.href);
  const approved = approval && approval.account.id === account.id && approval.account.email.toLowerCase() === account.email.toLowerCase() && approval.sourceUrl === url;
  if (operation !== "fill" && element.bodyContent) throw new Error("Kontroller inuti själva meddelandetexten får inte användas som tjänstens läskontroller.");
  if (operation === "search") {
    if (!element.search) throw new Error("Endast tjänstens sökfält får fyllas och skickas med Enter.");
    return;
  }
  if (operation === "fill") {
    if (!approved || !element.body) throw new Error("Endast det uttryckligen godkända svarets meddelandetext får fyllas.");
    return;
  }
  if (element.row || account.provider === 'zoho' && element.readingControl && element.readingContainerId) return;
  if (account.provider === 'zoho' && element.folder && !approval) return;
  if (ASSISTANT_CHANGING_CONTROL.test(label)) throw new Error("Kontrollen ändrar e-post eller kalender och är spärrad.");
  if (element.readingControl) return;
  if (ASSISTANT_REPLY_CONTROL.test(label)) {
    if (!approved) throw new Error("Svar får endast öppnas efter ditt uttryckliga godkännande av exakt svar.");
    // Outlook saves a draft the moment Reply is pressed, and its reply box cannot be verified yet: stopping here leaves nothing behind.
    if (account.provider === "outlook") throw new Error("Outlook-svar kan inte skickas härifrån ännu. Svara direkt i Outlook; ingenting skickades.");
    return;
  }
  if (element.href || element.role === "tab" || element.search || /^(inbox|inkorg|sent|sent items|skickat|skickade objekt|calendar|kalender|mail|e-post|search|sök|back|tillbaka|previous|föregående|next|nästa|today|idag|day|dag|week|vecka|month|månad|show more|visa mer|expand|expandera|all mail|all e-post|folders|mappar)(\b|\s)/i.test(label)) return;
  throw new Error("Kontrollen kan inte verifieras som en läsåtgärd. Använd sökning eller öppna en källadress.");
}

export interface AssistantComposer { from: string[]; fromImplicit?: boolean; to: string[]; cc: string[]; bcc: string[]; fieldsVerified: boolean; unknownRecipients: string[]; body: string; sendRef: string | null; bodyRef: string | null; url: string }
function composerScript(): AssistantComposer | null {
  const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const editors = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"]')].filter(e => visible(e) && /message body|message content|meddelandetext|meddelandets brödtext|meddelandeinnehåll/i.test(e.getAttribute("aria-label") || ""));
  if (editors.length !== 1) return null;
  const body = editors[0];
  const root = body.closest('[role="dialog"],form,[data-app-section="MailCompose"],.M9,.zmCompose') || body.closest('[role="main"]');
  if (!root) return null;
  const field = (names: string[]) => {
    const emails: string[] = [];
    let found = false;
    for (const e of root.querySelectorAll<HTMLElement>('[aria-label],input[name],textarea[name],[data-recipient-type]')) {
      const label = e.getAttribute("aria-label") || e.getAttribute("name") || e.getAttribute("data-recipient-type") || "";
      if (!names.some(name => new RegExp(`^${name}(?:$|[:\\s])`, "i").test(label))) continue;
      if (e.matches('button,a,[role="button"]')) continue;
      if (!e.matches('input,textarea,[role="textbox"],[role="combobox"],[data-recipient-type]') && !e.querySelector('input,textarea,[email],[data-email]')) continue;
      found = true;
      const value = [label, (e as HTMLInputElement).value || "", e.innerText || "", e.getAttribute("email") || "", e.getAttribute("data-email") || ""].join(" ");
      emails.push(...(value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(email => email.toLowerCase()));
    }
    return { emails: [...new Set(emails)], found };
  };
  // Gmail wraps the keyboard hint in a button's label in invisible direction marks.
  const plain = (text: string) => text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const sends = [...root.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(e => visible(e) && /^(send|skicka)(?:$|\s*\()/i.test(plain(e.getAttribute("aria-label") || e.getAttribute("data-tooltip") || e.getAttribute("title") || e.innerText)));
  if (sends.length !== 1) return null;
  const from = field(["from", "från"]);
  let to = field(["to", "till"]), cc = field(["cc", "kopia"]), bcc = field(["bcc", "hemlig kopia"]);
  // Gmail's reply box keeps its recipients in To, Cc and Bcc rows that stay hidden until opened, shows a one-line
  // summary instead, and has no From field for an account with one address. Only exactly that shape counts, and the
  // rows decide who receives the mail; the summary may only agree with them. Anything else stops at the field checks.
  const chipSelector = '[email],[data-email],[data-hovercard-id]';
  const address = (e: Element) => (e.getAttribute("email") || e.getAttribute("data-email") || e.getAttribute("data-hovercard-id") || "").toLowerCase();
  const labelled = [...root.querySelectorAll('[aria-label]')].map(e => ({ e, label: plain(e.getAttribute("aria-label") || "").trim().toLowerCase() }));
  const row = (names: string[]) => { const found = labelled.filter(item => names.includes(item.label)); return found.length === 1 ? found[0].e : null; };
  const [toRow, ccRow, bccRow] = [row(["till", "to"]), row(["kopia", "cc"]), row(["hemlig kopia", "bcc"])];
  const summaries = root.matches('.M9') ? [...root.querySelectorAll('.aoD .oL')].filter(visible) : [];
  const fromInput = root.querySelector<HTMLInputElement>('input[name="from"]');
  let fromImplicit = false;
  if (toRow && ccRow && bccRow && summaries.length === 1 && fromInput?.type === "hidden" && !fromInput.value
    && ![toRow, ccRow, bccRow].some(e => [...e.querySelectorAll<HTMLInputElement>('input,textarea')].some(input => input.value))
    && !labelled.some(item => /^(from|från|to|till|cc|kopia|bcc|hemlig kopia)(?:$|[:\s])/.test(item.label) && visible(item.e))
    && ![...root.querySelectorAll<HTMLElement>('*')].some(e => visible(e) && !body.contains(e) && /^(from|från)\b/i.test(plain(e.textContent || "").trim()))) {
    const inRow = (e: Element) => [...new Set([...e.querySelectorAll(chipSelector)].map(address))];
    // A row may not hold anyone its chips do not name: an address as text or in a label, or a chip with no readable address.
    const named = (e: Element) => [e.textContent || "", ...[...e.querySelectorAll("[aria-label],[title]")].flatMap(item => [item.getAttribute("aria-label") || "", item.getAttribute("title") || ""])].join(" ").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
    const readable = (e: Element) => named(e).every(item => inRow(e).includes(item)) && ![...e.querySelectorAll('.afV,[role="option"]')].some(item => !address(item));
    const shown = [...summaries[0].querySelectorAll(chipSelector)].map(address), line = summaries[0].cloneNode(true) as Element;
    line.querySelectorAll(chipSelector).forEach(e => e.remove());
    const rows = { to: inRow(toRow), cc: inRow(ccRow), bcc: inRow(bccRow) };
    // Digits or separators mean the line counts people ("och 3 till") or lists them, rather than naming one.
    if ([toRow, ccRow, bccRow].every(readable) && new Set(shown).size <= 1 && shown.every(item => rows.to.includes(item)) && !/[\d,;]/.test(line.textContent || "")) {
      fromImplicit = true;
      to = { emails: rows.to, found: true }; cc = { emails: rows.cc, found: true }; bcc = { emails: rows.bcc, found: true };
    }
  }
  const known = new Set([...from.emails, ...to.emails, ...cc.emails, ...bcc.emails]);
  const unknown = new Set<string>();
  for (const e of root.querySelectorAll<HTMLElement>('[email],[data-email],[data-hovercard-id],[title],input[name],textarea[name]')) {
    if (body.contains(e)) continue;
    // Gmail's "uet" fields list the thread's participants, not this reply's recipients: a reply to a Reply-To address names the sender there while its To row names someone else.
    if (fromImplicit && e.matches('input[name="uet"]')) continue;
    const text = [e.getAttribute('email'), e.getAttribute('data-email'), e.getAttribute('data-hovercard-id'), e.getAttribute('title'), (e as HTMLInputElement).value || ''].join(' ');
    for (const email of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) if (!known.has(email.toLowerCase())) unknown.add(email.toLowerCase());
  }
  return { from: from.emails, fromImplicit, to: to.emails, cc: cc.emails, bcc: bcc.emails, fieldsVerified: [from, to, cc, bcc].every(field => field.found), unknownRecipients: [...unknown],
    body: body.innerText.replace(/\r\n/g, "\n"), sendRef: sends[0].getAttribute("data-ccmcp-ref"), bodyRef: body.getAttribute("data-ccmcp-ref"), url: location.href };
}
export { composerScript as assistantComposerScript };

/** A directly read Gmail card names its thread by this ID, while Gmail replaces that part of the address after loading. */
function directGmailThread(approval: AssistantSendApproval): string | undefined {
  return approval.account.provider === 'gmail' && /^gmail:[0-9a-f]{12,24}$/i.test(approval.threadId) ? approval.threadId.slice('gmail:'.length) : undefined;
}
/** Page-side test that the tab shows the approved thread: its exact address, or Gmail's own heading at the same mailbox location. */
function approvalPin(approval: AssistantSendApproval): string {
  const exact = `location.href===${JSON.stringify(approval.sourceUrl)}`, thread = directGmailThread(approval);
  if (!thread) return exact;
  const [base, hash = ''] = approval.sourceUrl.split('#');
  return `(${exact}||(location.href.split('#')[0]===${JSON.stringify(base)}&&location.hash.slice(1).split('/')[0]===${JSON.stringify(hash.split('/')[0])}&&[...document.querySelectorAll('h2[data-legacy-thread-id]')].some(e=>e.getAttribute('data-legacy-thread-id')===${JSON.stringify(thread)}&&e.getBoundingClientRect().width>0&&!e.closest('.adn,.ii,.a3s'))))`;
}

export function verifyAssistantComposer(actual: AssistantComposer | null, approval: AssistantSendApproval): AssistantComposer {
  if (!actual || !actual.sendRef || !/^ref_\d+$/.test(actual.sendRef) || !actual.fieldsVerified || actual.unknownRecipients.length) throw new Error("Svarsredigeraren stöds inte säkert. Visa Från, Till, Kopia och Hemlig kopia i svaret så alla fält kan kontrolleras, eller skicka det själv.");
  const email = (value: string) => value.trim().toLowerCase();
  // With no From field in Gmail's reply box, the sender is the account whose identity was verified, so no other sender can have been approved.
  const senderMatches = actual.fromImplicit
    ? approval.account.provider === "gmail" && !approval.sender && !actual.from.length
    : actual.from.length === 1 && email(actual.from[0]) === email(approval.sender ?? approval.account.email);
  if (actual.url !== approval.sourceUrl || !senderMatches
    || actual.to.length !== 1 || email(actual.to[0]) !== email(approval.recipient) || actual.cc.length || actual.bcc.length
    || actual.body.replace(/\r\n/g, "\n") !== approval.body.replace(/\r\n/g, "\n")) throw new Error("Svaret avviker från godkännandet: kontrollera konto, tråd, Från, Till, kopior och exakt text. Ingenting skickades.");
  return actual;
}

function sentFeedbackScript() {
  const notices = [...document.querySelectorAll('[role="status"],[role="alert"],.vh,.zmToast')].map(e => (e as HTMLElement).innerText || "");
  return notices.find(text => /message sent|message has been sent|your message has been sent|meddelandet har skickats|meddelande skickat|e-postmeddelandet har skickats|mail sent successfully/i.test(text))?.slice(0, 1000) || "";
}

/**
 * The environment of the assistant's own MCP server. The assistant's data directory lies inside
 * the per-user data directory (by default ~/.claude-chrome-mcp, with the bridge token, module
 * records and recipes). That directory is the server's deny root, so no browser tool gives a page
 * a file from it. The root is always set here and never inherited from the parent process.
 */
export function assistantServerEnvironment(dataDir: string): Record<string, string> {
  const env: Record<string, string> = { CCMCP_CONFIG_DIR: join(dataDir, "browser-store"), CCMCP_LOG_DIR: join(dataDir, "browser-logs"), CCMCP_UPLOAD_DENY_ROOT: dirname(resolve(dataDir)) };
  for (const key of ["CCMCP_PORT", "CCMCP_CLIENT_PORT", "CCMCP_MODULE_CONFIG_DIR", "BRIDGE_TOKEN", "PATH", "HOME", "USERPROFILE", "SYSTEMROOT"]) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

type GmailListedThread = { tabId: number; last?: string; draft: boolean; areas: Set<string> };
export class AssistantBrowser {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<void>;
  private closed = false;
  private tabs = new Map<number, AssistantAccount>();
  private warmedTabs = new Set<number>();
  private foregroundAttempts = new Set<number>();
  readonly observations = new Map<string, AssistantObservation>();
  /** Observations stored so far, including reads a thread expansion makes internally; only the newest 80 are kept. */
  private observationSequence = 0;
  private attachmentReads = new Map<number, { key: string; at: number }>();
  readonly coverageAreas = new Map<string, Set<string>>();
  readonly readingProofs = new Map<string, AssistantReadingProof[]>();
  /** Native inbox rows this run has seen, per account and row key. */
  readonly inboxRows = new Map<string, Map<string, AssistantSeenRow>>();
  /** What the inbox list showed per account: parsed rows, an explicit empty inbox, or rows it could not parse. */
  readonly inboxListed = new Map<string, "rows" | "empty" | "unparsed">();
  /** Native incoming folders discovered in the verified Zoho account, independently of its profile name. */
  readonly mailFolders = new Map<string, Map<string, AssistantMailFolder>>();
  /** The thread a click on an inbox row opened, by `${accountId}\0${row key}`. */
  readonly rowThreads = new Map<string, string>();
  /** Gmail threads a native list showed in this session: the only ones that can be read by ID. */
  private readonly gmailThreads = new Map<string, Map<string, GmailListedThread>>();
  private zohoApi?: AssistantZohoApi;
  private readonly zohoAccounts = new Set<string>();
  /** A web view of an API-read conversation, by its route ID, still answers for the inbox row. */
  private readonly zohoAnchors = new Map<string, { accountId: string; key: string; version: string }>();
  /** Accounts whose API inventory stopped at its page limit. */
  readonly inventoryCut = new Set<string>();
  private get zoho(): AssistantZohoApi { return this.zohoApi ??= new AssistantZohoApi(this.dataDir); }
  /** Row refs of each tab's latest read; a read replaces them, as refs are per snapshot. */
  private rowRefs = new Map<number, Map<string, string>>();
  /** A row click awaiting the read that shows its thread. Any other page change drops it. */
  private rowClicks = new Map<number, { accountId: string; key: string; before: string }>();
  /** The thread each tab's latest read showed in its detail, or '' for none: the read a click's ref came from. */
  private shownThreads = new Map<number, string>();
  private dispatchStarted = false;
  private lastTabId?: number;
  constructor(private root: string, private dataDir: string, private approval?: AssistantSendApproval, private approvedMessageId?: string, private windowId?: number) {}

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Assistentens webbläsarsession har avslutats.");
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "tabai-daily-assistant", version: "1.0.0" });
      // No read limit on this link. The MCP SDK closes a stdio link when one reply exceeds
      // its read limit, which would end this session's server and browser mid-run; the
      // host's own size checks refuse an oversized result instead and keep the link. No
      // ceiling applies upstream of those checks, and the peer is this process's own child.
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(this.root, "dist/server.js")], cwd: this.root, env: assistantServerEnvironment(this.dataDir), stderr: "pipe", maxBufferSize: Number.POSITIVE_INFINITY });
      this.transport = transport;
      transport.stderr?.on("data", () => {});
      try {
        await client.connect(transport);
        if (this.closed) { await client.close(); throw new Error("Assistentens webbläsarsession har avslutats."); }
        this.client = client;
      } catch (error) {
        try { await transport.close(); } catch { /* The transport may already be closed. */ }
        throw error instanceof AssistantBrowserError ? error : new AssistantBrowserError("failed", "transport", "Anslutningen till Tabais webbläsare kunde inte startas. Kontrollera tillägget och försök igen.");
      }
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  async call<T = any>(name: string, args: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<T> {
    await this.connect();
    if (this.closed) throw new Error("Assistentens webbläsarsession har avslutats.");
    let result;
    try { result = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }); }
    catch (error) { throw new AssistantBrowserError("failed", "transport", error instanceof Error ? error.message : "Webbläsaranslutningen svarade inte. Försök läsa sidan igen."); }
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const text = content.find(item => item.type === "text")?.text || "";
    if (result.isError) throw new AssistantBrowserError("failed", "browser-tool", text || "Webbläsaråtgärden misslyckades.", /^([A-Z][A-Z_]+): /.exec(text)?.[1]);
    // An image-only result (the screenshot tool) comes back as the extension returned it.
    const image = content.find(item => item.type === "image");
    if (!text && typeof image?.data === "string") return { base64: image.data, mimeType: image.mimeType } as T;
    try { return JSON.parse(text); } catch { return text as T; }
  }
  /** The full-access path preserves MCP image blocks, errors and structured results. */
  async callRaw(name: string, args: Record<string, unknown> = {}) {
    await this.connect();
    if (this.closed) throw new Error('Assistentens webbläsarsession har avslutats.');
    return this.client!.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  }
  async listTools() {
    await this.connect();
    if (this.closed) throw new Error('Assistentens webbläsarsession har avslutats.');
    return this.client!.listTools();
  }
  private script<T>(tabId: number, fn: Function, args: unknown[] = [], world?: 'isolated'): Promise<T> {
    const account = this.tabs.get(tabId);
    if (!account) throw new AssistantBrowserError("failed", "unowned-tab", "Fliken tillhör inte assistentens konto.");
    const allowed = JSON.stringify([...origins[account.provider]]);
    const pin = this.approval ? approvalPin(this.approval) : "true";
    return this.call<T>("javascript_tool", { tabId, ...(world ? { world } : {}), text: `(()=>{if(!${allowed}.includes(location.origin)||!(${pin}))throw new Error('Kontots sida ändrades före läsningen. Läs på nytt.');return (${fn.toString()})(...${JSON.stringify(args)})})()` });
  }
  async context(): Promise<{ tabId: number; accountId: string }[]> { return [...this.tabs].map(([tabId, account]) => ({ tabId, accountId: account.id })); }
  /**
   * Outlook drops a message address on a full page load and shows the list. The running app opens
   * the same address when it gets it through its own history. These steps pass through the app's
   * start page, so they are not pinned to the approved address; every read after them is.
   */
  private async goTo(tabId: number, account: AssistantAccount, url: string): Promise<void> {
    const { origin, pathname } = new URL(url);
    const start = account.provider === 'outlook' && /\/id\/[^/]+$/i.test(pathname) ? /^\/mail\/\d+\//.exec(pathname)?.[0] : undefined;
    if (!start) { await this.call("navigate", { tabId, url, waitUntil: "load" }); return; }
    const shown = (selector: string, text = '') => `[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.getBoundingClientRect().width>0${text})`;
    const heading = shown('[data-app-section="MailReadCompose"] [role="heading"],[role="main"].Mq3cC [role="heading"]');
    await this.call("navigate", { tabId, url: origin + start, waitUntil: "load" });
    try {
      // No message may be on show yet: the address alone cannot prove which one is, since it is written here.
      await this.call("wait_for", { tabId, predicate: `location.origin===${JSON.stringify(origin)}&&location.pathname===${JSON.stringify(start)}&&!!document.querySelector('[role="listbox"]')&&!${heading}`, timeoutMs: 20_000 });
      await this.call("javascript_tool", { tabId, text: `history.pushState(null,'',${JSON.stringify(url)});window.dispatchEvent(new PopStateEvent('popstate',{state:null}));true` });
      await this.call("wait_for", { tabId, predicate: `location.href===${JSON.stringify(url)}&&${heading}&&${shown('[role="document"].BIZfh,[aria-label="Message body"],[aria-label="Meddelandetext"]', '&&!!e.textContent.trim()')}`, timeoutMs: 15_000 });
    } catch (error) {
      if ((error as AssistantBrowserError).toolCode !== "TIMEOUT") throw error;
      // A signed-out session is not a failed opening: the read that follows reports it and offers the sign-in help.
      const tab = (await this.call("tabs_context_mcp")).tabs?.find((item: { tabId: number }) => item.tabId === tabId);
      if (tab && assistantAccessError(account, tab.url)) return;
      throw new AssistantBrowserError("failed", "navigation-changed", "Outlook öppnade inte meddelandet. Öppna det i Outlook och försök igen.");
    }
  }
  private async waitForReady(tabId: number, account: AssistantAccount, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (await this.script<boolean>(tabId, loadingScript, [account.provider])) {
      if (Date.now() >= deadline) throw new AssistantBrowserError("failed", "loading", `${account.label} laddar fortfarande. Vänta tills Inkorg eller kalendern syns i assistentfliken och försök igen; kontot har inte kontrollerats.`);
      await delay(Math.min(400, Math.max(1, deadline - Date.now())));
      const context = await this.call("tabs_context_mcp");
      const current = context.tabs?.find((item: { tabId: number }) => item.tabId === tabId);
      if (!current) throw new AssistantBrowserError("failed", "tab-closed", "Assistentfliken stängdes under laddningen. Öppna kontot på nytt.");
      const accessError = assistantAccessError(account, current.url);
      if (accessError) throw accessError;
    }
  }
  private async sameOwnedPage(tabId: number, account: AssistantAccount, expectedUrl: string): Promise<void> {
    const context = await this.call("tabs_context_mcp");
    const tab = context.tabs?.find((item: { tabId: number }) => item.tabId === tabId);
    if (!this.tabs.has(tabId) || !tab) throw new AssistantBrowserError("failed", "tab-closed", "Assistentfliken har stängts. Öppna kontot igen.");
    const accessError = assistantAccessError(account, tab.url);
    if (accessError) throw accessError;
    if (tab.url !== expectedUrl) throw new AssistantBrowserError("failed", "navigation-changed", "Kontots sida ändrades medan appen laddade. Öppna rätt källadress igen.");
  }
  private async ensureReady(tabId: number, account: AssistantAccount, url: string): Promise<void> {
    try { await this.waitForReady(tabId, account); return; }
    catch (error) {
      if (!(error instanceof AssistantBrowserError) || error.code !== "loading" || this.foregroundAttempts.has(tabId)) throw error;
    }
    await this.sameOwnedPage(tabId, account, url);
    const visibleIdentities = await this.script<string[]>(tabId, identityScript, [account.provider]);
    if (visibleIdentities.length && (visibleIdentities.length !== 1 || visibleIdentities[0] !== account.email.toLowerCase())) throw new AssistantBrowserError("login", "account-mismatch", `Fliken visar ett annat eller flera konton. Välj ${account.email} manuellt innan assistenten får läsa.`);
    // Some cold native apps paint only in a foreground window. This asks the
    // existing user preference gate once; it never changes that preference.
    this.foregroundAttempts.add(tabId);
    try { await this.call("tab_switch", { tabId, bringToFront: true }); }
    catch (error) {
      if (/FOCUS_DISABLED/i.test(error instanceof Error ? error.message : String(error))) throw new AssistantBrowserError("failed", "foreground-required", `${account.label} behöver visas i Chrome för att laddas. Öppna assistentfliken manuellt. Om du vill tillåta automatisk visning kan du själv aktivera ”Tillåt att agenter tar fram Chrome” i tillägget; assistenten ändrar inte inställningen.`);
      throw error;
    }
    await this.sameOwnedPage(tabId, account, url);
    await this.waitForReady(tabId, account);
  }
  private async owned(tabId: number, verify = true): Promise<{ account: AssistantAccount; url: string }> {
    const account = this.tabs.get(tabId);
    if (!account) throw new AssistantBrowserError("failed", "unowned-tab", "Fliken tillhör inte assistentens konto.");
    const context = await this.call("tabs_context_mcp");
    const tab = context.tabs?.find((item: { tabId: number }) => item.tabId === tabId);
    if (!tab) throw new AssistantBrowserError("failed", "tab-closed", "Assistentfliken har stängts. Öppna kontot igen.");
    const accessError = assistantAccessError(account, tab.url);
    if (accessError) throw accessError;
    const url = assistantUrl(account, tab.url);
    if (verify) {
      await this.ensureReady(tabId, account, url);
      let identities = await this.script<string[]>(tabId, identityScript, [account.provider]);
      let opened = false;
      let identityVerified = false;
      try {
        if (!identities.length) {
          const deadline = Date.now() + 4_000;
          while (!identities.length && Date.now() < deadline) {
            // false proves no menu click was dispatched (or it is already open).
            // Retry only that case while a late app header is being painted.
            if (!opened) opened = await this.script<boolean>(tabId, identityMenuScript, [account.provider, "open"]);
            await delay(200);
            identities = await this.script<string[]>(tabId, identityScript, [account.provider]);
          }
        }
        if (!identities.length) throw new AssistantBrowserError("unsupported", "identity-unavailable", `Kontots e-postadress syns inte i den stödda kontomenyn. Öppna profilen för ${account.label} manuellt; logga in som ${account.email} om det behövs.`);
        if (identities.length !== 1 || identities[0] !== account.email.toLowerCase()) throw new AssistantBrowserError("login", "account-mismatch", `Fliken visar ett annat eller flera konton. Välj ${account.email} manuellt innan assistenten får läsa.`);
        identityVerified = true;
      } finally {
        if (opened || account.provider === 'zoho' && identityVerified) await this.script<boolean>(tabId, identityMenuScript, [account.provider, "close"]);
      }
      const after = await this.call("tabs_context_mcp");
      const current = after.tabs?.find((item: { tabId: number }) => item.tabId === tabId);
      if (!current) throw new AssistantBrowserError("failed", "tab-closed", "Assistentfliken stängdes under identitetskontrollen. Öppna kontot igen.");
      const changedAccess = assistantAccessError(account, current.url);
      if (changedAccess) throw changedAccess;
      if (current.url !== url) throw new AssistantBrowserError("failed", "navigation-changed", "Kontots sida ändrades under identitetskontrollen. Läs på nytt.");
    }
    return { account, url };
  }
  async open(account: AssistantAccount, suppliedUrl?: string, options: { lookbackDays?: number } = {}): Promise<unknown> {
    if (this.approval && (account.id !== this.approval.account.id || account.email !== this.approval.account.email)) throw new Error("Godkännandet gäller ett annat konto.");
    if (options.lookbackDays !== undefined && !suppliedUrl && !this.approval && this.zoho.available(account)) {
      // Any API failure leaves the ordinary web route to read and report the account.
      try { return await this.openZohoByApi(account, options.lookbackDays); } catch { /* The web route below still applies. */ }
    }
    let startUrl = account.url;
    if (!suppliedUrl && account.provider === 'zoho') {
      const initial = new URL(startUrl);
      if (!initial.hash && /^\/zm\/?$/.test(initial.pathname)) { initial.hash = 'mail/folder/inbox'; startUrl = initial.href; }
    }
    if (!suppliedUrl && account.provider === "gmail") {
      const initial = new URL(startUrl);
      if (initial.hostname === "mail.google.com") initial.pathname = "/mail/u/";
      initial.searchParams.set("authuser", account.email);
      startUrl = initial.href;
    }
    const url = assistantUrl(account, suppliedUrl || startUrl);
    if (this.approval && url !== this.approval.sourceUrl) throw new Error("Endast den godkända tråden får öppnas i sändningsläget.");
    let tabId = [...this.tabs].find(([, item]) => item.id === account.id)?.[0];
    const context = await this.call("tabs_context_mcp", { createIfEmpty: true, ...(this.windowId === undefined ? {} : { createWindowId: this.windowId }) });
    if (!tabId || !context.tabs?.some((item: { tabId: number }) => item.tabId === tabId)) {
      tabId = (await this.call("tabs_create_mcp")).tabId as number;
      this.tabs.set(tabId, account);
      await this.goTo(tabId, account, url);
    } else if (suppliedUrl) {
      if (account.provider === 'zoho') {
        await this.owned(tabId);
        await this.script(tabId, assistantZohoFoldersScript, ['arm'], 'isolated');
      }
      this.rowClicks.delete(tabId); await this.goTo(tabId, account, url);
    }
    try {
      await this.settleApprovedAddress(tabId);
      let read;
      try { read = await this.read(tabId); }
      catch (error) {
        if (this.approval || !(error instanceof AssistantBrowserError) || !["navigation-changed", "identity-unavailable"].includes(error.code)) throw error;
        // Cold SPAs can canonicalize the route or paint their account header
        // just after readiness. Retry only the read with fresh identity; an
        // account mismatch, login, ambiguous click or send is never replayed.
        read = await this.read(tabId);
      }
      return { tabId, ...read };
    }
    catch (error) {
      const classified = error instanceof AssistantBrowserError ? error : new AssistantBrowserError("failed", "read-failed", error instanceof Error ? error.message : "Sidan kunde inte läsas. Försök igen.");
      return { tabId, accountId: account.id, status: classified.status, code: classified.code, loginRequired: classified.status === "login", message: classified.message };
    }
  }
  async show(account: AssistantAccount, url?: string): Promise<void> {
    const existing = [...this.tabs].find(([, item]) => item.id === account.id)?.[0];
    let tabId = existing;
    if (url || !tabId) tabId = (await this.open(account, url) as { tabId: number }).tabId;
    try { await this.call("tab_switch", { tabId, bringToFront: true }); }
    catch (error) {
      if (!/FOCUS_DISABLED/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await this.call("tab_switch", { tabId, bringToFront: false });
      throw new AssistantBrowserError("unsupported", "focus-disabled", "Assistentfliken är vald i bakgrunden. Öppna Chrome och välj fliken eller använd kontolänken i panelen. För automatisk visning kan du själv aktivera ”Tillåt att agenter tar fram Chrome” i tillägget.");
    }
  }
  async showWork(): Promise<void> {
    const tabId = this.lastTabId ?? [...this.tabs.keys()].at(-1);
    if (!tabId || !this.tabs.has(tabId)) throw new Error("Ingen arbetsflik finns ännu.");
    // Showing an owned login/profile tab lets the user fix access. It does not
    // read that page or bypass identity checks on subsequent browser operations.
    await this.show(this.tabs.get(tabId)!);
  }
  hasHelpTarget(help: AssistantHelp): boolean {
    return [...this.tabs].some(([tabId, account]) => account.id === help.accountId && (help.tabId === undefined || tabId === help.tabId));
  }
  async helpTarget(help: AssistantHelp): Promise<AssistantHelp> {
    const entry = [...this.tabs].find(([, account]) => account.id === help.accountId);
    if (!entry || help.tabId !== undefined && help.tabId !== entry[0]) throw new AssistantBrowserError('failed', 'tab-closed', 'Den blockerade arbetsfliken finns inte kvar. Öppna hjälpen igen från panelen.');
    const [tabId, account] = entry;
    const tabs = await this.call('tabs_context_mcp'), tab = tabs.tabs?.find((item: { tabId: number }) => item.tabId === tabId);
    if (!tab) throw new AssistantBrowserError('failed', 'tab-closed', 'Den blockerade arbetsfliken har stängts. Öppna hjälpen igen från panelen.');
    const url = String(tab.url), access = assistantAccessError(account, url);
    if (access && access.status !== 'login') throw access;
    let sourceUrl = help.sourceUrl;
    if (sourceUrl) assistantUrl(account, sourceUrl);
    try { sourceUrl = assistantUrl(account, url); }
    catch { if (assistantAccessError(account, url)?.status !== 'login') throw new AssistantBrowserError('unsupported', 'unsupported-route', 'Arbetsfliken visar inte kontots tillåtna mejltjänst.'); }
    return { ...help, tabId, ...(sourceUrl ? { sourceUrl } : {}) };
  }
  async showHelp(help: AssistantHelp): Promise<AssistantHelp> {
    let target = await this.helpTarget(help);
    const account = this.tabs.get(target.tabId!)!;
    if (help.sourceUrl && help.code !== 'login' && target.sourceUrl !== help.sourceUrl) {
      if (help.tabId !== undefined) throw new AssistantBrowserError('failed', 'navigation-changed', 'Den blockerade fliken visar en annan källa. Återställ rätt mapp eller tråd innan du fortsätter.');
      // An older help record has no tab identity; explicitly opening it may navigate only to its saved safe source.
      await this.open(account, help.sourceUrl);
      target = await this.helpTarget({ ...help, tabId: target.tabId });
      if (target.sourceUrl !== help.sourceUrl) throw new AssistantBrowserError('failed', 'navigation-changed', 'Den sparade hjälpkällan kunde inte öppnas exakt. Ingen modell har startats.');
    }
    await this.show(account); return target;
  }
  async preflightHelp(help: AssistantHelp): Promise<void> {
    const target = await this.helpTarget(help);
    if (help.sourceUrl && help.code !== 'login' && target.sourceUrl !== help.sourceUrl) throw new AssistantBrowserError('failed', 'navigation-changed', 'Arbetsfliken visar en annan källa. Öppna rätt mapp eller tråd innan du fortsätter.');
    let read = await this.read(target.tabId!);
    if (read.attachmentReviewCandidate && !read.attachmentReviewAvailable) { await delay(550); read = await this.read(target.tabId!); }
    if (!['list', 'detail', 'empty'].includes(String(read.view))) throw new AssistantBrowserError('unsupported', 'layout', 'Mejlvyn kan fortfarande inte läsas. Visa kontots vanliga mejlvy och försök igen.');
    if (!read.attachmentReviewAvailable && (help.code === 'expand-thread' || read.view === 'detail') && (read.historyComplete !== true || read.truncated)) throw new AssistantBrowserError('unsupported', 'history-incomplete', 'Hela tråden kan fortfarande inte läsas. Öppna de äldre meddelandena innan du fortsätter.');
  }
  async mailboxFolder(account: AssistantAccount, area: 'inbox' | 'sent'): Promise<Record<string, unknown>> {
    const tabId = [...this.tabs].find(([, entry]) => entry.id === account.id)?.[0];
    if (!tabId) throw new AssistantBrowserError('failed', 'unowned-tab', 'Öppna kontot innan en mapp testas.');
    const current = await this.owned(tabId), url = new URL(current.url);
    if (account.provider === 'gmail') { url.search = ''; url.hash = area; }
    else if (account.provider === 'zoho') url.hash = `mail/folder/${area}`;
    else { const index = url.pathname.match(/^\/mail\/(\d+)\//)?.[1] || '0'; url.pathname = `/mail/${index}/${area === 'sent' ? 'sentitems' : 'inbox'}`; url.search = ''; url.hash = ''; }
    const result = await this.open(account, url.href) as Record<string, unknown>;
    if (result.code || result.status === 'login' || result.status === 'failed') return result;
    if (['list', 'empty', 'detail'].includes(String(result.view)) && (result.areas as string[] | undefined)?.includes(area)) return result;
    const ready = function (provider: string) {
      const selector = provider === 'gmail' ? '[role="main"] [role="grid"],table.F,.TC' : provider === 'outlook' ? '[role="listbox"]' : 'div.zmList[role="option"][data-ty][aria-controls],.zmNoMail';
      return [...document.querySelectorAll(selector)].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.a3s,.adn,.zmMailContent,[role="document"],[contenteditable="true"]'); });
    };
    await this.call('wait_for', { tabId, predicate: `location.origin===${JSON.stringify(url.origin)}&&(${ready.toString()})(${JSON.stringify(account.provider)})`, timeoutMs: 10000 });
    try { return { tabId, ...await this.read(tabId) }; }
    catch (error) { if (!(error instanceof AssistantBrowserError) || error.code !== 'navigation-changed') throw error; return { tabId, ...await this.read(tabId) }; }
  }
  async firstMessageRef(tabId: number): Promise<string | undefined> {
    const { account } = await this.owned(tabId);
    const candidate = await this.script<{ ref?: string; selector?: string } | undefined>(tabId, function(provider: string) {
      const selector = provider === 'gmail' ? '[role="main"] tr[role="row"].zA' : provider === 'outlook' ? '[role="listbox"] [role="option"]' : 'div.zmList[role="option"][data-ty][aria-controls]';
      const body = '.a3s,.adn,.zmMailContent,.zmReadMailView,.zmMailMsgBody,[data-testid="mail-detail"],[role="document"],[contenteditable="true"]';
      for (const row of document.querySelectorAll<HTMLElement>(selector)) {
        const rect = row.getBoundingClientRect();
        if (!rect.width || !rect.height || row.closest(body)) continue;
        const ref = row.getAttribute('data-ccmcp-ref');
        if (ref && /^ref_\d+$/.test(ref)) return { ref };
        const parts: string[] = [];
        let current: Element | null = row;
        while (current && parts.length < 32) {
          const tag = current.tagName.toLowerCase(), parent: Element | null = current.parentElement;
          const siblings = parent ? [...parent.children].filter(element => element.tagName === current!.tagName) : [current];
          parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
          current = parent;
        }
        if (!current) return { selector: parts.join(' > ') };
      }
      return undefined;
    }, [account.provider]);
    if (candidate?.ref) return candidate.ref;
    if (!candidate?.selector) return undefined;
    return (await this.call('resolve_target', { tabId, target: { selector: candidate.selector, frameId: 0 } })).ref;
  }
  async read(tabId: number): Promise<Record<string, unknown>> {
    const initial = await this.owned(tabId, false);
    this.lastTabId = tabId;
    if (!this.warmedTabs.has(tabId)) {
      // Select every provider's tab inside the owned background window once;
      // native row viewports need this even when Gmail needs no capture.
      this.warmedTabs.add(tabId);
      try { await this.call("tab_switch", { tabId, bringToFront: false }); }
      catch { /* Readiness and ownership below remain authoritative. */ }
      if (initial.account.provider === "outlook"
        || initial.account.provider === "zoho" && await this.script<boolean>(tabId, loadingScript, [initial.account.provider])) {
        // Capture remains auxiliary and local; identity still gates all text.
        try { await this.call("computer", { tabId, action: "screenshot", allowFocus: false }); }
        catch { /* Actual readiness, identity and text decide access. */ }
      }
    }
    const { account, url } = await this.owned(tabId);
    if (url !== initial.url) throw new AssistantBrowserError("failed", "navigation-changed", "Sidan ändrades under bakgrundsladdningen. Läs kontot igen.");
    if (account.provider === 'zoho' && /^#mail\/folder\//.test(new URL(url).hash) && !assistantThreadId('zoho', url)) {
      await this.waitForFolder(tabId, account, url);
    }
    const page = await this.call("read_page", { tabId, filter: "all", frameId: 0, maxResults: 500, maxChars: 40000, compact: true });
    const readMetadata = () => this.script<{ nativeThread: string | null; nativeMessage: string | null; scopeText: string; areas: string[]; view: AssistantView; truncated: boolean; historyComplete?: boolean; chronological?: boolean; messages?: { nativeId: string | null; sender?: string; body: string; complete: boolean }[]; rows?: unknown[]; attachmentReviewCandidate?: boolean; inboxSearchScoped?: boolean }>(tabId, messageMetadataScript, [account.provider, assistantThreadId(account.provider, url) || ""]);
    let metadata = await readMetadata();
    if (account.provider === 'gmail' && metadata.view === 'list' && metadata.rows?.some(row => {
      const parsed = assistantInboxRow(account.provider, row);
      return parsed !== undefined && !parsed.ref;
    })) {
      const targets = await this.script<string[]>(tabId, gmailRowTargetsScript);
      if (targets.length) {
        const deadline = Date.now() + 5_000;
        for (const selector of targets.slice(0, 12)) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          try { await this.call('resolve_target', { tabId, target: { selector, frameId: 0 } }, remaining); }
          catch (error) {
            // A disappearing optional row is not a failed content read. Never retry its old path.
            if (error instanceof AssistantBrowserError && error.code === 'browser-tool' && error.toolCode === 'TOOL_ERROR'
              && error.message === 'TOOL_ERROR: resolve_target: no visible match. []') break;
            throw error;
          }
        }
        // Positions may change during resolution. Only fresh native metadata binds refs to rows.
        metadata = await readMetadata();
      }
    }
    const after = await this.owned(tabId);
    if (after.url !== url) throw new AssistantBrowserError("failed", "navigation-changed", "Sidan ändrades under läsningen. Läs den igen.");
    if (account.provider === 'gmail' && metadata.view === 'list') this.rememberGmailThreads(account, tabId, metadata.rows ?? [], metadata.areas);
    const folder = account.provider === 'zoho' && !this.zohoAccounts.has(account.id) ? await this.readMailFolders(account, tabId, url, metadata.view, metadata.rows) : undefined;
    const sourceId = metadata.view === "detail" ? metadata.nativeThread ? `${account.provider}:${metadata.nativeThread}` : assistantThreadId(account.provider, url) || "" : "";
    const anchored = account.provider === 'zoho' && metadata.view === 'detail' && sourceId ? this.zohoAnchors.get(assistantThreadId('zoho', url) ?? '') : undefined;
    // Only while the row still ends with this message. The web read then replaces an
    // incomplete API read, which could otherwise never be saved or leave the coverage check.
    const anchoredRow = anchored?.accountId === account.id ? this.inboxRows.get(account.id)?.get(anchored.key) : undefined;
    const replacesThread = anchored?.accountId === account.id && (!anchoredRow || anchoredRow.version === anchored.version) ? anchored.key : undefined;
    if (replacesThread) {
      if (anchoredRow) this.rowThreads.set(`${account.id}\0${replacesThread}`, sourceId);
      for (const [id, observation] of this.observations) if (observation.accountId === account.id && observation.sourceId === replacesThread && (observation.historyComplete === false || observation.truncated)) this.observations.delete(id);
    }
    const click = this.rowClicks.get(tabId);
    this.rowClicks.delete(tabId);
    // A split view keeps the earlier detail beside the list, so a click that has not taken
    // effect still shows a detail. A Gmail row's key is its thread, so it binds only when the
    // detail shows that thread; a detail that changed to another thread is not the row's. A row
    // known only by its text binds once the detail has changed since the click, or when the
    // detail is the row's own thread. A row left unbound is read again, never closed.
    const threadKey = account.provider === "gmail" && click?.key.startsWith("gmail:");
    if (click?.accountId === account.id && metadata.view === "detail" && sourceId && (sourceId === click.key || !threadKey && sourceId !== click.before)) this.rowThreads.set(`${account.id}\0${click.key}`, sourceId);
    this.shownThreads.set(tabId, metadata.view === "detail" ? sourceId : "");
    const inboxRows = (metadata.areas.includes("inbox") || folder?.kind === 'custom') && (account.provider !== 'zoho' || !!folder)
      ? this.seeRows(account, tabId, Array.isArray(metadata.rows) ? metadata.rows : [], metadata.view, folder?.url, metadata.inboxSearchScoped !== true) : undefined;
    if (!inboxRows) this.rowRefs.delete(tabId);
    // Ref preparation happens after the bounded page scan. Expose fresh native
    // opening refs independently so Sent remains navigable even at that scan's cap.
    const listedThreads = account.provider === 'gmail' && metadata.view === 'list' ? (metadata.rows ?? []).flatMap(row => {
      const parsed = assistantInboxRow(account.provider, row), text = (row as Record<string, unknown>).text;
      return parsed && this.canReadThread(account.id, parsed.key) ? [{ threadId: parsed.key, label: typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : '' }] : [];
    }).slice(0, 12) : undefined;
    const mailRows = account.provider === 'gmail' && metadata.view === 'list' ? (metadata.rows ?? []).flatMap(row => {
      const parsed = assistantInboxRow(account.provider, row);
      if (!parsed?.ref) return [];
      const text = (row as Record<string, unknown>).text;
      return [{ ref: parsed.ref, label: typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 500) : '' }];
    }).slice(0, 12) : undefined;
    // These native detail routes identify the selected message. Their apps put
    // reply composers inside the read pane, so composer text is not a version.
    const routeMessage = account.provider !== "gmail" ? assistantThreadId(account.provider, url) : undefined;
    const nativeMessage = metadata.nativeMessage || (routeMessage && !routeMessage.includes(":event:") ? routeMessage.slice(account.provider.length + 1) : undefined);
    const messageIds = metadata.messages?.filter(message => message.complete && message.body.trim()).map(message => message.nativeId ? `${account.provider}:message:${message.nativeId}` : `content:${createHash("sha256").update(sourceId + "\n" + (message.sender || "") + "\n" + normalize(message.body)).digest("hex")}`);
    if (messageIds?.length === 1 && nativeMessage && metadata.messages?.length === 1 && !metadata.messages[0].nativeId) messageIds[0] = `${account.provider}:message:${nativeMessage}`;
    const messageId = metadata.messages && metadata.messages.length > 1 && metadata.chronological !== true
      ? `content:${createHash('sha256').update(sourceId + '\n' + JSON.stringify(metadata.messages.map(message => [message.nativeId, message.sender, normalize(message.body), message.complete]))).digest('hex')}`
      : messageIds?.at(-1) || (nativeMessage ? `${account.provider}:message:${nativeMessage}` : sourceId && normalize(metadata.scopeText).length > 30
      ? `content:${createHash("sha256").update(sourceId + "\n" + normalize(metadata.scopeText)).digest("hex")}` : undefined);
    const attachmentKey = metadata.attachmentReviewCandidate && messageId && !metadata.truncated
      ? createHash('sha256').update(url + '\n' + messageId + '\n' + metadata.scopeText).digest('hex') : undefined;
    const previousAttachment = this.attachmentReads.get(tabId);
    const attachmentReviewAvailable = !!attachmentKey && previousAttachment?.key === attachmentKey && Date.now() - previousAttachment.at >= 500;
    if (!attachmentKey) this.attachmentReads.delete(tabId);
    else if (previousAttachment?.key !== attachmentKey) this.attachmentReads.set(tabId, { key: attachmentKey, at: Date.now() });
    // Navigation snapshots can contain other threads and sidebar previews. Only
    // the independently recognized current message/event scope is quotable.
    const evidence = ((attachmentReviewAvailable ? 'Tabais lässtatus: Bilagans innehåll är inte läst. Manuell granskning krävs.\n' : '') + metadata.scopeText).slice(0, 60000);
    const { observationId, observationSeq } = this.recordObservation({ accountId: account.id, email: account.email, url, sourceId, messageId, areas: metadata.areas, view: metadata.view, text: evidence,
      historyComplete: metadata.historyComplete, truncated: metadata.truncated, messageIds, latestSender: metadata.messages?.at(-1)?.sender, chronological: metadata.chronological, tabId, attachmentReviewAvailable });
    return { accountId: account.id, accountEmail: account.email, url, sourceId, messageId, observationId, observationSeq, page, text: evidence, areas: metadata.areas, view: metadata.view, truncated: metadata.truncated,
      ...(account.provider === 'zoho' ? { mailFolders: [...(this.mailFolders.get(account.id)?.values() ?? [])] } : {}),
      ...(mailRows !== undefined ? { mailRows } : {}),
      ...(listedThreads !== undefined ? { listedThreads } : {}),
      ...(replacesThread ? { replacesThread } : {}),
      historyComplete: metadata.historyComplete, messageIds, latestSender: metadata.messages?.at(-1)?.sender, chronological: metadata.chronological, attachmentReviewAvailable, attachmentReviewCandidate: metadata.attachmentReviewCandidate === true, ...(inboxRows !== undefined ? { inboxRows } : {}),
      status: metadata.view === "unsupported" ? "unsupported" : "ready", warning: sourceId && messageId ? "Bara text får citeras; page används för navigering. Kopiera sourceId och messageId till fyndet. Öppna hela tråden och kontrollera skickat." : "Stabil tråd- eller meddelandeidentitet saknas. Öppna meddelandet/händelsen i en egen detaljvy innan fynd skapas. En lista bevisar inte lästa trådar; okänd layout redovisas som unsupported." };
  }
  private recordObservation(observation: AssistantObservation): { observationId: string; observationSeq: number } {
    const observationId = randomUUID();
    this.observations.set(observationId, observation);
    const observed = observation.areas ?? [], areas = this.coverageAreas.get(observation.accountId) || new Set<string>();
    for (const area of observed) areas.add(area);
    this.coverageAreas.set(observation.accountId, areas);
    const proofs = this.readingProofs.get(observation.accountId) || [];
    const proofView = observation.truncated ? "list" : observation.view!;
    for (const area of observed) if (!proofs.some(proof => proof.area === area && proof.view === proofView && proof.historyComplete === observation.historyComplete)) proofs.push({ area, view: proofView, historyComplete: observation.historyComplete });
    this.readingProofs.set(observation.accountId, proofs);
    const observationSeq = ++this.observationSequence;
    while (this.observations.size > 80) this.observations.delete(this.observations.keys().next().value!);
    return { observationId, observationSeq };
  }
  private rememberGmailThreads(account: AssistantAccount, tabId: number, raw: unknown[], areas: string[]): void {
    const threads = this.gmailThreads.get(account.id) ?? new Map<string, GmailListedThread>();
    for (const entry of raw.slice(0, 100)) {
      const row = assistantInboxRow('gmail', entry);
      if (!row || !/^gmail:[0-9a-f]{12,24}$/i.test(row.key)) continue;
      const earlier = threads.get(row.key);
      threads.delete(row.key);
      threads.set(row.key, { tabId, ...(row.native ? { last: row.version } : {}), draft: (entry as { draft?: unknown }).draft === true, areas: new Set([...(earlier?.areas ?? []), ...areas]) });
    }
    while (threads.size > 500) threads.delete(threads.keys().next().value!);
    this.gmailThreads.set(account.id, threads);
  }
  canReadThread(accountId: string, threadId: string): boolean { return this.gmailThreads.get(accountId)?.has(threadId) === true || this.zohoAccounts.has(accountId) && this.zoho.canRead(accountId, threadId); }
  private async openZohoByApi(account: AssistantAccount, lookbackDays: number): Promise<Record<string, unknown>> {
    const inventory = await this.zoho.inventory(account, Date.now() - lookbackDays * 86_400_000);
    this.zohoAccounts.add(account.id);
    if (inventory.complete) this.inventoryCut.delete(account.id); else this.inventoryCut.add(account.id);
    // The inventory covers every folder, including any an earlier web read still listed as unread.
    this.mailFolders.delete(account.id);
    const earlier = this.inboxRows.get(account.id), seen = new Map<string, AssistantSeenRow>();
    inventory.rows.forEach((row, order) => {
      const previous = earlier?.get(row.key);
      seen.set(row.key, { key: row.key, version: row.version, native: true, at: row.at, unread: row.unread, firstUnread: previous && previous.version === row.version ? previous.firstUnread : row.unread, tabId: 0, order });
    });
    this.inboxRows.set(account.id, seen);
    this.inboxListed.set(account.id, !inventory.complete ? 'unparsed' : seen.size ? 'rows' : 'empty');
    const view: AssistantView = seen.size ? 'list' : 'empty';
    const { observationId, observationSeq } = this.recordObservation({ accountId: account.id, email: account.email, url: account.url, sourceId: '', areas: ['inbox'], view, text: '', truncated: false });
    // No sent mail in the period is itself the read Sent area; otherwise a read thread proves it.
    if (!inventory.sentThreads.length) this.recordObservation({ accountId: account.id, email: account.email, url: account.url, sourceId: '', areas: ['sent'], view: 'empty', text: '', truncated: false });
    return { accountId: account.id, accountEmail: account.email, url: account.url, sourceId: '', observationId, observationSeq, text: '', areas: ['inbox'], view, truncated: false, inboxRows: seen.size, apiRead: true,
      listedThreads: inventory.rows.slice(0, 30).map(row => ({ threadId: row.key, label: row.label })), sentThreads: inventory.sentThreads.slice(0, 12), status: 'ready',
      warning: 'Alla inkommande mappar och Skickat är inventerade via Zohos API. Läs trådar med browser_read_thread; listetiketter är bara navigering och får inte citeras.' };
  }
  private async readZohoThread(account: AssistantAccount, threadId: string): Promise<Record<string, unknown>> {
    if (this.approval) throw new AssistantBrowserError('unsupported', 'direct-read-approval', 'Ett godkänt utskick läser bara den godkända tråden i webbvyn.');
    if (!this.zohoAccounts.has(account.id) || !this.zoho.canRead(account.id, threadId)) throw new Error('Tråden har inte visats i en lista i den här kontrollen. Läs listan och använd ett ID från inbox.openThreads.');
    const thread = await this.zoho.readThread(account, threadId);
    const fullText = assistantThreadText(thread), text = fullText.slice(0, 60000), truncated = fullText.length > text.length;
    const messageIds = thread.messages.map(message => `zoho:message:${message.messageId}`), messageId = messageIds.at(-1), latest = thread.messages.at(-1);
    // One Zoho login sends from many addresses, so Zoho's own Sent folder identifies the
    // account. It is a reply only when addressed to whoever wrote last: a forward to a
    // colleague is not. An incoming message that names the account is written by its sender.
    const email = account.email.toLowerCase(), lastIncoming = [...thread.messages].reverse().find(message => message.incoming);
    const answered = !!latest && !latest.incoming && (!lastIncoming?.sender || latest.addressed.includes(lastIncoming.sender));
    const latestSender = answered ? email : latest?.sender === email ? undefined : latest?.sender;
    const areas = [...new Set(thread.messages.map(message => message.incoming ? 'inbox' : 'sent'))];
    // The web route identifies a Zoho conversation by an incoming message in its address.
    const rowVersion = this.inboxRows.get(account.id)?.get(threadId)?.version;
    const anchor = thread.messages.find(message => `zoho:message:${message.messageId}` === rowVersion) ?? [...thread.messages].reverse().find(message => message.incoming) ?? thread.messages.at(-1);
    const url = assistantUrl(account, anchor ? `${new URL(account.url).origin}/zm/#mail/folder/${anchor.folderId}/p/${anchor.messageId}` : account.url);
    if (anchor) this.zohoAnchors.set(`zoho:${anchor.messageId}`, { accountId: account.id, key: threadId, version: `zoho:message:${anchor.messageId}` });
    const { observationId, observationSeq } = this.recordObservation({ accountId: account.id, email: account.email, url, sourceId: threadId, messageId, areas, view: 'detail', text,
      historyComplete: thread.complete, truncated, messageIds, latestSender, chronological: true, ...(thread.replyFrom ? { replyFrom: thread.replyFrom } : {}) });
    return { accountId: account.id, accountEmail: account.email, url, sourceId: threadId, messageId, observationId, observationSeq, text, areas, view: 'detail', truncated,
      historyComplete: thread.complete, messageIds, latestSender, chronological: true, attachmentReviewAvailable: false, attachmentReviewCandidate: false, status: 'ready',
      warning: thread.complete && !truncated ? 'Bara text får citeras. Kopiera sourceId, messageId och url till utfallet.'
        : 'Hela tråden kunde inte läsas här, till exempel när ett meddelande bara består av en bilaga. Öppna url med browser_open och läs tråden i webbvyn.' };
  }
  readThread(account: AssistantAccount, threadId: string): Promise<Record<string, unknown>> {
    return account.provider === 'zoho' ? this.readZohoThread(account, threadId) : this.readGmailThread(account, threadId);
  }
  /**
   * Reads a whole Gmail thread through the owned tab's signed-in session. Nothing is
   * clicked, so a missing list reference, a collapsed message or a hidden window
   * cannot lose part of it. The result is the same evidence a detail read produces.
   */
  async readGmailThread(account: AssistantAccount, threadId: string): Promise<Record<string, unknown>> {
    if (this.approval) throw new AssistantBrowserError('unsupported', 'direct-read-approval', 'Ett godkänt utskick läser bara den godkända tråden i webbvyn.');
    if (account.provider !== 'gmail') throw new AssistantBrowserError('unsupported', 'direct-read-unsupported', 'Direktläsning finns bara för Gmail. Öppna raden och läs den i webbvyn.');
    const seen = this.gmailThreads.get(account.id)?.get(threadId);
    if (!seen) throw new Error('Tråden har inte visats i en lista i den här kontrollen. Läs listan och använd ett ID från inbox.openThreads.');
    const mismatch = () => new AssistantBrowserError('login', 'account-mismatch', `Fliken visar ett annat konto. Välj ${account.email} innan assistenten får läsa.`);
    let owned: Awaited<ReturnType<AssistantBrowser['owned']>>;
    try { owned = await this.owned(seen.tabId); }
    catch (error) {
      // A closed tab cannot read anything it listed; leave those rows to a new list read.
      if (error instanceof AssistantBrowserError && ['tab-closed', 'unowned-tab'].includes(error.code)) for (const [key, entry] of this.gmailThreads.get(account.id) ?? []) if (entry.tabId === seen.tabId) this.gmailThreads.get(account.id)!.delete(key);
      throw error;
    }
    if (owned.account.id !== account.id) throw mismatch();
    this.lastTabId = seen.tabId;
    const native = threadId.slice('gmail:'.length), email = account.email.toLowerCase();
    const fetched = await this.script<Awaited<ReturnType<typeof gmailPrintScript>>>(seen.tabId, gmailPrintScript, [native, email]);
    if (fetched.error === 'account-mismatch') throw mismatch();
    if (fetched.error || typeof fetched.html !== 'string') throw new AssistantBrowserError('failed', 'direct-read-failed', 'Tråden kunde inte hämtas direkt. Öppna den med browser_open och läs den i webbvyn.');
    const thread = assistantParseGmailPrint(fetched.html);
    // The page's globals name the active account; this names the one that answered.
    // A response without that header is a changed page, not another account.
    if (!thread.account) throw new AssistantBrowserError('failed', 'direct-read-failed', 'Tråden kunde inte hämtas direkt. Öppna den med browser_open och läs den i webbvyn.');
    if (thread.account !== email) throw mismatch();
    const fullText = assistantThreadText(thread), text = fullText.slice(0, 60000), truncated = fetched.truncated === true || fullText.length > text.length;
    const messageIds = thread.messages.map(message => `content:${createHash('sha256').update(`${threadId}\n${message.sender || ''}\n${normalize(message.body)}`).digest('hex')}`);
    // The print view has no message IDs. Only the list row names the newest one.
    if (seen.last && messageIds.length) messageIds[messageIds.length - 1] = seen.last;
    const messageId = messageIds.at(-1), areas = [...seen.areas], latestSender = thread.messages.at(-1)?.sender;
    const area = seen.areas.has('sent') && !seen.areas.has('inbox') ? 'sent' : 'inbox';
    const url = assistantUrl(account, `https://mail.google.com${new URL(owned.url).pathname}#${area}/${native}`);
    // The print view includes unsent drafts and cannot tell one from a sent reply, and the list
    // read may predate the draft. Where the account would be the latest sender, the row is read
    // again after the fetch; without a fresh row that shows no draft, the web view decides.
    const draft = seen.draft || latestSender === email && !await this.gmailRowWithoutDraft(seen.tabId, owned.url, threadId);
    const historyComplete = thread.complete && !draft;
    const { observationId, observationSeq } = this.recordObservation({ accountId: account.id, email: account.email, url, sourceId: threadId, messageId, areas, view: 'detail', text,
      historyComplete, truncated, messageIds, latestSender, chronological: true, tabId: seen.tabId });
    return { tabId: seen.tabId, accountId: account.id, accountEmail: account.email, url, sourceId: threadId, messageId, observationId, observationSeq, text, areas, view: 'detail', truncated,
      historyComplete, messageIds, latestSender, chronological: true, attachmentReviewAvailable: false, attachmentReviewCandidate: false, status: 'ready',
      warning: historyComplete && !truncated ? 'Bara text får citeras. Kopiera sourceId, messageId och url till utfallet.'
        : 'Hela tråden kunde inte läsas här, till exempel vid ett osparat utkast eller när ett meddelande bara består av en bilaga. Öppna url med browser_open och läs tråden i webbvyn.' };
  }
  /** Whether the list tab shows the thread's row now, without a draft. Any doubt answers no. */
  private async gmailRowWithoutDraft(tabId: number, url: string, threadId: string): Promise<boolean> {
    try {
      const metadata = await this.script<{ rows?: unknown[] }>(tabId, messageMetadataScript, ['gmail', assistantThreadId('gmail', url) || '']);
      const row = (metadata.rows ?? []).find(entry => assistantInboxRow('gmail', entry)?.key === threadId) as { draft?: unknown } | undefined;
      // Read like the list read reads it: only a row the page reports as a draft has one.
      return !!row && row.draft !== true;
    } catch {
      // A changed or closed page proves nothing about a draft; the result asks for the web view.
      return false;
    }
  }
  private async waitForFolder(tabId: number, account: AssistantAccount, url: string): Promise<void> {
    let deadline = Date.now() + 10_000;
    for (;;) {
      const snapshot = await this.script<ReturnType<typeof assistantZohoFoldersScript>>(tabId, assistantZohoFoldersScript, [], 'isolated');
      if (snapshot.listReady) return;
      if (snapshot.state === 'unknown-layout') throw new AssistantBrowserError('unsupported', 'folder-layout', 'Zoho är öppet men Tabai känner inte igen mappvyn. Öppna den vanliga mejlvyn; omladdning räknas inte som en lyckad kontroll.');
      if (Date.now() >= deadline) {
        if (this.foregroundAttempts.has(tabId)) throw new AssistantBrowserError('failed', 'folder-loading', 'Zohos mappbyte är inte färdigt. Visa arbetsfliken och vänta tills rätt mapp visas. Redan sparade bedömningar finns kvar.');
        this.foregroundAttempts.add(tabId);
        try { await this.call('tab_switch', { tabId, bringToFront: true }); }
        catch (error) {
          if (/FOCUS_DISABLED/i.test(error instanceof Error ? error.message : String(error))) throw new AssistantBrowserError('failed', 'foreground-required', 'Zoho behöver visas i Chrome för att slutföra mappbytet. Öppna den blockerade arbetsfliken och fortsätt när rätt mapp visas.');
          throw error;
        }
        await this.sameOwnedPage(tabId, account, url);
        deadline = Date.now() + 10_000;
      }
      await delay(200);
      await this.sameOwnedPage(tabId, account, url);
    }
  }
  private async readMailFolders(account: AssistantAccount, tabId: number, url: string, view: AssistantView, rows?: unknown[]): Promise<AssistantMailFolder | undefined> {
    const snapshot = await this.script<ReturnType<typeof assistantZohoFoldersScript>>(tabId, assistantZohoFoldersScript, [], 'isolated');
    const after = await this.owned(tabId);
    if (after.url !== url) throw new AssistantBrowserError('failed', 'navigation-changed', 'Mappvyn ändrades under läsningen. Läs den igen.');
    if ((view === 'list' || view === 'empty') && /^#mail\/folder\//.test(new URL(url).hash) && !snapshot.listReady) {
      throw new AssistantBrowserError('failed', 'folder-loading', 'Zohos mapplista ändrades under läsningen. Läs den igen; den har inte räknats som kontrollerad.');
    }
    const known = this.mailFolders.get(account.id) ?? new Map<string, AssistantMailFolder>();
    for (const folder of snapshot.folders) if (folder.kind !== 'sent') {
      known.set(folder.id, { ...folder, listRead: known.get(folder.id)?.listRead === true });
    }
    this.mailFolders.set(account.id, known);
    const current = snapshot.currentId ? known.get(snapshot.currentId) : undefined;
    if (current && snapshot.listReady && (view === 'empty' || view === 'list' && rows?.some(row => assistantInboxRow(account.provider, row)))) current.listRead = true;
    return snapshot.listReady && (view === 'list' || view === 'empty') ? current : undefined;
  }
  pendingMailFolders(accountId: string): AssistantMailFolder[] {
    return [...(this.mailFolders.get(accountId)?.values() ?? [])].filter(folder => !folder.listRead);
  }
  /** Fresh method-validation inventory; accumulated listRead flags are not evidence here. */
  async methodFolders(account: AssistantAccount): Promise<{ id: string; url: string }[]> {
    if (account.provider !== 'zoho') return [];
    const tabId = [...this.tabs].find(([, entry]) => entry.id === account.id)?.[0];
    if (!tabId) throw new AssistantBrowserError('failed', 'unowned-tab', 'Öppna kontot före metodtestet.');
    const before = await this.owned(tabId);
    const snapshot = await this.script<ReturnType<typeof assistantZohoFoldersScript>>(tabId, assistantZohoFoldersScript, [], 'isolated');
    const after = await this.owned(tabId);
    if (before.url !== after.url || !snapshot.listReady || !snapshot.currentId) throw new AssistantBrowserError('failed', 'folder-loading', 'Den aktuella mappvyn kan inte verifieras för metodtestet.');
    return snapshot.folders.filter(folder => folder.kind !== 'sent').map(folder => ({ id: folder.id, url: folder.url }));
  }
  async verifyMethodFolder(account: AssistantAccount, folderId: string): Promise<void> {
    const tabId = [...this.tabs].find(([, entry]) => entry.id === account.id)?.[0];
    if (!tabId) throw new AssistantBrowserError('failed', 'unowned-tab', 'Metodens arbetsflik saknas.');
    const before = await this.owned(tabId);
    const snapshot = await this.script<ReturnType<typeof assistantZohoFoldersScript>>(tabId, assistantZohoFoldersScript, [], 'isolated');
    const after = await this.owned(tabId);
    if (before.url !== after.url || !snapshot.listReady || snapshot.currentId !== folderId) throw new AssistantBrowserError('failed', 'folder-loading', 'Metodtestet nådde inte rätt inkommande mapp.');
  }
  /** Records the inbox rows of a read; returns how many rows it showed. */
  private seeRows(account: AssistantAccount, tabId: number, raw: unknown[], view: AssistantView, folderUrl?: string, inventory = true): number {
    const rows = raw.slice(0, 100).flatMap(entry => assistantInboxRow(account.provider, entry) ?? []);
    const seen = this.inboxRows.get(account.id) ?? new Map<string, AssistantSeenRow>(), refs = new Map<string, string>();
    rows.forEach((row, order) => {
      // Identical list text in two split inboxes is not proof of the same mail.
      if (folderUrl && row.key.startsWith('row:')) row.key = `row:${createHash('sha256').update(folderUrl + '\n' + row.key).digest('hex')}`;
      const earlier = seen.get(row.key);
      seen.delete(row.key);
      seen.set(row.key, { ...row, firstUnread: earlier && earlier.version === row.version ? earlier.firstUnread : row.unread, tabId, order, ...(folderUrl ? { folderUrl } : {}) });
      if (row.ref) refs.set(row.ref, row.key);
    });
    while (seen.size > 500) seen.delete(seen.keys().next().value!);
    this.inboxRows.set(account.id, seen);
    this.rowRefs.set(tabId, refs);
    const listed = this.inboxListed.get(account.id);
    if (inventory) {
      if (rows.length) this.inboxListed.set(account.id, "rows");
      else if (view === "empty" && listed !== "rows") this.inboxListed.set(account.id, "empty");
      else if (view === "list" && !listed) this.inboxListed.set(account.id, "unparsed");
    }
    return rows.length;
  }
  /** The row's ref when it is still a ref of its tab's latest read. */
  currentRowRef(row: AssistantSeenRow): string | undefined {
    return row.ref && this.rowRefs.get(row.tabId)?.get(row.ref) === row.key ? row.ref : undefined;
  }
  async action(name: string, args: { tabId: number; ref?: string; query?: string; value?: string; direction?: string }): Promise<unknown> {
    if (name === "browser_read") return this.read(args.tabId);
    if (name === "browser_expand_thread") return this.expandThread(args.tabId);
    const { account, url } = await this.owned(args.tabId);
    this.lastTabId = args.tabId;
    const approval = this.approval && await this.approvalAt(args.tabId, url);
    if (approval && url !== approval.sourceUrl) throw new Error("Fliken visar inte den godkända tråden.");
    if (name === "browser_find") return this.call("find", { tabId: args.tabId, query: args.query });
    if (name === "browser_scroll") return this.call("computer", { tabId: args.tabId, action: "scroll", scroll_direction: args.direction, scroll_amount: 4 });
    if (!args.ref || !/^ref_\d+$/.test(args.ref)) throw new Error("En aktuell sidreferens krävs.");
    const element = await this.script<AssistantElement | null>(args.tabId, elementScript, [args.ref, account.provider]);
    const operation = name === "browser_search" ? "search" : name === "browser_fill" ? "fill" : "click";
    guardAssistantElement(operation, element, account, url, approval);
    const target = await this.call("resolve_target", { tabId: args.tabId, target: { selector: `[data-ccmcp-ref="${args.ref}"]`, frameId: 0 } });
    const bound = { tabId: args.tabId, ref: target.ref, documentId: target.documentId };
    if (name === "browser_fill") {
      if (!this.approval || args.value !== this.approval.body) throw new Error("Texten måste vara exakt den godkända versionen.");
      return this.call("form_input", { ...bound, value: args.value });
    }
    if (name === "browser_click") {
      // A click on a native inbox row binds that row to the thread the next read shows.
      const rowKey = element?.row ? this.rowRefs.get(args.tabId)?.get(args.ref) : undefined;
      if (rowKey) this.rowClicks.set(args.tabId, { accountId: account.id, key: rowKey, before: this.shownThreads.get(args.tabId) ?? "" }); else this.rowClicks.delete(args.tabId);
      const result = await this.call('computer', { ...bound, action: 'left_click' });
      if (account.provider === 'zoho' && element?.row) {
        // A row click mounts a preview while the old list stays visible. Wait
        // for the native detail; never dispatch the click again on uncertainty.
        const ready = function () {
          const route = location.hash.split('/'), last = route.at(-1) || '';
          return route.at(-2) === 'p' && /^\d{4,}$/.test(last) && [...document.querySelectorAll('.zmPVMail .zmMailContent [role="document"].jsConTent,.zmMailMsgBody')].some(e => {
            const rect = e.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !!e.textContent?.trim();
          });
        };
        await this.call('wait_for', { tabId: args.tabId, predicate: `location.origin===${JSON.stringify(new URL(url).origin)}&&(${ready.toString()})()`, timeoutMs: 15000 });
      }
      if (account.provider === 'zoho' && element?.readingControl && element.readingContainerId) {
        const ready = function (id: string) { return [...(document.getElementById(id)?.querySelectorAll('.zmMailContent [role="document"].jsConTent,.zmMailMsgBody') || [])].some(e => !!e.textContent?.trim()); };
        await this.call('wait_for', { tabId: args.tabId, predicate: `location.origin===${JSON.stringify(new URL(url).origin)}&&(${ready.toString()})(${JSON.stringify(element.readingContainerId)})`, timeoutMs: 15000 });
      }
      return result;
    }
    if (name === "browser_search") {
      this.rowClicks.delete(args.tabId);
      await this.call("form_input", { ...bound, value: args.query });
      await this.call("computer", { ...bound, action: "left_click" });
      await this.sameOwnedPage(args.tabId, account, url);
      const focused = await this.script<boolean>(args.tabId, function (ref: string) { return document.activeElement === document.querySelector(`[data-ccmcp-ref="${ref}"]`); }, [args.ref]);
      if (!focused) throw new Error("Sökfältet tappade fokus. Läs sidan igen; Enter skickades inte.");
      return this.call("computer", { tabId: args.tabId, action: "key", text: "Enter" });
    }
    throw new Error("Webbläsaråtgärden stöds inte.");
  }
  private async expandThread(tabId: number): Promise<unknown> {
    if (this.approval) throw new Error("Äldre meddelanden ska läsas innan ett svar godkänns. Sändningsläget ändrar inte konversationens vy.");
    const attempted = new Set<string>();
    for (let attempt = 0; attempt < 30; attempt++) {
      const reading = await this.read(tabId);
      if (reading.attachmentReviewAvailable) return reading;
      if (reading.attachmentReviewCandidate) { await delay(550); continue; }
      if (reading.historyComplete === true && !reading.truncated) return reading;
      const { account } = await this.owned(tabId);
      const candidate = await this.script<{ ref?: string; selector?: string; rootId?: string } | undefined>(tabId, function (provider: string) {
        const bodies = '.a3s,.ii,[role="document"],.zmMailMsgBody,[data-testid="message-body"],[contenteditable="true"]';
        if (provider === 'zoho') {
          for (const mail of document.querySelectorAll<HTMLElement>('.zmPVMail[role="listitem"][id]')) {
            if ([...mail.querySelectorAll('.zmMailContent [role="document"].jsConTent,.zmMailMsgBody')].some(body => !!body.textContent?.trim())) continue;
            const element = mail.querySelector<HTMLElement>(':scope > .zmMailHeader.zmTMailList');
            if (!element || element.closest(bodies)) continue;
            element.scrollIntoView({ block: 'center' });
            const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
            return { ref: element.getAttribute('data-ccmcp-ref') || undefined, selector: '#' + CSS.escape(mail.id) + ' > .zmMailHeader.zmTMailList', rootId: mail.id };
          }
          return undefined;
        }
        const header = provider === 'gmail' ? '.adn .gH,.adn .aju,.adn .ady' : provider === 'outlook' ? '[data-app-section="MailReadCompose"] [role="heading"],[role="main"].Mq3cC [role="heading"]' : '.zmMailHdr,.zmMailHeader,.zmConversationHeader';
        for (const element of document.querySelectorAll<HTMLElement>('[aria-expanded="false"][role="button"],button[aria-expanded="false"]')) {
          const rect = element.getBoundingClientRect();
          if (rect.width && rect.height && !element.closest(bodies) && !element.closest('a') && element.closest(header)) return { ref: element.getAttribute('data-ccmcp-ref') || undefined };
        }
      }, [account.provider]);
      let ref = candidate?.ref;
      if (!ref && candidate?.selector) ref = (await this.call('resolve_target', { tabId, target: { selector: candidate.selector, frameId: 0 } })).ref;
      if (!ref) return { ...reading, help: "Äldre meddelanden eller fullständig historik kunde inte öppnas säkert. Visa arbetsfliken och öppna konversationen manuellt; fortsätt sedan kontrollen." };
      const key = candidate?.rootId || ref;
      if (attempted.has(key)) return { ...reading, help: 'Den tidigare läsåtgärden gav inte komplett historik. Visa arbetsfliken och kontrollera meddelandet manuellt.' };
      attempted.add(key);
      await this.action("browser_click", { tabId, ref });
    }
    return { ...await this.read(tabId), help: "Fler äldre meddelanden återstår. Öppna dem i arbetsfliken och fortsätt kontrollen." };
  }
  /** The approval as it applies at this tab's address. It changes only when the page itself names the approved thread there. */
  private async approvalAt(tabId: number, url: string): Promise<AssistantSendApproval> {
    const approval = this.approval!;
    if (url === approval.sourceUrl || !directGmailThread(approval)) return approval;
    // script() runs a page function only where approvalPin holds, so an answer is the proof.
    const here = await this.script<string>(tabId, function () { return location.href; }).catch(() => undefined);
    return here === url ? { ...approval, sourceUrl: url } : approval;
  }
  /** Gmail rewrites a thread's address just after loading, and a read during that change would only fail. */
  private async settleApprovedAddress(tabId: number): Promise<void> {
    const thread = this.approval && directGmailThread(this.approval);
    if (!thread) return;
    let stable = '';
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await delay(250)) {
      const { url } = await this.owned(tabId, false);
      const named = await this.script<string | null>(tabId, assistantGmailOpenThreadScript).catch(() => null);
      if (named === thread && url === stable) return;
      stable = named === thread ? url : '';
    }
  }
  /** The approved message is still the newest in the approved thread. Any doubt stops the send. */
  private approvedStillLatest(account: AssistantAccount, fresh: { sourceId?: unknown; messageId?: unknown }, url: string): boolean {
    const approval = this.approval!, message = this.approvedMessageId;
    if (!message) return false;
    // A Gmail card from before the web view read the heading is named by its address.
    return (fresh.sourceId === approval.threadId || account.provider === 'gmail' && assistantThreadId('gmail', url) === approval.threadId) && fresh.messageId === message;
  }
  async send(tabId: number, sendIntent: () => Promise<void>, sent: (receipt: string) => Promise<void>): Promise<void> {
    if (!this.approval) throw new Error("Sändning kräver ett uttryckligt godkännande.");
    if (this.dispatchStarted) throw new Error("Sändningsförsöket har redan påbörjats. Kontrollera Skickat manuellt; försök inte igen.");
    const { account, url } = await this.owned(tabId);
    const approval = await this.approvalAt(tabId, url);
    if (account.id !== approval.account.id || url !== approval.sourceUrl) throw new Error("Godkännandet gäller ett annat konto eller en annan tråd.");
    const fresh = await this.read(tabId);
    if (!this.approvedStillLatest(account, fresh, url)
      || !String(fresh.text).toLowerCase().includes(approval.recipient.toLowerCase())) throw new Error("Den ursprungliga tråden, senaste meddelandet och mottagaradressen måste kunna bekräftas på nytt före sändning. Kör kontrollen igen om tråden ändrats och godkänn ett nytt svar.");
    await this.call("read_page", { tabId, filter: "interactive", frameId: 0, maxResults: 500, maxChars: 40000 });
    const actual = verifyAssistantComposer(await this.script<AssistantComposer | null>(tabId, composerScript), approval);
    const target = await this.call("resolve_target", { tabId, target: { selector: `[data-ccmcp-ref="${actual.sendRef}"]`, frameId: 0 } });
    if ((await this.script<string>(tabId, sentFeedbackScript)).trim()) throw new Error("Ett tidigare skickat-kvitto syns redan. Kontrollera Skickat manuellt.");
    // Consume authorization before awaiting persistence. Any subsequent failure is uncertain.
    this.dispatchStarted = true;
    await sendIntent();
    await this.owned(tabId);
    const again = verifyAssistantComposer(await this.script<AssistantComposer | null>(tabId, composerScript), approval);
    if (JSON.stringify(actual) !== JSON.stringify(again)) throw new Error("Svaret ändrades efter kontrollen. Kontrollera utfallet manuellt.");
    await this.call("computer", { tabId, ref: target.ref, documentId: target.documentId, action: "left_click" });
    for (let i = 0; i < 12; i++) {
      await delay(750);
      await this.owned(tabId);
      const receipt = await this.script<string>(tabId, sentFeedbackScript);
      if (receipt) { await sent(`${approval.sender ?? account.email}: ${receipt}`); return; }
    }
    throw new Error("Sändningen saknar entydigt kvitto. Kontrollera Skickat manuellt. Assistenten försöker inte igen.");
  }
  async close(): Promise<void> {
    this.closed = true;
    try {
      if (this.connecting) {
        // Interrupt an unfinished handshake rather than waiting for its timeout.
        try { await this.transport?.close(); } catch { /* Still settle the in-flight connect below. */ }
        await this.connecting.catch(() => {});
      }
      const client = this.client, transport = this.transport; this.client = undefined; this.transport = undefined;
      try { await client?.close(); } finally { await transport?.close(); }
    } finally {
      this.tabs.clear(); this.warmedTabs.clear(); this.foregroundAttempts.clear(); this.observations.clear(); this.coverageAreas.clear(); this.readingProofs.clear();
      this.inboxRows.clear(); this.inboxListed.clear(); this.rowThreads.clear(); this.rowRefs.clear(); this.rowClicks.clear(); this.shownThreads.clear();
    }
  }
}
