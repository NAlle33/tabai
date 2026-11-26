# Tabai migration runbook

Tabai is the product name adopted in September 2026 for the server, extension and repository
previously published as `claude-chrome-mcp`. This runbook records what changed, what stays the
same, and the exact steps to rename the GitHub repository and move an existing local checkout
without losing MCP registrations, saved settings or the browser security posture.

The rename ships without a version or protocol bump: a client that already runs 0.9.1 talks to
a Tabai 0.9.1 build unchanged.

## What changed and what stays the same

| Surface | Before | After |
|---|---|---|
| Product, extension card, toolbar title, popup | `claude-chrome-mcp bridge` | **Tabai** with the tab/bridge mark ([extension/icons](../extension/icons)) |
| MCP `initialize` server name | `claude-chrome-mcp` | `tabai` |
| npm package name (private, unpublished) | `claude-chrome-mcp` | `tabai` |
| Executables (`bin`) | `claude-chrome-mcp` | `tabai` **and** `claude-chrome-mcp`, same entry |
| Claude Code registration, fresh install | `claude-chrome` | `tabai` (`mcp__tabai__*`) |
| Claude Code registration, existing install | `claude-chrome` | **unchanged** (`mcp__claude-chrome__*`) |
| Codex registration, existing install | `claude-chrome` | **unchanged by default**; an explicit rename can opt into `tabai` below |
| Data directory (recipes, PDFs, GIFs, logs, token, pin, backups) | `~/.claude-chrome-mcp` | **unchanged** |
| Environment variables | `CCMCP_*`, `BRIDGE_TOKEN` | **unchanged** |
| Ports, protocol version, tool names, storage keys, `MCP·<sid4>` group titles | | **unchanged** |
| Extension ID | derived from the unpacked path | **unchanged while the path is unchanged** (see below) |
| GitHub repository | `NAlle33/claude-chrome-mcp` | `NAlle33/tabai` (Part 1) |
| Canonical checkout (maintainer) | `~/claude-chrome-mcp` | `~/tabai` (Part 2) |

An already-loaded extension keeps showing the old card name and no icon until it is reloaded
from disk (`npm run reload`, or ↻ on the card): the manifest changed, the permissions did not,
so a reload is enough and no remove-and-re-add is needed.

Claude Code registration policy for both names lives in [scripts/mcp-registration.mjs](../scripts/mcp-registration.mjs)
and is exercised by [test/mcp-registration.mjs](../test/mcp-registration.mjs). `npm run register`
never removes or overwrites an entry that points at another checkout unless you pass
`-- --name <name>`, and it backs up any entry it replaces to `~/.claude-chrome-mcp/backups/`.

## Explicit Codex registration rename

A user can explicitly choose `tabai` instead of the preserved `claude-chrome`
registration. This changes Codex's tool prefix to `mcp__tabai__*`; it does not
rename the executable aliases, private stores, environment variables or the
separate Claude Code registration. Chrome's existing unpacked extension only
needs a reload when its manifest permissions and path have not changed.

Read the old entry with `codex mcp get claude-chrome --json`. Back up the user
config and entry privately with mode `0600` in a `0700` backup directory. Add
`tabai` with the same command, arguments and any environment/policy fields; verify
the replacement before running `codex mcp remove claude-chrome`.
`npm run register` configures Claude Code and is not the Codex installer.

