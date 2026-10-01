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

## Chat exchange lifecycle

Since 2026-10-01 every chat Exchange settles clean, interrupted ones
included: provider-reported spend when the usage report arrived,
otherwise an estimated row (locally counted input + emitted text,
`estimated = true`) with finish reason `interrupted`/`timeout`/`error`.
An Exchange ending without completing flags its arrival row `abandoned`
(messages migration 015) and titles a still-untitled Thread from a short
preview of the arrival text (50 chars, the rename cap). Spend surfaces
are purpose-built: `message_usage` is chat-inference telemetry only,
rewrite/judge spend lives in `message_expansion_costs`, embedding cost
rides the arrival row; `sumThreadSpend()` is the single source of thread
spend totals. `POST /api/threads/:id/stop` stops the live Exchange
through the in-process exchange registry (single-replica assumption);
`GET /api/threads/:id/draft` owes interrupted arrival text back to the
input until a completed retry consumes it.

## Knowledge Map

- **`CONTEXT.md`** (repo root) — the domain vocabulary. Code uses these
  terms as its assumed language.
- **`adrs/`** — architectural decisions; the code is the source of truth
  for everything else.
- **`docs/ideas/`** — open explorations. High level only: how an approach
  works and why, never implementation specifics.
- **`docs/project-management/`** — destination for WIP tickets and bugs
  (`tickets/`, `bugs/`). Once work lands, its ticket is deleted; git
  history keeps the substance.
- **`.pi/FUTURE-IMPROVEMENTS.md`** — backlog and in-progress items.

## Agent Environment

- `cd backend && npm test` works from both the host and the agent
  container (real Postgres, no mocks; see README).
- Probing the host database from the agent container (connection string,
  one-off probe recipes): see `.testing/db.md` (gitignored — throwaway
  scripts and probes live there, never in the repo).
