// "Den här sidan": the address the model reads, the offer's label, mail pages,
// the shared file's text and the chip's privacy note, as panel and host share them.
import assert from 'node:assert/strict';
import { assistantLinkQuestion, assistantPageAddressForModel, assistantPageFile, assistantPageIsMail, assistantPagePrivacy, assistantSelectionFile, assistantSelectionLabel, assistantShareablePage } from '../dist/assistant-page.mjs';
import { ASSISTANT_PAGE_READ_MS, assistantReadPage } from '../dist/assistant-page-share.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog();

const page = (url, extra = {}) => ({ title: 'Order', url, selection: '', text: 'Sidans synliga text.', truncated: false, ...extra });
const now = new Date('2026-11-03T00:30:00Z');

// Only the parameters that describe the view keep their values; credentials and fragments never follow.
assert.equal(assistantPageAddressForModel('https://kim:pw@shop.example/x?order=4711&q=paket&token=abc#konto'), 'https://shop.example/x?order=dolt&q=paket&token=dolt');
assert.equal(assistantPageAddressForModel('https://shop.example/s?Q=lampa&page=2&p=3&sort=pris&lang=sv&tab=a&view=b&filter=c&category=d&id=7&utm_source=x&ref=y&email=kim%40example.se'),
  'https://shop.example/s?Q=lampa&page=2&p=3&sort=pris&lang=sv&tab=a&view=b&filter=c&category=d&id=7&utm_source=dolt&ref=dolt&email=dolt');
assert.equal(assistantPageAddressForModel('https://shop.example/s?debug&q='), 'https://shop.example/s?debug=&q=', 'an empty value carries nothing');
// Long opaque path segments (reset links, magic links, share keys) are hidden; readable slugs and short ids stay.
for (const [url, expected] of [
  ['https://example.se/magic/eyJhbGciOiJIUzI1NiJ9.e30.sig', 'https://example.se/magic/dolt'],
  ['https://example.se/orders/550e8400-e29b-41d4-a716-446655440000/kvitto', 'https://example.se/orders/dolt/kvitto'],
  ['https://docs.example/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', 'https://docs.example/d/dolt/edit'],
  ['https://example.se/n/123456789012345678901234', 'https://example.se/n/dolt'],
  ['https://example.se/reset-password/9f8e7d6c5b4a3210', 'https://example.se/reset-password/9f8e7d6c5b4a3210'],
  ['https://example.se/2026-11-03-arets-basta-recept-pa-kottbullar', 'https://example.se/2026-11-03-arets-basta-recept-pa-kottbullar'],
  ['https://example.se/how-to-make-swedish-meatballs-at-home', 'https://example.se/how-to-make-swedish-meatballs-at-home'],
  ['https://example.se/c?eyJhbGciOiJIUzI1NiJ9abcdefgh12', 'https://example.se/c?dolt='],
]) assert.equal(assistantPageAddressForModel(url), expected, url);
const once = assistantPageAddressForModel('https://example.se/magic/eyJhbGciOiJIUzI1NiJ9.e30.sig?q=a+b&token=t');
assert.equal(assistantPageAddressForModel(once), once, 'the host can apply it again to what the panel sent');

// The label never carries direction marks, overrides, isolates or line breaks.
const override = String.fromCharCode(0x202e), isolate = String.fromCharCode(0x2066), mark = String.fromCharCode(0x200f);
assert.equal(assistantShareablePage('https://example.se/%E2%80%AEtxt.exe'), 'example.se/txt.exe');
assert.equal(assistantShareablePage('https://example.se/a%0Ab%0Dc'), 'example.se/abc');
assert.equal(assistantShareablePage('https://example.se/%E2%81%A6x%E2%81%A9%E2%80%8Fy%E2%80%A8z'), 'example.se/xyz');
for (const label of [assistantShareablePage('https://example.se/%E2%80%AE%E2%81%A6%E2%80%8F')]) assert.ok(![override, isolate, mark].some(character => label.includes(character)));
assert.equal(assistantShareablePage('https://example.se/sv/%C3%A5r'), 'example.se/sv/år', 'ordinary letters are shown decoded');
for (const url of ['chrome://settings', 'file:///Users/x/a.html', 'https://example.se/doc.PDF', 'https://chromewebstore.google.com/detail/x', 'about:blank']) assert.equal(assistantShareablePage(url), undefined, url);

// Mail and calendar belong to Mejl: those pages are never offered for sharing.
for (const url of ['https://mail.google.com/mail/u/0/#inbox', 'https://calendar.google.com/calendar/r', 'https://outlook.cloud.microsoft/mail/', 'https://outlook.office.com/calendar/', 'https://mail.zoho.eu/zm/', 'https://calendar.zoho.com/'])
  assert.equal(assistantPageIsMail(url), true, url);
