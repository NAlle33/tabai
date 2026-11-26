import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as z from "zod";
import { dateTimeSchema, uuidSchema } from "../shared/stable-schemas";
import { MetadataStore } from "./metadata-store";

const MAX_CHECKPOINTS = 100;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const checkpoint = z.object({
  resumeId: uuidSchema, name: z.string().min(1).max(120), fingerprint: digest,
  createdAt: dateTimeSchema, updatedAt: dateTimeSchema, cursor: z.number().int().min(0).max(50),
  totalSteps: z.number().int().min(1).max(50), urlHash: digest.optional(),
  phase: z.enum(["new", "dispatching", "verified", "unverified", "complete"]),
  owner: z.object({ pid: z.number().int().positive(), host: z.string().max(255), token: uuidSchema }).strict().optional(),
}).strict();
export type RecipeCheckpoint = z.infer<typeof checkpoint>;
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type CheckpointOwner = NonNullable<RecipeCheckpoint["owner"]>;

function currentOwner(): CheckpointOwner {
  return { pid: process.pid, host: hostname(), token: randomUUID() };
}

function ownerIsAlive(owner: CheckpointOwner): boolean {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class RecipeCheckpoints {
  private readonly store: MetadataStore<RecipeCheckpoint>;

  constructor(dir: string) {
    this.store = new MetadataStore(dir, "recipe-checkpoints", checkpoint, MAX_CHECKPOINTS);
  }

  list() {
    return this.store.read().map(record => ({
      resumeId: record.resumeId, name: record.name, completedSteps: record.cursor,
      totalSteps: record.totalSteps, updatedAt: record.updatedAt, phase: record.phase,
      resumable: record.phase === "verified" && record.cursor > 0 && record.cursor < record.totalSteps && !!record.urlHash && (!record.owner || !ownerIsAlive(record.owner)),
    }));
  }

  get(resumeId: string) {
    uuidSchema.parse(resumeId);
    const record = this.store.read().find(item => item.resumeId === resumeId);
    if (!record) throw new Error("Checkpoint not found");
    return record;
  }

  async create(name: string, hash: string, totalSteps: number) {
    const record = checkpoint.parse({
      resumeId: randomUUID(), name, fingerprint: hash, totalSteps, cursor: 0,
      phase: "new", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      owner: currentOwner(),
    });
    await this.store.update(records => {
      if (records.length >= MAX_CHECKPOINTS) {
        // A completed run, or a `new` record that no live process owns, carries
        // nothing to resume or review: phase `new` proves nothing was dispatched.
        // A `new` record whose owner still runs belongs to a run that is starting.
        const evictable = records.findIndex(item => item.phase === "complete" ||
          (item.phase === "new" && (!item.owner || !ownerIsAlive(item.owner))));
        if (evictable < 0) throw new Error("Checkpoint capacity reached; preserve unresolved runs for manual review");
        records.splice(evictable, 1);
      }
      records.push(record);
    });
    return record;
  }

  async claim(resumeId: string, hash: string) {
    return this.store.update(records => {
      const record = records.find(item => item.resumeId === resumeId);
      if (!record || record.fingerprint !== hash) throw new Error("Recipe or parameters changed; checkpoint cannot be resumed");
      if (record.owner && ownerIsAlive(record.owner)) throw new Error("Checkpoint is owned by a running process");
      if (record.phase !== "verified" || !record.cursor || !record.urlHash || record.cursor >= record.totalSteps)
        throw new Error("No safe checkpoint: an action may already have executed. Inspect the page; never retry that action automatically");
      record.owner = currentOwner();
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    });
  }

  /** Resolves true when the release removed the record. */
  async change(record: RecipeCheckpoint, fields: Partial<Pick<RecipeCheckpoint, "phase" | "cursor" | "urlHash">>, release = false): Promise<boolean> {
    return this.store.update(records => {
      const index = records.findIndex(item => item.resumeId === record.resumeId);
      const current = records[index];
      if (!current?.owner || current.owner.token !== record.owner?.token) throw new Error("Checkpoint ownership changed; action blocked");
      // Releasing a record still in phase `new` ends a run that dispatched
      // nothing: it holds neither a resume point nor an action to review.
      if (release && current.phase === "new") { records.splice(index, 1); return true; }
      Object.assign(current, fields, { updatedAt: new Date().toISOString() });
      if (release) delete current.owner;
      return false;
    });
  }
}
