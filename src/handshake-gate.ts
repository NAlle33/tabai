// HTTP-upgrade gate shared by both WebSocket servers (extension port + client
// port). Rejecting inside ws's `verifyClient` — BEFORE the upgrade completes —
// means a rejected peer never produces a `connection` event: the bridge never
// adopts it as "the extension", and a rejected MCP server never sees `open`, so
// its queued calls are never flushed into a socket that is about to close (they
// stay queued and go out on the next accepted connection instead).
//
// Origin is what bounds WEB PAGES: a page's WebSocket handshake always carries
// its Origin (https://site, http://localhost:3000, file://), the extension's
// offscreen document sends chrome-extension://<id>, and Node clients send none.
// Chrome's Local Network Access prompt only covers PUBLIC pages, so a page served
// from localhost or file:// reaches a loopback port with no prompt — this gate,
// not the browser, is the boundary. Any installed extension passes the prefix
// check; the optional pin (`npm run set-extension-id`) narrows it to one id.

import type { IncomingMessage } from "node:http";
import { logEvent } from "./logger";

export type GateResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

function tokenOf(req: IncomingMessage): string | null {
  return new URL(req.url ?? "", "ws://localhost").searchParams.get("token");
}

/** Extension port: the Origin must be chrome-extension:// (exactly the pinned id
 *  when one is set); then the optional token must match. */
export function gateExtension(req: IncomingMessage, token: string, extensionId: string): GateResult {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin.startsWith("chrome-extension://")) {
    return { ok: false, status: 403, reason: "origin not allowed" };
  }
  if (extensionId && origin !== `chrome-extension://${extensionId}`) {
    return { ok: false, status: 403, reason: "extension id does not match the pin" };
  }
  if (token && tokenOf(req) !== token) return { ok: false, status: 401, reason: "invalid token" };
  return { ok: true };
}

/** Client port: any Origin header means a browser page (Node clients send none). */
export function gateClient(req: IncomingMessage, token: string): GateResult {
  if (req.headers.origin !== undefined) return { ok: false, status: 403, reason: "origin not allowed" };
  if (token && tokenOf(req) !== token) return { ok: false, status: 401, reason: "invalid token" };
  return { ok: true };
}

// The detached broker has no console, so rejections go to the file log. A
// rejected page that reconnects in a loop must stay visible without flooding:
// the first rejection per (port, origin) is logged at once, then at most one
// line per minute, each carrying the running count.
const rejectSeen = new Map<string, { count: number; loggedAt: number }>();
export function logHandshakeReject(port: number, origin: unknown, status: number, reason: string): void {
  const key = `${port}|${String(origin)}`;
  const seen = rejectSeen.get(key) ?? { count: 0, loggedAt: 0 };
  seen.count++;
  const now = Date.now();
  if (seen.count === 1 || now - seen.loggedAt >= 60_000) {
    seen.loggedAt = now;
    logEvent({ src: "broker", event: "handshake-reject", port, origin: String(origin), status, reason, count: seen.count });
  }
  rejectSeen.set(key, seen);
}

type VerifyInfo = { origin: string; secure: boolean; req: IncomingMessage };
type VerifyCallback = (res: boolean, code?: number, message?: string) => void;

/** Build a ws `verifyClient` (async form) from a gate: applies it, logs a
 *  rejection, and answers the upgrade with the gate's HTTP status. */
export function verifyClientWith(port: () => number, gate: (req: IncomingMessage) => GateResult) {
  return (info: VerifyInfo, cb: VerifyCallback): void => {
    const r = gate(info.req);
    if (r.ok) return cb(true);
    logHandshakeReject(port(), info.req.headers.origin, r.status, r.reason);
    console.error(`[gate] rejected handshake on :${port()} (${r.status} ${r.reason})`);
    cb(false, r.status, r.reason);
  };
}
