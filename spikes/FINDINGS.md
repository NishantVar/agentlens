# Spike: base-URL proxying against real claude & codex auth

Date: 2026-07-14. Machine: macOS arm64. Both CLIs installed & authenticated.
Proxy used: `spikes/passthrough.mjs` (localhost HTTP -> HTTPS upstream, strips `accept-encoding`).

- `claude`: Claude Code CLI, auth mode = **subscription OAuth** (no `ANTHROPIC_API_KEY` in env).
- `codex`: **0.144.4**, auth mode = **ChatGPT / subscription** (`~/.codex/auth.json` has `"OPENAI_API_KEY": null`, `auth_mode` + OAuth `tokens`).

---

## claude — WORKS through localhost passthrough

Command: `ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude -p "Reply with exactly: PROXY-OK" --model haiku`
Result: printed `PROXY-OK`, exit 0. All API traffic traversed the proxy.

**(a) Redirect mechanism:** `ANTHROPIC_BASE_URL` env var. Fully redirects claude's API traffic to the localhost proxy.

**(b) Auth through localhost passthrough:** YES. Subscription OAuth works unmodified — the CLI forwards its auth headers and upstream returned `200`. No API key needed; plain-HTTP localhost did not break auth.

**(c) Request path(s) seen:**
- `HEAD /` (connectivity preflight)
- `POST /v1/messages?beta=true` (the model call)

**(d) Compression after stripping `accept-encoding`:** Response came back **uncompressed** (`content-encoding=identity`). The model call is a `text/event-stream` (SSE) response — Task 6 must handle streaming SSE, not a single JSON blob.

Sample logged lines:
```
>>> HEAD / (0B)
>>> POST /v1/messages?beta=true (164869B)
<<< 200 /v1/messages?beta=true content-type=text/event-stream; charset=utf-8 content-encoding=identity
```

---

## codex — CANNOT be proxied via base-URL override under ChatGPT auth (definitive failure)

The CLI *prints* `PROXY-OK` and bills tokens, but the **model call never traverses the proxy**. Under ChatGPT (subscription) auth, codex 0.144 sends the completion over a **WebSocket to a hardcoded host** that no base-URL override affects.

### Mechanism 1 — `chatgpt_base_url` (ChatGPT-auth path): auxiliary traffic only, NOT the model call
Setup (temp `CODEX_HOME`, only `auth.json` copied — real `~/.codex/config.toml` untouched):
```
cp ~/.codex/auth.json $CODEX_HOME/
printf 'chatgpt_base_url = "http://127.0.0.1:4142/backend-api/"\n' > $CODEX_HOME/config.toml
codex exec "Reply with exactly: PROXY-OK"    # upstream = https://chatgpt.com
```
Result: `PROXY-OK` printed (12,955 tokens used), exit 0. Proxy log shows **only** plugin-store, MCP, and analytics REST calls — **no `/backend-api/codex/responses`**. Debug logging (`RUST_LOG=codex_core=debug,codex_api=debug`) reveals why: the model call is a WebSocket opened directly to the hardcoded default host, ignoring `chatgpt_base_url`:
```
codex_api::endpoint::responses_websocket: connecting to websocket: wss://chatgpt.com/backend-api/codex/responses
provider=ModelProviderInfo { name: "OpenAI", base_url: None, ... wire_api: Responses, supports_websockets: true, requires_openai_auth: true }
transport="responses_websocket"  api.path="responses"  auth_mode="Chatgpt"
```
`chatgpt_base_url` rewrote only the REST side-channels (auxiliary), never the model completion.

Sample logged lines (what DID traverse the proxy — auxiliary only):
```
>>> POST /backend-api/codex/analytics-events/events (652B)
<<< 200 /backend-api/codex/analytics-events/events content-type=application/json content-encoding=identity
>>> GET  /backend-api/ps/plugins/list?scope=GLOBAL&limit=200 (0B)
<<< 451 /backend-api/ps/mcp content-type=application/json content-encoding=identity   (plugin-store rejects proxied host)
```

### Mechanism 2 — `OPENAI_BASE_URL` (API-key path): ignored entirely under ChatGPT auth
```
OPENAI_BASE_URL=http://127.0.0.1:4142/v1 codex exec "Reply with exactly: PROXY-OK"   # upstream = https://api.openai.com
```
Result: `PROXY-OK` printed (3,156 tokens), exit 0, but the **proxy log is completely empty**. Debug shows codex still went to the ChatGPT websocket:
```
base_url: None
transport="responses_websocket"
wss://chatgpt.com/backend-api/codex/responses
```
Because valid ChatGPT auth is present (`auth_mode=Chatgpt`), codex uses the built-in OpenAI provider's ChatGPT websocket and ignores `OPENAI_BASE_URL`.

### Why no override works here
- The built-in `openai` provider cannot be overridden (`-c model_providers.openai.supports_websockets=false` -> `Error: model_providers contains reserved built-in provider IDs: openai`).
- No config flag / env var was found to disable the responses WebSocket transport (`supports_websockets` lives only on the unoverridable built-in provider; searched the native binary — no `disable_websocket` / `force_http` toggle exists).
- The WebSocket URL derives from the provider's default host (`base_url: None` -> `chatgpt.com`), not from `chatgpt_base_url`.

### Answers (a)-(d) for codex
- **(a) Redirect mechanism:** NONE effective under ChatGPT auth. `chatgpt_base_url` redirects only auxiliary REST calls; `OPENAI_BASE_URL` is ignored. The model call is a WebSocket to hardcoded `wss://chatgpt.com/backend-api/codex/responses`.
- **(b) Auth through localhost passthrough:** N/A — model traffic never reaches a localhost HTTP proxy, so there is nothing to authenticate through it.
- **(c) Model-call path:** `wss://chatgpt.com/backend-api/codex/responses` (WebSocket, not HTTP POST). Auxiliary REST paths that *do* traverse a base-URL proxy: `/backend-api/codex/analytics-events/events`, `/backend-api/ps/plugins/*`, `/backend-api/ps/mcp`.
- **(d) Compression:** N/A for the model call (WebSocket frames, permessage-deflate negotiated at the WS layer). Auxiliary REST responses came back `content-encoding=identity` after stripping `accept-encoding`.

---

## Implications for Task 6 (runtime adapters)

- **claude:** implement via `ANTHROPIC_BASE_URL` -> localhost capture proxy. Model call = `POST /v1/messages` returning an SSE stream (`text/event-stream`); parse usage from the stream. Bodies are uncompressed once `accept-encoding` is stripped.
- **codex (ChatGPT/subscription auth — this machine's mode):** the base-URL HTTP reverse-proxy approach **cannot capture the model call**. It uses a WebSocket to a hardcoded host that ignores every base-URL override. Task 6 must **fail loudly** for codex-under-ChatGPT-auth with a clear error (per the brief, do not improvise a fallback — the top-level review decides).
- **codex (API-key auth — NOT present on this machine):** untested. In API-key mode the provider `base_url` would be set from `OPENAI_BASE_URL` and calls would use the standard OpenAI Responses API over HTTP. This is *plausible* but was NOT verified here (no API key available). Do not assume it works without a real API-key test.
