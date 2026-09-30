# ADR 0006: Thread topic drift detection

## Status
Accepted

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

- **The Turn is the unit of measurement.** Every complete Turn — user
  Message and assistant reply together — embeds once. Solves: a single
  message carries no topic on its own, so it must be measured together
  with the reply it produced.
- **Embeddings persist keyed to the Turn's assistant Message with the
  id of the model that produced them**, so different embedding models
  never mix. Solves: vectors from different models live in different
  spaces and would compare as nonsense.
- **Topic state is a rolling centroid.** Each Topic segment carries a
  Gravity point: the centroid of its turns so far. Each arriving Turn
  is scored against the Gravity point *before* it joins; a Turn
  crossing the threshold is a Boundary turn — it closes the segment
  and starts the next one from its own embedding. Solves: telling
  "this turn continues the current topic" from "a new topic starts",
  without ever comparing one turn to a single previous turn.
- **An Anchor records how far the thread has moved from the start.**
  The Anchor is the centroid of the opening segment: the fold decides
  which turns that segment holds, and the Anchor is their centroid,
  frozen when the segment closes — a flip at the second turn leaves it
  as turn 1 alone, a thread that never leaves its opening theme gets
  the whole segment. The Anchor only measures distance from the
  opening topic; it never classifies a turn. Solves: showing
  cumulative drift (including a return to the opening) without the
  anchor flagging every later turn forever.
- **Slow drift also appears here as a report signal.** The same
  sustained-rise accumulator (Page–Hinkley) runs over the stored
  drift series and learns each thread's own noise floor: small steps
  below a tolerance never accumulate, and only a rise that keeps
  climbing over several turns fires. In live detection it is the
  secondary channel (see below), never the verdict by itself. Solves:
  surfacing a topic that drifts away gradually, turn by turn.
- **Segment merging is offline-report advice only.** If a topic leaves
  and comes back, the split (correctly) produces two separate
  segments. Here — and only here: the live path never sees any of
  this — the report checks whether two segments sit closer than this
  thread's own same-topic baseline (how far apart two halves of one
  segment sit, measured by earth-mover distance between their vector
  sets) and flags a possible revisit. Nothing anywhere joins
  segments; the flag is for the reader, because "the same topic
  again" is a judgment embedding distances alone can't make. Solves:
  surfacing a returned topic without pretending distances can
  confirm it.

### Live detection — the arriving user message

Decides, on the incoming message alone and before inference, whether
the conversation is drifting into a new topic, and may pause the turn
to offer a choice.

- **The arriving message is scored as a Prospective Turn** — embedded
  like the user half of a Turn (the assistant reply doesn't exist
  yet) and persisted as an *arrival row* keyed to the user Message, in
  the same `message_embeddings` table the offline fold uses, with the
  expanded text the reading came from and the per-step spend alongside.
  Solves: restriction 1 — the only text available at arrival is the
  user message — while never paying twice for the same reading.
- **Context-dependent messages are rewritten before embedding.** When
  an incoming message reads as a follow-up to what came before, a
  small model rewrites it into self-contained form against the
  previous Turn, and that rewrite is what gets compared. If the
  rewrite is refused or unusable, the raw message stays the fallback,
  and the outcome of the attempt is recorded on the arrival row.
  Solves: restriction 2 — a follow-up has no topic of its own, so it
  is re-read with the previous context before measuring.
- **The verdict is immediate: one message, one decision.** A topic
  flip can arrive in a single message — if it shifted, it shifted,
  and a verdict that waits to confirm would always decide one turn
  late. The arriving message's reading is judged against the thread's
  own state — its current topic and its noise level — instead of a
  global constant; the first turn alone is muted while there is
  nothing to compare against (later cold-start coverage is a
  calibration knob). Solves: deciding at the exact turn the topic
  changed, without tuning one number for every thread.
- **Slow drift gets a second channel.** Alongside, a sustained-rise
  accumulator (Page–Hinkley) follows the same drift series: it sums
  rises above the thread's own mean, ignores steps inside its noise
  floor, and fires only once the total rise has climbed enough across
  several messages. A sharp flip never reaches it — the immediate
  verdict catches those first — so it only matters when the immediate
  channel stays quiet: the gradually drifting topic. When it fires,
  the message gets the same drift verdict, and after any verdict the
  accumulator resets around the new topic. Solves: gradual drift that
  never crosses the immediate criterion, without ever delaying a
  sharp one.
