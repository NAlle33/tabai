# Assistant panel and chat

Part of the [daily assistant](daily-assistant.md) guide.

The control panel opens directly in one chat, simple on the surface. The header
is one row:
- **☰** opens the conversation list;
- the conversation's name;
- **Mejl**, with a count of what waits for you;
- **⚙︎** opens Inställningar.

The composer stays at the bottom. It has **+** (attach files, local tools), the
chat model and send/stop. An empty chat shows a greeting and quick choices:
- **Kolla mina mejl** and **Min dag** start those tasks directly, without a model
  call, exactly like the buttons in Mejl;
- **Förbered möte**, **Sök och sammanfatta** and **Hitta billigast** fill in the
  composer.
Questions, progress, results and exact approval cards stay in the conversation;
a started task appears as a one-line item with **Visa i Mejl**.

## Settings and appearance

**Inställningar** is a short list of pages, each saving on its own:
- Allmänt;
- Modeller och anslutningar;
- Mejlkonton;
- Webbåtkomst;
- Bevakningar;
- Rutiner;
- Minne (including Mina uppgifter);
- Kostnad;
- Avancerat.

**Avancerat** holds the technical sessions, recipes, run history and diagnostics.

There is one conversation surface and one settings surface. Draft edits stay in
memory until saved through the private controller; source selection waits for
pending draft saves. Appearance choices persist locally.

A settings page with unsaved changes keeps the values it was drawn from. When the
saved values for that page change meanwhile, for example a sender rule added from
Mejl, the page says "Inställningarna på sidan har ändrats sedan du började, till
exempel från Mejl. Dina ändringar finns kvar men är inte sparade." and saves nothing
until you choose. **Läs in de nya värdena** discards the page's unsaved changes.
**Spara mina ändringar** saves what you changed over the new values; fields you did not
change keep the new values. A field you type back to its earlier value while a save is
on its way counts as your change.

**Inställningar → Allmänt → Utseende** offers system/light/dark navy modes, accent colors
and a **Textstorlek** slider (12–20 px, 14 px by default). Text changes immediately
throughout the panel; control targets retain their size. The choice is saved on
this computer. **Återställ textstorlek** returns to 14 px.
The mandala, toolbar icons and tab favicon are baby blue. Session groups
and the page-presence indicator use the same blue brand direction.

## Panel chat

Use the shared composer for general conversation, follow-up questions and requests
such as “kolla mina mejl”. Enter sends; Shift+Enter inserts a line break. A selected
mail item or case appears as a chip in the composer; **✕** leaves that context. Unsent
text and scroll position remain separate per conversation in panel memory, across
polling and conversation switches; they are not written to browser storage.

**Den här sidan.** When an http(s) page is active in the panel's window, the
composer shows its address with **Dela**. Nothing is read until you press it.
Then the panel reads the page in your own tab, with your sign-in: the title,
the address, the text you selected and the page's visible text in the main frame
(open shadow roots included, a line break between blocks).
- **Visible text only.** Text is left out when it is hidden (display, visibility,
  opacity 0, content-visibility, a closed `details`), screen-reader-only or
  clipped to a box of at most 1 px, `aria-hidden` or `inert`, transparent,
  `font-size: 0`, or placed entirely outside the page or its scroll container.
  Form fields are never read: no typed values, passwords or select choices. A
  selection is taken only when it is not collapsed, not in a field and not focused
  in one; a selection that the page text contains and that covers nearly all of it
  (90 % or more) is not repeated.
- **Typed text stays out.** Editable content (contenteditable, inherited editability
  or `designMode`) and elements with the role textbox, searchbox or combobox never join
  the page text, also while they have focus. A selection you make inside one is shared,
  as the selection, also when it is long and also when you select the whole page. A page
  that is editable as a whole has no page text: the status line says "Hela sidan är ett
  redigerbart fält, så Tabai delar inte dess text. Markera det du vill dela och tryck Dela
  igen." A page whose text all stands in editable fields, with nothing selected, says
  "Sidans text står i redigerbara fält, så Tabai delar den inte. Markera det du vill dela
  och tryck Dela igen." The tooltip on **Dela** says: "Läser
  sidans titel, adress och den text som syns på sidan, och det du har markerat.
  Formulärfält, lösenord och dold text följer aldrig med. Inte heller text i redigerbara
  fält eller i rutor med rollen textbox, searchbox eller combobox, om du inte själv
  markerar den. En kodredigerare som visar texten i vanliga element bakom ett dolt
  textfält känns inte igen, och dess text följer med."
