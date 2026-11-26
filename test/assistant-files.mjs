import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createDeflateRaw, deflateRawSync, deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { AssistantChat } from '../dist/assistant-chat.mjs';
import { readAssistantFile } from '../dist/assistant-file-reader.mjs';
import { watchdog } from './watchdog.mjs';

// Real file parsing in child processes, OCR included, runs about 10 s.
const stopWatchdog = watchdog(async () => { await Promise.all(chats.map(chat => chat.close())); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }, 120_000);
const root = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'tabai-files-'));
const chats = [];
const until = async predicate => { const end = Date.now() + 30_000; while (!predicate()) { assert.ok(Date.now() < end, 'file parsing completed'); await new Promise(resolve => setTimeout(resolve, 20)); } };
function fixture() {
  const starts = [], tasks = [];
  const dir = join(directory, randomUUID());
  const bridge = {
    agent: () => undefined, current: () => undefined, verifications: () => [], berget: () => ({ configured: false, message: '' }),
    async start(task, instructions) { tasks.push(instructions); return { id: randomUUID(), label: task }; },
  };
  const executor = { async start(context, callbacks) { starts.push({ context, callbacks }); }, async stop() {}, async close() {} };
  const chat = new AssistantChat(root, dir, bridge, executor);
  chats.push(chat); return { chat, starts, tasks, dir, bridge, executor };
}
async function upload(chat, name, bytes, page) {
  const id = randomUUID(), conversation = chat.view().id;
  await chat.files.start(conversation, { id, name, size: bytes.length, ...(page ? { page } : {}) }, chat.attachedFiles());
  for (let offset = 0; offset < bytes.length; offset += 48 * 1024) await chat.files.append(conversation, id, offset, bytes.subarray(offset, offset + 48 * 1024).toString('base64'));
  await chat.files.finish(conversation, id);
  await until(() => ['ready', 'failed'].includes(chat.view().fileDrafts.find(file => file.id === id)?.status));
  return chat.view().fileDrafts.find(file => file.id === id);
}
// Minimal genuine ZIP/DOCX and PDF files keep tests independent of office applications.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const bytes = Buffer.from(content), filename = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(crc, 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(index, filename); offset += header.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
/** One entry's local header and data; `size` is what the archive declares, `data` what it really holds. */
function localPart({ name, data, size, method = 8, crc = 0 }) {
  const filename = Buffer.from(name);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(filename.length, 26);
  return Buffer.concat([header, filename, data]);
}
/** One entry's central-directory record for its local header at `offset`. */
function centralPart({ name, data, size, method = 8, crc = 0 }, offset, comment = Buffer.alloc(0)) {
  const filename = Buffer.from(name);
  const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(method, 10); index.writeUInt32LE(crc, 16); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(size, 24); index.writeUInt16LE(filename.length, 28); index.writeUInt16LE(comment.length, 32); index.writeUInt32LE(offset, 42);
  return Buffer.concat([index, filename, comment]);
}
function endRecord(onDisk, total, size, offset) {
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(onDisk, 8); end.writeUInt16LE(total, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return end;
}
/** A ZIP of deflated entries whose end record declares `declared` of them. */
function deflatedZip(entries, declared = entries.length) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) { const part = localPart(entry); central.push(centralPart(entry, offset)); local.push(part); offset += part.length; }
  const index = Buffer.concat(central);
  return Buffer.concat([...local, index, endRecord(declared, declared, index.length, offset)]);
}
/**
 * A ZIP whose checked entries are all honest, but whose end record asks for a ZIP64 directory.
 * The last checked entry's comment holds that ZIP64 end record, its locator and a second
 * central directory, which lists `hidden` in place of the checked entries; the hidden entry
 * itself travels as the stored data of a checked entry.
 */
