# Drift gate: constant cost per arrival, on a per-model schema

Priority: before the aws-prod `step50` run. Two parts in one branch:
part 1 cleans up the analysis schema, part 2 builds the checkpoints on
top of it. Part 1 lands first so part 2's tables reference the final
keys.

**Status:** an earlier change already cut a judgment to a fixed 9
queries. What remains grows with the Thread: every judgment still
rebuilds the gate's running state from the first arrival.

## Why

The `step10` run (2026-10-12, direct path, 9,740 users, about 1,950
chatting once a minute) held the request rate flat for fifteen minutes
while Threads grew from about 10 to about 27 Turns:

| Service | CPU at ~10 Turns | Rise per Turn |
|---|---|---|
| Worker (4 tasks) | 17.6% | +0.58 points |
| API (2 tasks) | 33.7% | +0.70 points |
| Database | 13.5% | +0.23 points |

A judgment costs roughly a fixed part plus 5% of it for every Turn
before the arrival: double at 20 Turns, about six times at 100. That is
the rebuild and its vector read. The API's rise has its own causes and
is logged separately.

## What a judgment does today

Only the gate's *outputs* are stored (the reading, μ, σ, the verdict).
The running state needed to judge the next arrival is not: the Gravity
point and Anchor sums, the segment baseline, the slow patrol. So each
judgment reads every arrival and reply vector in the Thread, replays
them from the first arrival to rebuild that state in memory, and only
then judges the new arrival. It does this twice per arrival, once to
fold the previous Turn and once to judge.

## Part 1: schema cleanup

### What is wrong today

- **Embeddings are not per model.** `message_embeddings` is keyed on
  `message_id` alone, so a model switch overwrites the vector and
  `model_id` in place, while `thread_segments` and `segment_drift_logs`
  already keep one chain per model. The retired chain keeps its
  verdicts but loses the vectors they were judged on.
- **Embedding spend sits on the analysis row.** `embedding_cost_usd`
  on `message_embeddings` adds every model's spend into one number, and
  pruning a retired model's rows would delete spend from the Thread's
  total (`sumThreadSpend` reads it).
- **Turn embedding spend is never recorded.** The fold embeds each Turn
  and drops the cost. "Costs are never lost" does not hold today; past
  Turn spend cannot be backfilled.
- **The rewrite rides the embedding row.** `expanded_text` and
  `expand_outcome` come from the chat-side rewrite and serve every
  embedding model. They are also why `embedding` is nullable: the
  rewrite's outcome is saved before the vector exists.
- **`segment_drift_logs` carries an unused `id`.** Nothing references
  it; one query uses it as a sort tie-break, which on random UUIDs means
  nothing. `(message_id, model_id)` is already unique.

What must hold: costs are never lost; analysis rows hold only analysis;
everything is kept per model, and retired models are pruned only by
hand once a switch has soaked.

### Target shape

| Table | Key | Holds |
|---|---|---|
| `analysis.message_expansions` (new) | `message_id` | `expand_outcome` not null, `expanded_text` present exactly when the outcome is `accepted` |
| `analysis.message_embeddings` | `(message_id, model_id)` | the vector (not null) and its provenance only |
| `analysis.segment_drift_logs` | `(message_id, model_id)` | as today, without `id` |
| `billing.message_side_costs` | `(message_id, kind, model)` | rewrite, judge, fact calls, and arrival and Turn embedding spend (`embedding` kind) |
| `analysis.thread_segments` | `id` | unchanged: referenced by drift logs, capture progress and Turn folds, so it keeps its own id |

A rewrite that was not needed gets its own outcome, `not_needed`,
instead of a null: today the null row is what tells the rewrite step it
already ran.

### Migration

Typed schema builder; raw `sql` only for backfills and triggers.

1. Create `message_expansions`; backfill from every arrival row the
   rewrite step wrote (null outcome becomes `not_needed`); drop both
   columns from `message_embeddings`.
