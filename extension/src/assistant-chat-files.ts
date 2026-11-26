import { node } from './module-views';
import { icon, iconButton, type AssistantAction } from './assistant-controls';
import { assistantPageAddressForModel, assistantPagePrivacy, assistantSelectionLabel, assistantShareablePage } from '../../shared/assistant-page';
import { ASSISTANT_FILE_BYTES, ASSISTANT_FILE_CHUNK, ASSISTANT_FILES_PER_MESSAGE, assistantFileKind, type AssistantFile } from '../../shared/assistant-files';
import type { AssistantChatView } from '../../shared/assistant-chat';

const accept = '.pdf,.docx,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.log,.yaml,.yml,.png,.jpg,.jpeg,.webp';
const labels = { uploading: 'Laddar upp', queued: 'Väntar på läsning', reading: 'Läser filen', ready: 'Klar', failed: 'Kunde inte läsa filen' };
const notRemoved = 'Bilagan kunde inte tas bort. Kontrollera status innan du försöker igen.';
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} MB`;

export function renderChatFile(file: AssistantFile): HTMLElement {
  const result = node('section', '', 'assistant-sent-file'); result.dataset.fileId = file.id;
  result.append(node('strong', file.name), node('p', `${size(file.size)}${file.pages ? ` · ${file.pages} ${file.kind === 'pdf' ? file.pages === 1 ? 'sida' : 'sidor' : 'del'}` : ''}${file.ocr ? ' · Bildtext avläst med OCR' : ''}`, 'muted'));
  if (file.preview) { const details = node('details'); details.append(node('summary', 'Förhandsvisning av läst text'), node('pre', file.preview, 'assistant-file-preview')); result.append(details); }
  if (file.ocr) result.append(node('p', 'Kontrollera namn, belopp och datum mot originalet.', 'muted'));
  return result;
}

/** The file stays local until sent; chunks never enter browser storage. */
export class AssistantChatFiles {
  readonly element = node('div', '', 'assistant-chat-files');
  private picker = node('input');
  private list = node('div', '', 'assistant-file-list');
  private error = node('p', '', 'module-error');
  private view?: AssistantChatView;
  private local = new Map<string, { conversationId: string; file: AssistantFile }>();
  private rows = new Map<string, { element: HTMLElement; name: HTMLElement; status: HTMLElement; remove: HTMLButtonElement; progress: HTMLProgressElement }>();
  private cancelled = new Set<string>();
  private uploading?: string;
  private hostBusy = false;
  /** Steps waiting for the card to be free; see `whenFree`. */
  private waiting: (() => void)[] = [];
  private dragDepth = 0;
  private preventNavigation = (event: DragEvent) => { if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault(); };
  /** `quiet` carries the chunks of an upload: no busy card, redraw or poll per chunk. Start, finish and remove use `act` once the card is free. */
  constructor(private composer: HTMLElement, private act: AssistantAction, private changed: () => void, private quiet: AssistantAction = act) {
    this.picker.type = 'file'; this.picker.multiple = true; this.picker.accept = accept; this.picker.hidden = true;
    this.picker.setAttribute('aria-label', 'Välj filer att bifoga'); this.error.setAttribute('role', 'alert');
    this.picker.onchange = () => { const files = Array.from(this.picker.files ?? []); this.picker.value = ''; void this.add(files); };
    this.element.append(this.picker, this.list, this.error);
    composer.addEventListener('dragenter', this.dragEnter); composer.addEventListener('dragleave', this.dragLeave);
    composer.addEventListener('dragover', this.dragOver); composer.addEventListener('drop', this.drop);
    window.addEventListener('dragover', this.preventNavigation); window.addEventListener('drop', this.preventNavigation);
  }
  private dragEnter = (event: DragEvent) => { if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) { event.preventDefault(); this.dragDepth++; this.composer.dataset.fileDrag = 'true'; } };
  private dragLeave = () => { if (--this.dragDepth <= 0) { this.dragDepth = 0; delete this.composer.dataset.fileDrag; } };
  private dragOver = (event: DragEvent) => { if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } };
  private drop = (event: DragEvent) => { event.preventDefault(); this.dragDepth = 0; delete this.composer.dataset.fileDrag; void this.add(Array.from(event.dataTransfer?.files ?? [])); };
  dispose() { this.composer.removeEventListener('dragenter', this.dragEnter); this.composer.removeEventListener('dragleave', this.dragLeave); this.composer.removeEventListener('dragover', this.dragOver); this.composer.removeEventListener('drop', this.drop); window.removeEventListener('dragover', this.preventNavigation); window.removeEventListener('drop', this.preventNavigation); }
  update(view?: AssistantChatView) { this.view = view; this.render(); }
  setBusy(busy: boolean) {
    this.hostBusy = busy;
    if (!busy) for (const resume of this.waiting.splice(0)) resume();
    this.render();
  }
  /**
   * Sends one of an upload's ordinary actions (start, finish, remove) once the card is free. The card
   * refuses an action without sending anything while another one holds it, and the quiet chunks do not
   * hold it, so Stopp, a search or a draft save can be running when an upload gets here. The card marks
   * itself busy and tells this list in one step, and the check below and the call run in one step too,
   * so the card cannot become busy in between: the action is sent once, never again. `skip` is asked
   * after the wait, because the user may have cancelled the upload meanwhile; then nothing is sent and
   * the answer is undefined.
   */
  private async whenFree(input: Record<string, string>, skip = () => false): Promise<boolean | undefined> {
    while (this.hostBusy) await new Promise<void>(resume => this.waiting.push(resume));
    return skip() ? undefined : this.act('correct', input);
  }
  private current(): AssistantFile[] {
    const files = new Map((this.view?.fileDrafts ?? []).map(file => [file.id, file]));
    // The file on its way up is shown from here: its chunks do not redraw the view, so only this copy knows how far it got.
    for (const [id, local] of this.local) if (local.conversationId === this.view?.id && (!files.has(id) || local.file.status === 'failed' || this.uploading === id)) files.set(id, local.file);
    return [...files.values()];
  }
  get ids(): string[] { return this.current().filter(file => file.status === 'ready').map(file => file.id); }
  get pending(): boolean { return !!this.uploading || this.current().some(file => file.status !== 'ready'); }
  get hasFiles(): boolean { return this.current().length > 0; }
  /** Why a new file cannot be added right now, or an empty string when it can. */
  get blocked(): string {
    if (!this.view || this.view.fileDrafts === undefined) return 'Bilagor behöver en uppdaterad Tabai-server.';
    if (this.view.fileError) return this.view.fileError;
    if (this.hostBusy || this.uploading) return 'Vänta tills uppladdningen är klar.';
    return this.current().length >= ASSISTANT_FILES_PER_MESSAGE ? 'Högst fem filer per meddelande.' : '';
  }
  openPicker() { if (!this.blocked) this.picker.click(); }
  /** Whether this page is already a draft in the open conversation; a shared selection of it, or a share that failed, is not the page. */
  hasPage(address: string): boolean { const shared = assistantPageAddressForModel(address); return this.current().some(file => file.source === 'page' && !file.pageSelection && file.status !== 'failed' && file.pageUrl === shared); }
  /** Whether a selection from this page is a ready draft in the open conversation. */
  hasSelection(address: string): boolean { const shared = assistantPageAddressForModel(address); return this.current().some(file => file.source === 'page' && file.pageSelection && file.status === 'ready' && file.pageUrl === shared); }
  /** A shared page or selection, uploaded through the same chunks as a picked file; the host keeps its mark. */
  addPage(file: File, page: { url: string; truncated: boolean; selection?: boolean }) { return this.add([file], page); }
  /**
   * A draft is a page by the host's own mark, so the chip survives a reload of the
   * panel: its label and privacy note come from the stored address, not panel memory.
   */
  private page(file: AssistantFile) {
    if (file.source !== 'page' || !file.pageUrl) return undefined;
    return file.pageSelection ? { label: assistantSelectionLabel(file.pageUrl), address: file.pageUrl, selection: true }
      : { label: assistantShareablePage(file.pageUrl) ?? new URL(file.pageUrl).host, address: file.pageUrl, selection: false };
  }
  showError(text: string) { this.error.textContent = text; this.render(); }
  private render() {
    const files = this.current();
    for (const file of files) {
      let row = this.rows.get(file.id);
      const page = this.page(file);
      if (!row) {
        const element = node('section', '', page ? 'assistant-file-row assistant-page-chip' : 'assistant-file-row'), heading = node('strong'), name = node('span'), status = node('p', '', 'muted'), progress = node('progress');
        element.setAttribute('aria-label', page ? page.selection ? page.label : `Delad sida ${page.label}` : `Bilaga ${file.name}`);
        const remove = iconButton('close', page ? page.selection ? `Sluta dela den markerade texten från ${new URL(page.address).host}` : `Sluta dela sidan ${page.label}` : `Ta bort bilagan ${file.name}`, () => void this.remove(file.id), 'assistant-file-remove'); remove.dataset.removeFile = file.id;
        if (page) { element.dataset.page = 'true'; element.title = page.address; heading.append(icon('globe')); }
        heading.append(name); element.dataset.fileId = file.id; element.append(heading, status, progress, remove); row = { element, name, status, progress, remove }; this.rows.set(file.id, row); this.list.append(element);
      }
      // The chip says how much of the page is shared and where its text goes before the user sends it.
      row.name.textContent = page ? page.selection ? page.label : `Sida: ${page.label}` : file.name;
      const privacy = page?.selection ? assistantPagePrivacy(this.view?.model).replace(/^Sidans text/, 'Den markerade texten') : assistantPagePrivacy(this.view?.model);
      row.status.textContent = file.error || (page && file.status === 'ready' ? `${(file.textChars ?? 0).toLocaleString('sv-SE')} tecken${file.pageTruncated ? ' · kapad' : ''} · ${privacy}`
        : `${labels[file.status]} · ${size(file.size)}${file.status === 'ready' ? ` · ${file.textChars?.toLocaleString('sv-SE')} tecken${file.ocr ? ' · OCR, kontrollera mot originalet' : ''}` : ''}`);
      row.progress.hidden = file.status !== 'uploading'; row.progress.max = file.size; row.progress.value = file.received; row.progress.setAttribute('aria-label', `Uppladdning av ${file.name}`);
      row.element.dataset.fileStatus = file.status; row.remove.disabled = this.cancelled.has(file.id) || this.hostBusy && this.uploading !== file.id;
    }
    for (const [id, row] of this.rows) if (!files.some(file => file.id === id)) { row.element.remove(); this.rows.delete(id); }
    if (this.view?.fileError) this.error.textContent = this.view.fileError;
    this.error.hidden = !this.error.textContent;
  }
  private async remove(id: string) {
    this.cancelled.add(id); this.render();
    if (this.uploading === id) return;
    const conversationId = this.view?.id;
    const ok = await this.whenFree({ action: 'chat-file-remove', conversationId: conversationId!, fileId: id });
    if (ok) this.local.delete(id); else this.error.textContent = notRemoved;
    this.cancelled.delete(id); this.render(); this.changed();
  }
  private async add(files: File[], page?: { url: string; truncated: boolean; selection?: boolean }) {
    const conversationId = this.view?.id;
    if (!files.length) return;
    if (!conversationId || this.blocked) { this.error.textContent = 'Vänta tills uppladdningen är klar, eller öppna chatten igen.'; this.render(); return; }
    if (this.current().length + files.length > ASSISTANT_FILES_PER_MESSAGE) { this.error.textContent = 'Bifoga högst fem filer åt gången.'; this.render(); return; }
    this.error.textContent = '';
    for (const source of files) {
      const kind = assistantFileKind(source.name);
      if (!kind || !source.size || source.size > ASSISTANT_FILE_BYTES) { this.error.textContent = `${source.name}: välj en fil av angiven typ, högst 10 MB, med innehåll.`; continue; }
      const id = crypto.randomUUID(), file: AssistantFile = { id, name: source.name, size: source.size, kind, status: 'uploading', received: 0, ...(page ? { source: 'page' as const, pageUrl: page.url, ...(page.truncated ? { pageTruncated: true as const } : {}), ...(page.selection ? { pageSelection: true as const } : {}) } : {}) };
      this.local.set(id, { conversationId, file }); this.uploading = id; this.render(); this.changed();
      const isCancelled = () => this.cancelled.has(id);
      // Whether the start was sent: from then on the host may hold the file, so a cancel removes it there.
      let started = false;
      try {
        const marked = page ? { source: 'page', pageUrl: page.url, ...(page.truncated ? { pageTruncated: 'true' } : {}), ...(page.selection ? { pageSelection: 'true' } : {}) } : {};
        const opened = await this.whenFree({ action: 'chat-file-start', conversationId, fileId: id, name: source.name, size: String(source.size), ...marked }, isCancelled);
        started = opened !== undefined;
        if (opened === false) throw new Error('Uppladdningen kunde inte startas.');
        for (let offset = 0; started && offset < source.size && !isCancelled(); offset += ASSISTANT_FILE_CHUNK) {
          const bytes = new Uint8Array(await source.slice(offset, offset + ASSISTANT_FILE_CHUNK).arrayBuffer());
          let binary = ''; for (let part = 0; part < bytes.length; part += 4096) binary += String.fromCharCode(...bytes.subarray(part, part + 4096));
          if (isCancelled()) break;
          // Each chunk still waits for the host's acknowledgement before the next one is read.
          if (!await this.quiet('correct', { action: 'chat-file-chunk', conversationId, fileId: id, offset: String(offset), fileChunk: btoa(binary) })) throw new Error('Uppladdningen kunde inte bekräftas. Ta bort filen och välj den igen.');
          file.received = offset + bytes.length; this.render();
        }
        if (started && !isCancelled()) {
          // The host holds every byte; the finish waits for a free card rather than failing the file.
          const finished = await this.whenFree({ action: 'chat-file-finish', conversationId, fileId: id }, isCancelled);
          if (finished === false) throw new Error('Filläsningen kunde inte startas.');
          if (finished) this.local.delete(id);
        }
      } catch (error) { file.status = 'failed'; file.error = error instanceof Error ? error.message : 'Uppladdningen avbröts.'; }
      finally {
        if (isCancelled()) {
          // A file the host never heard of goes from this panel only. One it may hold is removed there; if
          // that fails, the row says so instead of staying on "Laddar upp".
          if (!started || await this.whenFree({ action: 'chat-file-remove', conversationId, fileId: id })) this.local.delete(id);
          else { file.status = 'failed'; file.error = notRemoved; }
          this.cancelled.delete(id);
        }
        this.uploading = undefined; this.render(); this.changed();
      }
    }
    this.render(); this.changed();
  }
}
