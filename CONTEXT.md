# Alex Chat Bot

A local single-user assistant chat. One conversation (a Thread) is replayed
in full to the model on every Turn, so cost accumulates and stale context
can accumulate without the user noticing. This vocabulary supports the
thread-health feature: surfacing cost climb, detecting Topic Drift, and
advising when a Thread is no longer earning its context.

## Language

### Conversation structure

**Message**:
One row of conversation content, either `user` or `assistant`.
_Avoid_: post, entry, chat line

**Turn**:
One user Message plus the assistant Message that responds to it. The unit
of cost attribution and of drift measurement. A Turn "enters" when its user
Message arrives.
_Avoid_: exchange, round, step, request

**Thread**:
An ordered sequence of Turns under one title. Its full history is resent to
the model on every Turn.
_Avoid_: session, conversation (except informally in UI copy)

### Thread health

**Turn embedding**:
The vector produced from one Turn's text block — its user Message and its
assistant Message. Stored keyed to the Turn's assistant Message, so each
Message carries the state of the conversation ending at it.
_Avoid_: window embedding, message embedding (misleading — isolated Messages are not embedded)

**Anchor**:
The frozen reference that IS Segment 1: the centroid of the opening
segment's Turn embeddings, frozen when Segment 1 closes — pure opening
topic. A flip at Turn 2 locks it on Turn 1 alone; a Thread that never
leaves its opening theme hands it the whole segment. Anchor distance
charts where the Thread wanders relative to its start; the Anchor
charts only, never classifies.
_Avoid_: baseline, origin vector, first-K anchor

**Anchor distance**:
Cosine distance between the current Turn embedding and the Anchor.
Measures cumulative drift — how far the Thread has wandered from its
opening topic; it falls again when the Thread returns to that topic.
_Avoid_: total drift, global drift

**Gravity point**:
The equal-weight centroid of the member Turn embeddings of the current
Topic segment. Rolls forward as Turns join; reseeded by the Boundary turn
that opens the next segment.
_Avoid_: running mean, segment vector, centroid

**Segment drift**:
Cosine distance between a Turn embedding and the current Gravity point.
Measures whether the Turn belongs to the current Topic segment, in whatever
direction the topic moved.
_Avoid_: local delta, jump, step distance, velocity

**Drift score**:
The clamped Segment drift — the single signal the Drift gate acts on.
Range 0–1.
_Avoid_: similarity score (inverted scale causes sign-flip bugs)

**Boundary turn**:
A Turn whose Segment drift crosses threshold: it closes the current Topic
segment and seeds the next. A candidate point where the topic changed,
including a change back to a previous one.
_Avoid_: breakpoint, pivot, drift point

**Topic segment**:
The consecutive Turns between two Boundary turns, sharing one topic.
The report carries every Turn's messages inside its segment — the user
message always, the assistant reply when present.
_Avoid_: phase, chapter, cluster

**Baggage**:
Context that is still sent on every Turn but no longer contributes to the
answer. Baggage is paid for on every Turn after it becomes baggage.
_Avoid_: dead context, bloat, cruft, noise

### Flow

**Drift gate**:
The check that scores an incoming user Message *before* inference. It may
pause the Turn and present a choice; it never blocks silently.
_Avoid_: guard, interceptor, blocker, middleware

**Opt out**:
The user's decision, made at the Drift gate, to abandon the current Thread
for a Fresh start rather than continue.
_Avoid_: abort, cancel, reset

**Fresh start**:
A new Thread seeded with a summary of the previous one, so topic knowledge
survives while Baggage is dropped.
_Avoid_: fork, clone, restart

**Replay**:
Offline re-scoring of an existing Thread's Turns through the same Drift
gate logic used live. Backs the standalone analyzer, threshold
calibration, and the retrospective view.
_Avoid_: retrospective, backfill, reanalysis, audit

**Prospective Turn**:
An incoming user Message scored as a Turn *before* inference — its text
embedded as a user-only Turn block and fed through the Drift gate exactly
as a completed Turn would be. The live lane persists it as an *arrival
row* keyed to the user Message (Turn rows key to the assistant Message);
nothing else about it enters the chat.
_Avoid_: draft turn, pending message, preview, hypothesis

**Live chain**:
The live gate's persisted arrival history: one record per judged
arrival (the reading, the segment-ledger snapshot taken before the
verdict, the verdict, the firing channel) and one segment per live
segment. The chain is the conversation's truth about the live lane —
the walk is fill-forward and never re-embeds or re-judges a complete
chain; a thread predating the feature or a tail an edit shredded is
refilled by the same walk resuming where the chain stops.
_Avoid_: verdict history, ledger table, live audit

**Expanded signal / composite verdict signal**:
The arrival-time verdict signal of the live gate after the
pipeline: the incoming user Message rewritten into self-contained form against the prior
Turn by a small cheap model — the *rewrite* decides the verdict when one
lands, the raw message as audited fallback (`driftP`). It restores
what the Prospective Turn loses by withholding the assistant reply:
concrete referents that anchor it to the real topic. Both readings are
charted (`driftPGated` = verdict signal, `driftP` = raw audit), and every
fallback carries an `expansionNote`.
_Avoid_: rewrite embedding, paraphrase signal, topic expansion

**Expansion trigger judge**:
The small-model classifier that backstops the expansion tier's anaphora
heuristic: in `heuristic` mode every short incoming message the regex
trigger lets through asks the judge one question — does the message
dangle a referent into the prior Turn (`CONTEXT_DEPENDENT`) or stand on
its own (`SELF_CONTAINED`)? A dependent verdict adds the message to the
rewrite list — the judge only ever adds rewrite candidates, never vetoes
the heuristic's picks — and every other outcome (`SELF_CONTAINED`,
failed or unreadable verdict) keeps the raw fast path and explains
itself in the Turn's `expansionNote`. Exists because the regex misses
quirks it cannot anticipate ("Is there a silver bullet for this?").
_Avoid_: anaphora detector, context classifier, rewrite gate

**Immediate criterion**:
The live gate's per-message decision level (ADR 0006): the thread's own
noise level — the mean plus spread of the drift_p readings sampled so
far, judged before the arriving reading folds in — seeded with that
thread's T_segment while too few readings are sampled to trust the
statistics. A sharp topic flip clears it at its arrival turn; the
Page–Hinkley accumulator speaks only while this channel stays silent,
and resets after any verdict.
_Avoid_: live threshold (no global constant applies to the live lane), running mean

### Cost

**Marginal cost**:
The cost a single Turn added: its newly billed tokens at model pricing.
_Avoid_: turn cost, delta cost

**Running total**:
Cumulative Thread cost to date: the sum of Marginal costs of all Turns.
_Avoid_: total spend (keep the column name canonical), cumulative cost

**Savings estimate**:
Projected cost difference over the next N Turns between continuing in the
current Thread and taking a Fresh start.
_Avoid_: projection, forecast, ROI estimate
