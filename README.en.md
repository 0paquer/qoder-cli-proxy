# Qoder CLI Proxy

A multi-account gateway that turns your Qoder CLI subscription into a local OpenAI / Anthropic-compatible API.

[中文说明](README.md)

## Disclaimer

This project is only for personal-account local compatibility experiments and protocol adapter research.
Users must hold their own lawful Qoder account and Personal Access Token.
This project does not provide, share, resell, rent, or transfer any Qoder account, Token, or quota.
Do not deploy this project as a public service, community endpoint, commercial API, relay service, or multi-user shared service.
Do not use this project to bypass Qoder's official billing, risk controls, rate limits, regional restrictions, or usage restrictions.
Please comply with Qoder's official terms of service. If official rules do not allow your use case, stop using this project immediately.
This project is not affiliated with Qoder.

## Project Scope

This project adapts the Qoder CLI (`qoderclicn` or `qodercli`) into a local-only OpenAI / Anthropic-compatible HTTP interface. Chat execution is driven entirely by [@qoder-ai/qoder-agent-sdk](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk) — the SDK spawns the same CLI process underneath, accelerated by a warm-pool — while the layer above provides full multi-account gateway capabilities (scheduling, quotas, audit, console).

It is not an official API, does not imply official authorization, and does not provide account, Token, or quota services. All model calls depend on the user's own Qoder authentication.

Two backends are supported:

- **CN backend**: `qoderclicn`, connecting to qoder.com.cn
- **Global backend**: `qodercli`, connecting to qoder.com

## Core Features

- **Account pool**: multiple Qoder accounts (each with its own PAT, AES-256-GCM encrypted in SQLite) scheduled by weighted random; effective weight = configured weight × quota factor (remaining / total), so exhausted accounts drop to zero weight automatically. Per-account concurrency limits, automatic failover, and exponential-backoff cooldowns; persistent quota-exhaustion failures cool down for 1 hour on the first occurrence
- **Quota & rates**: per-account quota breakdowns queried through the SDK control protocol (streaming input produces no messages — zero credit consumption), refreshed server-side every 10 minutes; model list carries credit rates (`rate` / `is_free`)
- **Warm process pool**: a few prewarmed CLI processes give ~3 s hot responses (vs. 12-17 s cold start); each process serves one request and is discarded — no cross-request context sharing
- **Users & keys**: multiple gateway users, `qk-`-prefixed API keys per user, per-user account grants and quotas (daily/monthly, requests/tokens); keys can be revealed after creation (encrypted copy stored)
- **Usage audit**: every call records model, account, user, token usage, duration, and error code (SQLite, no prompt bodies)
- **Dual protocol egress**: OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`, both with streaming and tool-call field adaptation
- **Admin console**: accounts, users & keys, usage statistics, playground, API test, settings

## Quick Start

Requires Node.js 18+.

**Step 1: install the CLI**

CN backend (required):

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

Global backend (optional):

```bash
npm install -g @qoder-ai/qodercli
qodercli --version
qodercli login   # must log in once
```

**Step 2: configure**

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` (optional, for port and gateway auth basics):

```env
# Choose backend: "cn" or "global"
CLI_BACKEND=cn

# Gateway API key (recommended, protects your Qoder quota)
PROXY_API_KEY=
```

> **Qoder account PATs do NOT go into `.env`.** After starting, add accounts
> in the admin console (Accounts page). Each account's PAT is encrypted
> (AES-256-GCM) and stored in SQLite. CN PAT page:
> https://qoder.com.cn/account/integrations

Store tokens securely. Do not commit `.env` to Git, and do not enter your Token into third-party clients or share it with others.

**Step 3: start**

```powershell
npm start
```

On Windows you can also double-click `start-proxy.cmd`. Default address: `http://127.0.0.1:3000` (`PORT` is configurable).

On first start the proxy creates `data/` (SQLite database + AES master key), runs migrations, and seeds a default admin account:

> **The default admin is `admin` / `admin123`. Change the password immediately after first login.** Do not bind the proxy to a non-loopback address before the default password is changed.

