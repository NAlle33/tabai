import * as z from 'zod';
import { dateTimeSchema, uuidSchema } from './stable-schemas';

export const assistantConnectionSchema = z.object({
  id: z.string().max(100), label: z.string().max(120),
  state: z.enum(['unknown', 'checking', 'ready', 'action-required']),
  configured: z.boolean(), testedAt: dateTimeSchema.optional(),
  model: z.string().max(200).optional(), message: z.string().max(1000),
}).strict();
export type AssistantConnection = z.infer<typeof assistantConnectionSchema>;
export const assistantMemorySchema = z.object({
  id: uuidSchema, label: z.string().min(1).max(120), value: z.string().min(1).max(2000),
  scope: z.enum(['general', 'mail', 'module']), moduleId: z.string().max(80).optional(),
  updatedAt: dateTimeSchema,
}).strict();
export type AssistantMemory = z.infer<typeof assistantMemorySchema>;
/** What a watch reads: one public address, or one web search. */
export const assistantWatchTargetSchema = z.union([
  z.object({ url: z.string().url().max(2000) }).strict(),
  z.object({ query: z.string().trim().min(1).max(300) }).strict(),
]);
/** Daily at a local time, or every few hours. */
export const assistantWatchCadenceSchema = z.union([
  z.object({ time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict(),
  z.object({ hours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]) }).strict(),
]);
export type AssistantWatchCadence = z.infer<typeof assistantWatchCadenceSchema>;
const watchFields = {
  title: z.string().trim().min(1).max(120), target: assistantWatchTargetSchema,
  /** What counts as an event, in the user's words. */
  condition: z.string().trim().min(1).max(500), cadence: assistantWatchCadenceSchema,
};
/**
 * Why a run failed. Only `run` counts toward the automatic pause: the run reached
 * its model and could not read the target, report, or finish in time. Tabai
 * stopping (`interrupted`), a lost browser connection (`disconnected`), a model
 * that could not run (`unavailable`) and the user's own change (`stopped`) never do.
 */
export const assistantWatchFailureSchema = z.enum(['run', 'interrupted', 'disconnected', 'unavailable', 'stopped']);
export type AssistantWatchFailure = z.infer<typeof assistantWatchFailureSchema>;
/** A number a watch reads on its page, such as 48 öre/kWh; the model reports it, it is never required. */
export const assistantWatchValueSchema = z.object({ amount: z.number().finite(), unit: z.string().trim().min(1).max(30) }).strict();
export type AssistantWatchValue = z.infer<typeof assistantWatchValueSchema>;
export const assistantWatchResultSchema = z.object({ changed: z.boolean(), summary: z.string().max(2000), at: dateTimeSchema, status: z.enum(['ok', 'failed']), failure: assistantWatchFailureSchema.optional(), value: assistantWatchValueSchema.optional() }).strict();
export type AssistantWatchResult = z.infer<typeof assistantWatchResultSchema>;
/** The results a watch keeps, newest last, each with a summary of at most 300 characters. */
export const ASSISTANT_WATCH_HISTORY_LIMIT = 10;
export const ASSISTANT_WATCH_HISTORY_SUMMARY = 300;
export const assistantWatchHistoryEntrySchema = assistantWatchResultSchema.extend({ summary: z.string().max(ASSISTANT_WATCH_HISTORY_SUMMARY) });
export type AssistantWatchHistoryEntry = z.infer<typeof assistantWatchHistoryEntrySchema>;
/** Failed runs in a row before a watch pauses itself. */
export const ASSISTANT_WATCH_FAILURE_LIMIT = 3;
export const assistantWatchSchema = z.object({
  id: uuidSchema, ...watchFields, enabled: z.boolean(), createdAt: dateTimeSchema,
  createdFrom: uuidSchema.optional(), lastRunAt: dateTimeSchema.optional(), lastResult: assistantWatchResultSchema.optional(),
  /** The latest results, oldest first; absent in files from before the history (lastResult stays for them). */
  history: z.array(assistantWatchHistoryEntrySchema).max(ASSISTANT_WATCH_HISTORY_LIMIT).optional(),
  /** Counted failed runs since the last successful one; absent means none. */
  failedRuns: z.number().int().min(1).max(ASSISTANT_WATCH_FAILURE_LIMIT).optional(),
  /** Paused by Tabai after that many failed runs, not by the user. */
  pausedAfterFailures: z.literal(true).optional(),
}).strict();
export type AssistantWatch = z.infer<typeof assistantWatchSchema>;
/** One result as the history keeps it: the summary cut to 300 characters. */
export const assistantWatchHistoryEntry = (result: AssistantWatchResult): AssistantWatchHistoryEntry => ({ ...result, summary: result.summary.slice(0, ASSISTANT_WATCH_HISTORY_SUMMARY) });
/** A watch's results, oldest first. A file from before the history has at most its lastResult. */
export const assistantWatchHistory = (watch: Pick<AssistantWatch, 'history' | 'lastResult'>): AssistantWatchHistoryEntry[] =>
  watch.history ? [...watch.history] : watch.lastResult ? [assistantWatchHistoryEntry(watch.lastResult)] : [];
