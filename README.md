# agentlens

Wire-level observability for coding-agent CLIs. `agentlens` wraps a `claude` or
`codex` invocation, captures every model request/response and its token usage,
and writes it to a global on-disk store you can query for tokens, cost, and full
prompt/response traces — grouped by agent, model, runtime, or any tag you attach.

## Install

```bash
npm install
npm run build
npm link      # puts `lens` on your PATH
```

Requires Node >= 20 and the agent CLI you want to observe (`claude` and/or
`codex`) installed and authenticated on the same machine.

## Quickstart

```bash
lens run -- claude -p "hi"
lens stats
```

`lens run` executes the command after `--` with capture enabled, streaming the
child's stdio through untouched. When it exits, a one-line summary is printed to
stderr and the session is committed to the store. `lens stats` then aggregates
everything captured so far.

## Commands

### `lens run [--tag k=v ...] -- <agent command>`
Runs a coding-agent CLI with capture. Everything after `--` is the verbatim
command (e.g. `-- claude -p "hi" --model haiku`). The first token selects the
runtime adapter (`claude` or `codex`); anything else is rejected.
- `--tag k=v` — attribution tag, repeatable (`--tag agent=reviewer --tag run=42`).
Capture is **fail-open**: if the proxy or log collection fails, the agent still
runs to completion and its exit code is preserved; only the observability data is
lost, never the run.

### `lens import [--runtime claude|codex] [--since <dur>] [--tag k=v ...] [--json]`
One-shot, idempotent backfill of sessions that were NOT wrapped by `lens run`:
claude's native transcripts (`~/.claude/projects/**/*.jsonl`, override with
`AGENTLENS_CLAUDE_PROJECTS`) and codex's rollouts (`~/.codex/sessions`, override
with `AGENTLENS_CODEX_SESSIONS`). Sessions are deduped by native session id —
both against previous imports and against sessions already captured by
`lens run` — so re-running is safe. `--since` bounds the scan by the log's own
start time; `--tag` tags every session imported in the batch (`AGENTLENS_TAGS`
still wins on collision). Timing, cwd, models, and token usage all come from
the logs themselves. Prints `imported N, skipped M (already present), skipped
K (empty)`.

### `lens stats [--by <key>] [--tag k=v ...] [--since <dur>] [--runtime <rt>] [--json]`
Aggregates token counts and estimated cost.
- `--by <key>` — group rows by `agent`, `model`, `runtime`, `run`, `stage`, or any
  tag key. Omit to get a single `(all)` row.
- `--tag k=v` — filter to sessions carrying this exact tag (repeatable, AND-ed).
- `--since <dur>` — only sessions started within the window: `7d`, `24h`, `30m`.
- `--runtime claude|codex` — filter by runtime.
- `--json` — machine-readable output (`{ rows, generatedAt }`).
Cost is derived per model from the pricing table (see below); events whose model
has no known price are excluded from cost and flagged in a footnote.

### `lens sessions [--tag k=v ...] [--since <dur>] [--json]`
Lists captured sessions (newest first) with id, start time, runtime, tags,
request count, total tokens, and exit code. Same `--tag` / `--since` filters as
`stats`. `--json` emits the raw index entries.

### `lens report [sessionIds...] [--tag k=v ...] [--out <path>]`
Generates a single self-contained HTML file with the full conversation and raw
request/response bodies for the selected sessions. Select sessions by explicit
ids or by `--tag` (all matching sessions). `--out` sets the output path (defaults
to `lens-report-<id>.html`). Open the file in any browser — no server needed.

### `lens dashboard [--port <n>]`
Starts a live local dashboard (default `http://127.0.0.1:4040`) showing active
sessions, per-agent totals, and recent runs. `--port` changes the port. It serves
`/` (HTML) and `/api/data` (JSON) reading the same store live.

## Tags and attribution

