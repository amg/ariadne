---
description: The queue's own commits and standalone enqueues return before their log is flushed, because the worst a crash then does is run a job again; every write that holds a user's data or a task's result stays flushed.
---

# ADR 0016: Queue Commits Skip the Flush

## Status
Accepted. Takes the wait for the disk out of the serialized enqueue
commits that ADR 0012 names as a kept trade-off; the rest of 0012 stands.

## Context
Every job commits at least three times: when it is queued, when a worker
fetches it, and when it completes. A commit that sends a notification
holds one lock for the whole database server until its log is on disk
(ADR 0012), so enqueues commit one at a time, each behind the last
one's flush. Under load the database spends much of its time waiting
for log flushes, and the lock saturates as the chat rate grows.

Postgres can let a commit return before its log is written to disk. A
crash then loses only the newest commits: a transaction is never
half-saved, what is lost is always the newest commits, and a clean
restart loses nothing.

## Decision
**The worst a crash may do is make a job run again.** Nothing a user
typed, and no result a task has stored, may be lost. The queue already
runs every job at least once: a crashed worker, an attempt past its time
limit and a lock past the stale-lock sweep each run a job again. A lost
commit is one more cause of the same rerun, so it is safe exactly where
a rerun is.

### Which commits skip the flush
- **The queue engine's own commits**: fetching, completing and failing a
  job. The engine works through a pool of its own whose connections open
  with the setting off. A lost fetch leaves the job waiting, and a lost
  completion leaves it locked until the sweep frees it. Either way it
  runs again.
- **An enqueue made on its own**, outside any transaction. Whoever
  queues it must already have a way to queue it again if it is lost, and
  a new standalone enqueue is added only with one.

### Which commits stay flushed
- **A task's own writes.** Tasks write through the app's pool. A stored
  embedding, verdict, fold, Fact or pointer is what a rerun relies on, and
  a user may already have seen it, so it is never made asynchronous.
- **An enqueue inside a caller's transaction**, which is as durable as
  that transaction. The arrival's judgment is queued in the transaction
  that stores the arrival, and an edit's judgment in the one that stores
  its fork. Losing either would lose what the user typed.

### Tasks must be safe to run again from any point
A task's writes are separate commits, so a rerun can begin after any of
them. Every task is therefore proved to reach the same result when run
again, both after it finished and after it stopped between two writes. Spend follows the same rule: a rerun that pays a provider again
records that spend, because it was paid, and a rerun that reuses stored
work records nothing new. A write and the spend it incurs commit
together, so a stop never leaves one without the other.

## Considered
* **Setting it for the whole database or the app's pool.** Simpler, but a
  crash could then lose a user's Message or a task's stored result,
  which is no longer only a rerun.
* **A queue that polls instead of notifying.** Removes the lock rather
  than shortening it, but gives up waking workers at once. It stays the
  next step if the log flush is still the limit.
* **Fewer commits per job**, such as merging the two gate jobs. Also
  held back until this one is measured.