// Trailing dots never turn a mail host into an ordinary page.
for (const url of ['https://mail.google.com./mail/u/0/', 'https://mail.google.com../mail/u/0/'])
  assert.equal(assistantPageIsMail(url), true, url);
for (const url of ['https://example.se/', 'https://docs.google.com/document/d/x', 'https://mail.example.se/', undefined, 'inte en adress']) assert.equal(assistantPageIsMail(url), false, String(url));

// The file: title, the model's address, a selection unless it is nearly the whole page, then the page.
const file = assistantPageFile(page('https://shop.example/order?order=4711&token=abc#konto', { selection: 'Synliga' }), 'Europe/Stockholm', now);
assert.equal(file.text, 'Delad sida från din egen flik\nTitel: Order\nAdress: https://shop.example/order?order=dolt&token=dolt\nDelad: 2026-11-03 kl. 01.30\n\nMarkerad text:\nSynliga\n\nSidans text:\nSidans synliga text.');
assert.deepEqual([file.name, file.label, file.address, file.truncated], ['Sida shop.example 2026-11-03.txt', 'shop.example/order', 'https://shop.example/order?order=dolt&token=dolt', false]);
const text = 'x'.repeat(1000);
assert.equal(assistantPageFile(page('https://shop.example/', { text, selection: 'x'.repeat(900) }), 'Europe/Stockholm', now).text.includes('Markerad text'), false, '90 % of the page is the page itself');
assert.equal(assistantPageFile(page('https://shop.example/', { text, selection: 'x'.repeat(899) }), 'Europe/Stockholm', now).text.includes('Markerad text'), true, 'a smaller selection is kept');
assert.equal(assistantPageFile(page('https://shop.example/', { text: 'Rad ett.\nRad två.', selection: 'Rad ett. Rad  två.' }), 'Europe/Stockholm', now).text.includes('Markerad text'), false, 'the page text is judged word for word, not by its line breaks');
// Text in an editor never joins the page text, so a selection made there is not part of it: it is kept, however long.
const inEditor = assistantPageFile(page('https://shop.example/', { text: 'Kort sida.', selection: 'Ett långt utkast i redigeraren, längre än hela sidans text.' }), 'Europe/Stockholm', now);
assert.match(inEditor.text, /\n\nMarkerad text:\nEtt långt utkast i redigeraren, längre än hela sidans text\.\n\nSidans text:\nKort sida\.$/, 'a selection the page text does not contain is kept');
assert.match(assistantPageFile(page('https://shop.example/', { text: '', selection: 'Bara utkastet.' }), 'Europe/Stockholm', now).text, /\n\nMarkerad text:\nBara utkastet\.\n\nSidans text:\n$/, 'also on a page without page text');
const cut = assistantPageFile(page('https://shop.example/', { text: 'y'.repeat(500_000), truncated: true }), 'Europe/Stockholm', now);
assert.equal(cut.text.length, 500_000); assert.equal(cut.truncated, true); assert.match(cut.text, /\[Texten är kapad vid 500 000 tecken\. Resten av sidan kom inte med\.\]$/);

// "Fråga Tabai om ”…”": only the selection follows, with the model's address; the title and the rest of the page stay.
const chosen = assistantSelectionFile(page('https://shop.example/order?order=4711&token=abc#konto', { title: 'Order 4711 – Kim', selection: '  Paketet lämnade lagret.  ', text: 'Leverans för Kim. Paketet lämnade lagret.' }), 'Europe/Stockholm', now);
assert.equal(chosen.text, 'Markerad text från din egen flik\nAdress: https://shop.example/order?order=dolt&token=dolt\nDelad: 2026-11-03 kl. 01.30\n\nMarkerad text:\nPaketet lämnade lagret.');
assert.deepEqual([chosen.name, chosen.label, chosen.address, chosen.truncated], ['Markering shop.example 2026-11-03.txt', 'Markerad text från shop.example', 'https://shop.example/order?order=dolt&token=dolt', false]);
assert.equal(chosen.text.includes('Kim'), false, 'neither the title nor the unselected text follows');
assert.equal(assistantSelectionFile(page('https://shop.example/', { selection: ' \n ' }), 'Europe/Stockholm', now), undefined, 'no selection, no file');
const longSelection = assistantSelectionFile(page('https://shop.example/', { selection: 'z'.repeat(500_000) }), 'Europe/Stockholm', now);
assert.equal(longSelection.text.length, 500_000); assert.equal(longSelection.truncated, true, 'the same size cap as Dela');
assert.equal(assistantSelectionLabel('https://shop.example:8443/x'), 'Markerad text från shop.example:8443');
// "Fråga Tabai om länken" only fills in a question about an ordinary link, without its fragment or credentials.
assert.equal(assistantLinkQuestion('https://kim:pw@shop.example/produkt?id=7#recensioner'), 'Vad finns på https://shop.example/produkt?id=7?');
for (const url of ['javascript:alert(1)', 'chrome://settings', 'file:///etc/passwd', 'mailto:kim@example.se', 'inte en adress', undefined]) assert.equal(assistantLinkQuestion(url), undefined, String(url));

