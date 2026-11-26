import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod';
import { RecipeStore } from './recipe-store';
import { assistantWebUrl } from './assistant-web';
import { ASSISTANT_WATCH_FAILURE_LIMIT, ASSISTANT_WATCH_HISTORY_LIMIT, ASSISTANT_WATCH_RUNS_PER_HOUR, assistantWatchHistory, assistantWatchHistoryEntry, assistantWatchRunsPerDay, assistantWatchSchema, type AssistantChatIntent, type AssistantWatch, type AssistantWatchCadence, type AssistantWatchFailure, type AssistantWatchResult, type AssistantWatchValue, type AssistantWatchView } from '../shared/assistant-services';
import type { AssistantAgentConfig } from '../shared/assistant-diagnostics';

export const ASSISTANT_WATCH_LIMIT = 20;
/** The controller's existing timer pulses every 30 s; watches are considered at most this often. */
export const ASSISTANT_WATCH_CHECK_MS = 60 * 60_000 / ASSISTANT_WATCH_RUNS_PER_HOUR;
export const ASSISTANT_WATCH_WEB_OFF = 'Webbåtkomsten är avstängd';
/**
 * How long a scheduler pulse that found the browser connected counts: the
 * broker sends one every 30 s while it is, so this is two pulses and a margin.
 */
export const ASSISTANT_CONNECTED_MS = 75_000;
/**
 * How long the scheduler's pulses must have run unbroken before a scheduled run
 * may start. A sleeping Mac wakes briefly for maintenance and the broker pulses
 * then too; the longest unbroken span measured in such wakes was 98 s, and a run
 * started in one is frozen seconds later.
 */
export const ASSISTANT_AWAKE_MS = 3 * 60_000;
const stateSchema = z.object({ version: z.literal(1), watches: z.array(assistantWatchSchema).max(ASSISTANT_WATCH_LIMIT) }).strict();
type State = z.infer<typeof stateSchema>;
export type AssistantWatchIntent = Extract<AssistantChatIntent, { kind: 'watch' }>;
export type AssistantWatchChangeIntent = Extract<AssistantChatIntent, { kind: 'watch-pause' | 'watch-delete' | 'watch-edit' }>;
export const isAssistantWatchChange = (intent: AssistantChatIntent): intent is AssistantWatchChangeIntent => intent.kind === 'watch-pause' || intent.kind === 'watch-delete' || intent.kind === 'watch-edit';

export { ASSISTANT_WATCH_CAPACITY_WARNING, assistantWatchHistory, assistantWatchOverCapacity, assistantWatchRunsPerDay, assistantWatchTrend } from '../shared/assistant-services';
export function assistantWatchScheduleText(cadence: AssistantWatchCadence): string {
  if ('time' in cadence) return `varje dag kl. ${cadence.time}, 1 körning per dygn.`;
  return `${cadence.hours === 1 ? 'varje timme' : `var ${cadence.hours}:e timme`}, ${assistantWatchRunsPerDay(cadence)} körningar per dygn.`;
}
/** Watches run unattended, so the card says what every run costs on the chosen model. */
export function assistantWatchCostNote(backend: AssistantAgentConfig['backend']): string {
  if (backend === 'local') return 'Körs på den här datorn utan kostnad.';
  if (backend === 'berget') return 'Varje körning kostar pengar hos Berget, som debiterar varje anrop.';
  return `Varje körning drar användning av ditt ${backend === 'claude' ? 'Claude' : 'Codex'}-abonnemang.`;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number };
const formats = new Map<string, Intl.DateTimeFormat>();
/** The local wall clock at an instant; routines share it with watches. */
export function wall(at: number, timezone: string): Wall {
  let format = formats.get(timezone);
  if (!format) { format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formats.set(timezone, format); }
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}
const offset = (at: number, timezone: string) => { const seen = wall(at, timezone); return Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - Math.floor(at / 60_000) * 60_000; };
/**
 * The instant a local wall-clock minute falls on, using the zone's offset half
 * a day before and after it. A repeated minute (DST ends) is its first
 * occurrence; a skipped minute (DST starts) lands just after the gap.
 */
