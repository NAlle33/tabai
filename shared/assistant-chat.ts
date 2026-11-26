import * as z from 'zod';
import { dateTimeSchema, uuidSchema } from './stable-schemas';
import { assistantSearchViewSchema } from './assistant-search';
import { assistantAgentConfig, assistantAgentDefaults, assistantClaudeModelIds, assistantClaudeModelInfo, assistantCodexSettingsSchema, assistantLocalModelIds, assistantStoredLocalModelIdSchema, assistantLocalModelInfo, type AssistantAgentConfig, type AssistantAgentSettings } from './assistant-diagnostics';
import { assistantBergetDefaults, assistantBergetModelIds, assistantBergetModelInfo, assistantBergetStatusSchema } from './assistant-berget';
import { assistantChatIntentSchema, assistantMemorySchema, assistantConnectionSchema, assistantBudgetViewSchema, assistantProfileSchema, assistantWatchViewSchema } from './assistant-services';
import { assistantRoutineViewSchema } from './assistant-services';
import { assistantWebApprovalSchema } from './assistant-web';
import { assistantApprovalImageSchema, assistantFileSchema, ASSISTANT_FILES_PER_MESSAGE } from './assistant-files';
import { assistantInboxCountsSchema } from './assistant';

export const assistantChatTaskSchema = z.enum(['check-mail', 'follow-ups', 'prepare-meeting', 'my-day', 'custom']);
export type AssistantChatTask = z.infer<typeof assistantChatTaskSchema>;
type Choice = { id: string; backend: AssistantAgentConfig['backend']; label: string; model: string };
export const assistantChatModels: Choice[] = [
  ...assistantCodexSettingsSchema.shape.model.options.map(model => ({ id: `codex:${model}`, backend: 'codex' as const, label: model === 'gpt-6.1-terra' ? 'Codex · GPT-6.1 Terra' : 'Codex · GPT-6.1 Sol', model })),
  ...assistantClaudeModelIds.map(model => ({ id: `claude:${model}`, backend: 'claude' as const, label: `Claude · ${assistantClaudeModelInfo[model].label}`, model })),
  ...assistantLocalModelIds.map(model => ({ id: `local:${model}`, backend: 'local' as const, label: `Lokal · ${assistantLocalModelInfo[model].label}`, model })),
  ...assistantBergetModelIds.map(model => ({ id: `berget:${model}`, backend: 'berget' as const, label: `Berget · ${assistantBergetModelInfo[model].label}`, model })),
];
export const assistantChatModelSchema = z.preprocess(value => {
  if (typeof value !== 'string' || !value.startsWith('local:')) return value;
  const model = assistantStoredLocalModelIdSchema.safeParse(value.slice('local:'.length));
  return model.success ? `local:${model.data}` : value;
}, z.string().max(200).refine(id => assistantChatModels.some(model => model.id === id), 'Välj en tillgänglig modell.'));
export function assistantChatModel(agent?: AssistantAgentSettings): string {
  const config = assistantAgentConfig(agent);
  const model = config.backend === 'berget' ? (config.berget ?? assistantBergetDefaults).model : config[config.backend].model;
  return `${config.backend}:${model}`;
}
/** Watches run unattended, so by default on this computer without cost or usage. */
export const assistantWatchDefaultModel = 'local:qwen3.5:4b-q4_K_M';
export const assistantChatModelLabel = (id: string) => assistantChatModels.find(model => model.id === id)?.label ?? id;
export function assistantChatAgent(id: string, current?: AssistantAgentSettings): AssistantAgentConfig {
  id = assistantChatModelSchema.parse(id); const choice = assistantChatModels.find(model => model.id === id)!;
  const config = assistantAgentConfig(current); config.backend = choice.backend;
  // Every ID comes from the same typed provider catalogue as the settings form.
  if (choice.backend === 'codex') config.codex.model = assistantCodexSettingsSchema.shape.model.parse(choice.model);
  else if (choice.backend === 'claude') config.claude.model = z.enum(assistantClaudeModelIds).parse(choice.model);
  else if (choice.backend === 'local') config.local.model = z.enum(assistantLocalModelIds).parse(choice.model);
  else config.berget = { model: z.enum(assistantBergetModelIds).parse(choice.model) };
  return config;
}
export const assistantChatContextSchema = z.object({ kind: z.enum(['item', 'case']), id: z.string().min(1).max(100), revision: z.number().int().nonnegative(), label: z.string().max(300) }).strict();
export type AssistantChatContext = z.infer<typeof assistantChatContextSchema>;
/** Cards hold the agent's proposals or a host-created web approval; the agent can only propose the former. */
export const assistantChatCardIntentSchema = z.discriminatedUnion('kind', [...assistantChatIntentSchema.options, assistantWebApprovalSchema]);
export type AssistantChatCardIntent = z.infer<typeof assistantChatCardIntentSchema>;
export const assistantChatCardSchema = z.object({
  id: uuidSchema, title: z.string().max(200), detail: z.string().max(3000),
  status: z.enum(['pending', 'applying', 'applied', 'failed', 'uncertain', 'dismissed']),
  intent: assistantChatCardIntentSchema, error: z.string().max(1000).optional(),
  userMessageId: uuidSchema.optional(),
  /** Something the user should weigh before confirming, such as a watch schedule Tabai cannot keep. */
  warning: z.string().max(500).optional(),
}).strict();
export const assistantChatModuleTargetSchema = z.object({ moduleId: z.string().max(80), runId: z.string().max(100) }).strict();
export const assistantChatModuleSchema = z.object({
  moduleId: z.string().max(80), runId: z.string().max(100), title: z.string().max(200),
  status: z.enum(['running', 'waiting', 'paused', 'review', 'failed']), message: z.string().max(4000),
  summary: z.string().max(4000).optional(), question: z.string().max(4000).optional(), questionId: z.string().max(100).optional(),
  choices: z.array(z.object({ label: z.string().max(120), value: z.string().max(4000) }).strict()).max(6).optional(),
  canOpen: z.boolean().optional(), canResume: z.boolean().optional(), openLabel: z.string().max(120).optional(),
  messaging: z.enum(['ready', 'busy']).optional(),
  overview: z.array(z.object({ label: z.string().max(120), value: z.string().max(4000), status: z.enum(['confirmed', 'missing', 'conflict']), note: z.string().max(1000).optional() }).strict()).max(8).optional(),
  verification: z.object({ state: z.enum(['pending', 'passed', 'failed']), message: z.string().max(4000), issues: z.array(z.string().max(1000)).max(20) }).strict().optional(),
}).strict();
/** At most this many shops in one price comparison. */
export const ASSISTANT_COMPARE_ROWS = 8;
// The library reports an infinite number as a value of the wrong type. It keeps the short
// message, any other wrong value gets the example, and a missing one the library's own message.
const amount = (label: string, negative: string, large: string, max: number) => z.number({
  error: issue => issue.code !== 'invalid_type' || issue.input === undefined ? undefined
    : typeof issue.input === 'number' && !Number.isNaN(issue.input) ? `Ange ${label} som ett tal.`
    : `Ange ${label} som ett tal, till exempel 499 eller 1299.5.`,
}).finite(`Ange ${label} som ett tal.`).nonnegative(negative).max(max, large);
/** One shop's offer as the chat agent read it on that shop's own page; shipping only when the page showed it. */
export const assistantChatCompareRowSchema = z.object({
  shop: z.string().trim().min(1).max(120), product: z.string().trim().min(1).max(200),
  price: amount('priset', 'Priset kan inte vara negativt.', 'Priset är orimligt stort. Kontrollera det på sidan.', 100_000_000),
  shipping: amount('frakten', 'Frakten kan inte vara negativ.', 'Frakten är orimligt stor. Kontrollera den på sidan.', 1_000_000).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Ange valutan som en kod med tre stora bokstäver, till exempel SEK för kronor.'),
  url: z.string().url().max(2000),
}).strict();
export type AssistantChatCompareRow = z.infer<typeof assistantChatCompareRowSchema>;
/** What chat_compare takes: the user's search and one row per shop. */
export const assistantChatCompareInputSchema = z.object({
  query: z.string().trim().min(1).max(300),
  rows: z.array(assistantChatCompareRowSchema).min(1).max(ASSISTANT_COMPARE_ROWS, `Högst ${ASSISTANT_COMPARE_ROWS} butiker i en jämförelse.`),
}).strict();
export type AssistantChatCompareInput = z.infer<typeof assistantChatCompareInputSchema>;
/** The comparison card: the rows cheapest first and when the host recorded them. */
export const assistantChatCompareSchema = assistantChatCompareInputSchema.extend({ readAt: dateTimeSchema }).strict();
export type AssistantChatCompare = z.infer<typeof assistantChatCompareSchema>;
/** Price plus shipping, in whole cents; a shop that showed no shipping counts with its price alone. */
export const assistantCompareTotal = (row: Pick<AssistantChatCompareRow, 'price' | 'shipping'>) => Math.round((row.price + (row.shipping ?? 0)) * 100) / 100;
/** Cheapest total first; equal totals keep the agent's order. */
/**
 * Whether two http(s) addresses are on the same site as a comparison row counts it:
 * the same host, with a leading "www." ignored. A redirect within the shop keeps the
 * requested address valid; one to another site or a blank page does not.
 */
