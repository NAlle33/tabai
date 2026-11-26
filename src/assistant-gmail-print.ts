/**
 * Gmail's print view is the one native page that holds every message of a thread,
 * in order, without rendering or expansion. The page's Trusted Types policy rejects
 * DOMParser in both worlds, so the host parses the fetched text.
 *
 * Only the markup Gmail writes around messages decides boundaries, senders and
 * completeness. Body markup is written by the sender: a forged message block adds
 * to the parsed count, which then differs from Gmail's own declared count, so the
 * thread stays incomplete instead of gaining a forged latest sender. Boundaries are
 * found on the unmodified page, because removing markup first would let a body
 * erase a real boundary.
 */
export interface AssistantGmailPrintMessage { sender?: string; from: string; date: string; recipients: string; body: string; hasBody: boolean }
export interface AssistantGmailPrintThread { account?: string; subject: string; declared?: number; messages: AssistantGmailPrintMessage[]; complete: boolean }

// Gmail's structural attributes cannot span another opening tag. Stopping at
// '<' also avoids rescanning 2,000 characters at every malformed '<table'.
const ATTRS = '[^<>]{0,2000}';
const MESSAGE_BLOCK = new RegExp(`<table\\b${ATTRS}\\bclass=(?:"message"|'message'|message)(?=[\\s>])${ATTRS}>`, 'gi');
const ACCOUNT = new RegExp(`<td\\b${ATTRS}\\balign=(?:"right"|right)${ATTRS}>\\s*<font\\b${ATTRS}>\\s*<b>([\\s\\S]*?)</b>`, 'i');
const SUBJECT = new RegExp(`<font\\b${ATTRS}\\bsize=(?:"\\+1"|\\+1)${ATTRS}>\\s*<b>([\\s\\S]*?)</b>`, 'i');
const DECLARED = new RegExp(`<font\\b${ATTRS}\\bsize=(?:"-1"|-1)${ATTRS}>\\s*(\\d+)\\s[^<]{0,200}</font>\\s*</td>\\s*</tr>\\s*</table>\\s*<hr`, 'i');
const HEADER = new RegExp(`^\\s*<tr\\b${ATTRS}>\\s*<td\\b${ATTRS}>\\s*<font\\b${ATTRS}>([\\s\\S]*?)</font>\\s*</td>\\s*<td\\b${ATTRS}\\balign=(?:"right"|right)${ATTRS}>\\s*<font\\b${ATTRS}>([\\s\\S]*?)</font>`, 'i');
const RECIPIENTS = new RegExp(`<font\\b${ATTRS}\\bclass=(?:"recipient"|recipient)${ATTRS}>([\\s\\S]*?)</font>`, 'i');
const BODY = new RegExp(`<tr\\b${ATTRS}>\\s*<td\\b${ATTRS}\\bcolspan=(?:"2"|2)${ATTRS}>\\s*<table\\b${ATTRS}>\\s*<tr\\b${ATTRS}>\\s*<td\\b${ATTRS}>`, 'i');
const ATTACHMENTS = new RegExp(`<table\\b${ATTRS}\\bclass=(?:"att"|'att'|att)(?=[\\s>])${ATTRS}>`, 'gi');
const NAMED = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aring: 'å', auml: 'ä', ouml: 'ö', Aring: 'Å', Auml: 'Ä', Ouml: 'Ö', eacute: 'é', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' }));
const BLOCK_END = new Set(['p', 'div', 'tr', 'table', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);
const RAW_TEXT = new Set(['style', 'script', 'title']);
const TAG_LIMIT = 8192;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (entity, name: string) => {
    if (name[0] !== '#') return NAMED.get(name) ?? entity;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}
/**
 * One pass over the markup. A quoted attribute cannot end a tag, so a tag inside an
 * attribute cannot start a hidden region. Whatever is left unterminated stays in the
 * text: evidence may show stray markup, but never loses what follows it.
 */
export function assistantHtmlText(html: string): string {
  const parts: string[] = [], absent = new Set<string>();
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) { parts.push(html.slice(at)); break; }
    parts.push(html.slice(at, open));
    if (html.startsWith('<!--', open)) {
      // The endings a browser accepts: an empty comment, and the bang form.
      const empty = /^<!---?>/.exec(html.slice(open, open + 6));
      if (empty) { at = open + empty[0].length; continue; }
      const close = /--!?>/g;
      close.lastIndex = open + 4;
      const end = absent.has('comment') ? null : close.exec(html);
      if (!end) absent.add('comment');
      at = end ? close.lastIndex : open + 4;
      continue;
    }
    const name = /^<(\/?)([a-z][a-z0-9:-]*)/i.exec(html.slice(open, open + 64));
    if (!name && !/^<[!?]/.test(html.slice(open, open + 2))) { parts.push('<'); at = open + 1; continue; }
    let cursor = open + (name?.[0].length ?? 2), quote = '', closed = false, previous = '';
    const limit = Math.min(html.length, open + TAG_LIMIT);
    for (; cursor < limit; cursor++) {
      const char = html[cursor];
      if (quote) { if (char === quote) quote = ''; }
      else if ((char === '"' || char === "'") && previous === '=') quote = char;
      else if (char === '>') { closed = true; cursor++; break; }
      if (char.trim()) previous = char;
    }
    // Everything scanned is consumed either way, so hostile input stays linear.
    if (!closed) { parts.push(html.slice(open, cursor)); at = cursor; continue; }
    at = cursor;
    if (!name) continue;
    const tag = name[2].toLowerCase(), closing = name[1] === '/';
    if (!closing && RAW_TEXT.has(tag) && !absent.has(tag)) {
      const close = new RegExp(`</${tag}\\b[^>]{0,200}>`, 'gi');
      close.lastIndex = at;
      if (close.exec(html)) at = close.lastIndex; else absent.add(tag);
      continue;
    }
    if (tag === 'br' || tag === 'hr' || closing && BLOCK_END.has(tag)) parts.push('\n');
    else if (closing && tag === 'td') parts.push(' ');
  }
  return decodeEntities(parts.join('')).replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** A display name can contain an address, so only the final bracketed one is the sender. */
