# Durable queue, server push, and the memory toggle

Branch: `docs/user-facts-memory` (refactor in place; merges with memory
switched off). Supersedes ticket 005, whose capture-queue scope is folded
in here. Precedes ticket 004 (domain schemas).

Read first: ADR 0011 (queue), ADR 0012 (push), ADR 0013 (toggles), and
ADR 0010 for the Handover and capture semantics being preserved.

## Why

The Drift gate runs inline in the chat request. Capture is fire-and-forget
and kept in an in-memory map. Titling waits for the browser to ask. All
three are work that must finish whether or not the browser stays open,
and must not double up across retries, restarts, or (later) replicas.
This ticket moves them onto graphile-worker, adds a push channel for
results that land outside a request, and puts memory behind a root-only
toggle so everything else can merge first.

## Decisions settled in the grill

| # | Decision |
|---|---|
| Engine | graphile-worker, schema `queues`, in-process worker, liftable |
| Schemas | only the queue schema now; ticket 004's domain split comes after |
| Gate timing | still before inference; no reply ever generated for an unjudged arrival |
| Chat wait | request holds up to `GATE_WAIT_MS` (default 10000) for the verdict, then answers 503 `gate_pending` |
| Retry | the user's retry re-waits on the same task; a dead recoverable task is re-queued; dead fatal answers 503 `gate_failed` |
| Handover | still moves the user message only (no reply exists before the gate) |
| Attempts | 3, exponential backoff; dead jobs stay failed; no cron sweep |
| Lock | per-thread Postgres advisory lock replaces `runsByThread`, always released |
| Push | one event bus in the backend; one SSE stream per tab; user-scoped fan-out; screens filter by thread; current state re-emitted on connect |
| Toggles | central registry; backend from env at boot; frontend fetches `/api/config` on load, keeps it in memory, falls back to defaults (all off) |
| Toggle keys | `memory` only |
| Dead jobs | `npm run queue:retry-failed` script now; admin UI later |
| Analysis route | `GET /api/threads/:id/analysis` backfill stays synchronous (takes the advisory lock) |

Derived during write-up, confirm while implementing: since nothing passes
the gate, **an unanswered arrival blocks new submits** the same way a
Paused arrival does today (409, composer shows the retry). Without this a
second message lands behind an unjudged one and pairs into a broken Turn.

## Task catalogue

| Task | Job key | Enqueued by | Execute does | Publishes |
|---|---|---|---|---|
| `driftGateJudgeArrival` | message id | `submitChat` and edit fork (same txn as the arrival insert); the retry path when a recoverable task died | lock thread → run the live lane up to the message → persist verdict and side costs → on a fire that closes a segment, enqueue `memoryCaptureSegment` in the same txn (memory on only) | `verdict-paused` / `verdict-ok` / `gate-failed` |
| `threadGenerateTitle` | thread id | first Exchange settling successfully on an untitled Thread; the regenerate-title route (`forced`) | title the thread unless already titled (unless forced) | `thread-titled` |
| `memoryCaptureSegment` | segment id | the gate task's tail; Handover | capture past the segment pointer (ADR 0010 rules, per-user setting respected) | `memory-captured` |
| `memoryCaptureThread` | thread id | `POST /api/threads/:id/capture-memory` (the panel button) | `captureUnreadTurns` for the thread | `memory-captured` (with the pass report) |

Naming: every task starts with the domain feature it serves (`driftGate…`,
`thread…`, `memory…`), then a verb and object in domain language. The
file is `<name>Task.ts`, its pair is `enqueue<Name>` / `execute<Name>`,
and the queue's task identifier is `<name>`, so jobs group by feature in
the `queues` tables too. The names above are proposals; refine them
during implementation as long as the prefix rule holds.

The two capture tasks are registered only when `memory` is on. A deleted
thread, an abandoned arrival, or an already-settled state makes a task a
successful no-op, never an error.

## Flows

### Submit (and Edit fork)

```
POST /chat ─► auth, budget, guards ─► txn{ insert arrival; enqueueDriftGateJudgeArrival }
           ─► subscribe(bus, messageId) then check persisted verdict   (no race)
           ─► wait ≤ GATE_WAIT_MS
                verdict-ok      → startExchange → stream (transient verdict first, as today)
                verdict-paused  → pause response (unchanged)
                gate-failed     → 503 gate_failed
                cap reached     → 503 gate_pending, Retry-After: 5
client gone mid-wait → unsubscribe; task carries on; no Exchange starts
```

