# ADR 0011: Durable Background Work on a Postgres Queue

## Status
Accepted. Supersedes the in-process capture mechanics of ADR 0010 (the
fire-and-forget pass, the per-thread map, and a Handover that starts its
own capture). Everything else in 0010 stands. The Drift gate (ADR 0006,
amended by 0010) keeps its place before inference; only where its work
runs changes.

## Context
Three kinds of work hang off a chat today without being the chat itself:
the Drift gate's judging of every arrival, the titling of a Thread, and
Fact capture. All three run inside the request process. The gate runs
inline in the chat request, so a closed browser or a restarted backend
can strand an arrival half-judged. Capture is fired and forgotten, kept
one-at-a-time per Thread by an in-memory map, so a restart loses it and
a second backend would duplicate it. Titling waits for the browser to
ask for it, so a Thread whose tab closed early stays untitled.

All of this is work that should finish whether or not anyone is still
watching, and should happen exactly once in effect no matter how often
it is asked for.

## Decision

### The engine
Background work runs on **graphile-worker** over the existing Postgres,
in its own `queues` schema, apart from the app's tables. It needs no
new service, picks work up within milliseconds, and lets a task be
queued inside the same transaction as the data that triggers it, so the
two commit together or not at all. BullMQ was rejected for needing
Redis, for being unable to queue inside a Postgres transaction, and for
charging for per-key serialization.

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
handed
the enqueue side from the top of the call chain, so the code beneath
sees an ordinary async function and never knows a queue exists.

### Exactly once, in effect
Duplicates are refused at the door: a task queued while an identical
one is still waiting is merged into it, keyed by what it works on (the
arrival, the Thread, the Segment). Correctness does not rest on that.
Every task is idempotent by state: it re-reads what is already
persisted and does only what is still owed, so running it twice in a
row changes nothing unless the world changed in between.

Work on one Thread's live chain is serialized by a Postgres advisory
lock rather than process memory, released when the task finishes or
fails. This holds across processes, so the worker can leave the API
process without the lock moving.

### Failure
A task gets three attempts with exponential backoff. One that runs out
stays visible as failed; nothing sweeps it automatically. Failures are
classified at a single point as *recoverable* (rate limits, a model
still loading, timeouts, transient network faults) or *fatal* (missing
configuration, rejected credentials, malformed input). A user's retry
re-queues a failed recoverable task. A fatal one waits for the operator,
who re-queues failed tasks by script. A management screen can come
later.

### The chat waits on the gate, briefly
The Drift gate stays essential: no reply is generated for an arrival
the gate has not judged. A chat request stores the arrival, queues its
judgment in the same transaction, and holds the response open while it
waits for the verdict. A clear verdict starts the Exchange on that same
response. A fire answers with the pause, as before.

The wait is capped short (ten seconds by default) because a user
staring at a silent screen needs to hear something. When the cap
passes, the answer is "still checking, try again shortly". It is a
temporary-unavailability response that tells the client when to retry,
not a failure, and the arrival stays in the Thread. A retry waits on
the same judgment again. The cap belongs to the person waiting, not to
the task, which carries on under its own retry policy. If the browser
closes mid-wait, only the wait ends: the verdict still lands, and a
clear one leaves the arrival judged and unanswered rather than spending
on a reply nobody will read.

### Where the worker lives
The worker starts inside the API process for now. Only the server's
entry point starts it, and task code never imports the API layer, so
moving it to its own container later is a deployment change, not a
rewrite.

## Consequences
* **Easier**: judging, titling and capture survive closed tabs and
  restarts; a second backend can no longer double-capture; the gate's
  cost stops riding on the chat request's lifetime; adding the next
  kind of background work follows a fixed pattern.
* **Harder**: the chat path gains a wait and a third outcome besides a
  reply or a pause, which the client must render calmly because a
  cold-loading model will hit the cap often. A fatal failure blocks its
  Thread until the operator acts. Tests must drain the queue explicitly.
* **Deferred**: an automatic sweep for failed or owed work, a queue
  management screen, and the move to the domain schemas, which this
  work precedes.
