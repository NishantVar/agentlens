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

If `lens run` is stopped by SIGHUP (a closed pane or terminal), SIGTERM or
SIGINT, it still saves the session. It never passes the signal on to the
agent. Closing a pane signals the agent directly; a stop sent only to
`lens run`, such as `kill <pid>`, does not reach the agent. `lens run` takes
a last look for Codex rollouts and waits up to `AGENTLENS_SIGNAL_GRACE_MS`
(default 3000) for the agent to exit. It then saves and exits with the
agent's status, or 128 + signal number when the agent was killed by a
signal. If the agent is still running, `lens run` exits with 128 + the
number of the signal it received. An agent still running then keeps
running, and usage it adds after that is not recorded. A `lens run` that
dies without saving (SIGKILL, a crash) is finished later by `lens recover`.

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
`stats`. `--json` emits the raw index entries. A recovered session shows its
exit code as `unknown` (`null` in `--json`), because no one saw the agent exit.

### `lens report [sessionIds...] [--tag k=v ...] [--out <path>]`
Generates a single self-contained HTML file with the full conversation and raw
request/response bodies for the selected sessions. Select sessions by explicit
ids or by `--tag` (all matching sessions). `--out` sets the output path (defaults
to `lens-report-<id>.html`). Open the file in any browser — no server needed.

### `lens recover`
Saves sessions whose `lens run` ended without saving (killed, crashed). A
session is recovered only once its `lens run` and every process that held one
of its Codex rollouts open are gone, matched by pid and process start time so a
reused pid does not count. Sessions from before agentlens recorded that identity
are recovered once nothing in their folder has changed for an hour. A recovered
entry carries `"recovered": true` and `"exitCode": null`. It prints one summary
line and is safe to re-run. `lens stats`, `lens sessions`, `lens report` and the
dashboard's `/api/data` run the same sweep first, so a recovered session is
counted without running `recover` by hand; `lens run`, `import` and `compact`
never do.

### `lens compact`
Shrinks the store in place. Agent request bodies repeat the full tool list,
system prompt, and conversation history on every call; new captures already
store each distinct piece once per session (in the session's `blobs.jsonl`),
and `compact` rewrites older sessions the same way. Every line is verified to
read back byte-identical before a file is replaced. Sessions that are still
running (unfinalized and written to within the last hour) are skipped. Safe to
re-run.

### `lens dashboard [--port <n>]`
Starts a live local dashboard (default `http://127.0.0.1:4040`): a token trace
over time, sessions in flight, window totals with estimated cost, and per-agent /
per-model / recent-session breakdowns. Filterable by time window (1h/24h/7d/all)
and `run` tag; polls every 2s. `--port` changes the port. It serves `/` (HTML,
self-contained, no external assets) and `/api/data` (JSON) reading the same
store live.

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
├── claims/<sha256>.json      which session owns each Codex rollout (one file per rollout, never two owners)
└── sessions/<id>/
    ├── meta.json             runtime, capture mode, tags, cwd, argv, timing, `lens run` pid + start time
    ├── final.<n>.json        finalize ticket: only one process saves a session
    ├── holders.jsonl         extra processes seen writing this session's rollouts (checked before recovery)
    ├── events.jsonl          normalized per-call token usage
    ├── raw.jsonl             full request/response pairs (proxy mode); repeated request content is refs into blobs.jsonl
    ├── blobs.jsonl           each distinct tools/system/message value, stored once
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
  and extracts token counts from their `token_count` events. A rollout belongs
  to a session only if a process started by that `lens run` was seen holding it
  open for writing. `lens run` looks at child start, about once a second, on a
  signal and at exit, and the first session to see a rollout claims it, so each
  rollout counts for at most one session. A rollout no look saw open is not
  counted; it is named on stderr after the run. Start time and folder only
  narrow which rollouts are named, never which are counted. Open-file evidence
  comes from `lsof` (override with `AGENTLENS_LSOF`); if it cannot be read,
  stderr says so and no rollout is counted. After a signal, a look still
  running at the stop deadline (grace plus under a second) counts as evidence
  that could not be read: nothing is claimed from it and stderr says why.
  A claimed rollout of several hundred MiB can make the stop run past grace +
  1 s, though its usage is still counted in full. A rollout over about 512 MiB
  cannot be read, and is named on stderr as uncounted.

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
