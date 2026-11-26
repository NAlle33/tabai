import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicPrivateFile, isMissing, privateDirectory, readPrivateFile, withStoreLock } from "./private-storage";

import type { RunRecord, RunStatus } from "../shared/run-record";
export type { RunRecord } from "../shared/run-record";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_RECORDS = 1000;

function runId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid run ID: expected a lowercase UUID");
}

function boundedCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECORDS) throw new Error(`History limit must be between 1 and ${MAX_RECORDS}`);
}

function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid run metadata fields");
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error("Invalid run metadata number");
}

function duration(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid run duration");
}

function status(value: unknown): asserts value is RunStatus {
  if (value !== "succeeded" && value !== "failed" && value !== "cancelled") throw new Error("Invalid run status");
}

function classification(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value))) {
    throw new Error("Run errors and stages must be bounded classification codes, not page data");
  }
}

function validateRecord(value: unknown): RunRecord {
  object(value, ["runId", "startedAt", "durationMs", "status", "totalSteps", "completedSteps", "failedStep", "steps", "screenshot"]);
  runId(value.runId);
  if (typeof value.startedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt)
    || !Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt) throw new Error("Invalid run timestamp");
  duration(value.durationMs);
  status(value.status);
  integer(value.totalSteps, 1000);
  integer(value.completedSteps, value.totalSteps);
  if (value.failedStep !== undefined) {
    integer(value.failedStep, value.totalSteps);
    if (value.failedStep < 1) throw new Error("Run step indices start at 1");
  }
  if (value.screenshot !== undefined && typeof value.screenshot !== "boolean") throw new Error("Invalid screenshot flag");
  if (!Array.isArray(value.steps) || value.steps.length > value.totalSteps) throw new Error("Invalid run steps");
  const indices = new Set<number>();
  for (const step of value.steps) {
    object(step, ["index", "tool", "status", "durationMs", "stage", "error", "incidentId"]);
    integer(step.index, value.totalSteps);
    if (step.index < 1) throw new Error("Run step indices start at 1");
    if (indices.has(step.index)) throw new Error("Duplicate run step index");
    indices.add(step.index);
    if (typeof step.tool !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(step.tool)) throw new Error("Invalid run tool name");
    status(step.status);
    duration(step.durationMs);
    classification(step.stage);
    classification(step.error);
    if (step.incidentId !== undefined) runId(step.incidentId);
  }
  return value as unknown as RunRecord;
}

function pngBytes(base64: string): Buffer {
  if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_PNG_BYTES / 3) * 4
    || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid or oversized PNG encoding");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new Error("Invalid PNG encoding");
  validatePng(bytes);
  return bytes;
}

function validatePng(bytes: Buffer): void {
  if (bytes.length < 45 || bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(PNG_HEADER)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0
    || bytes.readUInt32BE(bytes.length - 12) !== 0 || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") {
    throw new Error("Invalid or oversized PNG");
  }
}

function diagnose(file: string): void {
  // Never echo JSON, raw exceptions, or page-derived data to diagnostics.
  console.error(`[Tabai history] Skipping unreadable or invalid run file: ${file}`);
}

export class RunHistory {
  private readonly dir: string;
  constructor(dir: string, private readonly limit = 100) {
    boundedCount(limit);
    this.dir = resolve(dir);
  }

  private read(id: string): RunRecord {
    runId(id);
    const bytes = readPrivateFile(join(this.dir, `${id}.json`), MAX_RECORD_BYTES);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch {
      throw new Error(`Invalid run metadata JSON: ${id}`);
    }
    const record = validateRecord(value);
    if (record.runId !== id) throw new Error("Run metadata ID does not match its filename");
    return record;
  }

  private files(): Array<{ id: string; modified: number }> {
    const files: Array<{ id: string; modified: number }> = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || !UUID.test(file.slice(0, -5))) continue;
      try {
        const stat = lstatSync(join(this.dir, file));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { diagnose(file); continue; }
        files.push({ id: file.slice(0, -5), modified: stat.mtimeMs });
      } catch (error) { if (!isMissing(error)) diagnose(file); }
    }
    return files.sort((a, b) => b.modified - a.modified || b.id.localeCompare(a.id));
  }

  private remove(file: string): void {
    try {
      const path = join(this.dir, file);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Refusing unsafe history cleanup path");
      unlinkSync(path);
    } catch (error) { if (!isMissing(error)) throw error; }
  }

  private prune(): void {
    for (const file of this.files().slice(this.limit)) {
      // Metadata disappears first so a reader never sees a retained record
      // whose image was deliberately removed by retention.
      this.remove(`${file.id}.json`);
      this.remove(`${file.id}.png`);
    }
    // A crash between PNG publication and metadata publication leaves an
    // orphan. Saves/retention share a lock, so no writer owns an orphan here.
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".png") || !UUID.test(file.slice(0, -4))) continue;
      try { lstatSync(join(this.dir, `${file.slice(0, -4)}.json`)); } catch (error) {
        if (!isMissing(error)) throw error;
        this.remove(file);
      }
    }
  }

  async save(record: RunRecord, pngBase64?: string): Promise<void> {
    // Copy before the await: the caller cannot change paths/metadata mid-save.
    validateRecord(record);
    const png = pngBase64 === undefined ? undefined : pngBytes(pngBase64);
    if (png && record.status !== "failed") throw new Error("Screenshots may only be saved for failed runs");
    if (record.screenshot && !png) throw new Error("Screenshot metadata requires PNG bytes");
    const serialized = JSON.stringify({ ...record, screenshot: !!png });
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error("Run metadata exceeds its size limit");
    const stored = validateRecord(JSON.parse(serialized));
    privateDirectory(this.dir);
    await withStoreLock(join(this.dir, ".history"), () => {
      const jsonFile = join(this.dir, `${stored.runId}.json`);
      try {
        lstatSync(jsonFile);
        throw new Error("Run ID is already stored");
      } catch (error) { if (!isMissing(error)) throw error; }
      const pngFile = join(this.dir, `${stored.runId}.png`);
      if (png) atomicPrivateFile(pngFile, png);
      try { atomicPrivateFile(jsonFile, serialized); } catch (error) {
        // A durability error can occur after rename committed the metadata.
        // Preserve its PNG whenever publication may already have succeeded.
        if (png) {
          try { lstatSync(jsonFile); } catch (readError) {
            if (isMissing(readError)) this.remove(`${stored.runId}.png`);
          }
        }
        throw error;
      }
      this.prune();
    });
  }

  list(limit = 20): RunRecord[] {
    boundedCount(limit);
    if (!privateDirectory(this.dir, false)) return [];
    const records: RunRecord[] = [];
    for (const file of this.files()) {
      try { records.push(this.read(file.id)); } catch (error) {
        // Concurrent retention can remove a listed record; corrupt records are
        // diagnosed and skipped instead of hiding all otherwise valid runs.
        if (!isMissing(error)) diagnose(`${file.id}.json`);
      }
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId)).slice(0, limit);
  }

  get(id: string): { record: RunRecord; pngBase64?: string } {
    runId(id);
    if (!privateDirectory(this.dir, false)) throw new Error("Run history does not exist");
    const record = this.read(id);
    if (!record.screenshot) return { record };
    const png = readPrivateFile(join(this.dir, `${id}.png`), MAX_PNG_BYTES);
    validatePng(png);
    return { record, pngBase64: png.toString("base64") };
  }
}
