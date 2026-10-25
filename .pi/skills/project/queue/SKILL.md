---
name: queue
description: Conventions for the durable queue (graphile-worker on the queues schema) — task payloads are typed by task name through the GraphileWorker.Tasks registry, never re-validated or re-shaped at runtime. Use when creating or editing queue tasks, enqueuing jobs, changing a task's payload, or writing queue tests.
---

# Queue Conventions

## 1. Tasks and payload types

*   **One registry per name.** Every task declares its payload in the global
    `GraphileWorker.Tasks` interface, inside the task's own file
    (`queue/tasks/`). `registeredTask(name, { execute, onGivenUp })`,
    `enqueueJob({ task, payload, … })` and the task's own
    `enqueue…` wrapper are all typed against it: name and payload are
    paired at compile time.
*   **No runtime payload checks.** The job row holds JSON written by our
    typed enqueue side and is trusted like a Kysely row — no parsers,
    no narrowing helpers, no schema validation.

## 2. Tasks and flows

*   **A task computes an outcome and throws on failure; it announces
    nothing and enqueues nothing.** Scheduling and announcing belong to
    the flow for that task — a function in `queue/flows/` that reads the
    outcome, publishes its events, and enqueues any follow-up work.
    A task with no sequel has no flow.
*   **Give-up hooks are flow announcements too**: the wrapper calls the
    flow when a job leaves for good, so a waiting caller always learns.

## 3. Changing a payload

Payloads are versioned by task name, the same way migrations version the
schema: *existing rows must stay readable by new code*.

*   **Additions are safe.** A new optional field may be added in place.
*   **Any rename, removal, or type change ships under a new task name.**
    Old jobs keep running (or dying) under the old name; drain or
    re-enqueue as the ticket demands. Never mutate a registry entry's
    shape in place while jobs for it may still be queued.
*   **Coverage:** change payload, change enqueue, change execution — the
    type system then flags every site that disagrees. A change that
    compiles with a diverging queue is a naming failure, not a cast
    opportunity: fix the name.

## 4. Enqueuing

*   **Keys:** `enqueueJob` takes a `key`; jobs merge by `jobKeyOf(task,
    key)`. One live judgment per arrival, one pending capture per segment.
*   **Transactions:** pass the caller's executor so the job commits or
    rolls back with the row it belongs to.
*   **Retry class:** throw `TaskFailure('<code>')` from a task; the code
    list in `queue/errors.ts` decides fatal (job dies at once) versus
    recoverable (retries put it back). `onGivenUp` fires once the job
    leaves for good.

## 5. Queue testing

*   **Real worker, no mocks.** Tests run jobs through the worker:
    `useTestQueue()` after `useTestDb()`, `drainQueue(queueTasks())` to
    work due jobs, `makeWaitingJobsDue()` to skip retry pauses,
    `addDeadJob()` to seed a dead job.
*   **Probe tasks** register through the same `GraphileWorker.Tasks`
    augmentation in the test file.
