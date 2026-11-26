import * as z from "zod";
import { dateTimeSchema, maxUtf16Units } from "./stable-schemas";
import { assistantCaseSchema } from './assistant-cases';
import { assistantAccountTestSchema, assistantAgentSettingsSchema } from './assistant-diagnostics';
import { assistantWebAccessSchema } from './assistant-web';
import { assistantMailMethodViewSchema } from './assistant-mail-methods';

export const ASSISTANT_MAIL_HOSTS = {
  gmail: ["mail.google.com"],
  // Outlook for Microsoft 365 moves to outlook.cloud.microsoft; the older hosts redirect there.
  outlook: ["outlook.live.com", "outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft"],
  zoho: ["com", "eu", "in", "com.au", "jp", "com.cn", "ca", "sa"].map(region => `mail.zoho.${region}`),
};
export const ASSISTANT_PROVIDER_ORIGINS = {
  gmail: ["https://mail.google.com", "https://calendar.google.com"],
  outlook: ASSISTANT_MAIL_HOSTS.outlook.map(host => `https://${host}`),
  zoho: ASSISTANT_MAIL_HOSTS.zoho.flatMap(host => [`https://${host}`, `https://${host.replace(/^mail\./, "calendar.")}`]),
};

export const assistantTaskSchema = z.enum(["check-mail", "follow-ups", "prepare-meeting", "my-day", "custom", "send"]);
export type AssistantTask = z.infer<typeof assistantTaskSchema>;
export const assistantAccountSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/), provider: z.enum(["gmail", "outlook", "zoho"]),
  label: z.string().min(1).max(120), email: z.string().email().max(254),
  url: z.string().url().max(2000), enabled: z.boolean(),
}).strict();
export type AssistantAccount = z.infer<typeof assistantAccountSchema>;
export const assistantPreferencesSchema = z.object({
  shortReplies: z.boolean(),
  senderRules: z.array(z.object({ accountId: z.string().max(60), email: z.string().email().max(254), priority: z.enum(["high", "normal"]) }).strict()).max(100),
}).strict();
export const assistantMorningSchema = z.object({ enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), notifications: z.boolean(), task: z.enum(['check-mail', 'my-day']).optional() }).strict();
export const assistantSettingsSchema = z.object({
  accounts: z.array(assistantAccountSchema).max(12),
  lookbackDays: z.number().int().min(1).max(90), followupDays: z.number().int().min(1).max(90),
  timezone: z.string().min(1).max(100), tone: z.string().max(2000),
  autoAcknowledgements: z.boolean(), acknowledgementRecipients: z.array(z.string().email()).max(30),
  acknowledgementBody: z.string().max(2000),
  preferences: assistantPreferencesSchema.optional(), morning: assistantMorningSchema.optional(),
  agent: assistantAgentSettingsSchema.optional(),
  chatAgent: assistantAgentSettingsSchema.optional(),
  /** The model for watches; absent means the local default, never the chat model. */
  watchAgent: assistantAgentSettingsSchema.optional(),
  web: assistantWebAccessSchema.optional(),
  learnMail: z.boolean().optional(),
  /** Desktop notice when a watch's condition is met; absent means on. Chrome's own permission still applies. */
  watchNotifications: z.boolean().optional(),
  /** Desktop notice when a routine is done; absent means on. Chrome's own permission still applies. */
  routineNotifications: z.boolean().optional(),
}).strict();
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>;
export const assistantSourceSchema = z.object({ observationId: z.string().max(100), quote: z.string().min(1).max(1000) }).strict();
export const assistantFindingSchema = z.object({
  accountId: z.string().max(60), threadId: z.string().min(1).max(500),
  messageId: z.string().min(1).max(500).optional(),
  kind: z.enum(["reply", "action", "information", "followup", "meeting", "decision"]),
  title: z.string().min(1).max(300), summary: z.string().max(4000), reason: z.string().min(1).max(2000),
  priority: z.number().int().min(1).max(3), sourceUrl: z.string().url().max(2000),
  sender: z.string().max(300).optional(), recipient: z.string().email().max(254).optional(),
  deadline: z.string().max(120).optional(), draft: z.string().max(12000).optional(),
  question: z.string().max(2000).optional(), sources: z.array(assistantSourceSchema).min(1).max(6),
  unreadAttachment: z.literal(true).optional(),
  /** The address a reply goes out from. Only the host sets it, from the provider's own list of permitted senders. */
  replyFrom: z.string().email().max(254).optional(),
}).strict();
export type AssistantFinding = z.infer<typeof assistantFindingSchema>;
export const assistantItemSchema = assistantFindingSchema.extend({
  id: z.string().max(100), revision: z.number().int().nonnegative(),
  status: z.enum(["open", "dismissed", "snoozed", "sending", "sent", "uncertain", "resolved"]),
  snoozedUntil: dateTimeSchema.optional(), updatedAt: dateTimeSchema,
  answer: z.string().max(4000).optional(), sendReceipt: z.string().max(2000).optional(),
  draftEdited: z.boolean().optional(),
  feedback: z.enum(["no-reply"]).optional(),
  resolution: z.object({ reason: z.string().max(2000), messageId: z.string().max(500), sourceUrl: z.string().url().max(2000), sources: z.array(assistantSourceSchema).min(1).max(6), resolvedAt: dateTimeSchema }).strict().optional(),
  /**
   * A reply the check found for mail that was already opened when the inbox list showed it, and
   * that Tabai had not reviewed in that state before. Absent when the list does not show it.
   */
  opened: z.boolean().optional(),
  /**
   * Set once a reply in this item's thread has been on its way out. The mark is for the thread:
   * every later item of it keeps the mark, also after the user said that an uncertain send did not
   * go out, and only the user's own approval sends another reply in that thread.
   */
  sendLocked: z.literal(true).optional(),
  /**
   * A later message in the thread, found while the send was locked. It becomes the item once the
   * user has said whether the send went out.
   */
  pendingFinding: assistantFindingSchema.optional(),
  /**
   * The revision at which an automatic acknowledgement was tried for this message. It is not tried
   * again; a later message in the thread starts without it.
   */
  autoAttempt: z.number().int().nonnegative().optional(),
});
export type AssistantItem = z.infer<typeof assistantItemSchema>;
/** Mejl's Att göra list: everything still open, and sends whose outcome the user must see. */
export const assistantInboxActive = (item: Pick<AssistantItem, 'status'>) => item.status === 'open' || item.status === 'uncertain' || item.status === 'sending';
/** How Mejl labels an active item: a proposed reply, something that needs the user, or mail only to know about. */
export type AssistantInboxStatus = 'reply' | 'needs-you' | 'info';
/**
 * Information from a prioritized sender (priority 1) needs the user: the host counts it in the
 * attention badge, so Att göra counts it too and Klar för alla never sweeps it away.
 */
