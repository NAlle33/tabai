// Per-connection client protocol. The broker owns all process-wide resources.
import { WebSocket } from "ws";
import { createHash, randomUUID } from "node:crypto";
import { BUILD_ID } from "../shared/build-info";
import { PROTOCOL_VERSION, SESSION_OPEN, clampCallTimeout } from "../shared/protocol";
import type { Bridge } from "./bridge";
import type { SessionReaper } from "./session-reaper";
import type { PanelRouter, PanelPeer } from "./panel-router";
import { normalizeSessionName } from "../shared/session-name";

interface ClientSessionDeps {
  getBridge: () => Pick<Bridge, "call" | "cancel" | "sendControl"> | undefined;
  reaper: Pick<SessionReaper, "connected" | "disconnected">;
  panel: Pick<PanelRouter, "add" | "remove" | "respond">;
  pendingReaps: Set<string>;
  perClientMax: number;
  logBroker: (event: string, extra?: Record<string, unknown>) => void;
}

export interface BrokerClientSessions {
  /** The client port's `connection` handler. */
  onClient: (ws: WebSocket) => void;
  /** Send session-open for every session with an accepted hello and an open
   *  socket. Called when an extension socket is accepted, before any other
   *  control frame on it: a hello accepted while no extension was connected is
   *  otherwise never announced, and a retried cleanup could close that live
   *  session's group. */
  announceSessions: () => void;
}

interface Client {
  ws: WebSocket;
  sessionId: string;
  sessionName?: string;
  inflight: number;
  pendingIds: Set<string>;
}

/** Derive an opaque, stable sessionId from the client's secret sessionKey. The
 *  key never travels past the broker; the derived id is safe to put on frames. */
