import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as z from 'zod';
import { RecipeStore } from './recipe-store';
import { instant, localTime, shiftDay, wall } from './assistant-watches';
import {
  ASSISTANT_WATCH_FAILURE_LIMIT, ASSISTANT_WATCH_HISTORY_SUMMARY, assistantRoutineDays, assistantRoutineDefinitionSchema, assistantRoutineSchema, assistantRoutineScheduleText, assistantRoutineTaskLabels,
  type AssistantChatIntent, type AssistantRoutine, type AssistantRoutineDefinition, type AssistantRoutineResult, type AssistantRoutineSchedule, type AssistantRoutineView,
} from '../shared/assistant-services';

export { ASSISTANT_SCHEDULE_CAPACITY_WARNING, assistantRoutineScheduleText, assistantScheduleCapacityWarning } from '../shared/assistant-services';
export { assistantRoutineWebLevel } from '../shared/assistant-web';
export const ASSISTANT_ROUTINE_LIMIT = 20;
const stateSchema = z.object({ version: z.literal(1), routines: z.array(assistantRoutineSchema).max(ASSISTANT_ROUTINE_LIMIT) }).strict();
type State = z.infer<typeof stateSchema>;
export type AssistantRoutineChangeIntent = Extract<AssistantChatIntent, { kind: 'routine-pause' | 'routine-delete' }>;
export const isAssistantRoutineChange = (intent: AssistantChatIntent): intent is AssistantRoutineChangeIntent => intent.kind === 'routine-pause' || intent.kind === 'routine-delete';
export type AssistantShortcut = { id: string; label: string; instructions: string };

