// Pure navigation URL guard — shared by the `navigate` tool. Bundled into the
// extension build AND emitted standalone (dist/url-guard.mjs) so Node unit tests
// can import it without Chrome.
//
// Allowlist posture (not a denylist): the only navigable schemes are http/https
// (a scheme-less input gets https:// prepended) and the literal about:blank.
// Everything else — file:, chrome:, chrome-extension:, devtools:, javascript:,
// data:, blob:, view-source:, mailto:, unknown custom schemes — is refused.
// These tabs are MCP-controlled, so navigation is restricted to ordinary web
// URLs; the function NEVER returns a non-http(s)/non-about:blank URL.

export type NavUrlResult = { url: string } | { error: string };

export function normalizeNavigationUrl(raw: string): NavUrlResult {
  if (typeof raw !== "string") return { error: "URL must be a string" };
  // Strip ASCII control chars (tab/newline/etc.) up front so they can't ride into
  // the returned URL (log-injection / surprising divergence). The URL parser drops
  // \t\n\r anyway, but this function also returns the pre-parse candidate string.
  const input = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!input) return { error: "empty URL" };
  if (input.toLowerCase() === "about:blank") return { url: "about:blank" };

  // Treat the input as scheme-qualified only when "scheme://" is present.
  // (Parsing alone would mis-read "localhost:3000" as scheme "localhost"; the
  // "//" test keeps host:port working while still catching file:// / chrome://.)
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const candidate = hasExplicitScheme ? input : `https://${input}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // e.g. "javascript:alert(1)" → "https://javascript:alert(1)" → invalid port.
    return { error: `Refusing to navigate — not a valid http(s) URL: ${input}` };
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return {
      error: `Refusing to navigate to non-http(s) URL scheme "${scheme}:": ${input}`,
    };
  }
  // A scheme-less input that parses with userinfo (e.g. "mailto:x@y.com" →
  // "https://mailto:x@y.com") was really an opaque "word:rest" form, not a
  // host[:port] — refuse rather than silently navigate somewhere surprising.
  // (Explicit "https://user:pass@host" is still allowed. A protocol-relative
  // "//host" / "\\host" resolves to https://host — surprising but within the
  // http(s) allowlist, so not refused.)
  if (!hasExplicitScheme && (parsed.username !== "" || parsed.password !== "")) {
    return { error: `Refusing to navigate — ambiguous scheme-less URL: ${input}` };
  }
  return { url: candidate };
}