function zip64Redirect(entries, hidden) {
  const hiddenLocal = localPart(hidden);
  const carrier = { name: 'word/media/carrier.bin', data: hiddenLocal, size: hiddenLocal.length, method: 0 };
  const all = [...entries, carrier], local = [], offsets = []; let offset = 0;
  for (const entry of all) { offsets.push(offset); const part = localPart(entry); local.push(part); offset += part.length; }
  const head = Buffer.concat(all.slice(0, -1).map((entry, index) => centralPart(entry, offsets[index])));
  const commentAt = offset + head.length + 46 + Buffer.byteLength(carrier.name);
  const second = Buffer.concat([centralPart(entries[0], offsets[0]), centralPart(hidden, offsets.at(-1) + 30 + Buffer.byteLength(carrier.name))]);
  const zip64End = Buffer.alloc(56); zip64End.writeUInt32LE(0x06064b50); zip64End.writeBigUInt64LE(44n, 4); zip64End.writeBigUInt64LE(2n, 24); zip64End.writeBigUInt64LE(2n, 32);
  zip64End.writeBigUInt64LE(BigInt(second.length), 40); zip64End.writeBigUInt64LE(BigInt(commentAt), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(commentAt + second.length), 8); locator.writeUInt32LE(1, 16);
  const index = Buffer.concat([head, centralPart(carrier, offsets.at(-1), Buffer.concat([second, zip64End, locator]))]);
  return Buffer.concat([...local, index, endRecord(0xffff, all.length, index.length, offset)]);
}
/** A deflate stream of `mebibytes` MiB of text between two strings, built without holding the text. */
async function deflatedFill(prefix, mebibytes, suffix) {
  const deflate = createDeflateRaw(), chunks = [], ended = once(deflate, 'end'), block = Buffer.alloc(1024 * 1024, 0x41);
  deflate.on('data', chunk => chunks.push(chunk));
  deflate.write(prefix);
  for (let index = 0; index < mebibytes; index++) if (!deflate.write(block)) await once(deflate, 'drain');
  deflate.end(suffix); await ended;
  return Buffer.concat(chunks);
}
function encodePdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let length = chunks[0].length;
  objects.forEach((object, i) => { offsets.push(length); const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]); chunks.push(chunk); length += chunk.length; });
  return Buffer.concat([...chunks, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`)]);
}
function pdf() {
  const stream = 'BT /F1 24 Tf 50 700 Td (TABAI PDF 4281) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  return encodePdf(objects);
}
function scannedPdf(canvas) {
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, rgb = Buffer.alloc(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
  const image = deflateSync(rgb), stream = 'q 600 0 0 120 0 0 cm /Im0 Do Q';
  return encodePdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 120] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')])]);
}
try {
  const f = fixture();
  const file = await upload(f.chat, 'underlag.txt', Buffer.from('Svenskt underlag åäö. Belopp 4281 kr.\n'.repeat(400)));
  assert.equal(file.status, 'ready', file.error); assert.ok(file.textChars > 12000);
  const owner = f.chat.view().id;
  await assert.rejects(f.chat.files.request(owner, new Set(), { action: 'read', fileId: file.id, offset: 0, limit: 10 }), /inte skickats/);
  await assert.rejects(f.chat.files.request(randomUUID(), new Set([file.id]), { action: 'read', fileId: file.id, offset: 0, limit: 10 }), /hör inte/);
  await f.chat.send({ id: randomUUID(), text: 'Läs underlaget', fileIds: [file.id] });
  assert.equal(f.chat.view().fileDrafts.length, 0); assert.equal(f.chat.view().messages[0].files[0].id, file.id);
  const turn = f.starts.at(-1); assert.ok(turn.context.chat.messages[0].text.includes('underlag.txt'));
  const content = await turn.callbacks.chatFiles({ action: 'read', fileId: file.id, offset: 0, limit: 50 });
  assert.equal(content.text.length, 50); assert.equal(content.nextOffset, 50); assert.ok(content.text.includes('åäö'));
  await turn.callbacks.chatTask('custom'); assert.ok(f.tasks[0].includes('4281 kr')); assert.ok(f.tasks[0].includes('obetrott underlag'));
  await turn.callbacks.chatReply('Läst');
  {
    // A page the user shared: the host keeps the panel's mark, the chat model reads the page,
    // and neither a task nor a card gets its text, whichever backend runs them.
    const p = fixture(), applied = [];
    p.bridge.apply = async (_intent, instructions) => { applied.push(instructions); return { text: 'Sparat.' }; };
    const shared = 'Delad sida från din egen flik\nTitel: Order\nAdress: https://shop.example/order?id=7&token=dolt\n\nSidans text:\nOrder 4711 Hemlig-Sidtext-5520';
    const page = await upload(p.chat, 'Sida shop.example 2026-11-03.txt', Buffer.from(shared), { url: 'https://kim:pw@shop.example/order?id=7&token=abc&session=s#konto', truncated: true });
    assert.equal(page.status, 'ready', page.error);
    assert.deepEqual([page.source, page.pageUrl, page.pageTruncated], ['page', 'https://shop.example/order?id=7&token=dolt&session=dolt', true], 'the host stores the mark and only the address the model may read');
    const plain = await upload(p.chat, 'Sida som bara heter så.txt', Buffer.from('Vanlig bilaga 3310'));
    assert.equal(plain.source, undefined, 'a file name never makes a page');
    const owner = p.chat.view().id;
    assert.equal(p.chat.files.isPage(owner, page.id), true); assert.equal(p.chat.files.isPage(owner, plain.id), false);
    await p.chat.send({ id: randomUUID(), text: 'Starta ett uppdrag om ordern', fileIds: [page.id, plain.id] });
    const pageTurn = p.starts.at(-1);
    const read = await pageTurn.callbacks.chatFiles({ action: 'read', fileId: page.id, offset: 0, limit: 8000 });
    assert.equal(read.source, 'page'); assert.deepEqual(read.sharedPageOrigins, ['https://shop.example']); assert.ok(read.text.includes('Hemlig-Sidtext-5520'), 'the chat model reads the page');
    assert.match(read.note, /följer inte med till uppdrag/);
    assert.deepEqual((await pageTurn.callbacks.chatFiles({ action: 'list', offset: 0, limit: 8000 })).sharedPageOrigins, ['https://shop.example'], 'a listed page shows its preview, so listing reads it');
    assert.equal((await pageTurn.callbacks.chatFiles({ action: 'read', fileId: plain.id, offset: 0, limit: 100 })).sharedPageOrigins, undefined);
    await pageTurn.callbacks.chatTask('custom');
    const task = p.tasks.at(-1);
    assert.equal(task.includes('Hemlig-Sidtext-5520') || task.includes('Order 4711'), false, 'a task started from the chat never gets the page text');
    assert.ok(task.includes('Vanlig bilaga 3310'), 'an ordinary attachment still goes with the task');
    assert.match(task, /delat en sida i chatten\. Sidans text följer inte med till uppdrag/);
    const card = await pageTurn.callbacks.chatPropose({ kind: 'schedule', enabled: false, time: '08:00', timezone: 'Europe/Stockholm', task: 'my-day' });
    await pageTurn.callbacks.chatReply('Kortet väntar.');
    await p.chat.confirmCard(card.cardId);
    assert.equal(applied.length, 1); assert.equal(applied[0].includes('Hemlig-Sidtext-5520'), false, 'a confirmed card never gets the page text either');
    // Only text from an ordinary page, never mail, and never another kind of file.
    await assert.rejects(p.chat.files.start(owner, { id: randomUUID(), name: 'Sida.pdf', size: 4, page: { url: 'https://shop.example/' } }, p.chat.attachedFiles()), /Bara text från en vanlig webbsida/);
    await assert.rejects(p.chat.files.start(owner, { id: randomUUID(), name: 'Sida.txt', size: 4, page: { url: 'file:///Users/kim/a.html' } }, p.chat.attachedFiles()), /Bara text från en vanlig webbsida/);
    await assert.rejects(p.chat.files.start(owner, { id: randomUUID(), name: 'Sida.txt', size: 4, page: { url: 'https://mail.google.com/mail/u/0/' } }, p.chat.attachedFiles()), /Mejlen hanteras i Mejl/);
    assert.equal(p.chat.view().messages[0].files.find(entry => entry.id === page.id).source, 'page', 'the sent message keeps the mark');
  }
  const blank = await upload(f.chat, 'empty.pdf', Buffer.from('not a pdf'));
  assert.equal(blank.status, 'failed'); assert.ok(blank.error); await f.chat.files.remove(owner, blank.id);
  await assert.rejects(f.chat.files.start(owner, { id: randomUUID(), name: 'danger.exe', size: 1 }, new Set()), /Välj PDF/);
  await assert.rejects(f.chat.files.start(owner, { id: randomUUID(), name: 'large.txt', size: 11 * 1024 * 1024 }, new Set()));
  const id = randomUUID(); await f.chat.files.start(owner, { id, name: 'part.txt', size: 4 }, f.chat.attachedFiles());
  await assert.rejects(f.chat.files.append(owner, id, 1, Buffer.from('x').toString('base64')), /ändrats/);
  await f.chat.files.append(owner, id, 0, Buffer.from('abcd').toString('base64'));
  await assert.rejects(f.chat.files.append(owner, id, 0, Buffer.from('abcd').toString('base64')), /ändrats/);
  await f.chat.files.remove(owner, id);
  const pdfFile = await upload(f.chat, 'real.pdf', pdf()); assert.equal(pdfFile.status, 'ready', pdfFile.error); assert.ok(pdfFile.preview.includes('4281')); assert.equal(pdfFile.pages, 1);
  const word = zip({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word underlag 4281</w:t></w:r></w:p></w:body></w:document>' });
  const docx = await upload(f.chat, 'real.docx', word); assert.equal(docx.status, 'ready', docx.error); assert.ok(docx.preview.includes('4281'));
  {
    // The sizes a Word file declares are its own claim. A stream that inflates beyond its declared
    // size is refused before the Word reader runs, without being inflated in full.
    const types = Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
    const open = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>', close = '</w:t></w:r></w:p></w:body></w:document>';
    const honest = Buffer.from(`${open}Komprimerat underlag 5190${close}`);
    const typesEntry = { name: '[Content_Types].xml', data: deflateRawSync(types), size: types.length, crc: crc32(types) };
    const deflated = await upload(f.chat, 'deflated.docx', deflatedZip([typesEntry, { name: 'word/document.xml', data: deflateRawSync(honest), size: honest.length, crc: crc32(honest) }]));
    assert.equal(deflated.status, 'ready', deflated.error); assert.ok(deflated.preview.includes('5190'), 'a deflated entry of its declared size is read');
    // 128 MiB of text declared as 1 KiB; the CRC is irrelevant, as nothing may inflate that far.
    const bomb = join(directory, 'declared-small.docx');
    writeFileSync(bomb, deflatedZip([typesEntry, { name: 'word/document.xml', data: await deflatedFill(open, 128, close), size: 1024 }]));
    const measure = 'const { parseAssistantFile } = await import(process.argv[1]); const bytes = (await import("node:fs")).readFileSync(process.argv[2]);'
      + ' const before = process.resourceUsage().maxRSS; let error = ""; try { await parseAssistantFile(bytes, "docx"); } catch (caught) { error = String(caught?.message); }'
      + ' console.log(JSON.stringify({ error, grewMiB: (process.resourceUsage().maxRSS - before) / 1024 }));';
    /** Parses the file in a child process with a small heap: the refusal, and how far memory grew. */
    const refusedUninflated = (file, why) => {
      const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', measure, pathToFileURL(join(root, 'dist', 'assistant-file-reader.mjs')).href, file], { encoding: 'utf8', timeout: 120_000 });
      assert.equal(child.status, 0, `${why}: ${child.stderr}`);
      const measured = JSON.parse(child.stdout.trim().split('\n').at(-1));
      assert.ok(measured.grewMiB < 48, `${why}: the stream was not inflated (memory grew ${measured.grewMiB} MiB; ${measured.error || 'no error'})`);
      assert.match(measured.error, /i det valda formatet/, `${why}: the archive check refuses it: ${measured.error}`);
    };
    refusedUninflated(bomb, 'a stream larger than its declared size');
    await assert.rejects(readAssistantFile(root, bomb, 'docx', new AbortController().signal), /i det valda formatet/, 'the reader process reports the refusal');
    const storedLie = Buffer.from(`${open}Lagrat 7731${close}`);
    await assert.rejects(readAssistantFile(root, (writeFileSync(bomb, deflatedZip([typesEntry, { name: 'word/document.xml', data: storedLie, size: 10, method: 0 }])), bomb), 'docx', new AbortController().signal), /i det valda formatet/, 'a stored entry must be its declared size');
    // The Word reader's ZIP library reads every entry its central directory lists, whatever count
    // the end record declares, and the last of two entries with one name. Only an archive whose
    // checked entries are exactly its directory is read.
    const honestEntry = { name: 'word/document.xml', data: deflateRawSync(honest), size: honest.length, crc: crc32(honest) };
    // 128 MiB of text that the archive declares truthfully, so the library inflates all of it.
    const filledEntry = async (name, prefix, suffix) => ({ name, data: await deflatedFill(prefix, 128, suffix), size: Buffer.byteLength(prefix) + 128 * 1024 * 1024 + Buffer.byteLength(suffix) });
    const styles = await filledEntry('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults/>', '</w:styles>');
    writeFileSync(bomb, deflatedZip([typesEntry, honestEntry, styles], 2));
    refusedUninflated(bomb, 'an entry the end record does not declare');
    const other = Buffer.from(`${open}Annat dokument 6620${close}`);
    writeFileSync(bomb, deflatedZip([typesEntry, honestEntry, { name: 'word/document.xml', data: deflateRawSync(other), size: other.length, crc: crc32(other) }]));
    refusedUninflated(bomb, 'two entries named word/document.xml');
    // A count of 0xffff entries on this disk makes the library look for a ZIP64 directory instead.
    writeFileSync(bomb, zip64Redirect([typesEntry, honestEntry], await filledEntry('word/document.xml', open, close)));
    refusedUninflated(bomb, 'a ZIP64 directory that lists other entries');
    rmSync(bomb, { force: true });
  }
  const canvas = createCanvas(1200, 240), context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 1200, 240); context.fillStyle = 'black'; context.font = '64px sans-serif'; context.fillText('TABAI TEST 4281', 40, 140);
  const image = await upload(f.chat, 'text.png', canvas.toBuffer('image/png')); assert.equal(image.status, 'ready', image.error); assert.equal(image.ocr, true); assert.ok(image.preview.includes('4281'), image.preview);
  const scanned = await upload(f.chat, 'scanned.pdf', scannedPdf(canvas)); assert.equal(scanned.status, 'ready', scanned.error); assert.equal(scanned.ocr, true); assert.ok(scanned.preview.includes('4281'), scanned.preview);
  await f.chat.clear(); assert.equal(f.chat.view().fileDrafts.length, 0);
  await assert.rejects(f.chat.files.request(owner, new Set([file.id]), { action: 'read', fileId: file.id, offset: 0, limit: 50 }), /hör inte/);
  const source = join(directory, 'abort.txt'); writeFileSync(source, 'Avbryt'); const abort = new AbortController(); abort.abort();
  await assert.rejects(readAssistantFile(root, source, 'text', abort.signal), /avbröts/);
  const restart = await upload(f.chat, 'restart.txt', Buffer.from('Sparas privat')); assert.equal(restart.status, 'ready');
  const conversation = f.chat.view().id, interrupted = randomUUID();
  await f.chat.files.start(conversation, { id: interrupted, name: 'interrupted.txt', size: 10 }, f.chat.attachedFiles());
  await f.chat.close();
  const resumed = new AssistantChat(root, f.dir, f.bridge, f.executor); chats.push(resumed); await resumed.files.ready();
  assert.equal(resumed.view().fileDrafts.find(file => file.id === restart.id).status, 'ready');
  assert.equal(resumed.files.isPage(conversation, restart.id), false, 'an index entry without the mark is an ordinary file');
  assert.equal(resumed.view().fileDrafts.find(file => file.id === interrupted).status, 'failed');
  const stored = join(f.dir, 'attachments', 'files.json'); assert.ok(existsSync(stored) && readFileSync(stored, 'utf8').includes(restart.id));
  await resumed.files.remove(conversation, interrupted); await resumed.files.remove(conversation, interrupted);
  const fault = fixture(), faultId = randomUUID(), faultOwner = fault.chat.view().id;
  await fault.chat.files.start(faultOwner, { id: faultId, name: 'durable.txt', size: 4 }, new Set());
  const store = fault.chat.files.store, save = store.save.bind(store);
  store.save = async () => { throw new Error('Synthetic pre-commit failure'); };
  await assert.rejects(fault.chat.files.append(faultOwner, faultId, 0, Buffer.from('test').toString('base64')), /Synthetic/);
  store.save = save;
  assert.equal(fault.chat.view().fileDrafts[0].received, 0);
  assert.equal(readFileSync(join(fault.dir, 'attachments', `${faultId}.source`)).length, 0);
  await fault.chat.files.append(faultOwner, faultId, 0, Buffer.from('test').toString('base64'));
  let late = true;
  store.save = async (...args) => { await save(...args); if (late) { late = false; throw new Error('Synthetic post-commit failure'); } };
  await fault.chat.files.remove(faultOwner, faultId); store.save = save;
  assert.equal(fault.chat.view().fileDrafts.length, 0);
  assert.equal(existsSync(join(fault.dir, 'attachments', `${faultId}.source`)), false);
  assert.ok(!readFileSync(join(fault.dir, 'attachments', 'files.json.bak'), 'utf8').includes(faultId), 'late commit error cannot leave removed metadata in rollback copy');
  assert.ok(!JSON.stringify(f.chat.view()).includes('.source'));

  // An approval card's image: a host file the user sees, never read, never a draft, removed with its conversation.
  {
    const images = fixture(), owner = images.chat.view().id;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300_000, 7), Buffer.from([0xff, 0xd9])]);
    const image = await images.chat.files.addHostFile(owner, { name: 'Godkännande shop.example 2026-11-03.jpg', bytes: jpeg, source: 'approval' });
    assert.deepEqual([image.status, image.source, image.kind, image.textChars, image.ocr], ['ready', 'approval', 'image', undefined, undefined], 'ready at once and never read as text');
    assert.deepEqual(images.chat.view().fileDrafts, [], 'never a draft the user could send');
    const pieces = [];
    for (let offset = 0, total = 1; offset < total; offset += 192 * 1024) { const piece = await images.chat.files.approvalImage(owner, image.id, offset); total = piece.total; pieces.push(piece); }
    assert.equal(pieces.length, 3, 'about 400 000 base64 characters arrive in three pieces');
    assert.ok(pieces.every(piece => piece.mimeType === 'image/jpeg' && piece.fileId === image.id && piece.base64.length <= 192 * 1024));
    assert.ok(Buffer.from(pieces.map(piece => piece.base64).join(''), 'base64').equals(jpeg), 'the pieces are the stored bytes');
    await assert.rejects(images.chat.files.approvalImage(owner, image.id, 3), /Ogiltig del/, 'an offset inside a base64 quantum is refused');
    await assert.rejects(images.chat.files.approvalImage(randomUUID(), image.id, 0), /hör inte till/, 'another conversation never reads it');
    const text = await upload(images.chat, 'notes.txt', Buffer.from('Underlag'));
    await assert.rejects(images.chat.files.approvalImage(owner, text.id, 0), /finns inte längre/, 'only approval images are served to the panel');
    await assert.rejects(images.chat.files.request(owner, new Set([image.id]), { action: 'read', fileId: image.id, offset: 0, limit: 100 }), /inte tillgänglig för läsning/, 'the model can never read the image as text');
    await assert.rejects(images.chat.files.addHostFile(owner, { name: 'x.jpg', bytes: Buffer.from('<svg/>'), source: 'approval' }), /fel format/, 'bytes that are not JPEG or PNG are refused');
    await assert.rejects(images.chat.files.addHostFile(owner, { name: 'x.jpg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]), source: 'approval' }), /en megabyte/, 'more than one megabyte is refused');
    await images.chat.files.remove(owner, text.id);
    // Images are never the user's drafts, so five of them still leave room for five attachments.
    for (let index = 0; index < 5; index++) await images.chat.files.addHostFile(owner, { name: `Godkännande ${index}.jpg`, bytes: jpeg, source: 'approval' });
    for (let index = 0; index < 5; index++) assert.equal((await upload(images.chat, `fil-${index}.txt`, Buffer.from(`Fil ${index}`))).status, 'ready');
    await images.chat.files.removeConversation(owner);
    assert.equal(existsSync(join(images.dir, 'attachments', `${image.id}.source`)), false, 'the image goes with its conversation');
  }
  console.log('assistant-files: genuine text/PDF/DOCX/OCR, chunk guards, scoped model reads, handoff, removal, cancellation and approval images passed');
} finally { await Promise.all(chats.map(chat => chat.close())); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); stopWatchdog(); }