- The read runs in an isolated script world, so the page's own scripts cannot replace
  the functions it relies on.
- **The address.** Fragment and credentials are removed. Every parameter value is
  replaced with `dolt` except `q`, `query`, `search`, `page`, `p`, `sort`,
  `lang`, `tab`, `view`, `filter`, `category` and `id`, and so is every long
  opaque path segment (24 characters or more, base64- or hex-like). The agent
  never opens an address with hidden parts.
- The result is attached as the file "Sida <värd> <datum>.txt", capped at 500,000
  characters, through the same file pipeline as other attachments. The host marks
  the file as a shared page (`source: 'page'` with the address in the attachment
  index); a file is never treated as a page because of its name, and older files
  without the mark are ordinary attachments.
- **Only the chat model reads it.** The chip says how many characters are shared,
  "kapad" when the text was cut, and that the text goes only to the chat model:
  the named provider, or the local model on this computer. It never follows a
  task started from the chat or a confirmed card, whatever their model. The chip
  is drawn from the host's mark, so it survives a reload of the panel.
- The agent reads it with `chat_files`. **In guided mode, a turn that has read a shared page
  reaches only that page's own site:** `web_search` is refused, and so are other
  sites, and forms and clicks on tabs of other sites, with "Den här turen har läst
  en delad sida. Andra webbplatser öppnas i ett nytt meddelande, så att sidans
  innehåll inte kan följa med." At **Agera med godkännande** with login on, it can
  open the page's own address in its own tab.
- The agents' tools still never reach your tabs; sharing is always your own press.
- No suggestion appears for `chrome://`, extension pages, `file:`, PDFs or the
  Chrome Web Store. For mail and calendar (Gmail, Google Calendar, Outlook, Zoho)
  the row says "Mejlen hanteras i Mejl" instead of **Dela**. The read is refused if
  the page changed site after the press.
- A read waits at most 15 seconds. It belongs to the conversation that was open at
  the press: one that finishes after you switched conversation is dropped with a
  message, and one slow tab never blocks **Dela** on other tabs. A share whose upload
  failed is never reported as attached: the status line says "Sidan <sida> kunde inte
  bifogas. Se felet ovanför och tryck Dela igen." A message about something that
  succeeded stays until the view has a status of its own to show, such as the running
  agent, or until your next action; a failure stays until that status changes.

**Fråga Tabai in Chrome's context menu.** Turn on **Inställningar → Allmänt →
Visa Tabai i högerklicksmenyn**. Chrome asks for the optional `contextMenus`
permission on that click, like notifications; turning it off removes the
permission again. No reinstall is needed: a normal reload of the extension
picks up the shortcut and the optional permission. On ordinary http(s) pages
the menu offers:
- **Fråga Tabai om ”…”** on selected text: the panel opens and shares only the
  selection, as a page file "Markering <värd> <datum>.txt" with the label
  "Markerad text från <värd>". The page's title and the rest of its text stay in
  the tab, and Chrome's own copy of the selection is never used: the panel reads
  the selection again with the rules of **Dela**, so text selected in a form
  field never follows. It is marked `source: 'page'` with `pageSelection`, so the
  same origin lock applies to the turn that reads it, and **Dela** still offers
  the whole page.
- **Dela sidan med Tabai**: the same as **Dela**.
- **Fråga Tabai om länken**: the panel opens and puts "Vad finns på <url>?" in the
  input, without the link's fragment or credentials. Nothing is opened or read
  until you send it.

