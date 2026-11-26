import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog(() => rmSync(dir, { recursive: true, force: true }));
const dir = mkdtempSync(join(tmpdir(), 'tabai-assistant-cases-'));
try {
  await build({ stdin: { contents: 'export * from "./src/assistant-cases"; export * from "./shared/assistant-cases";', resolveDir: process.cwd(), sourcefile: 'assistant-cases-test.ts' }, outfile: join(dir, 'cases.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { applyAssistantCaseOperation: apply, assistantCaseSchema, assistantCaseLinkSchema, CASES_MAX } = await import(pathToFileURL(join(dir, 'cases.mjs')));
  const firstStamp = '2026-11-01T10:00:00.000Z', nextStamp = '2026-11-01T10:30:00.000Z';
  const item = (id, accountId, kind = 'reply', status = 'open') => ({ id, revision: 0, status, accountId, kind, threadId: `thread-${id}`, title: 'Gemensamt ämne', summary: 'Testunderlag.', reason: 'Ett nästa steg behövs.', priority: 2, sourceUrl: `https://mail.example.test/${id}`, sources: [{ observationId: `observation-${id}`, quote: 'Ett testunderlag.' }], updatedAt: firstStamp });
  const items = [item('mail-one', 'first-account'), item('mail-two', 'second-account'), item('meeting-one', 'second-account', 'meeting'), item('task-one', 'first-account', 'action')];
  const frozenItems = structuredClone(items);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  freeze(items);
  const mutate = (cases, fields, currentItems = items, stamp = nextStamp) => apply(cases, currentItems, { action: fields.action ?? 'case-update', caseId: cases[0].id, revision: String(cases[0].revision), ...fields }, stamp);
  const link = (cases, value, currentItems = items) => mutate(cases, { action: 'case-link', link: JSON.stringify(value) }, currentItems);
  const unlink = (cases, value, currentItems = items) => mutate(cases, { action: 'case-unlink', link: JSON.stringify(value) }, currentItems);
  const empty = freeze([]);
  let cases = apply(empty, items, { action: 'case-create', title: '  Ett gemensamt ärende  ' }, firstStamp);
  assert.equal(empty.length, 0);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].title, 'Ett gemensamt ärende');
  assert.equal(cases[0].revision, 0);
  assert.equal(cases[0].status, 'open');
  assert.deepEqual(cases[0].links, [], 'matching subjects never infer a relationship');
  assert.equal(cases[0].description, '');
  assert.equal(cases[0].nextAction, '');
  assert.equal(cases[0].waitingFor, '');
  assert.equal(cases[0].createdAt, firstStamp);
  assert.equal(cases[0].updatedAt, firstStamp);
  assert.match(cases[0].id, /^[0-9a-f-]{36}$/);

  for (const entry of items) cases = link(cases, { kind: 'item', itemId: entry.id });
  cases = link(cases, { kind: 'module', moduleId: 'invoice-helper', runId: 'invoice-run-one', label: 'Fakturaunderlag' });
  cases = link(cases, { kind: 'url', url: 'HTTPS://EXAMPLE.TEST:443/invoice/one', label: 'Extern faktura' });
  assert.equal(cases[0].links.length, 6, 'mail from two accounts, a meeting, a task and invoice references group explicitly');
  assert.equal(cases[0].links[5].url, 'https://example.test/invoice/one');
  const grouped = freeze(structuredClone(cases));
  for (const value of [
    { kind: 'item', itemId: 'mail-one' },
    { kind: 'module', moduleId: 'invoice-helper', runId: 'invoice-run-one', label: 'En annan etikett' },
    { kind: 'url', url: 'https://example.test/invoice/one', label: 'Ny etikett' },
  ]) assert.strictEqual(link(grouped, value), grouped, 'relinking the same source never duplicates or revises it');
  assert.equal(grouped[0].links[4].label, 'Fakturaunderlag', 'a duplicate keeps the explicitly saved label');
  assert.throws(() => link(grouped, { kind: 'item', itemId: 'missing' }), /finns inte längre/);
  cases = mutate(grouped, { description: 'Samlat underlag.', nextAction: 'Bekräfta mötet.', waitingFor: 'Ett besked', deadline: '2026-11-10', status: 'waiting' });
  assert.equal(cases[0].revision, grouped[0].revision + 1);
  assert.equal(cases[0].createdAt, firstStamp);
  assert.equal(cases[0].updatedAt, nextStamp);
  assert.equal(cases[0].status, 'waiting');
  assert.equal(grouped[0].status, 'open', 'updates leave frozen original cases untouched');
  assert.strictEqual(mutate(cases, { nextAction: 'Bekräfta mötet.', status: 'waiting' }), cases, 'unchanged values do not revise the case');
  assert.strictEqual(mutate(cases, {}), cases);
  cases = mutate(cases, { deadline: '' });
  assert.equal(Object.hasOwn(cases[0], 'deadline'), false, 'an explicitly empty deadline clears it');
  assert.equal(cases[0].description, 'Samlat underlag.', 'partial edits preserve all other fields');
  for (const action of ['case-update', 'case-delete', 'case-link', 'case-unlink']) {
    assert.throws(() => mutate(cases, { action, revision: '0', ...(action.includes('link') ? { link: JSON.stringify({ kind: 'item', itemId: 'mail-one' }) } : {}) }), /har ändrats/);
  }
  const unrelated = apply(cases, items, { action: 'case-create', title: cases[0].title }, nextStamp);
  assert.equal(unrelated.length, 2);
  assert.deepEqual(unrelated[1].links, [], 'same case titles do not merge sources automatically');

  const allSent = items.map(entry => ({ ...entry, status: 'sent' }));
  const afterSent = mutate(cases, { nextAction: 'Invänta resten av ärendet.' }, allSent);
  assert.equal(afterSent[0].status, 'waiting', 'sent mail never completes the case automatically');
  const completed = mutate(afterSent, { status: 'completed' }, allSent);
  assert.equal(completed[0].status, 'completed');
  for (const status of ['sending', 'uncertain']) {
    const locked = items.map(entry => entry.id === 'mail-one' ? { ...entry, status } : entry);
    const lockedSnapshot = structuredClone(locked), caseSnapshot = structuredClone(cases);
    assert.throws(() => mutate(cases, { status: 'completed' }, locked), /pågående eller osäkert utskick/);
    assert.throws(() => mutate(cases, { action: 'case-delete' }, locked), /pågående eller osäkert utskick/);
    assert.throws(() => unlink(cases, { kind: 'item', itemId: 'mail-one' }, locked), /Kontrollera.*Skickat/, 'a locked send cannot be unlinked to bypass case completion/deletion protection');
    assert.deepEqual(cases, caseSnapshot, 'a blocked unlink preserves case links and revision');
    assert.deepEqual(locked, lockedSnapshot, 'a blocked unlink never changes the actual mail outcome');
    for (const value of [
      { kind: 'item', itemId: 'mail-two' },
      { kind: 'module', moduleId: 'invoice-helper', runId: 'invoice-run-one', label: '' },
      { kind: 'url', url: 'https://example.test/invoice/one', label: '' },
    ]) assert.equal(unlink(cases, value, locked)[0].links.length, cases[0].links.length - 1, 'unrelated item/module/URL links remain removable');
    assert.equal(unlink(cases, { kind: 'item', itemId: 'mail-one' }, allSent)[0].links.length, cases[0].links.length - 1, 'a confirmed sent item is not locked against unlinking');
    assert.doesNotThrow(() => mutate(cases, { nextAction: 'Kontrollera det osäkra utskicket.' }, locked));
    const unlinkedLocked = [...items, item('unrelated-send', 'first-account', 'reply', status)];
    assert.doesNotThrow(() => mutate(cases, { action: 'case-delete' }, unlinkedLocked), 'only a linked send can block deleting its case');
  }
  assert.deepEqual(items, frozenItems, 'grouping and send guards never change native items');
  const removedModule = unlink(grouped, { kind: 'module', moduleId: 'invoice-helper', runId: 'invoice-run-one', label: 'Ändrad etikett' });
  assert.equal(removedModule[0].links.length, 5);
  assert.equal(removedModule[0].revision, grouped[0].revision + 1);
  const removedUrl = unlink(removedModule, { kind: 'url', url: 'https://EXAMPLE.TEST:443/invoice/one', label: '' });
  assert.equal(removedUrl[0].links.length, 4);
  const removedArchived = unlink(grouped, { kind: 'item', itemId: 'mail-one' }, []);
  assert.equal(removedArchived[0].links.length, 5, 'archived item references can still be removed');
  assert.strictEqual(unlink(removedArchived, { kind: 'item', itemId: 'mail-one' }, []), removedArchived);
  assert.deepEqual(mutate(cases, { action: 'case-delete' }), []);
  assert.throws(() => mutate(cases, { action: 'case-delete', caseId: randomUUID() }), /finns inte längre/);

  for (const url of ['javascript:alert(1)', 'data:text/plain,test', 'file:///tmp/test', '//example.test', 'https:///example.test', 'https://', 'https://user:pass@example.test/a', 'https://@example.test/a', 'https://example.test:wrong/a', 'https://example.test\\@other.test/a', ' https://example.test/a', 'https://example.test/a b']) {
    assert.equal(assistantCaseLinkSchema.safeParse({ kind: 'url', url, label: '' }).success, false, `unsafe or malformed URL rejected: ${url}`);
    assert.throws(() => link(grouped, { kind: 'url', url, label: '' }), /http-\/https/);
  }
  assert.equal(assistantCaseLinkSchema.parse({ kind: 'url', url: 'http://example.test/source' }).label, '');
  for (const value of [
    { kind: 'item', itemId: '' }, { kind: 'item', itemId: 'x'.repeat(101) },
    { kind: 'module', moduleId: '../private', runId: 'a', label: '' },
    { kind: 'module', moduleId: 'invoice-helper', runId: 'x'.repeat(101), label: '' },
    { kind: 'module', moduleId: 'invoice-helper', runId: 'a', label: 'x'.repeat(301) },
    { kind: 'item', itemId: 'mail-one', extra: 'unknown' },
  ]) assert.throws(() => link(grouped, value));
  assert.throws(() => mutate(grouped, { action: 'case-link', link: '{' }), /ogiltiga/);
  assert.equal(assistantCaseSchema.safeParse({ ...grouped[0], extra: 'unknown' }).success, false);
  for (const changes of [{ caseId: '../workspace.json' }, { caseId: 'x'.repeat(1000) }, { revision: '-1' }, { revision: '1.1' }, { revision: '' }, { revision: '9007199254740992' }, { title: ' ' }, { title: 'x'.repeat(201) }, { description: 'x'.repeat(2001) }, { nextAction: 'x'.repeat(1001) }, { waitingFor: 'x'.repeat(301) }, { deadline: '2026-02-29' }, { deadline: '2026-11-31' }, { status: 'sent' }, { unknown: 'field' }]) {
    assert.throws(() => mutate(grouped, changes), /ogiltiga eller saknade/);
  }
  assert.doesNotThrow(() => mutate(grouped, { deadline: '2024-02-29' }));
  assert.throws(() => apply([], items, { action: 'case-create', title: 'Test' }, 'not-a-timestamp'), /giltig tidpunkt/);
  assert.throws(() => apply([], items, { action: 'case-create' }, firstStamp), /rubrik/);
  assert.throws(() => apply([], items, { action: 'case-create', title: 'Test', links: '[]' }, firstStamp), /ogiltiga eller saknade/);
  assert.doesNotThrow(() => mutate(grouped, { nextAction: 'Kontrollera underlaget.', windowId: '42' }));

  const full = freeze(Array.from({ length: CASES_MAX }, (_, index) => ({ ...cases[0], id: randomUUID(), title: `Testärende ${index}` })));
  assert.throws(() => apply(full, items, { action: 'case-create', title: 'Ett till' }, nextStamp), /Högst 100 ärenden/);
  assert.equal(full.length, 100, 'capacity never silently evicts a case');
  const fullLinks = freeze([{ ...cases[0], links: Array.from({ length: 100 }, (_, index) => ({ kind: 'url', url: `https://example.test/source/${index}`, label: '' })) }]);
  assert.throws(() => link(fullLinks, { kind: 'url', url: 'https://example.test/source/100', label: '' }), /Högst 100 kopplingar/);
  assert.strictEqual(link(fullLinks, { kind: 'url', url: 'https://example.test/source/0', label: 'Ny etikett' }), fullLinks, 'dedup still works at capacity');
  assert.equal(fullLinks[0].links.length, 100);
  console.log('Assistant cases: explicit grouping, source deduplication, immutable revisions, stale-write protection, send locks, URL validation and capacity passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
  stopWatchdog();
}
