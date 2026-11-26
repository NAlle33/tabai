// Private Node file operations; locking covers the complete storage transaction.
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 3_000;
const WINDOWS_RENAME_RETRIES = 40;
const WINDOWS_RENAME_DELAY_MS = 25;
const WINDOWS_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RENAME_WAIT = new Int32Array(new SharedArrayBuffer(4));

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Reject a link at the storage boundary; do not chmod its target. */
export function privateDirectory(dir: string, create = true): boolean {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!create) return false;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Storage directory is not a real directory: ${dir}`);
  // Windows does not support opening directories for chmod; it inherits the
  // user's profile directory ACL instead of POSIX permission bits.
  if (process.platform !== "win32") {
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  }
  return true;
}

function regularFile(path: string, allowLinks = false): void {
  try {
    const stat = lstatSync(path);
    // Concurrent atomic replacement can unlink the inode while lstat reads it.
    // Zero links is a retired snapshot; only extra hard links are unsafe.
    if (!stat.isFile() || stat.isSymbolicLink() || (!allowLinks && stat.nlink > 1)) {
      throw new Error(`Storage path is not a private regular file: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Size and file-kind checks happen before allocating or following a file. */
export function readPrivateFile(path: string, maxBytes: number, allowLinks = false): Buffer {
  regularFile(path, allowLinks);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    // An atomic replacement may unlink an already-open reader's old inode.
    // nlink=0 is still its complete snapshot; extra hard links are refused.
    if (!stat.isFile() || (!allowLinks && stat.nlink > 1)) throw new Error(`Storage path is not a private regular file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`Storage file exceeds ${maxBytes} bytes: ${path}`);
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) throw new Error(`Storage file exceeds ${maxBytes} bytes: ${path}`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function atomicPrivateFile(path: string, bytes: string | Buffer): void {
  regularFile(path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt++) {
      regularFile(path);
      try {
        renameSync(tmp, path);
        break;
      } catch (error) {
        // Windows readers and scanners can briefly prevent atomic replacement.
        // Keep the old file and the exclusive temp file intact; never unlink the destination.
        const code = (error as NodeJS.ErrnoException).code;
        const retryable = process.platform === "win32"
          && WINDOWS_RENAME_ERRORS.has(code ?? "")
          && attempt < WINDOWS_RENAME_RETRIES;
        if (!retryable) throw error;
        Atomics.wait(WINDOWS_RENAME_WAIT, 0, 0, WINDOWS_RENAME_DELAY_MS);
      }
    }
    if (process.platform !== "win32") {
      const dirFd = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

type LockOwner = { pid: number; host: string; nonce: string };

function lockOwner(path: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(readPrivateFile(path, 4096, true).toString("utf8"));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== hostname()
      || typeof owner.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(owner.nonce)) return undefined;
    return owner;
  } catch {
    // An incomplete, foreign-host, symlinked, or unreadable lock is ambiguous.
    return undefined;
  }
}

function isDead(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM and all other errors cannot prove that the owner has died.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function recoverDeadLock(path: string): void {
  const owner = lockOwner(path);
  if (!owner || !isDead(owner)) return;
  // Reapers must serialize too: an unchecked unlink by a second reaper could
  // otherwise remove a new live writer's lock after the first reaper freed it.
  const recovery = `${path}.recovery`;
  try { mkdirSync(recovery, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    const current = lockOwner(path);
    if (current?.nonce === owner.nonce && isDead(current)) unlinkSync(path);
  } finally {
    rmdirSync(recovery);
  }
}

/** A leftover recovery guard is ambiguous and fails closed for manual review. */
export async function withStoreLock<T>(file: string, operation: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const candidate = `${lock}.${randomUUID()}.tmp`;
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomUUID() };
  const deadline = performance.now() + LOCK_WAIT_MS;
  let acquired = false;
  const fd = openSync(candidate, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    while (!acquired) {
      try {
        // Hard-link publication makes the complete owner record visible in one
        // operation; no writer can observe a partially initialized lock.
        linkSync(candidate, lock);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        recoverDeadLock(lock);
        if (performance.now() >= deadline) {
          throw new Error(`Storage is locked: ${lock}. The owner is alive or cannot be verified; inspect the lock and any .recovery directory before retrying.`);
        }
        await delay(25);
      }
    }
    unlinkSync(candidate);
    return operation();
  } finally {
    try { unlinkSync(candidate); } catch (error) { if (!isMissing(error)) throw error; }
    if (acquired) {
      if (lockOwner(lock)?.nonce !== owner.nonce) throw new Error(`Storage lock ownership changed: ${lock}`);
      unlinkSync(lock);
    }
  }
}
