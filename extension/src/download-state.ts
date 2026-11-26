// Download capture survives worker idle/restart within this browser session.
// Every state transition (including Chrome events) uses one serialized write
// chain. In-memory waiters are notified only after storage commits successfully.
import { WAIT_TIMEOUT_MAX_MS } from "../../shared/protocol";

export const DOWNLOAD_ARM_TTL_MS = WAIT_TIMEOUT_MAX_MS + 60_000;
type DownloadResult = { state: string; path?: string; bytes?: number; note?: string };
interface Capture {
  armed: boolean;
  captureId: number | null;
  done: DownloadResult | null;
  /** When `done` was stored; a result left uncollected for an arm's lifetime no longer blocks a new arm. */
  doneAt?: number;
}
export interface DownloadState {
  lock: { sid: string; armedAt: number } | null;
  sessions: Record<string, Capture>;
}
type Waiter = { finish: (result: DownloadResult) => void };
const waiters = new Map<string, Set<Waiter>>();
let writes: Promise<unknown> = Promise.resolve();

export function armDecision(state: DownloadState, sid: string, now: number): "grant" | "busy" | "takeover" {
  if (!state.lock || state.lock.sid === sid) return "grant";
  return now - state.lock.armedAt >= DOWNLOAD_ARM_TTL_MS ? "takeover" : "busy";
}

function updateDl<T>(change: (state: DownloadState, committed: (fn: () => void) => void) => T | Promise<T>): Promise<T> {
  const run = writes.then(async () => {
    const stored = await chrome.storage.session.get("dl");
    const state: DownloadState = stored.dl ?? { lock: null, sessions: {} };
    const effects: (() => void)[] = [];
    const result = await change(state, fn => effects.push(fn));
    await chrome.storage.session.set({ dl: state });
    for (const effect of effects) effect();
    return result;
  });
  // A rejected write fails its caller, but cannot poison the next transaction.
  writes = run.catch(() => {});
  return run;
}

function notify(sid: string, result: DownloadResult): void {
  const waiting = waiters.get(sid);
  waiters.delete(sid);
  for (const waiter of waiting ?? []) waiter.finish(result);
}

function clearOwner(state: DownloadState, sid: string): void {
  const capture = state.sessions[sid];
  if (capture) { capture.armed = false; capture.captureId = null; }
  if (state.lock?.sid === sid) state.lock = null;
}

export async function armDownload(sid: string) {
  try {
    return await updateDl((state, committed) => {
      // Re-arming would discard this session's running capture or its finished,
      // uncollected result; the next collect would then advise arming and
      // triggering again, which downloads the file twice. Nothing changes, and
      // the answer is armed:false: callers trigger only on armed:true.
      if (state.lock?.sid === sid && state.sessions[sid]?.captureId != null
        && Date.now() - state.lock.armedAt < DOWNLOAD_ARM_TTL_MS) {
        return { ok: true, armed: false, note: "a download is already in progress for this session — call collect next; do not trigger it again" };
      }
      // A finished result is kept for as long as an arm lives. An older one belongs to an
      // attempt the caller left behind: holding it would refuse every later arm of the session.
      const waiting = state.sessions[sid];
      if (waiting?.done && Date.now() - (waiting.doneAt ?? 0) < DOWNLOAD_ARM_TTL_MS) {
        const file = waiting.done.path ? ` (${waiting.done.path})` : "";
        return { ok: true, armed: false, note: `this session's download${file} has finished and its result is waiting — call collect next; do not trigger it again` };
      }
      const decision = armDecision(state, sid, Date.now());
      if (decision === "busy") {
        return { ok: false, armed: false, note: "another session is capturing a download — retry shortly" };
      }
      if (decision === "takeover") {
        const previous = state.lock!.sid;
        clearOwner(state, previous);
        // The previous capture cannot claim the next onCreated by Map order.
        delete state.sessions[previous];
        committed(() => notify(previous, { state: "preempted" }));
      }
      state.lock = { sid, armedAt: Date.now() };
      state.sessions[sid] = { armed: true, captureId: null, done: null };
      committed(() => notify(sid, { state: "preempted" }));
      return { ok: true, armed: true };
    });
  } catch {
    return { ok: false, armed: false, error: "could not persist the download arm" };
  }
}

