import * as z from 'zod';
import { dateTimeSchema } from './stable-schemas';

export const assistantBergetModelIds = [
  'zai-org/GLM-5.3-Flash',
  'google/gemma-4-31B-it',
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
] as const;
export const assistantBergetModelSchema = z.enum(assistantBergetModelIds);
export type AssistantBergetModel = z.infer<typeof assistantBergetModelSchema>;
export const assistantBergetSettingsSchema = z.object({ model: assistantBergetModelSchema }).strict();
export const assistantBergetDefaults = { model: assistantBergetModelIds[0] };
export const assistantBergetModelInfo: Record<AssistantBergetModel, { label: string; role: string; contextBytes: number }> = {
  'zai-org/GLM-5.3-Flash': { label: 'GLM-5.3-Flash', role: 'Förstakandidat för agentuppdrag', contextBytes: 220_000 },
  'google/gemma-4-31B-it': { label: 'Gemma 4 31B', role: 'Alternativ för samtal och uppdrag', contextBytes: 220_000 },
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506': { label: 'Mistral Small 3.2', role: 'Alternativ för text och kortare uppdrag', contextBytes: 60_000 },
};
export const assistantBergetStatusSchema = z.object({
  configured: z.boolean(),
  verifiedAt: dateTimeSchema.optional(),
  model: assistantBergetModelSchema.optional(),
  message: z.string().max(500),
}).strict();
export type AssistantBergetStatus = z.infer<typeof assistantBergetStatusSchema>;
