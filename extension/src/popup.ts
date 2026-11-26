// Popup: shows bridge connection status + extension version + this extension's
// MCP session/tab counts, and lets the user set the bridge URL and optional token.

import { loopbackBridgeUrl } from "./bridge-url";

const input = (id: string) => document.getElementById(id) as HTMLInputElement;

/** Show the running extension version + a live session/MCP-tab count. The version
 *  is the self-diagnosing signal: after a rebuild it stays old until reload. */
async function renderInfo(): Promise<void> {
  const version = chrome.runtime.getManifest().version;
  const el = document.getElementById("info");
  if (!el) return;
  // The id is what `npm run set-extension-id` pins on the broker's extension port.
  const idEl = document.getElementById("extid");
  if (idEl) idEl.textContent = `id ${chrome.runtime.id}`;
  try {
    const { mcpGroups } = await chrome.storage.local.get("mcpGroups");
    const groups = mcpGroups && typeof mcpGroups === "object" ? mcpGroups : {};
    const sessions = Object.keys(groups).length;
    const groupIds = new Set(Object.values(groups));
    const tabs = (await chrome.tabs.query({})).filter((t) => groupIds.has(t.groupId)).length;
    el.textContent = `v${version} · ${sessions} session${sessions === 1 ? "" : "s"} · ${tabs} MCP tab${tabs === 1 ? "" : "s"}`;
  } catch {
    el.textContent = `v${version}`;
  }
}

function renderStatus(status?: string, detail?: string): void {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = `Status: ${status ?? "unknown"}${detail ? " — " + detail : ""}`;
  el.className =
    status === "connected"
      ? "ok"
      : status === "connecting"
        ? "warn"
        : "err";
}

async function load(): Promise<void> {
  const { bridgeUrl, bridgeToken, bridgeStatus, bridgeStatusDetail, showVisualPresence, allowAgentFocus } =
    await chrome.storage.local.get([
      "bridgeUrl",
      "bridgeToken",
      "bridgeStatus",
      "bridgeStatusDetail",
      "showVisualPresence",
      "allowAgentFocus",
    ]);
  input("url").value = bridgeUrl || "ws://127.0.0.1:9223";
  input("token").value = bridgeToken || "";
  input("presence").checked = showVisualPresence !== false;
  input("agent-focus").checked = allowAgentFocus === true;
  renderStatus(bridgeStatus, bridgeStatusDetail);
  void renderInfo();
  // Wake the service worker so it (re)creates the offscreen document.
  chrome.runtime.sendMessage({ type: "ensure-connection" });
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.allowAgentFocus) input("agent-focus").checked = changes.allowAgentFocus.newValue === true;
  if (changes.showVisualPresence) input("presence").checked = changes.showVisualPresence.newValue !== false;
  if (changes.bridgeStatus || changes.bridgeStatusDetail) {
    renderStatus(
      changes.bridgeStatus?.newValue,
      changes.bridgeStatusDetail?.newValue,
    );
  }
  if (changes.mcpGroups) void renderInfo();
});

input("presence").addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ showVisualPresence: input("presence").checked });
    document.getElementById("presence-error")!.textContent = "";
  } catch {
    input("presence").checked = !input("presence").checked;
    document.getElementById("presence-error")!.textContent = "Kunde inte spara. Försök igen.";
  }
});

input("agent-focus").addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ allowAgentFocus: input("agent-focus").checked });
    document.getElementById("agent-focus-error")!.textContent = "";
  } catch {
    input("agent-focus").checked = !input("agent-focus").checked;
    document.getElementById("agent-focus-error")!.textContent = "Kunde inte spara. Försök igen.";
  }
});

document.getElementById("save")?.addEventListener("click", async () => {
  const url = input("url").value.trim(), error = document.getElementById("url-error")!;
  // Only the broker on this computer; an empty field keeps the built-in default address.
  if (url && !loopbackBridgeUrl(url)) {
    error.textContent = "Ange en ws://-adress på den här datorn: 127.0.0.1, localhost eller [::1]. Inget har ändrats.";
    return;
  }
  error.textContent = "";
  await chrome.storage.local.set({
    bridgeUrl: url,
    bridgeToken: input("token").value.trim(),
  });
  chrome.runtime.sendMessage({ type: "reconnect" });
});

document.getElementById("reconnect")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ensure-connection" });
  chrome.runtime.sendMessage({ type: "reconnect" });
});

// Reliable one-click reload after a rebuild: chrome.runtime.reload() re-reads
// the unpacked files from disk (more dependable than the chrome://extensions ↻).
document.getElementById("reloadext")?.addEventListener("click", () => {
  chrome.runtime.reload();
});

void load();

// Cache the window before the click: sidePanel.open must keep its user gesture.
let panelWindowId: number | undefined;
void chrome.windows.getCurrent().then(win => { panelWindowId = win.id; });
document.getElementById("open-panel")?.addEventListener("click", () => {
  if (panelWindowId === undefined) return;
  void chrome.sidePanel.open({ windowId: panelWindowId }).then(() => window.close(), () => {
    document.getElementById("panel-error")!.textContent = "Kunde inte öppna panelen. Kontrollera att den uppdaterade versionen har installerats.";
  });
});
