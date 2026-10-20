# Security

This project is intended for local development and learning only.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.** Use GitHub's private
reporting form instead:
[Report a vulnerability](https://github.com/0paquer/qoder-cli-proxy/security/advisories/new)

This keeps the report visible only to the maintainers until a fix ships. It
requires no email address from either side.

Include the affected version, what an attacker can do, and the smallest set of
steps that reproduces it. Please **do not** include real personal access tokens,
cookies, `Authorization` headers, local client auth files, or private logs — a
redacted transcript is enough.

Expect an acknowledgement within roughly a week. This is a spare-time project
with no paid maintainers and no bounty, so please be patient, and give a fix a
reasonable window before disclosing publicly.

## Threat model

The proxy is designed to be reachable **only from the machine it runs on**:

- It binds to `127.0.0.1` by default. `BIND_HOST` can change that, but a
  non-loopback bind prints a loud startup warning.
- Browser requests are accepted only from loopback origins. Any other `Origin`
  is refused with `403`, because otherwise any web page you visited could spend
  your Qoder quota from the background.
- Requests naming a non-loopback host in the `Host` header are refused, which is
  what blocks DNS-rebinding attacks.
- A `qk-` API key, once any exists, is required on `/v1/*` and `/usage/*` as
  `Authorization: Bearer <key>` or `x-api-key: <key>`. While zero keys exist
  the gateway stays open (local open mode).

Two things this does **not** protect against, by design:

- **Other processes on your own machine.** While zero API keys exist, anything
  running locally can use the proxy. Issue a key in the admin console if that
  matters to you.
- **Public exposure.** Do not bind to `0.0.0.0`, and do not put the proxy behind
  a tunnel, port forward, or reverse proxy. `ALLOWED_HOSTS` and
  `ALLOWED_ORIGINS` exist as deliberate escape hatches; if you use them, the
  security model becomes yours to review.

## Server-side tool execution

`SERVER_TOOL_EXECUTION=1` makes the proxy run the model's tool calls on your
machine, and the model is steered by whatever prompt the client sent. It is off
by default and should stay off unless your client genuinely cannot execute tools
itself. When it is on:

- File operations are confined to `SERVER_TOOL_WORKSPACE` (default: the proxy's
  working directory). Absolute paths and symlinks that leave it are refused.
- The `Bash` tool needs `SERVER_TOOL_ALLOW_BASH=1` **and** a non-empty
  `SERVER_TOOL_BASH_ALLOWLIST`. Commands run without a shell, so chaining,
  pipes, redirection, and substitution are refused.

Treat the whole feature as experimental. Enabling it widens your exposure to
anything that can reach the proxy, so pair it with an issued `qk-` API key.

## Handling your token

- Qoder account PATs are not stored in `.env`. Add accounts in the admin
  console — each PAT is encrypted (AES-256-GCM) at rest in SQLite. Never paste
  a PAT into an issue, screenshot, or third-party client.
- Logs are redacted for tokens, cookies, and `Authorization` headers, but
  redaction is a safety net, not a guarantee — read before you post.
- If you suspect your token leaked, revoke it on the official Qoder account
  page, then update it in the admin console's Accounts page (replacing a PAT
  resets the account's verification status).