**Shortcut.** Alt+Shift+D (⌥⇧D on a Mac) opens the panel and shares the active tab,
like **Dela**; Allmänt shows the shortcut Chrome actually assigned, and
`chrome://extensions/shortcuts` changes it. The panel always opens inside your
own click or key press. The same refusals as **Dela** apply (mail and calendar,
Chrome's own pages, PDFs, the size cap), and each is said in the panel; when the
panel cannot open in a window, it says so the next time it opens. The service
worker reads no page: it only hands the panel the tab and address, and a request
older than a minute is ignored. See
[assistant-context-menu.ts](../extension/src/assistant-context-menu.ts).

Drag files onto the composer or use **+ → Bifoga filer**. Up to five files can be
attached to a message, at most 10 MB each. Supported formats are PDF, Word
(`.docx`), plain text/Markdown/CSV/JSON/XML/HTML/YAML, and PNG/JPG/WebP images.
The panel shows upload and reading status; remove a failed or unwanted file before
sending. Files can be sent without text, in which case the agent asks what to do.
An upload goes to the host in chunks through a quiet request path: each chunk waits for
the host's acknowledgement, which is its smallest view, without marking the panel busy,
redrawing it or starting a poll. The start, the finish and a removal wait until no other
action is running and are then sent once, and the uploading row's ✕ works meanwhile.

Text extraction runs locally in a separate, bounded process. Image text and
scanned PDF pages use packaged Swedish OCR, without a network service. This
extracts text rather than interpreting an entire picture; OCR can misread names,
amounts and dates. PDFs are limited to 100 pages, including at most 10 scanned
pages; extracted text is limited to 500,000 characters per file. Password-protected,
damaged or unreadable documents show an error instead of invented content. Every entry
of a Word file must be stored or deflated and inflate to exactly the size the file
declares for it; the check stops at that size, so a file that inflates further is
refused before the Word reader expands it. A file whose directory lists more entries
than it declares, repeats an entry name or points to a second directory is refused too.

Originals, extracted text and the attachment index stay in the private
`assistant/attachments/` directory outside Git (100 MB total source-file capacity).
Unsent files remain tied to their conversation and are not available to the model.
After sending, every model uses the same scoped `chat_files` list/read tool;
reads are bounded and indicate omitted text. Cloud models receive the text they
read. Filenames and short previews appear in the private conversation record.
Attachments are untrusted source material and grant no extra permissions or send
approval. Clearing or deleting the conversation also removes its files.

Create, search and select conversations in the conversation list (**☰**; fixed on
the left from 768 px). Each conversation's **…** menu renames, clears or deletes it.
**Sök sparat** searches saved conversation titles/messages, active and archived
mail findings, cases, and extracted text from attachments actually sent in a
conversation. It matches all entered words, ignoring letter case, locally without
a model call or cloud request. Results show source, date and an excerpt. Open a
chat result to select its conversation and focus a matching message; an attachment
result focuses its saved message. A mail result opens its original in the configured
account, and a case result opens that case. Opening
does not start a model or restore archived mail. Unsent files and approval images
are excluded. Large collections offer **Sök vidare i fler sparade källor**;
unreadable sources show an incomplete-search warning. A search typed while the panel
is busy is kept, the latest one only, and runs when the panel is free. Each returned part is sorted
newest first. If saved sources change while paging, the cursor is rejected and the
search must restart. Deleted sources are checked again before opening.
**Rensa meddelanden** clears the selected
conversation; deleting it also removes its immediate rollback copy. Other
conversations and saved mail/tasks remain. The private `assistant/chat.json` store
migrates old single-chat records on the first write with a prior backup. It holds
up to 100 conversations, 100 messages and 400 KB per conversation, with a bounded
whole archive. Model context uses the latest 20 complete messages within 24 KB;
omitted older context is marked explicitly. Restarted pending replies become
interrupted, and actions interrupted while applying become uncertain. Neither is
replayed automatically. A large selected conversation never stops the assistant's
state from being saved; when it makes the panel's view too large to show safely, an
action may already be carried out and saved, and the panel says so without claiming the
outcome: "Begäran togs emot och kan redan vara utförd. Panelens underlag är för stort för
att visas säkert, så resultatet visas först när ett mindre samtal är valt i chatten.
Kontrollera resultatet innan du försöker igen."

Questions such as “Vilka bevakningar har jag?” show complete **Bevakningar** or
**Rutiner** cards built from Tabai's saved lists. A plain list request needs no
model; other requests can ask for the same card with `chat_saved_list`. The model
never supplies list rows. Cards reflect current saved status and offer **Öppna**
and **Pausa/Återuppta**. A changed list invalidates an older pause control rather
than applying a stale action.

On an insufficient, failed or interrupted answer whose turn is known to have
started no external action, **Fortsätt med annan modell** lets you select a model
for one continuation. It reuses the conversation and sent attachments, shows the
selected model, and keeps global defaults. This continuation can only read and
answer: it cannot start tasks, answer module questions, propose changes, fill
forms or repeat browser actions. After a possibly dispatched action, check its
actual outcome instead; continue a mail task through its own checkpoint controls.
Older replies without a reliable action record do not offer this shortcut.

**Chatta om detta** on a mail finding or case creates a conversation with that
explicit saved source and revision. It does not read a mailbox again or grant send
permission. A changed source requires selecting its current revision. Ordinary
chat receives recent conversation, relevant private memory and concise task status,
without the mailbox contents or send approvals. It can request saved configuration
when needed. The private worker's exact chat tool list is owned by
[assistant-tools.ts](../src/assistant-tools.ts); mailbox browser and send tools are
excluded in guided mode, and web tools follow [web access](assistant-web-access.md).
Optional full access adds the real Tabai MCP browser catalogue, including access
to mail sites and actions without the panel's extra approval gates. The shared-page
origin restriction above applies to the guided web tools; the full MCP route
can visit other sites.

Actual progressive text is shown when a provider emits it. Status describes real
provider/tool events; CLI modes without token events can show status before the
complete reply. Internal reasoning is not displayed. **Stoppa svar** stops the chat
turn and ignores late callbacks. An already started task remains available under
its own controls. Chat starts existing mail/calendar tasks in the initiating
panel's Chrome window; they retain all account/source checks and exact reply-card
approval. Chat itself cannot approve a send.

## Private memory and action cards

The agent can propose a reusable fact, account, daily schedule, model-role choice
or installed module start. It shows a typed card describing the change; the host
applies the stored proposal only when its exact card is confirmed. Dismissed,
applied or uncertain cards cannot be replayed. Review, edit and delete saved facts
under **Inställningar → Minne → Sparade uppgifter**. General facts apply to chat; mail and
module facts are scoped to their relevant context. Secrets belong in connection
settings, not memory or conversation.

An installed private module can be discovered and started from the chat. Its own
questions can be answered through the shared composer or exact choice buttons,
bound to that conversation, run and question. The broker reuses its existing
module process and limits operations to registered IDs and an explicit allowlist;
chat cannot choose an executable, issue a shell command or access arbitrary module
correction operations. Module business rules and final-action safeguards remain
owned by the separately installed module. The bridge does not bundle private
business code into this repository.

### Chatting about a module run

A module can take free text about a run. Its card then shows **Skriv till agenten**
with the dialogue so far, and **Chatta om ärendet** opens the conversation that
follows the run, creating it the first time. In that conversation the composer
is marked **Skriver till ärendet** and the text goes to the run, not to the chat
model. **✕** sends the next text to the ordinary chat again; **Skriv till ärendet**
on the card returns. The choice is saved with the conversation, and only these
presses set it: a run started from the chat leaves the composer alone until you
press the button. Attachments stay with the ordinary chat.

Text is accepted whenever the run is not working, including after a failure.
While it works, sending waits. The module's replies and notes are mirrored into
the conversation once, and the card moves down when the dialogue grows. A run
that is no longer open in its module refuses the text without being opened. The
chat model has no tool for this route: only the user's own send reaches it, with
one message ID that is never sent again, and the dialogue stays out of the
ordinary chat model's context. What a message may do is owned by the module.