**Step 4: verify**

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

A model reply means the chain works. The admin console is at `http://127.0.0.1:3000/ui` (`.\start-ui.cmd` opens it in your browser).

## Local Client Adaptation

### OpenAI-Compatible Interface

- Base URL: `http://127.0.0.1:3000/v1`
- API Key: the `PROXY_API_KEY` you set in `.env`; if you did not set one, any placeholder works (e.g. `not-used`)
- Model: select from `/v1/models` or enter a model ID manually

Do not enter your Qoder Token into the client. Keep the Token only in this project's local `.env`.

### Anthropic-Compatible Interface

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "your-PROXY_API_KEY"   # any value if PROXY_API_KEY is unset
```

Do not append `/v1` to `ANTHROPIC_BASE_URL`; clients usually add API paths automatically.

### OpenCode Example

The repository includes `opencode.json` for local compatibility verification:

```powershell
opencode run --model qoder-cn-local/qwen3.8-max --variant high "reply OK"
```

If you set `PROXY_API_KEY`, replace `not-used` in `opencode.json`'s `options.apiKey` with your key.

## Admin Console

Open `http://127.0.0.1:3000/ui` after starting. Login credentials live in the local SQLite database; a regular user with zero grants cannot call the gateway.

| Page | Description |
|------|-------------|
| Dashboard | Today / cumulative calls, account and key overview |
| Accounts | Add Qoder accounts (PAT encrypted), verify by loading the model catalog (zero token cost), quota breakdowns (bucketed, auto-refreshed in the background), weight / concurrency / cooldown state |
| Users & Keys | Gateway user management, `qk-` API key issuance and revocation, per-user account grants and quotas |
| Usage | Statistics by day / model / user / account, plus per-call details |
| Playground | Real chat against a chosen account (streaming toggle) |
| API Test | Paste an API key and exercise the full gateway path (auth → scheduling → quota → SDK call) |
| Settings | Visual runtime configuration (port, bind host, CLI backend, …) with automatic restart on save |

Usage data is stored in the local SQLite database (`data/qoder-proxy.db`) and contains metadata only (model, token counts, duration, error codes) — **prompts and responses are never stored**. Token counts come partly from upstream and partly from local estimation (marked `estimated`); no accuracy is claimed. The console never displays PAT plaintext (fingerprints only).

## How It Works

`qoderclicn` and `qodercli` are command-line tools that accept text input and return text output; many local clients expect an OpenAI or Anthropic-format HTTP API. This project acts as a local adapter: it receives compatible API requests, converts them into CLI session calls through the Agent SDK (prompt over the stdin streaming protocol, warm pool supplying hot processes), and converts CLI output back into compatible responses.

Supported local protocol formats:

- **OpenAI-compatible format**: `/v1/chat/completions`
- **Anthropic-compatible format**: `/v1/messages`

Both formats include tool-call field adaptation (`tool_calls` / `tool_use`) for compatibility research. Reliability depends on whether the underlying model consistently emits valid JSON.

### Tool Call Implementation

Because the CLI only handles text and has no native tool-calling channel, this project implements tool-call adaptation through prompt format instructions and output parsing: tool definitions are added as formatting guidance, then JSON tool calls are extracted from model text output.

This is different from calling official OpenAI, Anthropic, DeepSeek, or similar APIs. Official APIs usually provide a native `tools` parameter channel. This project only simulates protocol behavior at the text layer and should not be treated as an equivalent replacement.

### Streaming

When a client requests `stream: true`, this project uses the CLI's `--output-format stream-json` for incremental streaming and forwards text as local SSE events in real time — including requests that declare tools. For tool-declared requests the prose part streams immediately through a safety gate that withholds any tail which could still be or grow into the tool-call JSON block (unclosed or closed ` ```json ` fences, unbalanced or `"tool_calls"`-bearing JSON objects, trailing partial backticks); once the stream completes, the withheld tail is parsed and tool calls are appended as structured `tool_calls` / `tool_use` blocks. Agent clients such as Claude Code therefore show live progress while structured tool calling stays intact.

