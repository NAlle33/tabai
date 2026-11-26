// Recipe validation and backed-up atomic persistence.
import { dirname, resolve } from "node:path";
import { atomicPrivateFile, isMissing, privateDirectory, readPrivateFile, withStoreLock } from "./private-storage";

const MAX_STORE_BYTES = 8 * 1024 * 1024;
const BAD_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "invalid data";
}

function checkName(name: string): void {
  if (typeof name !== "string" || name.length < 1 || name.length > 200
    || name !== name.trim() || /[\x00-\x1f\x7f/\\]/.test(name) || BAD_NAMES.has(name)
    || name === "." || name === "..") throw new Error("Invalid recipe name");
}

export class RecipeStore<T> {
  private readonly file: string;
  constructor(file: string, private readonly validate: (value: unknown) => T) {
    this.file = resolve(file);
  }

  private parse(bytes: Buffer): Record<string, T> {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch {
      throw new Error(`Recipe store contains invalid JSON; original file preserved: ${this.file}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Recipe store must be an object; original file preserved: ${this.file}`);
    }
    const recipes: Record<string, T> = Object.create(null);
    for (const [name, value] of Object.entries(parsed)) {
      try { checkName(name); recipes[name] = this.validate(value); } catch {
        // Validator messages may quote a secret stored in a recipe's args.
        throw new Error(`Recipe store contains an invalid entry; original file preserved: ${this.file}`);
      }
    }
    return recipes;
  }

  private read(): { entries: Record<string, T>; bytes?: Buffer } {
    let bytes: Buffer;
    try { bytes = readPrivateFile(this.file, MAX_STORE_BYTES); } catch (error) {
      if (isMissing(error)) return { entries: Object.create(null) };
      throw new Error(`Cannot read recipe store (${codeOf(error)}); original file preserved: ${this.file}`, { cause: error });
    }
    return { entries: this.parse(bytes), bytes };
  }

  load(): Record<string, T> {
    if (!privateDirectory(dirname(this.file), false)) return Object.create(null);
    return this.read().entries;
  }

  async save(name: string, value: T): Promise<void> {
    checkName(name);
    // Detach caller-owned values before awaiting the lock, then validate the
    // serialized representation that readers will actually receive.
    const replacement = JSON.stringify(this.validate(value));
    if (typeof replacement !== "string" || Buffer.byteLength(replacement) > MAX_STORE_BYTES) throw new Error("Recipe is too large or not JSON serializable");
    const entry = this.validate(JSON.parse(replacement));
    await this.update(name, () => entry);
  }

  /** Read/check/write under one process-safe lock, including optimistic revision checks. */
  async update(name: string, change: (current: T | undefined) => T): Promise<T> {
    checkName(name);
    privateDirectory(dirname(this.file));
    return await withStoreLock(this.file, () => {
      const { entries, bytes } = this.read();
      const next = this.validate(change(entries[name] === undefined ? undefined : structuredClone(entries[name])));
      const replacement = JSON.stringify(next);
      if (typeof replacement !== 'string' || Buffer.byteLength(replacement) > MAX_STORE_BYTES) throw new Error('Recipe is too large or not JSON serializable');
      entries[name] = this.validate(JSON.parse(replacement));
      const serialized = JSON.stringify(entries, null, 2);
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Recipe store exceeds its size limit; original file preserved");
      this.parse(Buffer.from(serialized));
      if (bytes) atomicPrivateFile(`${this.file}.bak`, bytes);
      atomicPrivateFile(this.file, serialized);
      return structuredClone(entries[name]);
    });
  }
}