### Retry (regenerate trigger, server-authoritative)

The last live arrival decides:

```
reply exists                 → today's retry (abandon stale replies, re-exchange)
verdict stored, no reply     → startExchange (clear) / pause response (fired, not yet handed over)
task live (queued/running)   → wait, as in submit
task dead, recoverable       → enqueueDriftGateJudgeArrival again, wait
task dead, fatal             → 503 gate_failed
no verdict and no task       → enqueueDriftGateJudgeArrival, wait   (pre-migration arrivals)
```

"Continue in this Thread" on a Paused arrival remains an ordinary retry
that replays the stored fire (ADR 0010).

### Handover

Unchanged in shape: enqueue `memoryCaptureSegment` for the open segment (memory
on), wait on its completion via the bus for up to 20 s, then move the
arrival in one transaction. The Handover never captures inline. With
memory off, skip both the capture and the seed insert.

### Titling

The 50-char preview title on an interrupted Exchange stays. The client
stops calling `generate-title` after the first reply. The server enqueues
on settlement. The regenerate button now gets `202 { queued: true }` and
its spinner clears on `thread-titled`, or on the next refetch if push is
down.

## HTTP contract

| Status | `errorCode` | Meaning | Client |
|---|---|---|---|
| 503 + `Retry-After: 5` | `gate_pending` | verdict not in yet | keep the user bubble, show calm "still checking" + Retry |
| 503 + `Retry-After: 5` | `gate_failed` | the gate's task died | keep the bubble, show "couldn't check this message" + Retry |
| 409 | `arrival_unanswered` | submit while the last arrival has no reply | composer disabled, point at the bubble's Retry |

The existing 503 `provider_not_configured` stays an error. The frontend
discriminates on `errorCode`, never on status alone.

## Push

Backend:
- `src/services/events/`: typed `ServerEvent` union and the bus
  (`publish`, `subscribe(filter, handler) → unsubscribe`). In-process
  today. This interface is the seam where Postgres NOTIFY slots in later.
- `app/routes/events/get.ts`: the SSE transport. `GET /api/events`,
  `verifySession()`, `text/event-stream`, a heartbeat comment every 25 s
  (Cloudflare idle is 90 s), unsubscribe on `reply.raw` close. On connect,
  re-emit current state for the user's unanswered/paused/failed arrivals
  as ordinary events.
- Events: `verdict-paused`, `verdict-ok`, `gate-failed`, `thread-titled`,
  `memory-captured`. Each carries `userId` (server-side filter only) and
  `threadId`, plus kind-specific fields.

Frontend:
- `services/push/`: `pushClient` (`subscribe(kind, handler)`, framework
  free) and `transports/sse.ts` (EventSource, cookie auth, built-in
  reconnect). A WebSocket transport implements the same adapter.
- `AppLayout` opens one connection per tab and closes it on unmount.
  `ChatPage` reacts to verdicts for its thread. The sidebar reacts to
  `thread-titled`.
- `chatRegistry`: a new outcome class for `gate_pending`/`gate_failed`
  that does **not** roll back the optimistic user message or restore the
  draft. Check how `useChat.regenerate()` behaves when the last message
  is a user message, since the Retry button rides it.

## Feature toggle: memory

Backend:
- `src/config/features.ts`: the registry with defaults (`memory: false`),
  read from `FEATURE_MEMORY`. Add it to `.env.dev.example`,
  `.env.prod.example`, and the compose passthrough (`audit:env` enforces
  this).
- `/api/config` returns `{ threadAnalysisMode, features: { memory } }`.
- `server.ts` (root): registers settings + memory-fact routes and
  `capture-memory` only when on, and registers the capture tasks only
  when on.
- Routes that start flows (`chat/post`, `handover`, `messages/patch`)
  resolve `memory` once and pass down
  `{ kind: 'off' } | { kind: 'on'; enqueueMemoryCaptureSegment }`. Seed assembly
  in `submitChat`, the seed insert in `moveArrivalToFreshThread`, and the
  gate task's capture tail all take it as a parameter. None of them
  imports the registry.

