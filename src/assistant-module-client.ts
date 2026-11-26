import { randomUUID } from 'node:crypto';
import { assistantModuleRequestSchema, type AssistantModuleRequest } from '../shared/assistant-services';

// The broker answers one module operation after two of its own module
// requests (the status read, then the operation), each bounded at 7 s. A
// shorter budget here reports a start as failed while the module performs it.
const BROKER_MODULE_REQUEST_MS = 7_000;
const REQUEST_TIMEOUT_MS = 2 * BROKER_MODULE_REQUEST_MS + 1_500;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** The built-in assistant borrows the broker's already-owned module processes. */
export class AssistantModuleClient {
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  constructor(private readonly send: (frame: unknown) => void) {}
  request(command: AssistantModuleRequest): Promise<unknown> {
    assistantModuleRequestSchema.parse(command);
    if (this.closed) return Promise.reject(new Error('Modulanslutningen stängdes. Inga anrop upprepas.'));
    if (this.pending.size >= 12) return Promise.reject(new Error('Modulanslutningen arbetar. Vänta ett ögonblick.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Modulsvaret dröjde. Kontrollera status innan en ny åtgärd; inget upprepades.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: 'assistant-service', id, command }); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Modulanslutningen stängdes. Kontrollera utfallet.'));
      }
    });
  }
  receive(frame: Record<string, unknown>): boolean {
    if (frame.type !== 'assistant-service-response') return false;
    const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
    if (!pending) return true;
    this.pending.delete(frame.id as string);
    clearTimeout(pending.timer);
    if (frame.ok === true) pending.resolve(frame.result);
    else pending.reject(new Error(typeof frame.error === 'string' ? frame.error.slice(0, 1000) : 'Modulfunktionen kunde inte slutföras.'));
    return true;
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Modulanslutningen stängdes. Inga anrop upprepas.'));
    }
    this.pending.clear();
  }
}
