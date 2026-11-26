import { node } from './module-views';
import { button } from './assistant-controls';
import type { AssistantApprovalImage } from '../../shared/assistant-files';
import type { AssistantWebApproval } from '../../shared/assistant-web';

/** One piece of an approval card's image from the host; undefined when the host sent none. */
export type AssistantPreviewFetch = (fileId: string, offset: number) => Promise<AssistantApprovalImage | undefined>;

/** At most one megabyte arrives in pieces of 192 KiB of base64: never more than eight requests. */
const MAX_PIECES = 8;

/**
 * The image on a web approval card. It is information only: the card's buttons and
 * what they approve never depend on it. Each image is fetched once per panel, outside
 * the polled view, and kept as an object URL until the panel closes.
 */
export class AssistantApprovalPreviews {
  readonly dialog = node('dialog', '', 'assistant-approval-preview-dialog');
  private caption = node('p', '', 'muted');
  private images = new Map<string, Promise<string>>();
  private urls: string[] = [];
  constructor(private fetch?: AssistantPreviewFetch) {
    const head = node('div', '', 'assistant-approval-preview-head');
    head.append(this.caption, button('Stäng', () => this.dialog.close(), 'quiet assistant-approval-preview-close'));
    this.dialog.append(head);
    // A click on the backdrop closes, like Escape.
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.dialog.close(); });
    this.dialog.addEventListener('close', () => this.dialog.querySelector('img')?.remove());
  }
  /** The card's figure: the image, or the line saying that none could be taken. */
  render(approval: AssistantWebApproval): HTMLElement {
    const figure = node('figure', '', 'assistant-approval-preview'), alt = `Bild av det som klickas på ${approval.site}`;
    if (!approval.previewFileId || !this.fetch) {
      figure.dataset.preview = 'missing';
      figure.append(node('p', 'Ingen bild kunde tas.', 'muted assistant-approval-preview-missing'));
      return figure;
    }
    // The image element exists only once it has its source: an empty one would read as a broken image.
    const open = node('button', '', 'assistant-approval-preview-open'), caption = node('figcaption', 'Hämtar bilden…', 'muted');
    open.type = 'button'; open.disabled = true; open.setAttribute('aria-label', `Förstora bilden: ${alt}`);
    figure.append(open, caption); figure.dataset.preview = 'loading';
    void this.url(approval.previewFileId).then(url => {
      const image = node('img'); image.alt = alt; image.decoding = 'async'; image.src = url;
      open.append(image); open.onclick = () => this.enlarge(url, alt); open.disabled = false; figure.dataset.preview = 'ready';
      caption.textContent = 'Så såg sidan ut när kortet skapades. Tryck för att förstora.';
    }, () => {
      figure.dataset.preview = 'failed';
      figure.replaceChildren(node('p', 'Bilden kunde inte visas. Kortet gäller ändå bara sidan som den ser ut när du godkänner.', 'muted assistant-approval-preview-missing'));
    });
    return figure;
  }
  dispose() { this.dialog.close(); this.dialog.querySelector('img')?.remove(); for (const url of this.urls) URL.revokeObjectURL(url); this.urls = []; this.images.clear(); }
  private enlarge(src: string, alt: string) {
    const large = node('img'); large.src = src; large.alt = alt;
    this.dialog.querySelector('img')?.remove(); this.dialog.append(large); this.caption.textContent = alt;
    if (!this.dialog.open) this.dialog.showModal();
  }
  private url(fileId: string): Promise<string> {
    let image = this.images.get(fileId);
    if (!image) {
      image = this.load(fileId);
      // A failed fetch is tried again the next time the card is drawn.
      image.catch(() => { if (this.images.get(fileId) === image) this.images.delete(fileId); });
      this.images.set(fileId, image);
    }
    return image;
  }
  private async load(fileId: string): Promise<string> {
    let base64 = '', total = 0, mimeType: AssistantApprovalImage['mimeType'] | undefined;
    for (let piece = 0; piece < MAX_PIECES && (!total || base64.length < total); piece++) {
      const chunk = await this.fetch!(fileId, base64.length);
      if (!chunk || chunk.fileId !== fileId || chunk.offset !== base64.length || !chunk.base64 || (total && (chunk.total !== total || chunk.mimeType !== mimeType))) throw new Error('Bilden kom inte fram.');
      total = chunk.total; mimeType = chunk.mimeType; base64 += chunk.base64;
    }
    if (!mimeType || base64.length !== total) throw new Error('Bilden kom inte fram.');
    const binary = atob(base64), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    this.urls.push(url);
    return url;
  }
}