export function assistantInboxStatus(item: Pick<AssistantItem, 'status' | 'kind' | 'question' | 'answer' | 'draft' | 'priority'>): AssistantInboxStatus {
  if (item.status !== 'open' || (item.question && !item.answer)) return 'needs-you';
  if (item.draft !== undefined && (item.kind === 'reply' || item.kind === 'followup')) return 'reply';
  return item.kind === 'information' && item.draft === undefined && item.priority !== 1 ? 'info' : 'needs-you';
}
export const assistantInboxCountsSchema = z.object({ replies: z.number().int().nonnegative(), needsYou: z.number().int().nonnegative(), info: z.number().int().nonnegative() }).strict();
export type AssistantInboxCounts = z.infer<typeof assistantInboxCountsSchema>;
/** The numbers the chat shows after a check; the same classification as the rows in Mejl. */
export function assistantInboxCounts(items: AssistantItem[]): AssistantInboxCounts {
  const counts = { replies: 0, needsYou: 0, info: 0 };
  for (const item of items) if (assistantInboxActive(item)) {
    const status = assistantInboxStatus(item);
    if (status === 'reply') counts.replies++; else if (status === 'info') counts.info++; else counts.needsYou++;
  }
  return counts;
}
function zonedParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
/**
 * A reminder at 08.00 in the user's time zone: tomorrow, or Monday next week (on a Monday that
 * is seven days ahead; on a Sunday it is tomorrow). DST shifts are resolved in that zone.
 */