2. Drop the `count_daily_spend` trigger on `message_embeddings` and its
   `count_embedding_cost_usd` function first. Then add the `embedding`
   kind, widen the side-cost key to `(message_id, kind, model)`, and
   backfill `embedding_cost_usd` as `embedding` rows attributed to the
   row's current model, with the side-cost trigger disabled for the
   backfill: daily totals already hold that spend.
3. Drop `embedding_cost_usd`; delete rows still without a vector (a
   rewrite that never reached its embed; the embed step redoes them);
   set `embedding` not null; key `message_embeddings` on
   `(message_id, model_id)`.
4. Drop `segment_drift_logs.id`; promote the unique index to the
   primary key.

### Code

- `recordMessageExpansion` writes `message_expansions`.
- `recordArrivalEmbedding` and `recordTurnEmbedding` insert per model,
  vector included; the overwrite-on-switch branch goes. Both record
  their spend through `addSideCost`, accumulating on conflict, since
  every pass that paid counts.
- Every embedding read filters by the current model and joins the
  rewrite from `message_expansions`.
- `sumThreadSpend` reads embedding spend from side costs.
- `listSegmentDriftLogsByThread` orders by the arrival's `created_at`.
- `rewriteMessageStep`, `embedMessageStep`, `liveChain`, `liveView`,
  `render`, `analyzeThread` pick up the split rows. An edit still
  invalidates every model's signals for the message.

## Part 2: checkpoints

### Two kinds of state, two moments

| | Judgment state | Turn fold |
|---|---|---|
| Describes | statistics of the **readings**, one distance per arrival | where the **segment sits** in embedding space |
| Input | the arrival's reading | the Turn's vector (user message + reply) |
| Changes when | an arrival is judged, before inference | the reply completes |
| Holds | baseline count, mean, M2; patrol count, sum, cumulative, low-water mark and its message | Gravity point sum, Anchor sum, Anchor count, completed Turns, current segment |
| Retry | unchanged | a new row for the new reply |
| Edit or handover | the abandoned arrival's row is skipped; the new arrival gets its own | unchanged |

The fold cannot happen at judgment: the reply it needs does not exist
yet. A fire resets the Gravity point, but the fire is already in the
verdict, so the fold reads it from the drift log ("fired: start the
sums from this Turn") rather than storing an empty state.

### Tables

```
analysis.segment_drift_logs          PK (message_id, model_id)   permanent
  └─ analysis.arrival_judgment_states  PK/FK (message_id, model_id), cascade
       baseline_count, baseline_mean, baseline_m2,
       patrol_count, patrol_sum, patrol_cumulative, patrol_low_water   not null
       patrol_low_water_message_id   null only while the patrol is empty

analysis.message_embeddings          PK (message_id, model_id)   Turn row
  └─ analysis.turn_folds               PK/FK (message_id, model_id), cascade
       segment_id → thread_segments, cascade
       gravity_sum float8[], anchor_sum float8[]   not null, full float64
       anchor_count (1–3), completed_turns         not null
```

The sums are stored in float64 and extended in the same order a rebuild
uses, so a checkpointed judgment equals a full rebuild bit for bit.
pgvector's float4 would round, and a rounded sum can flip a verdict near
the bar. A row that does not exist means "no checkpoint": nothing is
backfilled, and older rows need no nullable columns.

The drift log stays the permanent record of each judgment and keeps all
its columns. Its μ and σ are the baseline *before* the arrival joined,
as the Analysis tab charts them; the judgment state is the baseline
*after*, in the raw form needed to continue (count, mean, M2), kept only
for the next judgment. The previous arrival's judgment state equals this
row's μ and σ, but it is pruned, and finding "the previous live arrival"
across edits is exactly what a self-contained audit row avoids. z stays
stored because it was computed with the parameters of its day.

The drift log gains one column in this part: `immediate_threshold`, the
criterion the verdict was actually judged against — μ +
k·max(σ, σ_floor), or the flat T_segment while the baseline bootstraps
— null exactly when `drift_p` is null. The Analysis tab charts the
stored line instead of recomputing it from today's parameters; z is
already stored for the same reason. The slow channel keeps its fire
channel and low-water anchor; its λ is not a per-arrival line and is
not stored.

When tuning changes, nothing historical is rewritten. Stored verdicts
and thresholds stay records of the regime that produced them, live
baselines roll forward from the old regime until the next fire shreds
them, and judging old lanes under new parameters is replay's job, never
the live lane's.

### Flow

- **Judge arrival K:** one read of the newest live Turn fold with its
  arrival's judgment state; judge; write the verdict, any opened
  segment and K's judgment state in one transaction. A verdict another
  pass wrote first wins, and this pass writes nothing.
- **Fold Turn K:** previous live fold, K's verdict, Turn K's vector;
  insert if absent. Runs as a queue task when the reply completes, or
  inline in the next judgment if the task has not run yet. The Turn
  embedding call leaves the next arrival's critical path.
- **Retry:** the new reply folds from Turn K−1's fold.
- **Edit or handover:** the newest live fold is K−1's; the new arrival
  is judged against it.

### Keep two

Once arrival K is judged, nothing before it can change: only the newest
prompt can be edited, a retry only replaces the newest reply, a handover
only moves the newest arrival. So the K verdict's transaction deletes
every checkpoint of the Thread and model except arrival K−1's (judgment
state and fold) and arrival K's, plus any belonging to abandoned
messages. About 32 KB per Thread, whatever its length.

