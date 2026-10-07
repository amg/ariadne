# Chat Bot Project Knowledge

A dockerized, single-user chatbot with streaming replies and cost
observability plus a planned cross-session factual memory (ADR 0003 is
accepted, its pipeline unimplemented). It also carries a thread-health
analyzer for topic-drift detection (ADR 0006); its live gate now runs
with every conversation — arrivals are expanded, embedded, judged, and
persisted — with the reading surfaced under Conversation/Analysis tabs
(`?mode=analyze`), behind `THREAD_ANALYSIS_MODE`.

## Start Here

Everything user-facing — features, tech stack, quick start, environment
variables, deployment, project structure — lives in the root `README.md`.
The README is the single source of project truth; do not replicate it here.

## How it works

`docs/flows/NEW-MESSAGE.md` maps a message end to end (submit, Drift
gate, Retry, pause, Handover). `docs/flows/BACKGROUND-WORK.md` covers
the queue, the event bus, push and every failure path. The worker runs
inside the API process. Feature toggles are read at boot, so flipping
one needs a restart.

## Memory

ADR 0010 covers the pipeline (Fact capture at segment close, Thread
Seeds, per-user toggle). `CONTEXT.md` defines the terms (Fact, Memory,
Seed, Handover). Memory is off by default (`FEATURE_MEMORY`); the
backend reads toggles at boot, so a change needs a restart.

## Database

One Postgres schema per domain keeps app tables separate from the auth
provider's ~55 SuperTokens tables (which stay in `public`). The queue
engine owns its own `queues` schema.

| Schema | Tables |
|---|---|
| `chat` | `users`, `threads`, `messages` |
| `analysis` | `message_embeddings`, `thread_segments`, `segment_drift_logs` |
| `memory` | `user_facts`, `thread_seeds`, `user_settings`, `memory_capture_progress` |
| `billing` | `message_usage`, `message_side_costs`, `model_configs` |
| `auth` | SuperTokens tables (~55) |
| `public` | `kysely_migration`, `kysely_migration_lock` |

Foreign keys work across schemas. Extensions (`vector`, `uuid-ossp`)
resolve via the default `search_path`. Code references tables with
schema-qualified keys (`billing.messageUsage`); `CamelCasePlugin` maps
each dot-separated part to snake_case at query time.

## Knowledge Map

- **`CONTEXT.md`** (repo root) — the domain vocabulary. Code uses these
  terms as its assumed language.
- **`adrs/`** — architectural decisions; the code is the source of truth
  for everything else.
- **`docs/flows/`** — high-level flow maps with diagrams. Concepts only,
  never function or column names.
- **`docs/ideas/`** — open explorations. High level only: how an approach
  works and why, never implementation specifics.
- **`docs/project-management/`** — destination for WIP tickets and bugs
  (`tickets/`, `bugs/`). Once work lands, its ticket is deleted; git
  history keeps the substance.
- **`.pi/FUTURE-IMPROVEMENTS.md`** — backlog and in-progress items.

## Agent Environment

- `cd backend && npm test` works from both the host and the agent
  container (real Postgres, no mocks; always against `chatbot_test`
  next to the `.env`-configured database — see README/Testing and
  `.testing/db.md`).
- Probing the host database from the agent container (connection string,
  one-off probe recipes): see `.testing/db.md` (gitignored — throwaway
  scripts and probes live there, never in the repo).