const amounts = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });
/**
 * The list's trend: the latest values in one unit, oldest first, and the last
 * step's direction, such as "164 → 120 → 48 öre/kWh ↓". Without values in the
 * latest successful result there is none, and the list shows the summaries instead.
 */
export function assistantWatchTrend(history: AssistantWatchHistoryEntry[], count = 5): { text: string; direction: 'down' | 'up' | 'same' | 'none' } | undefined {
  const valued = history.filter(entry => entry.status === 'ok' && entry.value);
  const unit = valued.at(-1)?.value?.unit;
  if (!unit) return undefined;
  const values: number[] = [];
  // The run of values in the latest unit, back to the first one in another unit.
  for (let index = valued.length - 1; index >= 0 && values.length < count; index--) {
    if (valued[index].value!.unit !== unit) break;
    values.unshift(valued[index].value!.amount);
  }
  const [previous, last] = values.slice(-2);
  const direction = values.length < 2 ? 'none' : last < previous ? 'down' : last > previous ? 'up' : 'same';
  const arrow = { down: ' ↓', up: ' ↑', same: ' (oförändrat)', none: '' }[direction];
  return { text: `${values.map(value => amounts.format(value)).join(' → ')} ${unit}${arrow}`, direction };
}
/** The controller starts at most one watch per check, every five minutes: twelve runs an hour. */
export const ASSISTANT_WATCH_RUNS_PER_HOUR = 12;
export const assistantWatchRunsPerDay = (cadence: AssistantWatchCadence): number => 'hours' in cadence ? 24 / cadence.hours : 1;
/** Whether these schedules together need more runs an hour than the controller starts. */
export const assistantWatchOverCapacity = (runsPerDay: number[]) => runsPerDay.reduce((total, runs) => total + runs, 0) > ASSISTANT_WATCH_RUNS_PER_HOUR * 24;
export const ASSISTANT_WATCH_CAPACITY_WARNING = `Dina aktiva bevakningar behöver fler än ${ASSISTANT_WATCH_RUNS_PER_HOUR} körningar i timmen. Tabai startar högst en bevakning var femte minut, så en del körningar sker senare än schemat. Pausa en bevakning eller välj ett glesare schema.`;
/** The panel's projection: schedule and run state are derived by the host, never stored. */
export const assistantWatchViewSchema = assistantWatchSchema.extend({
  running: z.boolean(), runsPerDay: z.number().int().min(1).max(24),
  nextRunAt: dateTimeSchema.optional(), paused: z.string().max(300).optional(),
}).strict();
export type AssistantWatchView = z.infer<typeof assistantWatchViewSchema>;

