# What the load runs taught us

What strained in each load run, and what fixed it. Run folders live only
on the operator's machine in `load/.runs/`, so the figures that matter are
copied here with their run id. How a run is driven and judged is in
[the load testing architecture](load-testing-architecture.html).

## Where we stand

Step10 passes on the direct path with workers polling for new jobs and
running 6 at once: `20261031T024203Z-step10-load-direct`. It held 9,999
push streams and 2,000 chatters, with no failed request. Chat first byte
p95 was 436 ms, against 480 ms when workers were notified
(`20261030T060616Z`), and the busiest generator used 28.2% CPU.

Step50 passes on the direct path: `20261102T001256Z-step50-load-direct`.
It held 49,965 push streams and 10,000 chatters, with no failed request.
All 50,000 sign-ins succeeded at the first attempt, chat first byte p95
was 448 ms, and the busiest generator used 43.6% CPU. The database, an
r7g.4xlarge, held flat at 52.9% CPU through the hold, peaking at 54.9%,
while workers started about 41,700 jobs a minute.

## What strained, and the fix

**Too few jobs ran at once.** The first step50 run queued jobs while
worker CPU stayed under 54%. Fixed by letting each worker run several
jobs at once: 16 at first, and 6 since polling made jobs start in bursts.

**Worker CPU.** With 4 workers, all 16 slots were busy and CPU reached
99%. Chats waited for the gate's jobs, and first byte p50 rose to 6.3 s
(`20261022T034938Z`). Fixed with more 1 vCPU workers: 8 for step10 and 40
for step50. A worker is one Node process, so a second core would sit idle.

**The gate read every embedding of the Thread.** Worker CPU per job grew
from 16 ms to 36 ms across a flat hold (`20261022T093931Z`). Fixed by
reading only the newest two arrivals' vectors.

**One hot row held every spend write.** Each insert updated the day's
single total, so writers queued on its lock. Fixed by splitting the day
into sixteen rows.

**The load balancer grew under the load and cut push streams.** One
growth cut 8,800 streams, and another failed 2.81% of sign-ins
(`20261022T093931Z`). Reserving capacity would stop it, but the account's
quota of reserved units is 0. Fixed by an unrecorded warm-up of the same
users before the measured run. A stream that reopens within 10 s no
longer counts as a failure. On step50 a warm-up faster than the run
was not enough. It reached about 28,000 of its 50,000 users, the load
balancer began the run at about 30 capacity units, and while it grew to
about 560, 27,076 sign-ins failed without an answer
(`20261031T040409Z`). Fixed by ramping the warm-up as slowly as the
run. The load balancer then began the run at about 560 units, and no
sign-in failed (`20261102T001256Z`).

**The API kept dead streams for 15 minutes,** Linux's default for
unacknowledged data. Fixed by making the API's tasks give up after about
100 s.

**A stalled generator pushed back the rest of its ramp.** In the first
warm-up the generators stalled for up to 12 s at a time, and the ramp ran
late until the generators hit their time limit (`20261029T035850Z`).
Fixed by giving each user its own start time on the ramp.

**Generator CPU was judged while the generators started and stopped.**
The minute the users were stopped read 74.9% and 99.7%, against at most
40.3% under load. The minute a generator boots in read 99.7% against
24.7% under load (`20261030T014328Z`).

**The per-minute request check split the end of the hold.** Thousands of
push streams close together when the hold ends, and the generators and
the load balancer put about 2,090 of them on different sides of a
minute's edge (`20261030T014328Z`).

Both are fixed by judging only the whole minutes in which the generators
carried the load: from the last generator's start to the end of the hold.

**A printed step configuration lost a field.** A sized step was refused
because the run command dropped the share of users who chat. Fixed by
keeping the whole configuration and refusing one without that field.

**The quota check counted a deploy surge** that a first raise never uses.
Fixed by giving each step its own deploy policy.

**Every queue commit waited for the log to reach disk.** A commit that
notifies workers holds one database-wide lock until its log is flushed,
so enqueues lined up behind each other's flush. Log write waits averaged
1.43 sessions and the enqueue lock 0.59 (`20261030T014328Z`). Fixed by
letting the queue's own commits and standalone enqueues return before
the flush. At the same load these fell to 0.73 and 0.17, and job wait
p95 from 49 to 33 ms (`20261030T060616Z`). Database CPU and what users
see did not move: the gain is headroom on a lock that grows with the
chat rate.

