---
description: Thread topic drift is detected on two timescales, offline scoring of stored Turns and a live gate on each arrival.
---

# ADR 0006: Thread topic drift detection

## Status
Accepted. Amended by ADR 0010: a fire on a fresh arrival now pauses the
reply for the user to choose, instead of only marking the message.

## Context
A thread ideally covers one topic. While the conversation stays on
topic, previous context serves its purpose; the moment it drifts, that
context becomes costly baggage — paid for on every turn while
contributing nothing.

Drift must be detected on the user's message before inference starts,
which restricts the information available at that point:

1. **Only the user message exists.** There is no assistant response yet
   to carry the exchange's topic, so drift is scored from the incoming
   message alone, against the conversation it enters.
2. **Many user messages rely on earlier context instead of encoding
   it.** Follow-ups ("what about a motorcycle?", "yeah, make it
   smaller") carry no topic of their own; to capture their topic
   accurately they have to be read with the previous context.

## Decision

Drift detection works on two timescales, both built on the same stored
embeddings:

### Offline analysis — scoring a stored thread

Finds where the topic changed in a thread that already happened (or so
far), and scores every turn, for reports and calibration.

- **The Turn is the unit of measurement.** A single message carries no
  topic of its own, so every complete Turn — user Message and assistant
  reply together — is measured as one unit.
- **Embeddings persist per model.** Vectors from different models live
  in different spaces and therefore cannot be compared.
- **Topic state is a rolling centroid.** Each Topic segment carries a
  Gravity point: the centroid of its turns so far. A Turn is scored
  against the Gravity point *before* it joins the segment. A Turn that
  crosses the threshold is a Boundary turn: it closes the segment and
  starts the next one from its own embedding. Comparison is never
  against the single previous turn — it is against the centroid, and
  that is what tells a continuation from a new topic.
- **An Anchor records how far the thread has moved from its opening
  topic.** The Anchor measures distance only; it never classifies a
  turn. So it can show a return to the opening topic without flagging
  every turn after the first departure forever.
- **Slow drift appears as a report signal.** The same sustained-rise
  accumulator the live lane uses as its second channel runs over the
  stored series, so a topic that drifts away gradually, turn by turn,
  shows in the report.
- **Segment merging is report advice only.** If a topic leaves and
  comes back, the split correctly produces two segments; the report
  flags a possible revisit for the reader. Segments are never joined
  automatically: deciding that two segments are "the same topic again"
  is beyond what embedding distances can do.

### Live detection — the arriving user message

Decides, on the incoming message alone and before inference, whether
the conversation is drifting into a new topic, and may pause the turn
to offer a choice.

- **The arriving message is scored as a Prospective Turn.** It is
  embedded like the user half of a Turn, because the reply does not
  exist yet, and the reading is persisted, so the same reading is never
  paid for twice.
- **Context-dependent messages are rewritten before embedding.** A
  follow-up carries no topic of its own, so when a message reads as a
  continuation, a small model rewrites it into self-contained form
  against the previous Turn, and that rewrite is what gets compared.
  When the rewrite is refused or unusable, the raw message is the
  fallback.
- **The verdict is immediate: one message, one decision.** A topic flip
  can arrive in a single message, and a verdict that waits to confirm
  would always decide one turn late. The reading is judged against the
  thread's own state — its current topic and its noise level — rather
  than one global constant; while a segment is too new to have a noise
  level, a flat calibrated prior bridges. The first turn alone is
  muted, because there is nothing to compare it against yet.
- **Slow drift gets a second channel.** A sustained-rise accumulator
  follows the drift against the segment's Anchor — a reference fixed
  at the segment's opening, so a topic that walks away slowly keeps
  accumulating — and it speaks only while the immediate verdict stays
  silent. Gradual drift that never crosses the immediate criterion
  still fires eventually, and a sharp flip is never delayed: the
  immediate verdict catches it first. After a fire — from either
  channel — the baseline and the accumulator reset around the new
  topic.
- **The live gate is advisory, never blocking.** The detection is
  fallible, so it must not silently decide for the user, and its
  mistakes stay visible: disagreements between the live verdict and
  the offline record are kept as calibration material.
- **The live lane persists as it runs and never recomputes stored
  results.** Refill always moves forward: a thread that predates the
  feature, or the tail an edit invalidated, is rebuilt from where the
  stored rows stop. The online signals therefore survive restarts,
  retries, and flips of the flag. (The step-by-step shape of this
  persistence is ADR 0007.)
- **A judgment's cost does not grow with the thread.** The gate's
  running state persists as checkpoints, and each judgment reads the
  last one instead of recomputing the chain. When a checkpoint is
  missing or stale, the judgment rebuilds from the stored rows and
  writes fresh checkpoints on its way — the rebuild is the recovery
  path, not the normal one. Without the checkpoints, worker time per
  arrival grew with every Turn behind it.
- **Each verdict records the criterion it was judged against.** A later
  parameter change redraws no history.
- **One feature flag sets the expansion tier and the surface.** The
  flag's off position skips the pipeline and hides the Analysis
  surface, but stored signals survive an off period and reappear when
  the flag flips back: the lane ships behind a dial without losing its
  history to a cosmetic setting.
- **The verdict is delivered with the first event of the reply
  stream.** The reader sees the drift flag on the message that
  drifted, not one turn later.

The math — formulas, parameters, numerical guardrails — lives in
`docs/maths/THREAD-DRIFT-MATH.md`.

## What we tried instead

- **Multi-turn windows** — any window straddling a topic flip blends
  both topics and dilutes the flip signal; measured flips dropped
  below threshold already at a window of two (0.237 vs 0.632 for
  single turns), and the dilution grows with window size.
- **Two thresholds: anchor distance plus consecutive change** — the
  anchor stays tripped after the first real departure (every later
  turn flagged), and consecutive change can't tell a same-topic
  follow-up from a topic flip.
- **Per-message embedding** — adjustment messages embed directionless.
- **Prospective gate without rewrites** — context-dependent messages
  produced an unreadable drift signal regardless of topic; hence the
  expansion step.
- **Automatic segment merging (offline reports)** — the analyzer
  stitching revisited segments back together; "the same topic again"
  is beyond what embedding distances can decide, so merging stays
  flag-only, even offline.
- **Waiting for confirmation as *the* live verdict** — a trend
  detector alone would decide one turn late by construction, since a
  single message can flip the topic. The accumulator survives as the
  secondary slow-drift channel (it fires only when the immediate
  channel stays silent) and as the offline signal.
- **Rebuilding the gate's state from the first arrival on every
  judgment** — correct, but worker time per arrival grew with the
  thread's length, as the load runs measured; hence the checkpoints.

## Consequences

- No global drift threshold to maintain: the live verdict is judged
  against the thread's own state, message by message; a silent
  accumulator behind it covers gradual drift; the offline analysis
  keeps a segment threshold, taken from calibration data.
- The live gate costs one embed per arriving message — a small-model
  rewrite only for follow-ups — and its signals persist alongside it,
  so arrival readings can never leak into the fold's data.
- Re-runs with different numbers reclassify threads for free — all
  embeddings are stored.
- A judgment costs the same whatever the thread's length. The price is
  checkpoint upkeep: the old ones are pruned, and a rebuild runs
  whenever the kept ones go stale.
- Limits, each with a noted repair path (FUTURE-IMPROVEMENTS): a
  slowly drifting topic may never cross the threshold, because the
  centroid follows it (the Anchor chart is the compensating signal);
  and one-liner turns embed close to generic chatter.
