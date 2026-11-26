// First import: switches zod's string evaluation off before any schema is built.
import "./zod-no-eval";
import { toolScreenshotMarked } from "./marked-screenshot";
import { toolReadPageDiff, reapPerceptionState } from "./perception-snapshots";
import { toolDialog, reapDialogState, releaseUnownedTabs } from "./dialog-controller";
import { toolScreenshot } from "./capture-tools";
import { toolNavigate, toolResizeWindow, toolTabsClose, toolTabsContext, toolTabsCreate, toolTabSwitch, toolTabReload, toolTabDuplicate } from "./tab-tools";
// Service worker: offscreen lifecycle, message routing, and tool dispatch.
// Tool implementations live in the imported domain modules; the offscreen document holds
// the WebSocket and relays tool-call messages here (it has no chrome.tabs /
// chrome.scripting / chrome.storage — only chrome.runtime).

import { toolGifCreator, reapGifState } from "./gif-recorder";
import {
  toolHealth,
  toolPrintToPdf,
  toolCookies,
  toolEmulateDevice,
  toolDownload,
} from "./cdp-tools";
import { toolReadPageCompact, toolResolveTarget, toolExtractTable } from "./page-perception";
import { reapDownloadState } from "./download-state";
import {
  toolComputer,
  toolFileUpload,
  toolFind,
  toolFillForm,
  toolFormInput,
  toolGetPageText,
  toolJavascript,
  toolReadConsole,
  toolReadNetwork,
  toolReadPage,
  toolSelectOption,
  toolStorage,
  toolAccessibilityTree,
  toolFileDrop,
  toolWaitFor,
} from "./browser-tools";

import { scheduleSessionReap, cancelSessionReap, lookupGroupId, tabsInGroup, tabSummary, rememberSessionName, sessionOf, noteBrokerConnected, noteSessionOpen, retryFailedReaps } from "./tab-group-helpers";
import { isPanelSender } from "./panel-access";
import { loopbackBridgeUrl } from "./bridge-url";
import { handleAssistantNotice } from "./assistant-notifications";
import { registerAssistantEntryPoints } from "./assistant-context-menu";
import { SESSION_CLOSED, SESSION_OPEN } from "../../shared/protocol";
import { initializePresence, reapPresence, withPresence } from "./visual-presence";
import { forgetDiagnosticTab, reapDiagnostics, traceOperation } from "./diagnostics";
import { reapHealth } from "./health";

// A tab leaving a group, or a mapping being dropped, can leave an attached tab
// in no session's group; release it back to the user.
initializePresence(() => void releaseUnownedTabs().catch(() => console.warn("[tabs] could not release a tab that left its group")));
chrome.tabs.onRemoved.addListener(forgetDiagnosticTab);
// "Fråga Tabai" in the context menu and the Dela shortcut; both only open the panel on the user's own gesture.
registerAssistantEntryPoints();

const OFFSCREEN_URL = "offscreen.html";
const fromOffscreen = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(OFFSCREEN_URL);

// ---- Offscreen lifecycle ---------------------------------------------------

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification: "Maintain persistent WebSocket bridge to local MCP server.",
    });
  } catch (e) {
    console.warn("[bg] createDocument:", e);
  }
}

chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
void ensureOffscreen();

// ---- Tool dispatch ---------------------------------------------------------

