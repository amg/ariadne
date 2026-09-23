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
- **An Anchor records wander from the start.** The Anchor IS Segment
  1: the fold decides the opening segment's member set, and the Anchor
  is its centroid, frozen at the segment's close — a flip at the
  second turn leaves it as turn 1 alone, a thread that never leaves
  its opening theme obtains the whole segment. It charts how far the
  thread has moved from its opening topic; it charts only, never
  classifies. Solves: showing cumulative drift (including a return
  home) without the anchor flagging every later turn forever.
- **Slow drift also lives here as a report signal.** The same
  sustained-rise accumulator (Page–Hinkley) runs over the stored
  drift series, learning each thread's own noise floor: wiggles below
  a small allowance never accumulate, and only a rise that keeps
  climbing over several turns fires. In live detection it is the
  *secondary* channel (see below), never the verdict by itself.
  Solves: surfacing a topic that crawls away turn by turn in analysis
  and reports.
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
  previous Turn, and that rewrite is what gets compared — the raw
  message stays as the audited fallback, and both readings are
  recorded. This enriches the user message with contextual info before
  embedding. Solves: restriction 2 — a follow-up has no topic of its
  own, so it is re-read with the previous context before measuring.
- **The verdict is immediate: one message, one decision.** A topic
  flip can arrive in a single message — if it shifted, it shifted,
  and a verdict that waits to confirm would always decide one turn
  late. The arriving message's reading is judged against the thread's
  own state — its current topic and its noise level — instead of a
  global constant; messages that read as tweaks of the last Turn are
  withheld, and the first turn alone is muted while there is nothing
  to compare against (later cold-start coverage is a calibration knob). Solves: deciding at the exact turn the topic
  changed, without tuning one number for every thread.
- **Slow drift gets a second, quiet channel.** Alongside, a
  sustained-rise accumulator (Page–Hinkley) rides the same drift
  stream: it credits rises above the thread's own mean and ignores
  wiggles, firing only once credit has climbed enough across several
  messages. A sharp flip never reaches it — the immediate verdict
  catches those first — so it only speaks when immediate drift stays
  silent: precisely the crawling-topic class. When it fires, the
  message gets the same drift verdict, and after any verdict the
  accumulator resets with the new topic. Solves: gradual drift that
  never crosses the immediate criterion, without ever delaying a
  sharp one.
- **The live gate is advisory, never blocking.** It may pause the turn
  and present the choice, and the offline scoring stays the
  authoritative record of where segments cut; disagreements between
  the live verdict and the recorded cuts are kept as calibration
  material. Solves: the detection is fallible, so it must not
  silently decide for the user, and its mistakes need to stay visible
  to improve it.
- **The live chain persists as it runs and never re-reads itself.**
  Each judged arrival logs one row — the reading, the ledger snapshot,
  the verdict, the channel — and a fire burns a new segment row. The
  walk is fill-forward, so a thread predating the feature and the tail
  an edit shredded are both refilled by the same walk resuming where
  the chain stopped; a replay over a complete chain skips every
  provider call. Solves: the online signals survive restarts, retries,
  and flips of the flag.
- **One feature flag sets the expansion tier and the surface.**
  `THREAD_ANALYSIS_MODE` is `off` | `heuristic` | `always`: the two
  live tiers decide which arrivals get expanded against the previous
  context; `off` skips the pipeline and hides the Analysis surface,
  but stored signals survive an `off` period and reappear when it
  flips back. Solves: shipping the lane behind a dial without losing
  its history to a cosmetic setting.
- **The verdict rides the first stream event of the reply.** An
  arrival judged fire tints its own bubble before that reply starts
  growing, because the verdict is written into the response stream
  before the exchange stream merges in. Solves: the reader sees the
  drift flag on the message that drifted, not one turn later.

The math — formulas, parameters, numerical guardrails — lives in
`docs/ideas/THREAD-DRIFT-MATH.md`.

## What we tried instead

- **Multi-turn windows** — any window straddling a topic flip blends
  both topics and dilutes the flip signal; measured flips dropped
  below threshold at a window of two (0.237 vs 0.632 for single
  turns), and the dilution grows with window size.
- **Two thresholds: anchor distance plus consecutive change** — the
  anchor stays tripped after the first real wander (every later turn
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
  and a silent accumulator behind it for the slow crawl.
- The live gate costs one embed per arriving message — a small-model
  rewrite only for follow-ups under `heuristic` — and its signals
  persist alongside it, so arrival readings can never leak into the
  fold's data. Arrival embeddings read as per-message at first glance
  (Turn rows key to the assistant Message, arrival rows key to the user
  Message), but the live chain never touches `message_usage`: per-step
  spend rides the arrival row.
- Re-runs with different numbers reclassify threads for free — all
  embeddings are stored.
- Limits, each with a noted repair path (FUTURE-IMPROVEMENTS),
  neither solved by a wider unit: a slowly crawling topic may never
  cross the threshold (the centroid follows it — the Anchor chart is
  the compensating signal), and one-liner turns embed close to
  generic chatter.
