import { randomUUID } from "node:crypto";
import { PANEL_VERSION, PANEL_TIMEOUT_MS, PANEL_MAX_RESPONSE_BYTES, parsePanelCommand, type PanelSession } from "../shared/control-panel";

export interface PanelPeer {
  sessionId: string;
  sessionName?: string;
  panelVersion?: number;
  serverVersion?: string;
  send: (message: unknown) => void;
}

/** Reverse requests are bound to an authenticated client object, not a supplied ID. */
export class PanelRouter {
  constructor(private modules?: { list(): Promise<unknown>; request(id: string, operation: import("../shared/personal-modules").ModuleOperation, input: Record<string, string>): Promise<unknown> }) {}
  private peers = new Set<PanelPeer>();
  private pending = new Map<string, { peer: PanelPeer; finish: (reply: unknown) => void }>();

  add(peer: PanelPeer): void { this.peers.add(peer); }
  remove(peer: PanelPeer): void {
    this.peers.delete(peer);
    for (const [id, request] of this.pending) {
      if (request.peer === peer) this.respond(peer, { id, ok: false, error: "Session disconnected. Check its run status before starting again." });
    }
  }

  request(value: unknown, send: (reply: unknown) => void): void {
    const frame = value as { id?: unknown; command?: unknown };
    if (typeof frame?.id !== "string" || frame.id.length > 100) return;
    const reply = (data: object) => {
      const result = Buffer.byteLength(JSON.stringify(data)) <= PANEL_MAX_RESPONSE_BYTES
        ? data : { ok: false, error: "Panel response is too large" };
      send({ type: "panel-response", id: frame.id, ...result });
    };
    try {
      const command = parsePanelCommand(frame.command);
      if (command.action === "modules" || command.action === "module") {
        if (!this.modules) throw new Error("Lokala moduler kräver en uppdaterad broker.");
        const result = command.action === "modules" ? this.modules.list()
          : this.modules.request(command.moduleId, command.operation, command.input);
        void result.then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error instanceof Error ? error.message : "Modulfel" }));
        return;
      }
      if (command.action === "sessions") {
        const sessions: PanelSession[] = [...this.peers].map(peer => ({
          sessionId: peer.sessionId, supported: peer.panelVersion === PANEL_VERSION, version: peer.serverVersion ?? "",
          ...(peer.sessionName ? { sessionName: peer.sessionName } : {}),
        }));
        reply({ ok: true, result: sessions });
        return;
      }
      const matches = [...this.peers].filter(peer => peer.sessionId === command.sessionId);
      if (matches.length !== 1) throw new Error("Session is disconnected or ambiguous. Refresh the session list.");
      const peer = matches[0];
      if (peer.panelVersion !== PANEL_VERSION) throw new Error("Restart this MCP server to enable the control panel.");
      if (this.pending.size >= 64) throw new Error("Control panel is busy. Try refreshing shortly.");
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reply({ ok: false, error: "Request timed out. A start may already have run. Refresh status before starting again." });
      }, PANEL_TIMEOUT_MS);
      this.pending.set(id, { peer, finish: response => { clearTimeout(timer); reply(response as object); } });
      try { peer.send({ type: "panel-request", id, command }); } catch {
        this.respond(peer, { id, ok: false, error: "Session disconnected. Refresh status before starting again." });
      }
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : "Invalid panel request" });
    }
  }

  respond(peer: PanelPeer, value: unknown): void {
    const frame = value as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (typeof frame?.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending || pending.peer !== peer) return;
    this.pending.delete(frame.id);
    const reply = frame.ok === true ? { ok: true, result: frame.result } : {
      ok: false, error: typeof frame.error === "string" ? frame.error.slice(0, 2000) : "Panel request failed",
    };
    pending.finish(reply);
  }
}
