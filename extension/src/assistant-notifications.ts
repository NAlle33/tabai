import { assistantNoticeSchema } from "../../shared/assistant-notice";

const KEY = "tabaiAssistantNotices";
let queue: Promise<unknown> = Promise.resolve();
let listening = false;

/** A user click opens the panel; unsolicited notifications never focus Chrome. */
function registerClickHandler() {
  if (listening || !chrome.notifications?.onClicked) return;
  listening = true;
  chrome.notifications.onClicked.addListener(id => {
    if (!id.startsWith("tabai-assistant-")) return;
    void (async () => {
      try {
        const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        if (window.id === undefined) throw new Error("No browser window");
        await chrome.sidePanel.open({ windowId: window.id });
      } catch { await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") }); }
      await chrome.notifications.clear(id);
    })().catch(() => {});
  });
}
registerClickHandler();

export function handleAssistantNotice(value: unknown): Promise<void> {
  const notice = assistantNoticeSchema.safeParse(value);
  if (!notice.success) return Promise.resolve();
  const run = queue.then(async () => {
    const { id, count, critical, desktop, kind, watchEvent, routineEvent, routineTitle } = notice.data;
    await chrome.action.setBadgeBackgroundColor({ color: "#93c5fd" });
    await chrome.action.setBadgeText({ text: count ? count > 99 ? "99+" : String(count) : "" });
    await chrome.action.setTitle({ title: count ? `Tabai · ${count} punkter att granska` : "Tabai" });
    if (!desktop || !count || !await chrome.permissions.contains({ permissions: ["notifications"] })) return;
    registerClickHandler();
    const saved = await chrome.storage.local.get(KEY);
    const delivered: string[] = Array.isArray(saved[KEY]) ? saved[KEY].filter((item: unknown) => typeof item === "string").slice(-49) : [];
    if (delivered.includes(id)) return;
    // Reserve before dispatch. Reconnect or a lost receipt never replays an alert.
    await chrome.storage.local.set({ [KEY]: [...delivered, id] });
    await chrome.notifications.create(`tabai-assistant-${id}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/tabai-128.png"),
      ...(kind === "watch" && watchEvent === "paused" ? { title: "En bevakning har pausats", message: "Den pausades efter tre misslyckade körningar i rad. Slå på den igen i listan Bevakningar i Tabai." }
        : kind === "watch" ? { title: "En bevakning har slagit till", message: "Resultatet finns i samtalet Bevakningar i Tabai." }
        // The routine's own name only; its question and answer stay in the panel.
        : kind === "routine" && routineEvent === "paused" ? { title: "En rutin har pausats", message: `Rutinen ${routineTitle} pausades efter tre misslyckade körningar i rad. Slå på den igen under Inställningar → Rutiner i Tabai.` }
        : kind === "routine" ? { title: `Rutinen ${routineTitle} är klar`, message: "Öppna Tabai för att se resultatet." }
        : { title: "Nytt att ta ställning till", message: `${count} punkter väntar i Tabai${critical ? `, varav ${critical} är prioriterade` : ""}. Öppna panelen för underlaget.` }), priority: 0 });
  });
  queue = run.catch(() => {});
  return run;
}