Tags are arbitrary `key=value` labels attached to a session at capture time and
used for filtering and grouping. Two sources:
- `--tag k=v` flags on `lens run` (repeatable).
- `AGENTLENS_TAGS` environment variable, a comma-separated list
  (`AGENTLENS_TAGS="agent=reviewer,run=42,stage=review"`).

**Env wins.** When both are present, keys from `AGENTLENS_TAGS` override the same
key passed via `--tag`. This is deliberate: an outer orchestrator (e.g. flux) sets
`AGENTLENS_TAGS` in the child environment so that even if the launched agent
itself shells out through `lens run` with its own `--tag`, the outer run's
attribution is preserved down the spawn tree. See `docs/flux-integration.md`.

## Store layout

All sessions land in one global store, independent of the directory you run from:

```
~/.agent-obs/                 (override with AGENTLENS_HOME)
├── index.jsonl               one line per finalized session (the query index; carries nativeSessionIds for import dedup)
├── pricing.json              optional pricing overrides (see below)
└── sessions/<id>/
    ├── meta.json             runtime, capture mode, tags, cwd, argv, timing
    ├── events.jsonl          normalized per-call token usage
    ├── raw.jsonl             full request/response pairs (proxy mode)
    ├── rollout-N.jsonl       copied native rollout(s) (logs mode / codex)
    └── transcript.jsonl      copied native claude transcript (imported sessions)
```

- `AGENTLENS_HOME` overrides the store root (used for tests and isolated runs).
- The store root is `chmod 700` on write.
- **Traces contain full prompts and responses — treat the store as sensitive.**
  `raw.jsonl` and the codex rollout copies include everything the agent sent and
  received.

## Pricing overrides

Cost estimates use a built-in per-million-token price table (Claude Opus/Sonnet/
Haiku, GPT-5). To override or add models, create `~/.agent-obs/pricing.json`:

```json
{
  "claude-haiku-4": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 },
  "my-model":       { "input": 2, "output": 8, "cacheRead": 0.2, "cacheWrite": 0 }
}
```

Prices are USD per 1M tokens. Model matching is longest-prefix, so a key like
`claude-haiku-4` matches `claude-haiku-4-5-20251001`. User entries merge over (and
override) the built-ins.

## Supported runtimes

agentlens captures two runtimes through two different mechanisms, because the two
CLIs expose their model traffic very differently:

- **claude — proxy mode.** `lens run` starts a localhost reverse proxy and points
  the CLI at it via `ANTHROPIC_BASE_URL`. All `/v1/messages` traffic (an SSE
  stream) flows through the proxy, where it is recorded to `raw.jsonl` and
  normalized into token-usage events. Subscription-OAuth auth works unmodified
  over the plain-HTTP localhost hop.

- **codex — logs mode.** codex under ChatGPT/subscription auth sends its model
  call over a **WebSocket to a hardcoded host** that no base-URL override
  redirects (`OPENAI_BASE_URL` is ignored; `chatgpt_base_url` only moves auxiliary
  REST calls). A capture proxy therefore cannot see the completion — see
  `spikes/FINDINGS.md` for the definitive investigation. Instead, agentlens reads
  codex's own native session rollout logs (`~/.codex/sessions/**/rollout-*.jsonl`)
  after the run, filtered to rollouts written during the run window and matching
  the run's cwd, and extracts token counts from their `token_count` events.

### Adding a runtime

A runtime is a `RuntimeAdapter` in `src/runtimes.ts`, one of two shapes:

- **Proxy adapter** (`mode: 'proxy'`): declare the `upstream` host, an `env()`
  that returns the environment variables which point the CLI at the proxy origin,
  and a `normalize()` that turns a captured request/response pair into a
  `ModelCall` (model + usage). Register it in `adapters` and add its binary name
  to `detectRuntime`.
- **Logs adapter** (`mode: 'logs'`): implement `collect(startedAt, opts)` to find
  and parse the CLI's native session logs written during the run window, returning
  each session's rollout path and normalized events.

Use proxy mode when the CLI honors a base-URL override; fall back to logs mode
when it does not (as with codex).
