# Ari

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
_Avoid_: round, step, request

**Exchange**:
The live execution of one Turn — the streaming exchange itself, from the
moment inference starts until it settles. A Turn is the settled unit of
cost and drift; an Exchange is the in-flight run that produces it. The
assistant row carries the Exchange's state (`exchange_status`:
`pending → completed | interrupted | error`) while it streams; the guard
bounces a second submit against a live Exchange, and a hard failure leaves
it `pending` until the staleness window declares it lost. Every settled
Exchange accounts its spend — the provider's report when one arrived,
otherwise an Estimated row. An Exchange ending without completing
(interruption, failure, timeout, crash) abandons nothing; only deliberate
user actions (edit, retry) flag rows abandoned.
_Avoid_: generation, request, job

**Abandoned**:
Marked only by deliberate user actions: (1) an edit abandons the old
arrival + every reply grown from its text; (2) a retry/regenerate flags
stale assistant rows abandoned in place; (3) a Handover abandons the
paused arrival it moves out. Interruption, failure, timeout,
and crash abandon nothing — user prompt and partial assistant reply stay
live in the thread (empty assistant rows are skipped in model context
but remain in DB/UI). A still-untitled Thread titles from a short preview
of the arrival text. Abandoned rows stay in the Thread with their usages
intact (spend keeps tracking them) but vanish from the chat stream and
the live analysis. Nothing ever revives an abandoned row.
_Avoid_: hidden, orphaned, dead

**Resume Draft**:
Dormant (dead code): no path abandons the newest user row anymore (edits
always insert the fork behind). Previously: an Abandoned Exchange's
arrival text owed back to the input; owed when the Thread's newest user
Message was its abandoned arrival and no Exchange completed after it;
consumed by a completing retry. The `findResumeDraft` query and `/draft`
endpoint remain in place but are no longer invoked by the interruption
path.
_Avoid_: restore, recovery text

**Edit**:
Forking the last user prompt — a deliberate user action that abandons.
The old arrival row and every reply grown from its text are abandoned in
place — text, arrival analysis and spend stay, the usages keep tracking
what the thread burned — and the edited text lands as a new arrival row.
The retry exchanges the new arrival, and the live thread-health gate
acts there. Only the newest prompt is editable: every earlier one owes
the conversation its reading.
_Avoid_: message update, in-place rewrite

**Retry**:
The user's *regenerate* of an Exchange — a deliberate user action that
abandons. The server picks the newest live user Message, flags the
stale assistant rows beneath it abandoned in place,
and grows the fresh reply beneath those — nothing is ever deleted, every
burnt usage keeps counting. The client's message list serves only the
SDK's last-message guard.
_Avoid_: resend, re-run

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
Where a Topic segment started: the centroid of its opening Turn
embeddings, fixed once those Turns have folded. Unlike the Gravity
point it does not follow the conversation, so a slowly wandering topic
keeps moving away from it.
_Avoid_: baseline, origin vector, first-K anchor

**Anchor distance**:
Cosine distance between an arrival's reading and the current segment's
Anchor. The slow channel watches it for a sustained rise, which is how
gradual drift fires even when no single message crosses the immediate
criterion.
_Avoid_: total drift, global drift

**Gravity point**:
The equal-weight centroid of the member Turn embeddings of the current
Topic segment. Rolls forward as Turns join; reseeded by the Turn of the
arrival that fired, which opens the next segment.
_Avoid_: running mean, segment vector, centroid

**Segment drift**:
Cosine distance between an arrival's reading and the current Gravity
point, which the immediate criterion judges. It measures whether the
arrival belongs to the current Topic segment, whichever way the topic
moved.
_Avoid_: local delta, jump, step distance, velocity, similarity score
(inverted scale causes sign-flip bugs)

**Boundary turn**:
The Turn of an arrival the Drift gate fired on: it closes the current
Topic segment and seeds the next. A point where the topic changed,
including a change back to a previous one.
_Avoid_: breakpoint, pivot, drift point

**Topic segment**:
The consecutive Turns between two Boundary turns, sharing one topic.
_Avoid_: phase, chapter, cluster

**Baggage**:
Context that is still sent on every Turn but no longer contributes to the
answer. Baggage is paid for on every Turn after it becomes baggage.
_Avoid_: dead context, bloat, cruft, noise

### Memory

