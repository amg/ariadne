# Stop remembering: wipe a user's memory

Priority: after the Memory Screen (ticket 003) lands. Read the
"Memory is the user's to switch off" section of ADR 0010 first.

## Why

Phase 2 gives the user one fact at a time to look at, suppress, and
delete. What it has no answer for is the whole thing: "forget
everything you know about me". Turning memory off today only stops
capture and seeding; the accumulated facts stay stored and are ready to
flow back into a new Thread the moment memory comes back on. A purge is
a heavier operation than the switch, and is deliberately separate work.

## Decide first

1. **Whether the purge also turns memory off.** Recommended: yes.
   Deleting the facts while capture stays on leaves every segment the
   user still owes to a capture, which quietly rebuilds the memory from
   old conversations — the opposite of what was asked. Deleting and
   switching memory off starts truly from a blank slate, and turning
   memory back on later only ever captures what happens after that.
2. **What deletion does to Seeds already frozen in open Threads.**
   Same question the open point of ticket 003 asks about individual
   deletes, and the answer should be one policy for both. Recommended:
   frozen Seeds keep their lines until the Thread ends, consistent with
   the Seed's purpose of a stable prompt; a dynamic refresh policy
   addresses it later. The strip-out alternative (editing the Seed's
   line list on every delete) is imprecise — lines match by text and
   category — and is worth avoiding until the Seed policy itself is
   rethought.
3. **The API shape.** A `DELETE /api/memory/facts` that wipes the
   user's rows and updates the settings document, or a per-user flag.
   The Memory Screen's single-row delete (ticket 003) reuses the same
   service.

## Scope

- The service that hard-deletes all of a user's facts, settles any owed
  segments the same way "memory off" settles them, and turns memory off
  in the user's settings document.
- The settings page control with a confirmation step, behind the
  existing settings API.
- An audit row, since a wholesale delete of personal data should leave
  a trace that it happened, even after the data is gone.

## Done when

A user who stops remembering starts with zero seedable facts in every
new Thread, no owed segment rebuilds the old memory, and the action is
audited.