Exception: with `SERVER_TOOL_EXECUTION=1` (server-side tool execution), tool-declared streaming requests stay on the buffered path.

### Current Limitations

- Tool calls are implemented through prompt format instructions and text parsing, not native model capability; if the model emits invalid JSON or refuses the tool format, the response falls back to plain text
- In streaming mode, the tool-call JSON part is appended once at the end of the stream (incomplete JSON cannot be parsed early); an unclosed fenced code block in a normal reply is withheld until its fence closes (conservative gate: delayed display, never leaked tool JSON)
- Each request uses a dedicated CLI subprocess; the warm pool is on by default to eliminate cold starts (`QODER_WARM_POOL=0` disables it — every request then cold-starts for 12-17 s)
- Streaming responses do not carry per-chunk usage from upstream; the server records usage via tracker/estimation (marked `estimated`)

## Configuration Reference

### Dual Backend Switching

Switch backends via `CLI_BACKEND` in `.env`; restart to take effect:

| Setting | CN Backend | Global Backend |
|---------|------------|---------------|
| CLI command | `qoderclicn` | `qodercli` |
| Auth method | Personal Access Token | `qodercli login` (OAuth) |
| Auth directory | `~/.qoderworkcn` | `~/.qoder` |
| PAT config | Accounts page in the admin console (AES-256-GCM encrypted in DB) | Not required (auto-auth after login) |

### Reasoning Options

Global defaults via environment variables:

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

Or specify per request via `reasoning_effort`, `context_window`, and `max_tokens`.

### Other Environment Variables

- `PORT` / `BIND_HOST`: listen port and address (default `127.0.0.1:3000`)
- `QODERCN_TIMEOUT_MS`: per-request timeout in milliseconds. Proxy prompts plus model queueing can take several minutes, so keep this generous (default 300000; `.env.example` suggests 600000)
- `QODERCN_CLI_TOOLS`: the CLI's built-in tools are disabled by default (`--tools=` is appended) so the model answers directly instead of running file/shell loops in the proxy's own directory. Set to `1` to keep them
- Warm pool: `QODER_WARM_POOL=0` disables it entirely; `QODER_WARM_POOL_SIZE` / `QODER_WARM_POOL_MAX_TOTAL` / `QODER_WARM_POOL_TTL_MS` / `QODER_WARM_POOL_READY_MS` tune size, cap, TTL, and the maturity threshold (see `.env.example`)
- Diagnostics: `LOG_REQUESTS=1` logs every failed request (redacted)

### Supported Models

