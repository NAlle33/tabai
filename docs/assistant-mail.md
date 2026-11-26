# Assistant mail

Part of the [daily assistant](daily-assistant.md) guide.

**Mejl** is a calm inbox in the chat's style.

**At the top:**
- "Kollat <time>", when mail was last checked; during a check it says so, with
  **Stoppa**. While reply cards are open for mail you had already opened, the same
  line adds "· 3 mejl du öppnat men inte svarat på" (see
  [Opened mail without a reply](#opened-mail-without-a-reply));
- a red row only when an account needs you, for example "Gmail behöver loggas in ·
  **Åtgärda**". Åtgärda opens that account; when a run waits for your help, it opens
  the help under Kontroller. Technical partial or unsupported gaps are amber and use
  **Visa status**, rather than presenting an action as required;
- one main button, **Kolla mina mejl**;
- **⋯** for the other tasks and your shortcuts, **Ärenden**, and **Kontroller och
  konton** (coverage, the current run's controls and previous checks).

**Tabs:** **Att göra** and **Klart**.

**Each mail is one row**, with sender, subject and a status word:
- "Svar att skicka", "Fråga till dig", "Behöver dig", "Kolla om det skickades" or
  "För kännedom"; "Kolla om det skickades · nytt meddelande" when a later message waits
  on an uncertain send (see [Replies and interruption](#replies-and-interruption));
- informational rows carry **Klar** directly;
- **Klar för alla** marks every informational item done after a confirmation;
- an account filter appears when there is more than one account.

**Opening a row** shows one card. It says in one sentence what to do and has one
main button:

| Status | Main button |
|---|---|
| Svar att skicka | **Skicka svaret** |
| Fråga till dig | **Svara Tabai** |
| Kolla om det skickades | **Öppna i <account>**, then **Det skickades** or **Det skickades inte**; Tabai never sends it again on its own |
| Behöver dig (a reply Tabai has no proposal for) | **Öppna i <account>** |
| Behöver dig (anything else), För kännedom | **Klar** |

- The reply appears once, in an editable box with "Till: <recipient>" above it.
  **Skicka svaret** asks "Skicka till <recipient>?" in the card, and only its
  **Skicka** sends: the saved text to the sourced recipient, with the same checks as
  before. It waits until an edited draft is saved ("Sparar utkastet…"). **Avbryt**
  or Escape sends nothing, and editing the text or a change to the mail closes the
  question.
- Below the main button are two small buttons: **Klar** (called **Inget svar
  behövs** on a card with Tabai's reply or a question about one, where it records
  the no-reply feedback) and **Påminn mig** (tomorrow or next Monday at 08:00 in
  your time zone). Where the main button is already Klar, only Påminn mig is shown.
- **⋯** holds Öppna originalet, Visa vad Tabai läste, Kolla upp avsändaren, Chatta
  om detta, **Lär Tabai** (Kortare svar, Prioritera avsändaren) and, on a done mail,
  Flytta tillbaka.

After **Klar**, **Ångra** reopens the item for six seconds; it follows the list,
so Tab reaches it. Later, **⋯ → Flytta tillbaka** on a done mail in **Klart** does
the same. Information from a prioritized sender counts as needing
you, so **Klar för alla** leaves it. When a check started from the chat finishes,
its chat item shows the counts for the mail that check found, for example "2 svar
att godkänna · 5 för kännedom", with **Visa i Mejl**.

Add each mailbox separately under **Inställningar → Mejlkonton**, including its
expected email address and provider URL. Gmail selects the account by address; a
numeric browser index is not a durable identity. Zoho's regional URL must match
the signed-in installation. No personal accounts are shipped with the source.

Zoho can sort mail for several addresses into ordinary folders inside one
signed-in account. Keep that organisation: Tabai discovers the native Inbox and
custom folders and includes their visible rows in a mail check. The verified
profile address identifies the account; a folder's name does not indicate a
different login. Drafts, templates, snoozed mail, spam, trash, archive and Outbox
are excluded from this incoming-folder inventory; Sent is read separately.
The worker opens each discovered folder through its native control or observed
address. Unreadable or unvisited folders are named in partial coverage. The same
30-thread limit and saved thread reviews apply across the account's folders;
continuation retains assessments and discovers the folders again.
At a folder change, Tabai waits for the previous native list to be replaced and
Zoho's loading marker to clear. A changed folder label or address alone cannot
count the destination as read. A list that remains ambiguous stays incomplete.

## Agent and account access

The assistant reasons with an explicitly chosen backend (see
[Agent model](assistant-models.md#agent-model)): Codex, Claude or Berget in the cloud, or local inference
with Ollama on this computer. For Codex, install and sign in to Codex CLI before starting a task;
the worker reuses that authentication rather than installing new OAuth
applications or API credentials.
It operates the existing signed-in Chrome profile through a separate Tabai session.
Tasks started or resumed from the panel create their own Tabai group in that
panel's Chrome window, including when it has no Tabai tabs. Existing user tabs
are never adopted into that session. If that window closes before the group is
created, restart from the panel in an open window. Existing task groups stay in
their originating window; ordinary external MCP sessions retain their background
window default. Opening a source while a task runs shows that task's own tab.
If a login, account identity or web interface cannot be verified, the panel shows
the gap for that account. A partial check is not an empty mailbox. Google keeps
an account with an expired session in its profile menu; opening that account
leads to an identity confirmation page, which Tabai reports as login and names
in its message. Tabai never completes that confirmation. Outlook
accounts are read on `outlook.live.com`, `outlook.office.com`,
`outlook.office365.com` and Microsoft 365's new `outlook.cloud.microsoft`, where
the older work addresses redirect; the list is `ASSISTANT_MAIL_HOSTS` in
[shared/assistant.ts](../shared/assistant.ts).

Some mail interfaces do not finish loading in an occluded background window.
When a known provider loader remains, the assistant may request that its owned
window be shown once, through the existing **Tillåt att agenter tar fram Chrome**
preference. It never enables that preference. If showing the window is disallowed,
open the assistant tab manually and retry; that account remains unchecked until
the normal identity and content checks succeed.

With Codex, mail and calendar content is sent to the authenticated Codex service
for reasoning; Claude sends it to Anthropic and Berget to Berget.ai. With local
inference it is sent only to Ollama on `127.0.0.1`.
The assistant still needs the internet to read web mail, and
pulling a model needs the internet. Page content is evidence rather than
instructions, and saved custom instructions remain within the same mail/calendar
reading boundary. Browser behavior and provider recognition are owned by
[assistant-browser.ts](../src/assistant-browser.ts); the isolated tool catalog and
CLI launch are owned by [assistant-agent.ts](../src/assistant-agent.ts).

For browser-tool diagnostics, the assistant sets its own `CCMCP_LOG_DIR` to
`~/.claude-chrome-mcp/assistant/browser-logs/`; these calls are not logged in the
ordinary MCP session's default log directory. Host policy refusals before a tool
dispatch need not appear in that call log. Inspect the saved run's help and
current native element facts before attributing a refusal to Chrome.

The worker needs complete relevant conversation history, including sent replies,
to judge whether a response is still needed. The last successful check is scoped
to an account and task. Failed or partial checks do not move that boundary.

### Opened mail without a reply

A mail check covers mail you opened and then forgot to answer, not only unread
mail. The host, not the model's judgement of the list, decides which mail needs an
outcome ([assistant-agent.ts](../src/assistant-agent.ts),
[assistant-browser.ts](../src/assistant-browser.ts)):

- Each inbox list read records the visible native rows: the provider's thread and
  latest-message ids where the row renders them, otherwise a fingerprint of the row
  text without dates and unread markers; the read state; and the full date. The date
  comes from the provider's `time[datetime]` element when the row has one, otherwise
  from the latest readable date among its titles, never one beyond tomorrow, and a
  date without a time counts as the end of that day. A title the sender controls can
  then only pull a row into the look-back window and force a review, never date it
  out. An absent read state or date stays absent.
- Every row inside `lookbackDays` without a review newer than its latest message
  must get an outcome (`workflow_checkpoint`) before a check-mail account can be
  `checked`. A review covers a row when it reviewed the row's native latest message,
  was bound to the row (by its id, or by the click that opened it) at the same
  version, or was made after the row's latest message. A split view keeps the earlier
  detail beside the list, so a click binds the row only when the next read's detail
  shows the row's own thread; a row that is known only by its text, with no thread
  identity, is bound when the detail changed since the click. An unbound row is read
  again, never closed.
- Reads of the inbox list return `inbox`: how many such rows remain and which to
  open next, newest first. At most 30 rows per account get outcomes in one check;
  beyond that the account is partial with "N äldre mejl hann inte kontrolleras", and
  the next check continues.
- Gmail may issue an element reference on a native subject cell instead of its
  structural row. Tabai uses that exact visible cell to open the thread and bind
  its outcome to the original row. Sender, selection and action cells are not
  substitutes; tables inside message bodies cannot supply inbox rows.
  If the bounded general page listing omits native subject cells, the host
  prepares a bounded set through the existing unique-target resolver, then reads
  fresh metadata to bind the resulting references to their current rows. Hidden
  cells are excluded. This preparation neither opens nor assesses a message.
  If an optional target disappears, preparation stops and rereads the native
  list. Missing references remain missing; ambiguous matches, transport failures
  and ownership failures still stop the read.
  Gmail list reads also return at most twelve fresh native opening references
  with labels in `mailRows`, including Skickat. These remain available when the
  general page scan omits the cells or predates reference preparation. They are
  navigation data, never message evidence. The local runner mirrors these native
  rows without treating arbitrary grid cells as message rows; ordinary click
  validation and complete-history requirements still apply.
- Reviews are kept privately across checks (newest 400 per account, up to 120 days),
  so unchanged mail with an outcome is not read again; a new message makes it due.
- `already-replied` requires a complete, ordered thread whose latest message is from
  the account's own address. Its checkpoint cannot create any new finding, including
  an information card; evidence-backed resolutions may still close an existing item.
  A reply proposal is refused on such a thread.
- A check-mail account cannot be `checked` without reading the inbox list in that
  check. `inbox.inventoryRead` reports that inventory separately from remaining
  outcomes. Gmail search URLs recognize only `in:inbox` or `in:sent`, optionally
  followed by a positive `newer_than:<N>d`, `m` or `y`, even when the visible search
  input is empty. Filtered, detail-suffixed and unknown searches retain observed
  rows but cannot establish inbox inventory. Open the account without a URL or
  use bare `in:inbox` for that proof; content/history checks still apply.
  Rows without a readable date, an unreadable list and a list without read
  state are named in the account's coverage message instead of being guessed.
- A reply card for a row that was already read when the check first saw it, in a
  state no earlier review covered, is marked opened. Mejl counts such open cards.
  A resumed check does not mark mail opened, since it may have opened it itself.
  Mail Tabai opened without saving an outcome, such as in the account self-test, can
  later look opened by you; providers that mark mail read when Tabai reads it make
  that possible.

The local runner mirrors the same requirement from the host's results
([assistant-local-state.ts](../src/assistant-local-state.ts)).

Native message-body extraction includes hidden quoted text without clicking
controls authored in the email. Supported native header disclosures can be
expanded through **browser_expand_thread**; missing/lazy bodies and truncated
history stay incomplete. Unknown provider layouts require concrete manual help.
This does not guarantee that every mailbox's current UI exposes ordered history.

Gmail threads are read through the signed-in session rather than by clicking rows.
`inbox.openThreads` names the native threads a Gmail list showed in this check, and
`browser_read_thread` fetches Gmail's print view for one of them from the owned tab.
No list reference, expansion, visible window, password or stored token is involved.
The active address in the page and the address in the response must both match the
account. A thread is complete only when Gmail's declared message count equals its
message blocks and each block has a sender address and a body, so a forged block
inside a message leaves the thread incomplete. An attachment-only message and a
thread with an unsent draft, which the print view includes, stay incomplete and are
read in the web view, where the unread-attachment review applies. The print view cannot
tell a draft from a sent reply, so where the account would be the latest sender, the
list row is read again after the fetch; unless that fresh row shows no draft, the
thread stays incomplete and the web view decides.
The view has no IDs for older messages: the newest comes from the list row and older
ones use a content hash. Closing a saved item as already answered therefore still
needs a web-view read, and the result says so. The print view is not a documented
Gmail interface; if its markup changes, reads become incomplete rather than wrong.

Zoho is read through its REST API when `assistant/zoho-mail-oauth.json` exists in
the private data directory (mode 0600), holding a Self Client's `clientId`,
`clientSecret`, `refreshToken` and regional `accountsServer` for the scopes
`ZohoMail.accounts.READ`, `ZohoMail.folders.READ` and `ZohoMail.messages.READ`. The
file is read only by the host, and browser tools refuse any argument naming it. The
boundary for every file in the private data directory is the assistant's own MCP server:
its deny root is the per-user data directory, so `file_upload` and `file_drop` give a page
no file from it and no directory at all, also when a batch or recipe builds the path or
names the directory another way (`CCMCP_UPLOAD_DENY_ROOT` in the [README](../README.md#build)). The API's account must be the
configured address and its region the account's. `browser_open` then inventories
every incoming folder and Sent for the period without a tab, and
`browser_read_thread` reads a conversation across folders in thread order, complete
only when no message seen in a folder is missing and each has a sender and a body.
A message from Zoho's Sent folder counts as the account's reply, whichever of its
addresses sent it, only when it is addressed to whoever wrote last, so a forward to a
colleague does not close a conversation. An incoming message never counts as the
account's own, whatever its sender field says. A conversation holding a draft or an
item from an unknown folder stays incomplete.
Without that file, or after any API failure, Zoho uses the web view, as do
attachment-only messages. Outlook continues in the web view.

An attachment-only Gmail message can instead get an explicit **Granska mejl med
oläst bilaga** action. Tabai requires a native identified message and attachment
outside the mail body, a mounted blank body and stable fresh reads without loading
indicators. `workflow_review_attachment` rechecks the source and atomically saves
the host-created action and an `attachment-review` row/version outcome. Attachment
contents and incomplete message contents remain unread (`historyComplete=false`).
Ordinary findings, reply proposals, already-replied outcomes and resolutions still
require their complete reading evidence.

For **Kolla mejl**, `checked` means every relevant inbox row has a reviewed or
explicitly flagged outcome. Coverage and the summary name the outstanding unread
attachment threads; their actions stay under **Behöver dig** across later checks
and restarts. A changed native message version requires a new outcome. This
flag can cover a list row without a native latest-message id only within the
same logical scan and its continuations. The next new check opens that row again
to verify its current native detail version, even if its text looks unchanged.
This
manual exception can establish that a native mail area was traversed, but cannot
supply complete-content evidence to other tasks. A verified learned method
attests preparation, not attachment contents. Unknown layouts and genuinely
unloaded bodies retain the existing help path.

Zoho readiness waits for actual mailbox content after the initial spinner has
disappeared. A uniquely selected native folder remains valid even when the left
folder tree is collapsed or hidden; the route, folder identity and fresh list
nodes still have to agree. Loading and folder-selection transitions remain
transient states, while an unknown layout is reported as unsupported. Recovery is
bounded and read-only, with at most the existing foreground-permission request;
it never replays an uncertain click. Its account drawer uses a dedicated close
control. Reading recognizes the native preview body and can expand a missing
older message through that message's direct collapsed header. Sender profiles,
flags and menus are not thread disclosures. An uncertain click is never repeated;
empty/unloaded bodies remain incomplete. Supported native layouts still need
fresh account/source verification.

## Learned preparation methods

Under **Inställningar → Mejlkonton**, enable **Lär in och återanvänd verifierade
mejlmetoder**, or choose **Kör nu och lär in** for an account. Learning is off
initially. It uses the selected task model and an ordinary mail check, including
fresh complete threads and checkpoints; normal model usage or charges apply.
Only a successful, fully covered check can establish a verified method.

A method learns the observed order of incoming and Sent views, consolidates the
preparation into one worker tool, and remembers whether supported thread history
needed expansion. Current account identity, native folder routes and final inbox
references are resolved again on each use. Zoho's incoming folders are verified
individually. The model still assesses new mail; previous assessments are not a
recording to replay. Learning never sends mail or grants sending approval.

With Full Tabai access enabled, learning checks start with the guarded mail tools;
the full catalogue remains available as a fallback. Any raw `mcp_browser_call`
marks a possible external effect and disables learning/reuse for that run, even
for a read. The saved full-access preference and sending controls are unchanged.

The same saved learning choice applies to manual checks, the daily check and
check-mail routines. For example, ask “läs mina inkorgar klockan 12 varje dag och
lär in hur du gör”. The schedule card shows the explicit learning change before
you confirm it. An ordinary schedule request preserves the current choice. You
can also ask the chat to turn learning on or off. Chrome and Tabai must be running
at the scheduled time, as for the existing daily check.

Each account's settings show its verified method, pending changes and recent
preparation measurements. Edit the view order or history expansion, save, then
choose **Prova sparad ändring**. A candidate replaces the working version only
after fresh validation and durable saving of a fully checked result. If its
preparation fails, Tabai tries the previous verified preparation; ordinary guarded
reading remains available. Stopped, partial and effectful runs cannot promote a
method. A concurrent edit keeps your draft and requires an explicit reload before
saving against the latest revision.

Turning learning off retains methods without executing them. **Glöm metoden**
removes the saved method and its measurements; it can be learned again.
**Kör nu och lär in** starts a fresh baseline; only a successful check replaces a
pending edit as well as the previous method. A changed
account address/provider/URL cannot inherit the old method. The private
`assistant/mail-methods.json` stores only typed steps, account fingerprints,
versions and aggregate measurements, with a previous snapshot for recovery. It
contains no mail text, credentials, page URLs or browser references.

Preparation call counts and elapsed times describe actual runs. Different runs
can contain different work, so the panel does not claim a comparable time or
cost saving. A validation pass proves functional correctness, not a performance
improvement. Contracts live in
[assistant-mail-methods.ts](../shared/assistant-mail-methods.ts); guarded execution
is owned by [assistant-mail-method-execution.ts](../src/assistant-mail-method-execution.ts).

## Account self-test

Under **Inställningar → Mejlkonton**, save an account and choose
**Testa läsåtkomst**. A deterministic host test verifies the account, Inbox, one
native conversation including its mounted older messages, and the Sent view.
These are four separate outcomes with timestamps and concrete recovery guidance.
The test uses the current signed-in browser without a model call or send action.
It does not assess the whole mailbox, create findings or advance last-check dates.

The test can run for a saved disabled account. Unsaved account edits must be saved
first. Complete/stop other active work before testing. **Visa test i Chrome** shows
the owned test tab; **Stoppa självtestet** interrupts it without continuing a
mail action. Restarted tests are marked interrupted. A verified empty Inbox leaves
the conversation step untested rather than inventing a success. Sent is tested
independently when another reading step fails.

## Case center

Open **Mejl → ⋯ → Ärenden** and choose **Nytt ärende**. Save its name,
optional description, next step,
waiting person, due date and manual status. Explicitly link saved mail, meeting or
task findings, a known local module run, or a safe http/https source URL. Linking
does not fetch a page, merge accounts or start a module. Opening a module source
selects that exact run through the existing module contract.

Each source keeps its own status. A sent reply does not prove that the whole case
is complete or an invoice paid. A linked ongoing/uncertain send prevents case
completion, deletion or unlinking that source until its outcome is resolved. Case
metadata cannot authorize another mail send. Existing links to archived findings
retain read-only source opening; unavailable modules show explicit guidance.

Case edits remain in memory across polls and failed saves. A concurrent edit in
another panel cannot silently replace the original editing revision; discard
changes deliberately to load the latest data. Successful saves persist in the
same private backed-up workspace. Source quotations/drafts are not copied into
browser storage. Cases and source previews are paged/bounded; search/status filters
apply to the shown case page. A capacity error rejects a new write before saving,
preserving the previous committed workspace instead of overflowing the transport.

## Progress, continuation and preferences

The panel shows the current account/action and the number of genuinely assessed
threads. For a multi-account **Kolla mina mejl** run, accounts are checked
sequentially, with a separate scoped worker for each account. A blocked account does not stop the other readable
accounts: their results and checkpoints are saved, and the coverage meter counts
completed accounts rather than an estimated percent of mail read. **Visa arbete i
Chrome** opens the latest owned work tab.

When an account needs manual help, the run keeps account-specific help for every
blocked account and shows one help block at a time. **Öppna den blockerade fliken** targets the exact
account, owned tab and source; if that tab has closed, Tabai opens a safe owned
replacement for that account/source. **Kontrollera och fortsätt** performs a
read-only check of that target before starting a new model. If the check cannot
verify the target, the run remains waiting and no model starts; a changed account
or source fails closed. Only the remaining account work resumes, with saved
assessments and checkpoints retained. Older saved runs with one help entry remain
readable.

Each reviewed thread is checkpointed together with its findings. **Fortsätt saknade
delar** reuses completed accounts/threads within that scan and retains its original
scan-start boundary so later mail is still eligible for the next fresh check.
Starting another task preserves an unfinished scan in a private backed-up journal;
continue it from **Mejl → ⋯ → Kontroller och konton → Tidigare kontroller**. Changing accounts or the scan
range requires a new check. Uncertain sends are never resumed. A full-access MCP step is conservatively recorded
as a possible external effect before dispatch. A failed write of that record
prevents the step. Once recorded, both continuation and answering that run's
question are blocked: check the actual outcome and start a new scoped task.
The opt-in full-access setting for fresh work is unchanged. Older checks without
an effect record keep ordinary read-resume, but do not offer the new model-change
option.

The same unfinished check also offers **Fortsätt med annan modell** under
**Kontroller och konton**. Select the backend/model explicitly and press
**Fortsätt**. It applies only to the continued scan, preserves saved checkpoints,
completed accounts and its original scan boundary, and leaves global model
defaults unchanged. The new check names its model; that explicit choice survives
restart. A changed run is rejected, and an interrupted or uncertain send remains
locked. [Model settings](assistant-models.md#a-different-model-for-one-continuation)
explain provider privacy and availability.

The account queue applies only to a full **check-mail** run. Single-account tasks,
questions and sending keep their existing lifecycle and approval rules. Full-access
gates and the agent foreground permission are unchanged; a step that may already
have had an external effect is never resumed.

**Sök sparat** in the conversation list also finds saved mail and cases outside
the currently displayed page, including archived findings. It searches saved
local text rather than the mailbox, opens a mail finding's original through its
configured account, or opens the case itself, without restoring archived mail or
starting a model. See
[panel search](assistant-panel-and-chat.md#panel-chat).

Old reply proposals can become **Redan besvarat** only when fresh complete,
ordered conversation evidence contains the original message and a later message
sent by the exact account owner. Matching subjects, list text or a Sent folder
alone do not prove this. Layouts without that evidence retain the proposal for
manual review; the earlier draft and resolution evidence remain inspectable.

Explicit feedback can mark the current point as requiring no reply, prioritize
an exact sender for one account, or request shorter future replies. Review/edit
these preferences under **Inställningar**. A new substantive message can reopen
a previously dismissed point. Feedback never grants automatic sending rights.

## Morning overview and notifications

The daily task is optional and off initially. Ask in chat, for example “kontrollera
alla mina mejlinkorgar varje dag klockan åtta”, and confirm the exact time, timezone
and task on its card. At least one saved enabled account is required. The daily
mail task prepares findings and reply suggestions; sending still needs separate
approval. Results are attached to the conversation where the schedule was saved.
The same scheduler can run the morning overview; **Inställningar → Mejlkonton** retains
its manual controls under **Morgonkontroll och aviseringar**. Its next occurrence
is shown in the panel. The trusted broker keeps the assistant available even when
the panel is closed, while Chrome and Tabai are running. A missed time can run on
reconnection; it does not wake a sleeping computer or open a closed browser.
A scheduled run or watch starts only after the computer has stayed awake for
three minutes, because a Mac that wakes briefly for maintenance would freeze the
run seconds later. A short sleep does not end a run. A run whose time limit runs
out while the computer sleeps, or whose worker stops right after a wake, is shown
as interrupted rather than as having reached its limit. It can be continued unless
a send may have happened.
Running/waiting work defers the morning task. A durable local-day reservation
prevents duplicate starts after restart and across repeated daylight-saving hours;
nonexistent clock minutes are skipped.

The toolbar badge shows pending attention. A mail set aside with **Påminn mig** reopens
when its time runs out and is counted in the badge again, as before it was set aside.
Desktop notifications require a
separate explicit toggle and Chrome's optional notification permission. Only new
attention triggers them, with counts rather than message text or account addresses.
An uncertain notification dispatch is not replayed. Clicking an alert opens the
panel; alerts do not bring Chrome forward on their own.

## Replies and interruption

Review the source, recipient and exact proposed text before choosing **Skicka
svaret** and its **Skicka** in Mejl. Missing facts remain questions. The sending worker rereads the
original thread and checks the active account and composer before dispatch.
Unsupported or ambiguous composers require manual action in the mail service.

A reply found through a direct read is held to the same checks. Gmail rewrites a
thread's address after loading, so that address counts only while Gmail's own subject
heading names the approved thread at the same mailbox location.

Gmail's reply box has no From field for an account with one address, and it shows a
one-line summary while its To, Cc and Bcc rows stay hidden with the recipients in
them. A reply in that form passes only when those rows name exactly the approved
recipient and nobody else, with the verified account as sender. A summary that counts
people or separates names, a row holding something it cannot name, a sender that is shown, an open row or anything else that cannot be
confirmed stops the reply. A second address the account can send from is not visible
in this form, so an account with such aliases should reply in Gmail.

Outlook's message header shows only the sender's display name, which the sender chooses,
so Tabai never reads a sender from it. The address comes from the selected list row, and
only when that row holds exactly one address, its name is the one on the single From row
showing, it has the open message's subject, and it is not a conversation that expands
into several messages. Otherwise the sender stays unknown.

Outlook sends a message's address back to its list on a full page load. Tabai therefore
loads the app and hands it the same address through the app's own history, then waits
until that message is shown. If it does not appear in time, nothing is read or sent.
Approved Outlook replies still stop before Reply is pressed, with a message to reply in
Outlook: Outlook saves a draft as soon as Reply is pressed, and Tabai cannot yet verify
its reply box, where the sender, Cc and Bcc fields are not shown as Tabai expects.

A reply on a card read through Zoho's API is sent by the host through Zoho's reply
endpoint, with no worker, tab or composer. It needs a second private file,
`assistant/zoho-mail-oauth-send.json` (mode 0600), holding a Self Client grant for
only `ZohoMail.messages.CREATE`, in the same format as the read grant, so a run that
only reads holds no token that can send. It is protected like the read grant.
Before the attempt is recorded the approved message must still be the newest delivered
message of its conversation, written by the card's recipient and in an incoming folder,
Archive or Snoozed, and the sender must be among Zoho's permitted senders. For a message
with no conversation yet, later mail to the same recipient in Sent or in the Archive
folder, where Zoho moves a sent message that is archived, also counts as doubt, because
an answer may not have joined it. Any doubt leaves nothing sent and the card open.
The attempt is then recorded and one request is made; a missing confirmation makes the
send uncertain, and it is never repeated. Tabai submits exactly the approved text as
plain text and adds no signature. Zoho itself quotes the message being answered below it.

Zoho's web composer cannot pass the send checks: Reply moves the page to `#compose` and
the editor is inside a frame. So no worker is started for a Zoho reply. Reply in Zoho when
the send grant is missing, for a card whose IDs Zoho cannot confirm, and for a reminder in
a conversation whose newest message is your own.

A Zoho reply goes out from the one address that the last incoming message was sent to
and that Zoho lists as a permitted sender. The card and the question before sending show
it. When no single address qualifies the account's own address applies. Automatic
acknowledgements never use another address.

Automatic acknowledgements are off initially. Turning them on requires an explicit
recipient allowlist and fixed acknowledgement text. Only a matching proposed
acknowledgement is eligible; arbitrary generated replies cannot be sent by that
rule. Keep this setting off when every reply should receive individual approval.
An automatic attempt is made at most once per message and never repeated after it
fails. The mark is for the thread: once a reply has been on its way out in a thread,
whatever its outcome, only your own **Skicka** sends there again, also for a new
inbound message. A card without a message identity, an Outlook card and a Zoho card
that Zoho's API cannot confirm start no automatic acknowledgement, since such a send
could only fail.

An interrupted or unconfirmed send is locked as uncertain, and Tabai does not
automatically retry it. Check the provider's Sent folder, then answer the card's
question "Hittade du svaret i Skickat?": **Det skickades** marks the reply as sent, and
**Det skickades inte** reopens the card with its draft. Neither sends anything; a reply
that did not go out needs a new **Skicka**. A later message that a check finds in the
thread meanwhile waits on the card ("Ett nytt meddelande har kommit i tråden…") instead
of being lost; follow-up reminders are not such messages. Once you have answered, that
message becomes the thread's open card, and it is not announced again as new attention.
Stopping a read task preserves its state and allows a fresh read on continuation.
The state/approval boundary is owned by
[assistant-controller.ts](../src/assistant-controller.ts), with isolated regression
checks in [assistant-controller.mjs](../test/assistant-controller.mjs) and
[assistant-execution.mjs](../test/assistant-execution.mjs).
