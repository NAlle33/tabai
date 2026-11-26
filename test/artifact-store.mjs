// Saved PDFs and GIFs can show private page content: on POSIX a directory the
// store creates is owner-only (0700) and every saved file is 0600. A directory
// that already exists, also a symlinked one, is the user's choice and is left
// as it is.
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { watchdog } from "./watchdog.mjs";

if (process.platform === "win32") {
  console.log("=== artifact-store: POSIX modes only, skipped on Windows ===");
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "tabai-artifact-store-"));
const stopWatchdog = watchdog(() => rmSync(root, { recursive: true, force: true }));
try {
  // A permissive umask, so the default modes would show.
  process.umask(0o022);
  const store = join(root, "store");
  const shared = join(root, "shared-recordings");
  mkdirSync(store);
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  symlinkSync(shared, join(store, "gifs"));
  // The store location is read at import time.
  Object.assign(process.env, { HOME: root, USERPROFILE: root, CCMCP_CONFIG_DIR: store, CCMCP_LOG_DIR: join(root, "logs") });
  const { savePdf, saveGif } = await import("../dist/tool-orchestration.mjs");
  const mode = path => statSync(path).mode & 0o777;

  const pdf = savePdf(Buffer.from("%PDF-1.4 private page").toString("base64"));
  assert.equal(mode(join(store, "pdfs")), 0o700, "a created PDF directory is owner-only");
  assert.equal(mode(pdf.path), 0o600, "a saved PDF is owner-only");

  const gif = saveGif(Buffer.from("GIF89a private recording").toString("base64"), 2);
  assert.equal(mode(gif.path), 0o600, "a saved GIF is owner-only");
  assert.ok(lstatSync(join(store, "gifs")).isSymbolicLink(), "an existing symlinked directory stays a symlink");
  assert.equal(realpathSync(dirname(gif.path)), realpathSync(shared), "the GIF is saved through the existing symlink");
  assert.equal(mode(shared), 0o755, "an existing directory keeps its mode");
  console.log("=== artifact-store: private directories and files, existing directories untouched ===");
} finally {
  rmSync(root, { recursive: true, force: true });
}
stopWatchdog();
