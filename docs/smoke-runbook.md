# Smoke Runbook — what CI can't verify

The GitHub Actions [`live` job](../.github/workflows/ci.yml) runs the full
`test/e2e-live.mjs` suite through `npm run test:ci` headless on Ubuntu, in a fresh Chromium
at **devicePixelRatio = 1** with **synthetic fixtures**. A few
things only show up on **your real machine / real sites**:

| Can't be CI-verified | Why | Covered in |
|---|---|---|
| **Coordinate** landing on a scaled display | The current path uses synthetic CSS-pixel events; the host's scaling/zoom is outside the default CI environment | Part A (automated) |
| Real **cross-origin** embeds (payment/login widgets) | CI uses a same-origin sub-frame as a stand-in | Part B |
| **Auth-gated** real sites (bookkeeping, payments, webmail) | needs your logged-in session | Part B |
| CDP **file_upload** against a site's real input | CI uses an injected input | Part B |

The isolated launcher enables `CDPScreenshotNewSurface`, available in its pinned
Chromium, to avoid waiting for hidden-frame presentation during capture. This
does not configure everyday Chrome. Unflagged Linux Chromium 148 can still delay
background captures by tens of seconds; see the [upstream capture path](https://chromium.googlesource.com/chromium/src/+/refs/tags/148.0.7778.96/content/browser/renderer_host/render_widget_host_impl.cc#2174).
Headless runs on macOS leave the feature off: there the copied frame of a background tab is
never presented, so a page that loaded in that tab publishes no first-contentful-paint and
the keyboard paint guard refuses input. The default capture waits for a presented frame and
paints the page. Tab activation, native input assertions and test deadlines remain unchanged.

Ref-based clicks, fills, shadow-DOM, waits, screenshots and recipes have automated coverage in
[e2e-live.mjs](../test/e2e-live.mjs).
Native Enter submission and typing in inactive tabs, concurrent keyboard input
from two sessions, and cross-session keyboard refusals are covered by
[keyboard-live.mjs](../test/keyboard-live.mjs), also run by `test:ci`. It verifies
the submitted value, trusted events, one submission and unchanged tab activation.

[visual-presence-live.mjs](../test/visual-presence-live.mjs) checks the readable green
group, CSP-safe logo, click-through, concurrent activity, reduced motion, capture pixels,
popup preference and lifecycle. To save the actual working appearance and numbered
capture fixtures, run `npm run test:ci -- --artifact-dir plans/visual-check`.

---

## Part A — automated display/DPR smoke

By default this runs against **your everyday Chrome** on the real display.

### Prerequisites
1. `npm run build`
2. In your main Chrome, make sure the extension is loaded **and reloaded to the
   current version**: `npm run reload`, or open the popup → **Reload extension**. (If
   the card shows an old version with no Reload button, remove it and **Load unpacked**
   from `C:\path\to\tabai\extension`.)
3. Follow [CLAUDE.md → After every build](../CLAUDE.md#after-every-build) for any
   server, broker or shared dependency changes. The automated smoke starts its own MCP
   server; manual checks through an existing MCP host also need its server/catalog refreshed.
   `npm run doctor` flags a stray process squatting 9223/9225.

### Run
```powershell
node test/smoke-real-chrome.mjs
```
A window opens in **your** Chrome and runs one decisive test.

To verify a fresh build without reloading the shared everyday extension, leave
`CCMCP_HEADLESS` unset and run the isolated harness on the actual display:

```powershell
npm run test:ci -- --display-smoke
```

This uses its own headed Chromium, profile and ports 9224/9226. The optional
display mode runs only the display smoke, requires measured `devicePixelRatio > 1`
without emulation, checks the coordinate click and closes its own tab/client.
The harness then closes its browser/broker and restores the normal dev build.
Run the normal full live suite separately. Its layout assertions also run when
`--artifact-dir` is absent; only PNG export is optional.

### Read the verdict
- `devicePixelRatio` and approx zoom are printed first.
- **"✓ coordinate click LANDED"** → the synthetic coordinate path reached the button on your
  display. This does not establish trusted input or screenshot pixel alignment.
- **"✗ coordinate click MISSED"** → save the printed `devicePixelRatio`/zoom, arguments and
  response for diagnosis. A miss alone does not establish a CDP coordinate bug.

> Default clicks use synthetic CSS-pixel events. This older smoke tests synthetic
> landing. For trusted input on the real display, run the dedicated check below.

### Trusted pointer check on the actual display

After building and reloading the extension, enable **Tillåt att agenter tar fram
Chrome** in the popup for this explicit foreground test, then run:

```powershell
node test/browser-pointer-live.mjs
```

This starts fresh MCP processes against the existing default-port broker. Its own
local fixture listens on 9237, and only its own sessions/tabs are closed afterwards.
It explicitly focuses its fixture for native input, verifies trusted-event-only
controls and a native checkbox, prints the real `devicePixelRatio`, and checks one
effect at the requested CSS point. It does not emulate or alter the real display's
scale. The CI harness runs the same suite with emulated DPR 1/2 on isolated ports; its
general live suite also checks the CSS-pixel screenshot at an emulated device scale factor of 2.
The harness cannot verify a real extension reload end to end: its Chromium keeps an extension
that reloaded itself switched off, so CI proves the reconnection by dropping the extension's
broker connection instead and prints the checks after a real reload as skipped. Verify a real
reload in your everyday Chrome with `npm run reload`.
Neither test proves that every real-site widget or child frame accepts the input.
Turn the setting off afterwards to keep agents in the background. The isolated CI
harness grants permission only inside its disposable browser and restores it on cleanup.

---

## Part B — manual real-site checklist

Drive these with an agent (Claude Code with the MCP server registered) against
your real Chrome, OR step through them yourself. Tick each.

### B1. Real cross-origin iframe (the genuine version of the CI sub-frame test)
- [ ] Open a page with a **cross-origin embed** (e.g. a site with an embedded
      YouTube player, a Stripe/checkout iframe, or a Google reCAPTCHA-less
      login widget).
- [ ] `read_page` → confirm you see refs tagged `ref_N@<frameId>` belonging to
      the embedded origin (not just the top page).
- [ ] `find` something inside the embed → click it → confirm it reacts.
- Expected: the embed's elements are listed with `@frameId` and are clickable.
- If empty: the embed may block extension injection (rare) — note the site.

### B2. CDP file_upload on a real input
- [ ] Go to a page with a real `<input type=file>` (e.g. a receipt upload in a
      bookkeeping app, or any "attach file" form).
- [ ] `find` the file input → `file_upload` with a local path (e.g. a PDF/PNG).
- [ ] Confirm the site shows the file as attached.
- Use a **main-frame** input for this check. CDP lookup can reach accessible same-origin
      subframes, but cross-origin sub-frame file inputs remain a known gap.

### B3. Your actual target sites (Radix/SPA reality check)
Pick 1–2 flows you actually run. Suggested:
- [ ] **Bookkeeping app (Radix-style SPA)**: open a form → `read_page` → `form_input`/
      `select_option` a couple fields → confirm values stick (Radix dropdowns
      are the stress test for `select_option`; if a custom dropdown doesn't take,
      use `wait_for` + `computer` click on the option).
- [ ] **Payments / webmail**: navigate a list → `find` an item → click → confirm
      the SPA route settles (navigate waits for network-idle).
- [ ] A **recipe**: `recipe_save` one of the above flows → `recipe_run` it on a
      fresh tab → confirm it replays.
- Expected: forms fill, dropdowns select, SPA navigations settle, recipe replays.
- If a custom dropdown fails: that's the known `select_option` best-effort limit
      → note the site so it can be special-cased.

### B4. Repeatable GitHub workflow measurement

With the current extension connected in your everyday Chrome, run:

```powershell
node test/github-workflows-smoke.mjs plans/reports/github-workflows.json 3
```

The [script](../test/github-workflows-smoke.mjs) runs three read-only workflows:
the Tabai repository's PR search, GitHub's advanced search form with repository
and state filters, and a saved PR-search recipe. Each must find the expected
title and canonical link for `NAlle33/tabai#7` with the expected query. Advanced
search explicitly selects the Pull requests result category after submission.

The script creates its own MCP session; each attempt starts in a fresh inactive
tab. It closes its tabs and server and removes its temporary recipe store; existing
saved recipes are untouched. It uses the checked-in
[recipe definition](../test/fixtures/github-pr-search-recipe.json). That recipe
accepts a typed query parameter and resolves the unique search field before each
field/click action. Each target is bound to its current document; field-value and
result checks verify the outcome. It does not need to activate the target tab.

The JSON report records every attempt, outcome, elapsed milliseconds, MCP call
count and manual interventions. Recipe steps are counted separately from the
outer MCP calls. Timing includes the workflow and outcome checks, excluding
session/tab setup and cleanup. The script has no automatic retries or manual
recovery; failure exits nonzero. The final argument controls repetitions per
workflow (default 3, maximum 10). Results depend on GitHub, browser version,
login state and network conditions, so this smoke is intentionally outside CI.

### B5 — numbered screenshot inspection

The isolated live suite checks main-frame target labels, mapping-to-click behavior,
PNG pixels, viewport dimensions and DPR 1/2. To retain its synthetic fixture images
for visual inspection, pass an artifact directory:

```powershell
npm run test:ci -- --artifact-dir plans/reports/perception-images
```

`perception-marked-dpr-1.png` and `perception-marked-dpr-2.png` should show legible
numbers on the corresponding controls. Child-frame controls are explicitly excluded
from visual labels. Real site captures can be checked with `screenshot_marked`;
its PNG and returned CSS rectangles must describe the same viewport. A moving page
may be rejected with a layout-change error; wait for it to settle before a new read.

---

### B6. Real mail learning and reuse

Use an explicitly authorized existing account and its selected task model. Finish
CI and restore the default build, then refresh the extension/broker using
[CLAUDE.md](../CLAUDE.md#after-every-build). Keep automatic acknowledgements off
for a read-only pilot. Run **Kör nu och lär in**, then an ordinary mail check for
the same account. Require full coverage and a verified saved method, followed by
an actual method-mode preparation report. A partial run, a help request or an
external-effect fence is not successful learning. Preserve existing schedules;
only establish the requested new routine after the pilot succeeds.

If automating Tabai's panel through Chrome DevTools MCP, its launch arguments
need `--categoryExtensions` and Chrome's normal connection approval. Enable this
capability only with the user's permission. Codex launch arguments are configured
in `~/.codex/config.toml` ([MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).
This flag is for the operator's panel automation, not a requirement for ordinary
Tabai mail checks. Drive the existing trusted extension panel and its module
route; do not start a second controller against the live workspace store.

Keep mailbox contents and raw workspace evidence outside Git. Record only
aggregate coverage, preparation calls/time and whether a real method was used.
Different mail volume, saved thread reviews, warm-up and a single pair of runs
cannot establish a general time or cost saving. See
[learned preparation methods](assistant-mail.md#learned-preparation-methods).

## If something fails
- Capture: the tool call + args, the result/error text, and a `computer`
  screenshot.
- For coordinate-click misses: include `devicePixelRatio` + zoom from Part A.
- File it with those details; the fix should come with a regression check (CI
  where possible, or an extension of this runbook where it is display/site-dependent).

## Notes
- This runbook is for the **display/site-dependent** gaps only. Everything else
  lives in the CI harness — if you change tool logic, run `npm run test:ci`
  first; only come here for the four rows in the table above.
- CI uses dedicated ports (9224 extension / 9226 clients) and won't collide with
  your main-Chrome extension on 9223. This runbook intentionally uses the default
  ports (your real Chrome + the shared broker).
