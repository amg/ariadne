---
description: Adding a job notifies no worker; a worker with nothing to run checks for new jobs on a short timer, so enqueues never wait their turn on the database's notification lock.
---

# ADR 0017: Workers Poll for New Jobs

## Status
Accepted. Replaces the part of ADR 0011 that wakes workers by notifying
them of every new job, and the trade-off that ADR 0012 keeps for it.

## Context
The queue engine notifies workers of every new job, so that an idle one
starts it at once. A commit that sends a notification takes a lock
shared by the whole database and keeps it until the commit ends. So
every enqueue commits one at a time.

At a higher chat rate in a load test, enqueues arrived faster than the
lock let them through. The database sat mostly idle while nearly every
session waited on that one lock, and requests hung until they timed
out.

The engine needs the notification only to start jobs sooner. Its
workers find due jobs without it, and its maintainers name polling as
the way past this lock. The engine has no setting to turn it off.

## Decision
**Adding a job notifies no worker. A worker with nothing to run checks
for new jobs on a short timer.** A busy worker checks again as soon as
it has room, so only a job that meets an idle worker waits for the
timer. Background work that a chat waits on can take that wait.

**The app removes the notification from the engine's own code, as a
stopgap.** Installing or upgrading the engine brings the notification
back, so the app removes it again after each. A test fails when an
upgrade changes the notification so the app can no longer remove it.
This works around the engine instead of through it, and ends when the
engine offers a setting.

A job is still queued inside the caller's transaction, so it commits or
rolls back with the data it belongs to.

## Considered
* **Fewer notifying commits**, by queueing jobs in batches or merging
  jobs. Stays within what the engine supports, but enqueues still take
  the lock in turn, so a higher chat rate reaches it again. A job queued
  in the same transaction as the data it belongs to cannot join a batch.
* **Writing jobs into the engine's tables without its functions.**
  Leaves the engine's code alone, but works on tables the engine keeps
  private and copies logic that can drift from the engine's own.
* **Waking workers through the app's message bus after the commit.**
  Starts jobs at once without the lock, but adds a message to every
  enqueue and a second path to keep correct. It stays the next step if
  the timer's wait costs too much.
* **A broker outside the database.** Removes the lock and the timer, but
  can no longer queue a job in the same transaction as its data.