export async function collectDownload(sid: string, requestedTimeout?: number): Promise<DownloadResult> {
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(1, requestedTimeout!)) : 30_000;
  let resolveResult!: (value: DownloadResult) => void;
  const result = new Promise<DownloadResult>(resolve => { resolveResult = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiter: Waiter = { finish: value => { clearTimeout(timer); resolveResult(value); } };
  await updateDl((state, committed) => {
    const capture = state.sessions[sid];
    if (capture?.done) {
      const done = capture.done;
      delete state.sessions[sid];
      committed(() => waiter.finish(done));
      return;
    }
    // An arm still waiting for its download is kept alive by collect. A started
    // download's lifetime runs from its start: collect calls cannot extend it,
    // so a stuck download cannot hold the shared arm indefinitely.
    if (state.lock?.sid === sid && capture?.captureId == null) state.lock.armedAt = Date.now();
    committed(() => {
      const waiting = waiters.get(sid) ?? new Set<Waiter>();
      waiting.add(waiter);
      waiters.set(sid, waiting);
      timer = setTimeout(() => {
        void updateDl((state, committed) => {
          const waiting = waiters.get(sid);
          if (!waiting?.has(waiter)) return;
          // A captured download that is still running within its lifetime is
          // kept: its completion is stored for the next collect. Triggering it
          // again would create a duplicate download. Past its lifetime the
          // capture is cleared, but the download may still be running.
          const started = state.sessions[sid]?.captureId != null;
          const running = started && state.lock?.sid === sid
            && Date.now() - state.lock.armedAt < DOWNLOAD_ARM_TTL_MS;
          // One short collect cannot abandon another collect for this session.
          if (!running && waiting.size === 1) {
            clearOwner(state, sid);
            delete state.sessions[sid];
          }
          committed(() => {
            waiting.delete(waiter);
            if (waiting.size === 0) waiters.delete(sid);
            waiter.finish(running
              ? { state: "in_progress", note: `the download started but did not finish within ${timeoutMs}ms — call collect again; do not trigger the download again` }
              : started
                ? { state: "timeout", note: "the download started but did not finish within the capture's lifetime and may still be running in the browser — do not trigger it again without checking whether it finished" }
                : { state: "timeout", note: `no download completed within ${timeoutMs}ms — arm BEFORE triggering, then trigger, then collect` });
          });
        }).catch(() => {
          waiters.get(sid)?.delete(waiter);
          waiter.finish({ state: "error", note: "could not persist download timeout; call collect again" });
        });
      }, timeoutMs);
    });
  });
  return result;
}

export async function reapDownloadState(sid: string): Promise<void> {
  await updateDl((state, committed) => {
    clearOwner(state, sid);
    delete state.sessions[sid];
    committed(() => notify(sid, { state: "preempted" }));
  });
}

chrome.downloads.onCreated.addListener(item => {
  void updateDl((state, committed) => {
    const owner = state.lock;
    if (!owner) return;
    if (Date.now() - owner.armedAt >= DOWNLOAD_ARM_TTL_MS) {
      clearOwner(state, owner.sid);
      delete state.sessions[owner.sid];
      committed(() => notify(owner.sid, { state: "preempted" }));
      return;
    }
    const capture = state.sessions[owner.sid];
    if (capture?.armed && capture.captureId === null) {
      capture.captureId = item.id;
      owner.armedAt = Date.now(); // the capture's lifetime runs from the download's start
    }
  }).catch(() => console.warn("[download] could not persist download attribution"));
});

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
  void updateDl(async (state, committed) => {
    const sid = state.lock?.sid;
    if (!sid) return;
    const capture = state.sessions[sid];
    if (!capture || capture.captureId !== delta.id) return;
    let done: DownloadResult = { state: "interrupted" };
    if (delta.state?.current === "complete") {
      const [file] = await chrome.downloads.search({ id: delta.id });
      done = file?.filename
        ? { state: "completed", path: file.filename, bytes: file.fileSize }
        : { state: "completed", note: "download completed but its file record was not found" };
    }
    clearOwner(state, sid);
    // A restarted worker has no waiters: persist the completed result for its
    // next collect. An active collect consumes it here, just as a direct read.
    if (waiters.get(sid)?.size) delete state.sessions[sid];
    else { capture.done = done; capture.doneAt = Date.now(); }
    committed(() => notify(sid, done));
  }).catch(() => console.warn("[download] could not persist download completion; call collect again"));
});
