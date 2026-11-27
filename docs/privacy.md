# Tabai privacy policy

Effective date: 2026-11-27

Tabai connects a locally running MCP server to Chrome so you can direct an MCP
client or the optional assistant to operate browser tabs in its session.

## Data used for browser operations

An operation can handle the selected tab's URL, title, page text, accessibility
and form data, screenshots, network or console information, web storage, cookies,
and the files or input you choose for that operation. The extension sends
requests and results to the local Tabai host over an unencrypted loopback
WebSocket on this computer.
The host returns results to the MCP client that requested the operation. How
that client processes results depends on its configuration and provider.

Tabai has no maintainer-hosted browser relay, analytics service or advertising.
The extension stores its bridge settings, optional token, session identity and
preferences in Chrome. The local host stores history, logs, recipes and files in
its local data directory. Browser operations and local records serve the task you
select and let you inspect results and connection problems.

## Optional assistant and third parties

When you use the assistant, it may process your prompts, attached files, saved
preferences, selected pages, and mail or calendar content from accounts you
configure. The local host also stores conversations, results and the watches or
routines you enable. Scheduled tasks run according to the settings you choose.

If you select a cloud assistant, task content is sent to the provider you choose
from OpenAI/Codex, Anthropic/Claude or Berget.ai. The local Ollama option sends
inference requests to Ollama on this computer. Websites receive the requests
needed for the actions you direct. The guided search feature can send search
queries to DuckDuckGo or Bing. Use of those sites and cloud providers is subject
to their own policies. Tabai does not sell the data it processes.

## Local storage and controls

You can stop Tabai, remove the extension, disable optional features, or remove
local records. Uninstalling the extension and uninstalling the npm package are
separate actions. Local records can remain in the Tabai data directory until
deleted. Use the provider's controls for copies it processes or retains.

Release packages bind to loopback and use the Chrome Web Store extension ID as
the default Origin pin. Local token authentication is optional. Local trust
boundaries and file locations are documented in the project. [Security notes](https://github.com/NAlle33/tabai#security-notes-v1)

## Privacy questions

For general questions about this policy, use [GitHub Issues](https://github.com/NAlle33/tabai/issues).
Issues are public. Keep personal information, browser content and credentials out
of issue reports. For a security vulnerability, use the project's [private
reporting route](https://github.com/NAlle33/tabai/security/advisories/new).