async function executeTool(tool: string, args: any): Promise<unknown> {
  switch (tool) {
    case "tabs_context_mcp":
      return toolTabsContext(args);
    case "tabs_create_mcp":
      return toolTabsCreate(args);
    case "tabs_close_mcp":
      return toolTabsClose(args);
    case "resize_window":
      return toolResizeWindow(args);
    case "read_network_requests":
      return toolReadNetwork(args);
    case "navigate":
      return toolNavigate(args);
    case "get_page_text":
      return toolGetPageText(args);
    case "javascript_tool":
      return toolJavascript(args);
    case "read_page":
      return args.compact ? toolReadPageCompact(args) : toolReadPage(args);
    case "resolve_target":
      return toolResolveTarget(args);
    case "extract_table":
      return toolExtractTable(args);
    case "read_page_diff":
      return toolReadPageDiff(args);
    case "screenshot_marked":
      return toolScreenshotMarked(args);
    case "find":
      return toolFind(args);
    case "form_input":
      return toolFormInput(args);
    case "fill_form":
      return toolFillForm(args);
    case "computer":
      return toolComputer(args);
    case "file_upload":
      return toolFileUpload(args);
    case "read_console_messages":
      return toolReadConsole(args);
    case "wait_for":
      return toolWaitFor(args);
    case "select_option":
      return toolSelectOption(args);
    case "gif_creator":
      return toolGifCreator(args);
    case "dialog":
      return toolDialog(args);
    case "health":
      return toolHealth(args);
    case "print_to_pdf":
      return toolPrintToPdf(args);
    case "cookies":
      return toolCookies(args);
    case "screenshot":
      return toolScreenshot(args);
    case "emulate_device":
      return toolEmulateDevice(args);
    case "tab_switch":
      return toolTabSwitch(args);
    case "tab_reload":
      return toolTabReload(args);
    case "tab_duplicate":
      return toolTabDuplicate(args);
    case "storage":
      return toolStorage(args);
    case "get_accessibility_tree":
      return toolAccessibilityTree(args);
    case "file_drop":
      return toolFileDrop(args);
    case "download":
      return toolDownload(args);
    case "extension_reload": {
      // Reload the (unpacked) extension from disk — picks up the latest build,
      // killing the manual ↻. Ack FIRST, then reload (the SW + offscreen tear
      // down, so the response must go out before). Session-agnostic + affects
      // every session (they briefly reconnect).
      setTimeout(() => chrome.runtime.reload(), 250);
      return { ok: true, reloading: true };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ---- Message routing -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "panel-tabs") {
    if (!isPanelSender(sender) || typeof msg.sessionId !== "string" || !/^[0-9a-f]{16}$/.test(msg.sessionId)) {
      sendResponse({ ok: false, error: "Untrusted panel request" }); return false;
    }
    void (async () => {
      // A display read: it neither records tabs nor waits for the group lock.
      const groupId = await lookupGroupId(msg.sessionId);
      return groupId === null ? [] : (await tabsInGroup(groupId)).map(tabSummary);
    })().then(tabs => sendResponse({ ok: true, result: tabs }), () => sendResponse({ ok: false, error: "Kunde inte läsa sessionens flikar" }));
    return true;
  }
  if (msg?.type === "tool-call") {
    const args = (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<string, unknown>;
    // Inject the broker-authenticated sessionId so every group-aware handler
    // isolates by session. Overwrites any client-supplied value (fail-closed).
    args.__sessionId = msg.sessionId;
    if (typeof msg.sessionId === "string" && msg.sessionId) cancelSessionReap(msg.sessionId);
    const run = async () => {
      const sessionId = sessionOf(args);
      // Display metadata comes from the broker envelope, never tool arguments.
      // Health touches no group, so it never waits on this step.
      if (msg.sessionName !== undefined && msg.tool !== "health") await rememberSessionName(sessionId, msg.sessionName);
      return executeTool(msg.tool, args);
    };
    withPresence(msg.sessionId, msg.tool, args, () => msg.tool === "health" || msg.tool === "extension_reload"
      ? run() : traceOperation(msg.sessionId, "tool.execute", run, { tabId: typeof args.tabId === "number" ? args.tabId : undefined })).then(
      (result) => sendResponse({ ok: true, result }),
      (err) =>
        sendResponse({
          ok: false,
          // Forward a ToolError's machine-readable code + retryability if present;
          // a plain Error falls back to the generic TOOL_ERROR (not retryable).
          error: {
            code: err?.code ?? "TOOL_ERROR",
            message: String(err?.message ?? err),
            retryable: err?.retryable === true,
          },
        }),
    );
    return true; // async response
  }
  if (msg?.type === "broker-control") {
    if (msg.event === "assistant-attention") {
      if (!fromOffscreen(sender)) return false;
      void handleAssistantNotice(msg.notice).catch(() => console.warn("[assistant] attention notification unavailable"));
      return false;
    }
    // The broker accepted this session's hello: no retried cleanup may close it.
    if (msg.event === SESSION_OPEN && typeof msg.sessionId === "string" && msg.sessionId) {
      if (!fromOffscreen(sender)) return false;
      void noteSessionOpen(msg.sessionId).catch(() => console.warn("[tabs] could not record an open session"));
      return false;
    }
    // The broker reaps a session's group when its server process ends. Only the
    // offscreen document relays broker frames; this one closes a session's tabs
    // and starts the persisted cleanup retries.
    if (msg.event === SESSION_CLOSED && typeof msg.sessionId === "string") {
      if (!fromOffscreen(sender)) return false;
      scheduleSessionReap(msg.sessionId);
      void retryFailedReaps().catch(() => console.warn("[tabs] could not read failed session cleanups"));
      void reapDownloadState(msg.sessionId).catch(() => console.warn("[download] could not persist session cleanup"));
      reapPerceptionState(msg.sessionId);
      reapPresence(msg.sessionId);
      reapDiagnostics(msg.sessionId);
      reapHealth(msg.sessionId);
      reapGifState(msg.sessionId); // stop an abandoned recording timer
      reapDialogState(msg.sessionId);
    }
    return false; // fire-and-forget, no response
  }
  if (msg?.type === "ensure-connection") {
    ensureOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }
  // Offscreen has no chrome.storage; it reads config + writes status via us.
  // Only a loopback ws:// bridge URL is handed over; any other stored value leaves the offscreen default.
  if (msg?.type === "get-config") {
    chrome.storage.local
      .get(["bridgeUrl", "bridgeToken"])
      .then((s) =>
        sendResponse({ url: loopbackBridgeUrl(s.bridgeUrl) ?? "", token: s.bridgeToken || "" }),
      );
    return true;
  }
  if (msg?.type === "set-status") {
    // A new broker connection has to announce its sessions before any cleanup that
    // gave up earlier is tried again; an older broker never announces them.
    if (msg.status === "connected" && fromOffscreen(sender)) {
      void noteBrokerConnected().catch(() => console.warn("[tabs] could not record a new broker connection"));
    }
    chrome.storage.local
      .set({ bridgeStatus: msg.status, bridgeStatusDetail: msg.detail ?? "" })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  return undefined; // not ours (e.g. "reconnect" handled by offscreen)
});