`qoder-cn`, `auto`, `ultimate`, `performance`, `efficient`, `lite`, `cantus`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `kimi-k3`, `kimi-k2.7-code`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`

Reasoning effort aliases: `qwen3.8-max-effort-low`, `-medium`, `-high`, `-max`, and `qwen3.7-max-effort-low`, `-medium`, `-high`, `-max`

## API Endpoints

With `PROXY_API_KEY` set, `/v1/*` and `/usage/*` require the key; `/health` does not.

| Method | Path | Key required | Description |
|--------|------|------|------|
| GET | `/health` | No | Health check |
| GET | `/v1/models` | Yes | Model list (with credit rates) |
| POST | `/v1/chat/completions` | Yes | OpenAI-compatible chat with tools field adaptation |
| POST | `/v1/messages` | Yes | Anthropic-compatible chat with tool_use field adaptation |
| POST | `/v1/messages/count_tokens` | Yes | Token estimation |
| GET | `/usage/local` | Yes | Local usage estimate |
| POST | `/usage/reset-local` | Yes | Reset local usage statistics |

## Security Boundaries

- Binds to `127.0.0.1` by default. `BIND_HOST` can be changed, but a non-loopback bind prints a loud startup warning
- **Cross-origin browser requests are refused** (loopback origins only). Otherwise any web page you visit could call the proxy in the background and spend your Qoder quota
- **Requests naming a non-loopback `Host` are refused**, which blocks DNS rebinding (binding `0.0.0.0` without `ALLOWED_HOSTS` disables this protection — the startup log warns about it)
- The admin console `/admin/*` requires login; the login endpoint is rate-limited in memory (5 failures within 60 s locks the IP for 15 minutes)
- With `PROXY_API_KEY` set (or any API key existing), `/v1/*` requires the key. This project exposes **no unauthenticated endpoint that returns any key**
- Account PATs and API keys are stored AES-256-GCM encrypted under `data/` (master key `data/.secret-key`, generated on first start). `data/` is excluded by `.gitignore` — **never commit, back up, or distribute that directory**
- Logs redact tokens, cookies, Authorization headers, and other sensitive data; `.env`, `data/`, and logs are excluded from version control

Worth stating plainly: **without `PROXY_API_KEY`, any process on your machine can use the proxy.** Loopback binding keeps out the network, not your own machine. Setting a key is recommended.

### Client Authentication (PROXY_API_KEY)

Once set in `.env`, clients must send the key as:

```text
Authorization: Bearer <PROXY_API_KEY>
```

or, as Anthropic-style clients prefer:

```text
x-api-key: <PROXY_API_KEY>
```

Leave it empty to require no key. `/health` is always open so scripts can probe liveness.

If a local web app legitimately needs browser access, allow it explicitly with `ALLOWED_ORIGINS`; if you deliberately reach the proxy under another hostname, use `ALLOWED_HOSTS`. Both default to empty — once you use them, reviewing the security model becomes your job.

### Upstream Authentication

| Backend | Auth Method | PAT Config |
|---------|------------|--------------------|
| CN (`qoderclicn`) | Personal Access Token | Accounts page in the admin console (AES-256-GCM encrypted in DB, per account) |
| Global (`qodercli`) | OAuth login (`qodercli login`) | Not required |

### Server-Side Tool Execution (off by default)

`SERVER_TOOL_EXECUTION=1` makes the proxy run the model's tool calls **on your machine**, and the model is steered by whatever prompt the client sent. Keep it off unless your client genuinely cannot execute tools itself. When enabled:

- File operations are confined to `SERVER_TOOL_WORKSPACE` (default: the proxy's working directory). Absolute paths and symlinks leaving it are refused
- The `Bash` tool additionally requires `SERVER_TOOL_ALLOW_BASH=1` **and** a non-empty `SERVER_TOOL_BASH_ALLOWLIST`. Commands run without a shell, so chaining, pipes, redirection, and substitution are refused
- On Windows, skipping the shell means `.cmd`/`.bat` shims (such as `npm`) cannot run — only real executables (`node`, `git`, `python`)

Treat the feature as experimental, and pair it with `PROXY_API_KEY`.

## Compliance & Safety

### Abuse Policy

- No public deployment
- No multi-user sharing
- No API resale
- No bypassing official billing, risk controls, rate limits, regional restrictions, or usage restrictions
- No collecting, storing, or forwarding other people's Tokens
- No providing, sharing, renting, reselling, or transferring accounts, Tokens, or quota

### Safety Recommendations

- Use only on your own machine, bound to `127.0.0.1`
- Change the default admin password (`admin` / `admin123`) immediately after first login
- Do not bind to `0.0.0.0` and do not expose the service to the public internet; if LAN access is truly needed, set `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` and keep `PROXY_API_KEY` configured
- Do not send your Token — or the `data/` directory (it holds the encryption master key) — to anyone
- Do not commit `.env` to Git
- If you suspect a Token leak, revoke the PAT immediately from the official Qoder account page and create a new one

### Reporting a Vulnerability

Please do not use public issues for vulnerabilities. Use GitHub's private reporting form:
[Report a vulnerability](https://github.com/avaritiachaos/qoder-cli-proxy/security/advisories/new).
See [SECURITY.md](SECURITY.md) for details.

## Testing

```powershell
npm test
```

## License

MIT. See [LICENSE](LICENSE).
