---
description: Background work runs on a Postgres queue (graphile-worker), queued in the same transaction as its data and exactly once in effect.
---

# ADR 0011: Durable Background Work on a Postgres Queue

## Status
Accepted. Supersedes the in-process capture mechanics of ADR 0010 (the
fire-and-forget pass, the per-thread map, and a Handover that starts its
own capture). Everything else in 0010 stands. The Drift gate (ADR 0006,
amended by 0010) keeps its place before inference; only where its work
runs changes.

## Context
Three kinds of work hang off a chat without being the chat itself: the
Drift gate's judging of every arrival, the titling of a Thread, and Fact
capture. Run inside the request, a closed browser or a restarted backend
can strand an arrival half-judged, lose a capture, or leave a Thread
untitled, and a second backend would duplicate work that one process
kept in memory.

All of this is work that should finish whether or not anyone is still
watching, and should happen exactly once in effect no matter how often
it is asked for, on one backend or many.

## Decision

### The engine
Background work runs on **graphile-worker** over the existing Postgres,
in its own `queues` schema, apart from the app's tables. It needs no new
service, picks work up within milliseconds, and lets a task be queued
inside the same transaction as the data that triggers it, so the two
commit together or not at all. Brokers outside Postgres were rejected
because they cannot join that transaction.

### What is a task
A task is any work the user should not have to wait around for, or
whose loss would leave the data owing something: judging an arrival,
titling a Thread, capturing Facts. The Exchange itself is not a task.
It streams to the person waiting for it and ends when they leave.

Each task is one unit with two faces: an *enqueue* side, called where
the trigger happens, and an *execute* side, run only by the worker. A
task carries just the identifiers it needs and fetches everything else
itself when it runs, so its input never goes stale. A task's name leads
with the domain feature it serves (the Drift gate, the Thread, Memory),
so tasks group by feature in code and in the queue alike. Callers are
handed the enqueue side from the top of the call chain, so the code
beneath sees an ordinary async function and never knows a queue exists.

### Exactly once, in effect
Duplicates are refused at the door: a task queued while an identical
one is still waiting is merged into it, keyed by what it works on (the
arrival, the Thread, the Segment). Correctness does not rest on that.
Every task is idempotent by state: it re-reads what is already
persisted and does only what is still owed, so running it twice in a
row changes nothing unless the world changed in between.

Passes over one Thread do not lock each other out. Each does its work,
inference included, holding no database connection, then writes its
results in one short transaction that succeeds only if nobody wrote
first. What a pass stores before judging is written only if absent and
then read back, so overlapping passes judge the same inputs. A pass that
loses reads the winner's result and reports it, as a pass that finds its
work done always has. Overlap is rare, because the queue already merges
duplicates, so an occasional duplicate round of inference costs far less
than holding a connection through every pass. Its spend is added to the
record, never written over the winner's. Short row locks on request
paths still guard the reply, edit and Handover races.

### Failure
A task gets a few attempts with backoff. One that runs out stays visible
as failed; nothing sweeps it automatically. Failures are classified at
a single point as *recoverable* (rate limits, a model still loading,
timeouts, transient network faults) or *fatal* (missing configuration,
rejected credentials, malformed input). A user's retry re-queues a
failed recoverable task. A fatal one waits for the operator, who
re-queues failed tasks by script.

Every attempt has one time limit. A job locked well past it can only
belong to a worker that crashed or froze, so any running worker releases
it to run again. Idempotent tasks make that safe.

### Requests wait briefly
The Drift gate stays essential: no reply is generated for an arrival the
gate has not judged. A chat request stores the arrival, queues its
judgment in the same transaction, and holds the response open while it
waits for the verdict. A clear verdict starts the Exchange on that same
response; a fire answers with the pause. A Handover waits on its
segment's capture the same way.

The wait is capped short, because a person staring at a silent screen
needs to hear something. When the cap passes, the answer is "still
checking, try again shortly": a temporary-unavailability response that
tells the client when to retry, not a failure, and the arrival stays in
the Thread. The cap belongs to the person waiting, not to the task,
which carries on under its own retry policy. If the browser closes
mid-wait, only the wait ends: the verdict still lands, and a clear one
leaves the arrival judged and unanswered rather than spending on a reply
nobody will read.

### Where the worker lives
Only the backend's entry points start the worker, and task code never
imports the API layer. Whether the worker runs inside the API process or
as processes of its own is configuration, not code.

## Consequences
* **Easier**: judging, titling and capture survive closed tabs and
  restarts; any number of backends and workers can share the queue
  without double work; the gate's cost stops riding on the chat
  request's lifetime; adding the next kind of background work follows a
  fixed pattern.
* **Harder**: the chat path gains a wait and a third outcome besides a
  reply or a pause, which the client must render calmly because a
  cold-loading model will hit the cap often. A fatal failure blocks its
  Thread until the operator acts. Tests must drain the queue explicitly.
  Every new job notifies waiting workers through Postgres, which
  serializes those commits; ADR 0012 records that trade-off and the way
  out.
* **Deferred**: an automatic sweep for failed or owed work, and a queue
  management screen.
