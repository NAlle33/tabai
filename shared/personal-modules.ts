import * as z from "zod";
import { dateTimeSchema, uuidSchema } from "./stable-schemas";
import { assistantAccountSchema, assistantWorkspaceSchema } from "./assistant";
import { assistantLocalRuntimeSchema } from "./assistant-diagnostics";
import { assistantChatViewSchema } from './assistant-chat';

const text = z.string().max(4000);
export const moduleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
export const moduleOperationSchema = z.enum(["status", "start", "reply", "message", "resume", "stop", "open", "draft", "history", "select", "archive", "restore", "correct"]);
export type ModuleOperation = z.infer<typeof moduleOperationSchema>;
export const moduleInputSchema = z.record(z.string(), z.string().max(100000)).superRefine((value, context) => {
  if (Object.keys(value).length > 30) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many input fields' });
  for (const [key, input] of Object.entries(value)) if (input.length > (key === 'values' || key === 'fileChunk' ? 100000 : 20000)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Input field is too large' });
  }
});

const moduleReviewSourceSchema = z.object({
  label: z.string().max(120),
  quote: z.string().max(500),
  url: z.string().url().max(4000).optional(),
}).strict();

const moduleReviewItemSchema = z.object({
  id: z.string().max(100).optional(),
  editValue: z.string().max(300).optional(),
  label: z.string().max(120),
  value: text,
  status: z.enum(['confirmed', 'missing', 'conflict']),
  note: text.optional(),
  sources: z.array(moduleReviewSourceSchema).max(2),
}).strict();

export const moduleReviewSchema = z.object({
  title: z.string().min(1).max(120),
  summary: text,
  overview: z.array(moduleReviewItemSchema).max(8).optional(),
  verification: z.object({
    state: z.enum(['pending', 'passed', 'failed']),
    message: text,
    checkedAt: dateTimeSchema.optional(),
    issues: z.array(z.string().max(1000)).max(150),
  }).strict(),
  sections: z.array(z.object({
    title: z.string().max(120),
    items: z.array(moduleReviewItemSchema).max(10),
  }).strict()).max(22),
}).strict();
export type ModuleReview = z.infer<typeof moduleReviewSchema>;
const draftSchema = z.object({ context: z.string().max(180), revision: z.number().int().nonnegative(), values: moduleInputSchema, updatedAt: dateTimeSchema.optional() }).strict();
export const moduleViewSchema = z.object({
  chat: assistantChatViewSchema.optional(),
  assistant: assistantWorkspaceSchema.optional(),
  localRuntime: assistantLocalRuntimeSchema.optional(),
  title: z.string().min(1).max(120),
  description: text,
  startLabel: z.string().min(1).max(120),
  fields: z.array(z.object({
    name: moduleIdSchema, label: z.string().min(1).max(120),
    multiline: z.boolean().optional(), required: z.boolean().optional(),
    advanced: z.boolean().optional(),
    value: text.optional(), placeholder: text.optional(),
  }).strict()).max(20),
  run: z.object({
    id: z.string().max(100),
    title: text.optional(), archived: z.boolean().optional(),
    status: z.enum(["running", "waiting", "paused", "review", "failed"]),
    step: z.string().max(200).optional(),
    updatedAt: dateTimeSchema.optional(),
    replyReceivedAt: dateTimeSchema.optional(),
    message: text, summary: z.string().max(20000).optional(), question: text.optional(),
    questionId: z.string().max(100).optional(),
    choices: z.array(z.object({ label: z.string().min(1).max(120), value: text }).strict()).max(6).optional(),
    actionLabel: z.string().max(120).optional(), openLabel: z.string().max(120).optional(),
    canCorrect: z.boolean().optional(),
    sources: z.array(z.object({ label: text, url: z.string().url().max(4000) }).strict()).max(50).optional(),
    canOpen: z.boolean().optional(), canResume: z.boolean().optional(),
    /** The resume button's own words when resuming does something more specific than Fortsätt ärendet. */
    resumeLabel: z.string().min(1).max(120).optional(),
    /** While the run works: Arkivera may stop it, and the module archives it once the current step ends. */
    stopAndArchive: z.boolean().optional(),
    /** `false` while Stoppa would do nothing, for instance while an archive waits for the step to end. */
    canStop: z.boolean().optional(),
    /** Why the run cannot be archived right now. Shown instead of any archive button. */
    archiveBlocked: z.string().min(1).max(300).optional(),
    /** Present when the module takes free text about this run: `ready` now, `busy` while it works. */
    messaging: z.enum(['ready', 'busy']).optional(),
    /** The dialogue about this run, oldest first. The IDs let a linked chat mirror it once. */
    conversation: z.array(z.object({ id: uuidSchema, role: z.enum(['owner', 'agent', 'note']), text: z.string().min(1).max(8000), at: dateTimeSchema }).strict()).max(40).optional(),
    review: moduleReviewSchema.optional(),
  }).strict().optional(),
  drafts: z.object({ start: draftSchema, reply: draftSchema.optional() }).strict().optional(),
  history: z.array(z.object({ label: text, detail: text, id: z.string().max(100).optional(), archived: z.boolean().optional() }).strict()).max(20).optional(),
  historyPage: z.object({ query: z.string().max(300), archived: z.boolean(), offset: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
  /**
   * The module can start from one mail. Mejl offers `label` on an open mail from one of
   * `providers` (any provider when absent) and fills these start fields; the user still presses
   * the start button. `mailField` gets the mail's sender, account and title, `accountField` its
   * provider, `linkField` the mail's own address, and `clearFields` are emptied. A mail whose title
   * or summary contains one of `keywords` gets the start as its main button.
   */
  mailStart: z.object({
    label: z.string().min(1).max(60), mailField: moduleIdSchema, accountField: moduleIdSchema.optional(),
    linkField: moduleIdSchema.optional(), clearFields: z.array(moduleIdSchema).max(10).optional(),
    // At least two UTF-16 units, as module programs' views were accepted: zod's own min()
    // counts characters, so a one-emoji keyword would refuse the whole view. Listed as before.
    keywords: z.array(z.string().max(40).refine(keyword => keyword.length >= 2).meta({ minLength: 2 })).max(20).optional(),
    providers: z.array(assistantAccountSchema.shape.provider).min(1).max(3).optional(),
  }).strict().optional(),
  /**
   * Runs started from a mail, newest first, by the address the mail start gave `linkField`.
   * `handled` says the request is dealt with since `handledAt`; Mejl marks the mail Klar only when
   * the mail has not changed since then, so an Ångra (which changes it) holds.
   */
  mailRuns: z.array(z.object({
    link: z.string().url().max(4000), runId: z.string().max(100), label: z.string().max(120), handled: z.boolean(),
    handledAt: dateTimeSchema.optional(),
  }).strict()).max(50).optional(),
}).strict().superRefine((view, context) => {
  const start = view.mailStart;
  if (!start) return;
  const named = [start.mailField, start.accountField, start.linkField, ...(start.clearFields ?? [])].filter((name): name is string => !!name);
  if (new Set(named).size !== named.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['mailStart'], message: 'A field is named twice' });
  for (const name of named) if (!view.fields.some(field => field.name === name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['mailStart'], message: `Not a start field: ${name}` });
});
export type ModuleView = z.infer<typeof moduleViewSchema>;
export interface PersonalModule { id: string; view?: ModuleView; error?: string }
