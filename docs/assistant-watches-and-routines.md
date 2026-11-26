# Assistant watches and routines

Part of the [daily assistant](daily-assistant.md) guide.

The read-only browser limits below describe guided access. With optional
[Full Tabai access](assistant-web-access.md#full-tabai-access) enabled, watches
and routines also receive the entire ordinary MCP browser catalogue in their
own per-run session, including signed-in access and actions without panel
approval cards. Their schedules and result contracts remain unchanged; turning
full access off restores the guided limits.

## Watches (Bevakningar)

Ask in the chat, for example "säg till när laddkabeln kostar under 400 kr" or
"sammanfatta nyheter om X varje morgon". The agent proposes a card with:
- the title and target (one public page address or one web search);
- the condition;
- the schedule: daily at a time, or every 1, 3, 6 or 12 hours;
- the model and runs per day.

The watch is saved only when you approve the card, and only while web access is
on. At most 20 watches are kept in private `assistant/watches.json`.

**Model.** Watches use their own model, **Inställningar → Bevakningar**. Local
Qwen 3.5 4B is the default and costs nothing. Codex and Claude draw on your usage
limit, and Berget costs money per run; the card says so. There is no fallback:
a missing local model stops the run with a message.

**Running.** A watch runs unattended in its own executor:
- it uses only the web read tools and `watch_report`;
- its tabs open in their own incognito window, without fallback;
- it opens only its own address and its own search results;
- it never clicks, fills in, signs in or buys.

The controller starts at most one due watch or routine every five minutes (see
[Routines](#routines-rutiner)). Missed times produce one run; a run interrupted by
a restart is reported, not repeated.

**Capacity.** One start every five minutes is at most 12 runs an hour. When the
enabled watches together need more (for example 13 hourly watches), the list and
the card for a new watch warn that some runs will happen later than scheduled.
Paused watches do not count. A daily watch counts as 1/24 of a run an hour.
Routines share the schedule, so the warning counts the enabled routines too (a
weekly routine is 1/7 of a run a day) and then names both.

**Automatic pause.** A watch pauses itself after 3 failed runs in a row. Only
runs that reached their model and failed count: the model could not read the
target (`watch_report` with `readable: false`), ended without `watch_report`, or
hit the time limit. These never count, and never reset the count:
- a run interrupted because Tabai stopped;
- a run ended because you changed **Inställningar → Webbåtkomst** while it ran
  (`stopped`): that is your own stop. The watch runs again at its next time; with
  web access turned off it stays paused until web access is on again;
- a lost browser, extension or broker connection during the run;
- a model that could not run (Codex or Claude missing or signed out, Ollama not
  running or the model not pulled, no Berget key or a Berget limit), including
  the start failures.

Two more runs count, judged by the host rather than the model:
- a web call that timed out (`TIMEOUT`), when the browser stayed connected for
  the whole run, from its start to its report. A call that was on a connection
  when it dropped is never resent; it times out instead, so a lost connection
  looks like a page that hung. The controller tells them apart by the broker's
  scheduler pulse ([assistant-pulse.ts](../src/assistant-pulse.ts)): the broker
  pulses every 30 seconds whether or not the extension is connected, and at once
  when an extension connection closes, also one a newer connection replaced. The
  controller records when the browser was lost: a pulse without it, or a pulse
  more than 75 seconds after the previous one. A timeout counts only if no loss
  was recorded after the run started and a pulse within the last 75 seconds found
  the browser at the report; otherwise it is the lost connection's and does not
  count. An extension reload during a run therefore never counts, even when the
  extension is back before the run reports. The run is judged in the controller's
  queue, after any pulse that came before its report. A pulse without the browser
  only records the loss: no Ollama check, no module polling and no start, so the
  assistant does next to nothing while Chrome is closed. `SESSION_BUSY`,
  `QUEUE_FULL` and the other connection codes never count;
- a report from a run in which no web call that reads the target succeeded
  (`web_open`, `web_read` or `web_find`; for a search target also `web_search`).
  It is unreadable whatever the model reported, and the result carries Tabai's own
  text instead of the model's summary.

Each result records its failure kind (`run`, `interrupted`, `disconnected`,
`unavailable`, `stopped`) and is still shown as "Kunde inte köras". A successful
run, scheduled or with **Kör nu**, clears the count. When a watch pauses itself:
- the list shows "Pausad efter misslyckanden" with the reason;
- `chat_config` reports the status `paused-after-failures`;
- **Bevakningar** gets a message from Tabai;
- a notice is sent with fixed text and no page content, also as a desktop
  notification unless watch notifications are off.

**Återuppta**, in the list or on a resume card, starts the count over.

**Results.** Each result goes to the conversation **Bevakningar**. When the
condition is met, a notice is sent, and a desktop notification unless watch
notifications are off under **Inställningar → Bevakningar**; Chrome's own notification
permission still applies.

**History and trend.** Each watch keeps its 10 latest results in `history`,
including runs that could not run: time, status, `changed`, a summary of at most
300 characters and an optional value. `lastResult` stays, whole, for older
readers, and a `watches.json` from before the history loads as before: its
`lastResult` starts the history at the next run. `watch_report` takes an optional
`value: { amount, unit }`, such as 48 and "öre/kWh", when the page shows the number
the watch is about; it is never required, and a failed run keeps none. The list
shows a trend under the last result:
- with values, the latest five in the latest unit and the last step's direction,
  for example "164 → 120 → 48 öre/kWh ↓";
- otherwise, the three latest summaries, folded under "Senaste resultaten".

The message in **Bevakningar** ends with the value when there is one.

**Finding them.** The row **Bevakningar** is pinned at the top of the
conversation list. It shows how many are active and the next run, or "Pausade"
while web access is off. A dot appears after a new hit until the list is opened.
The list shows each watch with its target, condition, schedule and last result,
with **Kör nu**, **Pausa**/**Återuppta** and **Ta bort**.
**Inställningar → Bevakningar** keeps the model and notification choices.

**In the chat.** The agent can read your watches through `chat_config`: titles,
targets, conditions, schedules, local times and last results with their status
(`ok` or `failed`), the three latest results with any value as `recentResults`
(oldest first), and whether each is `active`, `paused`, `paused-after-failures` or
`paused-web-off`. The summaries are marked as untrusted material. When
`watches.json` cannot be read, `chat_config` has `watchesError` and the row
**Bevakningar** says "Kunde inte läsas" instead of "Inga ännu". A local chat model
gets a compact copy before its first turn (each summary cut to 200 characters with
the warning "obetrott underlag från webben" beside it, about 8,000 characters in
all, skipped after an error or 15 seconds), and `chat_config` is then no longer
offered to it. The agent can answer "vilka bevakningar har jag?" and propose to
pause, resume, change (condition or schedule) or delete one as a card. A resume
card, like a schedule change, names the model and what each run costs. The host
checks that the watch still exists when the card is proposed, confirmed and
applied; a card for a watch that is gone is closed as failed with the reason.
A card for a new watch with the address, the search or the title of a saved watch
(ignoring case and spaces) is refused when it is proposed, for every model: the
agent is told that the watch exists and asked to propose pausing, changing or
deleting it instead. This keeps a short request such as "Pausa elpriset." from
turning into a copy of the watch. The same check runs again when you approve a
card, so of two waiting cards for one page only the first approved is saved; the
other is closed with "Du bevakar redan den här sidan: {titel}." **Bevaka
priset** in a price comparison uses the same check
([Web access](assistant-web-access.md)).

## Routines (Rutiner)

A routine is a chat question or an existing task that runs at a set time, for
example "varje fredag kl. 16 vill jag ha en sammanfattning av veckans mejl". It
has a title, a schedule (`time` as `HH:MM` in your time zone and `days`, 1 for
Monday to 7 for Sunday; no days means every day) and either:
- `kind: 'chat'` with a `prompt`; or
- `kind: 'task'` with `task`: `check-mail` (Kolla mejl), `my-day` (Min dag),
  `prepare-meeting` (Förbered möte), `follow-ups` (Följ upp) or `shortcut` with
  the `shortcutId` of one of your own shortcuts.

At most 20 routines are kept in private `assistant/routines.json`, written whole
after each change, one change at a time.

**Creating one.** In the chat the agent proposes a `routine-create` card with the
question or task, the schedule, the model and what each run costs; the routine is
saved only when you approve it. **Inställningar → Rutiner** has the list and
**Ny rutin**. A task routine needs an active mail account.

**The shared schedule.** Routines and watches share one schedule: at most one
start every five minutes, only while the browser is connected, and never two runs
at once. A due routine goes before a due watch. A task routine waits while a mail
task or a self-test runs, and is tried again at a later check the same day. A
missed run is made at most once: later the same local day, or up to 30 minutes
after its time when that crosses midnight, so a routine at 23:58 still runs at a
check at 00:01. A day the computer slept through is skipped, not caught up. A
pulse without the browser uses no check: the first one after the browser is back
may start a run. Daylight saving follows the watches'
rules: a skipped time runs just after the gap, and a repeated one at its first
occurrence.

**A chat routine** runs one chat turn in the conversation **Rutiner**, which is
created on demand and never selected by a run. Its question is the turn's only
user message, and it uses the chat model on the background executor that watches
use, so it never blocks your own chat. Its web level is at most `read`, whatever
**Webbåtkomst** allows, and with web access off it has no web at all. Its web tabs
open only in their own incognito window, never in normal Chrome where your
sign-ins are: without "Tillåt i inkognito" the routine says it could not run for
that reason. It may open any public page, not only its own search results. The routine
worker mode (`TABAI_ASSISTANT_CHAT=routine`) lists the chat tools without
`chat_start_task` and `chat_module_reply`, and only the read tools; every backend,
including the local and Berget runners, gets exactly that list, and the host
refuses everything else. Cards the turn proposes wait in **Rutiner**; nothing is
approved or carried out by itself. The answer is an `assistant` message headed
"Rutin: {titel}".

**A task routine** starts its task the way the morning check does (Kolla mejl and
Min dag with the morning check's instructions), under the tasks' own mail and web
rules, as a scheduled run. **Rutiner** gets a short message that follows the task
and links to Mejl, where the result is.

**Failures and pause.** A routine counts failed runs like a watch: only the run's
own failures count, a successful run clears the count, and the third in a row
pauses it, with a message in **Rutiner** and a notice. A tool timeout counts only
when the browser stayed connected for the whole run, as for watches; a lost
connection, a model that could not run, Tabai's restart and your own change never
count. A change under **Webbåtkomst**, made while web access is on, ends a running chat
routine as your own stop; it runs again at its next time, without web if web access
is now off. A
task routine whose
shortcut is gone fails on its own; one without an active mail account does not
count. A run interrupted by a restart is reported, not repeated. The rule that a
run must read its target is for watches only: a chat routine may use no web.

**Notices.** `routineNotifications` is on by default. A finished routine sends a
notice with the fixed text "Rutinen {titel} är klar" and no answer; a task routine
is finished when its task is. The notice uses `kind: 'routine'`, and Chrome's own
notification permission still applies.

**The settings page.** **Inställningar → Rutiner** lists each routine with its
question or task, schedule, next run, state and last result, with **Kör nu**,
**Pausa**/**Återuppta**, **Ändra tid** (time and weekday toggles) and **Ta bort**.
A draft in the form or in an open time editor survives the panel's polling.

**In the chat.** `chat_config` lists the routines with `routineId`, title, kind,
question or task, schedule, status (`active`, `paused` or
`paused-after-failures`), last result and next run, plus your shortcuts' ids and
labels. The agent can propose `routine-pause` or `routine-delete` on a card; the
host checks that the routine still exists. A `routine-create` card with the title
of a saved routine is refused the same way as a copy of a watch, also when it is
approved after another card saved that routine ("Du har redan rutinen {titel}."). A local model's
grammar names only the `routineId`s that `chat_config` listed, like `watchId`.
