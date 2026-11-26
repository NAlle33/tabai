# Architecture Map

Three components that together expose a Chrome browser as an MCP server. This document is the
navigation layer: the hop diagram, the per-file map, the original design decisions and the
verified gotchas behind them. The rules an agent must follow (build/reload loop, non-derivable
constraints, security invariants) live in the repo root's `CLAUDE.md`.

> **Note (2026-06-12): multi-session broker.** Since plan `260612-1614-multi-session-broker-isolated-tabs`
> a **singleton broker daemon** (`src/broker.ts`) sits between the MCP servers and the extension, so SEVERAL
> Claude Code sessions can share the ONE extension concurrently — each in its OWN isolated tab group.
> The broker owns the extension port (`:9223`, via `Bridge`) plus a client port (`:9225`); every `server.ts`
> is a thin `BridgeClient` that auto-spawns the broker. Tab-group ownership is **per session**
> (`sessionId → groupId`, fail-closed; no shared "default" group). Diagnosis/cleanup: `npm run doctor` /
> `npm run kill-broker`.

## High-level

```
┌──────────────┐  stdio   ┌──────────────┐  ws :9225  ┌─────────────┐  ws :9223  ┌──────────────────┐  Chrome APIs  ┌──────────┐
│ Claude Code  │ ───────▶ │  MCP server  │ ─────────▶ │   broker    │ ─────────▶ │ Chrome extension │ ────────────▶ │ Web page │
│ (MCP client) │ ◀─────── │ (one per     │ ◀───────── │ (singleton, │ ◀───────── │ (offscreen doc + │ ◀──────────── │  (DOM)   │
│              │ JSON-RPC │  session)    │            │  detached)  │            │  service worker) │  debugger /   │          │
└──────────────┘          └──────────────┘            └─────────────┘            └──────────────────┘  scripting    └──────────┘
```

## File map

This table points to the owning modules and their boundaries.

