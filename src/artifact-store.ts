// Persist binary artifacts without changing direct or workflow result envelopes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GIF_DIR, PDF_DIR } from "./config-dir";

// Saved pages and recordings can show private content, so on POSIX a directory
// created here is owner-only and every file is 0600. An existing directory, also
// a symlinked one, is the user's choice: mkdir leaves it and its mode as they are.
function saveBinary(dir: string, prefix: string, ext: string, base64: string): { path: string; bytes: number } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${prefix}-${randomUUID()}.${ext}`);
  const buf = Buffer.from(base64, "base64");
  writeFileSync(path, buf, { mode: 0o600, flag: "wx" });
  return { path, bytes: buf.length };
}

/** print_to_pdf: persist the extension's base64 PDF under the pdfs/ store. */
export function savePdf(base64: string): { ok: true; path: string; bytes: number } {
  return { ok: true, ...saveBinary(PDF_DIR, "doc", "pdf", base64) };
}

/** gif_creator export: persist the encoded GIF under the gifs/ store. */
export function saveGif(base64: string, frames?: number): { ok: true; path: string; frames?: number; bytes: number } {
  const saved = saveBinary(GIF_DIR, "recording", "gif", base64);
  return { ok: true, path: saved.path, frames, bytes: saved.bytes };
}
