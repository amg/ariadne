---
description: Facts are captured at segment close and fresh Threads are seeded from them; a drift fire on a fresh arrival pauses the reply.
---

# ADR 0010: User Facts, Segment Capture, and Thread Seeding

## Status
Accepted. Amends ADR 0006: a drift fire on a fresh arrival now pauses
the reply instead of only marking it.

## Context
The Drift gate (ADR 0006) offers a fresh Thread when a Thread stops
earning its context. The offer is only fair if the fresh Thread starts
already knowing what mattered in the one it left; without memory, a
drift-borne restart degrades the experience instead of improving it.
Today nothing crosses Thread boundaries — an Exchange reads only its
own Thread's rows.

The eventual goal is broader cross-Thread awareness: a fact stated in
one chat ("I love dogs") should be retrievable when another chat's new
message asks what pets the user has. The extraction pipeline should
therefore be a general mechanism — take a bounded context scope,
produce candidate facts — hooked today only at the place that matters:
segment-cut detection.

Until now the gate was advisory: a fire only marked the arriving message
and the reply went ahead, so there was no moment where a fresh Thread
could be offered at all.

Inference caching constrains the read side: prompt caches key on
static prefixes, so dynamic content must not churn every turn. ADR
0003's storage foundation (pgvector, embeddings table) is already in
place; this ADR delivers its extraction/retrieval pipeline.

## Decision

### The general process
An extraction service takes a scope — an ordered run of Turns — and
produces candidate user facts via a small-model call: self-contained,
durable, future-useful sentences about the user (research note, §1–§2).
Relative time expressions are resolved to absolute dates at extraction.
Writes pass a similarity-search guard: a near-duplicate existing fact
becomes a NOOP instead of a second row. The full reconciliation
operation set from the research note (§3) stays in reserve; the
duplicate guard is sufficient today with idea that full reconciliation
is not a full rewrite but future improvement.

### Today's hook: Segment close
When the live gate elects a Boundary turn and closes a Topic Segment,
that Segment's Turns are queued for the extraction service. This rides
existing geometry — Turn embeddings and Segment boundaries — and keeps
extraction off the hot path for most conversations. Freshness is
therefore eventual: a fact stated inside a still-open Segment becomes
visible to other Threads when the Segment closes. A Segment counts as
closed only while the arrival that closed it is live: when an edit or a
handover abandons that arrival, the Segment is open again and owes a
fresh capture when it next closes. The duplicate guard absorbs what the
first capture already stored. Later hooks — an
idle sweep, or cheap per-arrival triage — plug into the same service
and tighten freshness without touching storage.

### Storage
Facts live in the pgvector table designated by ADR 0003 and carry from
day one: entity subject/object columns, a normalized predicate, the
source Turn, and `valid_at` / `invalid_at` timestamps. Update by
invalidation rather than destructive overwrite, so graph construction,
cross-user aggregation, and conflict resolution remain additive later.

### The handover: pause and choose
A drift fire on a fresh arrival no longer lets the reply run. The
arrival is stored without one and waits for the user: continue in this
Thread, which is an ordinary retry replaying the stored fire and never
pauses again, or start a new chat from it. Until the user picks, nothing
else enters the Thread. An edit of the last message lands a fresh
arrival, so its fork is judged and paused like any new message.

Starting a new chat first captures the segment the arrival closed, so
the fresh Thread's Seed already knows what that segment taught. The move
waits for that capture: while it is still running the handover answers
"still saving" and moves nothing, and the browser asks again. Only a
capture that gives up lets the new chat open without it; the segment's
Facts then stay owed for later Threads. The wait lives in the handover
alone. Then,
in one transaction, the arrival is abandoned in its old Thread and
copied in as the fresh Thread's first message, so it can never end up
in neither Thread or in both. Its reply is then requested there like a
retry. Moving the message itself, rather than carrying
it inside the Seed, keeps it visible where the user expects it and lets
the fresh Thread's gate start from it like any opening message. The
Seed only records which arrival the Thread took over.

### The read path: seeding is assembly, not persistence
A fresh Thread's context receives everything the store knows about the
user at that moment, bounded by a token-budget policy. The seed is
composed by the assembler, not the message stream: a snapshot taken at Thread creation, prepended during
context assembly every turn, byte-stable throughout the Thread's life
(no cache churn, nothing rendered or duplicated in the stream). The
seed policy — static snapshot today, dynamic retrieval when full user
awareness lands — lives entirely in the assembler, and the seed row
carries validity timestamps so a staleness policy can act on it.

Placement follows volatility: the stable system prompt first, the
memory block after it. The block changes only on fact events, and
cache TTL bounds the damage when it does.

### Memory is the user's to switch off
Memory is a per-user setting stored in the database, not a deployment
flag: one switch turns capture and seeding on or off, and a list of
blocked Fact categories (credentials by default) is never captured and
never seeded. Blocking a category later hides its stored Facts without
purging them, so the list can change freely. That includes Seeds already
frozen in open Threads: each Seed line keeps its category, and a line
whose category is now blocked is left out of the prompt. While memory is off,
segments that close are settled without extraction, never deferred
until it comes back on.

### Memory is invisible inside Threads
Threads never display facts or carryover blocks. A separate Memory
Screen (list, edit, delete, suppress) is the only management surface,
and suppression and deletion remain distinct operations: deletion
removes the fact; suppression only stops it being injected.

## Consequences
* **Easier**: the drift offer becomes honest — a fresh Thread starts
  primed; cross-Thread awareness grows as hooks grow, not as
  architecture changes; per-message spend stays visible on the spend
  surface (ADR 0008) as a new line in the expansion-costs table.
* **Harder**: extraction quality is prompt engineering we must own,
  measured with a small personal test set; availability today is
  eventual by hook design; a static seed can go stale against the live
  store, which a refresh policy must address before dynamic awareness
  arrives; both the extraction call and the duplicate guard rely on
  structured-output reliability from a small DeepInfra model — a spike,
  not a gamble.
* **Out of scope, deliberately**: preference-corpus tuning, graph
  visualization, cross-user analytics, and UPDATE/DELETE
  reconciliation. Each layers onto this pipeline when needed, without
  an architectural turn.
