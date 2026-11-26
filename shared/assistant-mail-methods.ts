import * as z from 'zod';
import { dateTimeSchema, uuidSchema } from './stable-schemas';

export const assistantMailMethodStepSchema = z.enum(['verify-account', 'read-incoming', 'read-sent', 'return-inbox']);
export type AssistantMailMethodStep = z.infer<typeof assistantMailMethodStepSchema>;
export const assistantMailMethodStepLabels: Record<AssistantMailMethodStep, string> = {
  'verify-account': 'Verifiera kontot', 'read-incoming': 'Läs inkommande mappar',
  'read-sent': 'Öppna Skickat', 'return-inbox': 'Återgå till en färsk inkorg',
};
export const assistantMailMethodDefinitionSchema = z.object({
  steps: z.array(assistantMailMethodStepSchema).length(4).refine(steps => steps[0] === 'verify-account'
    && steps[3] === 'return-inbox' && new Set(steps).size === 4, 'Kontoverifiering måste komma först, alla vyer ingå och en färsk inkorg sist.'),
  expandThreads: z.boolean(),
}).strict();
export type AssistantMailMethodDefinition = z.infer<typeof assistantMailMethodDefinitionSchema>;
export const assistantMailMethodVersionSchema = z.object({
  id: uuidSchema, definition: assistantMailMethodDefinitionSchema,
  createdAt: dateTimeSchema, verifiedAt: dateTimeSchema.optional(),
}).strict();
export type AssistantMailMethodVersion = z.infer<typeof assistantMailMethodVersionSchema>;
const counter = z.number().int().nonnegative().max(1_000_000);
export const assistantMailMethodMeasurementSchema = z.object({
  at: dateTimeSchema, status: z.enum(['verified', 'partial', 'failed', 'waiting']),
  mode: z.enum(['learning', 'method']), preparationCalls: counter, preparationMs: counter,
  folders: counter, reviewedThreads: counter,
  inputTokens: counter.optional(), outputTokens: counter.optional(), costEur: z.number().nonnegative().optional(),
  reason: z.enum(['coverage', 'preparation', 'expansion-not-observed', 'effect', 'stale']).optional(),
}).strict();
export type AssistantMailMethodMeasurement = z.infer<typeof assistantMailMethodMeasurementSchema>;
export const assistantMailMethodRecordSchema = z.object({
  accountId: z.string().regex(/^[a-z0-9-]{1,60}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  revision: counter, active: assistantMailMethodVersionSchema.optional(), candidate: assistantMailMethodVersionSchema.optional(),
  history: z.array(assistantMailMethodMeasurementSchema).max(8),
}).strict();
export type AssistantMailMethodRecord = z.infer<typeof assistantMailMethodRecordSchema>;
export const assistantMailMethodViewSchema = assistantMailMethodRecordSchema.omit({ fingerprint: true });
export type AssistantMailMethodView = z.infer<typeof assistantMailMethodViewSchema>;
export interface AssistantMailMethodSelection {
  accountId: string; fingerprint: string; revision: number;
  method?: AssistantMailMethodVersion; active?: AssistantMailMethodVersion;
}
export const assistantMailMethodReportSchema = z.object({
  accountId: z.string().regex(/^[a-z0-9-]{1,60}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), revision: counter,
  definition: assistantMailMethodDefinitionSchema, usedId: uuidSchema.optional(),
  validated: z.boolean(), measurement: assistantMailMethodMeasurementSchema,
}).strict();
export type AssistantMailMethodReport = z.infer<typeof assistantMailMethodReportSchema>;
export const assistantMailMethodRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), accountId: z.string().max(60), revision: counter, definition: assistantMailMethodDefinitionSchema }).strict(),
  z.object({ action: z.literal('forget'), accountId: z.string().max(60), revision: counter }).strict(),
  z.object({ action: z.literal('learn'), accountId: z.string().max(60).optional() }).strict(),
  z.object({ action: z.literal('test'), accountId: z.string().max(60) }).strict(),
]);
export type AssistantMailMethodRequest = z.infer<typeof assistantMailMethodRequestSchema>;

/** Compile only observed successful order/expansion behavior; no browser arguments enter the definition. */
export function compileAssistantMailMethod(order: AssistantMailMethodStep[], expandThreads: boolean): AssistantMailMethodDefinition | undefined {
  const middle = [...new Set(order.filter(step => step === 'read-incoming' || step === 'read-sent'))];
  if (middle.length !== 2) return undefined;
  return assistantMailMethodDefinitionSchema.parse({ steps: ['verify-account', ...middle, 'return-inbox'], expandThreads });
}
