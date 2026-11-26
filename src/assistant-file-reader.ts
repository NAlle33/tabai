import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import * as z from 'zod';
import { ASSISTANT_FILE_BYTES, ASSISTANT_FILE_TEXT, assistantFileKindSchema, type AssistantFileKind } from '../shared/assistant-files';
import { readPrivateFile } from './private-storage';

export const parsedAssistantFileSchema = z.object({ text: z.string().min(1).max(ASSISTANT_FILE_TEXT), pages: z.number().int().min(1).max(100), ocr: z.boolean() }).strict();
export type ParsedAssistantFile = z.infer<typeof parsedAssistantFileSchema>;
const require = createRequire(import.meta.url);
class FileReadingError extends Error {}
const invalid = () => new FileReadingError('Filen kunde inte läsas i det valda formatet. Kontrollera att filen är hel och inte lösenordsskyddad.');
const MAX_READER_OUTPUT_BYTES = 4 * 1024 * 1024;
const READER_TIMEOUT_MS = 90_000;

function readerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function checkedText(text: string): string {
  const cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!cleaned) throw new FileReadingError('Ingen läsbar text hittades i filen.');
  if (cleaned.length > ASSISTANT_FILE_TEXT) throw new FileReadingError('Filen innehåller för mycket text. Dela upp den i mindre filer.');
  return cleaned;
}

/**
 * A declared size is the archive's own claim. Each entry is inflated here with a hard output
 * limit of its declared size and must be exactly that size, so a stream that inflates further
 * is refused at the limit instead of being inflated in full by the Word reader. The sizes and
 * data offsets are the central directory's, as the Word reader's ZIP library reads them.
 */
function checkWordEntry(bytes: Buffer, local: number, method: number, compressed: number, size: number): void {
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (start + compressed > bytes.length) throw invalid();
  const data = bytes.subarray(start, start + compressed);
  let length: number;
  if (method === 0) length = data.length;
  else if (method === 8) {
    try { length = compressed ? inflateRawSync(data, { maxOutputLength: Math.max(1, size) }).length : 0; }
    catch { throw invalid(); }
  } else throw invalid();
  if (length !== size) throw invalid();
}

/**
 * Validate archive bounds before the Word reader allocates decompressed XML. Its ZIP library reads
 * every record the central directory holds, whatever count the end record declares, keeps the last
 * of two entries with one name, and looks for a ZIP64 directory elsewhere in the file when the
 * count on this disk is 0xffff. So the checked entries must be the whole directory: as many as
 * both counts declare, ending exactly where the directory's declared size ends, at the end record,
 * each name once.
 */
function checkWordArchive(bytes: Buffer): void {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalid();
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  let offset = start, total = 0, document = false;
  if (count > 2000 || count === 65535 || bytes.readUInt16LE(end + 8) !== count || start + bytes.readUInt32LE(end + 12) !== end) throw invalid();
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (names.has(name)) throw invalid();
    names.add(name);
    total += size;
    if (size > 8 * 1024 * 1024 || total > 20 * 1024 * 1024 || bytes.readUInt16LE(offset + 8) & 1) throw invalid();
    checkWordEntry(bytes, bytes.readUInt32LE(offset + 42), bytes.readUInt16LE(offset + 10), bytes.readUInt32LE(offset + 20), size);
    if (name === 'word/document.xml') document = true;
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (offset !== end || !document) throw invalid();
}

/** Refuse decompression bombs before asking a native decoder to allocate pixels. */
function imageDimensions(bytes: Buffer): { width: number; height: number } {
  let width = 0, height = 0;
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length > 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (kind === 'VP8 ') { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw invalid();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width * height > 20_000_000 || Math.max(width, height) > 20_000) throw new FileReadingError('Bilden är oläsbar eller för stor. Använd PNG, JPG eller WebP med högst 20 megapixel.');
  return { width, height };
}

