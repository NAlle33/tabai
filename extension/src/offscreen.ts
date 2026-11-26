// Offscreen document: holds the persistent WebSocket connection to the local
// MCP server. Relays tool requests to the service worker and sends results
// back. Survives service-worker idle termination.
//
// IMPORTANT: offscreen documents can only use the chrome.runtime API — NOT
// chrome.storage / chrome.tabs / etc. (chrome.storage is undefined here). So
// config reads and status writes are routed through the service worker via
// runtime messaging.

// First import: switches zod's string evaluation off before any schema is built.
import "./zod-no-eval";
import { BRIDGE_PORT } from "../../shared/protocol";
import { parsePanelCommand } from "../../shared/control-panel";
import { isPanelSender } from "./panel-access";
import { createOffscreenPanelChannel } from "./offscreen-panel-channel";

const panelChannel = createOffscreenPanelChannel();

const DEFAULT_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;

let ws: WebSocket | null = null;
let backoff = 1000;
// Set across the async gap inside connect() (the `await getConfig()` below). The
// readyState guard alone leaves that gap open, so a scheduled reconnect and the
// 15s keepalive could both slip through and each open a socket.
let connecting = false;

async function getConfig(): Promise<{ url: string; token: string }> {
  try {
    const cfg = await chrome.runtime.sendMessage({ type: "get-config" });
    return { url: cfg?.url || DEFAULT_URL, token: cfg?.token || "" };
  } catch {
    return { url: DEFAULT_URL, token: "" };
  }
}

// Fire-and-forget: the service worker persists status to chrome.storage so the
// popup can display it.
function setStatus(status: string, detail = ""): void {
  void chrome.runtime
    .sendMessage({ type: "set-status", status, detail })
    .catch(() => {});
}

async function connect(): Promise<void> {
  // Guard: never open a second socket while one is open/connecting — a duplicate
  // connection makes the bridge supersede (close) the prior one, whose onclose
  // schedules another reconnect → connect/disconnect cascade. `connecting` closes
  // the gap across the `await getConfig()` that the readyState check can't cover.
  if (
    connecting ||
    (ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
  ) {
    return;
  }
  connecting = true;
  const { url, token } = await getConfig();
  const full = token ? `${url}?token=${encodeURIComponent(token)}` : url;
  setStatus("connecting", url);
  try {
    ws = new WebSocket(full);
  } catch (e) {
    connecting = false;
    setStatus("error", String(e));
    scheduleReconnect();
    return;
  }
  // ws is now CONNECTING; the readyState guard covers re-entry from here on.
  connecting = false;
  const origin = ws;
  origin.onopen = () => {
    if (ws !== origin) return;
    backoff = 1000;
    setStatus("connected", url);
    origin.send(JSON.stringify({ type: "assistant-ready" }));
  };
  origin.onclose = () => {
    panelChannel.disconnect(origin);
    if (ws !== origin) return;
    setStatus("disconnected");
    scheduleReconnect();
  };
  origin.onerror = () => {
    if (ws !== origin) return;
    setStatus("error", "socket error");
  };
  origin.onmessage = (ev) => handleMessage(String(ev.data), origin);
}

function scheduleReconnect(): void {
  setTimeout(() => void connect(), backoff);
  backoff = Math.min(backoff * 2, 15_000);
}

function send(obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleMessage(raw: string, origin: WebSocket): void {
  let req: {
    id?: string;
    tool?: string;
    args?: unknown;
    sessionId?: string;
    sessionName?: string;
    type?: string;
    event?: string;
    ok?: boolean;
    result?: unknown;
    error?: string;
    notice?: unknown;
  };
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (req?.type === "panel-response" && req.id) {
    panelChannel.settle(origin, req.id, req.ok === true ? { ok: true, result: req.result } : { ok: false, error: req.error ?? "Panel request failed" });
    return;
  }
  // Out-of-band control from the broker (e.g. session-closed → reap group).
  if (req?.type === "control") {
    void chrome.runtime
      .sendMessage({ type: "broker-control", event: req.event, sessionId: req.sessionId, notice: req.notice })
      .catch(() => {});
    return;
  }
  if (!req?.id || !req?.tool) return;
  // Forward to the service worker, which has chrome.tabs / chrome.scripting.
  // No id-dedupe needed: the bridge is at-most-once (it never re-sends an
  // already-sent call), so each id arrives here exactly once.
  chrome.runtime.sendMessage(
    { type: "tool-call", tool: req.tool, args: req.args ?? {}, sessionId: req.sessionId, sessionName: req.sessionName },
    (resp) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr || !resp) {
        send({
          id: req.id,
          ok: false,
          error: {
            code: "SW_ERROR",
            message: lastErr?.message ?? "no response from service worker",
          },
        });
        return;
      }
      if (resp.ok) send({ id: req.id, ok: true, result: resp.result });
      else send({ id: req.id, ok: false, error: resp.error });
    },
  );
}

// Popup can ask us to reconnect after changing config.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "panel-command") {
    if (!isPanelSender(sender)) { sendResponse({ ok: false, error: "Untrusted panel sender" }); return false; }
    try {
      const command = parsePanelCommand(msg.command);
      panelChannel.request(ws, command, sendResponse);
    } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : "Ogiltig begäran" }); }
    return true;
  }
  if (msg?.type === "reconnect") {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    void connect();
    sendResponse({ ok: true });
    return true;
  }
  return undefined;
});

// Keepalive: a ping keeps the WS warm and the offscreen document from being
// idle-reclaimed (which would silently drop the bridge). Also self-heals if the
// socket is gone without an onclose having fired.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      /* ignore */
    }
  } else {
    void connect();
  }
}, 15_000);

void connect();
