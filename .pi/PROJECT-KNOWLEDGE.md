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

Since 2026-10-01 every chat Exchange settles clean, interrupted and
crashed ones included: provider-reported spend when the usage report
arrived, otherwise an estimated row (locally counted input + emitted
text, `estimated = true`) with finish reason
`interrupted`/`timeout`/`error`. Abandonment fires only from deliberate
user actions: (1) an edit abandons the old arrival + every reply grown
from its text (rows + usage kept), and the edited text lands as a new
fork row that the retry exchanges; (2) a retry/regenerate flags the
stale assistant rows abandoned in place (kept + counted, hidden from
the stream), and grows the fresh reply beneath. Interruption,
failure, timeout, and crash abandon nothing: the user prompt and partial
assistant reply stay live in the thread — visible, partial text included
in the model context of the next exchange (empty assistant rows are
skipped in context but remain in DB/UI). A still-untitled Thread titles
from a short preview of the arrival text (50 chars, the rename cap).
Editing the last user prompt forks instead of rewriting: the old arrival
row plus every reply grown from its text are abandoned in place — text,
arrival analysis and spend stay, the usages keep tracking what the
thread burned — and the edited text lands as a new arrival row, which
the retry exchanges and the live gate judges there (already-analysed
arrivals play back — never re-embedded or re-judged). A retry revives
the newest user turn it re-exchanges, flags the stale assistant rows
beneath it abandoned in place, and grows the fresh reply beneath those.
Abandoned rows vanish from the chat stream and the live-analysis
reading but keep counting in cost surfaces and reports. Spend surfaces
are purpose-built: `message_usage` is chat-inference telemetry only,
rewrite/judge spend lives in `message_expansion_costs`, embedding cost
rides the arrival row; `sumThreadSpend()` is the single source of thread
spend totals. `POST /api/threads/:id/stop` stops the live Exchange
through the in-process exchange registry (single-replica assumption);
the resume-draft prefill is dormant (no path abandons the newest user
row anymore).

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
  container (real Postgres, no mocks; always against `chatbot_test`
  next to the `.env`-configured database — see README/Testing and
  `.testing/db.md`).
- Probing the host database from the agent container (connection string,
  one-off probe recipes): see `.testing/db.md` (gitignored — throwaway
  scripts and probes live there, never in the repo).
