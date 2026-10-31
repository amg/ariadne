# Context Compaction

A Thread that stays on one topic still grows without bound. Every Turn
resends the whole history, so cost per Turn climbs, and a long enough
Thread eventually presses against the model's context window. Compaction
is the classic answer: once the Thread crosses a token threshold, older
Turns are summarized and the summary stands in for them in the context,
while the raw messages stay stored and visible.

## How it sits next to what exists
yeah 
The project already answers the *drifting* Thread differently. The drift
gate notices when a Thread stops earning its context, and a Handover moves
the conversation into a fresh Thread whose Seed carries what Memory knows.
That handles topic changes cleanly and keeps every Thread's context
honest, with no summary in between.

Compaction covers the case the gate deliberately leaves alone: a long,
coherent Thread that never drifts. It complements Handover rather than
replacing it.

## Why it is not built

- **Caching cuts against it.** Provider prompt caches key on a stable
  prefix. Rewriting the head of the context into a summary invalidates the
  cache for everything after it, so compaction has to happen rarely and in
  big steps, not a little each Turn. The same reasoning made the Seed
  byte-stable for a Thread's life.
- **Summaries lose things quietly.** A summary drops detail that the
  model may need several Turns later, and the user cannot see what was
  dropped. Memory capture already pulls the durable Facts out of a Thread,
  which shrinks what a summary would need to preserve.
- **The pressure is low today.** Current chat models offer context
  windows in the hundreds of thousands of tokens, and cached input is
  cheap, so few real Threads hit the wall.

## If it gets built

Keep the raw messages as the only source of truth and treat the summary
as a derived context block, assembled like the Seed: placed after the
stable system prompt, rebuilt only when the threshold is crossed again,
and recorded with the Turn range it covers so its cost and coverage stay
observable.
