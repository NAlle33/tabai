import { ASSISTANT_PROVIDER_ORIGINS } from './assistant';
import { ASSISTANT_FILE_TEXT } from './assistant-files';

/**
 * "Den här sidan": the pure parts of sharing the user's own page with the chat,
 * used by the panel that reads the page and by the host that stores it.
 */
export interface AssistantSharedPage { title: string; url: string; selection: string; text: string; truncated: boolean }

// Chrome never lets an extension script its own web store, so it is never offered.
const webStore = /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:[/?#]|$)/;
const mailHosts = new Set(Object.values(ASSISTANT_PROVIDER_ORIGINS).flat().map(origin => new URL(origin).hostname));
// Direction marks, embeddings, overrides and isolates, and every control character including line breaks:
// a label never reorders or breaks the text around it.
const unsafeLabel = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** The address without its fragment or credentials, which never leave the tab. */
export function assistantPageAddress(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = ''; url.username = ''; url.password = '';
  return url.href;
}
/** Mail and calendar belong to Mejl, whose reading rules a shared page must never bypass. */
export function assistantPageIsMail(value: string | undefined): boolean {
  if (!value) return false;
  // Every trailing dot is dropped: a host written with more of them is still the mail host.
  try { return mailHosts.has(new URL(value).hostname.toLowerCase().replace(/\.+$/, '')); } catch { return false; }
}
/** "värd/sökväg" for an ordinary http(s) page, or undefined for chrome://, extension pages, file: and PDFs. */
export function assistantShareablePage(value: string | undefined): string | undefined {
  const address = value === undefined ? undefined : assistantPageAddress(value);
  if (!address || webStore.test(address)) return undefined;
  const url = new URL(address);
  if (/\.pdf$/i.test(url.pathname)) return undefined;
  let path = url.pathname === '/' ? '' : url.pathname;
  try { path = decodeURI(path); } catch { /* A malformed escape is shown as it is. */ }
  return `${url.host}${path}`.replace(unsafeLabel, '').slice(0, 200);
}

// The parameters whose values say what the page shows, never who is asking.
const shownParameters = new Set(['q', 'query', 'search', 'page', 'p', 'sort', 'lang', 'tab', 'view', 'filter', 'category', 'id']);
/** A long base64- or hex-like segment: a reset link, a sign-in code or a share key, never a readable slug. */
function opaque(value: string): boolean {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Judged as written. */ }
  if (decoded.length < 24 || !/^[A-Za-z0-9+/=_.~-]+$/.test(decoded)) return false;
  return /^\d+$/.test(decoded) || decoded.split(/[-_.~+=/]/).some(piece => piece.length >= 8 && /\d/.test(piece) && /[A-Za-z]/.test(piece));
}
/**
 * The address as the model reads it: every parameter value except the few that
 * describe the view, and every long opaque path segment, is "dolt". Applying it
 * again changes nothing, so the host can enforce it on what the panel sends.
 */
export function assistantPageAddressForModel(address: string): string {
  const url = new URL(address);
  url.hash = ''; url.username = ''; url.password = '';
  url.pathname = url.pathname.split('/').map(segment => opaque(segment) ? 'dolt' : segment).join('/');
  const kept = [...url.searchParams].map(([name, value]) => [opaque(name) ? 'dolt' : name, shownParameters.has(name.toLowerCase()) || !value ? value : 'dolt']);
  url.search = kept.length ? new URLSearchParams(kept).toString() : '';
  return url.href;
}

