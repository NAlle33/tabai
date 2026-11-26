# Project Roadmap — Tabai

Single-user tool (single maintainer). Goal: a personal browser-automation MCP that matches Claude-in-Chrome's capability surface and is reliable for unattended/loop runs.

Scope note: built for one operator on one machine → distribution/multi-tenant/cross-device concerns are **deferred** (see bottom). Reliability + parity + resilience are the priorities.

## Phase 0 — Foundation (DONE 2026-05-31)

14 tools, 18/18 live-verified (ext 0.4.3). POC + Core + Advanced + CDP/debugger tier.
Reload friction solved via popup "Reload extension" button. Element-ref system, console + network capture, CDP screenshots, file upload and keyboard input.

## Claude-in-Chrome parity gap

Gap analysis from Phase 0 (14 tools then), measured against the 22-tool CinC surface mapped in [tool-catalog.md](tool-catalog.md). The historical ✗ rows except multi-browser have shipped (Phase 3), including opt-in trusted main-frame clicks in 0.15.

| CinC capability | Status | What it needs |
|---|---|---|
| `browser_batch` | ✗ | Sequential multi-action in one round trip; per-action permission check; stop-on-error; inline screenshots. ~half a day. |
| `upload_image` (cached image → input) | ✗ | An **image cache** (imageId → bytes) + either a temp-file write (extension can't) or drag-drop via `DataTransfer` injection (CDP `Input.dispatchDragEvent` / synthetic DataTransfer). `file_upload` already covers disk files. |
| `gif_creator` (record → animated GIF) | ✗ | Frame capture loop (reuse CDP screenshot) buffered in offscreen + a GIF encoder (`gif.js` bundled) + overlay rendering. |
| `shortcuts_list` / `shortcuts_execute` | ✗ | A recipe/workflow store (record action sequences → replay). Mirrors the recipe system of a prior private project — could port that design. |
| True accessibility tree in `read_page` | ~ | Historical gap, now covered by DOM-depth indentation, open-shadow-root traversal and separate iframe queries with frame-qualified refs. |
| Trusted **ref** clicks | ✓ main frame | `pointerMode:"browser"` dispatches trusted ref/coordinate clicks with explicit focus permission and document guards. Synthetic background clicks remain the default; child-frame trusted input is unsupported. |
| `list/select/switch_browser` (multi-browser) | ✗ (N/A solo) | Cross-device pairing needs a cloud relay. **Deferred** — single machine doesn't need it; `select_browser` could be a single-device no-op if ever wanted. |

Parity definition for this project: everything except cross-device multi-browser (N/A for one machine). Tracked in Phase 3.

## Phase 1 — CI live-harness (DONE)

Playwright launches a dedicated Chromium with the **freshly-built** unpacked extension, spawns the MCP server, and runs `e2e-live` — auto-loading every build so no manual reload is ever needed again (the single biggest dev-loop blocker this project hit).

Acceptance:
- [x] `npm run test:ci` launches Chromium with the extension, runs the full `test/e2e-live.mjs` suite, exits non-zero on any failure.
- [x] Zero manual steps — picks up the current `extension/dist` build automatically.
- [x] Isolated test browser (own user-data-dir + own ports 9224/9226), doesn't touch the main Chrome.
- [x] CDP tier (screenshot/file_upload/trusted input) works in the launched browser, or degrades to documented fallbacks.

## Phase 2 — Reliability foundation

What makes automations not flake mid-run.

### 2a — DONE (ext 0.5.0, 26/26 live)
- [x] **Auto-wait / actionability**: clicks + `form_input` + `select_option` wait until the target is present, visible, enabled, and geometrically stable (two equal rects) before acting; clear timeout error otherwise.
- [x] **`wait_for` tool**: selector / text / JS predicate / network-idle (~500ms, via the content-script in-flight counter).
- [x] **`select_option` tool**: native `<select>` by value/label; best-effort ARIA/custom (open + click matching option).

### 2b — DONE (ext 0.6.0, 30/30 live), except cross-origin iframes
- [x] **Open-shadow-root traversal and frame-qualified refs** in `read_page`/`find`. Each in-page resolver stays within its targeted frame; iframe elements are queried separately with `allFrames` and addressed as `ref_N@<frameId>`. Verified: `find` + click an element inside an open shadow root.
- [x] **Hierarchical `read_page`** — indented by DOM depth (a11y-tree-like). Counts toward Phase 3 a11y-tree too.
- [x] **Robust navigation**: `navigate` waits for network-idle by default (`waitUntil:"load"` to skip), via the content-script in-flight counter.
- [x] **Cross-origin iframes**: `read_page`/`find` inject via `allFrames`; refs are frame-qualified (`ref_N@<frameId>`); resolvers/actions target the owning frame (sub-frame clicks use the synthetic path since CDP input is main-frame-only). Verified live (`find` → `ref_1@5` → click → fired). Limitation: CDP `file_upload` cannot reach cross-origin file inputs; its sub-frame lookup only reaches accessible same-origin documents.
- [ ] **Explicit SPA pushState wait**: network-idle covers most soft-nav; an explicit history-API wait could be added if needed.

## Phase 3 — Claude-in-Chrome parity (tool completeness)

Close the parity gap. (Parity + extras shipped — current tool surface: README → Tools.)
- [x] **`browser_batch`** — sequential multi-call in one round trip, stop-on-error (server-side). Verified live.
- [x] **True a11y tree** — `read_page` now indents by DOM depth (done in 2b).
- [x] **`upload_image`** — disk image OR fresh screenshot (server writes base64 → temp PNG) → `file_upload`. Verified live.
- [x] **`shortcuts_*` / recipe system** — `recipe_save` / `recipe_list` / `recipe_run` (server-side JSON store, replay with tabId injection). Covers CinC's shortcuts_list/execute. Verified live.
- [x] **`gif_creator`** — frame-capture (CDP screenshot on a timer) → encode in the SW (OffscreenCanvas + gifenc) → server saves `.gif`. Verified live (GIF89a, 34KB).
- [x] **Trusted pointer input** — opt-in main-frame browser clicks by ref/coordinate, explicit focus, document/geometry fences and no fallback/replay. [Live tests](../test/browser-pointer-live.mjs) cover trusted events, native checkbox defaults and DPR 1/2; default-port execution verifies the actual display.

Parity **complete** (multi-browser N/A for a single machine). Plus extras beyond CinC: `wait_for`, `select_option`, `recipe_save`/`recipe_list`/`recipe_run`. Pointer verification scope is explained in [smoke-runbook.md](smoke-runbook.md).

Acceptance: met — every CinC tool except multi-browser has a local equivalent (mapping in the banner of `docs/tool-catalog.md`), within the documented main-frame pointer scope.

## Phase 4 — Resilience for unattended / loop runs

Long unattended agentic sessions (`/loop`, `/schedule`) must survive hiccups.
- [x] Bridge **queue during a brief disconnect + send on reconnect**, **at-most-once** (already-sent calls are NOT replayed → no double-execute), bounded queue, fast-fail only when never connected. (in-flight *replay* intentionally dropped — unsafe for non-idempotent tools without durable dedupe.)
- [x] **`health` tool**: bridge/extension state plus exact loaded build identities, mismatch guidance and bounded session operation timings in health and the existing panel (0.15).
- [x] **Auto-recover**: `tabs_create_mcp` re-creates a lost MCP tab group; a debugger "not attached" send failure clears stale attachment state and attempts one reattach.
- [x] Structured logging (per-call id, timing, outcome) → rotating `~/.claude-chrome-mcp/logs/` (`src/logger.ts`).

Acceptance: kill+reload the extension mid-sequence → not-yet-sent calls flush on reconnect, the already-sent call times out instead of double-running (at-most-once), and the run continues; `health` reports accurate live state.

## Phase 5 — Capability breadth for the target sites

Driven by the maintainer's actual targets: bookkeeping, payments, webmail and trading dashboards, plus the general web. These are forms-heavy Radix-UI-style SPAs, which is why Phase 2 (shadow DOM, auto-wait, select_option) matters first.
- [x] Cookie read/clear (`cookies`), download handling (`download`: arm → trigger → collect), JS-dialog handling (`dialog`: opt-in auto-handle + capture, default dismiss), region screenshot (`screenshot` clip, JPEG default + `maxWidth`).

Acceptance: a smoke recipe per primary site (login-gated reads excluded) runs green in the CI harness.

## Phase 6 — Frontier: beyond parity → best-in-class

CinC-parity is the *floor*. What separates a world-class web agent from a tool-wrapper is **perception, verification, and semantic intent** — these drive task success rate, which is the only metric that matters.

**Perception (biggest lever — page→text quality decides success):**
- **Set-of-Marks visual grounding**: screenshot with every interactive element boxed + numbered, fused with the a11y refs. SOTA web agents (WebVoyager/SoM) pick "element 7", not coordinates. Combine our `data-ccmcp-ref` with on-image labels.
- **Token-efficient ranked page encoding**: dedupe, collapse repetitive lists, prioritize visible/interactive, include position/landmark hints. Beat a raw a11y dump.
- **Page-diff after actions**: return *what changed* (added/removed/changed nodes) instead of a full re-read — cheaper + is itself a verification signal.

**Verification / self-correction (turns "dispatched" into "succeeded"):**
- **Action-outcome check** baked into every action: URL change? target appeared/disappeared? error toast? Return the observed effect.
- **Explicit escalation**: opt into browser pointer input when a control needs trusted events; observe the effect before deciding on another action. Ambiguous mutations must never be automatically replayed.
- **Stuck/loop detection**: no-progress over N actions → surface, don't spin.

**Semantic / composite tools (where world-class lives — fewer round-trips, fewer errors):**
- `extract_table` → JSON, `fill_form_from_object`, `find_row_by_content`, `click_text_and_verify`, `wait_until_text`. Intent-level, not primitive.

**Real-web hostility:**
- Cookie-consent / modal auto-dismiss (privacy-preserving), **captcha/bot-wall detection → hand to human** (never auto-solve — safety rule).
- **Anti-bot resilience is already a structural advantage**: we run as an extension in your real, logged-in Chrome (no `navigator.webdriver`, no Playwright flags) — strictly stealthier than Puppeteer/Playwright. Keep it that way (avoid detectable patterns; note the CDP debugger banner is the one tell).

**Observability / learning:**
- **Trace viewer**: per-step screenshot + action + DOM snapshot (Playwright-trace style) for debugging agent runs.
- **Per-site telemetry**: success/flake rates per tool/site → know what to harden.
- **Self-improving recipes**: record successful flows, parameterize, replay (extends the Phase 3 recipe tools).

**Agent ergonomics:**
- Structured, *recoverable* errors: not-found → return nearby candidate refs; ambiguous → return the options. The agent should never be stuck guessing.

Acceptance (the real bar): a benchmark suite of multi-step tasks on the primary target sites with a measured **task success rate**; frontier items are judged by moving that number, not by existing.

## Deferred (single-user → not worth building)

- Chrome Web Store publishing (load-unpacked + popup-reload is fine solo).
- Multi-tenant (other users) / cross-device cloud relay (multi-browser tools). Note: isolation between one user's *own* concurrent Claude Code sessions IS built (singleton broker + per-session tab groups).
- Trust/safety gates aimed at *other* users. (Action-confirmation for irreversible ops — purchase/send/delete — still has personal value; fold into Phase 5 if desired.)
- Firefox / Edge ports.

## Open questions

- Confirm primary target sites (drives Phase 5 order).
- Want action-confirmation gates for irreversible ops even solo? (default: no, you're driving.)
- Parity target — is "everything but multi-browser" the right line, or do you ever want multi-device?
