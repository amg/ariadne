# Fact capture on a durable job queue (graphile-worker)

Branch: `feat/capture-queue`. Priority: second, after the domain schemas
(ticket 004). Read ADR 0010 and `backend/src/services/memory/` first.

## Why

Fact capture runs in the backend process today. The pass is fired and
forgotten after the drift check, captures for a thread are kept one at a
time by an in-memory map, and the handover waits on that map. That breaks
down in three ways:

- With more than one backend, two processes can capture the same segment,
  and a handover on one cannot see a capture running on another.
- A capture in flight when the process stops is lost. The segment stays
  owed in the database, but nothing retries it until the next message in
  that thread, so a thread nobody returns to never gets captured.
- A handover after a failed capture starts a second one, spending model
  calls again while the user waits.

## Decided

**graphile-worker**, on the existing Postgres. No new service to run (no
Redis), jobs start within milliseconds through LISTEN/NOTIFY, a job can be
queued in the same transaction as the data that triggers it
(`graphile_worker.add_job()` is plain SQL, so it fits the rule that Kysely
lives only in `backend/src/db/`), and a `job_key` stops the same capture
being queued twice. BullMQ was rejected: it needs Redis, cannot queue
inside a Postgres transaction, and serializing per thread is a paid
feature.

## Scope

1. **ADR 0011** recording the choice. It supersedes the in-process
   capture described in ADR 0010; the rest of 0010 stands.
2. **Queueing.** When the drift check records a fire that closes a
   segment, the same transaction queues `capture_segment` with
   `job_key` = the segment id. A segment reopened by an edit or a handover
   is queued again when it next closes.
3. **The task.** Captures one segment: memory off marks it captured
   without extracting, as now. Failures retry with exponential backoff up
   to a set number of attempts; a job that runs out stays visible as
   failed, and the segment stays owed.
4. **A periodic sweep** (graphile-worker's cron) queues any owed segment
   that has no job, which covers the "thread nobody returns to" case.
5. **Handover.** Waits on the segment's job (finished, failed, or none)
   for up to 20 seconds, and never starts a capture itself.
6. **Removed:** the in-memory map and the fire-and-forget calls in
   `captureClosedSegments.ts`. Tests drain the queue with
   `runOnce` instead of `capturesSettled()`.

## Open points

- Run the worker inside the API process (simplest) or as its own
  container (scales separately). Start in-process; the queue makes the
  move later a deployment change only.
- graphile-worker installs its schema at startup. The production
  database user needs the right to create it, or the schema is created
  by a migration first.

## Out of scope

The two other pieces of process-local state, the exchange registry (stop
button and in-flight guard) and the drift-check lock, are logged in
`.pi/FUTURE-IMPROVEMENTS.md` under multi-replica prerequisites.

## Done when

Captures survive a backend restart, two backends never capture the same
segment, a handover never starts a capture, and the gate passes with the
in-memory queue gone.
