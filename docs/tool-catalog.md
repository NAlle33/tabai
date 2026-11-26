# Tool Catalog

The numbered sections preserve the CinC reference catalog: 22 tools grouped by category, schemas extracted from Claude-in-Chrome's MCP server (`mcp__claude-in-chrome__*`, 2026-05-28). Those historical schemas are a parity reference; the local contract notes below describe the differences relevant to calling this implementation.

> **What is actually implemented is owned by the code:** `shared/tool-names.ts` (extension-dispatched tools) + the `registerTool` calls in `src/tool-catalog.ts` (the whole surface, incl. the server-orchestrated `browser_batch`, `upload_image`, `recipe_save`/`recipe_list`/`recipe_run`, `run_history`). The Zod schema + `description` per tool in `src/tool-catalog.ts` is the current argument reference; a categorized overview is in `README.md` → "Tools". Deviations from the catalog below: **Multi-browser** (section 2) and **Shortcuts** (section 8) are NOT implemented (N/A for a local single-machine implementation; shortcuts are covered by the recipe tools), and the local additions beyond the CinC surface (reliability, DX and CDP tools) are absent here. Tool errors carry a machine-readable `CODE:` prefix (`ToolErrorCode`/`isRetryable` in `shared/protocol.ts`).

## Local contract notes

Use the registered schemas and descriptions in [src/tool-catalog.ts](../src/tool-catalog.ts) for exact
arguments and bounds. The older numbered reference sections do not override these local contracts.

The popup's **Tillåt att agenter tar fram Chrome** setting is off by default and
persists across reloads for all sessions. Foreground requests through `bringToFront`
or `allowFocus` require that user opt-in; an agent flag alone cannot override it.
Denied requests return `FOCUS_DISABLED` before any tab selection or window activation.
Background tab selection, synthetic input and CDP capture remain available.

Reference actionability for ordinary left/right/double clicks, `form_input`,
`select_option` and trusted browser pointer uses one five-second service-worker
deadline. Synchronous read-only page samples must show matching visible, enabled
geometry twice. The wait pins its frame/document and stops on replacement or
invalid identity; late probe results cannot authorize input or restart polling.
Background tabs support ordinary DOM input. Trusted pointer still requires visible,
focused Chrome. The implementation is [waitForActionableRef](../extension/src/page-wait.ts).

