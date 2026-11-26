// Portable run metadata shared by persistence and the browser panel.
export type RunStatus = "succeeded" | "failed" | "cancelled";
export interface RunRecord {
  runId: string;
  startedAt: string;
  durationMs: number;
  status: RunStatus;
  totalSteps: number;
  completedSteps: number;
  failedStep?: number;
  steps: RunStep[];
  screenshot?: boolean;
}

export interface RunStep { index: number; tool: string; status: RunStatus; durationMs: number; stage?: string; error?: string; incidentId?: string }
