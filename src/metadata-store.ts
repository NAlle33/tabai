import { join } from "node:path";
import * as z from "zod";
import { atomicPrivateFile, isMissing, privateDirectory, readPrivateFile, withStoreLock } from "./private-storage";

const MAX_STORE_BYTES = 4 * 1024 * 1024;

/** Small private metadata collections. The lock covers read/validate/write;
 * corrupt or unsafe files fail closed and are never silently replaced. */
export class MetadataStore<T> {
  private readonly file: string;
  private readonly schema: z.ZodType<{ version: 1; records: T[] }>;

  constructor(private readonly dir: string, name: string, record: z.ZodType<T>, limit: number) {
    this.file = join(dir, `${name}.json`);
    this.schema = z.object({ version: z.literal(1), records: z.array(record).max(limit) }).strict() as typeof this.schema;
  }

  read(): T[] {
    if (!privateDirectory(this.dir, false)) return [];
    try {
      const bytes = readPrivateFile(this.file, MAX_STORE_BYTES);
      return this.schema.parse(JSON.parse(bytes.toString("utf8"))).records;
    } catch (error) {
      if (isMissing(error)) return [];
      throw new Error("Invalid or unreadable private metadata store");
    }
  }

  async update<R>(change: (records: T[]) => R): Promise<R> {
    privateDirectory(this.dir);
    return withStoreLock(this.file, () => {
      const records = this.read();
      const result = change(records);
      const bytes = JSON.stringify(this.schema.parse({ version: 1, records }));
      if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new Error("Metadata capacity exceeded");
      atomicPrivateFile(this.file, bytes);
      return result;
    });
  }
}
