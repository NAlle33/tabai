# Workflows and page perception

The registered schemas in [tool-catalog.ts](../src/tool-catalog.ts) are the argument authority.
The current server checks its required extension version in
[shared/protocol.ts](../shared/protocol.ts). Refresh both the extension and the MCP
host's stdio server after updating. Shared panel-contract changes also require a
broker restart; coordinate that shared restart as described in
[the build/reload instructions](../CLAUDE.md#after-every-build).
The Chrome control panel was added in 0.12.0.

## Chrome control panel

Open **Öppna kontrollpanelen** in the extension popup. Choose the connected MCP
session under **Sessioner, recept och teknisk historik** whose work you want to follow. The panel's
primary task surface is the [daily assistant](daily-assistant.md); it does not
require an open agent chat. **Pågår** shows running batches/recipes,
their current tool, tab, step, observation stage and elapsed time, plus direct tool
activity and error classifications. Completed runs include expandable step results.
When the local checkpoint or timeout-bundle file cannot be read, **Pågår** names it
in an error line and that list shows empty; runs, tool activity, recording and
**Stoppa efter pågående steg** stay available. While checkpoints cannot be read,
**Spara kontrollpunkter för säker återupptagning** is disabled.

The daily assistant anchors new task groups to the window containing its panel.
The MCP `tabs_context_mcp` tool also accepts an explicit `createWindowId` with
`createIfEmpty`: it creates new owned tabs in that normal window, never adopts
existing tabs or relocates a live group. Omitting it preserves the background
window default. A missing target window fails without falling back elsewhere.

**Stoppa efter pågående steg** applies to the selected workflow, including one
started through MCP. Its current target resolution, action and expectation finish;
the next step is not dispatched. A stop before the first step dispatches nothing.
A stop during the final step still reports success when every step succeeds. Failed
expectations remain failures. This is distinct from MCP request cancellation, which
keeps its existing behavior. The button does not pause the agent or block subsequent
independent tool requests. Already applied page changes are never undone or replayed.

**Recept** reads the existing server store, renders string/number/boolean parameters
and defaults, and starts a saved recipe in a chosen owned tab. A selected tab fills
only missing action tab IDs. The server checks the chosen tab before starting and
every action still passes the existing ownership gate. A busy session disables new
panel starts. A required parameter without a default cannot be started empty,
strings included. Parameters remain in page memory; they are not written to extension
storage. Updating an unchanged recipe list preserves entered values. Closing or
reopening the panel does not cancel or repeat a run.

**Historik** displays the last 100 runs in the server's existing shared local store,
with outcome, timing, failed step and step classifications. It is not restricted to
the currently selected session. Raw browser outputs/arguments are intentionally not
stored. **Visa sparad felbild** opens an already opted-in PNG directly in the panel;
`run_history` remains available to the agent. Images load only on request, in bounded
chunks, and the viewer closes on view/session changes or disconnect. Retention may
remove an image before it is opened; the panel reports that failure. Old servers
without the debugging capability show an update instruction.
Panel starts do not enable screenshot capture. The recipe picker displays up to 100
recipes and explicitly reports truncation when the store is larger.

The selected MCP process must stay running. A disconnect makes its live state
unavailable; a failed/ambiguous start response must be checked in **Pågår** and
**Historik** before starting again. No command is replayed automatically. Servers
without panel capability appear with a restart instruction. An old broker without
the reverse route produces a timeout and update guidance.

Updating 0.15 to 0.16 adds no permission: build, restart the idle broker/MCP process
and reload the existing extension. The removal step below applies only to an older
install that has not yet granted `sidePanel`.

For an existing install, build the new version, refresh the broker with
`npm run kill-broker` when all sessions are idle, restart the MCP host's stdio server,
and install the updated extension manifest. The new `sidePanel` permission requires
remove + **Load unpacked** according to the repository's installation procedure;
keep any custom popup connection settings before removal. Verify the loaded popup
version, a connected session, and that **Öppna kontrollpanelen** opens Chrome's panel.
This permission adds a companion UI; existing page permissions and tool ownership
remain unchanged. [Chrome's Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
documents the manifest and user-gesture requirements.

## Recording a recipe

Open **Inställningar → Avancerat → Recept → Spara ett arbetsflöde**, select a
session-owned tab and choose **Börja spela in**. Let the agent perform the flow,
then **Stoppa och granska**. Review the targets, required inputs and result check
for every step before **Spara granskat recept**. The agent can also control capture
with `recipe_record`; saving remains an explicit panel review. Recording captures
Tabai's tool steps, not manual browser gestures.

A successful action is not proof of an application's business result. Suggested
address/field checks need review; choose an actual confirmation for a submission.
Select labels and string checkbox inputs need an explicit check because their
accepted input can differ from the DOM value. Synthetic pointer steps must use a
document-bound ref or workflow target so replay preserves their event behavior.
Unsupported or uncertain steps require a new recording instead of silently saving
an incomplete flow. The current supported operations and bounds belong to
[`recipe_record` and `resolve_target`](../src/tool-catalog.ts) and the
[recorder](../src/recipe-recording.ts).

Recording is opt-in because ordinary text and addresses may be private. Drafts
stay in the selected MCP process until explicit save or discard and disappear on
process exit. Recognized sensitive fields use required parameters without saved
values, named with the reserved `secret_` prefix; the review refuses a name without
it, so **Recept** asks for the value in a masked field. This is targeted field
protection, not general redaction of page labels, ordinary text or every possible
credential URL; review the draft before saving.
The [review view](../extension/src/recipe-recording-view.ts) and
[recording contracts](../shared/recipe-recording.ts) own the controls and save input.
The existing recipe store owns persistence and backup; saving does not run a recipe
or replace an existing name. [Live recording tests](../test/recipe-recording-live.mjs)
cover panel review and replay in a fresh tab.

## Build and operation diagnostics

Version 0.15 adds `health.serverBuildId` and `health.extension.buildId`: SHA-256
identities of the build's source, static extension assets, locked dependencies
and baked configuration. Rebuilds, including watch rebuilds, recompute the identity.
They identify loaded build inputs, rather than asserting that disk files are loaded.
Refresh the extension and the MCP host's stdio process/catalog from the same build
when `buildMismatch:true` appears. No new permission or protocol version is required.

Version 0.16 adds `health.brokerBuildId` through an opt-in protocol-v1 handshake.
`brokerBuildStatus` is `matching`, `mismatched` or `unknown`. An old broker remains
usable but reports unknown identity. `refresh` lists peers that differ from the
running server or have no build status. Restart that broker / reload that extension
from the intended build; restart the MCP server too if it is the stale component.
Build IDs identify differences, not which build the operator intended to run.

The panel's **Pågår → Teknisk diagnostik** shows all three identities and the selected
session's pending/recent operation names, elapsed milliseconds, status, tab ID and
sanitized error code. Pending cosmetic work beyond its wait budget is marked
degraded; ordinary tools can continue. An unconfirmed hide still refuses captures.
These records contain no tool arguments, URLs, page values or raw errors. They
live only in bounded worker memory, disappear on session cleanup/restart, and are
distinct from persistent workflow history. Limits are owned by
[diagnostics.ts](../extension/src/diagnostics.ts).

Health spends at most 500 ms on a session's read-only group inspection and reuses
that inspection while Chrome is stalled. `inspection:"unavailable"` means Chrome
has not confirmed the group metadata; the empty fallback fields must not be treated
as evidence of no tabs. Build identity and operation records remain available.
A pending stage localizes an observed stall; it does not establish the cause of a
historical timeout without a matching live reproduction.

`timeout_incidents` lists or reads automatic timeout bundles. The MCP client makes
one read-only health probe (1.5-second transport budget) after a coded `TIMEOUT`,
then saves metadata before returning the original failure. Worker-owned wait
deadlines now carry that code with `retryable:false`. No original action is retried.
If Chrome or the bridge is unavailable, the bundle says diagnostics are unavailable;
it cannot recover observations from a worker that has already died.

`timeout-incidents.json` in `CCMCP_CONFIG_DIR` retains 50 bundles across MCP/extension
reloads. It contains build IDs, timestamps, durations and whitelisted operation
metadata, never arguments, URLs, page output, screenshots or raw error messages.
At most four diagnostic health probes run concurrently; additional timeouts save
minimal bundles marked unavailable. Storage is private, size-bounded and
locked across local processes; corrupt files are preserved. A failed save is
reported on stderr and never changes/replays the failed action. Like run history,
bundles are shared by trusted local processes. The panel lists the latest five and
opens their saved operation/build metadata through **Visa timeoutpaket**. A failed
workflow step preserves its actual incident ID when one was captured, and history
offers **Visa stegets timeoutpaket**. Older records without an ID are not guessed
into a correlation. The agent can still use `timeout_incidents {incidentId}`.
A snapshot is evidence of
observed work, not proof of the historical timeout's exact cause.

## Loop guard

The MCP process observes ordinary page mutations through one shared boundary for
direct tools, batches and recipes. It covers `form_input`, `fill_form`,
`select_option`, `file_upload`, `file_drop`, and `computer` click variants, typing,
keys, scrolling, scroll-to and drag. Arbitrary JavaScript is not classified as a
read or mutation; use meaningful workflow expectations for its effects.

Before each covered mutation, one bounded read-only compact page scan records
document identities, root/nested scroll positions and a page fingerprint in memory.
This internal observation never mints or repairs element refs: an ambiguous ref
must still fail when the requested action resolves it. Explicit page reads and
target resolution continue to issue fresh refs.
After three successful
identical actions with unchanged complete observations, the fourth is refused
with `LOOP_DETECTED` before dispatch. Different actions, observed changes and new
documents reset the sequence. Missing, truncated, slow, stale or concurrently
invalidated observations cannot establish stagnation. This observes page content,
not hidden server-side effects; masked fields and deliberate repeated clicks can
therefore require manual inspection.

**Pågår** shows the paused tab and tool. Reads remain available. Inspect the page,
then choose **Fortsätt efter kontroll** to release that exact pause. Nothing is
queued, dispatched, replayed or automatically resumed by this button. A stopped
recipe stays stopped; checkpoint rules still reject uncertain effects. A completed
navigation/reload or tab closure clears its state; a failed navigation does not.
Each MCP process holds at most 32 tab states, retaining existing pauses when full.
If every slot is paused or busy, a mutation on an additional tab is refused before
dispatch with `LOOP_GUARD_CAPACITY`; inspect and continue or close an observed tab.
State disappears on process
exit and stores only hashes and pause metadata, never raw arguments or page text.
Bounds and classification are owned by [loop-guard.ts](../src/loop-guard.ts).

## Background keyboard readiness

Main-frame `computer key` uses trusted CDP input without selecting the tab or
focusing its window. Chromium can discard keys while a newly navigated background
document still defers its first contentful paint. Before the first key in a call,
Tabai checks that paint marker. If it is missing, one unclipped background surface
capture produces a frame through the existing capture path. Its pixels exist only
briefly in memory and are discarded; no image is returned or saved.

The document identity and paint marker are checked again before input. Paint
publication can follow capture completion, so the same-document marker is briefly
polled within a bounded budget without another capture. A capture
failure, changed document or missing paint aborts before any key is dispatched.
Ready documents skip the capture. Invalid key sequences are rejected before either
capture or input. CDP does not offer an atomic readiness-and-key operation, so a
later navigation can still race the dispatch; an uncertain input is never replayed.
The implementation is owned by [computer-input.ts](../extension/src/computer-input.ts).

## Trusted browser clicks

`computer` keeps synthetic background clicks as its default. For a control requiring
trusted pointer input, pass `pointerMode:"browser"` with `left_click`, `right_click`,
`double_click` or `triple_click`, plus exactly one main-frame `ref` or `[x,y]`
coordinate. Coordinates are viewport CSS pixels at every display scale. A supplied
`documentId` pins the action; the route also binds its own probes to the current
main-frame document. Child-frame clicks and pointer modifiers are rejected.
A `browser_batch` or recipe with such a step checks the extension's trusted pointer
support through `health` before its first step, as the direct call does; without it
the run fails with nothing dispatched and asks for an extension reload.

Browser pointer input requires a visible tab in a focused window. Default
`allowFocus:false` refuses an inactive/hidden target. Set `allowFocus:true` when
activation is acceptable and the user has enabled **Tillåt att agenter tar fram
Chrome** in the popup. That saved setting defaults to off, applies to every session,
and also gates `tab_switch bringToFront:true` and foreground screenshot fallback.
An agent flag cannot enable it; denied focus requests return `FOCUS_DISABLED`
before selecting a tab or activating a window. Background CDP screenshots do not
need this permission, including when `allowFocus:true` was supplied.
Ownership, document identity, focus and fresh target
geometry are checked immediately before dispatch. There is no synthetic fallback
or replay after an ambiguous error; a partial dispatch reports uncertain outcome.
Check the page before deciding on another action. Workflow expectations can observe
the result without repeating the click.

The route uses Chrome's [Input.dispatchMouseEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent)
CSS coordinates and [document-bound injection](https://developer.chrome.com/docs/extensions/reference/api/scripting).
[Browser pointer tests](../test/browser-pointer-live.mjs) verify trusted-event-only
controls, native defaults, focus/session/document boundaries and DPR alignment.

## Personal local modules

Optional personal cards appear alongside the bundled daily assistant. They are
served by the broker and do not require an already open agent chat. The ordinary
session/recipe/history controls remain independent. No personal module is shipped
with Tabai: its executable, domain logic, configuration and records belong outside
the repository and extension directory.

The broker reads an explicit `personal-modules.json` array in its local config
directory (`~/.claude-chrome-mcp` by default). Each registration contains an `id`,
absolute `command`, argument array `args`, and absolute `cwd`. Registration is a
trusted local installation operation, not something pages or the panel can change.
Keep this file private and back it up before editing. Restart the idle broker to
load registration changes. The installed program is trusted local code, not a
sandbox; Tabai does not download modules or accept executable paths from the UI.
This module directory, which also holds the daily assistant's `assistant/` data,
belongs to the broker, not to the client that spawned it: a directory baked into the
build (a build made with `CCMCP_MODULE_CONFIG_DIR` or `CCMCP_CONFIG_DIR` set bakes it in),
else `CCMCP_MODULE_CONFIG_DIR`, else `~/.claude-chrome-mcp`. The spawning client's
`CCMCP_CONFIG_DIR` is used only when it already holds an `assistant/` directory or the
module registry `personal-modules.json`, so an
installation that has relied on it keeps its data, while a disposable test store never
becomes the module store. The host passes `CCMCP_MODULE_CONFIG_DIR` to the module.
Preserve it when the module starts a Tabai browser client of its own, so a broker that
client respawns keeps the same registry.

The process receives newline-delimited JSON `{id, operation, input}` on stdin and
responds with `{id, ok:true, result}` or `{id, ok:false}` on stdout. Operations and
the bounded presentation schema are owned by
[shared/personal-modules.ts](../shared/personal-modules.ts). The result describes
plain-text fields, progress, questions, sources and history; it cannot inject HTML
or script. The panel supports start, answer, stop, resume and opening a result.
An optional `run.review` supplies sections of fields with confirmed/missing/conflict
status, short source quotes and pending/passed/failed verification details. The panel
renders plain text and expandable evidence; only HTTP(S) source links without embedded
credentials become links. Older modules can omit the card. The module, rather than
the shared panel, owns the evidence checks and meaning of a passed verification.
A module takes free text by adding `run.messaging`: `ready`, or `busy` while it
works. The `message` operation receives `run-id`, `message-id` and `message`; the
module must handle one `message-id` once. A `reply` from a linked chat also
carries `message-id`, for a module that records it in the dialogue. `run.conversation` is the bounded
dialogue, oldest first, with a UUID per entry so a linked chat mirrors it once. See
[chatting about a module run](assistant-panel-and-chat.md#chatting-about-a-module-run).
Optional `run.step`, `run.updatedAt` and `run.replyReceivedAt` show the current
step, last saved update and a durable answer receipt. Modules own these timestamps;
status polling must not fabricate activity. The panel refreshes on focus/reopening
and manual refresh, bounds requests to ten seconds, and discards a poll overtaken
by an action so stale state cannot overwrite the action's response.
The module owns validation, duplicate
protection, checkpoints, stop semantics and any browser/agent child processes.

Optional workspace controls use the same generic schema: advanced form fields,
question choices, individual review edits, overview fields and searchable paginated
history. The module owns the meaning of edits, archive/restore and continuation;
the shared renderer only presents bounded text and dispatches validated operations.
An idle active case in a workspace with history also has an archive button on its
card. A working case is archived only as the module allows it: `run.stopAndArchive`
puts **Avbryt och arkivera** behind an inline confirmation on the card and on its
history row, sending the ordinary `archive` with `case-id`; the module stops the
work and archives once its current step ends. `run.archiveBlocked` is the module's
reason the case cannot be archived now, shown instead of any archive button. A
working case with neither has no archive button. When the module clears its selected run, the panel removes the card and opens
the new-assignment form while preserving unsent text.
A module that starts from a mail adds `mailStart`: a button `label`, the start field
`mailField` that receives the mail's sender, account and title (never its content, since a
module may read the field as the owner's own request), an optional
`accountField` that receives the provider name (`Gmail`, `Outlook`, `Zoho`), an optional
`linkField` that receives the mail's own address, optional `clearFields` that are emptied,
optional `keywords`, and optional `providers` limiting which accounts' mail offer it. Every
named field must be a distinct start field. Mejl shows the button on an open mail; it opens
the module with those fields filled and saved as the module's start draft, and nothing starts
until the user presses the start button. A mail whose title or summary contains one of the
`keywords` gets the start as its one main button instead of a quiet one.
The module lists the runs started from a mail in `mailRuns` (`link`, `runId`, `label`,
`handled`, `handledAt`). The mail with that address then shows the run's label and
**Öppna ärendet** instead of the start. When a run is `handled` and the mail has not changed
since `handledAt`, Mejl marks the mail Klar once while Mejl is on screen and no other notice
shows, with Ångra; Ångra changes the mail, so it holds across reloads. Mejl first saves an
unsaved draft and judges the mail again after that save; Klar carries the revision it judged,
so a mail that changed in between, also through that saved draft, stays open. A module reports
`handled` only when nothing more is needed from the owner for that mail. `run.canStop: false` hides Stoppa while the run is otherwise working,
and `run.resumeLabel` names the resume button when resuming does something more specific.
Archived records remain
available through the history filter; selecting one shows its read-only details.
The required question or next action appears before review details. Older modules
can omit these additions; see [the controller](../extension/src/personal-modules.ts), [renderer](../extension/src/module-views.ts)
and [workspace integration checks](../test/workspace-panel-live.mjs).

Modules can opt into private autosave for unsent start/reply text. Context and
revision prevent a previous question or stale panel from overwriting a newer
draft. A save receipt means the module acknowledged persistence; failure leaves
the visible text available for retry. Persistence belongs to the installed module,
not Chrome storage or shared run history. Modules without this capability keep
input in page memory until the explicit action. Both routes use the existing
authenticated extension-to-broker route and the module's stdin.
Module output is not added to shared workflow history or broker logs. The module
must implement its own private persistence and close children when stdin closes
or SIGTERM arrives. Tabai kills a module that has not exited 3 seconds after SIGTERM.
On SIGTERM or SIGINT the broker stops routing at once but keeps its ports until every
module has exited (at most 10 seconds), so a replacement broker cannot start a second
copy of a module on the same data meanwhile. The broker waits 7 seconds for each
module answer. A module operation the daily assistant asks for (from the chat or an
approved start card) can take two of them, a status read and then the operation, so
the assistant waits 15.5 seconds before it reports the delay. A timed-out action is
never replayed; check status before trying again.
Private local storage does not imply that an installed agent runs offline.

Rebuild/reload the extension and restart the idle broker after changing this
support. No new Chrome permission or public listener is added. CI bakes an isolated
module directory so a test client's recipe-store override cannot load real modules.
The test fixture demonstrates the protocol against disposable local state without
embedding a user's business workflow.

## Reusable recipes

`recipe_save` stores a named sequence with optional `parameters` and `description`.
The parameter types are `string`, `number` and `boolean`. Parameters are required
unless they have a default or explicitly set `required:false`; an omitted optional
parameter still cannot be referenced by an action. Unknown names and wrong types
fail before any action. Bind an entire value with `{"$param":"query"}` to preserve
its type. Parameter names start with a letter and contain letters, digits,
underscores or hyphens. Interpolate strings with `{{query}}`. Supplied values are never interpreted
again. JavaScript source and predicates cannot contain parameter substitutions.
Only saved recipes bind parameters: `browser_batch` passes `{{name}}` text and
`{"$param":…}` objects on literally, as a direct call would. Give a string or number
parameter that carries a password or other secret the reserved `secret_` prefix:
**Recept** then asks for it in a masked field. The stored parameter schema has no other secret flag.

```json
{
  "name": "search-form",
  "parameters": { "query": { "type": "string" } },
  "actions": [
    {
      "tool": "form_input",
      "target": { "selector": "input[name=q]" },
      "args": { "value": { "$param": "query" } },
      "expect": { "fieldValue": { "selector": "input[name=q]", "value": { "$param": "query" } } }
    },
    {
      "tool": "computer",
      "target": { "role": "button", "name": "Search" },
      "args": { "action": "left_click" },
      "expect": { "selector": "#results", "timeoutMs": 10000 }
    }
  ]
}
```

Navigate to the form first, then call `recipe_run` with the saved `name`, the owned
`tabId` and `parameters:{query:"search text"}`. A default tab ID fills only steps
without one. [The GitHub fixture](../test/fixtures/github-pr-search-recipe.json)
contains a complete navigation/search example. Stored legacy action arrays remain
readable and runnable; new saves use versioned records.

## Resumable recipes

In 0.16, `recipe_run {name, tabId, parameters, resumable:true}` opts into durable
checkpoints. In **Recept**, select **Spara kontrollpunkter för säker återupptagning**.
The recipe must use one explicit owned tab, fresh targets instead of stored refs,
document IDs or coordinates (the refs in `fill_form` fields and its `submitRef` count
too), and at least one declarative `expect`. Predicate
expectations are excluded because executable code is not a safe resume probe.
Existing recipe runs keep their previous behavior unless opted in.

Stop after a complete step with a successful expectation. `recipe_checkpoints`
lists its `resumeId`, verified step count and resumability; a run that ended before its
first step was dispatched has nothing to resume and returns no `resumeId`. After a process restart,
supply the same recipe and parameters to `recipe_resume {resumeId,name,tabId,parameters}`,
or select the continuation in the panel's **Körning** field. The tab must currently
belong to the caller. A new process may use a new owned tab if the application has
preserved the verified state there. Continuation first verifies the URL fingerprint
and previous declarative expectation, bounded to 1.5 seconds, then dispatches only
the remaining actions. A `stableForMs` in that expectation is cut to half of this
check's timeout: the state was verified once already, and the check only confirms
that it still holds. Results report `skippedSteps`; ordinary run counts and history
refer to this continuation's remaining steps.

An atomic ownership claim prevents two processes from continuing the same run.
Each action's durable intent is written before dispatch. A timeout, failed expectation,
crash during dispatch, or a completed step without an expectation blocks continuation.
Inspect that outcome manually; the checkpoint never authorizes repeating an uncertain
click. A crashed owner can be reclaimed only when its local PID is proven dead and
the durable state is verified. Live, foreign-host or unverifiable owners fail closed.
An expectation proves only its declared condition; choose a meaningful outcome,
such as a receipt marker or field value, rather than a generic button's existence.

`recipe-checkpoints.json` stores names, hashes, verified counts and ownership metadata
in the existing private configuration directory. It stores no parameters, URL text,
selectors, page values or result payloads. Both metadata collections have a 4 MiB
file bound. A new run that ends before its first dispatch removes its own record.
Up to 100 checkpoints are retained; a new run evicts only a completed record or one
that never dispatched (phase `new`) and has no owner or a local owner whose process
is gone. If no slot qualifies, starts fail rather than discarding uncertain evidence.
Back up metadata before manual repair. Checkpoint writes fail closed before the next
action; a post-action storage failure leaves the dispatch uncertain, never replayable.
If the final write as a run ends fails, the run's result is still returned, with
`checkpointError`, and the record stays owned, so it cannot be resumed while that
process runs. A failed run returns its own error even when that write fails.

## Targets, expectations and results

Both `browser_batch` and recipe actions accept `target` and `expect`.

Refs returned by `read_page`, `find`, compact/diff reads and target resolution are
opaque document-local identities, not reusable sequence numbers. Keep the full
string, including a child-frame suffix. A moved original node retains its ref;
navigation, node replacement or a duplicated ref attribute makes an old ref fail
before input. Read the page again instead of guessing or editing ref numbers.
Injected and CDP actions authenticate the original node in the extension's
isolated identity map; an attribute match alone is insufficient.

- A target is either a CSS `selector` or exact `role` and `name`, optionally scoped
  to `frameId`. It must match exactly one visible element across the selected
  accessible frames. Open shadow roots are traversed. Role/name follows Tabai's
  simplified DOM naming, not a complete ARIA accessible-name algorithm.
- Dynamic targets support `form_input`, `select_option` and `computer` pointer
  actions: click variants, hover and scroll-to. They cannot be combined with an
  explicit ref or coordinates. `resolve_target` can also be called directly; its
  `ref` and `documentId` can be passed together to those tools. Document replacement
  invalidates the action before mutation, even if the new page reuses a ref number.
- An expectation specifies exactly one `selector`, `text`, `predicate`, exact
  `url`, or `fieldValue:{selector,value}`. Native checkbox/radio expectations use
  booleans; other native fields compare their string values. Field selectors must
  be unique. `frameId` applies to selector/text/field observations; URL and predicate
  checks use the main frame. `timeoutMs` has the existing 270-second maximum.

Selector waits/expectations accept `state`: `attached` (default, any match),
`visible` (any visible match), `hidden` (all matches hidden or absent), or
`detached` (no matches). Visibility means a nonempty bounding box without hidden
CSS display/visibility; it does not prove that the target is clickable or in the
viewport. `stableForMs` requires the condition to remain true across sampled
observations for that duration. False/error/loading observations and document
replacement reset it; sampling is not a guarantee of continuous truth.

Direct `form_input`, `fill_form`, `select_option` and input `computer` calls also
accept `expect`. Structural/type validation and extension-version checks happen
before input, then exactly one action is followed by an observational wait.
With `expect`, the result includes `actionState`, `actionResult` and
`outcome.status`. An unconfirmed outcome returns MCP `isError:true` and
`OUTCOME_UNVERIFIED`, even if the action completed. Inspect the page before
deciding on another action; Tabai never repeats it automatically. Workflow steps
may use either their step-level `expect` or input `args.expect`, never both.
Direct `computer` screenshot/wait calls do not accept input expectations.

For example, an input click can declare
`expect:{selector:"#dialog",state:"detached",timeoutMs:5000}`. Field readback or a
`fieldValue` expectation proves the DOM value only. An application's acceptance,
save or calculation needs its own explicit confirmation condition. For reports,
wait for a new calculation/update marker tied to the requested inputs before
reading output; unchanged result numbers do not prove that no recalculation ran.

Wait timeouts append bounded `waitDiagnostics` JSON: start time, requested/actual
duration, completed-poll count, last observation and the last eight polls with
relative start/finish times, document/frame changes and an unfinished probe when
applicable. Observations contain booleans/counts/status, never expected/observed
field values, page text or predicate source. The existing bounded last-predicate
error remains in the message. Timeout bundles in `timeout_incidents` still store
operation/build metadata, not this page-observation history. A later successful
JavaScript check cannot prove what was true before the wait's deadline.

All steps are checked against their direct tool schemas before execution. New
workflow features check the extension version before the first action. A dynamic
target is resolved immediately before its action; expectations use one bounded
observational wait afterwards. An unsuccessful expectation never repeats the
action. Cancellation stops further work but cannot undo an already dispatched action.

The first text block remains the legacy array of `{tool,ok,result|error}` entries.
`structuredContent` adds `runId`, `ok`, `status`, timing, counts, 1-based `failedStep`
and step details. `actionState` distinguishes not-started, dispatched (possibly
executed) and completed actions. A failed or cancelled run sets MCP `isError:true`.
Page JavaScript returning a data object with `ok:false` is still ordinary data.
Batch image data is omitted; numbered-image mappings remain in the summary.

## History and storage

`run_history` lists recent runs, or reads one `runId`; `includeScreenshot:true`
returns an image block when available. A batch or recipe run must explicitly set
`captureOnError:true` to save a failure PNG. Cancelled runs do not take screenshots.
Screenshots contain visible page data and are not automatically redacted.

History under `~/.claude-chrome-mcp/runs/` retains 100 runs and their associated
images. It stores tool names, step times, status and error classifications, not
arguments, result bodies or raw browser error strings. Detailed errors remain in
the current tool response. History is shared by trusted local processes across
server restarts, just like recipes; it is not a separate tenant boundary.
Files are private (0600; directory 0700 on POSIX, inherited profile ACL on Windows).
A history or screenshot failure is reported separately and never changes the
action's outcome or causes a replay. Failed parameter/store loading before a run
is created returns a tool error and has no history entry.

`recipes.json` writes now lock the complete read/validate/modify/backup/replace
transaction across processes. Only a missing file means an empty store. Malformed
JSON, invalid entries and read failures preserve the original and stop the operation.
The previous valid bytes are saved to `recipes.json.bak` before atomic replacement.
The store has an 8 MiB bound. `CCMCP_CONFIG_DIR` relocates recipes, history and saved
artifacts; it does not relocate tokens or broker logs.

A lock waits up to three seconds. A confirmed dead local PID can be recovered;
living, foreign or unverifiable owners fail closed. If recovery was interrupted,
inspect the reported `.lock` and `.lock.recovery` paths and running processes before
manually removing stale locks. Preserve a copy before repairing a corrupt store;
do not replace it with an empty object. [Recipe store](../src/recipe-store.ts), [private storage primitives](../src/private-storage.ts)
and [history implementation](../src/run-history.ts) own the precise limits.

## Reading pages and numbered screenshots

| Tool | Behavior |
|---|---|
| `read_page {compact:true}` | Prioritizes visible interactive/main content, removes repeated structural text and retains actionable refs. Optional frame restriction. Secret-like field values are masked; ordinary page text is not a general redaction surface. Default reads remain unchanged. |
| `read_page_diff` | First call establishes a baseline; subsequent calls return added, removed and changed nodes. `reset:true` starts over. Baselines are scoped to session/tab/frame selection and document IDs; navigation reports a reset. Bounded worker memory, evicted on tab/session cleanup or restart. Truncation is explicit; absence from a truncated snapshot never proves removal. |
| `extract_table` | Native/ARIA tables, grids and treegrids become `columns` and `rows`. A selector must uniquely identify a visible table; optional frame restriction. Row/column spans repeat cell text. One leading header row supplies column labels; without one, labels are `Column N`. Bounds and truncation are explicit. |
| `screenshot_marked` | PNG with numbered interactive main-frame targets, plus number→ref/role/name and CSS rectangles. Returns image and text blocks plus structured metadata. Click using the mapped ref; keep its `documentId` for document-bound actions. |

Marked screenshots use CDP and canvas without adding page overlays or activating
tabs. They check document, viewport and target layout around capture; changes cause
an error instead of returning mismatched labels. Pinch zoom is rejected. Child-frame
controls are explicitly excluded from visual labels; use `resolve_target` or reads
with frame-qualified refs for those controls. Refs may add the same bookkeeping
attributes used by normal page reads. A screenshot remains a point-in-time observation;
the page can change after it is returned.

Verification lives in [workflow tests](../test/workflow-live.mjs),
[perception tests](../test/perception-live.mjs), and the focused Node suites wired
into [package.json](../package.json). `npm run test:ci` exercises all live suites in
an isolated Chromium and restores the ordinary build afterwards.
