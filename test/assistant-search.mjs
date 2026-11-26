import assert from 'node:assert/strict';
import { searchAssistantDocuments } from '../dist/assistant-controller.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog();
async function* documents() {
  for (let index = 0; index < 7; index++) yield {
    kind: 'mail', id: String(index), title: `Beslut ${index}`, date: `2026-11-0${index + 1}T00:00:00.000Z`, bytes: 10,
    read: () => index === 3 ? Promise.reject(new Error('Unreadable private source')) : `Orkidé <img onerror=x> underlag ${index}`,
  };
}
const limits = { bytes: 100, documents: 2, milliseconds: 1000 }, found = [];
let offset = 0, warned = false;
do {
  const result = await searchAssistantDocuments('OrKidé underlag', documents(), offset, limits);
  found.push(...result.results.map(result => result.id)); warned ||= !!result.warnings.length;
  if (result.nextOffset === undefined) break;
  assert.ok(result.nextOffset > offset); offset = result.nextOffset;
} while (true);
assert.deepEqual(found.sort(), ['0', '1', '2', '4', '5', '6'], 'bounded continuation covers the whole collection without duplicates');
assert.equal(warned, true);
assert.deepEqual((await searchAssistantDocuments('   ', documents())).results, []);
stopWatchdog();
console.log('assistant-search: local matching, bounded continuation and partial failures OK');