**The notification lock ran out at step50.** Every enqueue sent workers
a notification, and commits that notify take one database-wide lock in
turn. Near 8,000 chatters the enqueues fell behind it. `Lock:object`
averaged 497 sessions with a peak of 899, database CPU fell from 71% to
16%, and 48,843 chats timed out with a 504 (`20261030T084021Z`).
Performance Insights put nearly all of that wait on `commit`, so the
cause is measured. Fixed on aws-prod by adding jobs without a
notification, with idle workers polling every 100 ms instead. Home
deployments keep notifying.

**Polling started jobs in bursts.** Two step10 runs of polling on two
deployments agree (`20261030T105417Z`, `20261031T003201Z`). A worker
ran 10 or more of its 16 jobs at once in 79 and 88 of the hold's 152
worker-minutes, against 0 to 2 when notified, though on average it ran
fewer than 2. A burst shares the worker's one core, so the judge's run
p50 went from 47 to 88 ms while worker CPU per job fell, and chat first
byte p95 rose from 480 to 702 ms. Fixed by running 6 jobs at once per
worker. At the same load the judge's run p95 halved, from 304 to
147 ms, its wait did not grow, and chat first byte p95 fell to 436 ms
(`20261031T024203Z`). What bunches the jobs is a guess: eight workers
polling every 100 ms look about every 12 ms between them, which piles
up only one or two jobs per look.

## Still open

- **What polling still costs.** The middle is slower than notifying:
  the gate verdict's p50 is 125 ms against 64, and chat first byte p50
  146 ms against 85 (`20261031T024203Z`, `20261030T060616Z`). Of the
  judge's extra 50 ms at p50, about 20 ms is waiting for a poll (11 to
  31 ms) and about 30 ms is running longer (47 to 77 ms). Every
  worker still reached all 6 of its slots in every minute.
- **The API's database pool fills in bursts.** One copy had all 40
  connections in use, with 50 to 74 waiting, in the three minutes when
  first byte p95 reached 1,001 to 1,980 ms (`20261031T003201Z`). At 6
  jobs per worker, at most 2 waited (`20261031T024203Z`), but a
  notified run reached 53 (`20261029T094411Z`). So the cause is not
  settled.
- **API CPU climbs across the hold.** The busiest task went from 58% to
  81% on a flat 4,350 replies a minute (`20261029T053022Z`). At 6 jobs
  per worker it held flat, 62% in the first half of the hold and 61% in
  the second (`20261031T024203Z`). On step50, with ten times the API
  tasks, the busiest held at 38% in both halves (`20261031T040409Z`),
  so the API is no longer the nearest limit.
- **Auth runs unevenly.** During step50's ramp the busiest auth task ran
  at 66 to 92% CPU while the average stayed at 27 to 30%
  (`20261102T001256Z`). Sign-ins were fast all the same, p95 350 ms at
  the API, but CPU scaling would react to the one hot task. The API
  finds the auth tasks by name and keeps its connections, so each API
  copy may stick to a few of them. That is a guess until each auth
  task's sign-ins are recorded.
- **Spend writers wait on each other at step50.** Row lock waits
  averaged 3.9 sessions over the hold, against none on step10, and rose
  from 3.0 in its first half to 4.8 in its second (`20261102T001256Z`).
  They are almost all `addSideCost` and the `message_usage` insert.
  Both add to the day's spend total, which is split into 16 rows, so
  those rows are the likely source. Jobs did not slow: the judge ran
  92 ms against 83 ms on step10.
- **Chat's slowest replies arrive late outside the app.** In step50's
  hold, chat first byte p95 averaged 566 ms with minutes up to 987 ms,
  against 402 ms and 713 ms in the previous step50 hold
  (`20261031T040409Z`). The median held at 144 ms, and the app's own
  first token p95 stayed between 250 and 400 ms in every minute
  (`20261102T001256Z`). Whether the gap is in a generator, an API copy
  or the load balancer is not recorded.

## Keeping this file useful

- One entry per strain: what strained, with its figure and run, and the
  fix. Say when a cause is a guess.
- Delete an entry that no longer matters. Git keeps the history.
