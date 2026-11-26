# CLAUDE.md

Agent rules for this repository. What the project is, how it is laid out and why it is built this
way live in [README.md](README.md) and [docs/architecture-map.md](docs/architecture-map.md); this
file holds only what prevents costly mistakes.

## Commands

```sh
npm install             # postinstall builds
npm run build           # esbuild -> dist/*.js (server, broker) + extension/dist/*.js. Does NOT typecheck
npm run typecheck       # TypeScript + build/npm scripts via checkJs; run after edits (build strips types)
npm test                # Chrome-free suite (exact list: package.json "test"); pretest builds
npm run test:ci         # LIVE suite (test/e2e-live.mjs) in a dedicated Chromium with the fresh build —
                        # no manual reload, own ports 9224/9226. CCMCP_HEADLESS=1 for headless
npm run smoke           # real-Chrome DPR smoke: the one check CI's DPR=1 browser can't (docs/smoke-runbook.md)
npm run trial           # same assistant tasks on every model backend; REAL model calls, never in CI (docs/model-trial.md)
npm run reload          # make the loaded extension reload itself from disk after a build
npm run kill-broker     # stop the detached broker after changes bundled into dist/broker.js
npm run doctor          # diagnose: dist built? ports 9223/9225 free or broker-owned? registered? node version?
npm run register        # registers `tabai`, or updates an existing `tabai`/`claude-chrome` entry (Claude Code closed; -- --name to choose)
npm run set-token       # OPTIONAL opt-in token for the broker client port; then npm run kill-broker
npm run set-extension-id -- <id>  # OPTIONAL extension-Origin pin; then npm run kill-broker
npm run dev             # esbuild watch (the reload and restart rules below still apply)
```

Run `node test/e2e-live.mjs` directly only against the user's everyday Chrome after a manual
reload; `npm run test:ci` runs the same suite with no manual step. A direct run waits until the
extension and the broker report the build ID of the server it starts, so restart the broker too,
and it shows the checks that need the browser's own debugging endpoint as skipped.

## After every build

- **Extension code** (`extension/src/*`): Chrome keeps running the OLD bundle until the extension
  reloads — `npm run reload`, or ↻ on the card in `chrome://extensions`. A new **required**
  permission (`permissions`/`host_permissions`) needs remove + Load unpacked (a reload cannot grant
  it); new `optional_permissions` and `commands` work after a normal reload. `test/e2e-live.mjs`
  polls for this build on the extension and the broker and says which one is stale while it waits.
- **MCP server code** (`src/server.ts` and its bundled dependencies): have the MCP host restart
  its stdio server from the rebuilt `dist/server.js` and reload the tool catalog; restarting the
  host also starts a fresh server. Each process owns its descriptions, schemas, handlers and
  `health.serverVersion` ([src/server.ts](src/server.ts)). Verify the changed catalog and server
  version through that fresh process. `npm run kill-broker` only reconnects existing servers and
  cannot refresh their code or catalog.
- **Broker code** (`src/broker.ts` and its bundled dependencies): the detached singleton keeps
  running the OLD `dist/broker.js` until `npm run kill-broker`; existing servers reconnect and
  auto-spawn the new broker ([src/bridge-client.ts](src/bridge-client.ts)). Killing it briefly
  drops every live session's connection; in-flight calls time out instead of double-running.
  Coordinate this shared restart and check process ownership first.
- **Shared code** (`shared/*` or other imports used by multiple bundles): refresh every affected
  process using the rules above. After a `PROTOCOL_VERSION` bump, restart both MCP servers and
  broker together; mismatched versions are rejected ([src/broker.ts](src/broker.ts)).
- **Ports**: the broker owns `127.0.0.1:9223` (extension) + `:9225` (clients). A stray process on
  either blocks it — `npm run doctor` flags it, `npm run kill-broker` frees both. The CI harness uses
  9224/9226 and reaps its own broker.
