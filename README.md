# Tabai

<img src="docs/assets/tabai-mandala.png" alt="Tabai mandala" width="128">

Tabai is a standalone TypeScript MCP server that controls Chrome through a custom Manifest-v3 extension. It is an independent, from-scratch implementation that offers the tool surface of Anthropic's "Claude in Chrome" with no dependency on Anthropic's extension or cloud. Tabai is not affiliated with or endorsed by Anthropic or Google.

**[Watch the 21-second demo on TechTeddy](https://techteddy.ai/en/apps/tabai#demo).** Tabai opens the site in its own Chrome tab group and gets the TechTeddy bear to play saxophone.

Tabai is provided as-is under the [MIT License](LICENSE), without warranty or a support commitment. Report security problems privately as described in [docs/SECURITY.md](docs/SECURITY.md).

Tabai was published as `claude-chrome-mcp` until September 2026. Existing installations keep working unchanged: the `claude-chrome` registration name with its `mcp__claude-chrome__*` tool prefix, the `claude-chrome-mcp` executable, the `~/.claude-chrome-mcp` data directory and the `CCMCP_*` environment variables are retained on purpose. [docs/tabai-migration.md](docs/tabai-migration.md) lists what changed and how to move an existing checkout.

## Status: Claude-in-Chrome parity, plus resilience, CDP extras, multi-session & one-command setup

Full CinC tool surface (multi-browser excepted — N/A for a single machine) **plus** extras CinC lacks: `wait_for`, `select_option`, `fill_form`, `recipe_save`/`recipe_list`/`recipe_run`, and more. The live suite exercises the tools against a fresh Chromium (`npm run test:ci`, see [test/ci-harness.mjs](test/ci-harness.mjs)). [GitHub Actions](.github/workflows/ci.yml) runs the Chrome-free suite plus typecheck on Ubuntu + Windows, and the `live` job runs the browser suite headless on Ubuntu.

Highlights: auto-wait/actionability · `wait_for` · open-shadow-root traversal + iframe targeting incl. **cross-origin** (`allFrames` + frame-qualified `ref@frameId`; `file_upload` cannot reach a cross-site frame) · hierarchical `read_page` · network-idle nav · CDP keyboard input + reliable screenshot · `file_upload` / `upload_image` · `browser_batch` · recipes · `gif_creator` · **several Claude Code sessions at once**, each in its own isolated tab group (see Architecture).

By default, ref and coordinate clicks use untrusted page events (`isTrusted:false`) and work in the background. Opt into trusted main-frame clicks with `computer {pointerMode:"browser"}`. This requires a visible, focused tab; `allowFocus:true` explicitly permits activation. It supports left/right/double/triple click, checks the current document/target and never falls back or replays an ambiguous dispatch. Both modes use CSS pixels. `computer screenshot` returns CSS-pixel viewport images. Contracts and display checks: [docs/smoke-runbook.md](docs/smoke-runbook.md).

### Tools

The authoritative list is in code: [shared/tool-names.ts](shared/tool-names.ts) (extension-dispatched tools) plus the server-orchestrated tools registered in [src/tool-catalog.ts](src/tool-catalog.ts) (`browser_batch`, `upload_image`, `recipe_save`, `recipe_list`, `recipe_run`, `recipe_checkpoints`, `recipe_resume`, `run_history`, `timeout_incidents`). By category:

POC: `tabs_context_mcp` · `tabs_create_mcp` · `navigate` · `get_page_text` · `javascript_tool`
Core: `read_page` · `find` · `form_input` · `computer` (click/type/key/scroll/hover/drag/screenshot/wait) · `read_console_messages`
Advanced: `tabs_close_mcp` · `resize_window` · `read_network_requests`
Reliability: `wait_for` (selector/text/predicate/networkIdle/exact URL/field value) · `select_option` · auto-wait/actionability baked into clicks + form_input
Speed: `browser_batch` (prevalidated sequence, fresh targets, outcome checks and aggregate results)
Perception: `read_page` compact mode · `read_page_diff` · `extract_table` · `resolve_target` · `screenshot_marked` (numbered main-frame click targets)
Files/recipes: `file_upload` (local paths → file input) · `upload_image` (disk image or fresh screenshot → file input) · `recipe_save` / `recipe_list` / `recipe_run` (typed parameters, fresh targets and expectations; recipe_run injects a default tabId) · `run_history` (step timing/status, opt-in failure PNG)
Recording: `gif_creator` (start_recording / stop_recording / export / clear → animated GIF saved under `~/.claude-chrome-mcp/gifs/`)
CDP tools: `print_to_pdf` (→ `~/.claude-chrome-mcp/pdfs/`) · `cookies` (get / domain-scoped clear) · `screenshot` (element/region clip) · `emulate_device` (size/DPR/mobile)
Tabs/files: `tab_switch` · `file_drop` (drag-drop a local file onto a target) · `download` (arm → trigger → collect → saved path)
Robustness: `dialog` (opt-in auto-handle alert/confirm/prompt, default dismiss) · `health` (bridge + extension state)
DX batch: `fill_form` (set many fields in one round-trip) · `storage` (read/write local/session web storage) · `get_accessibility_tree` (bounded role/name tree) · `tab_reload` · `tab_duplicate` · `extension_reload` (self-reload after a build)

`read_page`/`find` and ref resolvers pierce open shadow roots; `read_page` is indented by DOM depth. Iframes are queried separately with `allFrames` injection and addressed through frame-qualified `ref@frameId`; in-page resolvers stay within the targeted frame. `navigate` waits for network-idle by default (`waitUntil: "load"` to skip).
CDP/debugger tier: `file_upload` + reliable `computer screenshot` (CDP `Page.captureScreenshot`) + trusted main-frame `computer` keyboard input (CDP `Input.*`) + `navigate` back/forward + `javascript_tool` and `wait_for` predicates (CDP `Runtime.evaluate`, so they work on pages whose Content-Security-Policy omits `unsafe-eval` — the page's own `eval` stays blocked and its policy is never edited). Requires the `debugger` permission → yellow "debugging this browser" banner while attached, and DevTools must be closed on the target tab. History traversal includes entries Chrome's toolbar may skip after synthetic clicks; see the [local navigation contract](docs/tool-catalog.md#local-contract-notes).

Recipes now use locked, backed-up atomic persistence and fail closed on corrupt stores. Usage, result envelopes, history retention and screenshot coverage: [workflows and page perception](docs/workflows-and-perception.md).

`health` returns loaded server, broker and extension build IDs with bounded, session-scoped Chrome operations. **Teknisk diagnostik** shows the same information and identifies peers that differ from the running server. `timeout_incidents` retrieves automatic, private metadata bundles retained across restarts. Version numbers alone cannot prove freshness. [Diagnostics contract](docs/workflows-and-perception.md#build-and-operation-diagnostics).

Start a recipe with `resumable:true` to save durable checkpoints. `recipe_checkpoints` lists continuation IDs; `recipe_resume` verifies the same inputs and current page before running the remaining steps. The panel offers the same controls. Ambiguous effects block continuation. [Resume contract](docs/workflows-and-perception.md#resumable-recipes).

New external sessions create their own window in the background without taking focus.
The daily assistant creates its owned group in the initiating panel's window.
An explicit `tabs_context_mcp` `createWindowId` provides the same placement for
other clients; it never adopts existing user tabs or moves an existing group.
Navigation, additional tabs and `tab_switch` keep that window in the background.
Tools already address a `tabId`, so routine work does not need a preceding switch.
Use `tab_switch` with `bringToFront: true` when you need to show an owned tab.
`computer screenshot` also stays in the background by default. If its CDP capture
fails, the visible-tab fallback can use an already focused, selected tab. For an
essential screenshot that needs the window shown, the agent can retry with
`allowFocus: true`; that option permits focus only if background capture fails.

**Agent foreground permission is off by default.** The popup setting **Tillåt att
agenter tar fram Chrome** must be enabled by the user before `bringToFront:true`
or `allowFocus:true` can bring a window forward. The saved choice applies to all
sessions and survives reloads. A blocked request returns `FOCUS_DISABLED` before
selecting a tab or focusing a window; background tools and CDP screenshots still work.

Tabai groups are blue and use the MCP session's project directory name, such as
`tabai` or `Hej och Hå`, without a visible session code. The control panel uses
the same names. Sessions in the same project keep separate owned groups even when
their labels match. Only the directory name is sent, never its full local path.
When started through Tabai's npm start script, the name comes from npm's original
caller directory, rather than the installation folder. Clients without project
metadata use `Tabai`; older encoded names migrate when the session next uses its group.
Temporary Chrome inspection errors retain the existing group mapping and stop
the call without creating a replacement window. A group confirmed missing can
still be recreated. A new MCP process starts a new session; matching project
names do not authorize taking over another session's group.
The baby-blue mandala identifies Tabai in the toolbar, popup, side panel and
page badge. On ordinary web pages, the badge shows **Arbetar**, **Väntar** or **Redo**.
A thin blue edge moves only during tool work and respects reduced-motion
preferences. The badge and edge let clicks through and disappear from Tabai screenshots,
marked captures, GIF frames and PDF exports. Turn them off immediately for all sessions
with **Visa Tabai på sidan** in the extension popup; the choice survives reloads.
Chrome owns the native tab-strip styling, so the logo and gradient appear inside the page.

Open **Öppna kontrollpanelen** in the popup for the Chrome side panel: select a live
session, follow its current step/tab and elapsed time, run saved recipes with typed
parameters, or inspect local run history. **Stoppa efter pågående steg** finishes
the current workflow step and its expectation before stopping further steps.
It also works on batches/recipes started by the agent. Existing changes are retained.
Open saved failure PNGs and timeout packages directly in the panel. Its loop guard
pauses repeated inputs/clicks after three unchanged observations, while reads remain
available; **Fortsätt efter kontroll** releases the pause without replaying anything.
Setup and boundaries: [control panel](docs/workflows-and-perception.md#chrome-control-panel).

The panel starts with **Din vardagsassistent**: check Gmail, Outlook and Zoho mail,
follow up sent messages, prepare meetings, review the day and run saved instructions.
One main chat holds questions, progress, results and approval cards, with settings
and saved work accessible alongside it. Drag files into the composer or use
**Bifoga filer**; choose text size under **Inställningar → Allmänt**. Chat about
general topics or request an existing task, with a visible model choice. Test account reading,
link related sources into a case, save progress, continue
unfinished checks, inspect explicit preferences, and optionally enable a morning
overview. Settings also offer light/dark navy and accent choices. Configure accounts
in the panel; the bundled worker uses the signed-in Chrome profile and your choice of
Codex (your existing Codex CLI login), Claude (your existing Claude Code login; no API
key is stored), Berget.ai (your own privately stored key) or, experimentally, the pinned Qwen3.5 4B model in your own
[Ollama](https://ollama.com/download) on `127.0.0.1`.
Local mode never falls back to the cloud; the browser still reads web mail online and
model weights are pulled by you, not bundled. [Daily assistant](docs/daily-assistant.md)
explains setup, local models and licences, private storage, notifications and the
explicit approval boundary for sending replies. Its topic guides cover the
[panel and chat](docs/assistant-panel-and-chat.md), [mail](docs/assistant-mail.md),
[web access](docs/assistant-web-access.md),
[watches and routines](docs/assistant-watches-and-routines.md) and
[models](docs/assistant-models.md). The [model trial](docs/model-trial.md)
(`npm run trial`) gives every model backend on this computer the same assistant tasks.

**Inställningar → Webbåtkomst → Full Tabai-åtkomst för agenter** optionally gives
every panel agent the ordinary Tabai MCP browser tools, including JavaScript,
cookies, downloads and uploads. It keeps session-owned tabs and the foreground
preference, while allowing requested browser actions without the panel's extra
site and approval gates. It enables no terminal or general filesystem tools.
It is off by default; existing guided settings are retained. See
[full access and its boundaries](docs/assistant-web-access.md#full-tabai-access).

The panel also supports explicitly installed [personal local modules](docs/workflows-and-perception.md#personal-local-modules).
Their code, configuration and records live outside this repository. A clean install
has no personal cards; sharing Tabai does not include locally registered modules.

## Architecture (one-liner)

```
Claude Code (1..n) ──stdio──▶ MCP server (1..n) ──ws :9225──▶ broker (singleton) ──ws :9223──▶ extension offscreen doc ──runtime msg──▶ service worker ──Chrome APIs──▶ page
```

Every MCP server process is a thin client of one auto-spawned **broker** that owns the extension connection; each session gets its own isolated tab group. Per-file map, design decisions and verified gotchas: [docs/architecture-map.md](docs/architecture-map.md). Agent rules and security invariants: [CLAUDE.md](CLAUDE.md). CinC reference catalog: [docs/tool-catalog.md](docs/tool-catalog.md).

## Build

Use a current Node.js 22 or 24 release (minimum: Node.js 22).

```powershell
npm install
npm run build      # -> dist/server.js + extension/dist/*.js
npm run dev        # esbuild watch — rebuild on change (still click ↻ in chrome://extensions)
npm run typecheck  # application, build/npm scripts and protocol test fixtures
npm test           # Chrome-free suite (exact list: package.json "test"); builds first
npm run register   # register with Claude Code as tabai, or update an existing tabai/claude-chrome entry — run with CC closed
npm run doctor     # diagnose setup: dist built? ports 9223/9225 free or owned by the broker? registered? node version?
npm run kill-broker  # stop the detached broker after changes bundled into dist/broker.js
npm run reload     # make the loaded extension reload itself from disk after a rebuild (no manual ↻)
npm run set-token  # OPTIONAL: opt-in token for the broker's client port (see Security notes)
npm run set-extension-id -- <id>  # OPTIONAL: pin the extension-port Origin; then kill-broker
npm run test:ci    # launches a dedicated Chromium with the freshly-built
                   # extension + runs the live suites in test/ci-harness.mjs — no
                   # manual reload, own ports, isolated from your everyday Chrome.
                   # CCMCP_HEADLESS=1 for headless.
```

To keep fake-peer responses aligned with the [wire contract](shared/protocol.ts), use the
[typed fixture serializer](test/protocol-fixtures.mjs). Fixture suites opt in with
`// @ts-check` and are selected by [the test typecheck config](tsconfig.tests.json);
deliberately malformed input tests stay outside that valid-response boundary.

For display-dependent coordinate checks, real cross-origin embeds and auth-gated sites: [docs/smoke-runbook.md](docs/smoke-runbook.md). `npm run smoke` checks synthetic landing; `node test/browser-pointer-live.mjs` verifies trusted input on the real display.

`test:ci` restores the development build without its temporary ports, log path or short reap grace. Normal broker logs remain under `~/.claude-chrome-mcp/logs/` unless you explicitly set `CCMCP_LOG_DIR`; see the [harness](test/ci-harness.mjs) for cleanup and failure-log retention.

Recipes, saved PDFs and GIFs default to `~/.claude-chrome-mcp/` (the pre-rename directory name is kept so existing data, the token file and the extension-id pin stay in place). Set `CCMCP_CONFIG_DIR` on the MCP server to use another store ([src/config-dir.ts](src/config-dir.ts)); tests use a disposable store. This override does not move broker logs, the token file or the extension-id pin. Nor does it move the module directory of a broker that server spawns (the daily assistant's data and the personal module registry), unless that directory already holds an `assistant/` directory or the module registry `personal-modules.json`; see [personal local modules](docs/workflows-and-perception.md#personal-local-modules). A relative `CCMCP_CONFIG_DIR`, `CCMCP_LOG_DIR` or `CCMCP_MODULE_CONFIG_DIR` is resolved against the working directory of the client that starts the broker; the broker itself runs in its bundle directory.

`CCMCP_UPLOAD_DENY_ROOT` on an MCP server makes `file_upload` and `file_drop` refuse, with `FILE_REFUSED`, every path that is not an absolute path to an existing regular file outside that directory, including paths that batch or recipe steps build. Containment is decided by the directory's identity, not its name, so another name for the same directory (macOS's `/System/Volumes/Data/...`) is refused too; a path that cannot be checked is refused, and on Windows so is a share or device path. The daily assistant sets it on its own server to the per-user data directory ([guardLocalFiles](src/tool-orchestration.ts)).

Roadmap (parity with Claude-in-Chrome + the frontier beyond it): [docs/project-roadmap.md](docs/project-roadmap.md).

## Run it for real (3 steps)

### 1. Load the extension into Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** → select the `extension/` folder in this repo
4. Click the extension's toolbar icon → popup should show **Status: connected** once the MCP server is running (step 2). Default bridge URL `ws://127.0.0.1:9223`, no token.

### 2. Register the server with Claude Code

`npm run register` registers the server **user-scoped** so it's available in every project. Run it with Claude Code **closed**, then reopen. A fresh install is registered as `tabai`, so tools appear as `mcp__tabai__navigate`, etc. The equivalent manual command is:

```powershell
claude mcp add tabai -s user -- node "C:/path/to/tabai/dist/server.js"
```

An installation that already has the pre-rename `claude-chrome` entry keeps that name and its `mcp__claude-chrome__*` prefix: the script leaves a correct entry alone, repoints it (keeping its command and environment) only when its path is stale because the checkout moved or reaches this checkout through another path such as a symlink, and stops without touching anything when both names exist, an entry points at another checkout, or an entry is not a plain `node <server>` stdio entry — choose between the two names with `npm run register -- --name tabai` or `-- --name claude-chrome`. A replaced entry is backed up under `~/.claude-chrome-mcp/backups/`, re-added through `claude mcp add`, verified by re-reading the configuration and restored if any step fails. `npm run doctor` reports which name is registered for this checkout.

> **Where Claude Code actually looks:** it loads MCP servers from a project `.mcp.json` and from `~/.claude.json` (the file `claude mcp add` writes). It does **NOT** read `~/.claude/.mcp.json` — that path is only a personal inventory convention, not a config the CLI loads. Don't hand-edit `~/.claude.json` while Claude Code is running (it rewrites that file from memory on exit and will drop the change); use `claude mcp add` (global) **or** a project `.mcp.json` (this repo only) — but not both with the same name, or Claude Code flags a duplicate.
>
> A newly added server needs a Claude Code **restart** to load — `/mcp` "reconnect" only re-attaches servers already loaded in the current session.

> Works on the Claude Max plan — local MCP servers are plan-independent. (This is a Claude **Code** server; it cannot be used from claude.ai web without a public HTTPS + OAuth deploy.)

### 3. Use it

```
tabs_context_mcp { createIfEmpty: true }   -> creates a window + MCP tab group, returns tabId
navigate         { url: "example.com", tabId: <id> }
get_page_text    { tabId: <id> }
javascript_tool  { text: "document.title", tabId: <id> }
```

## Security notes (v1)

- Both broker ports (`:9223` extension, `:9225` clients) bind **127.0.0.1 only** — not reachable off-machine.
- Browser pages are excluded at the WebSocket upgrade: `:9225` rejects any `Origin` header, and `:9223` requires a `chrome-extension://` Origin ([src/handshake-gate.ts](src/handshake-gate.ts)). Installed extensions are inside this trust boundary by default. To accept only this extension's Origin, copy its ID from the popup and run `npm run set-extension-id -- <id>`, then `npm run kill-broker`. The pin is stored in `~/.claude-chrome-mcp/extension-id`; `npm run set-extension-id -- --clear` removes it.
- **Token auth is optional** (empty = disabled) for zero-friction local dev. Extension port: set `BRIDGE_TOKEN` env on the server/broker and the matching token in the extension popup. Client port: `npm run set-token` writes a 0600 token file that the server and broker both read ([src/auth.ts](src/auth.ts)); `BRIDGE_TOKEN` takes precedence. Harden before any non-loopback use.
- The popup's **Bridge URL** accepts only a `ws://` address on `127.0.0.1`, `localhost` or `[::1]` without a query or fragment, and its token field is a password field. The service worker checks a stored address again before handing it to the offscreen socket, which otherwise uses the default `ws://127.0.0.1:9223` ([bridge-url.ts](extension/src/bridge-url.ts)).
- **Trusted-local posture:** the Origin gate does not authenticate native processes, which can supply arbitrary headers. With no token, a local process can supersede the extension under newest-connection-wins, spoof tool results, or pose as a client. Tokens remain optional; the extension-id pin narrows accepted browser extensions, not native processes.
- **Per-session isolation does not depend on the token.** Each Claude Code session owns its own tab group, keyed by a broker-authoritative `sessionId` a sibling session cannot forge; a missing sessionId fails closed. Details: [CLAUDE.md → Security invariants](CLAUDE.md#security-invariants-do-not-weaken) and [docs/architecture-map.md → Security](docs/architecture-map.md#security).
- `navigate` uses an **allowlist**: only `http`/`https` (scheme-less → `https`) and `about:blank`; every other scheme (`file:`, `chrome:`, `chrome-extension:`, `devtools:`, `javascript:`, `data:`, …) is refused.
- Only tabs inside the calling session's tab group are controllable — every other tab is invisible to that session's tools (`gif_creator` re-checks group membership on every captured frame, since it attaches the debugger).
- Plain group titles are display metadata. Reuse requires the exact saved title, session-to-group mapping and a recorded Chrome page-target UUID still inside the group. Worker and extension reloads retain these proofs; recycled numeric group/tab IDs after a Chrome restart cannot supply the old target UUID. Exact previous encoded titles remain migration inputs, retaining their former 1/65536 suffix-collision limit only during migration. A group without a recorded live target is left orphaned and a new group is created on demand; close leftover windows by hand. Groups are never adopted by searching their names ([group ownership](extension/src/tab-group-helpers.ts)).
- Defense-in-depth caveat: the MAIN-world content script + ref resolution trust page-controllable DOM/globals — a hostile page could plant a decoy `data-ccmcp-ref` or pollute the captured console/network buffers. Not an escalation (the operator already runs arbitrary JS via `javascript_tool`).

## Layout

```
tabai/
├── shared/      wire protocol, canonical tool-name list, URL allowlist — bundled into BOTH builds
├── src/         MCP server, broker, bridge transports, logger (Node)
├── extension/   MV3 extension: manifest, icons, service worker, offscreen doc, content script, popup
├── scripts/     npm helpers: register (+ shared registration policy), doctor, kill-broker, reload, set-token
├── test/        Chrome-free suite (npm test), CI live harness (test:ci), real-Chrome smoke, e2e-live
├── docs/        design notes, assistant guides, model trial, CinC reference catalog, roadmap, smoke runbook, migration runbook, security policy, brand assets
└── build.mjs    esbuild: server (ESM/node) + extension (IIFE/browser)
```

Per-file roles: [docs/architecture-map.md → File map](docs/architecture-map.md#file-map). The constraints that shape them: [CLAUDE.md](CLAUDE.md).

## Reloading the extension after a rebuild

`npm run build` does NOT update running processes. Follow
[CLAUDE.md → After every build](CLAUDE.md#after-every-build) for the affected components:

- Extension code change → `npm run reload` (the extension reloads itself from disk), or click ↻ on the card in `chrome://extensions`.
- MCP server code or tool-description change → restart the host's stdio MCP server from the fresh build and reload its tool catalog; verify `health.serverVersion` and the changed descriptions. A broker restart cannot refresh them.
- Broker code change → coordinate `npm run kill-broker`; existing servers reconnect and auto-spawn the new broker. Shared dependency changes require refreshing each affected component.
- **Manifest permission change** (e.g. host_permissions) → ↻ often does NOT apply it; **remove + Load unpacked** again. New `optional_permissions` and `commands` take effect after ↻.
- Confirm the running extension via `tabs_context_mcp` → its `version` field reports the live manifest version. If it doesn't match, the wrong build is loaded (check you re-added from `extension/`, not a stale copy elsewhere).

## Adding a tool

Four edits (tool-name list, handler, dispatch case, Zod registration) — see [CLAUDE.md → Adding an extension-dispatched tool](CLAUDE.md#adding-an-extension-dispatched-tool-four-edits-one-test). Roadmap and deferred items: [docs/project-roadmap.md](docs/project-roadmap.md).
