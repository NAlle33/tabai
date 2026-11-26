// Session lifecycle bookkeeping for the broker, extracted as a PURE unit (no
// Chrome, no ws) so the refcount + grace-cancel logic is unit-testable.
//
// When a session's last client disconnects, reap its group after a grace window.
// A transient blip (the server is still alive) reconnects with the same sessionId
// and CANCELS the reap; a dead server (stdio closed) does not, so it is reaped.
export class SessionReaper {
  private active = new Map<string, number>(); // sessionId -> connected client count
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private graceMs: number,
    private onReap: (sessionId: string) => void,
  ) {}

  connected(sessionId: string): void {
    this.active.set(sessionId, (this.active.get(sessionId) ?? 0) + 1);
    const t = this.timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(sessionId); // reconnect within grace cancels the reap
    }
  }

  disconnected(sessionId: string): void {
    const n = (this.active.get(sessionId) ?? 1) - 1;
    if (n > 0) {
      this.active.set(sessionId, n); // another client still holds the session
      return;
    }
    this.active.delete(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.onReap(sessionId);
    }, this.graceMs);
    this.timers.set(sessionId, timer);
  }

  /** Pending reap timers — for tests/diagnostics. */
  get pendingReaps(): number {
    return this.timers.size;
  }
}
