# Thread details: the live gate becomes part of the conversation

Branch: `feat/thread-details`. Read this ticket plus ADR 0006 and
`CONTEXT.md` before touching code; the analyzer's private modules live
behind the `backend/src/services/threadAnalysis/index.ts` seam, and the
shared verdict core is `verdict.ts`.

## Goal

The thread-health analyzer lives in the CLI today: `analyze:thread`
reads a thread from the database and writes self-contained HTML/JSON
artifacts to `build/analysis/`. Two things change:

1. **The live gate starts running with the conversation.** Every
   arriving user message is expanded where needed, embedded, and
   judged by the same two-channel verdict the offline fold uses, and
   every result is persisted — nothing is re-embedded or re-judged.
   The verdict is advisory in v1: a fired verdict tints the user
   bubble purple in the Conversation tab.
2. **The live report becomes a page in the chat.** The center area
   gains Conversation and Analysis tabs. The Analysis tab shows the
   thread's live reading from persisted signals, rendered as React,
   reachable as the thread URL with `?mode=analyze`.

This is the seed of the signal that will later suggest opening a new
chat; in this iteration the purple bubble is the whole signal.

## Settled design (grilled and confirmed — do not reopen)

1. **One arrival pipeline, awaited before inference.** `POST /chat`
   runs one call for a new user message: expansion (heuristic tier,
   the CLI's calibrated default — no per-chat tuning knob) → embed the
   composite reading → judge with the shared verdict core → persist
   every step as it completes. Inference only starts after the
   pipeline succeeds. Pipeline **failure fails the exchange** through
   `/chat`'s existing failed-exchange error class, so the assistant
   message fails and the existing retry re-runs the hit. On success
   the verdict rides the stream as a first event so the bubble tints
   before the reply grows. `regenerate`/`resume-stream` triggers carry
   no new arrival and skip the pipeline. (Always-block on failure is
   the testing-era choice; advisory-and-continue was considered and
   filed for later.)

2. **The pipeline is really "fill missing signals forward in order".**
   Every step persists on completion, so one routine covers all the
   gaps uniformly: backfill of threads predating the feature,
   post-retry recovery, and message edits (an edit invalidates that
   message's row and everything after it — the chain re-fills from
   there on the next arrival or analysis view). Backfill is lazy,
   triggered by whichever surface needs it first.

3. **Storage (new migrations 009+).**
   - `message_embeddings` (arrival rows key to the user Message; turn
     rows keep keying to the assistant Message — one table, two kinds,
     keep the vocabulary honest in docs): add `expanded_text` (the
     rewrite the embedding came from, null when none landed) plus
     `embedding_cost_usd`, `rewrite_cost_usd`, `judge_cost_usd`
     (nullable; never written to `message_usage`).
   - `thread_segments`: `id`, `thread_id`, `start_message_id`,
     `created_at`. This is the **live arrival chain** the gate builds
     as the conversation progresses — deliberately not the fold's
     segments; the same verdict on different readings may split
     differently and that is correct. A segment end is the next
     segment's start (chronology), no end column.
   - `segment_drift_logs`: `id`, `segment_id` (the segment the arrival
     was *judged in* — a fired arrival logs against the segment it
     burned; the next segment's `start_message_id` points at the same
     message), `message_id`, `drift_p` (the composite reading judged),
     `mu`, `sigma`, `z_score` (the at-judgement snapshot **before**
     the arrival joined the ledger, so stored numbers recompute
     exactly), `verdict` (`muted|pass|fire`), `fire_channel`
     (`immediate|slow`, null otherwise), `created_at`. No
     `is_boundary` — a fire *is* the segment end. Muted turns log a
     row with null numbers.

4. **The Analysis tab shows the live lane only.** Drift-vs-trigger
   chart with the z-tracking series from `segment_drift_logs`, the
   segment table from the live chain, verdict-tinted bubbles (the
   Conversation tab reads verdicts from the existing
   `GET /api/threads/:id/messages` response, extended with a small
   field per message). Chat in hand-rolled inline SVG components
   (no chart library — same discipline as the CLI artifacts).

5. **Delivery.** Conversation / Analysis tabs in the center area;
   `?mode=analyze` shows Analysis; sidebar thread links use
   react-router's `preserveSearchParams` so report viewing carries
   across thread switches. No entry point on the right pane. Loading
   state (missing signals) = the existing spinner plus rotating
   one-liners (suggested set, strike freely: "Reading the room…",
   "Consulting the gravity point…", "Counting baggage…", "Weighing
   the anchor…", "Checking drift…").

6. **Feature flag.** `THREAD_ANALYSIS_MODE` (`off|heuristic|always`,
   default `heuristic`) via `config/env.ts`, wired through the
   env-sync audit, compose passthrough and the README env table.
   `off` = surface gone: pipeline skipped, Analysis tab hidden,
   bubbles untinted. Stored signals survive an `off` period and
   reappear when flipped back.

7. **Offline analyzer untouched.** The CLI keeps its pretend-replay
   semantics (transient prospective embeddings; the script persists
   only Turn embeddings). Offline never runs in chat.

## Out of scope (registered in FUTURE-IMPROVEMENTS)

EMD revisits, gate/fold divergences, anchor-wander counsel, the cost
chart and stored-cost display, the fold chart in chat, SSE progress,
the pause-and-choose flow from ADR 0006, and the fresh-start
suggestion driven by fired verdicts.

## Docs owed when the work lands

- ADR 0006: live-detection section rewritten surface-agnostic —
  arrival signals are computed before inference and persisted; how
  they surface (bubble, tabs) is UI policy, not the ADR.
- `CONTEXT.md`: Arrival-signal vocabulary; fix Prospective Turn's
  "nothing is persisted" wording so the CLI replay stays transient
  while in-chat arrivals persist.
- README: the `THREAD_ANALYSIS_MODE` env row.
- `.pi/PROJECT-KNOWLEDGE.md`: one-line state update.
