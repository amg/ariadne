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

Smoke passes through CloudFront: `20261113T104904Z-smoke-load`. All
1,000 users signed in, 1,000 push streams held through a 10-minute
hold without one ending early, and chat first byte p95 was 185 ms.
CloudFront added about 4 ms between the edge and the load balancer, and
about 8 ms to a sign-in end to end.

Scale10 passes through CloudFront with its services scaling on CPU:
`20261114T100754Z-scale10-load`. The API, worker and auth started at 2
tasks each. 10,000 users rose over 30 minutes with no warm-up, held for
15 and left over 20. All 10,000 push streams and 2,000 chatters held, no
push stream ended early, rise and fall included, and all 10,000 sign-ins
succeeded. Chat first byte p95 was 577 ms in the hold, against 446 ms in
step10's. Only the worker scaled. It went to 3 and then 4 tasks on the
rise, and was back at 2 three minutes after the run ended. Two API tasks
carried the whole hold at 62% CPU at most, under their 65% target, and
auth never left 2.

Scale50 holds through CloudFront but does not pass yet:
`20261116T002004Z-scale50-load`. 50,000 users rose over 45 minutes,
held for 20 and left over 30. Every service scaled: the API to 13 tasks,
the worker to 19 and auth to 8. Once the run is judged with a slice
down until its users had signed in again, every criterion passes. At the
fewest, 49,995 push streams and 10,000 chatters were open, chat first
byte p95 was 922 ms, and 0.02% of sign-ins failed. It still fails on
two checks that are not about users: the API was 2 min 42 s late back to
its floor, and the load balancer counted 3,675 requests against the
generators' 6,723 in the minute it grew.

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
sign-in failed (`20261102T001256Z`). A 30-minute rise to 10,000 users
needed no warm-up. The load balancer grew from 10 to 30 units and cut no
stream (`20261114T100754Z`).

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

**The seed came out empty, and replaced the good one.** Cloudflare
answered every sign-up of a reseed with its 403 challenge page. The
seeding run counts a failed sign-up as nothing worse than a log line,
so it snapshotted an empty database and deleted the older seed. The
next run's sign-ins all failed with wrong credentials, at 6 ms each
against the 220 ms a password check takes (`20261113T064642Z`). The
challenge went with Cloudflare's proxy. A reseed through CloudFront
signed up all 100,000 accounts.

**Auth ran unevenly.** During step50's ramp the busiest auth task ran
at 66 to 92% CPU while the average stayed at 27 to 30%
(`20261102T001256Z`). Fixed by reaching auth through ECS Service Connect,
which spreads requests over every auth task. On scale10 the busiest of
the two tasks stayed within 8 points of the average, apart from the
first minute of sign-ins (`20261114T100754Z`).

**A replacement generator signed its whole slice in at once.** Spot
took a generator during scale50's rise. Its replacement signed 5,000
users in over one minute, about five times the run's own arrival rate
and more than its 4 auth tasks could check. For five minutes 95 to 99.8% of sign-ins failed with a 500
after 15 s, and the users' retries kept auth busy until all 5,000 were
in (`20261116T002004Z`). Fixed by bringing a replaced slice back no
faster than the run's users arrived.

**The verdict counted a replaced slice as back too early.** It took the
slice as back once its replacement's ramp was over, while most of its
users were still failing to sign in, and it read the hold's fewest push
streams, 46,623, 19 ms later (`20261116T002004Z`). Fixed by keeping a
slice down until its replacement has every user signed in again. A
slice that never gets them all back is judged as before.

**The per-minute request check missed streams the load balancer
closed.** Each time the API scaled in, the load balancer counted the
push streams of the stopped task as answered, 11,848 in one minute
(`20261116T002004Z`). The check had assumed it never counts a stream
that broke off, and it does miss those cut while the load balancer
grows. A minute now agrees when the load balancer's count lies between
the generators' count without those streams and the count with them.

**Checkpoints stall the database at scale50.** Job waits reached 7 to
13.5 s at three moments of the hold and the fall. In the minute after
each, log write waits rose to between 26 and 58 sessions, against 2 to
7 otherwise. The worst stall made 1,977 chats give up waiting for the
gate. The database wrote 50 GB of log, 14 of its 19 checkpoints came
from the log filling, and 2.58 million log records were whole pages
(`20261116T002004Z`). Log compression is on from the next run. That the
stalls are checkpoints, and that compression shortens them, are both
guesses until that run.

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
  settled. On scale10, with 5,000 streams on each of two API copies,
  one copy filled its 40 connections with up to 22 waiting while API
  CPU stayed at 57 to 62% (`20261114T100754Z`). CPU scaling does not
  see this.
- **API CPU climbs across the hold.** The busiest task went from 58% to
  81% on a flat 4,350 replies a minute (`20261029T053022Z`). At 6 jobs
  per worker it held flat, 62% in the first half of the hold and 61% in
  the second (`20261031T024203Z`). On step50, with ten times the API
  tasks, the busiest held at 38% in both halves (`20261031T040409Z`),
  so the API is no longer the nearest limit.
- **The worker scales out 6 minutes behind its CPU.** On scale10,
  worker CPU crossed its 70% target at 10:29 and peaked at 85%, and the
  third task was asked for at 10:34:48. Meanwhile job wait p95 rose from
  about 120 to 308 ms, and fell back once the task ran
  (`20261114T100754Z`). On scale50 it took about 3 minutes, and chat
  first byte p95 reached 3.4 s while the new tasks started
  (`20261116T002004Z`).
- **The API scales past its need and back in during the hold.** On
  scale50 it went to 13 tasks while its CPU was near 50%, under its 65%
  target, then removed three during the hold. Each removed task cut its
  push streams, up to 11,848 at once, and all reopened within 10 s.
  Streams stay on the task they opened on, so the first two tasks
  carried about 12,000 each and later ones 1,800 to 6,700. It scales in
  one task every 6 minutes, too slowly to reach its floor within the
  30-minute watch (`20261116T002004Z`).
- **A new auth task did not take a hot task's load.** In the sign-in
  burst one auth task stayed at 98% CPU while the average fell to 26%,
  and four more tasks did not bring it down (`20261116T002004Z`).
  Whether the hot task was still checking passwords for requests the API
  had already given up on is a guess. The run does not record CPU or
  requests per auth task.
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
- **A seed or a run can fail quietly.** A seed snapshots and replaces
  the older one whatever its sign-ups did. A step without limits, such
  as smoke, passes even when no user signed in (`20261113T064642Z`).

## Keeping this file useful

- One entry per strain: what strained, with its figure and run, and the
  fix. Say when a cause is a guess.
- Delete an entry that no longer matters. Git keeps the history.
