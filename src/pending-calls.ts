// At-most-once request/response registry, shared by BOTH transport hops:
//   - Bridge (MCP/broker  ->  Chrome extension)
//   - BridgeClient (MCP server  ->  broker)
//
// The invariant (identical on both hops): a call is QUEUED until the peer is
// connected; the moment it is written it is marked `sent` and is NEVER
// re-written on a later (re)connect — it times out instead. So a non-idempotent
// tool (navigate / click / submit / place-order) can never double-execute, even
// across a broker crash + respawn. Extracting it into one module is deliberate:
// the two hops must not be allowed to drift.

import { logEvent } from "./logger";
import { clampCallTimeout, isRetryable, type ToolErrorCode } from "../shared/protocol";

/** Build an Error carrying a machine-readable code + retryability. The message is
 *  "CODE: message" so the code is visible in the surfaced isError text; the bare
 *  message is attached as `rawMessage` for the broker hop to forward un-prefixed. */
function codedError(code: ToolErrorCode | string, message: string, retryable: boolean = isRetryable(code)): Error {
  // Surface "(retryable)" in the text too, so an agent reading only the isError
  // string can branch retry-vs-abort without a separate field. rawMessage stays
  // bare for the broker to forward un-prefixed (it re-prefixes once downstream).
  const e = new Error(`${code}: ${message}${retryable ? " (retryable)" : ""}`) as Error & {
    code: string;
    retryable: boolean;
    rawMessage: string;
  };
  e.code = code;
  e.retryable = retryable;
  e.rawMessage = message;
  return e;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  tool: string;
  started: number;
  sent: boolean;
  frame: string; // pre-serialized request frame (already contains `id`)
}

// Backstop so an unresponsive peer can't grow the queue without bound.
const DEFAULT_MAX_PENDING = 200;

export interface PendingCallsOpts {
  /** Write a frame to the peer; return false if not currently writable. */
  write: (frame: string) => boolean;
  /** Is the peer connection currently open (writable)? */
  isOpen: () => boolean;
  maxPending?: number;
  /** When true, calls made while disconnected QUEUE (rely on the per-call
   *  timeout) instead of fast-failing. Used by BridgeClient during broker
   *  cold-start; Bridge keeps the fast-fail so an unloaded extension doesn't
   *  leave the operator waiting. */
  queueWhenDisconnected?: boolean;
  /** Error message for the fast-fail path (Bridge only). */
  notConnectedMessage?: string;
  /** Startup grace (ms): while >0 and unexpired, calls QUEUE instead of fast-
   *  failing even when not connected — smooths a freshly (re)spawned broker whose
   *  extension hasn't re-dialed yet. On expiry with still no peer, queued calls
   *  fail NO_EXTENSION. 0 = no grace. */
  graceMs?: number;
}

export class PendingCalls {
  private pending = new Map<string, Pending>();
  private opts: PendingCallsOpts;
  private maxPending: number;
  everConnected = false;
  private graceUntil: number;
  private graceTimer?: NodeJS.Timeout;

  constructor(opts: PendingCallsOpts) {
    this.opts = opts;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    const graceMs = opts.graceMs ?? 0;
    this.graceUntil = graceMs > 0 ? Date.now() + graceMs : 0;
    if (graceMs > 0) {
      this.graceTimer = setTimeout(() => this.expireGrace(), graceMs);
      this.graceTimer.unref?.();
    }
  }

  get size(): number {
    return this.pending.size;
  }

  /** Register + (try to) send a call. `frame` must already include `id`. */
  add(id: string, frame: string, tool: string, timeoutMs: number): Promise<unknown> {
    timeoutMs = clampCallTimeout(timeoutMs);
    return new Promise((resolve, reject) => {
      const inGrace = this.graceUntil > 0 && Date.now() < this.graceUntil;
      if (
        !this.opts.queueWhenDisconnected &&
        !inGrace &&
        !this.everConnected &&
        !this.opts.isOpen()
      ) {
        return reject(codedError("NO_EXTENSION", this.notConnectedMessage()));
      }
      if (this.pending.size >= this.maxPending) {
        return reject(
          codedError(
            "QUEUE_FULL",
            `Bridge queue full (${this.maxPending} calls in flight) — peer unresponsive?`,
          ),
        );
      }
      const started = Date.now();
      const timer = setTimeout(() => {
        // Read sent-ness BEFORE deleting: a call already written to the wire may
        // have executed (we just didn't hear back in time). Marking it retryable
        // would invite the agent to re-issue it under a NEW id — which the send-
        // gate does NOT block — and double-run a non-idempotent tool. Only a
        // still-queued (never-sent) call is safe to retry.
        const wasSent = this.pending.get(id)?.sent ?? false;
        this.pending.delete(id);
        // The log keeps only a code; `sent` says whether the call may have run.
        logEvent({ id, tool, event: "err", ms: Date.now() - started, error: "TIMEOUT", sent: wasSent });
        reject(codedError("TIMEOUT", `Tool '${tool}' timed out after ${timeoutMs}ms`, !wasSent));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, tool, started, sent: false, frame });
      logEvent({ id, tool, event: "call", queued: !this.opts.isOpen() });
      this.trySend(id);
    });
  }

  /** Send a queued (never-sent) call if the peer is open. */
  trySend(id: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.sent || !this.opts.isOpen()) return;
    if (this.opts.write(entry.frame)) entry.sent = true;
    // else: leave unsent; a later onConnected() flush retries.
  }

  /** Settle a pending call by id from a response frame. */
  settle(
    id: string,
    ok: boolean,
    result: unknown,
    error?: { code?: string; message?: string; retryable?: boolean },
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return; // unknown id (timed out or unsolicited)
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const ms = Date.now() - entry.started;
    if (ok) {
      logEvent({ id, tool: entry.tool, event: "ok", ms });
      entry.resolve(result);
    } else {
      const code = typeof error?.code === "string" ? error.code : "TOOL_ERROR";
      const message = typeof error?.message === "string" ? error.message : "unknown error";
      logEvent({ id, tool: entry.tool, event: "err", ms, error: `${code}: ${message}` });
      entry.reject(codedError(code, message, typeof error?.retryable === "boolean" ? error.retryable : false));
    }
  }

  private notConnectedMessage(): string {
    return (
      this.opts.notConnectedMessage ??
      'No Chrome extension connected to the bridge. Load the extension and confirm its popup shows "connected".'
    );
  }

  /** Cancel a still-QUEUED (never-sent) call. Safe: it never reached the peer.
   *  No-op if already sent — re-cancelling a sent call could mask a real result
   *  and the peer might still execute it (at-most-once is about not RE-sending). */
  cancel(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.sent) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error("call cancelled before send"));
    return true;
  }

  /** Peer (re)connected: flush ONLY never-sent calls. Already-sent calls are
   *  deliberately NOT replayed (at-most-once) — they time out. */
  onConnected(): void {
    this.everConnected = true;
    for (const [id, entry] of this.pending) if (!entry.sent) this.trySend(id);
  }

  /** Startup grace elapsed: if still never connected, fail QUEUED never-sent calls
   *  with NO_EXTENSION instead of making them wait the full per-call timeout. Sent
   *  calls are left alone (at-most-once). */
  private expireGrace(): void {
    if (this.everConnected || this.opts.isOpen()) return;
    for (const [id, entry] of this.pending) {
      if (entry.sent) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(codedError("NO_EXTENSION", this.notConnectedMessage()));
    }
  }
}
