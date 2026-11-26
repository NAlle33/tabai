# Assistant models

Part of the [daily assistant](daily-assistant.md) guide. To give every backend on this
computer the same assistant tasks and compare the results, use the
[model trial](model-trial.md) (`npm run trial`).

## Agent model

**Inställningar → Modeller och anslutningar → Chatt och uppdrag** chooses separate
defaults for conversation and new tasks. **Fler val för uppdragsmodellen** on the same
page contains effort and provider-specific task options. Each role chooses where it reasons:
**Codex (moln, OpenAI)**, **Claude (moln, Anthropic)**, **Berget.ai (moln)** or **Lokal inferens på den här
datorn (Ollama, experimentell)**. Each choice applies from the next turn or task;
running work keeps its starting
backend and model. Existing settings initially apply to both roles; changing one
role preserves the other. Every
backend's choices are stored, so switching back and forth loses none of them. Workspaces saved before local inference existed (no model
setting, or the earlier Codex-only `{model, reasoningEffort}` object) are read
unchanged and mean Codex Terra/medium or the saved Codex choice.

For Codex, the section selects GPT-6.1 Terra or Sol and medium/high reasoning
effort. Terra/medium is the default for the bounded browser/mail worker; Sol/high
can be selected for more demanding interpretation. The isolated Codex CLI receives
both choices explicitly, independently of global user configuration.

For Claude, the section selects Claude Opus 5.5 (default), Claude Sonnet 5.5 or
Claude Fable 5.1, and medium (default) or high effort. Claude runs through the
Claude Code CLI on this computer with your own Claude Code login; Tabai stores no
API key, and the task and the mail text the assistant reads are sent to Anthropic.
The CLI is bound to the assistant the same way Codex is: no built-in tools, only the
assistant's MCP worker and its tools, no user, project or local settings, no hooks or
commands, no stored session, and the model and effort passed explicitly. The worker's
socket and secret are written to a file only you can read in the task's private work
directory, removed with it, and never put on a command line. Tool results stay inline:
the worker marks its tools with `anthropic/maxResultSizeChars` and the CLI's MCP limit
covers the host's largest reply, so Claude Code never saves mail text to a
`tool-results` file the model could not read. Auto-memory, the server-side advisor
and nonessential traffic are off, and the folders the CLI keeps for the task's
working directory are removed with it. Tabai checks the CLI's start event (only the
assistant's server and tools, built-in plugins only, no skills, the chosen model and
permission mode) and its event stream, and stops the task if anything else appears.
If Claude Code is not logged in, the task stops and asks you to run `claude` and log
in.

For local inference, Qwen3.5 4B is the default and the only catalogue choice. Its
Q4_K_M Ollama tag is checked against the registry digest:

| Model | Ollama tag | Licence |
| --- | --- | --- |
| Qwen3.5 4B (recommended local model) | `qwen3.5:4b-q4_K_M` | [Apache-2.0](https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE) |

Saved 2B and 9B choices are read as 4B automatically, including conversation, task
and watch settings. Existing model files stay on disk until you remove them in
Ollama. Tabai does not bundle or redistribute weights; you pull the model yourself
and the vendor's licence applies.

Local inference remains experimental. The [model trial](model-trial.md) measures
synthetic tasks on this computer; its dated reports stay in the untracked `plans/` directory.
These do not establish accuracy in every real mailbox. The host checks source
evidence and disallowed actions, but cannot ensure that the model identified every
mail that needs an answer. Review findings and coverage. Codex remains the backend
verified on real mailboxes.

### Berget.ai

Choose a Berget model for the desired role and enter your key under
**Inställningar → Modeller och anslutningar → Berget-nyckel**.
Save, replace or remove it there; never paste a key into the conversation. The panel
returns only whether a key is saved. Saving does not make a paid validation request.
Calls are billed separately by Berget, outside Codex and Claude subscriptions.