**Fact**:
One memory record: a self-contained, durable sentence about the user —
useful in a future conversation without any surrounding context, e.g.
"the user is vegetarian". Carries its source Turn, a category from a
fixed set, a stated date when the conversation dates when the Fact took
effect (null otherwise) plus the record time at capture, and optional
entity subject/object columns with a normalized predicate. Stated dates
are pinned to absolute days at extraction, inferring the user's day-
month order from their own dates and the conversation's date; where the
meaning stays genuinely ambiguous, no date is stored. A near-duplicate
of an existing Fact is not stored twice. A category the user blocks is
never captured and never seeded; Facts already stored under it stay,
hidden.
_Avoid_: memory item, note, observation

**Memory**:
The durable store of Facts that outlives any Thread. Captured piecemeal
as segments settle, keeping a pointer to the last Turn read; namespaced
per user even though it holds one user today.
_Avoid_: knowledge base, profile store, memory bank

**Seed**:
What a fresh Thread's context receives at creation: a snapshot of what
the Memory store knows about the user, bounded by a token-budget
policy. A Thread born from a Handover also records which arrival it
took over; that arrival enters as the Thread's first message, never as
part of the Seed. The Seed is composed by the assembler, stays
byte-stable for the Thread's life, and never appears in the chat
stream.
_Avoid_: carryover, handoff block, preamble

**Memory Screen**:
The separate surface for viewing, editing, deleting, and suppressing
Facts. Facts never surface inside Threads; the Screen is their only
home. Deletion removes a Fact; suppression only stops it being injected.
_Avoid_: memory panel, profile editor

### Flow

**Drift gate**:
The check that scores an incoming user Message *before* inference. A fire
on an arrival judged for the first time — a new message, or an Edit's
fork — pauses the reply: the arrival becomes a Paused arrival and the
user decides where it continues. The gate never decides for the user,
and a retry that replays a stored verdict never pauses. It judges only
the live conversation: an abandoned arrival never counts as context.
_Avoid_: guard, interceptor, blocker, middleware

**Paused arrival**:
A fresh user Message the Drift gate fired on, stored with no reply. It
waits for the user's choice: continue in this Thread (a Retry) or a
Handover. Nothing else enters the Thread until the user chooses. An Edit
lands a fresh arrival, judged anew, which may pause again.
_Avoid_: blocked message, held message

**Unanswered arrival**:
A live user Message with no reply that is not paused: its Drift gate
verdict is still being reached, has come back clear while nobody was
waiting for it, or could not be reached at all. No reply is generated
until the gate has judged it, and nothing else enters the Thread until it
is answered. A Retry waits for the verdict and replies once it is clear.
_Avoid_: pending message, stuck message

**Handover**:
Moving a Paused arrival into a fresh Thread. Memory capture runs over
the Turns up to the arrival first — a capture point, not a close, since
the old segment stays open — so the fresh Thread's Seed already knows
it; then, as one step, the arrival is abandoned in its old Thread and
becomes the fresh Thread's first message, never in both and never in
neither.
_Avoid_: split, fork, transfer

**Prospective Turn**:
An incoming user Message scored as a Turn *before* inference — its text
embedded as a user-only Turn block and fed through the Drift gate exactly
as a completed Turn would be. The live lane persists it as an *arrival
row* keyed to the user Message (Turn rows key to the assistant Message);
nothing else about it enters the chat.
_Avoid_: draft turn, pending message, preview, hypothesis

**Live chain**:
The live gate's persisted arrival history under one embedding model: one
record per judged arrival (the reading, the segment baseline it was
judged against, the verdict, the firing channel) and one row per live
segment, each carrying the model that produced the reading as its
source — the same identity the embedding rows use. A thread runs one
chain per model: switching models starts a fresh chain, and the retired
one stays stored for pruning. The chain is the conversation's truth
about the live lane — it is refilled forward and never re-embeds or
re-judges a stored row; a thread that predates the feature, or the tail
an edit invalidated, is rebuilt from where the chain stops. (An edit
invalidates signals under every model.)
_Avoid_: verdict history, ledger table, live audit