- **The live gate is advisory, never blocking.** A fire only marks
  the arriving message in the chat; the reply is produced normally.
  (A pause-and-choose flow is deferred follow-up work.) The offline
  scoring stays the authoritative record of where segments cut, and
  disagreements between the live verdict and the recorded cuts are
  kept as calibration material. Solves: the detection is fallible, so
  it must not silently decide for the user, and its mistakes need to
  stay visible to improve it.
- **The live lane persists as it runs and never recomputes stored
  results.** Each judged arrival logs one row — the reading, the
  baseline it was judged against, the verdict, the channel — and a
  fire starts a new segment row. Refill always moves forward, so a
  thread that predates the feature, or the tail an edit invalidated,
  is rebuilt by running the lane again from where the stored rows
  stop; a run over an already-complete lane makes no provider calls
  (the step-by-step shape of this persistence is ADR 0007). Solves:
  the online signals survive restarts, retries, and flips of the
  flag.
- **One feature flag sets the expansion tier and the surface.**
  `THREAD_ANALYSIS_MODE` is `off` | `heuristic` | `always`: the two
  live tiers decide which arrivals get expanded against the previous
  context; `off` skips the pipeline and hides the Analysis surface,
  but stored signals survive an `off` period and reappear when it
  flips back. Solves: shipping the lane behind a dial without losing
  its history to a cosmetic setting.
- **The verdict is delivered with the first event of the reply
  stream.** The arrival is judged before inference runs, so the
  verdict is written to the response stream before the reply stream
  merges in, letting the UI mark the arriving message before the reply
  starts. Solves: the reader sees the drift flag on the message that
  drifted, not one turn later.

The math — formulas, parameters, numerical guardrails — lives in
`docs/ideas/THREAD-DRIFT-MATH.md`.

## What we tried instead

- **Multi-turn windows** — any window straddling a topic flip blends
  both topics and dilutes the flip signal; measured flips dropped
  below threshold at a window of two (0.237 vs 0.632 for single
  turns), and the dilution grows with window size.
- **Two thresholds: anchor distance plus consecutive change** — the
  anchor stays tripped after the first real departure (every later turn
  flagged), and consecutive change can't tell a same-topic follow-up
  from a topic flip.
- **Per-message embedding** — adjustment messages embed directionless
- **Prospective gate without rewrites** — context-dependent messages
  produced an unreadable drift signal regardless of topic; hence the
  expansion step.
- **Automatic segment merging (offline reports)** — having the
  analyzer stitch revisited segments back together automatically;
  semantic relatedness exceeds what embedding distances can decide,
  so merging stays flag-only, even offline.
- **Waiting for confirmation as *the* live verdict** — a trend
  detector alone as the live gate would decide one turn late by
  construction, since a single message can flip the topic. The
  accumulator survives as the secondary slow-drift channel (fires
  only when immediate stays silent) and as the offline signal.

## Consequences

- No global drift threshold to maintain: one segment threshold in the
  offline analysis (calibration data, overridable per run), a live
  verdict judged against the thread's own state message by message,
  and a silent accumulator behind it for gradual drift.
- The live gate costs one embed per arriving message — a small-model
  rewrite only for follow-ups under `heuristic` — and its signals
  persist alongside it, so arrival readings can never leak into the
  fold's data. Arrival embeddings read as per-message at first glance
  (Turn rows key to the assistant Message, arrival rows key to the user
  Message), but the live lane never writes to `message_usage`:
  per-step spend is recorded on the arrival row.
- Re-runs with different numbers reclassify threads for free — all
  embeddings are stored.
- Limits, each with a noted repair path (FUTURE-IMPROVEMENTS),
  neither solved by a wider unit: a slowly drifting topic may never
  cross the threshold (the centroid follows it — the Anchor chart is
  the compensating signal), and one-liner turns embed close to
  generic chatter.