export function instant(day: { year: number; month: number; day: number }, hour: number, minute: number, timezone: string): number {
  const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const candidates = [target - offset(target - 43_200_000, timezone), target - offset(target + 43_200_000, timezone)];
  const exact = candidates.filter(at => offset(at, timezone) === target - at).sort((a, b) => a - b);
  return exact[0] ?? Math.max(...candidates);
}
export function shiftDay(day: Pick<Wall, 'year' | 'month' | 'day'>, days: number) {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function slots(now: number, time: string, timezone: string): { latest: number; next: number } {
  const [hour, minute] = time.split(':').map(Number), today = wall(now, timezone);
  const candidate = instant(today, hour, minute, timezone);
  return candidate <= now ? { latest: candidate, next: instant(shiftDay(today, 1), hour, minute, timezone) }
    : { latest: instant(shiftDay(today, -1), hour, minute, timezone), next: candidate };
}
const baseline = (watch: AssistantWatch) => Date.parse(watch.lastRunAt ?? watch.createdAt);

/**
 * Whether a watch should run now. Every due slot since the last run counts
 * once: a computer that slept or a restart runs a missed watch one time, never
 * once per missed slot. A new hourly watch runs at the next check; a daily one
 * at its next time.
 */
export function assistantWatchDue(watch: AssistantWatch, now: Date, timezone: string): boolean {
  if (!watch.enabled) return false;
  if ('hours' in watch.cadence) return !watch.lastRunAt || now.getTime() >= Date.parse(watch.lastRunAt) + watch.cadence.hours * 3_600_000;
  return slots(now.getTime(), watch.cadence.time, timezone).latest > baseline(watch);
}
export function assistantWatchNextRun(watch: AssistantWatch, now: Date, timezone: string): string | undefined {
  if (!watch.enabled) return undefined;
  if (assistantWatchDue(watch, now, timezone)) return now.toISOString();
  if ('hours' in watch.cadence) return new Date(Date.parse(watch.lastRunAt!) + watch.cadence.hours * 3_600_000).toISOString();
  return new Date(slots(now.getTime(), watch.cadence.time, timezone).next).toISOString();
}
export function localTime(value: string, timezone: string): string {
  try { return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(new Date(value)); }
  catch { return value; }
}
/**
 * The watches as chat_config shows them to the chat model: what the user sees in the
 * list, in local time. The only identity is watchId, which the change cards name;
 * the originating conversation and run bookkeeping stay with the host.
 */
export function assistantWatchesForChat(watches: AssistantWatchView[], timezone: string) {
  return watches.map(watch => ({
    watchId: watch.id, title: watch.title, target: watch.target, condition: watch.condition,
    schedule: assistantWatchScheduleText(watch.cadence),
    status: !watch.enabled ? watch.pausedAfterFailures ? 'paused-after-failures' as const : 'paused' as const : watch.paused ? 'paused-web-off' as const : 'active' as const,
    // A failed run found nothing: its status says so, so "changed: false" is never read as a check that passed.
    ...(watch.lastResult ? { lastResult: { changed: watch.lastResult.changed, status: watch.lastResult.status, summary: watch.lastResult.summary, at: localTime(watch.lastResult.at, timezone) } } : {}),
    // The three latest results, oldest first, with any value the run read: the same untrusted page summaries.
    ...(assistantWatchHistory(watch).length ? { recentResults: assistantWatchHistory(watch).slice(-3).map(entry => ({ changed: entry.changed, status: entry.status, summary: entry.summary, at: localTime(entry.at, timezone), ...(entry.value ? { value: entry.value } : {}) })) } : {}),
    ...(watch.nextRunAt ? { nextRun: localTime(watch.nextRunAt, timezone) } : {}),
  }));
}
/**
 * Saves a finished run on the watch. A successful run clears the count of failed
 * runs; only a counted failure adds to it, and the one that reaches the limit
 * pauses an enabled watch. Returns whether this result paused it.
 */
export function assistantWatchRecord(watch: AssistantWatch, result: AssistantWatchResult): boolean {
  // A file from before the history starts it with its last result.
  const history = assistantWatchHistory(watch);
  watch.lastResult = result;
  watch.history = [...history, assistantWatchHistoryEntry(result)].slice(-ASSISTANT_WATCH_HISTORY_LIMIT);
  if (result.status === 'ok') { delete watch.failedRuns; return false; }
  if (result.failure !== 'run') return false;
  watch.failedRuns = Math.min(ASSISTANT_WATCH_FAILURE_LIMIT, (watch.failedRuns ?? 0) + 1);
  if (watch.failedRuns < ASSISTANT_WATCH_FAILURE_LIMIT || !watch.enabled) return false;
  watch.enabled = false; watch.pausedAfterFailures = true;
  return true;
}
/** The user's own pause or resume: it starts the failure count over and replaces an automatic pause. */
export function assistantWatchSetEnabled(watch: AssistantWatch, enabled: boolean): void {
  watch.enabled = enabled;
  delete watch.failedRuns; delete watch.pausedAfterFailures;
}
/**
 * Web tools whose success shows that a run read its target: the page itself,
 * and for a search also the search.
 */
export const assistantWatchReadTools = (target: AssistantWatch['target']): string[] => 'url' in target ? ['web_open', 'web_read', 'web_find'] : ['web_search', 'web_open', 'web_read', 'web_find'];
/**
 * A run's report as the executor hands it over. `web` lists the web tools that
 * succeeded in the run and whether a call failed on Tabai's own connection or
 * on a tool timeout; a report without it (an older executor) is taken as it is.
 */
export type AssistantWatchReport = { changed: boolean; summary: string; failure?: 'run' | 'disconnected'; value?: AssistantWatchValue; web?: { succeeded: string[]; disconnected?: true; timedOut?: true } };
export const ASSISTANT_WATCH_UNREAD = 'Tabai kunde inte läsa källan: inget anrop till sidan eller sökningen lyckades under körningen.';
/**
 * A run that failed on a tool timeout failed on its own only while the browser
 * is still connected; otherwise the timeout was the lost connection's.
 */
export function assistantRunFailure(failure: AssistantWatchFailure, timedOut: boolean | undefined, connected: boolean): AssistantWatchFailure {
  return failure === 'run' && timedOut && !connected ? 'disconnected' : failure;
}
/**
 * The result of a reported run. A report whose run read nothing (no web call
 * that reads the target succeeded) is unreadable whatever the model said; its
 * summary is Tabai's own, since the model's cannot come from the page.
 */
export function assistantWatchOutcome(report: AssistantWatchReport, target: AssistantWatch['target'], connected: boolean): Omit<AssistantWatchResult, 'at'> {
  const unread = !!report.web && !report.web.succeeded.some(tool => assistantWatchReadTools(target).includes(tool));
  if (!report.failure && !unread) return { changed: report.changed, summary: report.summary, status: 'ok', ...(report.value ? { value: report.value } : {}) };
  const failure = assistantRunFailure(report.failure === 'disconnected' || report.web?.disconnected ? 'disconnected' : 'run', report.web?.timedOut, connected);
  return { changed: false, summary: report.failure ? report.summary : `${ASSISTANT_WATCH_UNREAD}${report.web?.timedOut ? ' Sidan svarade inte i tid.' : ''}`, status: 'failed', failure };
}
/** The host's checks on a proposed watch; a page address follows the web tools' address rules. */
export function validateAssistantWatch(intent: AssistantWatchIntent): AssistantWatchIntent {
  if ('url' in intent.target) assistantWebUrl(intent.target.url);
  return intent;
}

/** Private `watches.json`: at most twenty watches, written whole after each change. */
export class AssistantWatches {
  private readonly store: RecipeStore<State>;
  private state: State = { version: 1, watches: [] };
  unavailable?: string;
  constructor(dataDir: string) {
    this.store = new RecipeStore(join(dataDir, 'watches.json'), value => stateSchema.parse(value));
    try { this.state = this.store.load().state ?? this.state; }
    catch { this.unavailable = 'Bevakningarna kunde inte läsas säkert. Filen har bevarats.'; }
  }
  get list(): AssistantWatch[] { return structuredClone(this.state.watches); }
  find(id: string): AssistantWatch | undefined { return structuredClone(this.state.watches.find(watch => watch.id === id)); }
  private async change(update: (watches: AssistantWatch[]) => void): Promise<void> {
    if (this.unavailable) throw new Error(this.unavailable);
    const next = structuredClone(this.state);
    update(next.watches);
    stateSchema.parse(next);
    await this.store.save('state', next);
    this.state = next;
  }
  async create(intent: AssistantWatchIntent, createdFrom: string | undefined, now: Date): Promise<AssistantWatch> {
    const { kind: _kind, ...fields } = validateAssistantWatch(intent);
    const watch = assistantWatchSchema.parse({ id: randomUUID(), ...fields, enabled: true, createdAt: now.toISOString(), ...(createdFrom ? { createdFrom } : {}) });
    await this.change(watches => {
      if (watches.length >= ASSISTANT_WATCH_LIMIT) throw new Error('Du kan ha högst 20 bevakningar. Ta bort en innan du lägger till fler.');
      watches.push(watch);
    });
    return watch;
  }
  async update(id: string, update: (watch: AssistantWatch) => void): Promise<AssistantWatch> {
    let result: AssistantWatch | undefined;
    await this.change(watches => {
      const watch = watches.find(entry => entry.id === id);
      if (!watch) throw new Error('Bevakningen finns inte längre.');
      update(watch); result = structuredClone(watch);
    });
    return result!;
  }
  async remove(id: string): Promise<void> {
    await this.change(watches => { const index = watches.findIndex(entry => entry.id === id); if (index < 0) throw new Error('Bevakningen finns inte längre.'); watches.splice(index, 1); });
  }
  /** A run reserved before a restart has no result: it is reported, never run again. */
  async recover(now: Date): Promise<void> {
    if (this.unavailable || !this.state.watches.some(watch => watch.lastRunAt && (!watch.lastResult || watch.lastResult.at < watch.lastRunAt))) return;
    const result: AssistantWatchResult = { changed: false, status: 'failed', failure: 'interrupted', at: now.toISOString(), summary: 'Körningen avbröts när Tabai stängdes. Den körs inte om; nästa körning sker enligt schemat.' };
    await this.change(watches => { for (const watch of watches) if (watch.lastRunAt && (!watch.lastResult || watch.lastResult.at < watch.lastRunAt)) assistantWatchRecord(watch, { ...result }); });
  }
  /** The most overdue enabled watch, if any. */
  due(now: Date, timezone: string): AssistantWatch | undefined {
    return this.list.filter(watch => assistantWatchDue(watch, now, timezone)).sort((a, b) => baseline(a) - baseline(b))[0];
  }
  view(now: Date, timezone: string, running?: string, paused?: string): AssistantWatchView[] {
    return this.list.map(watch => {
      const held = !!paused && watch.enabled, next = held ? undefined : assistantWatchNextRun(watch, now, timezone);
      return { ...watch, running: watch.id === running, runsPerDay: assistantWatchRunsPerDay(watch.cadence), ...(held ? { paused } : {}), ...(next ? { nextRunAt: next } : {}) };
    });
  }
}
