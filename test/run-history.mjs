import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RunHistory } from "../dist/run-history.mjs";
import { watchdog } from "./watchdog.mjs";

const stopWatchdog = watchdog();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7wAAAABJRU5ErkJggg==";
const record = (offset = 0) => ({
  runId: randomUUID(), startedAt: new Date(Date.now() + offset).toISOString(), durationMs: 24,
  status: "failed", totalSteps: 2, completedSteps: 1, failedStep: 2,
  steps: [{ index: 1, tool: "navigate", status: "succeeded", durationMs: 10 },
    { index: 2, tool: "computer", status: "failed", durationMs: 14, stage: "dispatch", error: "dispatch.failed" }],
});
const [mode, path] = process.argv.slice(2);
if (mode === "--writer") {
  const history = new RunHistory(path, 3);
  process.send("ready");
  await once(process, "message");
  await history.save(record(), PNG);
  process.exit(0);
} else {
  const dir = mkdtempSync(join(tmpdir(), "tabai-run-history-"));
  const children = new Set();
  const timeout = setTimeout(() => { for (const child of children) child.kill(); process.exit(1); }, 30_000);
  try {
    const path = join(dir, "history");
    const history = new RunHistory(path, 2);
    assert.deepEqual(history.list(), []);
    const first = record();
    await history.save(first, PNG);
    const loaded = new RunHistory(path).get(first.runId);
    assert.deepEqual(loaded.record, { ...first, screenshot: true });
    assert.deepEqual(Buffer.from(loaded.pngBase64, "base64"), Buffer.from(PNG, "base64"));
    assert.ok(!readFileSync(join(path, `${first.runId}.json`), "utf8").includes(PNG));
    assert.equal(readFileSync(join(path, `${first.runId}.png`)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    if (process.platform !== "win32") {
      for (const file of readdirSync(path)) assert.equal(lstatSync(join(path, file)).mode & 0o777, 0o600);
      assert.equal(lstatSync(path).mode & 0o777, 0o700);
    }
    await assert.rejects(history.save(first, PNG), /already stored/);
    console.log("  ✓ restart-visible metadata and actual separate PNG bytes have private modes");

    const traces = new RunHistory(join(dir, "traces"));
    const succeeded = { ...record(), status: "succeeded", completedSteps: 2, failedStep: undefined };
    succeeded.steps = succeeded.steps.map(step => ({ ...step, status: "succeeded", error: undefined }));
    const cancelled = { ...record(), status: "cancelled", failedStep: undefined, steps: [succeeded.steps[0]] };
    await traces.save(succeeded);
    await traces.save(cancelled);
    assert.equal(traces.get(succeeded.runId).record.status, "succeeded");
    assert.equal(traces.get(cancelled.runId).record.status, "cancelled");
    assert.equal(traces.get(cancelled.runId).record.completedSteps, 1);
    assert.equal(traces.get(succeeded.runId).pngBase64, undefined);

    for (const id of ["../escape", "../../secret", first.runId.toUpperCase(), "bad", `${first.runId}.json`]) {
      assert.throws(() => history.get(id), /Invalid run ID/);
      await assert.rejects(history.save({ ...record(), runId: id }), /Invalid run ID/);
    }
    for (const bad of [0, -1, 1001, 1.5]) {
      assert.throws(() => new RunHistory(path, bad), /limit/);
      assert.throws(() => history.list(bad), /limit/);
    }
    await assert.rejects(history.save({ ...record(), args: { secret: "do-not-store" } }), /metadata fields/);
    await assert.rejects(history.save({ ...record(), steps: [{ index: 1, tool: "navigate", status: "failed", durationMs: 1, error: "page contained secret value" }] }), /classification/);
    await assert.rejects(history.save({ ...record(), screenshot: true }), /requires PNG/);
    await assert.rejects(history.save(record(), "bad!base64"), /PNG/);
    await assert.rejects(history.save(record(), Buffer.from("not a png").toString("base64")), /PNG/);
    await assert.rejects(history.save({ ...record(), status: "succeeded" }, PNG), /failed runs/);
    await assert.rejects(history.save({ ...record(), failedStep: 0 }), /start at 1/);
    await assert.rejects(history.save({ ...record(), failedStep: 3 }), /metadata number/);
    const oversized = { ...record(), totalSteps: 1000, steps: Array.from({ length: 1000 }, (_, index) => ({
      index: index + 1, tool: "a".repeat(100), status: "failed", durationMs: 1, stage: "a".repeat(100), error: "a".repeat(100),
    })) };
    await assert.rejects(history.save(oversized), /size limit/);
    await assert.rejects(history.save(record(), "A".repeat(14 * 1024 * 1024)), /oversized PNG/);
    assert.equal(history.list().length, 1);
    console.log("  ✓ UUID/path, count, metadata, classification and PNG constraints fail before writes");

    const second = record(1);
    await history.save(second);
    const third = record(2);
    await history.save(third, PNG);
    assert.equal(history.list().length, 2);
    assert.ok(!existsSync(join(path, `${first.runId}.json`)));
    assert.ok(!existsSync(join(path, `${first.runId}.png`)));
    const orphan = randomUUID();
    writeFileSync(join(path, `${orphan}.png`), Buffer.from(PNG, "base64"));
    writeFileSync(join(path, "not-a-run.png"), "leave unknown files alone");
    await history.save(record(3));
    assert.equal(existsSync(join(path, `${orphan}.png`)), false);
    assert.equal(existsSync(join(path, "not-a-run.png")), true);
    console.log("  ✓ bounded retention removes paired images and safe orphan PNGs only");

    const corruptId = randomUUID();
    const corruptFile = join(path, `${corruptId}.json`);
    writeFileSync(corruptFile, "{broken");
    const diagnostic = [];
    const originalError = console.error;
    console.error = (...args) => diagnostic.push(args.join(" "));
    try { assert.equal(history.list().length, 2); } finally { console.error = originalError; }
    assert.ok(diagnostic.some(line => line.includes(corruptId)));
    assert.equal(readFileSync(corruptFile, "utf8"), "{broken");
    assert.throws(() => history.get(corruptId));
    const mismatched = record();
    writeFileSync(corruptFile, JSON.stringify(mismatched));
    assert.throws(() => history.get(corruptId), /does not match/);
    writeFileSync(corruptFile, " ".repeat(256 * 1024 + 1));
    assert.throws(() => history.get(corruptId), /exceeds/);
    writeFileSync(corruptFile, Buffer.from([0xff]));
    assert.throws(() => history.get(corruptId), /Invalid run metadata JSON/);
    rmSync(corruptFile);
    console.log("  ✓ corrupt records are explicitly diagnosed/skipped; get refuses corruption and mismatched IDs");

    if (process.platform !== "win32") {
      const target = join(dir, "outside.json");
      writeFileSync(target, "outside data");
      const linkedId = randomUUID();
      symlinkSync(target, join(path, `${linkedId}.json`));
      assert.throws(() => history.get(linkedId), /private regular file/);
      await history.save(record());
      assert.equal(readFileSync(target, "utf8"), "outside data");
      assert.ok(lstatSync(join(path, `${linkedId}.json`)).isSymbolicLink());
      const linkedDir = join(dir, "linked-history");
      symlinkSync(path, linkedDir);
      assert.throws(() => new RunHistory(linkedDir).list(), /real directory/);
      await assert.rejects(new RunHistory(linkedDir).save(record()), /real directory/);
    }
    console.log("  ✓ history never follows linked directories/files or cleans an unknown path");

    const concurrentDir = join(dir, "concurrent");
    mkdirSync(concurrentDir);
    const writers = Array.from({ length: 10 }, () => {
      const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--writer", concurrentDir], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.add(proc);
      let stderr = "";
      proc.stderr.on("data", chunk => { stderr += chunk; });
      return { proc, ready: once(proc, "message"), exit: once(proc, "exit").then(([code]) => { children.delete(proc); return { code, stderr }; }) };
    });
    await Promise.all(writers.map(writer => writer.ready));
    for (const writer of writers) writer.proc.send("go");
    for (const result of await Promise.all(writers.map(writer => writer.exit))) assert.equal(result.code, 0, result.stderr);
    const runs = new RunHistory(concurrentDir, 3).list();
    assert.equal(runs.length, 3);
    assert.equal(readdirSync(concurrentDir).filter(file => file.endsWith(".json")).length, 3);
    assert.equal(readdirSync(concurrentDir).filter(file => file.endsWith(".png")).length, 3);
    for (const run of runs) assert.ok(new RunHistory(concurrentDir).get(run.runId).pngBase64);
    console.log("  ✓ ten simultaneous processes retain exactly three complete records/images");
    console.log("=== run-history: PASS ===");
  } finally {
    clearTimeout(timeout);
    for (const child of children) child.kill();
    rmSync(dir, { recursive: true, force: true });
    stopWatchdog();
  }
}