Frontend:
- `config/features.ts`: the same keys with defaults, all `false`.
- `rootLoader` fetches `/api/config`. On failure it uses the defaults
  (today it falls back to `'heuristic'` for analysis; that stays as is).
- Page entries decide: the `/memory` and memory-settings entries redirect
  or render nothing when off. `AppLayout` passes `memory` as a boolean
  to the sidebar (Memory link) and folds it into `memoryCaptureAvailable`.
  Components never read the registry.

Enabling later: owed segments from the off period are picked up by the
next capture pass in each thread (the pointer covers everything past
it). No retroactive sweep.

## Layout and boundaries

```
backend/
  queue/
    tasks/driftGateJudgeArrivalTask.ts  enqueueDriftGateJudgeArrival(params, trx?) / executeDriftGateJudgeArrival(params, deps)
    tasks/threadGenerateTitleTask.ts    enqueueThreadGenerateTitle / executeThreadGenerateTitle
    tasks/memoryCaptureSegmentTask.ts   enqueueMemoryCaptureSegment / executeMemoryCaptureSegment
    tasks/memoryCaptureThreadTask.ts    enqueueMemoryCaptureThread / executeMemoryCaptureThread
    errors.ts                  classifyTaskError(err): 'recoverable' | 'fatal'
    worker.ts                  runner bootstrap; wires execute deps (incl. enqueue fns)
    index.ts                   startQueue / stopQueue
  src/db/queries/queue/        enqueueJob(dbOrTrx, …), findJobByKey, listDeadJobs
  src/services/events/         bus + ServerEvent
  app/routes/events/get.ts     SSE transport
  scripts/queue-retry-failed.ts
```

- Enqueue functions hide graphile metadata (task name, key, attempts) and
  accept the caller's transaction. Roots pass them down. Services take
  them as parameters.
- New depcruise rules: `src/**` and `app/**` must not import
  `queue/worker` or `queue/index` (only `app/server.ts` may). `queue/**`
  must not import `kysely` or the db singleton.
- `audit:boundaries` currently scans `frontend/src backend/src` only. Add
  `backend/app` and `backend/queue`, or the rules above never run. Also
  update the `@queue/*` tsconfig path, knip entries, and the vitest
  include.
- Fatal errors should not burn remaining attempts. Use graphile-worker's
  permanent-failure mechanism if the installed version has one; otherwise
  record the class in the error so `findJobByKey` and the script can
  read it.
- The schema is installed by graphile-worker's own migrator at boot
  (`schema: 'queues'`). The DB user needs `CREATE` on the database.
  `test/global-setup.ts` must drop `queues` alongside `public`.

## Removed

- `runsByThread` in `liveGate.ts` (advisory lock instead).
- `captureClosedSegments`' fire-and-forget calls and in-memory map;
  `capturesSettled()` in tests (drain with graphile-worker's run-once).
- Inline `runLiveGate` calls in `submitChat`/`retryLastExchange`.
- The client's post-first-reply `generateTitle(threadId)` call.

## Out of scope

Domain schemas (ticket 004), queue admin UI, cross-replica bus, moving the
exchange registry, moving the analysis-route backfill to the queue, and
Fact-edit spend lines.

## Done when

- A gate, title, or capture survives a backend restart mid-task and
  completes on boot.
- Closing the tab mid-wait still lands the verdict. On return the arrival
  shows its state, and Retry produces the reply without re-judging.
- A cold model past 10 s yields `gate_pending` with the bubble kept, and
  Retry eventually streams the reply.
- A forced recoverable death is re-queued by Retry. A forced fatal death
  answers `gate_failed` until `npm run queue:retry-failed` clears it.
- Two identical enqueues while one is pending run once. Running any task
  twice leaves the database unchanged.
- Push delivers `thread-titled` to a second open tab. Killing the SSE
  connection and reconnecting re-emits the current state.
- With `FEATURE_MEMORY` unset: no memory routes, no capture tasks, no
  seed rows, no Memory link or screen. `/api/config` failing hides the
  same.
- `npm run gate` passes with the boundary audit covering `backend/queue`
  and `backend/app`.
