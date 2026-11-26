import { createHash } from 'node:crypto';

const MAX_REPEAT = 3, LOOP_WINDOW = 16, LOOP_RECURRENCE = 4;

/**
 * Loop detection that tolerates normal reading: identical consecutive calls are
 * capped, and a call that keeps returning the same result within a window is no
 * progress, also when other calls come between, as long as the run made those
 * before as well. A read after a click returns a new page and therefore counts
 * as new, and an unchanged list read again between threads is navigation: a
 * call the run had not made before, such as opening the next thread, stands
 * between the repeats. A call that merely answers differently each time is not
 * progress. `loop` builds the runner's own error.
 */
export class AssistantLoopGuard {
  private previous = ''; private repeat = 0; private recent: { key: string; signature: string }[] = [];
  /** How often each call was made in this run. */
  private readonly made = new Map<string, number>();
  constructor(private readonly loop: () => Error) {}
  before(key: string): void {
    this.repeat = key === this.previous ? this.repeat + 1 : 1; this.previous = key;
    if (this.repeat > MAX_REPEAT) throw this.loop();
  }
  after(key: string, result: string): void {
    let stable = result;
    // Every read mints a fresh observationId and observationSeq; neither is a change of content.
    try { const value = JSON.parse(result); if (value && typeof value === 'object' && !Array.isArray(value)) { delete value.observationId; delete value.observationSeq; stable = JSON.stringify(value); } } catch { /* Plain text results compare as-is. */ }
    const signature = `${key}\0${createHash('sha256').update(stable).digest('hex')}`;
    this.made.set(key, (this.made.get(key) ?? 0) + 1);
    this.recent.push({ key, signature }); if (this.recent.length > LOOP_WINDOW) this.recent.shift();
    if (this.recent.filter(entry => entry.signature === signature).length < LOOP_RECURRENCE) return;
    // A loop makes the same calls again and again. A call the run made only once, since the
    // first of these repeats, is progress: each new thread opened between reads of one list.
    const since = this.recent.slice(this.recent.findIndex(entry => entry.signature === signature));
    if (since.every(entry => this.made.get(entry.key)! > 1)) throw this.loop();
  }
}
