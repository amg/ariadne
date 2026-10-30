# What the load runs taught us

What strained in each load run, and what fixed it. Run folders live only
on the operator's machine in `load/.runs/`, so the figures that matter are
copied here with their run id. How a run is driven and judged is in
[the load testing architecture](LOAD-TESTING-ARCHITECTURE.html).

## Where we stand

Step10 passes on the direct path: `20261030T060616Z-step10-load-direct`.
It held 10,000 push streams and 2,000 chatters, with no sign-in failures.
Chat first byte p95 was 480 ms and the busiest generator used 30.8% CPU.

## What strained, and the fix

**Too few jobs ran at once.** The first step50 run queued jobs while
worker CPU stayed under 54%. Fixed by letting each worker run 16 jobs at
once.

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
longer counts as a failure.

**The API kept dead streams for 15 minutes,** Linux's default for
unacknowledged data. Fixed by making the API's tasks give up after about
100 s.

**A stalled generator pushed back the rest of its ramp.** In the first
warm-up the generators stalled for up to 12 s at a time, and the ramp ran
late until the generators hit their time limit (`20261029T035850Z`).
Fixed by giving each user its own start time on the ramp.

**Generator CPU was judged while the generators stopped their users.**
That minute read 74.9% and 99.7%, against at most 40.3% under load. Fixed
by judging generator CPU only up to the end of the hold.

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

## Still open

- **The enqueue lock, smaller.** `Lock:object` averaged 0.17 sessions
  and peaked at 0.98 (`20261030T060616Z`), likely from enqueues inside a
  caller's transaction, which still wait for the flush. One commit holds
  it at a time, so it grows faster than the chat rate; step50 shows
  whether that matters.
- **The API's database pool fills in bursts.** Both copies reached all 40
  connections, with up to 16 waiting, in the run's slowest minute for
  first byte: p95 878 ms against 467 ms across the hold
  (`20261030T060616Z`).
- **API CPU climbs across the hold.** The busiest task went from 58% to
  81% on a flat 4,350 replies a minute (`20261029T053022Z`). It is the
  nearest limit for step50.

## Keeping this file useful

- One entry per strain: what strained, with its figure and run, and the
  fix. Say when a cause is a guess.
- Delete an entry that no longer matters. Git keeps the history.
