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
Editing forks instead of rewriting. Both edit and retry target the last
live (non-abandoned) user prompt — so a handed-over arrival is never
mistaken for the anchor. The edit abandons the old arrival row plus
every reply grown from its text in place — text, arrival analysis and
spend stay, the usages keep tracking what the thread burned — and the
edited text lands as a new arrival row, which the retry exchanges and
the live gate judges there (already-analysed arrivals play back — never
re-embedded or re-judged). A retry re-exchanges that anchor prompt,
flags the stale assistant rows beneath it abandoned in place, and grows
the fresh reply beneath those; abandoned rows are never revived — a
handed-over arrival stays in its new Thread.
Abandoned rows vanish from the chat stream and the live-analysis
reading but keep counting in cost surfaces and reports. Spend surfaces
are purpose-built: `message_usage` is chat-inference telemetry only,
rewrite/judge spend lives in `message_side_costs`, embedding cost
rides the arrival row; `sumThreadSpend()` is the single source of thread
spend totals. `POST /api/threads/:id/stop` stops the live Exchange
through the in-process exchange registry (single-replica assumption);
the resume-draft prefill is dormant (no path abandons the newest user
row anymore).

## Background work (decided, being built)

ADRs 0011–0013 are accepted; implementation is underway on this branch
(ticket 006). Drift gate judging, Thread titling and Fact capture run as
tasks on a graphile-worker queue in the `queues` schema. Tasks are named
by domain feature first, and the worker runs in-process but can be
lifted out. The chat waits up to `GATE_WAIT_MS` for a verdict, then
answers "still checking" (503 `gate_pending`). Results reach the browser
over a per-tab SSE push stream behind a swappable transport. Feature
toggles are read only at entry points. Memory sits behind
`FEATURE_MEMORY` (off by default) so the rest can merge first. Failed
tasks: `npm run queue:retry-failed`. Until this lands, the sections
below describe the in-process mechanics still running.

## Memory Feature (Phase 2 Complete)

User-scoped factual memory captured by segment pointer, frozen Seeds on
fresh Threads, and per-user settings. Facts are self-contained sentences
about the user (e.g., "the user is vegetarian") with category, a stated
`valid_at` date when the conversation gives one (null otherwise), and
optional entity columns.

### Storage
- **`user_facts`** table: durable store with a stated-only `valid_at` (the date
  the conversation states, else null), `invalid_at`, suppression flag, and
  pgvector embeddings. Update by supersession, never overwrite.
- **`thread_seeds`** table: frozen snapshot of seedable Facts at Thread creation,
  stored as jsonb lines with category per line (so blocked categories drop out).
- **`user_settings`** table: per-user `memoryEnabled` boolean and
  `memoryBlockedCategories` array (credentials blocked by default).

### API Endpoints
- `GET /api/memory/facts` — lists user's Facts (including suppressed), newest first
- `PATCH /api/memory/facts/:id` — edit sentence (supersedes old row,
  re-classifies the new one) or toggle suppression
- `DELETE /api/memory/facts/:id` — hard delete
- `GET /api/settings` — get user settings
- `PATCH /api/settings` — update memory settings

### Frontend Routes
- `/memory` — Memory Screen: view, edit, suppress, delete Facts
- `/settings` — Settings page: memory on/off toggle and blocked category checkboxes

### Key Behaviors
- Frozen Seeds keep edited/suppressed/deleted Facts until Thread ends (ticket 010 decides purge)
- Blocked categories are skipped at Seed assembly time, not at capture
- Memory is invisible in Threads; only visible in Memory Screen
- Editing a Fact re-classifies it from the new sentence (category,
  subject, predicate, object, stated date) and supersedes the old row;
  a change of subject moves it into a new group on the Memory Screen
- A segment owes capture once settled: a live drift fire judged into
  it, or a cut onto it whose fire was handed over. Memory keeps a
  `captured_through_at` pointer per segment in its own progress table
  (`memory_capture_progress`), marking how far capture has gone; each
  pass extracts only the Turns past the pointer, with older Turns read
  as context only. A failed pass leaves the pointer put, so the debt
  survives — abandonment of the anchor row can never strand it, because
  the successor segment's opener anchors it in its place. Handover is a
  capture point, not a close: the move waits up to 20 seconds for a
  pending pass, then proceeds and retries in the background until the
  debt settles
- Seed lines always carry a date: the stated `valid_at` when present,
  the day the Fact was recorded otherwise

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