// The chip: the page's text goes only to the chat model, never along to a task.
assert.equal(assistantPagePrivacy('local:qwen3.5:4b-q4_K_M'), 'Sidans text stannar på datorn. Bara den lokala chattmodellen läser den, och den följer aldrig med till uppdrag. Delningen gäller bara det här samtalet.');
assert.equal(assistantPagePrivacy('codex:gpt-6.1-terra'), 'Sidans text skickas till OpenAI via Codex när du skickar. Bara chattmodellen läser den, och den följer aldrig med till uppdrag. Delningen gäller bara det här samtalet.');
for (const model of ['claude:x', 'berget:y', undefined]) assert.match(assistantPagePrivacy(model), /följer aldrig med till uppdrag/);
// The read on the user's tap: at most 15 s, then the late result is never used; mail is never read.
assert.equal(ASSISTANT_PAGE_READ_MS, 15_000);
let script, scripted = 0;
const injections = [];
globalThis.chrome = {
  tabs: { get: async tabId => ({ id: tabId, active: true, windowId: 1, url: tabId === 2 ? 'https://mail.google.com/mail/u/0/' : 'https://shop.example/order' }) },
  scripting: { executeScript: injection => { scripted++; injections.push(injection); return script(); } },
};
const active = { tabId: 1, windowId: 1, address: 'https://shop.example/order', label: 'shop.example/order', mail: false };
script = () => new Promise(() => {});
const started = Date.now();
await assert.rejects(assistantReadPage(active, 50), /Sidan svarade inte inom 15 sekunder\. Ladda om sidan och tryck Dela igen\./, 'a page that never answers ends the read');
assert.ok(Date.now() - started < 5_000);
script = async () => [{ result: { title: 'Order', url: 'https://shop.example/order', contentType: 'text/html', selection: '', text: 'Order 4711', truncated: false } }];
assert.deepEqual(await assistantReadPage(active, 1_000), { title: 'Order', url: 'https://shop.example/order', selection: '', text: 'Order 4711', truncated: false });
script = async () => [{ result: { title: 'Annan', url: 'https://other.example/', contentType: 'text/html', selection: '', text: 'x', truncated: false } }];
await assert.rejects(assistantReadPage(active, 1_000), /bytts till en annan webbplats/);
const before = scripted;
await assert.rejects(assistantReadPage({ ...active, tabId: 2, address: 'https://mail.google.com/mail/u/0/', label: 'mail.google.com/mail/u/0/', mail: true }, 1_000), /Mejlen hanteras i Mejl/);
assert.equal(scripted, before, 'a mail page is never scripted');
// The read runs once, in the tab's main frame only and in the extension's isolated world, where
// the page's own scripts cannot replace the functions it reads the page with.
{
  const { target, world, func, args } = injections.at(-1);
  assert.deepEqual({ target, world, func: func.name, args }, { target: { tabId: 1, frameIds: [0] }, world: 'ISOLATED', func: 'readSharedPage', args: [500_000] });
}
// A page that is editable as a whole has no page text; the panel then asks for a selection
// instead of reporting an empty page. An ordinary page without text is still refused.
script = async () => [{ result: { title: 'Utkast', url: 'https://shop.example/order', contentType: 'text/html', selection: '', text: '', truncated: false, editable: true } }];
assert.deepEqual(await assistantReadPage(active, 1_000), { title: 'Utkast', url: 'https://shop.example/order', selection: '', text: '', truncated: false, editable: true });
script = async () => [{ result: { title: 'Tom', url: 'https://shop.example/order', contentType: 'text/html', selection: '', text: '', truncated: false } }];
await assert.rejects(assistantReadPage(active, 1_000), /Sidan visar ingen text som kan delas\./);
// A page whose only text is in an editor asks for a selection too, instead of reporting an empty page.
script = async () => [{ result: { title: 'Skriv', url: 'https://shop.example/order', contentType: 'text/html', selection: '', text: '', truncated: false, editable: false, typed: true } }];
assert.deepEqual(await assistantReadPage(active, 1_000), { title: 'Skriv', url: 'https://shop.example/order', selection: '', text: '', truncated: false, typed: true });
delete globalThis.chrome;
stopWatchdog();
console.log('assistant-page-share: a bounded read on the tap, model addresses with only view parameters, hidden opaque segments, safe labels, no offer for mail, selections that are not the whole page, selection-only files, link questions, truncation and the chip note passed');