/** A routine's local time and weekdays, 1 for Monday to 7 for Sunday; no list or an empty one means every day. */
export const assistantRoutineScheduleSchema = z.object({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
}).strict();
export type AssistantRoutineSchedule = z.infer<typeof assistantRoutineScheduleSchema>;
/** The existing tasks a routine can start: Kolla mejl, Min dag, Förbered möte, Följ upp, or one of the user's own shortcuts. */
export const assistantRoutineTaskSchema = z.enum(['check-mail', 'my-day', 'prepare-meeting', 'follow-ups', 'shortcut']);
export type AssistantRoutineTask = z.infer<typeof assistantRoutineTaskSchema>;
const routineBase = { title: z.string().trim().min(1).max(120), schedule: assistantRoutineScheduleSchema };
/** A chat question the chat model answers in "Rutiner", read-only at most. */
const chatRoutine = z.object({ kind: z.literal('chat'), ...routineBase, prompt: z.string().trim().min(1).max(2000) }).strict();
/** An existing task, started like the morning check under the tasks' own mail and web rules. */
const taskRoutine = z.object({ kind: z.literal('task'), ...routineBase, task: assistantRoutineTaskSchema, shortcutId: z.string().min(1).max(100).optional() }).strict();
export const assistantRoutineDefinitionSchema = z.discriminatedUnion('kind', [chatRoutine, taskRoutine]);
export type AssistantRoutineDefinition = z.infer<typeof assistantRoutineDefinitionSchema>;
/** A finished run; for a task routine, the task it started, whose own result is in Mejl. */
export const assistantRoutineResultSchema = z.object({
  at: dateTimeSchema, status: z.enum(['ok', 'failed']), summary: z.string().max(ASSISTANT_WATCH_HISTORY_SUMMARY),
  failure: assistantWatchFailureSchema.optional(), taskId: z.string().max(100).optional(),
}).strict();
export type AssistantRoutineResult = z.infer<typeof assistantRoutineResultSchema>;
/** The same bookkeeping as a watch: a run is reserved before it starts, and three counted failures in a row pause it. */
const routineState = {
  id: uuidSchema, enabled: z.boolean(), createdAt: dateTimeSchema, createdFrom: uuidSchema.optional(),
  lastRunAt: dateTimeSchema.optional(), lastResult: assistantRoutineResultSchema.optional(),
  failedRuns: z.number().int().min(1).max(ASSISTANT_WATCH_FAILURE_LIMIT).optional(), pausedAfterFailures: z.literal(true).optional(),
};
export const assistantRoutineSchema = z.discriminatedUnion('kind', [chatRoutine.extend(routineState), taskRoutine.extend(routineState)]);
export type AssistantRoutine = z.infer<typeof assistantRoutineSchema>;
/** The panel's projection; `label` names the task, or says that its shortcut is gone. */
const routineView = { ...routineState, running: z.boolean(), runsPerWeek: z.number().int().min(1).max(7), nextRunAt: dateTimeSchema.optional(), label: z.string().max(200).optional() };
export const assistantRoutineViewSchema = z.discriminatedUnion('kind', [chatRoutine.extend(routineView), taskRoutine.extend(routineView)]);
export type AssistantRoutineView = z.infer<typeof assistantRoutineViewSchema>;
/** The tasks a routine can start, as the panel and the cards name them. */
export const assistantRoutineTaskLabels: Record<Exclude<AssistantRoutineTask, 'shortcut'>, string> = { 'check-mail': 'Kolla mejl', 'my-day': 'Min dag', 'prepare-meeting': 'Förbered möte', 'follow-ups': 'Följ upp' };
const weekdays = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
/** "varje fredag kl. 16:00", "vardagar kl. 08:00", "måndag och torsdag kl. 07:30" or "varje dag kl. 07:00". */
export function assistantRoutineScheduleText(schedule: AssistantRoutineSchedule): string {
  const days = assistantRoutineDays(schedule), key = days.join('');
  const when = key === '1234567' ? 'varje dag' : key === '12345' ? 'vardagar' : key === '67' ? 'helger' : days.length === 1 ? `varje ${weekdays[days[0] - 1]}`
    : `${days.slice(0, -1).map(day => weekdays[day - 1]).join(', ')} och ${weekdays[days.at(-1)! - 1]}`;
  return `${when} kl. ${schedule.time}`;
}
/** The weekdays a schedule runs on, sorted and without repeats; every day when none are chosen. */
export const assistantRoutineDays = (schedule: AssistantRoutineSchedule): number[] => schedule.days?.length ? [...new Set(schedule.days)].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7];
/** A routine's share of the shared schedule, in runs a day. */
export const assistantRoutineRunsPerDay = (schedule: AssistantRoutineSchedule): number => assistantRoutineDays(schedule).length / 7;
/** The same limit counted over watches and routines together, worded for both. */
export const ASSISTANT_SCHEDULE_CAPACITY_WARNING = `Dina aktiva bevakningar och rutiner behöver fler än ${ASSISTANT_WATCH_RUNS_PER_HOUR} körningar i timmen. Tabai startar högst en bevakning eller rutin var femte minut, så en del körningar sker senare än schemat. Pausa en bevakning eller rutin, eller välj ett glesare schema.`;
/** The capacity warning for these enabled schedules, if they need more runs than the shared schedule starts. */
export function assistantScheduleCapacityWarning(watchRunsPerDay: number[], routineRunsPerDay: number[]): string | undefined {
  if (!assistantWatchOverCapacity([...watchRunsPerDay, ...routineRunsPerDay])) return undefined;
  return routineRunsPerDay.length ? ASSISTANT_SCHEDULE_CAPACITY_WARNING : ASSISTANT_WATCH_CAPACITY_WARNING;
}

