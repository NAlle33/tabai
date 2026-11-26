// Canonical list of tools the extension's executeTool() can dispatch. Single
// source of truth: src/server.ts builds BRIDGE_TOOLS from this, and
// test/tool-names-consistency.mjs asserts it matches background.ts's switch.
// Bundled into the server build and emitted standalone (dist/tool-names.mjs).
//
// When adding a new extension-dispatched tool: add its name here AND a case in
// extension/src/background.ts executeTool() AND a registerTool in src/server.ts.
export const EXTENSION_TOOLS = [
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "resize_window",
  "read_network_requests",
  "navigate",
  "get_page_text",
  "javascript_tool",
  "read_page",
  "resolve_target",
  "extract_table",
  "read_page_diff",
  "screenshot_marked",
  "find",
  "form_input",
  "fill_form",
  "computer",
  "file_upload",
  "read_console_messages",
  "wait_for",
  "select_option",
  "gif_creator",
  "dialog",
  "health",
  "print_to_pdf",
  "cookies",
  "screenshot",
  "emulate_device",
  "tab_switch",
  "tab_reload",
  "tab_duplicate",
  "storage",
  "get_accessibility_tree",
  "file_drop",
  "download",
  "extension_reload",
] as const;
