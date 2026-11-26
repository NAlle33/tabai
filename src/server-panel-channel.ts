import { WebSocket } from "ws";
import { PANEL_MAX_RESPONSE_BYTES, parsePanelCommand, type PanelCommand } from "../shared/control-panel";

/** Replies stay with the socket that delivered the request across handler awaits. */
export function respondToPanelRequest(
  id: string,
  value: unknown,
  origin: WebSocket,
  handler?: (command: PanelCommand) => Promise<unknown>,
): void {
  void (async () => {
    let reply: unknown;
    try {
      if (!handler) throw new Error("Restart the MCP server to enable the panel");
      const command = parsePanelCommand(value);
      reply = { type: "panel-response", id, ok: true, result: await handler(command) };
      if (Buffer.byteLength(JSON.stringify(reply)) > PANEL_MAX_RESPONSE_BYTES) throw new Error("Panel response is too large");
    } catch (error) {
      reply = { type: "panel-response", id, ok: false, error: error instanceof Error ? error.message : "Panel request failed" };
    }
    if (origin.readyState === WebSocket.OPEN) origin.send(JSON.stringify(reply));
  })().catch(() => {});
}
