/**
 * The broker's scheduler pulse to the daily assistant. It says whether the
 * extension is connected, and the assistant uses it to start scheduled runs and
 * to tell a page that hung from a lost connection. The broker pulses every 30 s
 * whether or not the extension is connected, and at once when an extension
 * connection closes: a call that was on that connection times out later, and
 * the assistant must already know the browser was lost when that timeout
 * reaches a run. Pure unit; src/broker.ts wires it to the bridge and the module.
 */
export class AssistantPulse {
  private running = false;
  private lost = false;

  /**
   * `send` delivers one pulse and handles its own errors; `connected` reads the
   * bridge at the moment a pulse is sent.
   */
  constructor(
    private readonly send: (browserConnected: boolean) => Promise<void>,
    private readonly connected: () => boolean,
  ) {}

  /**
   * One pulse. `lost`: an extension connection just closed, so this pulse says
   * the browser is not connected even when a newer connection is already open.
   * A pulse asked for while one is being sent is dropped, except a lost
   * connection's, which follows it: the pulse in flight may have said connected.
   */
  async pulse(lost = false): Promise<void> {
    if (lost) this.lost = true;
    if (this.running) return;
    this.running = true;
    try {
      do {
        const wasLost = this.lost;
        this.lost = false;
        try { await this.send(!wasLost && this.connected()); } catch { /* `send` reports its own failures; the next pulse tries again. */ }
      } while (this.lost);
    } finally { this.running = false; }
  }
}
