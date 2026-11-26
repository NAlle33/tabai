import type { PanelReply } from "../../shared/control-panel";

interface PanelClientOptions {
  missingReplyMessage: string;
  errorFallback?: string;
  timeoutMs?: number;
  timeoutMessage?: string;
}

/** Share transport mechanics while each controller keeps its existing deadline/errors. */
export function createPanelClient<TCommand extends object = object>(options: PanelClientOptions) {
  return async function request<T = unknown>(command: TCommand): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply: PanelReply | undefined;
    try {
      const delivery = chrome.runtime.sendMessage({ type: "panel-command", command }) as Promise<PanelReply | undefined>;
      reply = options.timeoutMs === undefined ? await delivery : await Promise.race([
        delivery,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(options.timeoutMessage)), options.timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!reply) throw new Error(options.missingReplyMessage);
    if (!reply.ok) throw new Error(reply.error ?? options.errorFallback);
    return reply.result as T;
  };
}