A fold task that runs after its Turn fell out of the kept two gives up
instead of writing.

### Fallback

When the newest live fold is missing, or its `completed_turns` differs
from the number of live Turns up to it (something earlier was
abandoned), the judgment rebuilds from the first arrival using the
stored vectors, as today, and writes the checkpoints the keep-two rule
keeps. Changing the edit rules later costs a rebuild, never a wrong
verdict.

## Docs and ADRs

- ADR 0006: the live lane still never recomputes stored verdicts; the
  rebuild becomes the recovery path, not the normal one.
- ADR 0007: the verdict step's output includes the judgment state, the
  fold writes its own; the consequence about the nullable vector goes;
  moving columns between tables is not removing a step.
- `CONTEXT.md`: a term for the gate's running state, if "ledger" is not
  wanted (it is listed under the Live chain's words to avoid).
- `.testing/db.md`: table descriptions.
- `.pi/FUTURE-IMPROVEMENTS.md`: the retired-chain pruning note becomes
  true once part 1 lands.

## Tests

Part 1:
- After a model switch both models' vectors exist; switching back
  re-judges nothing and pays nothing.
- The rewrite is paid once per message across models.
- Thread spend after a switch equals both models' embedding spend plus
  chat and side calls, Turn embeddings included; pruning a retired model
  leaves it unchanged.
- Daily spend after the migration equals daily spend before it.

Part 2:
- A judgment's reads and CPU do not grow with the Thread's length.
- A checkpointed judgment equals a full rebuild, verdict for verdict and
  reading for reading, over chains with immediate fires, slow fires,
  muted cold starts, an edit, a retry and a handover.
- After judging arrival K only K−1's and K's checkpoints remain.
- A late fold task for a Turn outside the kept two writes nothing.
- A fold whose `completed_turns` no longer matches the live Turns (an
  arrival abandoned mid-Thread, set up directly) makes the judgment
  rebuild; an ordinary edit does not.
- The chart's threshold line reads the stored `immediate_threshold`;
  changing the parameters leaves old points' lines unchanged.

## Measure

Worker time per task, by task name, as structured log fields, before and
after. On the next load run, worker CPU per arrival should stay flat as
Threads grow.

## Out of scope

- Automatic pruning of retired models (stays manual).
- A future "new Thread from this message": its copied messages carry no
  checkpoints, so the new Thread's first judgment rebuilds once.