/** The user's own form details. Never cards, passwords or keys (the host validates every value). */
export const ASSISTANT_PROFILE_FIELDS = ['name', 'street', 'postalCode', 'city', 'country', 'phone', 'email'] as const;
export type AssistantProfileField = typeof ASSISTANT_PROFILE_FIELDS[number];
export const assistantProfileLabels: Record<AssistantProfileField, string> = {
  name: 'Namn', street: 'Gatuadress', postalCode: 'Postnummer', city: 'Ort', country: 'Land', phone: 'Telefon', email: 'E-post',
};
export const assistantProfileSchema = z.object({
  name: z.string().max(200).optional(), street: z.string().max(200).optional(), postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(), country: z.string().max(100).optional(), phone: z.string().max(40).optional(),
  email: z.string().email().max(254).optional(),
  extra: z.array(z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(300) }).strict()).max(6),
  updatedAt: dateTimeSchema,
}).strict();
export type AssistantProfile = z.infer<typeof assistantProfileSchema>;

export const assistantChatIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('memory'), label: z.string().min(1).max(120), value: z.string().min(1).max(2000), scope: z.enum(['general', 'mail', 'module']), moduleId: z.string().max(80).optional() }).strict(),
  z.object({ kind: z.literal('schedule'), enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().max(100), task: z.enum(['check-mail', 'my-day']), learnMail: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('mail-learning'), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('module'), moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), values: z.record(z.string(), z.string().max(4000)).optional() }).strict(),
  z.object({ kind: z.literal('model'), role: z.enum(['chat', 'task']), model: z.string().max(200) }).strict(),
  z.object({ kind: z.literal('account'), provider: z.enum(['gmail', 'outlook', 'zoho']), email: z.string().email().max(254), url: z.string().url().max(2000).optional(), label: z.string().max(120).optional() }).strict(),
  z.object({ kind: z.literal('watch'), ...watchFields }).strict(),
  /** Changes to a saved watch, named by the watchId chat_config shows; the host checks it still exists. */
  z.object({ kind: z.literal('watch-pause'), watchId: uuidSchema, paused: z.boolean() }).strict(),
  z.object({ kind: z.literal('watch-delete'), watchId: uuidSchema }).strict(),
  z.object({ kind: z.literal('watch-edit'), watchId: uuidSchema, condition: watchFields.condition.optional(), cadence: assistantWatchCadenceSchema.optional() }).strict(),
  /** A new routine, and changes to a saved one named by the routineId chat_config shows. */
  z.object({ kind: z.literal('routine-create'), routine: assistantRoutineDefinitionSchema, learnMail: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('routine-pause'), routineId: uuidSchema, paused: z.boolean() }).strict(),
  z.object({ kind: z.literal('routine-delete'), routineId: uuidSchema }).strict(),
]);
export type AssistantChatIntent = z.infer<typeof assistantChatIntentSchema>;
export const assistantModuleRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('request'), moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), operation: z.enum(['status', 'start', 'reply', 'message', 'stop', 'select', 'history']), input: z.record(z.string(), z.string().max(20000)).default({}) }).strict(),
]);
export type AssistantModuleRequest = z.infer<typeof assistantModuleRequestSchema>;
export const assistantBudgetPriceSchema = z.object({
  model: z.string().max(200), currency: z.literal('EUR'), inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(),
  checkedAt: dateTimeSchema, source: z.literal('https://api.berget.ai/v1/models/'),
}).strict();
export type AssistantBudgetPrice = z.infer<typeof assistantBudgetPriceSchema>;
export const assistantBudgetViewSchema = z.object({
  period: z.string().max(20), currency: z.literal('EUR'), limitEur: z.number().nonnegative().optional(),
  settledEur: z.number().nonnegative(), reservedEur: z.number().nonnegative(), uncertainEur: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  prices: z.array(assistantBudgetPriceSchema).max(10), message: z.string().max(1000),
  entries: z.array(z.object({ id: uuidSchema, model: z.string().max(200), runId: z.string().max(100), createdAt: dateTimeSchema, status: z.enum(['reserved', 'settled', 'uncertain']), reservedEur: z.number().nonnegative(), costEur: z.number().nonnegative().optional(), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }).strict()).max(50),
}).strict();
export type AssistantBudgetView = z.infer<typeof assistantBudgetViewSchema>;