- Per-session isolation exists only with the NEW extension loaded: an old bundle ignores the
  stamped `sessionId` and collapses every session into one group.

## Definition of done

`npm run typecheck` and `npm test` green before reporting a change complete. For anything under
`extension/src/` or a tool handler, also `npm run test:ci` — it is the only automated check of
extension behaviour. Never weaken or delete a test to get green.

[GitHub Actions](.github/workflows/ci.yml) runs Chrome-free checks on Ubuntu and Windows;
its Ubuntu `live` job runs `test:ci` headless.

## Constraints you cannot infer from the code alone

- **Tabai is the product name; the old identifiers are compatibility contracts.** Keep the
  `claude-chrome-mcp` executable alias, the `claude-chrome` registration name (and its
  `mcp__claude-chrome__*` prefix), the `~/.claude-chrome-mcp` data directory, the `CCMCP_*` env
  vars and the `__ccmcp*`/`data-ccmcp-ref` page identifiers. Renaming any of them breaks existing
  installs ([docs/tabai-migration.md](docs/tabai-migration.md)).
- **The offscreen document has `chrome.runtime` only.** No `chrome.storage`/`chrome.tabs`/
  `chrome.scripting` in `extension/src/offscreen.ts`: a `chrome.storage` call there throws on load
  and silently kills the WebSocket. Route config/status through the service worker
  (`get-config` / `set-status`).
- **Injected page functions are serialized with `func.toString()`.** Functions in
  `extension/src/injected-page-scripts.ts`, `injected-form-scripts.ts` and
  `injected-interaction-scripts.ts` must be self-contained: no imports, no module-scope
  constants, no closures — only own params + page globals. Ref resolvers are therefore
  duplicated inside the injected functions: change all relevant copies or none.
- **`computer`'s synthetic-event fallback for sub-frames is untrusted input** (`isTrusted:false`).
  Native widgets that ignore it are a limitation of the fallback, not a bug to patch.
- **Trusted pointer input is explicit** (`pointerMode:"browser"`, main-frame clicks only).
  Keep CSS coordinates, document/ownership/focus guards and opt-in focus activation.
  Never silently fall back or replay an ambiguous pointer dispatch.
- **`javascript_tool` and `wait_for` predicates run through CDP `Runtime.evaluate`, not
  `chrome.scripting`.** A MAIN-world injection inherits the PAGE's CSP, so a page without
  `unsafe-eval` (GitHub) refuses to evaluate a string at all. The per-call
  `allowUnsafeEvalBlockedByCSP` allowance is the whole point of `extension/src/page-evaluation.ts`;
  moving either back to an injection reintroduces the bug, and the cost of the current path is that
  DevTools open on the tab blocks evaluation. Never add a fallback evaluator: a command that failed
  ambiguously may already have mutated the page.
- **`download` uses `chrome.downloads`, not CDP.** `Page.setDownloadBehavior` is rejected as
  browser-level in stable Chrome; do not "upgrade" it.
- **`dialog` defaults to dismiss and never auto-confirms.** Keep it that way.
- **At-most-once** (`src/pending-calls.ts`, shared by both hops): a call already written to a
  socket is never re-written on reconnect; it times out. Do not add replay.
- **Worker request limits:** keep `wait_for`/`download collect` at or below 270 s and the transport
  ceiling at 300 s (`shared/protocol.ts`). Keep both schema bounds and extension-side clamps;
  the margin avoids Chrome's five-minute single-request worker limit.
- **Cross-platform**: CI runs Ubuntu **and** Windows. npm scripts stay `node …` only — no
  shell-specific constructs; build paths with `node:path`.

## Security invariants (do not weaken)

- Every session owns its own tab group. Handlers resolve the session with `sessionOf(args)` and gate
  every tab access through the single chokepoint `assertTabInGroup(sessionId, tabId)`
  (`extension/src/tab-group-helpers.ts`). A missing/empty `sessionId` **fails closed** — never add a
  shared "default" group.
