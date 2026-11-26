// The broker runs on this computer, so the extension's bridge URL may name only a loopback host.
// The popup checks it when the user saves, and the service worker again before it hands the
// config to the offscreen socket, so a value stored by an older version is never used.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The trimmed URL when it is ws://, its parsed host name is exactly 127.0.0.1, localhost or [::1],
 * and it has no query or fragment, not even an empty "?" or "#"; otherwise undefined. The offscreen
 * document appends ?token=… to the URL, and a socket refuses a URL with a fragment.
 */
export function loopbackBridgeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  if (url.includes("?") || url.includes("#")) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  return parsed.protocol === "ws:" && LOOPBACK_HOSTS.has(parsed.hostname) ? url : undefined;
}
