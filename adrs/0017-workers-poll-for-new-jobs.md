---
description: Where many users share the queue, adding a job notifies no worker and idle workers check for new jobs on a timer, so enqueues never wait their turn on the database's notification lock; elsewhere workers are notified as the engine intends.
---

# ADR 0017: Busy Deployments Poll for New Jobs

## Status
Accepted. Replaces, for busy deployments, the notification on every new
job that ADR 0011 relies on to wake workers at once, and the
serialized-commit trade-off that ADR 0012 keeps for it.

## Context
The queue engine notifies workers of every new job, so that an idle one
starts it at once. A commit that sends a notification takes a lock
shared by the whole database and keeps it until the commit ends. So
every enqueue commits one at a time.

At a higher chat rate in a load test, enqueues arrived faster than the
lock let them through. The database sat mostly idle while nearly every
session waited on that one lock, and requests hung until they timed
out.

Polling has costs of its own. A new job waits for the next check, and
the jobs that pile up between two checks all start at once in the same
worker and slow each other down. Fetching fewer jobs at a time does not
help, because the worker fetches again at once until none are left.
Only checking more often shortens the pile. A home deployment with a
handful of users pays these costs and gains nothing, since its enqueues
never come close to the lock's limit.

The engine needs the notification only to start jobs sooner. Its
workers find due jobs without it, and its maintainers name polling as
the way past this lock. The engine has no setting to turn it off.

## Decision
**Each deployment chooses whether its workers are notified or poll.**
By default they are notified, as the engine intends. A busy deployment
sets how often workers check for new jobs, and then adding a job
notifies no worker. A busy worker checks again as soon as it has room,
so only a job that meets an idle worker waits for the timer.

**The app switches the notification in the engine's own code, as a
stopgap.** Installing or upgrading the engine turns the notification
back on, so every worker sets it to its deployment's choice on start.
The switch works both ways, so a deployment that stops polling gets its
notifications back. A test fails when an upgrade changes the
notification so the app can no longer switch it. This works around the
engine instead of through it, and ends when the engine offers a
setting.

A job is still queued inside the caller's transaction, so it commits or
rolls back with the data it belongs to.

## Considered
* **Polling everywhere.** One behaviour to reason about, but every
  deployment pays the polling wait and the pile-up, and a home
  deployment gains nothing for it.
* **Fewer notifying commits**, by queueing jobs in batches or merging
  jobs. Stays within what the engine supports, but enqueues still take
  the lock in turn, so a higher chat rate reaches it again. A job queued
  in the same transaction as the data it belongs to cannot join a batch.
* **Writing jobs into the engine's tables without its functions.**
  Leaves the engine's code alone, but works on tables the engine keeps
  private and copies logic that can drift from the engine's own.
* **Waking workers through the app's message bus after the commit.**
  Starts jobs at once without the lock or the pile-up, but ties the
  queue to a second component, which is a step towards replacing the
  engine rather than working with it.
* **A broker outside the database.** Removes the lock and the timer, but
  can no longer queue a job in the same transaction as its data.
