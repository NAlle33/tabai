// Real disposable filesystem + independent Node processes; never the user store.
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { RecipeStore } from "../dist/recipe-store.mjs";
import { recipeSchema } from "../dist/workflow-schema.mjs";
import { watchdog } from "./watchdog.mjs";

// Real writer and lock-owner processes run about 9 s.
const stopWatchdog = watchdog(undefined, 90_000);
const validate = value => recipeSchema.parse(value);
const legacy = [{ tool: "read_page", args: { tabId: 1 } }];
const versioned = { version: 2, parameters: { query: { type: "string" } }, actions: [{ tool: "find", args: { query: "{{query}}" } }] };
const [mode, path, name] = process.argv.slice(2);

if (mode === "--writer") {
  const store = new RecipeStore(path, validate);
  store.load(); // Every writer observes the initial revision before the barrier.
  process.send("ready");
  await once(process, "message");
  await store.save(name, legacy);
  process.exit(0);
} else if (mode === "--lock-owner") {
  writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() }), { mode: 0o600 });
  process.send("ready");
  setInterval(() => {}, 1000);
} else {
  const dir = mkdtempSync(join(tmpdir(), "tabai-recipe-store-"));
  const children = new Set();
  const timeout = setTimeout(() => { for (const child of children) child.kill(); process.exit(1); }, 45_000);
  const child = (args) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.add(proc);
    let stderr = "";
    proc.stderr.on("data", chunk => { stderr += chunk; });
    const exit = once(proc, "exit").then(([code]) => { children.delete(proc); return { code, stderr }; });
    return { proc, exit, ready: once(proc, "message") };
  };
  try {
    // Exercise Windows' transient rename failures on every CI platform, using real files.
    const compiled = await transform(readFileSync(new URL("../src/private-storage.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" });
    const require = createRequire(import.meta.url);
    const fs = require("node:fs");
    const retryFile = join(dir, "rename.json");
    function renameCase(platform, failures, code, expectedCalls, shouldPass) {
      writeFileSync(retryFile, "original");
      let calls = 0;
      const module = { exports: {} };
      runInNewContext(compiled.code, { module, exports: module.exports, Buffer, process: { platform },
        require: name => name === "node:fs" ? { ...fs, renameSync: (from, to) => {
          calls++;
          if (calls <= failures) throw Object.assign(new Error("rename refused"), { code });
          fs.renameSync(from, to);
        } } : require(name),
      });
      if (shouldPass) module.exports.atomicPrivateFile(retryFile, "replacement");
      else assert.throws(() => module.exports.atomicPrivateFile(retryFile, "replacement"), error => error.code === code);
      assert.equal(calls, expectedCalls);
      assert.equal(readFileSync(retryFile, "utf8"), shouldPass ? "replacement" : "original");
      assert.equal(fs.readdirSync(dir).filter(name => name.startsWith("rename.json.")).length, 0, "temp files are removed on success and failure");
    }
    for (const code of ["EPERM", "EACCES", "EBUSY"]) renameCase("win32", 2, code, 3, true);
    renameCase("win32", Infinity, "EPERM", 41, false);
    renameCase("win32", Infinity, "EIO", 1, false);
    renameCase("darwin", Infinity, "EPERM", 1, false);
    console.log("  ✓ Windows rename retries are bounded, preserve the original on failure and never retry other errors");

    const file = join(dir, "data", "recipes.json");
    const store = new RecipeStore(file, validate);
    assert.deepEqual(Object.keys(store.load()), []);
    await store.save("legacy", legacy);
    const original = readFileSync(file);
    await store.save("versioned", versioned);
    assert.deepEqual(store.load().legacy, legacy);
    assert.deepEqual(store.load().versioned, versioned);
    assert.deepEqual(readFileSync(`${file}.bak`), original);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(join(dir, "data")).mode & 0o777, 0o700);
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      assert.equal(lstatSync(`${file}.bak`).mode & 0o777, 0o600);
    }
    console.log("  ✓ legacy and v2 validation, exact original backup, private modes");

    for (const bad of ["", "{broken", "null", "[]", '{"bad":42}', '{"legacy":[{"tool":"read_page"}],"bad":false}', '{"__proto__":[{"tool":"read_page"}]}']) {
      writeFileSync(file, bad);
      const backup = readFileSync(`${file}.bak`);
      assert.throws(() => store.load(), /original file preserved/);
      await assert.rejects(store.save("new", legacy), /original file preserved/);
      assert.equal(readFileSync(file, "utf8"), bad);
      assert.deepEqual(readFileSync(`${file}.bak`), backup);
      assert.equal(existsSync(`${file}.lock`), false);
    }
    console.log("  ✓ malformed JSON, shapes, prototype keys and invalid existing entries preserve original and backup");

    const invalidUtf8 = Buffer.concat([Buffer.from('{"legacy":[{"tool":"read_page","args":{"value":"'), Buffer.from([0xff]), Buffer.from('"}}]}')]);
    writeFileSync(file, invalidUtf8);
    assert.throws(() => store.load(), /invalid JSON/);
    await assert.rejects(store.save("new", legacy), /invalid JSON/);
    assert.deepEqual(readFileSync(file), invalidUtf8);

    writeFileSync(file, JSON.stringify({ legacy }));
    for (const badName of ["__proto__", "prototype", "constructor", "..", "../escape", "a/b", "a\\b", "", " a", "a\0b"]) {
      await assert.rejects(store.save(badName, legacy), /Invalid recipe name/);
    }
    const before = readFileSync(file);
    await assert.rejects(store.save("bad", { version: 3, steps: [] }));
    assert.deepEqual(readFileSync(file), before);
    const seen = [];
    const checking = new RecipeStore(file, value => { seen.push(value); return validate(value); });
    await checking.save("versioned", versioned);
    assert.ok(seen.some(value => Array.isArray(value)));
    assert.ok(seen.filter(value => value?.version === 2).length >= 2);
    console.log("  ✓ safe names and every old/new entry validated before writing");

    const wrongType = join(dir, "directory.json");
    mkdirSync(wrongType);
    await assert.rejects(new RecipeStore(wrongType, validate).save("new", legacy), /Cannot read recipe store/);
    assert.ok(lstatSync(wrongType).isDirectory());
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      assert.throws(() => store.load(), /Cannot read recipe store/);
      await assert.rejects(store.save("new", legacy), /Cannot read recipe store/);
      chmodSync(file, 0o600);
    }
    console.log("  ✓ filesystem/read-permission errors fail closed");

    if (process.platform !== "win32") {
      const link = join(dir, "link.json");
      symlinkSync(file, link);
      assert.throws(() => new RecipeStore(link, validate).load(), /Cannot read recipe store/);
      const linkedDir = join(dir, "linked-dir");
      symlinkSync(join(dir, "data"), linkedDir);
      assert.throws(() => new RecipeStore(join(linkedDir, "recipes.json"), validate).load(), /real directory/);
      rmSync(`${file}.bak`);
      symlinkSync(join(dir, "outside.json"), `${file}.bak`);
      const bytes = readFileSync(file);
      await assert.rejects(store.save("new", legacy), /private regular file/);
      assert.deepEqual(readFileSync(file), bytes);
      assert.equal(existsSync(join(dir, "outside.json")), false);
      rmSync(`${file}.bak`);
    }
    const hardLink = join(dir, "hard-link.json"), beforeLink = readFileSync(file);
    linkSync(file, hardLink);
    assert.throws(() => store.load(), /Cannot read recipe store/);
    await assert.rejects(store.save("linked", legacy), /Cannot read recipe store/);
    assert.deepEqual(readFileSync(hardLink), beforeLink);
    rmSync(hardLink);
    console.log("  ✓ symlinked and hard-linked stores, directories and backup destinations are refused");

    const live = child(["--lock-owner", `${file}.lock`]);
    await live.ready;
    const held = readFileSync(`${file}.lock`);
    await assert.rejects(store.save("held", legacy), /Storage is locked/);
    assert.deepEqual(readFileSync(`${file}.lock`), held);
    live.proc.kill();
    await live.exit;
    await store.save("afterCrash", legacy);
    assert.ok(store.load().afterCrash);
    console.log("  ✓ bounded lock wait never reaps a live PID; a killed owner recovers");

    writeFileSync(`${file}.lock`, "ambiguous incomplete lock");
    await assert.rejects(store.save("ambiguous", legacy), /Storage is locked/);
    assert.equal(readFileSync(`${file}.lock`, "utf8"), "ambiguous incomplete lock");
    rmSync(`${file}.lock`);

    const killed = child(["--lock-owner", `${file}.lock`]);
    await killed.ready;
    killed.proc.kill();
    await killed.exit;
    const writers = Array.from({ length: 10 }, (_, i) => child(["--writer", file, `writer-${i}`]));
    await Promise.all(writers.map(writer => writer.ready));
    const readFailures = [];
    const reader = setInterval(() => { try { store.load(); } catch (error) { readFailures.push(error); } }, 2);
    for (const writer of writers) writer.proc.send("go");
    try {
      for (const result of await Promise.all(writers.map(writer => writer.exit))) assert.equal(result.code, 0, result.stderr);
    } finally { clearInterval(reader); }
    assert.deepEqual(readFailures, []);
    const stored = store.load();
    for (let i = 0; i < 10; i++) assert.deepEqual(stored[`writer-${i}`], legacy);
    assert.ok(stored.legacy && stored.versioned && stored.afterCrash);
    assert.equal(existsSync(`${file}.lock`), false);
    console.log("  ✓ ten barrier-synchronized processes recover one stale lock without lost updates");

    const oversized = " ".repeat(8 * 1024 * 1024 + 1);
    writeFileSync(file, oversized);
    await assert.rejects(store.save("large", legacy), /Cannot read recipe store/);
    assert.equal(lstatSync(file).size, oversized.length);
    console.log("=== recipe-store: PASS ===");
  } finally {
    clearTimeout(timeout);
    for (const child of children) child.kill();
    rmSync(dir, { recursive: true, force: true });
    stopWatchdog();
  }
}
