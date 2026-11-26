import { WebSocket } from "ws";
import { once } from "node:events";

export function trackedSocket(registry, socket) {
  registry.add(socket);
  socket.once("close", () => registry.delete(socket));
  return socket;
}
export function openSocket(registry, url, options) {
  const socket = trackedSocket(registry, new WebSocket(url, options));
  socket.on("error", () => {});
  return socket;
}
export async function waitOpen(socket) {
  try { await once(socket, "open"); return socket; }
  catch (error) { socket.terminate(); throw error; }
}
export async function closeSocket(socket, timeoutMs = 250) {
  if (!socket) return;
  if (typeof socket.terminate !== "function") { socket.destroy(); return; }
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => socket.once("close", resolve));
  const force = setTimeout(() => socket.terminate(), timeoutMs);
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
    await closed;
  } finally { clearTimeout(force); }
}
export async function closeSockets(registry) {
  await Promise.all([...registry].map(socket => closeSocket(socket)));
}
export function ownChild(registry, child) {
  registry.add(child);
  child.once("exit", () => registry.delete(child));
  child.once("close", () => registry.delete(child));
  return child;
}
export async function stopChild(child, signal = "SIGTERM", timeoutMs = 2000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  const force = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try { child.kill(signal); await exited; } finally { clearTimeout(force); }
}
export async function stopChildren(registry) {
  await Promise.all([...registry].map(child => stopChild(child)));
}

// Correlation only. The suite owns parsing, valid/malformed frames and every send.
export function pendingResponses(socket, { timeoutMs, timeoutMessage }) {
  const pending = new Map();
  const dispose = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.once("close", () => dispose(new Error("fixture socket closed")));
  socket.on("error", dispose);
  return {
    wait(id, send) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(timeoutMessage(id))); }, timeoutMs);
        pending.set(id, { timer, resolve, reject });
        try { send(); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    resolve(id, value) {
      const entry = pending.get(id); if (!entry) return;
      pending.delete(id); clearTimeout(entry.timer); entry.resolve(value);
    },
    dispose,
  };
}