export function assistantReminderAt(now: Date, timeZone: string, when: 'tomorrow' | 'next-week'): string {
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(now); } catch { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  const local = zonedParts(now, zone), weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const days = when === 'tomorrow' ? 1 : (8 - weekday) % 7 || 7;
  const wall = Date.UTC(local.year, local.month - 1, local.day + days, 8, 0, 0);
  const offset = (instant: number) => { const parts = zonedParts(new Date(instant), zone); return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant; };
  let instant = wall - offset(wall);
  instant = wall - offset(instant);
  return new Date(instant).toISOString();
}
export const assistantCoverageSchema = z.object({
  accountId: z.string().max(60), status: z.enum(["pending", "checking", "checked", "partial", "login", "unsupported", "failed"]),
  // The host adds its notes and keeps the message within 2000 UTF-16 units.
  message: maxUtf16Units(z.string(), 2000), checkedAt: dateTimeSchema.optional(),
}).strict();
export type AssistantCoverage = z.infer<typeof assistantCoverageSchema>;
export const assistantCheckpointSchema = z.object({
  accountId: z.string().max(60), threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
  sourceUrl: z.string().url().max(2000), reviewedAt: dateTimeSchema, outcome: z.enum(["needs-action", "no-action", "already-replied", "attachment-review"]),
}).strict();
export type AssistantCheckpoint = z.infer<typeof assistantCheckpointSchema>;
/**
 * The host's record of one reviewed thread, kept across checks: the inbox rows it was bound to
 * and the version (latest message) each row had. A row whose version is unchanged needs no new
 * outcome; a new message gives the row a new version.
 */
