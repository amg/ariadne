# What the load runs taught us

A running record of what each aws-prod and cubi run hit, what we changed
because of it, and what we now believe. Run folders live only on the
operator's machine in `load/.runs/`, so the figures that matter are copied
here, each with its run id. How a run is driven and judged is in
[the load testing architecture](LOAD-TESTING-ARCHITECTURE.html).

New runs go at the bottom of [The runs](#the-runs), oldest first. Beliefs
that a run changed go in [What we believe](#what-we-believe), with the run
that taught it. Say when something is a guess.

## What we believe

**The worker is one Node process per task, and it is CPU-bound.**
- At 16 jobs at once the worker's limit is CPU, not job slots. A 1 vCPU
  task pinned at 99% with 4 workers for 10,000 users, and sat at 41% to 62%
  with 8 (runs 1 and 2).
- More 1 vCPU tasks, not bigger tasks: a second core would sit idle.
- Step10 is one fifth of step50: 8 workers to 40.

**The work per job grew through a hold because the gate read every
embedding of the thread.** Measured, and fixed in the code; not yet seen
on a run.
- On a flat load, worker CPU per job started rose from 16 ms to 36 ms over
  run 2's hold, and database CPU per job from 13 ms to 21 ms. Run 1 showed
  the same, 19 ms to 34 ms in the workers. The two gate tasks grew most:
  in run 2 a judgment's run time went from 70 ms to 127 ms and a fold's from
  47 ms to 87 ms, while the memory task stayed near 35 to 50 ms.
- Every judgment and every fold read all of the thread's stored vectors,
  sent as text and parsed again. Against a real Postgres, that read took
  0.3 ms at 1 turn, 4.7 ms at 20 and 13.4 ms at 60, and the whole chain
  read 420 rows at 60 turns.
- The gate now reads the vectors of the newest two arrivals and their
  replies only. The rest are read only when a pass has to rebuild the
  gate's state from the first arrival. The whole chain read now takes
  1.8 ms at 1 turn and 4.4 ms at 60, and the vectors it reads no longer
  depend on the thread's length. The gate's tests pass unchanged.
- What still grows is small: the rows that name each message, verdict and
  segment. Production threads grow too, so this mattered beyond load runs.

**One hot row serialised all spend writes.**
- Every spend insert fired a trigger that updated the day's single total,
  so writers queued on its lock until commit (run 1: `Lock:transactionid`,
  sessions mostly waiting).
- Fixed by splitting the day into sixteen rows, one per transaction. The
  lock wait disappeared from the top waits (run 2).
- Left behind: `WALWrite` waits rose (mean 1.64 sessions, peak 3.57) and a
  `Lock:object` wait appeared (mean 0.95, peak 3.26). Neither is explained.
  Neither step10 run kept the statements behind its waits. The archive now
  keeps the busiest five statements of each of the ten busiest waits, so
  the next run will name them.

**The load balancer scaled in the middle of the load and dropped
connections.** The operator's reading, borne out by the figures in both
runs.
- Each event starts with one zone going silent for a minute: zone 2b
  reported nothing at 03:58 (run 1) and at 09:47 (run 2). In the next
  minutes both zones' active connections fell (run 1: about 7,800 each to
  2,626 at 04:00), and new connections jumped from about 2,000 a minute to
  8,000 to 12,000.
- Sign-ins, threads, chats and push streams in flight at that moment
  failed with no answer. Every push stream that ended early broke off
  mid-stream, after its 200, rather than closing cleanly. The generator
  sets no time limit on a stream, so the connection broke under it. Every
  one was open again within 10 s: 8,797 of 8,797 in run 1 and 7,324 of
  7,324 in run 2.
- The streams cut were the ramp's whole cohort: all but 256 had lasted 1
  to 15 minutes, with a median of 4.5 to 7.5 minutes in each minute of an
  event. None had lasted 15 minutes or more.
- Run 1: after the ramp. Run 2: at about 8,000 users, in the ramp, and
  again inside the hold, and a small one later.
- The load balancer's own figures show it outgrowing itself. In run 2 it
  used 40% of its capacity at 09:47 and 100% from 09:49 to 09:53. Its
  capacity, the units it needed over the share it used, went from about
  50 units (20 at 40%) to about 140 (30 at 21%) by 09:59. It needed 30 to
  40 units through the hold and 90 in the reconnect storm.
- It broke three of the pass criteria without anything being wrong in the
  app: push streams through the hold, sign-in failures and first byte p95.
  First byte p95 over the hold alone was 1,364 ms in run 2, under the
  2,500 ms limit, though the hold had events of its own at 09:52 and
  10:00. So the run-wide 2,583 ms most likely came from the event in the
  ramp, where a minute's p95 reached 9,786 ms. That is a reading, not a
  figure rebuild gives.
- Step50 has five times the connections, so expect it to be worse.
- What we do about it. Reserving capacity (about 14 units per thousand
  users, step10's own growth) would stop the growing, but the account's
  quota of reserved units is 0 until AWS raises it. So a load run first
  warms the load balancer up. The same users come up unrecorded, as fast
  as auth allows (6.5 minutes for step10), hold 2 minutes, and stop. Not
  yet proven on a run. And a stream that the load
  balancer, or anything else beneath the app, ends and the user reopens
  within 10 s is not a failure: the infrastructure changing is not the
  app failing. Such a user counts as holding a stream for the push
  streams criterion. Rebuilt that way, run 1 held 9,984 and run 2 held
  9,999, both passing. Sign-ins and chats in flight when it happens
  still fail, because a user sees those.
- The warm-up lengthens every load run, so the load stack now lives up to
  80 minutes.

**The app did not always notice a dead stream.** In run 1 the API kept
about 8,800 closed streams for about 15 minutes, until the network gave up
on them, and counted 18,800 against 10,000 real ones. Both copies kept
their share: about 9,400 each against about 5,000 live (run 1, by copy).
Run 2 did not. Push streams per API task is the planned scaling signal, so
a count that can be inflated by a load balancer event is a problem.
- 15 minutes is Linux's default for giving up on data that is never
  acknowledged. The API's tasks now give up after about 100 s, which
  closes the stream. Separately, a stream whose reader stops taking what
  is written is ended at its next heartbeat; that does not catch a tab
  that vanished.
  Whether Fargate accepts the kernel setting is proven only by the next
  raise.

**How to read a mismatch between the generators and the load balancer.**
- A request counts at the load balancer when it completes, so a stream
  that was cut never counts there.
- The generators' excess over the load balancer, in a minute, is about the
  number of streams that were cut in it. Rebuild counts those as
  `push_streams_ended_early`, by the minute they ended.
- A load balancer minute at half the generators' and the API's figure is a
  half-reported minute, and the zone columns show which zone went silent.
- A stream that broke off is left out of the generators' side of the
  cross-check, because the load balancer never counts it. A stream cut
  off and reopened within 10 s is not counted as a failure either.
- What then still disagrees is the load balancer under-reporting while it
  grows: 03:58 (run 1) and 09:47 to 09:48 (run 2), where both zones
  counted about half of what the generators and the API both counted.

**Smoke cannot prove a sized step.** A smoke run records no sized limits,
so it never needed the step's share of chatting users. The first step10
attempt was refused because that field was stripped from the configuration.
Anything that reads a printed step configuration needs a test on a real one.

**The quota arithmetic counted a deploy surge that a first raise never
uses.** A step can now say how its deploy replaces tasks. Load steps replace
them, so step50 needs 98.5 of the 160 On-Demand vCPU. A one-task service
needs a minimum of 0% to be replaced at all, because ECS rounds the
minimum up.

**Timings.** The archive seals a run about 7 minutes after it ends (runs 1
and 2). A step10 run is 10 minutes of ramp, 20 of hold and about 1 minute of
ramp-down.

## The runs

### 20261014T034350Z-step50-load-direct, an early step50 run, not a pass

Before the harness recorded why things failed.
- About 22,800 users signed in and about 22,700 push streams open against
  50,000. Chat first byte p95 in the 10 to 30 second bucket.
- Worker CPU never passed 54% while jobs queued, so the limit was how many
  jobs ran at once. Auth CPU never passed 26%. Database 52% at a third to
  half the designed chat rate.
- Led to: the worker's job concurrency of 16, the generator work, the
  recording of every request.

### 20261021T234351Z-smoke-load-direct, smoke, pass

First run after the quota check, `load-image` and timestamp run ids.
- Four generators, none down. Every cross-check agreed: 4,538 replies
  against 4,538 at the API, 7,149 requests against 7,149 at the load
  balancer in all 13 minutes, 0 errors.
- `images.load` named a different tag from the backend's, so the generators'
  image can be replaced without a new raise. `rebuild` by timestamp matched
  the run and gave identical bytes.

### 20261022T005251Z-home-smoke-mock, cubi, pass

First cubi run since the refactor. 20 users, host CPU 36%, memory 46%, first
byte p95 136 ms, nothing failed, and the backend and mock stopped cleanly.

### 20261022T025241Z, step10, refused before it began

Not a run: no folder. The run command stripped the share of chatting users
from the step's configuration, so the limits of a sized step could not be
worked out. Fixed by keeping the whole configuration and refusing one
without that field.

### 20261022T034938Z-step10-load-direct, step10 with 4 workers, fail

Two limits missed: push streams 9,575 (at least 9,800) and first byte p95
4,799 ms (at most 2,500 ms). Two cross-checks disagreed.
- The worker was the bottleneck. All 16 slots busy from the start of the
  hold, CPU 66% to 99%, oldest job wait from 0.6 s to 5.9 s, jobs started
  falling from 8,475 to 7,019 a minute. The chat waited for the gate's
  jobs, so first byte p50 went from 0.19 s to 6.3 s. The gate's 10 s wait
  limit was not reached only because the hold ended.
- A load balancer event at about 04:00 dropped about 8,800 push streams,
  which reopened. The API kept them as open for about 15 minutes.
- Spend writes queued on one row.
- Database CPU 51%, sessions busy up to 9.4 on 4 vCPUs, mostly waiting.
- Auth peaked at 35%, generators at 60% CPU, one sign-in failed.
- Led to: the sharded spend counter, 8 workers for step10 and 40 for
  step50, the per-step deploy policy.
- Rebuilt later with the figures it lacked:
  - The fewest push streams, 9,575, were at 04:01:08, inside the event.
  - First byte p95 over the hold alone was 4,924 ms over 74,909 chats, so
    the worker's limit, not the ramp, set that figure.
  - The 159 connections waiting at 04:00 were in an API copy, not a
    worker. The 255 ms event loop delay at 04:18 was in one worker.
  - Worker CPU per job rose from 19 ms to 34 ms, and a judgment's run
    time from 156 ms to 680 ms, while jobs waited for slots.

### 20261022T093931Z-step10-load-direct, step10 with 8 workers and sharded spend, fail

Three limits missed: push streams 7,338, first byte p95 2,583 ms, sign-ins
failed 2.81% (at most 0.5%). One cross-check disagreed in 4 of 32 minutes.
Gate waits at the limit 0%, generators 60% CPU.
- The worker is no longer the limit. Oldest job wait at most 142 ms, slots
  at most 12 of 16, steady first byte p50 0.1 to 0.3 s and p95 0.36 to 0.9 s.
- Three load balancer events, at 09:47 to 09:49 (during the ramp: 3,775
  requests failed in one minute, including 289 sign-ins, and all 18 of the
  load balancer's server errors), at 09:52 (inside the hold, about 3,100
  streams ended and reconnected, p95 7.1 s) and a small one at 10:00.
- Database CPU 48% to 73% over the hold, and worker CPU 41% to 62%, on a
  flat load.
- Led to: ticket 28.
- Rebuilt later with the figures it lacked:
  - The fewest push streams, 7,338, were at 09:52:38, in the event inside
    the hold.
  - Push streams cut: 2,210 at 09:48, 2,010 at 09:49 and 3,104 at 09:52.
    None were cut at 10:00, so that minute's 759 new connections and
    3,359 ms p95 were not the push streams.
  - First byte p95 over the hold alone was 1,364 ms over 76,475 chats.
  - CPU per job, and run time by task, are in the first belief above.
    CPU is not measured task by task; a task's run time stands in for
    its share.

## Keeping this file useful

- Quote figures only with the run that gave them, and say whether the cause
  is known or a guess.
- When a belief is overturned, change it in place and say which run did it.
- Delete a belief that no longer matters. Git keeps the history.
