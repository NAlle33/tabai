# Assistant web access

Part of the [daily assistant](daily-assistant.md) guide.

**Inställningar → Webbåtkomst** is off initially.

## Full Tabai access

**Full Tabai-åtkomst för agenter** is a separate, optional choice on this page,
off by default. It gives Codex, Claude, Berget and local models the ordinary
Tabai MCP browser catalogue, including JavaScript evaluation, cookies, storage,
uploads, downloads, screenshots, PDF, batches and recipes. It applies to chat,
mail tasks, watches and routines. The previous guided settings remain saved;
turning full access off restores their effect.

Full access uses your normal Chrome profile in its own session-owned tabs. The
panel's extra site, local-network, login and final-action gates do not apply to
this route. An agent can carry out requested purchases, sends or deletions
without a panel approval card. Mail and signed-in sites are accessible through
the same raw browser tools. Page content remains untrusted evidence, never an
instruction or authorization to act.

The ordinary MCP boundaries still apply: agents cannot adopt your existing
tabs, navigation accepts only http(s) and `about:blank`, the foreground preference
still controls focus, and uncertain actions are never replayed. No terminal or
general filesystem tools are enabled. Uploads require an already known local
path. Codex and Claude receive MCP image blocks; the current local and Berget
connections read text and are told to use page-reading tools when a call returns
an image.

The private worker exposes `mcp_browser_tools` to discover the real server's tool
names and exact schemas (paginated, or one tool by name), and `mcp_browser_call`
to call one. The ordinary MCP server validates the arguments; no browser schema
catalogue is copied into the assistant. Native provider tools remain disabled.
Chat keeps its full-access session between turns. Other runs close theirs on
completion. Changing the web settings, stopping full-access work, deleting its
conversation, or 30 minutes of inactivity closes the owned session. Revocation
prevents further calls; an action already dispatched cannot be undone.

The guided `web_*` and mail workflow tools retain their original checks even
when full access is on. Their saved findings still require verified mail
observations; raw MCP reads do not substitute for that evidence. The full-access
activity record names the called tool without storing arguments or secrets.

## Guided access

**One setting for every model.** It applies to every model choice: Codex, Claude,
Berget and local inference receive the same web tools through Tabai, with the same
descriptions, and the host checks every call the same way. Codex's own web search
and Claude Code's built-in tools stay disabled. The lists per level are owned by
[assistant-tools.ts](../src/assistant-tools.ts); the gates by
[assistant-web.ts](../src/assistant-web.ts).

**Levels:**
- **Söka och läsa:** search, open http(s) pages and read their text and controls.
- **Agera med godkännande:** also click and fill in forms.

**What the guided web tools refuse:**
- **Mail and calendar.** Web tools refuse the mail and calendar services, compared
  by host name (including `outlook.cloud.microsoft`), so the reply-card send
  approval cannot be bypassed.
- **Local network.** Loopback, private and local-only addresses are refused, also
  where a redirect lands. That includes host names without a dot, which the local
  search domain or router answers, names with an empty label or trailing dots, and names
  under suffixes no public registry delegates, such as `.local`, `.lan`, `.home`, `.corp`,
  `.intranet` or `.test`; the list is `assistantWebLocalHost` in
  [assistant-web.ts](../src/assistant-web.ts).
- **Final steps.** A step that looks final is never clicked directly: buy, pay,
  order, send, book, sign, confirm, delete, moderation and account-state controls
  (reject, decline, pause, deregister, suspend, block, disable, archive, revoke,
  approve), a submit of a non-search form, or any button on a page with visible
  payment fields. On an administration page (for example a path with `/admin`),
  every control button needs approval; ordinary links still navigate. Cookie banners pass only with
  their own consent words. The host creates an approval card instead. It shows
  the site, the button, the amount found on the page and the choices the form
  would send, with secrets masked.
- **Secrets.** Passwords, card fields and one-time codes are refused, also where the
  field's `autocomplete` carries a section or billing prefix before the token, and login
  submits are left to the user. The agent hands the tab over (`web_handover`) and
  continues when the user says it is done.

**Search.** Search uses DuckDuckGo's HTML page. When it returns no results, Bing
is used instead, with the same address filters, and the activity names the engine.

