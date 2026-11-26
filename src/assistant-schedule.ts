import type { AssistantSettings } from "../shared/assistant";

export const morningDefaults = { enabled: false, time: "08:00", notifications: false };
export const preferenceDefaults = { shortReplies: false, senderRules: [] };

function formatter(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
function parts(format: Intl.DateTimeFormat, value: Date) {
  return Object.fromEntries(format.formatToParts(value).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}
function localDay(parts: Record<string, string>): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function assistantLocalDay(value: Date, timezone: string): string {
  return localDay(parts(formatter(timezone), value));
}

/** Find the next actual wall-clock minute. Missing DST minutes are skipped;
 * the controller's durable local-day reservation handles repeated minutes. */
export function nextAssistantMorning(after: Date, settings: AssistantSettings, excludeDay?: string): string | undefined {
  const morning = settings.morning ?? morningDefaults;
  if (!morning.enabled) return;
  const format = formatter(settings.timezone);
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let stamp = start; stamp <= start + 49 * 60 * 60_000; stamp += 60_000) {
    const p = parts(format, new Date(stamp));
    if (`${p.hour}:${p.minute}` === morning.time && localDay(p) !== excludeDay) return new Date(stamp).toISOString();
  }
  throw new Error("Nästa tid för morgonöversikten kunde inte beräknas. Kontrollera tidszon och klockslag.");
}

export function assistantScheduleKey(settings: AssistantSettings): string {
  const morning = settings.morning ?? morningDefaults;
  return JSON.stringify({ enabled: morning.enabled, time: morning.time, timezone: settings.timezone, ...(settings.morning?.task === 'check-mail' ? { task: 'check-mail' } : {}) });
}