| File | Role |
|---|---|
| `shared/protocol.ts` | Wire types, host/ports, `ClientHello`/`ClientCall`/`ControlMessage`/`SESSION_CLOSED`/`SESSION_OPEN`, the shared call-timeout clamp, `ToolErrorCode` + `isRetryable`. Bundled into **both** builds. |
| `shared/tool-names.ts` | Canonical list of extension-dispatched tools; `src/tool-orchestration.ts` gates batch/recipe steps on it and `test/tool-names-consistency.mjs` asserts it matches `background.ts`. |
| `shared/url-guard.ts` | Pure `navigate` URL allowlist; bundled into the extension and emitted standalone for Node tests. |
| [src/server.ts](../src/server.ts) | MCP bootstrap, shared resource instances, stdio lifecycle and temporary-upload cleanup. |
| [src/tool-catalog.ts](../src/tool-catalog.ts) | Ordered MCP registrations and the single schema-registering wrapper. |
| [src/server-workflows.ts](../src/server-workflows.ts) | Workflow, recipe-start and panel composition using the bootstrap's resources and catalog schema map. |
| [src/tool-timeouts.ts](../src/tool-timeouts.ts) / [artifact-store.ts](../src/artifact-store.ts) | Direct/workflow timeout policy and PDF/GIF persistence: on POSIX each saved file is 0600, and a directory it creates is 0700; an existing directory keeps its mode. |
| [src/tool-orchestration.ts](../src/tool-orchestration.ts) | Shared batch/recipe schema validation, whole-run schema preflight, document-bound dynamic targets, outcome checks, cancellation, timing and binary result envelopes. |
| [src/workflow-control.ts](../src/workflow-control.ts) | In-memory observation and stop-after-step control around the existing workflow runner/history envelope. |
| [src/loop-guard.ts](../src/loop-guard.ts) | Bounded per-process/tab fingerprints and pre-dispatch stagnation pauses shared by direct and workflow calls; explicit panel release never replays. |
| [shared/control-panel.ts](../shared/control-panel.ts) / [src/panel-router.ts](../src/panel-router.ts) | Validated, bounded reverse requests; optional hello capability and socket-bound session routing. |
| [extension/sidepanel.html](../extension/sidepanel.html) / [sidepanel.ts](../extension/src/sidepanel.ts) | Native Chrome companion panel: sessions, progress, stop, parameterized recipes and local history. |
| [extension/src/panel-client.ts](../extension/src/panel-client.ts), [panel-views.ts](../extension/src/panel-views.ts), [recipe-form.ts](../extension/src/recipe-form.ts) | Runtime request adapter, panel presentation and recipe parameter fields; session/polling state stays in `sidepanel.ts`. |
| [extension/src/panel-debugging.ts](../extension/src/panel-debugging.ts) / [shared/panel-image.ts](../shared/panel-image.ts) | On-demand session-bound PNG/incident viewer and shared image chunk limits; no image polling or new capture policy. |
| [extension/src/personal-modules.ts](../extension/src/personal-modules.ts) / [module-views.ts](../extension/src/module-views.ts) | Module controller and DOM-preserving presentation; drafts, polling and actions remain controller-owned. |
| [src/personal-modules.ts](../src/personal-modules.ts) / [shared/personal-modules.ts](../shared/personal-modules.ts) | Opt-in local process registry, bounded stdio requests and plain-data presentation contract; private module implementations stay outside this repository. |
| [shared/workflow-schema.ts](../shared/workflow-schema.ts) | Versioned recipe validation, typed scalar parameter binding and target/expectation contracts. |
| [src/recipe-store.ts](../src/recipe-store.ts) / [private-storage.ts](../src/private-storage.ts) | Recipe validation and transactions over shared private file/lock primitives. |
| [shared/run-record.ts](../shared/run-record.ts) | Run/step/status data types shared by persistence and panel code. |
| [src/run-history.ts](../src/run-history.ts) / [workflow-report.ts](../src/workflow-report.ts) | Bounded private run metadata/optional PNG store; aggregate MCP envelope and independent diagnostic failures. |
| [src/metadata-store.ts](../src/metadata-store.ts), [timeout-incidents.ts](../src/timeout-incidents.ts) | Locked private metadata collections and bounded automatic timeout evidence; no page payloads. |
| [src/recipe-checkpoints.ts](../src/recipe-checkpoints.ts), [recipe-execution.ts](../src/recipe-execution.ts) | Durable dispatch intent, atomic continuation claims, URL/input hashes and read-only checkpoint revalidation over the existing workflow runner. |
| [extension/src/page-perception.ts](../extension/src/page-perception.ts) / [perception-scripts.ts](../extension/src/perception-scripts.ts) | Target/table/compact-read handlers and self-contained perception injection. |
| [extension/src/perception-frames.ts](../extension/src/perception-frames.ts), [perception-snapshots.ts](../extension/src/perception-snapshots.ts), [marked-screenshot.ts](../extension/src/marked-screenshot.ts) | Frame/document verification, the single snapshot/diff cache and canvas-marked capture. |
| [src/config-dir.ts](../src/config-dir.ts) | Server store paths for recipes, PDFs and GIFs; `CCMCP_CONFIG_DIR` override. |
| `src/bridge-client.ts` | The server's transport: ws CLIENT to the broker's client port with the same `.call()` surface as `Bridge`; writes calls only after the broker acknowledges the hello; reconnects and auto-spawns the broker (absolute path, detached, in its bundle directory, so relative `CCMCP_*` paths in its environment resolve from there). |
| [src/broker.ts](../src/broker.ts) / [broker-client-session.ts](../src/broker-client-session.ts) | Singleton bootstrap binds the client port first and chooses its own module directory; client closures own hello, acknowledgement, `session-open`, call deadlines, routing, inflight limits and authoritative session stamping. |
| [src/server-panel-channel.ts](../src/server-panel-channel.ts) | Reverse-panel handler adapter; replies belong to the request's origin socket. |
| `src/bridge.ts` | ws server on `:9223` for the single extension: UUID per call, 30s timeout, newest-connection-wins; `sendControl` for out-of-band frames. |
| `src/pending-calls.ts` | The at-most-once send/queue/`sent`-flag/timeout state machine shared by `Bridge` + `BridgeClient` so the two hops cannot drift. |
| `src/session-reaper.ts` | Pure refcount + grace-timer logic for reaping ended sessions (unit-tested, no Chrome/ws). |
| [src/assistant-pulse.ts](../src/assistant-pulse.ts) | The broker's scheduler pulse to the daily assistant: every 30 s with or without the extension, and at once when an extension connection closes (`Bridge.extensionLost`); unit-tested, no Chrome/ws. |
| `src/auth.ts` | Optional client-port token (`BRIDGE_TOKEN` or the file written by `set-token`) and extension-id pin resolution. |
| [src/handshake-gate.ts](../src/handshake-gate.ts) | HTTP upgrade Origin/token checks for both ports and rate-limited `handshake-reject` logging. |
| [src/env.ts](../src/env.ts) | Bounded integer environment parsing, shared by broker configuration and its tests. |
| `src/ports.ts` | Server-side port resolution: runtime `CCMCP_PORT`/`CCMCP_CLIENT_PORT` override the build-time define. |
| `src/logger.ts` | JSON lines per tool-call lifecycle event under `~/.claude-chrome-mcp/logs/` (size-rotated, retention sweep, best-effort). |
| `extension/src/offscreen.ts` | Holds the persistent WebSocket; relays each request (with `sessionId`) to the SW and the response back; routes broker control frames; auto-reconnects. |
| [extension/src/offscreen-panel-channel.ts](../extension/src/offscreen-panel-channel.ts) | Socket-bound pending panel requests, deadlines and disconnect settlement. |
| `extension/src/background.ts` | Service worker: injects the authenticated `sessionId` into args, `executeTool()` dispatches to handlers, handles `session-open` and `session-closed` → reap, from the offscreen document only. |
| `extension/src/browser-tools.ts` | DOM, computer, file, wait and read handlers; domain helpers own input and capture. |
| [extension/src/tab-tools.ts](../extension/src/tab-tools.ts) / [element-ref.ts](../extension/src/element-ref.ts) | Tab/navigation handlers and neutral ref/frame lookup helpers. |
| [extension/src/computer-input.ts](../extension/src/computer-input.ts) / [capture-tools.ts](../extension/src/capture-tools.ts) | Keyboard paint-readiness and input dispatch; screenshot capture/downscaling. |
| [extension/src/browser-pointer.ts](../extension/src/browser-pointer.ts) | Opt-in trusted main-frame pointer clicks, CSS coordinates, explicit focus permission and document/ownership/geometry guards; no fallback or ambiguous replay. |
| [extension/src/diagnostics.ts](../extension/src/diagnostics.ts), [extension/src/health.ts](../extension/src/health.ts), [src/health.ts](../src/health.ts) | Bounded session operation metadata, coalesced health inspection and loaded build identities. Panel presentation uses the existing authenticated snapshot route. |
| [scripts/build-identity.mjs](../scripts/build-identity.mjs) | Deterministic build-input identity, including watch rebuilds; no personal stores or environment credentials are hashed. |
| [extension/src/page-wait.ts](../extension/src/page-wait.ts) | Shared worker-owned wait deadline and document probes for `wait_for` and navigation settling; page timers cannot survive every document replacement. |
| [extension/src/page-evaluation.ts](../extension/src/page-evaluation.ts) | The single CSP-capable execution path: serializes `evalInPage` / `checkWaitForInPage` into one `Runtime.evaluate`, decodes its envelope, and fences the result with document-identity probes, session ownership and the caller's deadline. Each predicate wait first uses non-persisted `Runtime.compileScript` to check Script syntax without executing the source. No fallback — an ambiguous evaluation failure is reported, never retried. |
| `extension/src/cdp-tools.ts` | Health, PDF, cookies, emulation and download handlers. |
| [extension/src/dialog-controller.ts](../extension/src/dialog-controller.ts) | Dialog policy, in-memory arms and the single Page event listener; defaults to dismiss. |
| [extension/src/download-state.ts](../extension/src/download-state.ts) | Per-session download capture and expiring arm ownership, serialized in `chrome.storage.session`. |
| `extension/src/cdp.ts` | `chrome.debugger` helper: lazy per-tab attach that is kept (steady banner), detach on tab close, `cdpSend`, and the `onCdpEvent` dispatcher. |
| `extension/src/gif-recorder.ts` | `gif_creator`: per-session frame capture (CDP screenshots on a timer) and GIF encoding in the service worker (OffscreenCanvas + gifenc); only the finished GIF crosses the bridge. |
| `extension/src/injected-page-scripts.ts` | Functions injected via `chrome.scripting.executeScript`; serialized with `func.toString()`, so fully self-contained. |
| [extension/src/injected-form-scripts.ts](../extension/src/injected-form-scripts.ts) / [injected-interaction-scripts.ts](../extension/src/injected-interaction-scripts.ts) | Self-contained form and interaction injections; inline resolvers stay inside each serialized function. |
| `extension/src/tab-group-helpers.ts` | Per-session tab-group ownership (`sessionId → groupId` in `chrome.storage.local`), `sessionOf()`, `assertTabInGroup()`, the read-only `lookupGroupId()`, identity refresh, `reapSession` and persisted cleanup retries. |
| `extension/src/tool-error.ts` | `ToolError` carrying the machine-readable error code. |
| `extension/src/content.ts` | MAIN-world content script at `document_start`: buffers `console.*` and fetch/XHR into page globals and keeps the in-flight counter behind network-idle waits. |
| `extension/src/popup.ts` | Popup: connection status, extension version, session/tab counts, bridge URL + optional token, self-reload button. |
| [test/helpers/mcp-client.mjs](../test/helpers/mcp-client.mjs), [cdp-observer.mjs](../test/helpers/cdp-observer.mjs), [socket-fixture.mjs](../test/helpers/socket-fixture.mjs) | MCP setup, correlated CDP observation and explicit socket/child ownership. Raw negative protocol frames and suite scenarios remain local. |