Reload the extension with `npm run reload`. At an idle boundary, verify ownership
of both broker ports before `npm run kill-broker`; existing clients spawn the
fresh broker. Codex's running app-server supports `config/mcpServer/reload`, which
reads disk configuration and queues refreshes for loaded threads. Its Unix
control socket uses a WebSocket HTTP Upgrade, not raw JSONL; discover the socket
through `codex app-server daemon version`. See the
[official app-server protocol](https://learn.chatgpt.com/docs/app-server).

Verify the new prefix in the actual session, discover its tool catalog and call
`health`: server, broker and extension build IDs must match, with `refresh: []`.
Use an owned HTTP test page for navigate/read/close verification. A refresh error
for a legacy loaded thread does not prove that every thread failed; inspect the
target thread's actual catalog and health. Stale inactive threads may need to be
reopened; do not overwrite their separate tool-policy choices merely to clear a
global refresh error.

## Prerequisites (both parts)

- The Tabai branding change is merged on `main` with green CI, and your checkout is on that
  commit (`git status` clean apart from local, untracked work you intend to carry).
- `gh auth status` shows the repository owner with admin access. `NAlle33/tabai` is not taken.
- No in-flight tool call, active `download` or `gif_creator` recording in any session.
- Claude Code is **closed** for the registration step (a running session rewrites `~/.claude.json`
  on exit). Codex sessions using the server are idle.
- Old MCP server processes started before the move are left alone: they captured their broker
  path at startup and are outside this runbook's scope.

## Part 1 — Rename the GitHub repository

Executed on 2026-09-08: the repository is `https://github.com/NAlle33/tabai` (immutable id
`R_kgDOSzNumw`, `main` at `72eb078` before and after), and `NAlle33/claude-chrome-mcp` redirects.
The steps stay here as the record of the procedure and for a rollback.

GitHub keeps the repository's identity, history, branches, issues and PRs across a rename, and
redirects ordinary web and Git traffic from the old name. Pages sites and actions hosted **by**
the renamed repository are the documented exceptions; this repository has neither.

1. Record the pre-rename facts: immutable ID, `main` SHA, privacy, open PRs.
   ```sh
   gh repo view NAlle33/claude-chrome-mcp --json id,nameWithOwner,isPrivate,defaultBranchRef,url
   gh pr list -R NAlle33/claude-chrome-mcp --state open
   git -C ~/claude-chrome-mcp rev-parse main
   ```
2. Confirm the destination is free (expect HTTP 404) and that no consumer depends on the old
   name outside redirect coverage (no Pages, no `uses: NAlle33/claude-chrome-mcp/...` in workflows).
   ```sh
   gh api repos/NAlle33/tabai
   ```
3. Rename. The owner and visibility are preserved; nothing is created or transferred.
   ```sh
   gh repo rename tabai -R NAlle33/claude-chrome-mcp --yes
   ```
4. Read back and compare with step 1: same immutable ID, same `main` SHA, still private, and the
   old name redirects to the new one.
   ```sh
   gh repo view NAlle33/tabai --json id,nameWithOwner,isPrivate,defaultBranchRef,url
   gh api repos/NAlle33/claude-chrome-mcp --jq .full_name     # → NAlle33/tabai
   ```
5. Point the local checkout at the canonical URL and verify the remote still agrees with local `main`.
   ```sh
   git remote set-url origin https://github.com/NAlle33/tabai.git
   git fetch origin && git status -sb
   ```
6. Update any canonical link that names the repository (this runbook and the architecture map;
   the README carries no clone URL) in a follow-up PR. Historical plans and reports keep their
   old, redirected URLs.

**Rollback:** while the old name is still free, `gh repo rename claude-chrome-mcp -R NAlle33/tabai --yes`,
then restore `origin` and re-run step 4 against the old name.

## Part 2 — Move the local checkout and re-point the clients

Executed on 2026-09-08 for the maintainer's checkout: the canonical directory is now `~/tabai`,
both existing `claude-chrome` registrations launch from it, and Chrome loads the extension from
`~/tabai/extension` under a new unpacked ID, exactly as this part predicts. The steps stay here
as the procedure for any other machine and as the rollback.

A same-parent rename preserves Git history, tracked and untracked files and permissions. Three
references live outside the directory and must be updated separately: the Claude Code entry, the
Codex entry, and Chrome's unpacked-extension path.

**Chrome identity.** The manifest has no `key`, so Chrome derives the extension ID from the
unpacked path. Loading the extension from the new directory normally yields a **new ID** and a
fresh `chrome.storage` namespace: the saved bridge URL/token are not carried over, and an
extension-ID pin written for the old ID rejects the new one until it is replaced. A symlink at
the old path is not identity proof; Chrome resolves it. Session ownership (`mcpGroups`),
cached status, download and recording state are session data, never copied.

### 2a. Backup checklist (private, outside the repository)

Keep backups in a `0700` directory with `0600` files, and never paste their contents into a
report. Note only key names and whether a restore matched.

- Claude Code entry (fields included, secrets not printed by this command):
  ```sh
  mkdir -p -m 700 ~/.claude-chrome-mcp/backups
  node -e 'const j=require(require("os").homedir()+"/.claude.json");process.stdout.write(JSON.stringify(j.mcpServers["claude-chrome"],null,2)+"\n")' > ~/.claude-chrome-mcp/backups/claude-mcp-claude-chrome-pre-move.json
  chmod 600 ~/.claude-chrome-mcp/backups/claude-mcp-claude-chrome-pre-move.json
  ```
- Codex entry: copy `~/.codex/config.toml` next to it with the same permissions.
- Extension settings: open the popup and note the **Bridge URL** and whether a **Token** is set
  (copy the token privately only if it is set). Note the **id** line: that is the current ID.
- Pin: copy `~/.claude-chrome-mcp/extension-id` if it exists; note its absence otherwise.
- Chrome-managed choices on the extension card (site access, incognito, file URLs): they are
  browser settings, not extension storage. Note them so they can be restored without widening.

### 2b. Steps

1. Reach an idle boundary: no in-flight calls, stop any `npm run dev`/test processes you own,
   close Claude Code. On the extension card, **disable** (do not remove) the old copy.
2. Move only if the destination is absent:
   ```sh
   [ -e ~/tabai ] && echo "destination exists" || mv ~/claude-chrome-mcp ~/tabai
   cd ~/tabai && npm run build
   ```
   An optional `ln -s ~/tabai ~/claude-chrome-mcp` keeps excluded old processes working through
   the old path. Record it if you create it; it proves nothing about clients or Chrome identity.
3. Re-point Claude Code with Claude Code closed. The script keeps the `claude-chrome` name, prefix
   and every stored field, backs the entry up and restores it if the update fails:
   ```sh
   npm run register
   npm run doctor          # expect: registered as 'claude-chrome' … for this checkout
   ```
4. Re-point Codex. The existing entry launches `npm --silent --prefix <checkout> start`; recreate
   it with the new checkout path, passing any `--env KEY=VALUE` the old entry carried:
   ```sh
   codex mcp get claude-chrome
   codex mcp remove claude-chrome
   codex mcp add claude-chrome -- npm --silent --prefix ~/tabai start
   ```
5. Load Chrome from the new path: `chrome://extensions` → **Load unpacked** → `~/tabai/extension`.
   Exactly one copy is enabled at any time. Compare the popup's **id** with the recorded one.
6. Restore settings first: re-enter the bridge URL and token in the popup and **Save & reconnect**.
   Restore the Chrome-managed choices from 2a without broadening them.
7. If a pin exists and the ID changed, replace it — never clear it to get past a rejection — and
   restart the broker so it re-reads the file, then reconnect the popup:
   ```sh
   npm run set-extension-id -- <new id from the popup>
   npm run kill-broker
   ```
8. Reopen the project from `~/tabai`, start Claude Code and Codex from their updated entries.

### 2c. Verification

- `cd ~/tabai && git status -sb && git remote -v` show the canonical directory and origin.
- `npm run typecheck && npm test` pass; `npm run doctor` is all green.
- In Claude Code and in Codex: `tabs_context_mcp { createIfEmpty: true }`, `navigate`,
  `get_page_text`, then `tabs_close_mcp` on the tab each created. Each session sees only its own
  tab group.
- The popup shows Tabai, the version, the id and **Status: connected**; the toolbar shows the mark.
- Pinned setups only: a WebSocket upgrade on `:9223` with a different `chrome-extension://…`
  Origin returns HTTP 403 while the real extension stays connected. Do not enable another
  extension for this probe; a raw HTTP client with a forged Origin header is enough.
- Saved recipes (`recipe_list`) and exports under `~/.claude-chrome-mcp` are still available.
- Only after the above: remove the disabled old extension copy, and remove the old-path symlink
  unless an excluded old process still needs it (then keep and document it as an alias).

### 2d. Rollback

Reverse the order: disable the new extension copy; stop only the broker you verified belongs to
this project (`npm run kill-broker`); remove the owned symlink; move the directory back
(`mv ~/tabai ~/claude-chrome-mcp`); restore the Claude Code entry from the backup
(`claude mcp remove claude-chrome -s user`, then `claude mcp add claude-chrome -s user -e KEY=VALUE … -- node <old checkout>/dist/server.js`
with the command, path and environment recorded in the backup file — the same call `npm run register` makes);
restore `~/.codex/config.toml` and the pin file from their copies; re-enable the old extension
copy; restart the affected clients from their restored entries and repeat the verification
against the old path. A moved directory restored to its original path yields the original
extension ID again.
