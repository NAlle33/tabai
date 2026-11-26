/** Only our extension document may drive the local control plane. A content
 * script has our extension ID too, but its sender URL and tab are different. */
export function isPanelSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("sidepanel.html");
}
