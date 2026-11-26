import * as z from 'zod';
import { dateTimeSchema, uuidSchema } from './stable-schemas';

export const assistantSearchResultSchema = z.object({
  kind: z.enum(['chat', 'mail', 'case', 'attachment']), id: z.string().min(1).max(100),
  conversationId: uuidSchema.optional(), messageId: uuidSchema.optional(),
  title: z.string().max(300), date: dateTimeSchema, snippet: z.string().max(360),
}).strict();
export type AssistantSearchResult = z.infer<typeof assistantSearchResultSchema>;
export const assistantSearchViewSchema = z.object({
  query: z.string().max(200), results: z.array(assistantSearchResultSchema).max(100),
  scanned: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string().max(300)).max(8),
}).strict();
export type AssistantSearchView = z.infer<typeof assistantSearchViewSchema>;
