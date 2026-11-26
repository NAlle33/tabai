# Daily assistant

The control panel opens on the daily assistant: one chat for mail, meetings, the day's
overview, web lookups, watches and routines. This page lists the topic guides and the
records the assistant keeps; the guides hold the details.

## Guides

- [Panel and chat](assistant-panel-and-chat.md): the header, composer and quick choices, the
  settings pages and appearance, page sharing, the context menu and shortcut, attachments,
  conversations, private memory and action cards.
- [Mail](assistant-mail.md): Mejl, mail accounts and how they are read, the mail check
  including opened mail without a reply, learned preparation methods, the account self-test, cases, continuation and
  preferences, the morning overview and notifications, and replies.
- [Web access](assistant-web-access.md): optional full Tabai browser access, the guided web levels, approval
  cards and their image, isolated checks, receipts, Mina uppgifter, Kolla upp avsändaren,
  Hitta billigast, login, tabs and web access in mail tasks.
- [Watches and routines](assistant-watches-and-routines.md): watches, their history and trend,
  automatic pause and capacity, and routines on the shared schedule.
- [Models](assistant-models.md): the chat and task models, Codex, Claude, Berget.ai, local
  inference with Ollama, and connection status.
- [Model trial](model-trial.md): `npm run trial` gives every backend on this computer the same
  assistant tasks and reports pass or fail per backend and task.

The executable task/result contract is [shared/assistant.ts](../shared/assistant.ts),
with the main UI in [assistant-panel.ts](../extension/src/assistant-panel.ts).

## Private local records

The broker's local configuration directory owns the `assistant/` subdirectory.
Account settings, concise source quotes, edited drafts, decisions and task history
are stored there, outside the checkout and extension. The store maintains a prior
snapshot before replacement. It is separate from personal invoice-module records
and the shared recipe/run-history store.

Conversations, reusable memory and their rollback copies are private local
records too. Connection-probe history and the Berget budget ledger are also
private files; the ledger retains uncertain reservations instead of rolling them
back, for the months its [budget](assistant-models.md#bergetai) keeps. An unreadable
probe history is moved aside intact, with an `.unreadable` suffix, at the next
connection test, which starts a new history. The Berget key
is stored separately at `~/.claude-chrome-mcp/assistant/berget-api-key` by default
(under the configured assistant data directory when overridden). POSIX directories
and files use owner-only permissions; on Windows the user profile's ACL applies.
Symlinks are refused. The key is excluded from workspace JSON, chat, exports, command
arguments and logs, and is not forwarded to the MCP worker. These are private files,
not encrypted storage. Keep any custom data directory outside the checkout.

Opt-in [mail preparation methods](assistant-mail.md#learned-preparation-methods)
use the same private backed-up store mechanism in `assistant/mail-methods.json`.
Only typed steps, account fingerprints, versions and aggregate measurements are
recorded there; mail text, credentials, page URLs and browser references are excluded.

Unfinished scan journals are stored in the same private directory. A journal is
removed once no saved run can continue it; worker directories that a stopped process
left behind are removed at the next start once they are an hour old. Mail-provider passwords,
browser cookies and provider login tokens are not panel settings; authentication
continues through the existing browser and Codex installation. Local inference
stores only which model you chose (in the settings) and which self-tests passed
(model, digest, Ollama version, time) in `local-models.json` beside the workspace;
runtime and download status are kept in memory and re-read from Ollama after a
restart. A Tabai build without a selected backend refuses a workspace whose saved
backend it does not know rather than run it on Codex; choose Codex in the panel before
building or loading such a version, for example another branch. The mail items'
schema is strict, and builds that predate its optional `sendLocked`, `pendingFinding`
and `autoAttempt` fields refuse a stored item that has them. Before running such a
build, stop the broker and remove these fields from every item in
`assistant/workspace.json` and in each `assistant/archive/<id>.json`, including
their `.bak` copies. These private files
are not an encrypted vault. Publishing the source requires a separate review of
Git history, documentation, screenshots and locally installed private modules;
a clean source scan alone is not a public-release clearance.

Large result sets are paged in the panel. Completed points can move into the
private archive; unresolved and uncertain work is retained. When active capacity
is reached, a check reports partial coverage instead of silently discarding work.

No personal accounts are shipped in the source. A fresh panel contains onboarding,
not a configured mailbox. Keep this directory private when sharing diagnostics;
ephemeral CLI sessions do not make the saved local evidence public. Refresh the
extension and idle broker after a build using the existing
[build/reload procedure](../CLAUDE.md#after-every-build). A running installation
keeps its old bundles until then. When a build changes the broker, the MCP server
and the extension, refresh them in this order: stop the broker with
`npm run kill-broker`, which stops the assistant with it, and the broker the MCP
servers spawn again starts the assistant from the new build; then have the MCP host
restart its server; then reload the extension. The broker and the assistant must be
refreshed together: the broker checks every assistant view against the strict item
schema of its own build, so a broker from an older build refuses the views of a newer
assistant.
