import * as z from "zod";
import { uuidSchema } from "./stable-schemas";
import { scalarSchema, type Parameters } from "./workflow-schema";
import type { RunRecord } from "./run-record";
import { moduleIdSchema, moduleInputSchema, moduleOperationSchema } from "./personal-modules";
import type { PanelDiagnostics } from "./diagnostics";
import { PANEL_IMAGE_MAX_CHARS } from "./panel-image";
import { recordingSaveSchema, type RecordingStatus } from './recipe-recording';

// Optional protocol-v1 capability. Old peers still execute their existing tools.
export const PANEL_VERSION = 1;
export const PANEL_TIMEOUT_MS = 10_000;
export const PANEL_MAX_REQUEST_BYTES = 512 * 1024;
export const PANEL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const sessionId = z.string().regex(/^[0-9a-f]{16}$/);
export const panelCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sessions") }).strict(),
  z.object({ action: z.literal("modules") }).strict(),
  z.object({ action: z.literal("module"), moduleId: moduleIdSchema, operation: moduleOperationSchema, input: moduleInputSchema.default({}) }).strict(),
  z.object({ action: z.literal("snapshot"), sessionId }).strict(),
  z.object({ action: z.literal("recipes"), sessionId }).strict(),
  z.object({ action: z.literal('recording-start'), sessionId, tabId: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('recording-draft'), sessionId }).strict(),
  z.object({ action: z.literal('recording-stop'), sessionId, recordingId: uuidSchema }).strict(),
  z.object({ action: z.literal('recording-discard'), sessionId, recordingId: uuidSchema }).strict(),
  z.object({ action: z.literal('recording-save'), sessionId, review: recordingSaveSchema }).strict(),
  z.object({ action: z.literal("history"), sessionId }).strict(),
  z.object({ action: z.literal("history-image"), sessionId, runId: uuidSchema, offset: z.number().int().min(0).max(PANEL_IMAGE_MAX_CHARS) }).strict(),
  z.object({ action: z.literal("incident"), sessionId, incidentId: uuidSchema }).strict(),
  z.object({ action: z.literal("continue-loop"), sessionId, tabId: z.number().int().nonnegative(), pauseId: uuidSchema }).strict(),
  z.object({ action: z.literal("stop"), sessionId, runId: uuidSchema }).strict(),
  z.object({
    action: z.literal("start"), sessionId, name: z.string().min(1).max(120),
    tabId: z.number().int().nonnegative(), parameters: z.record(z.string(), scalarSchema).default({}),
    resumable: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("resume"), sessionId, name: z.string().min(1).max(120), resumeId: uuidSchema,
    tabId: z.number().int().nonnegative(), parameters: z.record(z.string(), scalarSchema).default({}),
  }).strict(),
]);
export type PanelCommand = z.infer<typeof panelCommandSchema>;
export interface PanelSession { sessionId: string; sessionName?: string; supported: boolean; version: string }
export interface PanelRecipe { name: string; steps: number; description?: string; parameters: Parameters }
export interface PanelCall { id: string; tool: string; tabId?: number; startedAt: number; error?: string }
export interface PanelRun {
  runId: string;
  name: string;
  status: "running" | "stopping" | RunRecord["status"];
  startedAt: string;
  durationMs: number;
  totalSteps: number;
  completedSteps: number;
  currentStep: number;
  tool?: string;
  tabId?: number;
  stage: string;
  steps: RunRecord["steps"];
  failedStep?: number;
  historySaved?: boolean;
}
export interface PanelCheckpoint { resumeId: string; name: string; completedSteps: number; totalSteps: number; updatedAt: string; phase: string; resumable: boolean }
export interface PanelLoopPause { pauseId: string; tabId: number; tool: string; repetitions: number; pausedAt: string }
/** A private helper store that could not be read; its list in the snapshot is empty. */
export type PanelStore = "checkpoints" | "incidents";
export interface PanelSnapshot { runs: PanelRun[]; calls: PanelCall[]; lastError?: PanelCall; diagnostics?: PanelDiagnostics; checkpoints?: PanelCheckpoint[]; incidents?: Array<{ incidentId: string; capturedAt: string; tool: string; diagnosticsAvailable: boolean }>; loopPauses?: PanelLoopPause[]; debugging?: true; recording?: RecordingStatus; storeErrors?: PanelStore[] }
export type PanelReply = { ok: true; result: unknown } | { ok: false; error: string };
export interface PanelImageChunk { mimeType: "image/png"; offset: number; total: number; base64: string }

export function parsePanelCommand(value: unknown): PanelCommand {
  if (new TextEncoder().encode(JSON.stringify(value)).length > PANEL_MAX_REQUEST_BYTES) throw new Error("Panel request is too large");
  return panelCommandSchema.parse(value);
}
