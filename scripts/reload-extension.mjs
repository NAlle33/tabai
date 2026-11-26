// Reload the (unpacked) extension from disk — picks up the latest build without a
// manual ↻. Connects to the broker's client port + invokes the extension_reload
// tool. Pairs with `npm run build`: `npm run build && npm run reload`.
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { clientWsUrl } from "./resolve-token.mjs";
import { PROTOCOL_VERSION } from "../dist/protocol.mjs";

const CLIENT_PORT = Number(process.env.CCMCP_CLIENT_PORT || 9225);
const ws = new WebSocket(clientWsUrl(CLIENT_PORT));
const id = randomUUID();
let done = false;
function finish(msg, code) {
  if (done) return;
  done = true;
  console.log(msg);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

ws.on("open", () => {
  ws.send(JSON.stringify({ role: "client", sessionKey: randomUUID(), version: PROTOCOL_VERSION }));
  ws.send(JSON.stringify({ id, tool: "extension_reload", args: {}, timeoutMs: 5000 }));
});
ws.on("message", (d) => {
  try {
    const m = JSON.parse(d.toString());
    if (m.id === id) {
      finish(
        m.ok ? "extension reloading — it reconnects with the new build in a moment" : `reload failed: ${m.error?.message ?? "unknown"}`,
        m.ok ? 0 : 1,
      );
    }
  } catch {
    /* ignore non-JSON */
  }
});
ws.on("error", (e) =>
  finish(`could not reach the broker on :${CLIENT_PORT} — is the extension loaded + connected? (${e.message})`, 1),
);
setTimeout(() => finish("timed out waiting for the broker", 1), 8000);
