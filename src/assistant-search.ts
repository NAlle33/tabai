import { setImmediate } from 'node:timers/promises';
import { assistantSearchViewSchema, type AssistantSearchResult, type AssistantSearchView } from '../shared/assistant-search';

export type AssistantSearchDocument = Omit<AssistantSearchResult, 'snippet'> & { read(): string | { text: string; title: string; date: string } | Promise<string | { text: string; title: string; date: string }>; bytes?: number };
const normalized = (text: string) => text.normalize('NFC').toLocaleLowerCase('sv-SE');
const unreadableWarning = 'En sparad källa kunde inte läsas säkert. Sökningen är ofullständig.';

/** A bounded, local scan. The cursor lets large collections be searched without holding up other work. */
export async function searchAssistantDocuments(query: string, sources: AsyncIterable<AssistantSearchDocument>, offset = 0,
  limits = { bytes: 16 * 1024 * 1024, documents: 500, milliseconds: 1500 }): Promise<AssistantSearchView> {
  query = query.trim().slice(0, 200);
  const terms = normalized(query).split(/\s+/u).filter(Boolean);
  const view: AssistantSearchView = { query, results: [], scanned: 0, warnings: [] };
  if (!terms.length) return view;
  let index = 0;
  let bytes = 0;
  const started = Date.now();
  const found = new Set<string>();
  for await (let source of sources) {
    if (index++ < offset) continue;
    const limitReached = view.scanned > 0 && (
      view.scanned >= limits.documents
      || bytes + (source.bytes ?? 0) > limits.bytes
      || Date.now() - started >= limits.milliseconds
      || view.results.length >= 100
    );
    if (limitReached) {
      view.nextOffset = index - 1;
      break;
    }
    view.scanned++;
    try {
      const read = await source.read();
      const text = typeof read === 'string' ? read : read.text;
      bytes += Buffer.byteLength(text);
      if (typeof read !== 'string') source = { ...source, title: read.title, date: read.date };

      const content = `${source.title}\n${text}`;
      const lower = normalized(content);
      if (!terms.every(term => lower.includes(term))) continue;

      const key = `${source.kind}\0${source.id}\0${source.conversationId ?? ''}`;
      if (found.has(key)) continue;
      found.add(key);

      const position = Math.max(0, lower.indexOf(terms[0]) - 75);
      const snippet = content.slice(position, position + 340).replace(/\s+/g, ' ').trim();
      const { read: _read, bytes: _bytes, ...metadata } = source;
      view.results.push({ ...metadata, snippet: `${position ? '…' : ''}${snippet}${position + 340 < content.length ? '…' : ''}` });
    } catch {
      if (!view.warnings.includes(unreadableWarning)) view.warnings.push(unreadableWarning);
    }
    if (view.scanned % 20 === 0) await setImmediate();
  }
  view.results.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return assistantSearchViewSchema.parse(view);
}
