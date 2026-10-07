# User facts: Memory Screen and settings page (phase 2)

Branch: `docs/user-facts-memory`. Read ADR 0010 and the Memory section of
`CONTEXT.md` first. Phase 1 is built on this branch: Fact capture at
segment close, Seeds, the drift pause with handover, and per-user
settings behind `GET`/`PATCH /api/settings`. The memory seam is
`backend/src/services/memory/index.ts`.

## Goal

The user can see and manage everything the Memory holds, and can switch
memory on or off and block categories, without touching the API.

## Scope

1. **Memory Screen** (`/memory`, linked from the sidebar): lists the
   user's current Facts, including suppressed ones, newest first, with
   date and category.
   - **Edit** invalidates the old row (`invalid_at = now()`) and inserts the
     replacement with a fresh embedding. It never overwrites.
   - **Suppress** toggles the flag. A suppressed Fact stays known, so the
     duplicate guard never re-adds it, but it is never seeded.
   - **Delete** hard-deletes the row.
   - Backend: `GET /api/memory/facts`, `PATCH /api/memory/facts/:id`
     (`{ content }` or `{ suppressed }`), and `DELETE /api/memory/facts/:id`.
     All are user-scoped.
2. **Settings page** (`/settings`): a memory on/off switch and checkboxes
   for the blocked categories, backed by the existing settings API. There
   is no delete-everything control here — "stop remembering" is ticket 010.

## Open points

- Seeds already frozen keep a Fact that is later edited, suppressed, or
  deleted until that Thread ends. That is the shipping behaviour of
  phase 2; whether a delete should also strip the Fact out of frozen
  Seeds is decided together with the purge in ticket 010. Blocking a
  category is already handled: Seed lines keep their category and
  blocked ones are skipped at assembly.
