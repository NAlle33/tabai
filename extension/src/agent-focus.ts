import { ToolError } from "./tool-error";

/** A tool flag cannot override the user's persistent foreground preference. */
export async function assertAgentFocusAllowed(): Promise<void> {
  const { allowAgentFocus } = await chrome.storage.local.get("allowAgentFocus");
  if (allowAgentFocus !== true) {
    throw new ToolError("FOCUS_DISABLED",
      'Agent focus is disabled. Continue in the background, or ask the user to enable "Tillåt att agenter tar fram Chrome" in the Tabai popup.');
  }
}