function addressOf(text: string): string | undefined {
  const bracketed = [...text.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].at(-1)?.[1];
  const value = bracketed ?? (/^[^\s<>]+@[^\s<>]+$/.test(text.trim()) ? text.trim() : undefined);
  return value?.toLowerCase();
}
function parseMessage(block: string): AssistantGmailPrintMessage | undefined {
  const header = HEADER.exec(block);
  if (!header) return undefined;
  const rest = block.slice(header[0].length), bodyStart = BODY.exec(rest);
  if (!bodyStart) return undefined;
  const from = assistantHtmlText(header[1]), meta = rest.slice(0, bodyStart.index), recipients = RECIPIENTS.exec(meta)?.[1];
  const content = rest.slice(bodyStart.index + bodyStart[0].length);
  // Gmail writes the attachment list last. It only decides whether the message has
  // readable text; all text stays in the evidence, whatever a table is named.
  const attachments = [...content.matchAll(ATTACHMENTS)].at(-1);
  const body = assistantHtmlText(content);
  return { sender: addressOf(from), from, date: assistantHtmlText(header[2]), recipients: recipients ? assistantHtmlText(recipients) : '', body,
    hasBody: !!(attachments?.index === undefined ? body : assistantHtmlText(content.slice(0, attachments.index))) };
}
export function assistantParseGmailPrint(html: string): AssistantGmailPrintThread {
  const marks = [...html.matchAll(MESSAGE_BLOCK)];
  const head = html.slice(0, marks[0]?.index ?? html.length);
  const main = head.search(/\bclass=(?:"maincontent"|maincontent)/i);
  const account = ACCOUNT.exec(main < 0 ? head : head.slice(0, main))?.[1];
  const subject = SUBJECT.exec(head)?.[1], declared = DECLARED.exec(head)?.[1];
  const parsed = marks.map((mark, index) => parseMessage(html.slice(mark.index! + mark[0].length, marks[index + 1]?.index ?? html.length)));
  const messages = parsed.filter((message): message is AssistantGmailPrintMessage => !!message);
  const count = declared === undefined ? undefined : Number(declared);
  // Gmail links a clipped message to its full view; a clipped thread is not complete.
  const clipped = /[?&]view=lg\b/.test(html);
  return { ...(account ? { account: addressOf(assistantHtmlText(account)) } : {}), subject: subject ? assistantHtmlText(subject) : '', ...(count === undefined ? {} : { declared: count }), messages,
    complete: !clipped && count !== undefined && count === marks.length && messages.length === marks.length && messages.length > 0 && messages.every(message => !!message.sender && message.hasBody) };
}
/** The evidence text: each message's headers around its body, in thread order. */
export function assistantThreadText(thread: { subject: string; messages: { from: string; date: string; recipients: string; body: string }[] }): string {
  const total = thread.messages.length;
  return [`Ämne: ${thread.subject}`, ...thread.messages.map((message, index) =>
    [`[Meddelande ${index + 1} av ${total}]`, `Från: ${message.from}`, `Datum: ${message.date}`, ...(message.recipients ? [message.recipients] : []), '', message.body].join('\n'))].join('\n\n');
}
