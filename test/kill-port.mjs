// Reap any process LISTENING on a loopback port. The broker is detached and
// OUTLIVES the server that spawned it, so tests + CI must reap it explicitly —
// otherwise the next run silently attaches to a stale-build broker.
//
// LISTENING only, on every platform. `lsof -i tcp:PORT` also matches the CLIENT
// side of every connection to that port — the calling test process (its own
// fake-extension / client sockets, still closing), every live MCP server on the
// client port, and the Chrome process holding the extension socket. Without the
// state filter a test SIGKILLs itself in its own teardown (exit 137 on Linux CI)
// and `npm run kill-broker` takes Chrome + all sessions down with the broker.
import { spawnSync } from "node:child_process";

export function killPort(port) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) return;
  try {
    if (process.platform === "win32") {
      // Query the enum value instead of netstat's localized display string.
      const out = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${number} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`], { encoding: "utf8" }).stdout || "";
      const pids = new Set(out.split(/\s+/).filter(pid => /^\d+$/.test(pid) && pid !== "0"));
      for (const pid of pids) {
        const stopped = spawnSync("taskkill", ["/PID", pid, "/T"]);
        if (stopped.status !== 0) spawnSync("taskkill", ["/PID", pid, "/T", "/F"]);
      }
    } else {
      const out = spawnSync("lsof", ["-ti", `tcp:${number}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "";
      for (const pid of new Set(out.split(/\s+/).filter(pid => /^\d+$/.test(pid)))) {
        try { process.kill(Number(pid), "SIGTERM"); } catch { /* already exited */ }
      }
    }
  } catch {
    /* best-effort */
  }
}