function localDate(now: Date, timezone: string) {
  const parts = (zone?: string) => Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  let value: Record<string, string>;
  try { value = parts(timezone); } catch { value = parts(); }
  return { day: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}.${value.minute}` };
}
const truncation = '\n\n[Texten är kapad vid 500 000 tecken. Resten av sidan kom inte med.]';
const words = (value: string) => value.replace(/\s+/g, ' ');
/**
 * The shared page as a text file for the chat's own file flow: title and address
 * first. A selection that the page text contains and that covers nearly all of it
 * (90 % or more) is the page itself, so it is not repeated. Any other selection is
 * kept: text in an editor never joins the page text, so a selection made there is
 * not part of it, however long it is.
 */
export function assistantPageFile(page: AssistantSharedPage, timezone: string, now = new Date()) {
  const address = assistantPageAddress(page.url)!, url = new URL(address), when = localDate(now, timezone), model = assistantPageAddressForModel(address);
  const selection = page.selection.trim(), text = page.text.trim();
  // Line breaks between blocks may fall differently in a selection, so the page text is judged word for word.
  const repeated = !!selection && selection.length >= text.length * 0.9 && words(text).includes(words(selection));
  const parts = [
    ['Delad sida från din egen flik', `Titel: ${page.title.trim() || '(ingen titel)'}`, `Adress: ${model}`, `Delad: ${when.day} kl. ${when.time}`].join('\n'),
    selection && !repeated ? `Markerad text:\n${selection}` : '',
    `Sidans text:\n${text}`,
  ];
  let file = parts.filter(Boolean).join('\n\n');
  const truncated = page.truncated || file.length > ASSISTANT_FILE_TEXT;
  if (truncated) file = file.slice(0, ASSISTANT_FILE_TEXT - truncation.length) + truncation;
  const host = url.host.replace(/[^\p{L}\p{N}.-]+/gu, '-').slice(0, 80);
  return { name: `Sida ${host} ${when.day}.txt`, text: file, label: assistantShareablePage(model)!, address: model, truncated };
}

/**
 * "Fråga Tabai om ”…”" from the context menu: only the text the user selected, as a
 * page file of its own. Its address is the one the model reads; the page's title and
 * the rest of its text stay in the tab.
 */
export function assistantSelectionFile(page: AssistantSharedPage, timezone: string, now = new Date()) {
  const selection = page.selection.trim();
  if (!selection) return undefined;
  const address = assistantPageAddress(page.url)!, url = new URL(address), when = localDate(now, timezone), model = assistantPageAddressForModel(address);
  let file = [['Markerad text från din egen flik', `Adress: ${model}`, `Delad: ${when.day} kl. ${when.time}`].join('\n'), `Markerad text:\n${selection}`].join('\n\n');
  const truncated = page.truncated || file.length > ASSISTANT_FILE_TEXT;
  if (truncated) file = file.slice(0, ASSISTANT_FILE_TEXT - truncation.length) + truncation;
  const host = url.host.replace(/[^\p{L}\p{N}.-]+/gu, '-').slice(0, 80);
  return { name: `Markering ${host} ${when.day}.txt`, text: file, label: assistantSelectionLabel(model), address: model, truncated };
}
/** The chip's name for a shared selection: "Markerad text från värd". */
export const assistantSelectionLabel = (address: string) => `Markerad text från ${new URL(address).host}`.replace(unsafeLabel, '').slice(0, 200);
/**
 * "Fråga Tabai om länken" only fills in a question: an ordinary http(s) link, without
 * its fragment or credentials. Nothing is opened or read until the user sends it.
 */
export function assistantLinkQuestion(value: string | undefined): string | undefined {
  const address = value === undefined ? undefined : assistantPageAddress(value);
  return address ? `Vad finns på ${address}?` : undefined;
}

/** Where the shared text goes when the user sends, in the user's words: only to the chat model, never to a task. */
export function assistantPagePrivacy(model: string | undefined) {
  const backend = model?.split(':')[0];
  if (backend === 'local') return 'Sidans text stannar på datorn. Bara den lokala chattmodellen läser den, och den följer aldrig med till uppdrag. Delningen gäller bara det här samtalet.';
  const to = backend === 'codex' ? 'OpenAI via Codex' : backend === 'claude' ? 'Anthropic via Claude Code' : backend === 'berget' ? 'Berget.ai' : 'den valda chattmodellen';
  return `Sidans text skickas till ${to} när du skickar. Bara chattmodellen läser den, och den följer aldrig med till uppdrag. Delningen gäller bara det här samtalet.`;
}