const weekday = (day: { year: number; month: number; day: number }) => (new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7 + 1;
const clock = (time: string) => time.split(':').map(Number) as [number, number];
const baseline = (routine: AssistantRoutine) => Date.parse(routine.lastRunAt ?? routine.createdAt);
/** A run missed late in the evening may still start this long after its time, also after midnight. */
export const ASSISTANT_ROUTINE_LATE_MS = 30 * 60_000;
/** A local day's slot, if the routine runs that day. */
function daySlot(schedule: AssistantRoutineSchedule, day: { year: number; month: number; day: number }, timezone: string): number | undefined {
  if (!assistantRoutineDays(schedule).includes(weekday(day))) return undefined;
  const [hour, minute] = clock(schedule.time);
  return instant(day, hour, minute, timezone);
}

/**
 * Whether a routine should run now: its time today has passed, or yesterday's
 * passed at most 30 minutes ago, and it has not run since that time. A missed
 * run is made at most once: later the same day, or within 30 minutes after a
 * late-evening time even past midnight. A day the computer slept through is
 * skipped, never caught up.
 */
export function assistantRoutineDue(routine: AssistantRoutine, now: Date, timezone: string): boolean {
  if (!routine.enabled) return false;
  const at = now.getTime(), today = wall(at, timezone), last = baseline(routine);
  const missed = (slot: number | undefined) => slot !== undefined && slot <= at && slot > last;
  const yesterday = daySlot(routine.schedule, shiftDay(today, -1), timezone);
  return missed(daySlot(routine.schedule, today, timezone)) || missed(yesterday) && at - yesterday! <= ASSISTANT_ROUTINE_LATE_MS;
}
export function assistantRoutineNextRun(routine: AssistantRoutine, now: Date, timezone: string): string | undefined {
  if (!routine.enabled) return undefined;
  if (assistantRoutineDue(routine, now, timezone)) return now.toISOString();
  const today = wall(now.getTime(), timezone), days = assistantRoutineDays(routine.schedule), [hour, minute] = clock(routine.schedule.time);
  for (let offset = 0; offset <= 7; offset++) {
    const day = shiftDay(today, offset);
    if (!days.includes(weekday(day))) continue;
    const slot = instant(day, hour, minute, timezone);
    if (slot > now.getTime()) return new Date(slot).toISOString();
  }
  return undefined;
}
/** The label of what a routine does: its task, or the shortcut it starts. */
export function assistantRoutineLabel(routine: AssistantRoutineDefinition, shortcuts: AssistantShortcut[]): string | undefined {
  if (routine.kind === 'chat') return undefined;
  if (routine.task !== 'shortcut') return assistantRoutineTaskLabels[routine.task];
  return shortcuts.find(shortcut => shortcut.id === routine.shortcutId)?.label ?? 'Snabbknappen finns inte längre';
}
/**
 * The host's checks on a routine from a card or the settings: a task names an
 * existing task, and only a shortcut routine names a saved shortcut. The days
 * are kept sorted and without repeats; every day is stored as no list.
 */
export function validateAssistantRoutine(input: AssistantRoutineDefinition, shortcuts: AssistantShortcut[]): AssistantRoutineDefinition {
  const routine = assistantRoutineDefinitionSchema.parse(input);
  if (routine.kind === 'task') {
    if (routine.task === 'shortcut' && !shortcuts.some(shortcut => shortcut.id === routine.shortcutId)) throw new Error('Välj en sparad snabbknapp för rutinen.');
    if (routine.task !== 'shortcut' && routine.shortcutId !== undefined) throw new Error('Bara en rutin för en snabbknapp anger en snabbknapp.');
  }
  return { ...routine, schedule: assistantRoutineSchedule(routine.schedule) };
}
export function assistantRoutineSchedule(schedule: AssistantRoutineSchedule): AssistantRoutineSchedule {
  const days = assistantRoutineDays(schedule);
  return { time: schedule.time, ...(days.length < 7 ? { days } : {}) };
}
/**
 * Saves a finished run on the routine, with a watch's rules: a successful run
 * clears the count of failed runs, only a counted failure adds to it, and the
 * one that reaches the limit pauses an enabled routine. Returns whether it paused.
 */
export function assistantRoutineRecord(routine: AssistantRoutine, result: AssistantRoutineResult): boolean {
  routine.lastResult = { ...result, summary: result.summary.slice(0, ASSISTANT_WATCH_HISTORY_SUMMARY) };
  if (result.status === 'ok') { delete routine.failedRuns; return false; }
  if (result.failure !== 'run') return false;
  routine.failedRuns = Math.min(ASSISTANT_WATCH_FAILURE_LIMIT, (routine.failedRuns ?? 0) + 1);
  if (routine.failedRuns < ASSISTANT_WATCH_FAILURE_LIMIT || !routine.enabled) return false;
  routine.enabled = false; routine.pausedAfterFailures = true;
  return true;
}
/** The user's own pause or resume starts the failure count over, as for a watch. */
export function assistantRoutineSetEnabled(routine: AssistantRoutine, enabled: boolean): void {
  routine.enabled = enabled;
  delete routine.failedRuns; delete routine.pausedAfterFailures;
}
/**
 * The routines as chat_config shows them: what the settings list shows, in
 * local time, with routineId as the only identity a change card needs.
 */
export function assistantRoutinesForChat(routines: AssistantRoutineView[], timezone: string) {
  return routines.map(routine => ({
    routineId: routine.id, title: routine.title, kind: routine.kind,
    ...(routine.kind === 'chat' ? { prompt: routine.prompt } : { task: routine.label ?? routine.task, ...(routine.task === 'shortcut' ? { shortcutId: routine.shortcutId } : {}) }),
    schedule: assistantRoutineScheduleText(routine.schedule),
    status: !routine.enabled ? routine.pausedAfterFailures ? 'paused-after-failures' as const : 'paused' as const : 'active' as const,
    ...(routine.lastResult ? { lastResult: { status: routine.lastResult.status, summary: routine.lastResult.summary, at: localTime(routine.lastResult.at, timezone) } } : {}),
    ...(routine.nextRunAt ? { nextRun: localTime(routine.nextRunAt, timezone) } : {}),
  }));
}

/** Private `routines.json`: at most twenty routines, written whole after each change, one change at a time. */
export class AssistantRoutines {
  private readonly store: RecipeStore<State>;
  private state: State = { version: 1, routines: [] };
  private queue: Promise<unknown> = Promise.resolve();
  unavailable?: string;
  constructor(dataDir: string) {
    this.store = new RecipeStore(join(dataDir, 'routines.json'), value => stateSchema.parse(value));
    try { this.state = this.store.load().state ?? this.state; }
    catch { this.unavailable = 'Rutinerna kunde inte läsas säkert. Filen har bevarats.'; }
  }
  get list(): AssistantRoutine[] { return structuredClone(this.state.routines); }
  find(id: string): AssistantRoutine | undefined { return structuredClone(this.state.routines.find(routine => routine.id === id)); }
  private change(update: (routines: AssistantRoutine[]) => void): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.unavailable) throw new Error(this.unavailable);
      const next = structuredClone(this.state);
      update(next.routines);
      stateSchema.parse(next);
      await this.store.save('state', next);
      this.state = next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async create(definition: AssistantRoutineDefinition, shortcuts: AssistantShortcut[], createdFrom: string | undefined, now: Date): Promise<AssistantRoutine> {
    const routine = assistantRoutineSchema.parse({ id: randomUUID(), ...validateAssistantRoutine(definition, shortcuts), enabled: true, createdAt: now.toISOString(), ...(createdFrom ? { createdFrom } : {}) });
    await this.change(routines => {
      if (routines.length >= ASSISTANT_ROUTINE_LIMIT) throw new Error('Du kan ha högst 20 rutiner. Ta bort en innan du lägger till fler.');
      routines.push(routine);
    });
    return routine;
  }
  async update(id: string, update: (routine: AssistantRoutine) => void): Promise<AssistantRoutine> {
    let result: AssistantRoutine | undefined;
    await this.change(routines => {
      const routine = routines.find(entry => entry.id === id);
      if (!routine) throw new Error('Rutinen finns inte längre.');
      update(routine); result = structuredClone(routine);
    });
    return result!;
  }
  async remove(id: string): Promise<void> {
    await this.change(routines => { const index = routines.findIndex(entry => entry.id === id); if (index < 0) throw new Error('Rutinen finns inte längre.'); routines.splice(index, 1); });
  }
  /** A run reserved before a restart has no result: it is reported, never run again. */
  async recover(now: Date): Promise<void> {
    const open = (routine: AssistantRoutine) => !!routine.lastRunAt && (!routine.lastResult || routine.lastResult.at < routine.lastRunAt);
    if (this.unavailable || !this.state.routines.some(open)) return;
    const result: AssistantRoutineResult = { status: 'failed', failure: 'interrupted', at: now.toISOString(), summary: 'Körningen avbröts när Tabai stängdes. Den körs inte om; nästa körning sker enligt schemat.' };
    await this.change(routines => { for (const routine of routines) if (open(routine)) assistantRoutineRecord(routine, { ...result }); });
  }
  /** The due routines, the longest waiting first. */
  due(now: Date, timezone: string): AssistantRoutine[] {
    return this.list.filter(routine => assistantRoutineDue(routine, now, timezone)).sort((a, b) => baseline(a) - baseline(b));
  }
  view(now: Date, timezone: string, shortcuts: AssistantShortcut[], running?: string): AssistantRoutineView[] {
    return this.list.map(routine => {
      const next = assistantRoutineNextRun(routine, now, timezone), label = assistantRoutineLabel(routine, shortcuts);
      return { ...routine, running: routine.id === running, runsPerWeek: assistantRoutineDays(routine.schedule).length, ...(next ? { nextRunAt: next } : {}), ...(label ? { label } : {}) };
    });
  }
}
