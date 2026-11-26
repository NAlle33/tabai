import { PANEL_TIMEOUT_MS, type PanelCommand, type PanelReply } from "../../shared/control-panel";

const DISCONNECTED = "Anslutningen bröts. Kontrollera körstatus innan du startar igen.";

/** Each request belongs to one socket, including its deadline and disconnect. */
export function createOffscreenPanelChannel() {
  const pending = new Map<string, { origin: WebSocket; finish: (reply: PanelReply) => void }>();

  function request(origin: WebSocket | null, command: PanelCommand, sendResponse: (reply: PanelReply) => void): void {
    if (!origin || origin.readyState !== WebSocket.OPEN) throw new Error("Ingen anslutning. Öppna inställningarna och återanslut.");
    if (pending.size >= 16) throw new Error("Panelen arbetar. Vänta ett ögonblick.");
    const id = crypto.randomUUID();
    const timer = setTimeout(() => finish({ ok: false, error: "Inget svar. Uppdatera broker/MCP-servern om panelstödet saknas. En start kan redan ha körts; kontrollera status först." }), PANEL_TIMEOUT_MS + 2000);
    const finish = (reply: PanelReply) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      sendResponse(reply);
    };
    pending.set(id, { origin, finish });
    try { origin.send(JSON.stringify({ type: "panel-request", id, command })); } catch {
      finish({ ok: false, error: DISCONNECTED });
    }
  }

  function settle(origin: WebSocket, id: string, reply: PanelReply): void {
    const entry = pending.get(id);
    if (entry?.origin === origin) entry.finish(reply);
  }

  function disconnect(origin: WebSocket): void {
    for (const entry of pending.values()) {
      if (entry.origin === origin) entry.finish({ ok: false, error: DISCONNECTED });
    }
  }

  return { request, settle, disconnect };
}