The initial choices are GLM-5.3-Flash (first task candidate), Gemma 4 31B (alternative
for conversation/tasks) and Mistral Small 3.2 (text and shorter tasks). Exact IDs and
host working budgets live in [assistant-berget.ts](../shared/assistant-berget.ts).
These are candidates based on the provider's active stable catalogue and tool support,
not measured quality recommendations. No real Berget inference or mailbox-quality
benchmark has been run without a configured user key. The runner checks availability,
lifecycle and function calling against [Berget's catalogue](https://api.berget.ai/v1/models/)
before inference. Retired, preview and unavailable models fail without a fallback.

Berget calls use only `https://api.berget.ai/v1`, with redirects and automatic retries
disabled. The serial runner reaches actions only through the existing authenticated
worker and validates a complete proposed tool group before dispatch. It preserves
unreviewed evidence and stops when its working budget is exhausted. Provider error
bodies and credentials never become panel diagnostics.

**Berget · användning och budget** shows the current UTC month, verified token
usage, estimated EUR cost, outstanding reservations and uncertain consumption.
Prices come from the official live model catalogue with a timestamp; no permanent
price table is embedded. CLI subscription costs are not invented or added here.
The ledger keeps the current and the previous UTC month; each update drops older
entries.

An optional monthly EUR limit admits new Berget requests only when the persistent
ledger has room for their conservative reservation. Each paid POST reserves before
dispatch, with cross-process locking. Missing prices, an unreadable ledger or an
insufficient limit block that request without a provider fallback. This is an
admission control based on provider prices, not a guarantee of the final invoice.
Verified usage settles a reservation. Only chat turns stream, for their reply
preview, and Berget documents no usage on a stream, so each call of a chat turn
keeps its full reservation as uncertain. Tasks, routines and watches call without
streaming, so the usage Berget reports settles each of their reservations.
Interrupted calls keep their full reservation as uncertain too; neither is ever
counted as zero. Requests already in flight are not undone by lowering the limit.

The source/account and exact-send validators apply with every backend and model.
Account self-tests do not use an AI model.

### Local inference with Ollama

1. Install Ollama from its [official download](https://ollama.com/download) and
   start the app. Tabai never installs, starts, stops or updates Ollama, and never
   changes its global settings.
2. Open **Lokala modeller** under **Inställningar → Modeller och anslutningar → Fler
   val för uppdragsmodellen**. The status shows
   whether Ollama answers on
   `127.0.0.1:11434` and its version. **Kontrollera igen** re-reads it.
3. **Hämta modellen** pulls one model at a time and shows bytes and progress.
   **Avbryt** closes Tabai's request; Ollama may keep the part it already wrote, so
   the next pull resumes. An interrupted pull is reported as not downloaded.
4. **Kör självtest** runs a harmless protocol test (a synthetic order lookup, no
   private content): three rounds of a valid tool call, the tool result and a final
   Swedish answer. A pass is recorded for that model, digest and Ollama version.
5. Choose **Lokal inferens**, the model, and save.

Before any private text reaches the model, every local task re-reads Ollama's
version, the pulled tag's digest and its details, and the digest is checked again
before each model turn. A missing or partial pull, a moved tag (different digest),
another quantization or a cloud model stops the task with an actionable message.
Each model is pinned to the Ollama release its protocol gate passed on (recorded in
the benchmark report). Any other release, for example after an Ollama
auto-update, also stops local tasks until the model's self-test passes on this
computer; Tabai then accepts that release for that model.

Local tasks use the same private worker, tool catalog, 200-call limit, 15-minute
deadline, account/source evidence checks, checkpoints, approvals and at-most-once
send as Codex. The local runner (`src/assistant-local-runner.ts`) talks to Ollama
and reaches tools only through the shared MCP worker and the host's authenticated
socket; it has no direct browser or workspace access and never runs model text as
code. Each worker request is one authenticated, bounded newline-delimited frame.
The host dispatches it once before closing its response; the client keeps the
connection open until then, so Windows named pipes need no request half-close.
A model that answers in prose, repeats a call, keeps sending invalid
arguments, runs out of context or memory, or stops responding ends the task with
an honest error; checkpoints already saved remain. **Local mode never falls back to
Codex**: only an explicitly saved backend choice changes where reasoning happens.

The local model sees a bounded working history within a 64K-token context, which
fits one complete worst-case mail read. When the history would overflow, the
navigation snapshots of older page results, and then older reads of threads already
saved with a checkpoint, are replaced by explicit identity stubs telling the model to
read again; the host still holds every observation for quoting. Unreviewed evidence
is never removed: if it does not fit, the task stops with a context error. Requests
also disable Ollama's own prompt truncation and context shifting, which would
otherwise drop text silently.

Small models lose track of identifiers and of what is still unread, so the runner
mirrors the host's own tool results (`src/assistant-local-state.ts`). Each turn ends
with a short status message: the task, open tabs, which required areas are still
unread, which read threads are not yet saved (with their `messageId`s) and one
concrete next step, such as reading a page again after a click or saving a thread. It
contains refs, identifiers and counts only, never page or mail text, and is not
stored in the history, so Ollama's prompt cache stays valid. Local models also get a
short guide to the finding kinds after the unchanged shared task prompt. A message
waiting for a reply uses a reply finding even when its subject is a meeting or a
decision. A proven own latest reply is stated in the status and its outcome is
chosen before findings. An acknowledged read is not offered as a duplicate
checkpoint; reading again permits a new assessment.

In a chat turn the status only says that the conversation context is already read.
It names no tool to answer with: as the last message of every request, a closing
"answer with chat_reply" made the small models answer before the web search or the
change card the question needed. Only after the host accepted a card does it add
that the card waits for the user and that the answer remains, because 4B otherwise
proposed the same card again. Local chat models get a short chat guide after the
unchanged shared chat policy:
- A request to pause, stop, resume or delete a saved watch or routine, even by its
  subject alone ("Pausa elpriset."), gets the matching change card through
  `chat_propose`: never a proposal in text, a claim that it is done, or a new watch.
- With web tools, a question about current facts such as today's prices is answered
  only after reading a source with `web_search` and `web_open`.

In a watch run the status asks for the source until a page's text has been read
(`web_open` or `web_read`; search results alone do not count). Then it says that the
source is read and that the report remains, so the model evaluates that source
instead of searching again for a page that meets the condition. The model trial
([docs/model-trial.md](model-trial.md)) measures these behaviours.

Models on the intent profile also get a per-turn output grammar narrowed from the
same mirror. Thread, message, source URL and observation ids can only be ones the
host returned for that thread's latest read. Quotes can only be exact lines or
sentences of the cited observation. A recipient can only be an address visible in
the cited text. `checked` coverage is offered only once the host would accept it, and
a finished run cannot report a running check. Tabs and click, search and fill refs
come from the latest read or find, and a click or search requires a new read first.
Reply, fill and send are offered only in approved-send mode, fill only into the
message-body field, send only after the exact approved body was filled, and never
again after a failed send. When the mirror cannot tell, for example on a page whose
refs it cannot parse, or when the narrowed grammar would exceed 300 KB, the tool's own
schema applies. The mirror never fills in a value for the model, and the host
validates every call exactly as before. Qwen3.5 4B uses the intent profile in normal
runs. Native-profile tool definitions remain available to the protocol benchmark,
which can measure both profiles on 4B.

**Stop** aborts the open inference request and terminates the runner and its
worker. Ollama may finish computing in the background; no new tool call or late
result is accepted, and an already dispatched send stays uncertain. Ollama keeps a
model loaded for a few minutes after use and manages that cache itself, because it
may serve other local programs. **Ladda ur från minnet** is the explicit way to free
that memory; model files remain until you remove them in Ollama.

To stop using local inference, choose **Codex (moln, OpenAI)** and save; nothing else is
discarded. A panel that has not been reloaded since the update can still save other
settings; it never switches a saved local choice back to Codex. Saving Codex with the default local model stores the setting in the
earlier format, so an older Tabai build can still read the workspace. Choose Codex
in this build before running an older build: an older build refuses (and leaves
untouched) a workspace whose saved choice is local inference.

These choices apply only to Tabai's workers. They do not change the user's global
Codex or Claude Code defaults or the model of an already running session. The
separately installed private module also explicitly pins its own worker model.

## A different model for one continuation

**Fortsätt med annan modell** on an eligible chat answer or unfinished mail check
selects a backend/model for that continuation only. The chooser explains where
the context is sent; the selected model appears on the new answer/check. It does
not save a new chat or task default. Missing provider credentials or an unavailable
local model produce an error with no automatic provider fallback.

Chat continuation preserves conversation context and sent-file access, with
read-only tools and no replay of earlier actions. Mail continuation preserves its
scan origin, completed accounts and thread checkpoints; the explicit choice also
survives a restart of that continuation. Sends cannot be continued this way. Checks with a possible external full-access effect are also locked against continuation/question replay; older checks without an effect record cannot change models mid-scan.
See [chat](assistant-panel-and-chat.md) and
[mail continuation](assistant-mail.md#progress-continuation-and-preferences).

## Connection status

**Inställningar → Modeller och anslutningar → Anslutningar** distinguishes a saved configuration from a tested
connection. The connection buttons inspect CLI authentication status, local runtime
metadata or the public provider catalogue. They do not run inference, start tasks
or change settings. The Berget button checks the public model catalogue without
inference or a paid
completion. Its timestamp verifies catalogue availability; a saved key remains
unverified by that check. Changed model/runtime identities invalidate the relevant
probe; the public catalogue check is bound to its selected model. Mail rows use the
existing deterministic account self-test rather than an AI call. A successful connection is not a mailbox-quality assessment.