**Gate checkpoint**:
One piece of the gate's running state, persisted so the next judgment
reads it instead of walking the chain: an *arrival judgment state* (the
baseline and patrol one judged arrival leaves behind) or a *Turn fold*
(one folded Turn's segment sums, its segment, and the live chain's
Turn count). Each verdict's commit stores its own and prunes the thread
to the newest two — the keep-two rule — so a judgment costs a fixed
handful of queries however long the thread grew. A stale or missing
checkpoint falls back to the rebuild walk, which replays the stored
rows and heals the checkpoints as it goes; a fold lagging behind its
Turn is not stale — the next judgment folds inline what the queue task
has not written yet.
_Avoid_: gate cache, working state, ledger

**Rewritten signal / composite verdict signal**:
The arrival-time verdict signal of the live gate after the
pipeline: the incoming user Message rewritten into self-contained form against the prior
Turn by a small cheap model — the *rewrite* decides the verdict when
it lands, and the raw message stays the fallback when it is refused or
unusable (see Expansion outcome). It restores
what the Prospective Turn loses by withholding the assistant reply:
concrete referents that tie it to the real topic. Every fallback records
why in its Expansion outcome.
_Avoid_: expansion signal, paraphrase signal, topic expansion

**Rewrite trigger judge**:
The small-model classifier that backstops the rewrite tier's anaphora
heuristic: in `heuristic` mode every short incoming message the regex
trigger lets through asks the judge one question — does the message
dangle a referent into the prior Turn (`CONTEXT_DEPENDENT`) or stand on
its own (`SELF_CONTAINED`)? A dependent verdict adds the message to the
rewrite list — the judge only ever adds rewrite candidates, never vetoes
the heuristic's picks — and every other outcome (`SELF_CONTAINED`,
failed or unreadable verdict) keeps the raw fast path. Exists because the regex misses
quirks it cannot anticipate ("Is there a silver bullet for this?").
_Avoid_: anaphora detector, context classifier, expansion gate

**Immediate criterion**:
The live gate's per-message decision level (ADR 0006): the thread's own
noise level — the mean plus spread of the drift_p readings sampled so
far, judged before the arriving reading folds in — seeded with that
thread's T_segment while too few readings are sampled to trust the
statistics. A sharp topic flip clears it at its arrival turn; the
Page–Hinkley accumulator speaks only while this channel stays silent,
and resets after any verdict.
_Avoid_: live threshold (no global constant applies to the live lane), running mean

**Message transformer**:
The lane that turns each arriving user Message into a judged Prospective
Turn before inference: the Message is rewritten into a self-contained
reading, that reading is checked and embedded, and the result is judged
against the current Topic segment — closing the segment on a fire and
folding completed Turns. Runs per Message when its arrival triggers it;
what is stored replays and never re-runs.
_Avoid_: link, stage pipeline, interceptor

**Naive refusal detector**:
The rewrite's string-level check that the rewrite reading is not the
rewrite model *refusing* ("I can't assist with this request…"). Refusal
is a closed, provider-stable boilerplate class, decided by pattern,
never by meaning; a hit discards the rewrite and the Message keeps its
raw reading.
_Avoid_: refusal classifier, content filter, guardrail

**Expansion outcome**:
The recorded end of one Message's try at a rewrite: the self-contained
reading landed, or why it did not — a refusal, a quality reject, a
provider failure, or unusable output. Only the end is recorded; attempts
that led to it are not.
_Avoid_: stage report, pipeline state

### Running the app

**Copy**:
One running instance of the backend. aws-prod runs several side by side,
each an ECS task; a home deployment runs one. Every app record names the
copy that wrote it.
_Avoid_: instance, replica, node, task (that is ECS's word, and the queue's)

### Cost

**Marginal cost**:
The cost a single Turn added: its newly billed tokens at model pricing.
_Avoid_: turn cost, delta cost

**Running total**:
Cumulative Thread cost to date: the sum of Marginal costs of all Turns.
_Avoid_: total spend (keep the column name canonical), cumulative cost

**Estimated spend**:
What an Exchange settles when the provider's usage report never arrived:
locally counted input tokens plus the text that made it out, priced by
model and marked `estimated` on the usage row. Marginal and Running
totals count it the same as provider-reported spend — an interrupted
Exchange still accounts for what it spent.
_Avoid_: fallback cost, projected cost

**Daily spend**:
All provider-metered spend recorded in one UTC day, across chat,
embeddings and side calls; what the daily budget is checked against.
Spend counts on the day it is recorded and stays counted when its
messages are later deleted.
_Avoid_: running total (that is per Thread), daily total

