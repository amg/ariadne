# ADR 0010: User Facts, Segment Capture, and Thread Seeding

## Status
Proposed

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
visible to other Threads when the Segment closes. Later hooks — an
idle sweep, or cheap per-arrival triage — plug into the same service
and tighten freshness without touching storage.

### Storage
Facts live in the pgvector table designated by ADR 0003 and carry from
day one: entity subject/object columns, a normalized predicate, the
source Turn, and `valid_at` / `invalid_at` timestamps. Update by
invalidation rather than destructive overwrite, so graph construction,
cross-user aggregation, and conflict resolution remain additive later.

### The read path: seeding is assembly, not persistence
A fresh Thread's context receives two things: everything the store
knows about the user at that moment — one, bounded by a token-budget
policy — and, when the Thread was born from a drift handover, the
Segment-cutting Turn. The seed is composed by the assembler, not the
message stream: a snapshot taken at Thread creation, prepended during
context assembly every turn, byte-stable throughout the Thread's life
(no cache churn, nothing rendered or duplicated in the stream). The
seed policy — static snapshot today, dynamic retrieval when full user
awareness lands — lives entirely in the assembler, and the seed row
carries validity timestamps so a staleness policy can act on it.

Placement follows volatility: the stable system prompt first, the
memory block after it. The block changes only on fact events, and
cache TTL bounds the damage when it does.

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