export async function parseAssistantFile(bytes: Buffer, kind: AssistantFileKind): Promise<ParsedAssistantFile> {
  // Every parser receives bytes, never a document-supplied path or URL. Network
  // access is disabled even if a dependency tries to fetch an optional asset.
  globalThis.fetch = async () => { throw new Error('File processing is offline'); };
  let ocrWorker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | undefined;
  const recognize = async (image: Buffer) => {
    if (!ocrWorker) {
      const { createWorker } = await import('tesseract.js');
      const language = require('@tesseract.js-data/swe') as { langPath: string; gzip: boolean };
      ocrWorker = await createWorker('swe', 1, { langPath: language.langPath, gzip: language.gzip, cacheMethod: 'none', logger: () => {} });
    }
    return (await ocrWorker.recognize(image)).data.text;
  };
  try {
    if (kind === 'text') {
      let text: string;
      if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
      else {
        if (bytes.includes(0)) throw invalid();
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { text = new TextDecoder('windows-1252').decode(bytes); }
      }
      return { text: checkedText(text), pages: 1, ocr: false };
    }
    if (kind === 'docx') {
      checkWordArchive(bytes);
      const mammoth = await import('mammoth');
      return { text: checkedText((await mammoth.extractRawText({ buffer: bytes })).value), pages: 1, ocr: false };
    }
    if (kind === 'image') {
      const { width, height } = imageDimensions(bytes);
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const scale = Math.min(1, 2400 / Math.max(width, height));
      const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))), context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(await loadImage(bytes), 0, 0, canvas.width, canvas.height);
      return { text: checkedText(await recognize(canvas.toBuffer('image/png'))), pages: 1, ocr: true };
    }
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw invalid();
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const document = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, disableFontFace: true, verbosity: 0,
      standardFontDataUrl: join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').split(sep).join('/') + '/' }).promise;
    try {
      if (!document.numPages || document.numPages > 100) throw new FileReadingError('En PDF får innehålla högst 100 sidor. Dela upp filen.');
      const pages: string[] = []; let scanned = 0, characters = 0, readable = false;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), content = await page.getTextContent();
        let text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        if (!text.trim()) {
          if (++scanned > 10) throw new FileReadingError('En skannad PDF får innehålla högst 10 bildsidor. Dela upp filen.');
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 2000 / Math.max(original.width, original.height)) });
          const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
          await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport, background: '#ffffff' }).promise;
          text = await recognize(canvas.toBuffer('image/png'));
        }
        readable ||= !!text.trim(); pages.push(`--- Sida ${number} ---\n${text}`); characters += text.length;
        if (characters > ASSISTANT_FILE_TEXT) throw new FileReadingError('PDF-filen innehåller för mycket text. Dela upp den.');
        page.cleanup();
      }
      if (!readable) throw new FileReadingError('Ingen läsbar text hittades i PDF-filen.');
      return { text: checkedText(pages.join('\n\n')), pages: document.numPages, ocr: scanned > 0 };
    } finally { await document.destroy(); }
  } finally { await ocrWorker?.terminate(); }
}

/** A native parser crash or expensive document cannot take the broker down. */
export function readAssistantFile(root: string, path: string, kind: AssistantFileKind, signal: AbortSignal): Promise<ParsedAssistantFile> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', join(root, 'dist', 'assistant-file-reader.mjs'), '--parse-file', path, kind], {
      cwd: root,
      env: readerEnvironment(),
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    });
    let output = '', bytes = 0, stopped = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, READER_TIMEOUT_MS); timer.unref();
    signal.addEventListener('abort', stop, { once: true });
    child.stdin.end();
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_READER_OUTPUT_BYTES) stop();
      else output += chunk;
    });
    child.on('error', () => { stopped = true; });
    child.once('close', (code, signalCode) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop);
      if (stopped || signal.aborted) { reject(new Error('Filläsningen avbröts eller tog för lång tid. Prova en mindre fil.')); return; }
      if (code !== 0 || signalCode) { reject(new Error('Filläsaren avslutades oväntat. Prova en annan eller mindre fil.')); return; }
      try {
        const result = JSON.parse(output);
        if (result.ok !== true) { reject(new Error(typeof result.error === 'string' ? result.error.slice(0, 500) : 'Filen kunde inte läsas.')); return; }
        resolve(parsedAssistantFileSchema.parse(result.data));
      } catch { reject(new Error('Filen kunde inte läsas säkert. Prova en annan fil.')); }
    });
    if (signal.aborted) stop();
  });
}

if (process.argv[2] === '--parse-file') {
  void (async () => {
    try { const data = await parseAssistantFile(readPrivateFile(process.argv[3], ASSISTANT_FILE_BYTES), assistantFileKindSchema.parse(process.argv[4])); process.stdout.write(JSON.stringify({ ok: true, data }) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof FileReadingError ? error.message : 'Filen kunde inte läsas. Den kan vara skadad eller lösenordsskyddad.' }) + '\n'); }
  })();
}
