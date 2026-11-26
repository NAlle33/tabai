// WebSocket bridge server — the EXTENSION-facing hop. Listens on
// 127.0.0.1:BRIDGE_PORT and correlates request/response pairs with the single
// connected Chrome extension (offscreen document). Used directly by the broker
// (src/broker.ts); the at-most-once + queue state machine lives in PendingCalls
// so this hop and the client<->broker hop cannot drift.
//
// Resilience (at-most-once): a call made while the extension is briefly
// disconnected is QUEUED and sent on (re)connect; a call ALREADY SENT when the
// connection drops is deliberately NOT replayed (it times out) — so a
// non-idempotent tool can never double-execute.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { BRIDGE_HOST, BRIDGE_PORT } from "./ports";
import type { ControlMessage } from "../shared/protocol";
import { PendingCalls } from "./pending-calls";
import { gateExtension, verifyClientWith } from "./handshake-gate";

export class Bridge {
  panelHandler?: (message: unknown, reply: (value: unknown) => void) => void;
  assistantReady?: () => void;
  /** An extension connection closed, also one a newer connection superseded: calls sent on it time out. */
  extensionLost?: () => void;
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private calls: PendingCalls;
  private onConnect?: () => void;
  private stopping = false;

  /** `extensionId` is the optional pin: when set, only that extension's Origin
   *  is accepted on this port (empty = any chrome-extension:// Origin). */
  constructor(
    token = "",
    port: number = BRIDGE_PORT,
    onError?: (e: NodeJS.ErrnoException) => void,
    graceMs = 0,
    onConnect?: () => void,
    extensionId = "",
  ) {
    this.onConnect = onConnect;
    this.calls = new PendingCalls({
      write: (frame) => {
        if (!this.isOpen()) return false;
        try {
          this.client!.send(frame);
          return true;
        } catch {
          return false;
        }
      },
      isOpen: () => this.isOpen(),
      // Cold-start grace: queue (don't fast-fail) while the extension re-dials a
      // freshly-spawned broker; fail NO_EXTENSION on expiry if it never shows.
      graceMs,
    });
    // Origin + token are checked at the HTTP upgrade (HTTP 403 / 401), so a
    // rejected peer never reaches onConnection and can never supersede the
    // real extension. Post-upgrade close codes (4002 superseded) keep their meaning.
    const verify = verifyClientWith(
      () => this.boundPort(),
      (req) => gateExtension(req, token, extensionId),
    );
    this.wss = new WebSocketServer({
      host: BRIDGE_HOST,
      port,
      // A stopping broker keeps the port bound but routes nothing (HTTP 503).
      verifyClient: (info: Parameters<typeof verify>[0], done: Parameters<typeof verify>[1]) =>
        this.stopping ? done(false, 503, "broker shutting down") : verify(info, done),
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    // The broker passes onError to couple its singleton lock to THIS port's bind
    // result (it exits + releases the lock if the extension port is held by a
    // stray, instead of wedging while blocking all replacement brokers).
    this.wss.on("error", (e: NodeJS.ErrnoException) =>
      onError ? onError(e) : console.error("[bridge] server error:", e),
    );
    console.error(`[bridge] listening on ws://${BRIDGE_HOST}:${port}`);
  }

  private boundPort(): number {
    const a = this.wss.address();
    return a && typeof a === "object" ? a.port : BRIDGE_PORT;
  }

  /** Resolve once the server is accepting connections; yields the bound port. */
  ready(): Promise<number> {
    return new Promise((resolve) => {
      if (this.wss.address()) return resolve(this.boundPort());
      this.wss.once("listening", () => resolve(this.boundPort()));
    });
  }

  /** Stop accepting connections (tests / shutdown). */
  close(): void {
    this.wss.close();
  }

  /** Broker shutdown: refuse new extension upgrades with HTTP 503 and close the
   *  current connection, while the port stays bound until the process exits. */
  stopRouting(): void {
    this.stopping = true;
    this.client?.close(1001, "broker shutting down");
  }

  /** Is a Chrome extension currently connected? */
  get connected(): boolean {
    return this.isOpen();
  }

  /** Number of in-flight calls awaiting a response. */
  get pendingCount(): number {
    return this.calls.size;
  }

  private isOpen(): boolean {
    return this.client != null && this.client.readyState === WebSocket.OPEN;
  }

  private onConnection(ws: WebSocket) {
    // Single-extension model: newest connection wins.
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.close(4002, "superseded by new connection");
    }
    this.client = ws;
    console.error("[bridge] extension connected");
    ws.on("message", (data) => {
      if (this.client === ws) this.onMessage(data.toString(), ws);
    });
    ws.on("close", () => {
      if (this.client === ws) this.client = null;
      console.error("[bridge] extension disconnected");
      this.extensionLost?.();
    });
    ws.on("error", (e) => console.error("[bridge] socket error:", e));
    // Let the broker re-deliver any reap deferred while the extension was down
    // before queued calls go on the wire. Worker dispatch remains best-effort.
    this.onConnect?.();
    this.calls.onConnected();
  }

  private onMessage(raw: string, origin: WebSocket) {
    let msg: {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: { code?: string; message?: string; retryable?: boolean };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[bridge] dropped non-JSON message");
      return;
    }
    if (msg?.type === "panel-request") {
      this.panelHandler?.(msg, value => {
        if (origin.readyState === WebSocket.OPEN) origin.send(JSON.stringify(value));
      });
      return;
    }
    if (msg?.type === "assistant-ready") { this.assistantReady?.(); return; }
    if (!msg || typeof msg.id !== "string") return; // ignore pings / malformed frames
    this.calls.settle(msg.id, msg.ok === true, msg.result, msg.error);
  }

  /** Send a tool call to the extension and await its response. The broker passes
   *  the authenticated `sessionId`, which is stamped onto the wire frame (the
   *  extension consumes it for per-session tab-group isolation). */
  call(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
    sessionId?: string,
    id = randomUUID(),
    sessionName?: string,
  ): Promise<unknown> {
    let frame: string;
    try {
      // Serialize once, up front, so non-serializable args fail FAST.
      frame = JSON.stringify(
        sessionId ? { id, tool, args, sessionId, sessionName } : { id, tool, args },
      );
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return this.calls.add(id, frame, tool, timeoutMs);
  }

  /** Cancel a still-queued call (broker abandons a client's call). */
  cancel(id: string): boolean {
    return this.calls.cancel(id);
  }

  /** Send an out-of-band control frame to the extension (fire-and-forget — the
   *  extension acts on it but sends no response; not part of at-most-once).
   *  Returns whether it was actually written (false if no extension connected). */
  sendControl(obj: ControlMessage): boolean {
    if (!this.isOpen()) return false;
    try {
      this.client!.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
}