function deriveSessionId(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

export function createBrokerClientSession({ getBridge, reaper, panel, pendingReaps, perClientMax, logBroker }: ClientSessionDeps): BrokerClientSessions {
  // Connections whose hello was accepted and whose socket has not closed.
  const accepted = new Set<Client>();

  // Fire-and-forget: when no extension is connected, announceSessions() covers
  // the session as soon as one connects.
  function announce(sessionId: string): void {
    getBridge()?.sendControl({ type: "control", event: SESSION_OPEN, sessionId });
  }

  function announceSessions(): void {
    for (const sessionId of new Set([...accepted].map(client => client.sessionId))) announce(sessionId);
  }

  function onClient(ws: WebSocket): void {
    const client: Client = { ws, sessionId: "", inflight: 0, pendingIds: new Set() };
    let helloSeen = false;
    let panelPeer: PanelPeer | undefined;

    ws.on("message", (data) => {
      let msg: {
        role?: string;
        sessionKey?: string;
        sessionName?: unknown;
        version?: unknown;
        id?: unknown;
        tool?: unknown;
        args?: unknown;
        timeoutMs?: unknown;
        deadline?: unknown;
        type?: unknown;
        panelVersion?: unknown;
        serverVersion?: unknown;
        buildStatusVersion?: unknown;
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // First frame MUST be the ClientHello — establishes this connection's session.
      if (!helloSeen) {
        if (msg && msg.role === "client" && typeof msg.sessionKey === "string" && msg.sessionKey) {
          if (msg.version !== PROTOCOL_VERSION) {
            logBroker("version-skew-reject", { got: msg.version, want: PROTOCOL_VERSION });
            ws.close(4004, "protocol version mismatch");
            return;
          }
          helloSeen = true;
          client.sessionId = deriveSessionId(msg.sessionKey);
          client.sessionName = normalizeSessionName(msg.sessionName);
          reaper.connected(client.sessionId);
          // A revived session cancels its own deferred reap (if any) so the next
          // extension reconnect won't close the group it is now using.
          pendingReaps.delete(client.sessionId);
          accepted.add(client);
          // The extension cancels a cleanup of this session it may still retry.
          announce(client.sessionId);
          panelPeer = { sessionId: client.sessionId,
            sessionName: client.sessionName,
            panelVersion: typeof msg.panelVersion === "number" ? msg.panelVersion : undefined,
            serverVersion: typeof msg.serverVersion === "string" ? msg.serverVersion.slice(0, 30) : undefined,
            send: frame => { if (ws.readyState !== WebSocket.OPEN) throw new Error("Disconnected"); ws.send(JSON.stringify(frame)); },
          };
          panel.add(panelPeer);
          // Opt-in keeps legacy protocol-v1 clients' first response unchanged.
          // A current client writes no call before this acknowledgement.
          if (msg.buildStatusVersion === 1) safeSend(ws, { type: "broker-status", buildId: BUILD_ID, version: PROTOCOL_VERSION });
        } else {
          ws.close(4003, "expected client hello");
        }
        return;
      }
      if (msg?.type === "panel-response" && panelPeer) {
        panel.respond(panelPeer, msg);
        return;
      }
      if (msg && typeof msg.id === "string" && typeof msg.tool === "string") {
        // Clamp client-supplied timeout: 0/negative would pin a slot then time out
        // pointlessly; an absurd value would hold the per-session in-flight slot for
        // hours. Leave the worker's five-minute ceiling intact on both hops.
        const timeoutMs = clampCallTimeout(msg.timeoutMs);
        const deadline = typeof msg.deadline === "number" && Number.isFinite(msg.deadline) ? msg.deadline : undefined;
        void routeCall(client, msg.id, msg.tool, (msg.args ?? {}) as Record<string, unknown>, timeoutMs, deadline);
      }
    });

    ws.on("error", () => {
      /* the 'close' handler runs cleanup */
    });
    ws.on("close", () => {
      accepted.delete(client);
      if (panelPeer) panel.remove(panelPeer);
      for (const id of client.pendingIds) {
        if (getBridge()?.cancel(id)) logBroker("call-cancelled", { id, sessionId: client.sessionId });
      }
      client.pendingIds.clear();
      if (client.sessionId) reaper.disconnected(client.sessionId);
    });
  }

  async function routeCall(
    client: Client,
    id: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    deadline: number | undefined,
  ): Promise<void> {
    // The client gives up at its deadline; a call still undispatched by then
    // must never reach the extension. Nothing was sent on, so it is retryable.
    const remaining = deadline === undefined ? timeoutMs : deadline - Date.now();
    const deadlineError = { code: "TIMEOUT", message: `Tool '${tool}' reached its deadline before dispatch`, retryable: true };
    if (remaining <= 0) {
      safeSend(client.ws, { id, ok: false, error: deadlineError });
      return;
    }
    const bridge = getBridge();
    if (!bridge) {
      safeSend(client.ws, {
        id,
        ok: false,
        error: { code: "NO_BRIDGE", message: "broker not ready", retryable: true },
      });
      return;
    }
    if (client.inflight >= perClientMax) {
      safeSend(client.ws, {
        id,
        ok: false,
        error: {
          code: "SESSION_BUSY",
          message: `session already has ${perClientMax} calls in flight`,
          retryable: true,
        },
      });
      return;
    }
    client.inflight++;
    const bridgeId = randomUUID();
    client.pendingIds.add(bridgeId);
    // Bounded by the client's deadline. The extension hop raises a shorter budget
    // to its 1 s floor, so a call still queued there (no extension connected)
    // could be written after the client has already reported TIMEOUT. Cancel it
    // at the deadline instead: cancel() does nothing once the call was written,
    // and such a call ends on the extension hop's own timer, never written again.
    const budget = Math.min(timeoutMs, remaining);
    let expired = false;
    const deadlineTimer = setTimeout(() => {
      expired = bridge.cancel(bridgeId);
      if (expired) logBroker("call-cancelled", { id: bridgeId, sessionId: client.sessionId, reason: "deadline" });
    }, budget);
    // Closure-bound: the reply goes to THIS client's socket only.
    try {
      const result = await bridge.call(tool, { ...args, __sessionId: client.sessionId }, budget, client.sessionId, bridgeId, client.sessionName);
      safeSend(client.ws, { id, ok: true, result });
    } catch (e: any) {
      // A call cancelled at its deadline was never written on: retryable.
      // Otherwise preserve the extension hop's REAL code + retryability (rawMessage
      // is the un-prefixed text; the client re-prefixes once for display).
      safeSend(client.ws, {
        id,
        ok: false,
        error: expired
          ? deadlineError
          : {
              code: e?.code ?? "TOOL_ERROR",
              message: e?.rawMessage ?? String(e?.message ?? e),
              retryable: e?.retryable ?? false,
            },
      });
    } finally {
      clearTimeout(deadlineTimer);
      client.pendingIds.delete(bridgeId);
      client.inflight--;
    }
  }

  function safeSend(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  return { onClient, announceSessions };
}
