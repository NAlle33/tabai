import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchdog } from './watchdog.mjs';
const stopWatchdog = watchdog(() => { if (process.argv[2] !== '--reserve-child') rmSync(dir, { recursive: true, force: true }); });
const compiled = await build({ entryPoints: ['src/assistant-budget.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20' });
const { AssistantBudget } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const price = { model: 'fixture-model', currency: 'EUR', inputPerMillion: 1, outputPerMillion: 2, checkedAt: new Date().toISOString(), source: 'https://api.berget.ai/v1/models/' };
if (process.argv[2] === '--reserve-child') {
  try { await new AssistantBudget(process.argv[3]).reserve(price.model, 'crash-after-reserve', 500, 1000, price); process.exit(0); }
  catch { process.exit(2); }
}
const dir = mkdtempSync(join(tmpdir(), 'tabai-budget-'));
try {
  const first = new AssistantBudget(dir), second = new AssistantBudget(dir);
  assert.equal(first.view().limitEur, undefined, 'new budgets have no configured limit');
  await first.configure(0.007);
  const reservations = await Promise.allSettled([first.reserve(price.model, 'one', 500, 1000, price), second.reserve(price.model, 'two', 500, 1000, price)]);
  assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1, 'independent store instances cannot race beyond the limit');
  assert.match(first.view().message, /stoppades/);
  assert.equal(first.view().entries.length, 1);
  const id = reservations.find(result => result.status === 'fulfilled').value;
  const actual = await second.settle(id, { prompt_tokens: 20, completion_tokens: 30 });
  assert.equal(actual, 0.00008); assert.equal(first.view().settledEur, actual);
  assert.equal(first.view().inputTokens, 20); assert.equal(first.view().outputTokens, 30);
  await assert.rejects(first.settle(id), /redan/);
  const unknown = await first.reserve(price.model, 'unknown', 500, 1000, price);
  await second.settle(unknown);
  assert(first.view().uncertainEur > 0);
  assert.equal(first.view().reservedEur, 0);
  assert.equal(first.view().entries.at(-1).costEur, undefined, 'unknown usage is never recorded as zero');
  await assert.rejects(first.reserve('other-model', 'mismatch', 1, 1, price), /aktuellt/);
  await assert.rejects(first.reserve(price.model, 'stale', 1, 1, { ...price, checkedAt: new Date(Date.now() - 16 * 60_000).toISOString() }), /aktuellt/);
  await assert.rejects(first.configure(-1), /Budgetgränsen/);
  await second.configure(undefined); assert.equal(first.view().limitEur, undefined);
  assert.equal(JSON.stringify(first.view()).includes('ownerPid'), false);
  assert.match(first.view().message, /UTC/);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'assistant-budget.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dir, 'assistant-budget.json'), 'utf8')).entries.length, 2);
  const raced = new AssistantBudget(join(dir, 'process-race')); await raced.configure(0.007);
  const child = () => new Promise(resolve => {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(import.meta.url), '--reserve-child', join(dir, 'process-race')], { stdio: 'ignore' });
    process.on('error', () => resolve(-1)); process.on('exit', code => resolve(code));
  });
  assert.deepEqual((await Promise.all([child(), child()])).sort(), [0, 2], 'cross-process reservation is atomic and at most one call fits');
  assert.equal(raced.view().entries.length, 1); assert.equal(raced.view().entries[0].status, 'uncertain', 'a process that exits without settlement never frees its reservation');
  assert(raced.view().uncertainEur > 0); assert.equal(raced.view().settledEur, 0);

  // Closed periods: an entry older than the previous UTC month never counts toward the limit and
  // goes on the next change; the current and the previous month stay.
  const month = offset => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7); };
  const entry = (period, changes = {}) => ({ id: randomUUID(), model: price.model, runId: 'fixture-run', createdAt: new Date().toISOString(), status: 'settled', reservedEur: 1, costEur: 1, inputTokens: 1, outputTokens: 1, price, period, ownerPid: process.pid, ...changes });
  const ledgerFile = directory => join(directory, 'assistant-budget.json');
  const aged = join(dir, 'aged'); mkdirSync(aged, { mode: 0o700 });
  const old = entry(month(-2), { costEur: 100, reservedEur: 100 }), previous = entry(month(-1)), current = entry(month(0), { costEur: 0.001, reservedEur: 0.001 });
  writeFileSync(ledgerFile(aged), JSON.stringify({ version: 1, limitEur: 0.01, entries: [old, previous, current], message: '' }), { mode: 0o600 });
  const agedBudget = new AssistantBudget(aged);
  await agedBudget.reserve(price.model, 'after-old-period', 500, 1000, price);
  const kept = JSON.parse(readFileSync(ledgerFile(aged), 'utf8')).entries;
  assert.deepEqual(kept.slice(0, 2).map(item => item.id), [previous.id, current.id], 'an entry older than the previous month is removed on the next change; the previous and the current month stay');
  assert.equal(kept.length, 3); assert.equal(kept[2].runId, 'after-old-period');
  assert.equal(agedBudget.view().settledEur, 0.001, 'the view counts the current month only');
  // A ledger near its size cap with closed periods still admits a reservation.
  const crowded = join(dir, 'crowded'); mkdirSync(crowded, { mode: 0o700 });
  const filler = entry(month(-3), { status: 'uncertain', costEur: undefined, inputTokens: undefined, outputTokens: undefined, runId: 'r'.repeat(100) });
  const perEntry = Buffer.byteLength(JSON.stringify(filler)) + 1, count = Math.floor((8 * 1024 * 1024 - 200) / perEntry);
  const crowdedLedger = { version: 1, entries: Array.from({ length: count }, () => ({ ...filler, id: randomUUID() })), message: '' };
  writeFileSync(ledgerFile(crowded), JSON.stringify(crowdedLedger), { mode: 0o600 });
  assert(statSync(ledgerFile(crowded)).size > 8 * 1024 * 1024 - 1024, 'the fixture ledger is within a kilobyte of the cap');
  await new AssistantBudget(crowded).reserve(price.model, 'near-cap', 500, 1000, price);
  const compacted = JSON.parse(readFileSync(ledgerFile(crowded), 'utf8')).entries;
  assert.deepEqual(compacted.map(item => item.runId), ['near-cap'], 'closed periods make room for the new reservation');
  // The month is the UTC month on any computer: at 23.30 UTC on 31 October it is already
  // 1 November in Stockholm, and the spending still belongs to October. From UTC midnight,
  // November starts with nothing spent.
  {
    const RealDate = Date, savedZone = process.env.TZ;
    let fixedNow = RealDate.parse('2026-10-31T23:30:00.000Z');
    class FixedDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixedNow])); }
      static now() { return fixedNow; }
    }
    process.env.TZ = 'Europe/Stockholm';
    globalThis.Date = FixedDate;
    try {
      assert.deepEqual([new Date().getMonth(), new Date().getUTCMonth()], [10, 9], 'the local calendar has reached November, UTC has not');
      const boundary = join(dir, 'utc-boundary'); mkdirSync(boundary, { mode: 0o700 });
      const monthly = new AssistantBudget(boundary), current = () => ({ ...price, checkedAt: new Date().toISOString() });
      const october = await monthly.reserve(price.model, 'october', 500, 1000, current());
      await monthly.settle(october, { prompt_tokens: 1000, completion_tokens: 1000 });
      assert.deepEqual([monthly.view().period, monthly.view().settledEur], ['2026-10', 0.003], 'spending before UTC midnight is October\'s');
      assert.equal(JSON.parse(readFileSync(ledgerFile(boundary), 'utf8')).entries[0].period, '2026-10');
      fixedNow = RealDate.parse('2026-11-01T00:30:00.000Z');
      assert.deepEqual([monthly.view().period, monthly.view().settledEur], ['2026-11', 0], 'November starts with nothing spent');
    } finally {
      globalThis.Date = RealDate;
      if (savedZone === undefined) delete process.env.TZ; else process.env.TZ = savedZone;
    }
  }
  console.log('assistant-budget: locked admission, exact-price settlement, unknown usage, stale/model refusal, private storage, closed-period pruning and the UTC month boundary passed');
} finally { rmSync(dir, { recursive: true, force: true }); stopWatchdog(); }