| Tool | Local usage and limits |
|---|---|
| `tabs_context_mcp` | `createIfEmpty:true` creates a new owned group. By default it uses a new background window; optional `createWindowId` creates a new owned tab in that existing normal window instead. Existing user tabs are never adopted, and an existing session group is never moved. A closed target window fails without fallback. The daily assistant passes its initiating panel's window. Optional `incognito:true` creates the group in a separate background incognito window instead; it requires the user's “Allow in Incognito” setting for Tabai (otherwise `INCOGNITO_UNAVAILABLE`) and cannot be combined with `createWindowId`. Before answering, it records tabs that joined the group without a tool call (a page's `target=_blank` or `window.open`) in the group's ownership proof; when that recording fails it still answers. |
| `tabs_close_mcp` | Records the group's current tabs before closing, so closing the recorded tabs cannot cost the session tabs the page opened itself. When that recording fails it closes nothing and returns `GROUP_IDENTITY_UNAVAILABLE`; call `tabs_context_mcp`, then try again. See [tab-tools.ts](../extension/src/tab-tools.ts). |
| `tab_switch` | Selects the owned tab without bringing its window forward by default. Pass `bringToFront:true` only when showing Chrome is needed. Ordinary tools target `tabId` directly and need no preceding switch. |
| `computer screenshot` | Tries CDP twice without taking focus. Its visible-tab fallback uses only an already focused, selected tab by default; otherwise it returns an actionable error. An essential capture may retry with `allowFocus:true`, allowing the fallback to activate the target and restore/focus its window. That option still tries background capture first. |
| `navigate` | Back/forward means one adjacent history entry. Chrome's toolbar may skip entries created without user activation, so this path uses the debugger tier; keep DevTools closed on the target tab. The URL allowlist applies to history targets too. See [toolNavigate](../extension/src/browser-tools.ts) and the [live regressions](../test/navigation-live.mjs). |
| `computer` | Default pointer events are synthetic and work in background tabs. `pointerMode:"browser"` opts into trusted main-frame left/right/double/triple clicks by one ref or coordinate, without fallback/replay. The tab and document must be visible/focused; `allowFocus:true` permits activation. Child-frame browser clicks and browser pointer modifiers are unsupported. Both modes and screenshots use CSS pixels. A ref target is scrolled into view first; a coordinate is used where it is and its target is focused without scrolling, so several coordinates read off one screenshot stay valid. Coordinates reach into open shadow roots. A synthetic pointer action at a point over a frame is refused with an error naming the control's frame ref (`ref_N@frameId`) and `pointerMode:"browser"`. `key` accepts space-separated keys/chords and `modifiers`; main-frame keyboard input prefers CDP. `type` and `key` with a `ref` focus that element first, and a stale ref fails before any input; a disabled or read-only field and a frame element are refused before anything is dispatched. Without a ref, `type` needs a focused editable in the main frame; focus inside a frame is an error, and typing into a frame goes through the field's own frame ref as synthetic input. `scroll` acts on the nearest container under the ref or point (default: the viewport centre) that can still move on that axis; one that is already at its end hands the scroll on to the next container and at last to the page, as a wheel does. With a ref the scroll stays in that ref's own container: at its end the answer is `moved:false`, and the page behind a list or a dialog does not move. It is never an error: `moved:false` with a `reason` reports an end or nothing scrollable. |
| `health` / `timeout_incidents` | Health reports loaded server/broker/extension build IDs, mismatch/unknown-peer guidance and session-scoped operation metadata. Group inspection is bounded and coalesced; unavailable inspection is not proof of an empty group. Coded timeouts automatically persist up to 50 private metadata bundles, retrievable across restarts without arguments, URLs, page values or raw errors. See [diagnostics](workflows-and-perception.md#build-and-operation-diagnostics). |
| `recipe_checkpoints` / `recipe_resume` | Opt in via `recipe_run {resumable:true}`. List durable continuation IDs and verify the same inputs, owned tab, URL fingerprint and declared checkpoint before running remaining steps. Unknown effects, changed inputs and active owners block resume. See [resumable recipes](workflows-and-perception.md#resumable-recipes). |
| `recipe_record` | Explicit agent-step capture and panel review use the existing recipe store and runner. Secret field values become required parameters named with the reserved `secret_` prefix, which the review keeps and **Recept** masks; name a secret parameter in `recipe_save` the same way. See [recording a recipe](workflows-and-perception.md#recording-a-recipe) for the review route, privacy boundary and rationale. |
| `read_page` / `find` | Refs are opaque document-bound identities; keep the complete string and frame suffix. Stale/replaced nodes and duplicate ref attributes fail before input; moving the original node preserves its identity. Refs resolve within their owning frame and pierce open shadow roots. Secret fields are inputs and textareas of type password/hidden, with any password, one-time-code or card (`cc-*`) autocomplete token, or with pass/otp/cvv/cvc in their name or id. Their values are masked with a length marker, and a textarea's text never becomes an element's name. This is targeted value masking, not general page redaction. A walk stops at 512 levels or 20,000 elements and says so (`…(walk aborted)`). Names are capped at 500 characters; `find`'s merged listing is capped at 12,000 characters, cut at a line end with `…(truncated)`; `read_page`'s own character limit also cuts at a line end, so a ref is never cut in half. |
| `get_page_text` | Uses an `<article>` only when exactly one exists; otherwise falls back to `main`, then the body. Text cut at 100,000 characters includes a truncation marker. |
| `form_input` / `fill_form` | Read back field state after changes. Rejected/sanitized values, disabled fields and read-only inputs report errors; secret values are masked in those errors. A control inside `<fieldset disabled>` counts as disabled, except in that fieldset's first `<legend>`. Checkbox/radio strings such as `"false"` and `"0"` are parsed as booleans. `fill_form` returns per-field outcomes and throws on total failure; `submitted:true` records a click, not server acceptance. Optional `expect` observes a declared postcondition after the one action; unverified outcomes return `OUTCOME_UNVERIFIED` with MCP isError and never replay input. |
| `select_option` | Native and custom lists match the same way: an exact option value (a custom option's `data-value`), else an exact visible text, else a text substring only when exactly one option contains it. Several matches are an error that lists them. Native selects return `verified:true` after readback. Custom controls are best effort: `verified` is true only when the chosen option itself reports `aria-selected` or `aria-checked`; `verified:false` means the option event sequence was dispatched without that confirmation. Confirm the page state, or use `wait_for` and an explicit option click when rendering is asynchronous. |
| `file_upload` | Absolute local paths. A file input inside a cross-site frame runs in its own process, out of the debugger's reach, and fails with an error that says so; open that frame's page in its own tab. A server started with `CCMCP_UPLOAD_DENY_ROOT` gives a page, through `file_upload` and `file_drop`, only absolute paths to existing regular files whose real path lies outside that directory, also in batch and recipe steps. Directories are refused too, because a directory input would receive everything beneath it. Anything else fails with `FILE_REFUSED` before the page receives anything. The daily assistant's own server sets it to the per-user data directory. See [guardLocalFiles](../src/tool-orchestration.ts). |
| `read_console_messages` | The buffer keeps the latest 500 entries. Each entry is formatted in the page without running page code: own data properties only (no getters, `toJSON` or `toString`), two levels deep, 20 keys or items per level and 4,000 characters per entry. Typed arrays and DataViews show as `[Binary]`, an Error's own message is included, and an unhandled rejection's reason is formatted the same way. See [content.ts](../extension/src/content.ts). |
| `wait_for` / `download collect` | Maximum `timeoutMs` is 270,000 ms, with a 300,000 ms transport ceiling to leave delivery margin below the worker request limit ([shared/protocol.ts](../shared/protocol.ts)). `wait_for` selectors support attached/visible/hidden/detached `state`, and `stableForMs` adds sampled stability. Timeout messages include bounded poll/timing/document diagnostics without field values or predicate source. For waits across document changes and network-idle timing, see [waitInTab](../extension/src/page-wait.ts). On HTTP(S), `networkIdle` requires the content-script counter; an absent counter reports a capture-not-active error. Non-HTTP documents return a no-capture note. |
| `wait_for` predicates | Judged synchronously, so a returned promise counts as truthy — compare a resolved value instead. Predicates run through the debugger tier ([page-evaluation.ts](../extension/src/page-evaluation.ts)), which is why a page whose Content-Security-Policy omits `unsafe-eval` can still be waited on; keep DevTools closed on that tab. A predicate that cannot parse, or that the page refuses to evaluate, fails immediately; a missing global or element keeps polling and its last error is reported with the timeout. Selector, text and network-idle conditions keep their plain injection and are unchanged. |
| `browser_batch` / `recipe_run` | At most 50 extension-tool steps, each validated with its direct-call schema. Results are `{tool, ok, result\|error}` and stop on the first error, including a refused download arm, or after cancellation (including during the final dispatched step). The legacy text array is preserved; structuredContent adds aggregate status/timing/run ID/1-based failed step and failed runs set MCP isError. An `ok:false` value returned by page JavaScript remains ordinary page data. Screenshot results contain metadata (`kind`, `mimeType`, `bytes`, optional `source`, `note`), never base64 text; call a screenshot tool directly for an image block. PDF/GIF exports save files and return paths. A recipe's default `tabId` also applies to steps saved without `args`. `browser_batch` binds no parameters: `{{name}}` and `{$param}` pass literally; only saved recipes bind them. A `computer` step with `pointerMode:"browser"` needs the extension's trusted pointer support, checked before the first step. When a resumable run's final checkpoint write fails, the result still returns, with `checkpointError`. |
| `download` | Arm immediately before triggering, then collect. Attribution is browser-wide because download events have no tab ID: an unrelated browser download can consume the arm, so keep the window short. One session holds the arm at a time. An arm still waiting for its download expires unless collect keeps it alive; once the download starts, the capture's lifetime runs from that start and collect calls do not extend it. `state:"in_progress"` means the download started but has not finished: collect again and do not trigger it again. Arming while the session's download is in progress, or after it finished and before `collect`, changes nothing and answers `armed:false` with a note that names the waiting file: `collect` is the next call. In `browser_batch` and in a recipe such an arm fails its step, so the trigger after it does not run. A finished result left uncollected for 330 s is dropped by the next arm. A capture that expires while the download may still be running returns `timeout` with a note to check whether it finished before triggering it again. Capture state survives service-worker idle/restart within the browser session; pending replies do not, so **collect again after a service-worker restart**. Persistence failures do not report a successful arm. |
| `gif_creator` / `dialog` | GIF recordings and dialog arms live in service-worker memory and are lost when it restarts. Export recordings promptly; an absent dialog arm keeps the default-dismiss behavior. Download-state persistence does not make these features durable. |

Parameterized recipes, dynamic document-bound targets, typed expectations, safe storage, local history, compact/diff reads, table extraction and numbered screenshots are documented in [workflows and page perception](workflows-and-perception.md).

Behavior owners: [injected-page-scripts.ts](../extension/src/injected-page-scripts.ts),
[browser-tools.ts](../extension/src/browser-tools.ts),
[tool-orchestration.ts](../src/tool-orchestration.ts),
[download-state.ts](../extension/src/download-state.ts),
[gif-recorder.ts](../extension/src/gif-recorder.ts), and [cdp-tools.ts](../extension/src/cdp-tools.ts).

## 1. Tab management (foundational)

Entry point for all browser automation. Every other tool requires a valid `tabId` from this group.

### `tabs_context_mcp`
**Args:** `createIfEmpty?: boolean`
**Returns:** the list of tabIds in the MCP tab group.
**Behavior:** if the group does not exist and `createIfEmpty=true` → creates a new window + a new group + one empty tab.
**MUST be called first** in every session, before any other tool.

### `tabs_create_mcp`
**Args:** (none)
**Returns:** a new tab in the MCP group.
**Note:** every conversation should create its own tab — avoid reuse.

### `tabs_close_mcp`
**Args:** `tabId: integer`
**Behavior:** closes the tab. If it was the last tab in the group → Chrome auto-removes the group.

## 2. Multi-browser

For users with several paired Chrome installations.

### `list_connected_browsers`
**Args:** (none)
**Returns:** array of `{deviceId, name, os, isThisComputer}`.
**UX requirement:** MUST be presented to the user via ask-question — never pick automatically.

### `select_browser`
**Args:** `deviceId: string`
**Behavior:** selects the browser with a known deviceId without a broadcast.

### `switch_browser`
**Args:** (none)
**Behavior:** broadcasts a handshake to all paired browsers. Waits 2 min for the user to click "Connect" in one extension window.

## 3. Navigation

### `navigate`
**Args:** `url: string` (or `"back"` / `"forward"`), `tabId: number`
**Behavior:** allowlist — only `http`/`https` (scheme-less → `https://`) and `about:blank`; other schemes are refused. `"back"`/`"forward"` for history. Waits for load complete + (by default) network idle.

### `resize_window`
**Args:** `width: number`, `height: number`, `tabId: number`
**Behavior:** resizes the window containing tabId. Use for responsive testing.

## 4. Page reading

### `read_page`
**Args:** `tabId: number`, `depth?: number` (default 15), `filter?: "interactive" | "all"`, `ref_id?: string`, `max_chars?: number` (default 50000)
**Returns:** accessibility tree with element refs (`ref_1`, `ref_2`, ...).
**Use when:** you need to interact with elements (refs are used by form_input, computer.scroll_to, etc.).
**Gotcha:** the default returns ALL elements incl. non-visible ones. Large pages → can exceed 50000 chars → use `ref_id` for a subtree or `depth` to truncate.

### `get_page_text`
**Args:** `tabId: number`
**Returns:** article-prioritized plain text.
**Use when:** you want to read article/blog/text content without interacting.

### `find`
**Args:** `query: string`, `tabId: number`
**Returns:** up to 20 matching elements with refs.
**Use when:** you know what you are looking for ("login button", "search bar"). More targeted than `read_page`.
**Gotcha:** > 20 matches → error; make the query more specific.

## 5. Page interaction

### `computer`
**Args:** `action: enum`, `tabId: number`, + per-action specifics
**Actions:**
- `left_click`, `right_click`, `double_click`, `triple_click` — require `coordinate: [x,y]` OR `ref`
- `type` — requires `text: string`
- `key` — requires `text` (space-separated keys, e.g. "Backspace Backspace")
- `screenshot` — optional `save_to_disk: boolean`
- `zoom` — requires `region: [x0,y0,x1,y1]`
- `wait` — requires `duration: number` (max 10s)
- `scroll` — requires `scroll_direction`, optional `scroll_amount`
- `scroll_to` — requires `ref`
- `left_click_drag` — requires `start_coordinate` + `coordinate`
- `hover` — coordinate or ref
**Modifiers:** `"ctrl"`, `"shift"`, `"alt"`, `"cmd"`/`"meta"`, `"win"` — combinable with `+`
**Backend:** uses the Chrome `debugger` API (CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`) to simulate real input.

### `form_input`
**Args:** `ref: string`, `value: string | boolean | number`, `tabId: number`
**Behavior:** sets the value of a form element. Checkbox → boolean. Select → option value or text.
**Use instead of:** `computer.type` when you know the element ref.

### `javascript_tool`
**Args:** `action: "javascript_exec"`, `text: string`, `tabId: number`
**Behavior:** evaluates JS in the page context. Returns the last expression.
**Gotcha:** do NOT use `return` — just write the expression directly.
**Local contract:** main frame, MAIN world by default; optional `world: "isolated"` evaluates in a dedicated isolated world of the main frame (CDP `Page.createIsolatedWorld`, reused within a document), where the page cannot override the DOM functions the script uses, though it still controls its own content, and fails without fallback if that world cannot be created. `undefined` comes back as `null`; the result must be
JSON-serializable, and a returned promise is awaited for up to 25 s
([evalInPage](../extension/src/injected-page-scripts.ts)). Evaluation goes through the debugger
tier ([page-evaluation.ts](../extension/src/page-evaluation.ts)), so it works on a page whose
Content-Security-Policy omits `unsafe-eval`; the page's own `eval` stays blocked and its policy is
never edited. Close DevTools on that tab — only one debugger can attach, and a denial is reported
rather than worked around. If the document is replaced while the script is evaluating, or the
debugger fails ambiguously, the call fails and the script is **not** run again. A worker timeout
ends the call; it does not cancel asynchronous work the script already started.

### `file_upload`
**Args:** `paths: string[]`, `ref: string`, `tabId: number`
**Behavior:** uploads files from local disk to an `<input type="file">` element.
**Use instead of:** clicking an upload button (opens a native picker that cannot be controlled).

### `upload_image`
**Args:** `imageId: string`, `tabId: number`, + either `ref: string` OR `coordinate: [x,y]`
**Behavior:** uploads a previously captured screenshot (via `computer.screenshot`) or a user-uploaded image.
**Path 1 (ref):** for `<input type="file">`, incl. hidden ones.
**Path 2 (coordinate):** for drag/drop targets (Google Docs etc.).

## 6. Browser state inspection

### `read_console_messages`
**Args:** `tabId: number`, `pattern?: string` (regex), `onlyErrors?: boolean`, `clear?: boolean`, `limit?: number` (default 100)
**Returns:** console messages from the current domain.
**Implementation:** a MAIN-world content script wraps `console.*` → buffers into `window.__ccmcpConsole`; read via `executeScript` (no debugger, no banner).
**Gotcha:** ALWAYS send `pattern` — without a filter it can return thousands of messages.

### `read_network_requests`
**Args:** `tabId: number`, `urlPattern?: string`, `clear?: boolean`, `limit?: number` (default 100)
**Returns:** HTTP requests (fetch + XMLHttpRequest only; not document/image/CSS subresources).
**Implementation:** a MAIN-world content script wraps `fetch` + `XMLHttpRequest` → buffers into `window.__ccmcpNetwork`; read via `executeScript` (no debugger).
**Gotcha:** the buffer lives on the page global → reset on page load/navigation.

## 7. Recording

### `gif_creator`
**Args:** `action: "start_recording" | "stop_recording" | "export" | "clear"`, `tabId: number`, + per-action options
**Workflow:**
1. `start_recording` → take a screenshot right away (first frame)
2. ... perform browser actions ...
3. Take a screenshot right away → `stop_recording`
4. `export` with `download: true` OR a `coordinate` for drag/drop
**Export options:** `filename`, `quality` (1-30), show/hide click indicators, drag paths, action labels, progress bar, watermark.
**Implementation (CinC):** captures canvas frames in the offscreen document and assembles the GIF with `gif.js` or similar. (Locally: CDP frames encoded in the service worker with gifenc, saved to disk by the server.)

## 8. Shortcuts / workflows

### `shortcuts_list`
**Args:** `tabId: number`
**Returns:** available shortcuts/workflows (slash commands in the extension).

### `shortcuts_execute`
**Args:** `tabId: number`, `command?: string` OR `shortcutId?: string`
**Behavior:** starts the shortcut in a new side-panel window. Returns immediately (do NOT wait for completion).

## 9. Batch orchestration

### `browser_batch`
**Args:** `actions: Array<{name, input}>`
**Behavior:** runs several tool calls sequentially in one round trip. Stops at the first error.
**Constraints:**
- The per-action permission check runs separately
- Screenshots are returned inline between outputs
- Coordinates you write refer to the screenshot taken BEFORE the batch call
- **Cannot nest** — `browser_batch` inside `browser_batch` is forbidden
**Use for:** predictable multi-step flows (navigate → click field → type → screenshot).

## Tool-group summary

| Group | Count | Required permissions |
|---|---|---|
| Tab management | 3 | `tabs`, `tabGroups` |
| Multi-browser | 3 | `storage` + cloud relay |
| Navigation | 2 | `tabs` |
| Page reading | 3 | `scripting` |
| Page interaction | 5 | `scripting`, `debugger` |
| Browser state | 2 | `scripting` (MAIN-world buffers) |
| Recording | 1 | `scripting`, offscreen doc |
| Shortcuts | 2 | `scripting` |
| Batch | 1 | (inherited from the sub-actions) |
| **Total** | **22** | |
