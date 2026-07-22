# agentlens — conventions for agents

Wire-level observability for coding agents. **Usage** (commands, tags, store, pricing) is in `README.md` — read it first. This file is for working on the code.

## Build / test

- `npm run build` (tsc, strict ESM/NodeNext — imports between `src/` files use `.js` extensions)
- `npx vitest run` (all) or `npx vitest run tests/<file>` (one file). `tests/` mirrors `src/` names. TDD: failing test first.
- Tests MUST set `AGENTLENS_HOME` to a fresh temp dir — never touch the real store at `~/.agent-obs`. Same for `AGENTLENS_CODEX_SESSIONS` (overrides `~/.codex/sessions` in codex-collector tests). No test may depend on `lens`, `claude`, or `codex` being installed; integration tests use fake CLIs + mock upstreams (see `tests/run.test.ts`, `tests/proxy.test.ts`).

## Hard invariants

- **Fail-open**: capture must never break, block, or alter the wrapped agent's session. Store/parse/proxy errors are logged to stderr and swallowed; the child's exit code always propagates. A change that can make `lens run` crash or hang after the child exits is a bug even if capture improves.
- **Runtime deps**: `commander` only. Proxy and dashboard are plain `node:http`/`node:https`. Don't add packages.
- **Codex is logs-mode, not proxy-mode — by evidence, not oversight.** Under ChatGPT auth codex's model calls ride a hardcoded WebSocket (`wss://chatgpt.com/backend-api/codex/responses`); base-URL overrides only move side-traffic. See `spikes/FINDINGS.md` before "fixing" the codex adapter into a proxy. Capture comes from its native rollouts (`~/.codex/sessions/**/rollout-*.jsonl`), collected post-run filtered by start-time + cwd.
- Claude is proxy-mode via `ANTHROPIC_BASE_URL` (subscription OAuth passes through a localhost reverse proxy; `accept-encoding` is stripped so bodies stay parseable).
- Backward compat of the store: JSONL is append-only; readers skip corrupt lines. Don't change `NormalizedEvent`/`IndexEntry` shapes without a migration story.
- Recorded traces redact `authorization`, `x-api-key`, `cookie`, `set-cookie`. Keep it that way; traces contain full prompts and the store is chmod 700.
- **Captured data never leaves this machine.** The store (`~/.agent-obs` or any `AGENTLENS_HOME`), generated `lens-report*.html` files, and anything derived from real sessions contain full prompts/responses. Never commit them, never push them, never upload them anywhere — no exceptions, regardless of task. This repo is headed for open source: only source, docs, and synthetic fixtures may be committed. Before any commit, verify nothing data-derived is staged. Never add a git remote or publish this repo unless the user explicitly directs it in the current conversation.

## Attribution semantics (load-bearing)

`AGENTLENS_TAGS` env **overrides** `--tag` flags on collision — deliberate, so outer orchestrators (afork/flux) own attribution across nested spawns. Do not "fix" this precedence.

## Where the history lives

- Design spec + implementation plan: `$OBSIDIAN/plans/agentlens-design-2026-07-14.md`, `$OBSIDIAN/plans/agentlens-plan-2026-07-14.md`
- Spike evidence (what's proxyable and what isn't): `spikes/FINDINGS.md`
- Flux/afork integration contract: `docs/flux-integration.md` (afork side: `--observe`/`--obs-tag` in agent-skills PR #26)
