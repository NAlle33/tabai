import { assistantInboxStatus, type AssistantItem } from '../../shared/assistant';

/** A mail's status word and the key its chip is styled by. */
export type AssistantMailStatus = { key: string; label: string };
/**
 * What one mail asks of the user, which decides its sentence and its one main button. "self" is
 * a reply Tabai has no proposal for; "rewriting" is a question the user answered while Tabai
 * writes a new proposal.
 */
export type AssistantMailCard = Exclude<AssistantItem['status'], 'open'> | 'question' | 'rewriting' | 'reply' | 'self' | 'info' | 'needs-you';
/** The status words, the same on a row, on its card and on a mail linked to a case. */
export const assistantInboxLabels = { reply: 'Svar att skicka', question: 'Fråga till dig', 'needs-you': 'Behöver dig', info: 'För kännedom' };
/** Mail the host can send an approved reply for; the same kinds its send action accepts. */
export const assistantReplyKind = (item: Pick<AssistantItem, 'kind'>) => item.kind === 'reply' || item.kind === 'followup';
/**
 * A mail loaded in Mejl, or a case's saved reference to one, which keeps only its status and
 * kind. A reference without a priority is not a prioritized sender's.
 */
type MailFields = Pick<AssistantItem, 'status' | 'kind'> & Partial<Pick<AssistantItem, 'question' | 'answer' | 'draft' | 'priority' | 'feedback' | 'snoozedUntil' | 'pendingFinding'>>;
const inboxStatus = (item: MailFields) => assistantInboxStatus({ ...item, priority: item.priority ?? 3 });

function inZone<T>(timeZone: string, format: (zone?: string) => T): T { try { return format(timeZone); } catch { return format(undefined); } }
/** The calendar day of a moment in the user's time zone, as YYYY-MM-DD. */
export function assistantLocalDay(moment: Date, timeZone: string) { return inZone(timeZone, zone => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment)); }
/** "i dag 08:12", "i går 17:40", "i morgon 08:00" or "mån 9 nov. 08:00" in the user's time zone. */
export function assistantWhen(value: string, timeZone: string) {
  const date = new Date(value);
  const day = (moment: Date) => Date.parse(`${assistantLocalDay(moment, timeZone)}T00:00:00Z`);
  const clock = inZone(timeZone, zone => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(date));
  const offset = Math.round((day(date) - day(new Date())) / 86_400_000);
  if (offset === 0) return `i dag ${clock}`;
  if (offset === -1) return `i går ${clock}`;
  if (offset === 1) return `i morgon ${clock}`;
  return `${inZone(timeZone, zone => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(date))} ${clock}`;
}

/** The card a mail gets; the list's status word and the card's sentence follow it. */
export function assistantMailCard(item: MailFields): AssistantMailCard {
  if (item.status !== 'open') return item.status;
  if (item.question) return item.answer ? 'rewriting' : 'question';
  const status = inboxStatus(item);
  if (status !== 'needs-you') return status;
  return assistantReplyKind(item) && item.draft === undefined ? 'self' : 'needs-you';
}
/** The status word of a mail, as Mejl's list and a case's linked mail both show it. */
export function assistantMailStatus(item: MailFields, timeZone: string): AssistantMailStatus {
  const card = assistantMailCard(item);
  // A later message waiting on the uncertain send is named on the row too, not only inside the card.
  if (card === 'uncertain') return { key: 'uncertain', label: item.pendingFinding ? 'Kolla om det skickades · nytt meddelande' : 'Kolla om det skickades' };
  if (card === 'sending') return { key: 'sending', label: 'Skickas…' };
  if (card === 'sent') return { key: 'sent', label: 'Svar skickat' };
  if (card === 'resolved') return { key: 'resolved', label: 'Redan besvarat' };
  if (card === 'dismissed') return { key: 'dismissed', label: item.feedback === 'no-reply' ? 'Inget svar behövs' : 'Klar' };
  if (card === 'snoozed') return { key: 'snoozed', label: item.snoozedUntil ? `Påminner ${assistantWhen(item.snoozedUntil, timeZone)}` : 'Påminner senare' };
  if (card === 'question') return { key: 'question', label: assistantInboxLabels.question };
  if (card === 'rewriting') return { key: 'rewriting', label: 'Nytt förslag på väg' };
  const status = inboxStatus(item);
  return { key: status, label: assistantInboxLabels[status] };
}