**Isolated checks.** The host reads elements, form choices, amounts and search
results in an isolated script world (`javascript_tool` with `world: "isolated"`),
so a page cannot override the DOM functions those checks use. If the isolated
world cannot be created, nothing runs; there is no fallback to the page's world.

**Receipts.** After an approved step, Tabai prints the resulting page to PDF and
attaches it to the conversation as a file, readable with `chat_files`. If
printing fails, the message says so; the step is never repeated.

**Mina uppgifter.** **Inställningar → Minne → Mina uppgifter** stores your details
privately in `assistant/profile.json`: name, address, phone, email and up to six
extra fields. Card numbers, passwords, codes and key-like values are refused. At
**Agera med godkännande** the agent reads them only through `chat_profile`, which
is recorded as web activity together with where they go:
- with a cloud chat model, the provider (OpenAI, Anthropic or Berget) receives
  them;
- with local inference they stay on the computer.

In every turn of a conversation, searches, addresses and search-form fields that
contain them are refused. The check matches the words of each value in any order,
spacing or URL encoding, and phone numbers by their last eight digits. It is a
heuristic: a value rewritten beyond that can pass.

**Kolla upp avsändaren.** On a mail item in Mejl, or in a case's mail list for
items loaded in Mejl, this button starts a conversation about the sender's
organisation. Only the domain leaves the mailbox: the conversation gets no mail
text and no item context. The lookup turn reads like a mail task:
- search and read only, whatever the chat level;
- its own incognito window, without fallback;
- only its own search results are opened;
- every search must contain the domain.

Private mail services (Gmail, Outlook, iCloud and similar) are refused, since the
lookup is for organisations, not people. Web access must be at least **Söka och
läsa**.

**Hitta billigast.** The empty chat's quick choice **Hitta billigast** puts
"Hitta billigast: " in the composer. At either level the agent searches, opens each
shop's own product page and shows the result with `chat_compare`: the user's search
and at most eight rows, each with shop, product, price, shipping when the page shows
it, a three-letter currency code and the page's address. The host checks every row
against the pages the turn read ([assistant-agent.ts](../src/assistant-agent.ts),
`AssistantComparePages`), taken from the turn's own record of web calls, never
from message text:
- the address must name a page this turn read with `web_open` or `web_read`; a
  fragment is ignored. The page's own address counts. The address `web_open` was
  asked for counts too when the page that loaded is an http(s) page on the same
  site (the same host, `www.` aside), as after a redirect within the shop. A
  request that ended on `about:blank` or on another site counts only by the page
  it ended on;
- the price must be an amount in the text that page returned to the model: its
  text, title and listed elements, and `web_find` matches on it. Amounts are read
  the way shops write them: spaces and no-break spaces group thousands, `,` or `.`
  is the decimal point or groups thousands by the digits after it, and `kr`, `:-`,
  `SEK` or `€` change nothing, so "1 249 kr", "1249:-", "1 249,00 SEK" and
  "€12.99" all count. A row whose price is not there is refused with "Priset {x}
  står inte på sidan {url} som lästes. Läs om sidan eller ta bort raden.";
- amounts are finite and not negative, and all rows share one currency;
- one comparison per turn.