## Component 1: MCP server

- **Process:** Node.js, started by Claude Code over the stdio transport
- **SDK:** `@modelcontextprotocol/sdk`
- **Role:**
  - Advertise the tool catalog (`registerTool` in `src/tool-catalog.ts`; dispatch names in `shared/tool-names.ts`)
  - Validate tool-call args with Zod
  - Forward the call to the extension over WebSocket
  - Return result/error to Claude Code
- **Transport:** `BridgeClient` (ws client, `src/bridge-client.ts`) to the broker's client port `:9225`; the standalone broker (`src/broker.ts`) owns the extension port `:9223` and is auto-spawned by the first server
- **State:** pending tool calls (id → resolver, at-most-once via `src/pending-calls.ts`). The `sessionId → tabGroupId` mapping is owned by the extension (`mcpGroups` in `chrome.storage.local`, `extension/src/tab-group-helpers.ts`)

## Component 2: Chrome extension

- **Manifest:** v3
- **Background:** service worker (`background.ts`) — routes tool calls between the extension APIs and the offscreen document
- **Offscreen document:** hosts the WebSocket connection (`ws://localhost:9223`). Created by the SW at startup via `chrome.offscreen.createDocument({ reasons: ['WORKERS'] })`. Persistent — outlives the SW's ~30s idle timeout. Auto-reconnects with exponential backoff on disconnect.
- **Message routing:** offscreen doc ↔ SW via `chrome.runtime.sendMessage`. SW ↔ tabs/debugger via the standard Chrome APIs.
- **Auth:** the extension Origin gate and optional pre-shared token apply before WebSocket upgrade. Token setup and the optional extension-id pin are owned by [README → Security notes](../README.md#security-notes-v1).
- **Worker state:** download captures survive service-worker idle/restart through `chrome.storage.session`; pending collect replies do not, so collect again after a worker restart. GIF frames and dialog arms remain in worker memory. This avoids putting large frame buffers into shared storage and prevents an accept arm from surviving the default-dismiss fail-safe. See [download-state.ts](../extension/src/download-state.ts), [gif-recorder.ts](../extension/src/gif-recorder.ts) and [dialog-controller.ts](../extension/src/dialog-controller.ts).

### Required permissions

| Permission | Used by |
|---|---|
| `tabs` | tabs_*, navigate (resolve tabId), resize_window |
| `tabGroups` | tabs_context_mcp (the MCP tab-group concept) |
| `debugger` | `computer` (CDP Input.dispatch* trusted input, main frame), navigate back/forward (Page history), file_upload (DOM.setFileInputFiles), screenshots (Page.captureScreenshot), gif_creator (CDP frames), javascript_tool and `wait_for` predicates (Runtime.evaluate with a per-call CSP allowance) |
| `scripting` | read_page, get_page_text, find, form_input, select_option, `wait_for` selector/text/network-idle probes, the no-eval document-identity probes around every evaluation, computer (synthetic fallback), read_console_messages + read_network_requests (read the MAIN-world buffers) |
| `storage` | per-session group map (`mcpGroups`), download capture state (`storage.session`), bridge URL/token, status |
| `downloads` | download (capture via chrome.downloads) |
| `sidePanel` | Native control panel opened by a user gesture in the popup |
| `host_permissions: <all_urls>` | runs on every page (required for captureVisibleTab) |

## Component 3: bridge protocol

JSON messages over WebSocket. The shapes are owned by `shared/protocol.ts` (bundled into BOTH builds): `ToolRequest` (`id`/`tool`/`args`; the broker additionally stamps the session's `sessionId`), `ToolResponse` (`ok:true` + `result`, or `ok:false` + `error{code,message,retryable?}` with the codes in `ToolErrorCode`), `ClientHello` (first frame server→broker: `sessionKey` + `PROTOCOL_VERSION`), `ClientCall` (server→broker: one call with `timeoutMs` and an optional absolute `deadline`) and `ControlMessage` (broker→extension, out-of-band `session-open` and `session-closed` so the extension knows which sessions are alive and can reap an ended session's group — no `id`, not a tool call).

The [upgrade gate](../src/handshake-gate.ts) returns HTTP **401** for a token mismatch or
**403** for a rejected Origin/pin, before a connection can adopt the extension role or flush
queued calls. Rejections emit a rate-limited `handshake-reject` log event for diagnosis.
After upgrade, [broker-client-session.ts](../src/broker-client-session.ts) uses close **4003** for an invalid first hello and
**4004** for protocol skew; [bridge.ts](../src/bridge.ts) uses **4002** when a newer extension
connection replaces the old one. The client re-resolves its token when reconnecting.

A client writes no call before the broker's `broker-status` frame, which the broker sends
only after accepting the hello. A broker that rejects the hello (4003/4004) therefore leaves
every call unwritten, queued and retryable. A broker that sends no acknowledgement (an older
build) counts as accepting after a 1 s grace; until then `health` reports the bridge as not
connected. The broker never dispatches a call whose `deadline` has passed (`TIMEOUT`,
retryable) and bounds the extension hop's timer by it; a call that is still queued at the
broker when its deadline passes is cancelled there and answered the same way, while a call
already written to the extension ends on that hop's own timer. An older peer ignores or
omits the field.

The broker sends `session-open` when it accepts a hello. When an extension connects, it
first sends `session-open` for every live session, then the `session-closed` frames it
deferred while no extension was connected; frames on one socket keep this order. On
SIGTERM or SIGINT it refuses upgrades on both ports with HTTP **503**, closes open sockets
with **1001**, and keeps both ports bound until its modules have exited (a module still running
after 3 s is killed; the broker exits after at most 10 s), so a replacement broker cannot start a
second assistant on the same data. A client treats a 503 as a running broker and reconnects
instead of spawning one; calls it has not written stay queued for the next broker, within
their own timeout.

There are NO extension→server "events" (such as `tab_closed`/`console_log`): console and network data are pulled from page buffers via `read_console_messages`/`read_network_requests`, and `gif_creator` keeps its state in the service worker per session.

The optional panel route uses `panel-request`/`panel-response` frames on the existing
connections. The offscreen runtime listener admits only the exact local panel URL
and extension ID. The broker selects a uniquely connected authenticated session;
responses must come from that same client object. Replies return to the originating
extension socket, never a replacement. Requests expire, pending counts and payloads
are bounded, and starts are neither queued while disconnected nor replayed. No new
network listener is introduced. Polling carries observation metadata; recipe inputs
only travel in the explicit start request. Server-to-extension browser actions keep
their original broker-stamped session ID and ownership checks. Live tab metadata is
resolved inside the worker through the exact group-title check. The client hello
advertises panel support without changing protocol-v1 behavior for older clients.

Optional `modules`/`module` panel commands are handled by the broker before session
routing. They can address only IDs in its explicit local registry, never arbitrary
commands or paths. The panel sender check and authenticated extension connection
remain the entry boundary. Personal processes receive bounded JSON over stdin,
return validated presentation data, and are stopped on broker shutdown. Their
domain records do not enter the ordinary shared run history. The module directory
belongs to the broker, not to the client that spawned it; the order is in
[personal local modules](workflows-and-perception.md#personal-local-modules).

## Key concepts

### 1. MCP tab group

The extension creates one Chrome **tab group** per MCP session. Every tab in the group is "owned" by the MCP client and can be controlled. Tabs outside the group are invisible to the tools — security + isolation.

- `tabs_context_mcp` returns the tabs in the group + creates the group if it is missing
- Every tab-touching tool validates that `tabId` belongs to the session's group (`assertTabInGroup`) → otherwise a `TAB_NOT_IN_GROUP` error
- A stored ID is reusable only when the live title exactly equals
  `groupTitle(sessionId, storedSessionName)` (only the project name) **and** a saved
  Chrome page-target UUID still belongs to that mapped group. Equal project names
  do not authorize access. Worker/extension reloads preserve UUIDs; browser restarts
  replace targets, so recycled numeric IDs fail closed. Exact old encoded titles
  are accepted for migration, with target proof persisted before the visible code
  is removed. The optional hello label is bounded display metadata; Tabai's npm
  start route uses its caller's INIT_CWD, direct Node launches use process.cwd().
  Full paths are never sent. New/migrated groups are blue.
  [tab-group-helpers.ts](../extension/src/tab-group-helpers.ts) owns the identity check and locked
  stale-map removal. Restart cleanup and the accepted suffix-collision limit are described in
  [README → Security notes](../README.md#security-notes-v1).
- The recorded targets follow the group's live tabs. A tab that joins a mapped group without a
  tool call (a page's `target=_blank` or `window.open`, or a tab moved into the group) starts a
  background refresh of that session's proof, one per session at a time; so does a check that
  finds the live tabs differ from the recorded ones. The refresh re-verifies ownership under the
  group write lock and writes only when the sets differ. `tabs_context_mcp` and `tabs_close_mcp`
  inspect without the lock and wait for a recording only when a legacy title or unrecorded tabs
  need one; `tabs_close_mcp` closes nothing when that recording fails. Health, the panel's tab
  list and the dialog race read ownership without recording, dropping a mapping or waiting for
  the lock.
- A tab that left every session's group is released: its dialogs are no longer answered,
  device emulation is cleared and the debugger detaches, also for an attachment from before a
  worker restart. A tab in any mapped group keeps its attachment.
- `session-open` and `session-closed` are accepted from the offscreen document only. A cleanup
  that gives up after its retries is kept in `chrome.storage.session` and tried again only at a
  later `session-closed` frame, on a broker connection that has announced a session, and for at
  most ten minutes after it gave up. A session that calls or is announced again leaves that
  list. There is no retry at worker start: before the broker's announcements, a reconnected idle
  session would look exactly like an ended one.

[visual-presence.ts](../extension/src/visual-presence.ts) tracks per-session/tab work,
wait and capture counts in the worker. Its serialized, closed-shadow
[renderer](../extension/src/presence-script.ts) adds a click-through logo/status and
gradient edge to owned HTTP(S) pages. The local `showVisualPresence` preference
defaults on; the popup updates current pages. Navigation and worker startup reconcile
owned tabs, while group removal/renaming removes the badge. Page reads exclude it.
An extension reload may replace the isolated context while retaining DOM; the
page marker lets the new renderer retire its old surface. The marker is two keyed hashes,
one of the page's origin and one of origin plus session, so the page never sees a session
or extension ID and two origins never share a value. The key stays in extension storage
and is replaced at every browser start, when no painted surface survives. Presence
injects immediately so it cannot wait for document idle before a loading-page tool.
CDP image/PDF capture and the native screenshot fallback suppress the surface with
reference counting, restoring the current state even after capture failure. Cosmetics
never replay an action. Cosmetic waits are bounded and each tab keeps at most one
running and one coalesced render; startup reconciliation does not hold tool
dispatch. Cosmetic group appearance updates do not hold the ownership-map write
lock. Capture suppression retains the original queue and refuses image/PDF
capture if ownership/presence is not ready, hiding fails or its deadline expires;
a late cosmetic completion cannot bypass that barrier. Restore failures do not
mask completed captures. See [coordination regressions](../test/visual-presence.mjs)
and [live browser checks](../test/visual-presence-live.mjs). Reduced-motion
preferences stop the working animation.

### 2. Element-ref pattern

`read_page` and `find` return opaque numeric `ref_…` strings; sub-frame refs include
`@frameId`. Each document has a random namespace and an isolated node-identity map.
Resolvers require the original connected node, current namespace and exactly one
attribute match across open shadow roots. Clones cannot impersonate removed nodes.
CDP ref operations select the matching extension isolated context rather than a
MAIN-world attribute lookup. Context discovery and predicate compilation share a
per-tab Runtime setup lock; uncertain actions are never replayed.

At the start of each scan, [pageQuery](../extension/src/injected-page-scripts.ts) removes
disconnected elements from that frame's ref map, including when the scan returns no results.
Connected elements keep their refs even when hidden or excluded from the current results.
Cleanup waits for the next scan; it does not cap connected elements or force garbage collection.
A removed element rediscovered after cleanup receives a fresh ref from the monotonic counter.

- `form_input`, `file_upload`, `computer.scroll_to`, `upload_image` take a `ref` instead of (or in addition to) a coordinate
- More robust than coordinate-based clicks because the UI layout can change

### 3. Multi-browser support (CinC concept — NOT implemented, see decision 2)

One extension instance = one "device". Users can have several Chrome installations (laptop + desktop) paired with the same Anthropic account.

- `list_connected_browsers` lists all paired devices
- `select_browser(deviceId)` picks a known one
- `switch_browser()` broadcasts a handshake to every extension → the first one to click "Connect" wins

Implementation: a cloud relay is required for cross-device discovery. For a standalone (local-only) implementation → skipped in v1.

### 4. Permission per action (CinC concept — NOT implemented)

Locally there is no per-domain policy; the `navigate` scheme allowlist and per-session tab
ownership still apply. [tool-orchestration.ts](../src/tool-orchestration.ts) owns `browser_batch`
and `recipe_run`: each step uses its direct-call schema, and errors or cancellation stop the
sequence. Screenshot steps return metadata; PDF/GIF steps save files and return paths. Binary
payloads never become batch text. Current tool usage: [tool-catalog.md](tool-catalog.md#local-contract-notes).
Detailed workflow/data contracts: [workflows-and-perception.md](workflows-and-perception.md).

### 5. Image cache (CinC concept — NOT implemented)

CinC caches screenshots in the extension under an `imageId`. Locally there is no cache: `upload_image` takes an image from disk OR a fresh screenshot and delivers it via `file_upload` (CDP `DOM.setFileInputFiles`). The screenshot can show private page content, so the server writes it as a 0600 PNG in its own private temp directory (0700). Chrome reads the bytes lazily, at a later submit, so the directory stays until the server process ends: exit, SIGTERM and SIGINT remove it (after a signal the server exits with 128 + the signal number), and the OS temp cleanup is the backstop after a hard kill.

## Flow of a typical tool call

`mcp__tabai__navigate(url="https://example.com", tabId=123)` (an installation registered before the rename calls the same tool as `mcp__claude-chrome__navigate`):

1. Claude Code sends JSON-RPC `tools/call` to the MCP server over stdio
2. The server validates args with Zod → generates an `id` → `{id, tool:"navigate", args}` to the broker (`:9225`), which stamps the session's `sessionId` and forwards it over the extension port (`:9223`)
3. The extension service worker receives it and validates the tabId against the tab group
4. The extension validates the URL (allowlist http/https/about:blank), arms a `chrome.tabs.onUpdated` listener, then calls `chrome.tabs.update(123, {url})`
5. Navigation settles through [navigateAndSettle](../extension/src/tab-tools.ts): full loads wait for completion, fragment navigation can finish on its URL update, and a removed tab fails early; network-idle settling applies by default
6. The server finds the pending resolver for the id and resolves it with the result
7. The SDK returns it to Claude Code as the tool result

## Verified gotchas (POC, 2026-05-30)

1. **The offscreen document does NOT have `chrome.storage`** (nor `chrome.tabs`/`chrome.scripting`) — only `chrome.runtime`. The first POC version let the offscreen doc read config + write status via `chrome.storage.local` → it threw immediately on load, status was never set ("unknown" in the popup) + a silent red error on the extension card. **Fix:** the offscreen doc reads config + reports status through the service worker via `chrome.runtime.sendMessage` (`get-config` / `set-status`); the SW owns `chrome.storage`. Symptom signature: popup stuck on "unknown" + no connection attempt reaches the server.
2. **stderr buffering in a background process** — a server started as a plain background `node dist/server.js` flushes the startup lines but buffers later `console.error` lines; the log file looks "silent" even when the extension has actually connected. Trust the popup status / actual behavior, not just the buffered log.
3. **Stray processes on 9223/9225** — a process that does not shut down cleanly keeps the port; the broker then cannot bind and the extension connects to the "wrong" (uncontrollable) instance. Today: `npm run doctor` flags it, `npm run kill-broker` frees both ports (the CI harness uses its own ports 9224/9226 and cleans up after itself).
4. **Extension reload is required after a rebuild** — `npm run build` is not enough; click the reload arrow (↻) on the card in `chrome://extensions` so the old offscreen document + SW are torn down and the new code loads (`npm run reload` does the same from the CLI).

## Verified gotchas (Core, 2026-05-30)

5. **The loaded-from-the-wrong-folder reload trap** (cost ~5 rounds). An unpacked extension loaded from a DIFFERENT folder than the one you build into → builds never reach it. Symptom: "the reload doesn't take". **Diagnostic trick:** put the version in a tool response (`tabs_context_mcp` returns `chrome.runtime.getManifest().version`) → the test prints the running version and you see at once whether the wrong build is running. **Fix:** remove + Load unpacked from EXACTLY the build folder; bump the manifest version per change as a visible receipt on the card.
6. **`captureVisibleTab` requires `<all_urls>`** — `host_permissions: ["http://*/*","https://*/*"]` is NOT enough; Chrome literally requires the `<all_urls>` pattern, or `activeTab` *activated by a user gesture* (which never happens on MCP-created tabs). Set `"host_permissions": ["<all_urls>"]`.
7. **`image readback failed`** — captureVisibleTab can fail if the window is minimized/occluded/not composited. `computer screenshot` first tries CDP without taking focus. Its visible-tab fallback uses an already focused, selected tab by default; `allowFocus:true` permits restoring/focusing the window when an essential capture needs it. The fallback retries transient compositor failures. See the [local tool contract](tool-catalog.md#local-contract-notes).
8. **The element-ref system** — `read_page`/`find` tag elements with opaque `data-ccmcp-ref` values and retain the original nodes in an extension-isolated identity map. Document namespaces and strict duplicate checks prevent old or cloned refs from selecting another node. CDP consumers authenticate that same isolated context. See the element-ref pattern above.
9. **Console capture without the debugger** — a content script in `world:"MAIN"` at `document_start` wraps `console.*` → buffers into `window.__ccmcpConsole`. `read_console_messages` reads the buffer via executeScript (MAIN). Captures from page load, no debugger banner.
10. **Synthetic events are untrusted** — `el.click()` + dispatched MouseEvents work for most pages but `isTrusted:false`. `key` events do not trigger defaults → Enter is special-cased to `form.requestSubmit()`. Native widgets that require trusted input may not respond (acceptable for Core; debugger-based input is the next level).

## Security

- The WebSocket binds to `127.0.0.1` only (not `0.0.0.0`)
- The Origin gate excludes browser pages; installed extensions remain trusted unless the optional pin is set. Native processes can forge headers. Token setup and this trusted-local boundary are documented in [README → Security notes](../README.md#security-notes-v1). Session isolation uses broker-authoritative IDs independently of token configuration.
- `navigate` uses an **allowlist**: only `http`/`https` (+ scheme-less → `https`) and `about:blank`; every other scheme (`file:`, `chrome:`, `javascript:`, `data:`, …) is refused
- Only tabs in the session's own group are controllable (fail-closed without a sessionId); `gif_creator` re-validates group membership per frame (debugger attach)
- No remote-execution paths — the server can only send commands to locally paired extensions

## Resilience, event-driven CDP & DX (2026-06)

- **Bridge at-most-once + queue:** `bridge.call` queues calls during a brief extension disconnect and (re)sends on reconnect; a call that was already SENT is NOT replayed (it times out) → non-idempotent tools cannot double-run. Fast-fail only if the extension never connected. Bounded via `MAX_PENDING`. Args are serialized once (bad args fail fast).
- **Event-driven CDP:** `cdp.ts` has an `onCdpEvent` dispatcher for `chrome.debugger.onEvent`. `dialog` auto-handles `Page.javascriptDialogOpening` (opt-in per tab, default **dismiss**) so a JS dialog cannot wedge the bridge. `download` uses **`chrome.downloads`** (arm/collect) — CDP `Page.setDownloadBehavior` is rejected as "browser-level" in stable Chrome, and the Page.* download events are deprecated.
- **Structured logging:** `src/logger.ts` writes JSON lines per tool call to `~/.claude-chrome-mcp/logs/` (size-rotated, best-effort). A transport timeout is logged as `error:"TIMEOUT"` with `sent`, whether the call was written.
- **Auto-recover:** `tabs_create_mcp` re-creates a lost MCP group (`createMcpGroup`).
- **CDP handlers:** follow the domain imports in [background.ts](../extension/src/background.ts); [shared/tool-names.ts](../shared/tool-names.ts) owns dispatch names.
- **DX:** `npm run register` (user-scope `claude mcp` registration as `tabai`, or field-preserving update of an existing `tabai`/`claude-chrome` entry — policy in `scripts/mcp-registration.mjs`), `npm run doctor`, `npm run dev` (esbuild watch); GitHub Actions CI (ubuntu + windows); `postinstall` builds.

## Architecture decisions (2026-05-30)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Bridge: WebSocket** (`ws://127.0.0.1:9223`) | Fits MCP's stdio-owned process model. Native messaging would require a third process. Pattern proven in a prior private project. *Since 2026-06-12 the standalone broker owns the ws endpoint (several sessions share one extension) — the transport choice stands, "one process owns both transports" does not.* |
| 2 | **Multi-browser: skipped in v1** | Standalone local implementation, one paired extension instance. Cross-device requires a cloud relay → needless complexity for v1. Can be added later via the same `list_connected_browsers` / `select_browser` / `switch_browser` API if the need arises. |
| 3 | **SW idle: offscreen document** | `chrome.offscreen.createDocument({ reasons: ['WORKERS'] })` hosts the WS connection → outlives the SW's ~30s timeout. Standard MV3 pattern since 2023. |
| 4 | **Permission UI: CLI config file in v1** | `~/.claude-chrome-mcp/permissions.json` with domain allowlists. *Never built — the single-user scope made it unnecessary; the only gate is the `navigate` scheme allowlist. Open if it is ever needed (see the roadmap's "Deferred").* |
| 5 | **Repo name: `claude-chrome-mcp`** | Superseded 2026-09-06: the product is **Tabai**, and the repository was renamed to `NAlle33/tabai` on 2026-09-08 following [tabai-migration.md](tabai-migration.md); the old name redirects. The `claude-chrome-mcp` executable, the `claude-chrome` registration name, the `~/.claude-chrome-mcp` data directory, the `CCMCP_*` environment variables and the `__ccmcp*` page globals are retained as compatibility contracts, not leftovers. |

## Remaining open questions

None. The implementation details that were open on 2026-05-30 are settled: token generation (`npm run set-token`), port conflicts (`npm run doctor` / `npm run kill-broker`), permissions (`extension/manifest.json`).
