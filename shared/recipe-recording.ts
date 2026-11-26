import * as z from 'zod';
import { uuidSchema } from './stable-schemas';
import { expectationSchema, targetSchema, type Action, type Recipe } from './workflow-schema';

export const RECORDING_MAX_STEPS = 50;
export const recordingReviewStepSchema = z.object({
  id: uuidSchema,
  target: targetSchema.optional(),
  expect: expectationSchema,
  parameter: z.object({ enabled: z.boolean(), name: z.string().max(120) }).strict().optional(),
}).strict();
export const recordingSaveSchema = z.object({
  recordingId: uuidSchema, revision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(),
  steps: z.array(recordingReviewStepSchema).min(1).max(RECORDING_MAX_STEPS),
}).strict();
export type RecordingSave = z.infer<typeof recordingSaveSchema>;
export interface RecordingStatus {
  state: 'idle' | 'recording' | 'stopping' | 'review' | 'blocked' | 'saving' | 'saved';
  revision: number; steps: number; pending: number;
  recordingId?: string; tabId?: number; issue?: string; savedName?: string;
}
export interface RecordingStep {
  id: string; title: string; action: Action;
  input?: { key: 'value' | 'url'; type: 'string' | 'number' | 'boolean'; sensitive: boolean; parameterName: string };
  checkSource: 'suggested' | 'declared' | 'required';
}
export interface RecordingDraft extends RecordingStatus { entries: RecordingStep[] }
/** A value-free description, derived in the extension's isolated world. */
export interface RecordingTarget {
  target?: z.infer<typeof targetSchema>;
  fieldSelector?: string;
  sensitive: boolean;
  fieldType?: 'string' | 'boolean' | 'selection';
  role: string; name: string;
}
export interface RecordingStore { update(name: string, change: (current: Recipe | undefined) => Recipe): Promise<Recipe> }