export const assistantReviewSchema = z.object({
  accountId: z.string().max(60), threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
  outcome: assistantCheckpointSchema.shape.outcome, reviewedAt: dateTimeSchema,
  rows: z.array(z.object({ key: z.string().min(1).max(600), version: z.string().min(1).max(600) }).strict()).max(10),
}).strict();
export type AssistantReview = z.infer<typeof assistantReviewSchema>;
export const assistantActivitySchema = z.object({
  stage: z.enum(["opening", "reading", "searching", "reviewing", "waiting", "complete", "error"]),
  message: z.string().max(1000), accountId: z.string().max(60).optional(), tabId: z.number().int().positive().optional(),
  updatedAt: dateTimeSchema, reviewedThreads: z.number().int().nonnegative(),
}).strict();
export type AssistantActivity = z.infer<typeof assistantActivitySchema>;
export const assistantHelpSchema = z.object({ accountId: z.string().max(60), message: z.string().min(1).max(2000), code: z.enum(["login", "expand-thread", "unsupported", "browser"]), sourceUrl: z.string().url().max(2000).optional(), tabId: z.number().int().positive().optional(), reason: z.string().max(100).optional() }).strict();
export type AssistantHelp = z.infer<typeof assistantHelpSchema>;
export const assistantRunSchema = z.object({
  id: z.string().max(100), task: assistantTaskSchema, label: z.string().max(200),
  agent: assistantAgentSettingsSchema.optional(), model: z.string().max(200).optional(),
  externalEffect: z.enum(['none', 'possible']).optional(),
  status: z.enum(["running", "waiting", "review", "paused", "failed"]),
  message: z.string().max(4000), summary: z.string().max(12000),
  startedAt: dateTimeSchema, updatedAt: dateTimeSchema,
  coverage: z.array(assistantCoverageSchema).max(12),
  question: z.string().max(4000).optional(), questionId: z.string().max(100).optional(),
  accountId: z.string().max(60).optional(), instructions: z.string().max(12000).optional(),
  threadId: z.string().max(500).optional(),
  scanKey: z.string().max(64).optional(), scanStartedAt: dateTimeSchema.optional(), resumedFrom: z.string().max(100).optional(),
  scanId: z.string().max(100).optional(),
  checkpoints: z.array(assistantCheckpointSchema).max(400).optional(), activity: assistantActivitySchema.optional(), help: assistantHelpSchema.optional(),
  helps: z.array(assistantHelpSchema).max(12).optional(),
  accountProgress: z.array(z.object({ accountId: z.string().max(60), reviewedThreads: z.number().int().nonnegative() }).strict()).max(12).optional(),
  scheduled: z.boolean().optional(),
  learnMail: z.boolean().optional(),
  canContinue: z.boolean().optional(),
}).strict();
export type AssistantRun = z.infer<typeof assistantRunSchema>;
// A start refuses instructions over 12000 UTF-16 units, so a longer shortcut must not save.
export const assistantShortcutSchema = z.object({ id: z.string().max(100), label: z.string().min(1).max(100), instructions: maxUtf16Units(z.string().min(1), 12000) }).strict();
export const assistantWorkspaceSchema = z.object({
  revision: z.number().int().nonnegative(), settings: assistantSettingsSchema,
  items: z.array(assistantItemSchema).max(100), shortcuts: z.array(assistantShortcutSchema).max(24),
  current: assistantRunSchema.optional(), history: z.array(assistantRunSchema).max(20),
  lastChecks: z.record(z.string(), dateTimeSchema),
  schedule: z.object({ nextRunAt: dateTimeSchema.optional(), lastRunAt: dateTimeSchema.optional(), message: z.string().max(1000) }).strict().optional(),
  attention: z.object({ count: z.number().int().nonnegative(), critical: z.number().int().nonnegative(), createdAt: dateTimeSchema }).strict().optional(),
  cases: z.array(assistantCaseSchema).max(100).optional(),
  caseItems: z.array(assistantItemSchema.pick({ id: true, title: true, status: true, kind: true, accountId: true, sourceUrl: true, deadline: true })).max(100).optional(),
  casePage: z.object({ offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().optional() }).strict().optional(),
  accountTests: z.array(assistantAccountTestSchema).max(12).optional(),
  mailMethods: z.array(assistantMailMethodViewSchema).max(12).optional(),
  mailMethodsError: z.string().max(1000).optional(),
  itemPage: z.object({ offset: z.number().int().nonnegative(), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().optional() }).optional(),
  /** Open reply items for mail that had been opened without a reply; Mejl names the count after "Kollat". */
  openedUnanswered: z.number().int().nonnegative().optional(),
}).strict();
export type AssistantWorkspace = z.infer<typeof assistantWorkspaceSchema>;
export const assistantResolutionSchema = z.object({ itemId: z.string().max(100), revision: z.number().int().nonnegative(), accountId: z.string().max(60), threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500), sourceUrl: z.string().url().max(2000), reason: z.string().min(1).max(2000), sources: z.array(assistantSourceSchema).min(1).max(6) }).strict();
export type AssistantResolution = z.infer<typeof assistantResolutionSchema>;
export const assistantResultSchema = z.object({
  // The host adds web activity and attachment notes and keeps the summary within 12000 UTF-16 units.
  summary: maxUtf16Units(z.string(), 12000), findings: z.array(assistantFindingSchema).max(60),
  coverage: z.array(assistantCoverageSchema).max(12),
  resolutions: z.array(assistantResolutionSchema).max(60).optional(),
}).strict();
export type AssistantResult = z.infer<typeof assistantResultSchema>;
export interface AssistantSendApproval {
  itemId: string; revision: number; account: AssistantAccount;
  threadId: string; sourceUrl: string; recipient: string; body: string;
  /** Set when the approved card names a reply address; otherwise the account's own address applies. */
  sender?: string;
}
