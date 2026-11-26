import * as z from 'zod';
import { uuidSchema } from './stable-schemas';

/**
 * What the chat agent may do on the open web. One setting for every model
 * choice: the host exposes the same tools to Codex, Claude, Berget and local
 * inference and enforces the same gates on each call.
 */
export const assistantWebLevelSchema = z.enum(['off', 'read', 'act']);
export type AssistantWebLevel = z.infer<typeof assistantWebLevelSchema>;
/**
 * Mail tasks never act on the web: nobody can approve a card during a mail
 * check. `tasks` lets them search and read: in tasks the user starts, or also
 * in scheduled checks that run unattended. Absent means off.
 */
export const assistantWebTasksSchema = z.enum(['off', 'manual', 'all']);
export type AssistantWebTasks = z.infer<typeof assistantWebTasksSchema>;
export const assistantWebAccessSchema = z.object({ level: assistantWebLevelSchema, login: z.boolean(), tasks: assistantWebTasksSchema.optional(), fullAccess: z.boolean().optional() }).strict();
export type AssistantWebAccess = z.infer<typeof assistantWebAccessSchema>;
export const assistantWebDefaults: AssistantWebAccess = Object.freeze({ level: 'off', login: false }) as AssistantWebAccess;
export const assistantWebAccess = (value?: AssistantWebAccess): AssistantWebAccess => value ? { ...value } : { ...assistantWebDefaults };
export const assistantWebEnabled = (value?: AssistantWebAccess): boolean => value?.fullAccess === true || (value?.level ?? 'off') !== 'off';

/** The web level of one mail task run: read or nothing, never for sending. */
export function assistantTaskWebLevel(web: AssistantWebAccess | undefined, run: { task: string; scheduled?: boolean }): AssistantWebLevel {
  const tasks = web?.tasks ?? 'off';
  if (run.task === 'send' || tasks === 'off' || tasks === 'manual' && run.scheduled) return 'off';
  return 'read';
}

/**
 * The web level of a routine: it runs unattended, so it reads at most and never
 * acts, whatever the conversation setting is; with web access off it has none.
 */
export function assistantRoutineWebLevel(web: AssistantWebAccess | undefined): Exclude<AssistantWebLevel, 'act'> {
  return (web?.level ?? 'off') === 'off' ? 'off' : 'read';
}

export const assistantWebLevelLabels: Record<AssistantWebLevel, string> = {
  off: 'Av',
  read: 'Söka och läsa',
  act: 'Agera med godkännande',
};

/**
 * A final step on a web page (buy, pay, send, book, sign, confirm) that the
 * host stopped before dispatch. Only the host creates it; the chat agent's
 * own proposals cannot carry this kind. It binds the exact tab, page, element
 * and document, the visible button text and amount, and the form's choices.
 */
export const assistantWebApprovalSchema = z.object({
  kind: z.literal('web-action'),
  approvalId: uuidSchema,
  tabId: z.number().int().positive(),
  url: z.string().url().max(2000),
  site: z.string().min(1).max(200),
  page: z.string().max(300),
  action: z.string().min(1).max(200),
  amount: z.string().max(100).optional(),
  fields: z.array(z.object({ label: z.string().max(120), value: z.string().max(500) }).strict()).max(12),
  /** Hash of every choice the submit would send (the card shows the first twelve). */
  state: z.string().regex(/^[0-9a-f]{64}$/),
  ref: z.string().regex(/^ref_\d+$/),
  documentId: z.string().min(1).max(200),
  /**
   * The conversation file with an image of the button and its form, taken when the
   * card was made. Information for the user only: it is never part of what binds the
   * approval, and a card without it simply has no image.
   */
  previewFileId: uuidSchema.optional(),
}).strict();
export type AssistantWebApproval = z.infer<typeof assistantWebApprovalSchema>;

/**
 * Personal mailbox providers: their domain says nothing about an organization,
 * and a lookup would be about a private person.
 */
const PRIVATE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com', 'icloud.com', 'me.com', 'mac.com',
  'ymail.com', 'rocketmail.com', 'aol.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com', 'mail.com', 'email.com',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'zoho.com', 'zohomail.com', 'zohomail.eu', 'fastmail.com', 'fastmail.fm', 'hey.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com',
  'telia.com', 'bredband.net', 'bredband2.com', 'comhem.se', 'tele2.se', 'spray.se', 'passagen.se', 'home.se', 'swipnet.se', 'glocalnet.net', 'bahnhof.se', 'tiscali.se', 'chello.se', 'ownit.se']);
const PRIVATE_MAIL_FAMILIES = /^(?:hotmail|outlook|live|windowslive|yahoo|gmx|yandex|libero|orange|free|laposte|t-online|seznam|wp|o2)\.[a-z.]{2,6}$/;
/**
 * The organization domain behind a sender address, or why it cannot be looked up.
 * Shared so the panel disables the lookup for exactly the addresses the host refuses.
 */
export function assistantSenderDomain(address: string | undefined): { domain: string; refusal?: undefined } | { domain?: undefined; refusal: string } {
  const match = (address ?? '').trim().toLowerCase().match(/^[^@\s]+@([a-z0-9.-]+)$/);
  const domain = match?.[1].replace(/\.$/, '');
  if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return { refusal: 'Ärendet saknar en verifierad avsändaradress att slå upp.' };
  if (PRIVATE_MAIL_DOMAINS.has(domain) || PRIVATE_MAIL_FAMILIES.test(domain)) return { refusal: `${domain} är en e-posttjänst för privatpersoner. Uppslaget gäller organisationer, inte privatpersoner.` };
  return { domain };
}
