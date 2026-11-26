/** Metadata only. Never add arguments, URLs, page output or raw error text. */
export const DIAGNOSTIC_OPERATIONS = [
  "tool.execute", "ownership.check", "storage.local.get", "storage.local.set", "storage.local.remove",
  "tabGroups.get", "tabGroups.query", "tabGroups.update", "tabs.get", "tabs.query", "tabs.group", "tabs.update",
  "tabs.remove", "tabs.create", "windows.get", "windows.create", "windows.update", "scripting.executeScript",
  "debugger.attach", "debugger.getTargets", "debugger.sendCommand", "presence.render", "presence.logo",
  "capture.hide", "group.appearance",
] as const;
export type DiagnosticOperation = typeof DIAGNOSTIC_OPERATIONS[number];
export interface DiagnosticEntry {
  id: number;
  operation: DiagnosticOperation;
  tabId?: number;
  startedAt: number;
  durationMs: number;
  status: "pending" | "overdue" | "succeeded" | "failed";
  errorCode?: string;
}
export interface DiagnosticSnapshot {
  active: DiagnosticEntry[];
  recent: DiagnosticEntry[];
  dropped: number;
  degraded: boolean;
}
export interface PanelDiagnostics {
  serverBuildId: string;
  extensionBuildId?: string;
  brokerBuildId?: string;
  refresh?: Array<"broker" | "extension">;
  buildMismatch: boolean;
  available: boolean;
  operations?: DiagnosticSnapshot;
}