A refused call names each row to fix, so the model can open the page or leave the
row out. The card ("Prisjämförelse: <search>") lists the shops by price plus
shipping, cheapest first and marked **Billigast**, under the line "Priser lästa kl.
HH:MM. Kontrollera i butiken innan du köper." Shipping is shown only as the page
shows it: an amount on the page, or free (0) when the page says so next to a
shipping word ("Fri frakt", "Gratis frakt", "Fri leverans", "Fraktfritt", "Frakt:
gratis", "Frakt 0 kr"). A free word about something else, such as "Fri retur" or
"Gratis inslagning", is not free shipping. Shipping the page does not show, or one
the model gave that is not on it, is shown as **Okänd**: the shop counts with its
price alone, the card says so, and the model is told.

Known limits of the check: it stops invented amounts, not mixed-up ones. Any
amount on the page counts, so a similar product's price or the threshold in "Fri
frakt över 499 kr" (which also counts as free shipping) can pass. A number in a
field the page lists counts too, including one the turn filled in itself. A
small number right before a price on the same line, with one space between, is
read as its thousands ("Köp 3 299 kr" reads as 3 299), so the real price 299 is
refused; that only drops a shop, never shows a wrong price.

Each row has:
- **Öppna:** an ordinary tab in the panel's window, opened by the panel, never one
  of Tabai's web tabs;
- **Bevaka priset:** the ordinary new-watch card for that page, with the condition
  "Säg till när priset är under <price> kr" every six hours, from the checked
  price. It is checked like any watch card, also against the saved watches, and
  shows the capacity warning when it applies. A page that is already watched gets
  no card: the tap answers "Du bevakar redan den här sidan: {titel}." A second tap
  while its card waits finds that card.

A comparison only reads. The prompt says so, and once the card is shown the host
refuses `web_click`, `web_fill` and `web_handover` for the rest of the turn; a
purchase is a later message and goes through Godkänn. Local models are offered
`chat_compare` only after the turn has opened a page, and only with the addresses
it opened or read. Later turns read the comparison's rows as text.

**Pending cards.** Once a card is waiting, the turn may only read and then reply.
Any later click, fill or navigation on that tab cancels the card.

**Image on the card.** When the host creates a card it also takes an image of the
button and its form with the extension's existing screenshot tool: the area in
the same tab and document, with a margin, at most 1200×900 CSS pixels, as a JPEG
of at most 1 MB. It shows what the page renders, so password fields stay masked
as the page masks them; no value is read out for it. It is saved as a host file
of the conversation (`source: 'approval'`), is never a draft, is never read as
text by any model, and is removed with the conversation. The panel fetches it
once, outside the polled view, shows it under the card's title with the alt text
"Bild av det som klickas på <sajt>" and enlarges it on a tap. **The image is
information only:** the approval stays bound to the tab, address, document,
button text, amount and form state, all checked again before the click. A
failed capture, a changed document or more than 3 seconds gives a card without
an image that says "Ingen bild kunde tas."

**After Godkänn.** The host re-checks the tab, address, document, button text,
amount and every form choice, then clicks exactly once. A changed page fails
without a click. A dispatch failure is reported as uncertain and is never
retried. A changed web setting closes the tabs, cancels pending cards and ends
web access for a reply already running.

**Login.** **Får logga in** is off initially. While it is off, login forms stay
closed. Web tabs open in a separate incognito window when Tabai is allowed in
incognito (`chrome://extensions` → Tillåt i inkognito). Chrome shares that
profile across incognito windows. Without the permission the tabs open in normal
Chrome, and the activity and the agent's reply say that existing sign-ins are
visible.

**Tabs.** One conversation's web tabs live in their own Tabai session. They stay
open between turns for approvals and handovers, and close after 30 idle minutes,
when the conversation is deleted or when the setting changes. Each reply lists
the pages opened and fields filled as **Webbaktivitet**.

**Routines.** A chat routine runs while nobody is at the computer, so its web
tabs always use their own incognito window and stop without the permission
instead of falling back; the routine then says that it could not run because
Tabai is not allowed in incognito. A routine reads at most and may open any
public page, not only its own search results
([Routines](assistant-watches-and-routines.md#routines-rutiner)).

**Mail tasks.** **I mejluppdrag** is a separate choice, off initially:
- **Söka och läsa i uppdrag jag startar**;
- **Söka och läsa även i automatiska kontroller**.

Mail tasks never click or fill on the web, and send runs never get web tools.
Their web tabs always use their own incognito window and stop without the
permission instead of falling back. They open only addresses from their own
searches, never a link from mail. The task policy also forbids putting mail text
into a search. Web pages cannot be cited as finding sources. The host appends the
pages visited to the task record however the task ends. With the choice off, the
task policy and tool list are unchanged.

**Limits:**
- The final-step check is a heuristic and can miss an unusual button.
- A page's visible text and markup are its own; the isolated world prevents
  overridden DOM functions, not misleading content.
- A page or mail can try to trick the agent into putting text into a search or
  address. Tabai limits and records that but cannot rule it out.
- An email-first login page without a password field is not recognised as a
  login.
- A public name that resolves to a private address is not caught.

Choose the lowest level that is enough.
