# Flux integration

This document specifies the contract between [flux](../../flux) and `agentlens`.
agentlens is the observability layer; flux is the orchestrator that launches
agents. The integration is one-directional: flux wraps the agent commands it
launches in `lens run` and tags them, then reads back per-run token/cost data
through agentlens's `--json` queries. agentlens has no dependency on flux.

## Dependency declaration

Flux declares `agentlens` as an external, separately-installed tool — the same
way it declares `afork`, `tfork`, and `cmux`. It belongs in the flux README
prerequisites table alongside those, as an optional-but-recommended dependency:

| Tool | Purpose | Required |
| --- | --- | --- |
| afork | agent forking / relaunch | yes |
| tfork | terminal forking | yes |
| cmux | multiplexed agent terminals | yes |
| **agentlens** | **per-run token/cost + prompt-trace observability** | **optional** |

When `agentlens` (the `lens` binary) is present on `PATH`, afork wraps launched
agents with it; when it is absent, afork launches them directly and flux simply
has no observability data for the run. agentlens is fail-open (see below), so its
presence never affects whether an agent runs or its exit code.

## afork adapter change

This change lives in the flux repo (afork's launch path), not here. When building
the command to launch an agent, afork:

1. **Prepends `lens run --`** to the built launch command:

   ```
   claude -p "<prompt>" --model sonnet
   →  lens run -- claude -p "<prompt>" --model sonnet
   ```

2. **Sets `AGENTLENS_TAGS` in the child environment** with the run's attribution:

   ```
   AGENTLENS_TAGS="agent=<agent>,run=<flux-run-id>,stage=<stage>,project=<repo-basename>"
   ```

Tags are passed via the environment (not `--tag` flags) on purpose — see
nested-spawn semantics below.

## Reserved tag keys

These four tag keys are reserved by the flux ↔ agentlens contract. Flux always
sets them; agentlens groups and filters on them. Do not repurpose them for other
meanings.

| Key | Meaning |
| --- | --- |
| `agent` | the agent role/name flux launched (e.g. `reviewer`, `implementer`) |
| `run` | the flux run id — the primary correlation key for a whole flux run |
| `stage` | the workflow stage the agent is executing in (e.g. `plan`, `review`) |
| `project` | the repo basename the run operates on |

agentlens treats tags as free-form; these four are a naming convention the two
tools agree on so `--by agent`, `--by stage`, and `--tag run=<id>` mean the same
thing on both sides.

## Queries flux consumes

Flux reads observability data back with these commands (all `--json`, so output
is stable and machine-parseable):

- **Per-agent breakdown for a run:**
  ```bash
  lens stats --tag run=<id> --by agent --json
  ```
  Returns `{ rows: [{ key, sessions, totals, costUsd }], generatedAt }`, one row
  per `agent` value seen in that run.

- **Per-stage breakdown for a run:**
  ```bash
  lens stats --tag run=<id> --by stage --json
  ```
  Same shape, grouped by `stage`.

- **Session list for a run:**
  ```bash
  lens sessions --tag run=<id> --json
  ```
  Returns the array of index entries (id, runtime, tags, models, timing, exit
  code, totals) for every session in the run.

`totals` carries `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, and
`requests`; `costUsd` is the estimated USD cost from agentlens's pricing table
(events with an unpriced model are excluded from cost).

## Nested-spawn semantics (env wins)

agentlens resolves tags from two sources — `--tag` flags and the `AGENTLENS_TAGS`
environment variable — and **the environment overrides the flags on key
collisions**.

This is what makes the flux attribution survive nested spawns. flux sets
`AGENTLENS_TAGS` in the agent's environment. If that agent itself launches a
sub-agent through `lens run` — even with its own `--tag agent=child` — the
inherited `AGENTLENS_TAGS` still wins for the reserved keys, so the whole spawn
tree stays attributed to the outer flux `run` (and `project`, `stage`). Child
processes inherit the environment by default, so no explicit propagation is
needed; the outer run's identity flows down automatically.

## Fail-open guarantee

`lens run` never changes whether the wrapped agent runs or what exit code it
returns. If capture setup fails, the agent runs unwrapped; if log collection or
finalization fails, it is logged to stderr and the run's exit code is preserved.
Flux can wrap every agent launch unconditionally without risking the run.
