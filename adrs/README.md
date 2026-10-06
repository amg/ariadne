# Architecture Decision Records (ADRs)

This directory contains records of significant architectural decisions for the chatbot project.

## Format
We use a lightweight markdown format for ADRs. Each ADR should include:
- **Title**
- **Status** (Proposed, Accepted, Rejected, Superseded)
- **Context** (What is the problem?)
- **Decision** (What is the change?)
- **Consequences** (What becomes easier/harder?)

## Status

All architectural decisions have been accepted. See ADRs 0001–0010:
0004 supersedes the DI convention of 0001; 0003's pipeline is decided by
0010; 0006 is the
single thread-health drift record — Turn embeddings keyed to messages,
Segment drift against a rolling Gravity point, the frozen Anchor demoted to a
chart gauge, and the advisory gate-replay shape; 0007 is the live lane's
message transformer — steps mediated only through the database; 0008 rejects
per-client rate limiting in the app (no proxy trust, client-IP limiting lives
at Cloudflare) in favor of one deployment-wide, Postgres-backed daily spend
budget plus deployment-wide caps on the billed routes; 0009 fixes the
deployment vocabulary — dev (host app + infra containers), staging (full
Docker build, disposable data), prod (tunnel-fronted) — one compose file and
resource-name suffix per tier, two env files, one local stack at a time.

0010 delivers the pipeline 0003's storage was waiting for — a general
fact-extraction process hooked at Segment close, Facts stored in the pgvector
table, fresh Threads primed by assembler Seeds, and memory switched per user.
It also amends 0006: a drift fire on a fresh arrival pauses the reply until
the user continues in the Thread or hands the message over to a new one. Its
out-of-scope boundary is deliberate — preference-corpus tuning, graph
visualization, cross-user analytics, and full UPDATE/DELETE reconciliation
are future improvements, not rewrites.

0011 moves work that must outlive a request (the Drift gate's judging,
titling, Fact capture) onto a graphile-worker queue in its own `queues`
schema, superseding 0010's in-process capture. The gate stays before
inference: a chat waits briefly for its verdict and otherwise answers
"still checking". 0012 delivers background results through an event bus
whose transport (SSE today, WebSockets possibly later) is an adapter.
0013 puts unfinished features behind toggles read only at the backend
and frontend entry points, with decisions passed down as values and
deployment toggles kept distinct from per-user settings.
