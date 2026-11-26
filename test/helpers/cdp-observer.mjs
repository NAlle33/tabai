import { WebSocket } from "ws";
import { once } from "node:events";

/** Own one browser-level CDP socket. Closing a target remains the suite's job. */
export async function openCdpObserver(endpoint, { timeoutMs, timeoutMessage, handshakeTimeout, closedMessage = "browser CDP socket closed", onEvent } ) {
  const socket = new WebSocket(endpoint, handshakeTimeout === undefined ? {} : { handshakeTimeout });
  const pending = new Map();
  let nextId = 0;
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.on("error", rejectPending);
  socket.on("close", () => rejectPending(new Error(closedMessage)));
  socket.on("message", data => {
    let response;
    try { response = JSON.parse(data.toString()); }
    catch (error) { rejectPending(error); socket.terminate(); return; }
    if (response.id === undefined) { onEvent?.(response); return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  });
  function rpc(method, params = {}, sessionId, requestTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("browser CDP socket is not open"));
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(timeoutMessage(method))); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error || !pending.has(id)) return;
        clearTimeout(timer); pending.delete(id); reject(error);
      });
    });
  }
  try { await once(socket, "open"); }
  catch (error) { rejectPending(error); socket.terminate(); throw error; }
  return { socket, rpc, rejectPending, get pendingCount() { return pending.size; } };
}
