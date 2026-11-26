# Security policy

Tabai is maintained by one person and provided as-is under the [MIT License](../LICENSE).
Security reports are handled on a best-effort basis, without a response-time commitment.

## Supported versions

Only the latest commit on `main` receives fixes.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, pull request or discussion for it.

Include the affected version or commit, the steps to reproduce, and what an attacker gains.

## Scope

Tabai runs on one computer and trusts that computer by design. The boundaries it enforces,
and the ones it deliberately does not, are listed in
[README → Security notes](../README.md#security-notes-v1) and
[CLAUDE.md → Security invariants](../CLAUDE.md#security-invariants-do-not-weaken).

In scope, for example:

- a web page reaching the broker ports or driving tools;
- one MCP session controlling a tab outside its own tab group;
- `navigate` opening a scheme outside its allowlist;
- a dialog being accepted without an explicit per-call request.

Out of scope, because they follow from the documented trusted-local posture:

- a native process on the same computer connecting without a token while the optional token
  is unset;
- another installed extension connecting to the extension port while no extension ID is
  pinned;
- code that the operator runs on purpose through `javascript_tool`.
