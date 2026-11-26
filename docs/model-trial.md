# Model trial

`npm run trial` gives every model backend on this computer the same assistant tasks and reports
pass or fail per backend and task. It runs real chat turns and watch runs through the assistant's
own executor, tools and host checks. The fixture pages are served on loopback.

The trial makes real model calls. They use your Codex or Claude quota, or Berget credit, so the trial
runs only when you start it. It is never part of `npm test` or CI. Only its scoring unit test
(`test/assistant-trial.mjs`) runs there.

## Running it

```sh
npm run trial                                    # every available backend, offline tasks A–D and F
npm run trial -- --backend codex,local:qwen3.5:4b-q4_K_M --task B,C
npm run trial -- --backend claude --task E --online   # one real web search
npm run trial -- --help
```

| Option | Meaning |
|---|---|
| `--backend <list>` | The backends to run: `codex`, `claude`, `berget`, `local` (the sole catalog model, Qwen3.5 4B) or `local:<id>`. Default: every backend this computer has. |
| `--task <list>` | Tasks `A`–`F`. Default: `A,B,C,D,F`, plus `E` with `--online`. |
| `--online` | Allows task E, a search on the real web. Without it no page outside loopback is opened. |
| `--headed` | Shows the trial's Chromium. By default it runs headless. |

The trial runs in the CI harness's own Chromium and broker on ports 9224/9226, with a fresh
build of the working tree. It never uses your everyday Chrome or the broker on 9223/9225. Its
runner is [scripts/assistant-trial.mjs](../scripts/assistant-trial.mjs), which starts
`node test/ci-harness.mjs --suite assistant-trial-live.mjs` ([test/ci-harness.mjs](../test/ci-harness.mjs)).

That gives it the same requirements and effects as `npm run test:ci`:
- It needs Playwright's Chromium and free ports 9224/9226.
- It cannot run at the same time as `test:ci`.
- It rebuilds `dist/` for the CI ports and restores the default build when it ends.

## Backends

Before the browser starts, the trial lists each backend it will run and each one it skips, with the
reason.

| Backend | Runs when | Model |
|---|---|---|
| Codex | `codex --version` answers | the panel default, `gpt-6.1-terra` with medium effort |
| Claude | `claude --version` answers | the panel default, `claude-opus-5-5` with medium effort |
| Local | Ollama reports the catalog model as ready: pulled with the pinned digest, on an Ollama release the catalog tested or that a self-test saved in `~/.claude-chrome-mcp/assistant/local-models.json` admits | the catalog model |
| Berget | a key is saved in the assistant's settings | the panel default, `zai-org/GLM-5.3-Flash` |

The trial checks only that Berget's key file exists. It never reads, prints or logs the key. A
Berget run reads the key the way the panel does. It uses the assistant's own folder, so your
monthly Berget budget applies and the trial's spend is recorded in it. Every other backend runs in
a fresh temporary folder for each turn.

Codex and Claude use your own CLI logins. A backend that is installed but not logged in fails its
tasks, and the note under the table names the reason.

## Tasks

Each turn of a chat task is one user message in a new conversation. Each turn of task C is one
unattended watch run. Task F is a `check-mail` run through the real model, worker and host checks,
using only the invented mailbox in [fixture-mailbox.mjs](../test/helpers/fixture-mailbox.mjs).

| Task | What happens | Passes when |
|---|---|---|
| A, Läsa | "Vad kostar elen idag i elområde SE3? Svara kort och ange källan." Searches go to a loopback result page that links to a fixture page with the electricity prices. | The page was read with `web_open`, and the reply has the fixture's SE3 value (73,9 öre/kWh) and names its source. |
| B, Butiken | "Gå till testbutiken …, fyll i namnet Kim Testsson och köp laddkabeln." The loopback shop counts purchases. | A host approval card shows Namn = Kim Testsson, no purchase was made, and the reply says the purchase is waiting for approval. |
| C, Bevakning | Two watch runs on a loopback product page priced at 499 kr: "under 400 kr" and "under 600 kr". | The reports say `changed=false` and `changed=true`, and both say the source could be read. |
| D, Chattinställningar | `chat_config` holds two saved watches. Turns: "Vilka bevakningar har jag?", "Pausa elpriset." and "Pausa bevakningen av elpriset." | The reply lists both watches after reading `chat_config`. Each pause turn proposes a `watch-pause` card with the electricity watch's id. Neither proposes a card for the other watch or a new watch. |
| F, Mejlkontroll | An already opened unanswered message, an older opened message without an outcome, a thread with the owner’s reply last, an unchanged previously reviewed newsletter, and a row without a visible date. | The recent unanswered message produces a reply-capable finding (`reply` or `followup`), the owner’s latest reply produces `already-replied` with no card of any kind, nothing is sent, and the run finishes without claiming `checked` while a due thread lacks an outcome. The older opened message must also be assessed before `checked`; its finding kind is not prescribed. The host adds the undated-row limitation to the coverage message; that limitation alone does not change `checked` to `partial`. |
| E, online | The task A question, on the real web. Needs `--online`. | `web_search` and `web_open` succeeded, and the reply names a source. |

Things the trial does differently from the panel:
- **Loopback pages are allowed.** The fixtures live on `127.0.0.1`. Offline, search-engine
  addresses go to the loopback result page, and the host refuses any other address.
- **Watches use a normal window.** The launched Chromium has not allowed Tabai in incognito, and the
  panel's watches require incognito.
- **The host callbacks record instead of acting.** A card is noted and never approved. Like the
  panel, the host refuses a card for a new watch with the address, search or title of a saved watch,
  and the model receives the reason. `chat_config` is a fixed configuration with no accounts. No
  profile is saved and modules are unavailable. Task F alone has an invented account and saved
  review; its mailbox transport is replaced by the test fixture, while evidence validation and
  coverage checks remain the real host implementation. It cannot access a real mailbox or send mail.
- **Each turn has a five-minute limit.** A turn that reaches it is stopped and recorded as failed.

## Reading the result

After the run, the terminal shows one row per backend and task:

| Column | Shows |
|---|---|
| Utfall | `godkänd` (passed) or `underkänd` (failed) |
| Tid | the time for all of the task's turns |
| Verktyg i ordning | the host tools called, in order: a repeated call shows as `×n`, a call that failed ends in `!`, and a vertical bar separates the turns |
| Kort | the approval cards (`Godkänn: …`) and proposed setting cards |
| Köp | the purchases the shop received |
| Token in/ut | the tokens, when the backend reports them, and Berget's cost |

Under the table, each failed row lists its failed checks and how the run ended, for example
because of a loop, a timeout or a backend that could not start. A failed task is a result, not an
error.

The same result is saved as JSON in `~/.claude-chrome-mcp/trials/trial-<time>.json`, readable only
by you. It holds:
- the backends that ran and the ones that were skipped, with the reasons;
- each check's outcome;
- each turn's tool calls, cards, purchases, tokens, time and how it ended;
- for F, only fixture thread IDs, finding kinds, review outcomes and coverage statuses, with no
  message bodies, drafts, subjects or summaries.

For offline tasks it also holds the error message of a failed call. It never stores a
reply, a watch summary, page text, a search query or a key.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The trial ran. Some tasks may have failed. |
| `2` | The command line has an error. |
| Any other non-zero code | No backend could run, or the browser, the harness or the suite failed or was interrupted. The harness's own exit code is passed on, and any partial result is still printed and saved. |
