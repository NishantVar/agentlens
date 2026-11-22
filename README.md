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

`npm run build` also records the git commit it was built from. `lens --version`
prints `<version> <commit>`, for example `0.1.0 c62a7c5…` (the full 40-character
commit), wherever it is run from and even after the checkout moves on. It prints
`unknown` for the commit when the build was made outside a git checkout, from
uncommitted changes to `src/`, `tsconfig.json` or `package.json`, or when the last
build failed or was stopped before it finished; commit and rebuild to fix that.
A clean checkout is compiled from a copy of its commit's sources, so the recorded
commit is the one compiled even if the checkout changes during the build.

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
running, and usage it adds after that is not recorded. A Claude agent sends
its model requests through `lens run`'s proxy, so after a stop sent only to
`lens run` it keeps running but cannot reach the model, and has to be
restarted. A `lens run` that
dies without saving (SIGKILL, a crash) is finished later by `lens recover`.

### `lens import [--runtime claude|codex] [--since <dur>] [--tag k=v ...] [--json]`
One-shot, idempotent backfill of sessions that were NOT wrapped by `lens run`:
claude's native transcripts (`~/.claude/projects/**/*.jsonl`, override with
`AGENTLENS_CLAUDE_PROJECTS`) and codex's rollouts (`~/.codex/sessions`, override
with `AGENTLENS_CODEX_SESSIONS`). Sessions are deduped by native session id —
both against previous imports and against sessions already captured by
`lens run` — so re-running is safe. A codex rollout that a running `lens run`
session's processes hold open for writing is also skipped, even before that
session has claimed it: the session counts it. Those processes include any the
session has seen in its tree that has since been reparented. A session whose
`lens run` process identity is unknown holds nothing back.

Import records the same per-rollout claim a `lens run` session does, and the
first claim wins. If open-file evidence (the process table, `lsof`, or a
session's remembered process tree) cannot be read, nothing is held back and
import says so on stderr. A running session's rollout imported that way is
counted once, under the import's tags. A `lens run -- codex resume` of a
rollout that is already counted (by import, including an import from before
import recorded claims) counts nothing for that rollout: the one entry keeps
its tags and the usage from before the resume, tokens the resume adds are not
counted, and the wrapper names the rollout on stderr. An import interrupted
after it claimed a rollout leaves it uncounted, and later imports skip it,
until `lens recover` finalizes the idle import session: recover then counts the
claimed rollout once, in full, under the import's tags. An import interrupted
before it claimed or counted anything is never indexed: `lens recover` removes
that idle session, names it on stderr, and says to run `lens import` again,
which counts the rollout once, in full. `--since` bounds the scan by the log's own
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
Cost is derived per request from the pricing table (see Pricing); events whose model
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
├── pricing.json              optional pricing overrides (see Pricing)
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

## Pricing

Cost is the API list-price equivalent: what the same requests would cost at each
vendor's Standard global rates, by prompt-length tier and cache-write duration.
If you use Claude or Codex on a subscription, you do not pay this amount.

The built-in table covers Claude Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5
(from https://platform.claude.com/docs/en/about-claude/pricing) and GPT-6.2 Astra,
GPT-6.2 Sol, GPT-6.1 Sol, GPT-6 Astra and GPT-6 Luna (from
https://developers.openai.com/api/docs/pricing), as published on 2026-11-22, plus
older Claude 4 and GPT-5 entries.

Each request is priced on its own:

- **Prompt length.** A request's prompt is its uncached input plus cache reads
  plus cache writes. If it is over the model's threshold (Haiku 5.5: 100,000
  tokens; the OpenAI models: 272,000), the long-prompt rates apply to the whole
  request: input, output, cache reads and cache writes. At or below the
  threshold, the base rates apply. OpenAI's 272K limit is assumed to count cached
  input.
- **Cache-write duration.** Claude 5m and 1h writes are priced at their own rates
  when the transcript or proxied response reports the split. A write with only a
  total count, including every session saved before this change, is priced at the
  5m rate. Codex cache writes are priced at the 30m rate.

Not applied: fast mode, Batch/Flex/Priority processing, Anthropic's US-only 1.1×
inference and OpenAI's regional-processing +10%.

**Codex usage source.** Codex 0.171+ writes one usage record per completed
response, and agentlens counts those when a rollout has any; otherwise it counts
the older `token_count` lines, which can repeat or miss requests. Two cases are
known gaps: a session started by an older Codex and resumed by 0.171+ in the same
rollout does not count its requests from before the upgrade, and a forked child
rollout with no completed response of its own is priced from the parent's copied
`token_count` lines. Sessions saved before this change keep their stored usage
counts and are not re-extracted from their rollouts. `stats` and the dashboard
compute cost when you run them, from those stored counts and the current price
table, so older Codex usage may still overstate cache writes and repeat or miss
requests.

### Overrides

To override or add models, create `~/.agent-obs/pricing.json`:

```json
{
  "claude-haiku-4": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 },
  "my-model":       { "input": 2, "output": 8, "cacheRead": 0.2, "cacheWrite": 0 }
}
```

Prices are USD per 1M tokens. Model matching is longest-prefix, so a key like
`claude-haiku-4` matches `claude-haiku-4-5-20251001`. A user entry replaces the
whole built-in entry for its key. Two optional fields add tiers:
`cacheWriteLong` (the 1h or 12h write rate; without it every write is priced at
`cacheWrite`) and `long` (`{ "threshold", "input", "output", "cacheRead",
"cacheWrite", "cacheWriteLong"? }`, the rates for a request whose prompt is over
`threshold`; without it every request is priced at one rate).

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
