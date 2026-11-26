import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PersonalModules } from "../dist/personal-modules.mjs";
import { PanelRouter } from "../dist/panel-router.mjs";
import { watchdog } from "./watchdog.mjs";
const stopWatchdog = watchdog(async () => { hosts.forEach(item => item.close()); await new Promise(resolve => setTimeout(resolve, 150)); rmSync(dir, { recursive: true, force: true }); });
const dir = mkdtempSync(join(tmpdir(), "tabai-modules-")), hosts = [];
const host = path => { const result = new PersonalModules(path); hosts.push(result); return result; };
const registry = join(dir, "personal-modules.json");
try {
  assert.deepEqual(await host(dir).list(), [], "clean installs have no personal UI");
  writeFileSync(registry, JSON.stringify([{ id: "test-module", command: process.execPath, args: [resolve("test/fixtures/personal-module.mjs"), join(dir, "state.json")], cwd: dir }]), { mode: 0o600 });
  const modules = host(dir), router = new PanelRouter(modules);
  const command = command => new Promise(resolve => router.request({ id: "request", command }, resolve));
  assert.equal((await command({ action: "modules" })).result[0].view.title, "Personligt testflöde");
  const start = { action: "module", moduleId: "test-module", operation: "start", input: { subject: "private-case" } };
  const started = await command(start); assert.equal(started.result.run.status, "waiting");
  assert.equal(started.result.run.review.verification.state, "failed");
  assert.deepEqual(started.result.run.review.sections[0].items.map(item => item.status), ["confirmed", "missing", "conflict"]);
  await command(start);
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).starts, 1, "same case is not started twice");
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).moduleConfigDir, dir, "module clients retain the owning registry when using separate recipe stores");
  const result = await command({ action: "module", moduleId: "test-module", operation: "reply", input: { "run-id": "local-case", answer: "September" } });
  assert.equal(result.result.run.status, "review"); assert.match(result.result.run.summary, /September/);
  assert.equal(result.result.run.review.verification.state, "passed");
  assert.equal((await command({ action: "modules" })).result[0].view.run.review.sections[0].items[0].sources[0].quote, '<img src=x onerror="alert(1)">');
  const contract = await command({ action: "module", moduleId: "test-module", operation: "status", input: { contract: "valid" } });
  assert.equal(contract.result.mailStart.mailField, "subject", "a module may declare which start field a mail fills");
  assert.equal(contract.result.run.stopAndArchive, true); assert.equal(contract.result.run.archiveBlocked, "Publiceringen pågår.");
  const unknownField = await command({ action: "module", moduleId: "test-module", operation: "status", input: { contract: "invalid" } });
  assert.equal(unknownField.ok, false, "a mail start naming a field the start form lacks is rejected");
  const sameField = await command({ action: "module", moduleId: "test-module", operation: "status", input: { contract: "same" } });
  assert.equal(sameField.ok, false, "one field cannot receive both the mail and its provider");
  assert.equal((await command({ action: "module", moduleId: "test-module", operation: "status", input: { contract: "cleared" } })).ok, false, "a field a mail start fills is not also emptied");
  assert.equal(contract.result.mailRuns[0].runId, "local-case", "runs started from a mail are listed by their mail address");
  for (const invalid of [
    { ...start, moduleId: "../../other" }, { ...start, operation: "execute" },
    { ...start, command: "/bin/sh" }, { ...start, input: { x: "x".repeat(20001) } },
    { ...start, input: { values: 'x'.repeat(100001) } },
    { ...start, moduleId: "not-installed" },
  ]) assert.equal((await command(invalid)).ok, false);
  modules.close();
  assert.equal((await command(start)).ok, false, "shutdown cannot restart a module from a late panel request");
  writeFileSync(registry, JSON.stringify([{ id: "bad", command: "node", args: [], cwd: dir }]));
  await assert.rejects(() => host(dir).list(), /Ogiltig/);
  rmSync(registry); symlinkSync(join(dir, "state.json"), registry);
  await assert.rejects(() => host(dir).list(), /registreringsfilen/);
  console.log("personal-modules: clean install, private process, real persisted state, question/reply, duplicate case, archive and mail-start contract, validation and symlink checks passed");
} finally {
  hosts.forEach(item => item.close());
  await new Promise(resolve => setTimeout(resolve, 150)); rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
