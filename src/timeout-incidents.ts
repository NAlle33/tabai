import { randomUUID } from "node:crypto";
import * as z from "zod";
import { dateTimeSchema, uuidSchema } from "../shared/stable-schemas";
import { BUILD_ID } from "../shared/build-info";
import { DIAGNOSTIC_OPERATIONS } from "../shared/diagnostics";
import { EXTENSION_TOOLS } from "../shared/tool-names";
import { MetadataStore } from "./metadata-store";

const MAX_INCIDENTS = 50;
const MAX_CONCURRENT_CAPTURES = 4;
const number = z.number().finite().nonnegative();
const buildId = z.string().regex(/^(?:sha256:[a-f0-9]{64}|unbundled)$/);
function loadedBuild(value: unknown): string | undefined {
  const parsed = buildId.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
const entry = z.object({
  id: number, operation: z.enum(DIAGNOSTIC_OPERATIONS), tabId: number.optional(), startedAt: number, durationMs: number,
  status: z.enum(["pending", "overdue", "succeeded", "failed"]),
  errorCode: z.enum(["NO_SESSION", "TAB_NOT_IN_GROUP", "TAB_NOT_FOUND", "NO_EXTENSION", "TIMEOUT", "SESSION_BUSY", "QUEUE_FULL", "NO_BRIDGE", "SW_ERROR", "TOOL_ERROR"]).optional(),
});
// Object schemas strip all unrecognized fields at the persistence boundary.
const snapshot = z.object({ active: z.array(entry).max(96), recent: z.array(entry).max(20), dropped: number, degraded: z.boolean() });
const incident = z.object({
  incidentId: uuidSchema, capturedAt: dateTimeSchema, tool: z.enum(EXTENSION_TOOLS),
  durationMs: number, timeoutMs: number, serverBuildId: buildId, brokerBuildId: buildId.optional(), extensionBuildId: buildId.optional(),
  diagnosticsAvailable: z.boolean(), operations: snapshot.optional(),
});
export type TimeoutIncident = z.infer<typeof incident>;

export class TimeoutIncidents {
  private readonly store: MetadataStore<TimeoutIncident>;
  private collecting = 0;

  constructor(dir: string) {
    this.store = new MetadataStore(dir, "timeout-incidents", incident, MAX_INCIDENTS);
  }

  list(limit = 20) { return this.store.read().slice(0, limit); }

  get(id: string) {
    uuidSchema.parse(id);
    const found = this.store.read().find(record => record.incidentId === id);
    if (!found) throw new Error("No timeout incident with that ID");
    return found;
  }
  /** One bounded read-only health probe; never retry the action or log its data.
   * Awaited before reporting the original timeout so evidence survives a reload. */
  async capture(tool: string, durationMs: number, timeoutMs: number, brokerBuildId: string | undefined, health: () => Promise<unknown>): Promise<string | undefined> {
    if (!(EXTENSION_TOOLS as readonly string[]).includes(tool)) return undefined;
    const probe = this.collecting < MAX_CONCURRENT_CAPTURES;
    if (probe) this.collecting++;
    try {
      let extension: { buildId?: unknown; diagnostics?: unknown } | undefined;
      try { if (probe) extension = await health() as typeof extension; } catch { /* unavailable is evidence too */ }
      const parsed = snapshot.safeParse(extension?.diagnostics);
      const record = incident.parse({
        incidentId: randomUUID(), capturedAt: new Date().toISOString(), tool,
        durationMs, timeoutMs, serverBuildId: BUILD_ID, brokerBuildId: loadedBuild(brokerBuildId),
        extensionBuildId: loadedBuild(extension?.buildId),
        diagnosticsAvailable: parsed.success, ...(parsed.success ? { operations: parsed.data } : {}),
      });
      await this.store.update(records => {
        records.unshift(record);
        records.splice(MAX_INCIDENTS);
      });
      return record.incidentId;
    } finally {
      if (probe) this.collecting--;
    }
  }
}