export function assistantCompareSameSite(a: string, b: string): boolean {
  const host = (value: string) => {
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase().replace(/^www\./, '') : undefined; }
    catch { return undefined; }
  };
  const left = host(a);
  return left !== undefined && left === host(b);
}
export const assistantCompareSorted =<T extends Pick<AssistantChatCompareRow, 'price' | 'shipping'>>(rows: readonly T[]): T[] => [...rows].sort((a, b) => assistantCompareTotal(a) - assistantCompareTotal(b));
/** "1 299 kr" for kronor, "12,50 EUR" otherwise; `grouping: false` gives "1299 kr" for a watch's condition. */
export function assistantCompareAmount(value: number, currency: string, grouping = true): string {
  const digits = Number.isInteger(value) ? 0 : 2;
  return `${value.toLocaleString('sv-SE', { minimumFractionDigits: digits, maximumFractionDigits: 2, useGrouping: grouping })} ${currency === 'SEK' ? 'kr' : currency}`;
}
/** A comparison as the model and the conversation search read it: one line per shop, cheapest first. */
export function assistantCompareText(compare: AssistantChatCompare): string {
  return [`Prisjämförelse: ${compare.query} (priser lästa ${compare.readAt})`, ...compare.rows.map(row => `• ${row.shop}: ${row.product}, ${assistantCompareAmount(row.price, row.currency)}${row.shipping === undefined ? ', frakt okänd' : ` + ${assistantCompareAmount(row.shipping, row.currency)} frakt`} = ${assistantCompareAmount(assistantCompareTotal(row), row.currency)} (${row.url})`)].join('\n');
}
export const assistantSavedListKindSchema = z.enum(['watches', 'routines']);
export type AssistantSavedListKind = z.infer<typeof assistantSavedListKindSchema>;
export const assistantSavedListSchema = z.object({
  kind: assistantSavedListKindSchema, revision: z.string().max(64), readAt: dateTimeSchema, error: z.string().max(500).optional(),
  rows: z.array(z.object({ id: uuidSchema, title: z.string().max(200), enabled: z.boolean(), status: z.string().max(200).optional(), detail: z.string().max(800), at: dateTimeSchema.optional() }).strict()).max(20),
}).strict();
export type AssistantSavedList = z.infer<typeof assistantSavedListSchema>;
export const assistantChatMessageSchema = z.object({
  id: uuidSchema, role: z.enum(['user', 'assistant', 'system']), text: z.string().max(16000),
  createdAt: dateTimeSchema, model: z.string().max(200).optional(),
  status: z.enum(['pending', 'complete', 'failed', 'interrupted']),
  files: z.array(assistantFileSchema).max(ASSISTANT_FILES_PER_MESSAGE).optional(),
  task: z.object({ id: uuidSchema, label: z.string().max(120), status: z.enum(['running', 'waiting', 'review', 'paused', 'failed']).optional(), model: z.string().max(200).optional(),
    /** Mejl's Att göra list when the task finished; recorded once, so the message stays a record of that check. */
    counts: assistantInboxCountsSchema.optional() }).strict().optional(),
  card: assistantChatCardSchema.optional(), module: assistantChatModuleSchema.optional(),
  /** Text between the owner and a module run. It stays out of the ordinary chat model's context. */
  moduleDialogue: z.literal(true).optional(),
  /** Pages and searches Tabai itself registered during a turn or a watch run, one line each. */
  webActivity: z.array(z.string().max(300)).min(1).max(40).optional(),
  /** A price comparison the chat agent showed; every row's page was opened or read in its turn. */
  compare: assistantChatCompareSchema.optional(),
  lists: z.array(assistantSavedListSchema).max(2).optional(),
  /** Persisted before any dispatch that may change external state. Missing metadata is unknown. */
  continuation: z.object({ userId: uuidSchema, effect: z.enum(['none', 'possible']), from: uuidSchema.optional() }).strict().optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costEur: z.number().nonnegative().optional() }).strict().optional(),
}).strict();
export type AssistantChatMessage = z.infer<typeof assistantChatMessageSchema>;
/** The heading older messages used for web activity in their text. */
export const ASSISTANT_WEB_ACTIVITY_HEADING = 'Webbaktivitet:';
/** Bounds the registered lines to what a message may carry. */
export const assistantWebActivityLines = (lines: string[]) => lines.map(line => line.slice(0, 300)).filter(Boolean).slice(0, 40);
/** A message as the model and the conversation search read it: web activity under its old heading, and a comparison's rows. */
export function assistantChatMessageText(entry: Pick<AssistantChatMessage, 'text' | 'webActivity'> & Partial<Pick<AssistantChatMessage, 'compare' | 'lists'>>): string {
  const compare = [entry.compare ? assistantCompareText(entry.compare) : '', ...(entry.lists ?? []).map(list => `${list.kind === 'watches' ? 'Bevakningar' : 'Rutiner'}:\n${list.rows.map(row => `${row.title}: ${row.enabled ? 'aktiv' : 'pausad'} · ${row.detail}`).join('\n')}`)].filter(Boolean).join('\n\n');
  if (!entry.webActivity?.length) return [entry.text, compare].filter(Boolean).join('\n\n');
  return [entry.text, compare, `${ASSISTANT_WEB_ACTIVITY_HEADING}\n${entry.webActivity.map(line => `• ${line}`).join('\n')}`].filter(Boolean).join('\n\n');
}
export const assistantChatViewSchema = z.object({
  focusAttachment: z.object({ id: uuidSchema, title: z.string().max(255), snippet: z.string().max(360) }).strict().optional(),
  search: assistantSearchViewSchema.optional(), focusMessageId: uuidSchema.optional(), focusRequestId: uuidSchema.optional(),
  id: uuidSchema, messages: z.array(assistantChatMessageSchema).max(100), busy: z.boolean(),
  model: assistantChatModelSchema, berget: assistantBergetStatusSchema,
  unavailable: z.string().max(500).optional(),
  fileDrafts: z.array(assistantFileSchema).max(ASSISTANT_FILES_PER_MESSAGE).optional(), fileError: z.string().max(500).optional(),
  title: z.string().max(120).optional(), taskModel: assistantChatModelSchema.optional(), context: assistantChatContextSchema.optional(),
  /** The run this conversation's text goes to; absent means the ordinary chat. */
  moduleTarget: assistantChatModuleTargetSchema.optional(),
  conversations: z.array(z.object({ id: uuidSchema, title: z.string().max(120), updatedAt: dateTimeSchema, count: z.number().int().nonnegative(), busy: z.boolean(), context: assistantChatContextSchema.optional() }).strict()).max(100).optional(),
  query: z.string().max(200).optional(), activeConversationId: uuidSchema.optional(),
  activity: z.object({ message: z.string().max(500), updatedAt: dateTimeSchema }).strict().optional(),
  memories: z.array(assistantMemorySchema).max(100).optional(), connections: z.array(assistantConnectionSchema).max(20).optional(),
  budget: assistantBudgetViewSchema.optional(),
  budgetError: z.string().max(500).optional(),
  /** Watches, their own model and the conversation that receives their results. */
  watches: z.array(assistantWatchViewSchema).max(20).optional(), watchModel: assistantChatModelSchema.optional(), watchNotifications: z.boolean().optional(),
  /** The host clears a named conversation; an older host clears only the selected one. */
  clearById: z.literal(true).optional(),
  watchConversationId: uuidSchema.optional(), watchesError: z.string().max(500).optional(),
  /** The user's own form details; only the act web level lets the agent read them. */
  profile: assistantProfileSchema.optional(), profileError: z.string().max(500).optional(),
  /** A piece of an approval card's image, only in the reply to the panel's own request for it. */
  preview: assistantApprovalImageSchema.optional(),
  /** Routines, their notice setting and the conversation that receives their answers. */
  routines: z.array(assistantRoutineViewSchema).max(20).optional(), routineNotifications: z.boolean().optional(),
  routineConversationId: uuidSchema.optional(), routinesError: z.string().max(500).optional(),
}).strict();
export type AssistantChatView = z.infer<typeof assistantChatViewSchema>;
export const assistantChatDefaultModel = assistantChatModel(assistantAgentDefaults);
