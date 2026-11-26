import type { PanelCommand, PanelImageChunk } from "../../shared/control-panel";
import { PANEL_IMAGE_CHUNK_CHARS, PANEL_IMAGE_MAX_CHARS } from "../../shared/panel-image";
import type { TimeoutIncident } from "../../src/timeout-incidents";
import { node } from "./panel-views";

/** A single on-demand viewer. Session, view and connection changes discard late replies. */
export function createPanelDebugging(
  request: <T>(command: PanelCommand) => Promise<T>,
  session: () => string,
  connected: () => boolean,
) {
  let generation = 0;
  let dialog: HTMLDialogElement | undefined;
  function close() { generation++; dialog?.close(); dialog?.remove(); dialog = undefined; }
  function open(title: string) {
    close();
    const current = generation, id = session();
    const surface = node("dialog", "", "debug-viewer");
    const heading = node("h2", title);
    heading.id = "debug-heading";
    surface.setAttribute("aria-labelledby", heading.id);
    const dismiss = node("button", "Stäng"); dismiss.type = "button";
    dismiss.addEventListener("click", close);
    surface.addEventListener("cancel", event => { event.preventDefault(); close(); });
    const content = node("div", "Hämtar…"); content.setAttribute("role", "status");
    surface.append(heading, dismiss, content); document.body.append(surface);
    dialog = surface; surface.showModal();
    return { id, content, valid: () => current === generation && id === session() && connected() };
  }
  async function image(runId: string) {
    if (!connected() || !session()) return;
    const viewer = open("Sparad felbild");
    try {
      const chunks: string[] = [];
      let offset = 0, total: number | undefined;
      do {
        const chunk = await request<PanelImageChunk>({ action: "history-image", sessionId: viewer.id, runId, offset });
        if (!viewer.valid()) return;
        if (chunk.mimeType !== "image/png" || chunk.offset !== offset || !Number.isSafeInteger(chunk.total)
          || chunk.total < 1 || chunk.total > PANEL_IMAGE_MAX_CHARS || (total !== undefined && total !== chunk.total)
          || !chunk.base64 || chunk.base64.length > PANEL_IMAGE_CHUNK_CHARS || chunk.base64.length % 4
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.base64) || offset + chunk.base64.length > chunk.total) {
          throw new Error("Ogiltig sparad bild.");
        }
        chunks.push(chunk.base64); offset += chunk.base64.length; total = chunk.total;
        viewer.content.textContent = `Hämtar felbild… ${Math.round(offset / total * 100)} %`;
      } while (offset < total);
      const img = node("img"); img.alt = "Sparad bild från det misslyckade steget";
      img.addEventListener("error", () => { if (viewer.valid()) viewer.content.replaceChildren(node("p", "Bilden kunde inte visas.", "notice error")); });
      img.src = `data:image/png;base64,${chunks.join("")}`;
      viewer.content.replaceChildren(img);
    } catch (error) { if (viewer.valid()) viewer.content.replaceChildren(node("p", String(error), "notice error")); }
  }
  async function incident(incidentId: string) {
    if (!connected() || !session()) return;
    const viewer = open("Sparat timeoutpaket");
    try {
      const record = await request<TimeoutIncident>({ action: "incident", sessionId: viewer.id, incidentId });
      if (!viewer.valid()) return;
      const content: HTMLElement[] = [node("p", `${record.tool} · ${new Date(record.capturedAt).toLocaleString("sv-SE")}`),
        node("p", `${record.durationMs} ms · tidsgräns ${record.timeoutMs} ms`),
        node("p", `Incident-ID: ${record.incidentId}`, "muted")];
      for (const [label, value] of [["Server", record.serverBuildId], ["Broker", record.brokerBuildId], ["Tillägg", record.extensionBuildId]]) {
        content.push(node("p", `${label}: ${value ?? "okänd build"}`, "muted diagnostic-build"));
      }
      if (!record.diagnosticsAvailable) content.push(node("p", "Chrome-diagnostik var inte tillgänglig vid timeouten.", "notice"));
      const list = node("ul", "", "steps");
      for (const entry of [...record.operations?.active ?? [], ...record.operations?.recent ?? []]) {
        list.append(node("li", `${entry.operation} · ${entry.status} · ${entry.durationMs} ms${entry.tabId === undefined ? "" : ` · flik ${entry.tabId}`}${entry.errorCode ? ` · ${entry.errorCode}` : ""}`));
      }
      if (list.children.length) content.push(list);
      if (record.operations?.dropped) content.push(node("p", `${record.operations.dropped} poster utelämnades vid kapacitetsgränsen.`, "muted"));
      viewer.content.replaceChildren(...content);
    } catch (error) { if (viewer.valid()) viewer.content.replaceChildren(node("p", String(error), "notice error")); }
  }
  return { close, image, incident };
}