- A plain project title never establishes ownership. Validate its exact stored title,
  session-to-group mapping and at least one recorded live Chrome page-target UUID
  (`tab-group-helpers.ts`). Record UUIDs only after creation or verified ownership,
  under the group write lock, and refresh them after adding/duplicating owned tabs and
  whenever verified ownership finds unrecorded tabs (pages open tabs into the group
  themselves). Inspect without the lock; take it only to record. `tabs_close_mcp`
  records first and closes nothing when it cannot. Observers (health, the panel's tab
  list, the dialog race) use the read-only `lookupGroupId` and never wait for the lock.
  This survives worker/extension reloads and rejects recycled numeric IDs after a
  browser restart. Exact previous encoded titles are migration inputs; persist the
  internal identity before removing their visible code. Never adopt groups by name.
  Failed identity/list inspections retain the mapping and stop replacement creation.
  These guards also run after dispatch, so their errors must not invite action replay.
- Keep the HTTP upgrade Origin gate (`src/handshake-gate.ts`): `:9225` rejects every Origin
  header; `:9223` requires `chrome-extension://`, exactly the pinned ID when
  `~/.claude-chrome-mcp/extension-id` is set. This bounds web pages; installed extensions are
  trusted unless pinned, and native processes can forge headers. Do not loosen the gate.
- `sessionId` is broker-stamped from the per-process `sessionKey` in the `ClientHello`, never taken
  from client-supplied per-call data. Keep the service worker's unconditional overwrite of
  `__sessionId` in `background.ts`.
- `session-closed` and `session-open` are accepted from the offscreen document only. A persisted
  cleanup retry runs only at a later `session-closed` frame, on a broker connection that has sent
  `session-open`, for at most ten minutes. Never retry at worker start: before the broker's
  announcements a reconnected idle session looks ended, and the retry would close its live group.
- Any per-session state in the service worker (recordings, download arm/collect, attached tabs)
  must be keyed by `sessionId`.
- Persist download capture state through `download-state.ts` and its serialized storage writes.
  Keep GIF frames and dialog arms in memory; persisting an accept arm would outlive the
  default-dismiss fail-safe.
- `navigate` allowlist: `http`/`https` (scheme-less → `https`) and `about:blank` only
  (`shared/url-guard.ts`). Do not add schemes.
- Loopback-only, token optional by design (trusted-local posture; rationale in README → Security
  notes). Do not make the token mandatory without the user's decision.

## Adding an extension-dispatched tool (four edits, one test)

1. `shared/tool-names.ts` — add the name (`test/tool-names-consistency.mjs` fails otherwise).
2. The matching handler module under `extension/src/` (follow the imports in `background.ts`) —
   `assertTabInGroup(sessionOf(args), tabId)` first, then the Chrome API or a self-contained injection.
3. `extension/src/background.ts` — a `case` in `executeTool()`.
4. `src/tool-catalog.ts` — `registerTool` with the Zod input schema; its `description` is the contract the
   calling model reads.

Add a check to `test/e2e-live.mjs`, then `npm run build`, refresh the affected processes using
[After every build](#after-every-build), and run `npm run test:ci`.
Server-only tools (batch, recipes, upload_image) need step 4 only.

## Conventions

- Conventional commits (`feat:`/`fix:`/`docs:`/`test:`/`refactor:`), scoped with explicit pathspecs.
- Code comments explain the invariant or race, never a plan or finding ID.
- When docs and code disagree, the code is current: fix the doc. `docs/architecture-map.md` and
  `docs/tool-catalog.md` deliberately keep unimplemented CinC reference concepts, labelled as such.
- Per-call logs: `~/.claude-chrome-mcp/logs/` (JSON lines; `CCMCP_LOG_DIR` overrides). Read them
  before guessing at bridge/broker behaviour.
- `plans/` is gitignored and never enters this repository: local, stateful plans and audit
  reports live there; they are not product authority.
