# Database: one Postgres schema per domain

Branch: `feat/domain-schemas`. Priority: after the durable queue (ticket
006), which already lands its own `queues` schema.

## Goal

Every app table lives in `public` today, mixed in with roughly 60
SuperTokens tables that share the same database. Moving each domain into
its own schema makes the boundaries visible in the database itself, and
keeps the app's tables apart from the auth provider's.

## Proposed map

| Schema | Tables |
|---|---|
| `chat` | `users`, `threads`, `messages` |
| `analysis` | `message_embeddings`, `thread_segments`, `segment_drift_logs` |
| `memory` | `user_facts`, `thread_seeds`, `user_settings` |
| `billing` | `message_usage`, `message_side_costs`, `model_configs` |
| `public` | `kysely_migration` and its lock table, unless they move too |

The queue library (ADR 0011) creates and owns a `queues` schema by
itself; leave it out of the move.

## Decide first

1. **How code names a table.** Either schema-qualified keys in Kysely's
   `Database` type (`'memory.userFacts'`; the CamelCasePlugin maps each
   part), which is explicit but touches every query, or a connection
   `search_path`, which needs no query changes but hides the domain in code
   and requires table names to stay unique across schemas.
2. **SuperTokens.** Moving it into an `auth` schema goes through its
   `POSTGRESQL_TABLE_SCHEMA` setting. Check that existing sessions and
   users survive the move before doing it; it can also stay out of scope.
3. **Whether a schema boundary is also an access boundary** (one DB role
   per schema), or only an organisational one. Organisational is enough
   for now.

## Scope

- One migration that creates the schemas and moves the tables with
  `alter table ... set schema`. That moves data, indexes and constraints
  in one statement with nothing copied; foreign keys keep working across
  schemas. The `down` moves them back.
- Kysely types and queries updated to the chosen naming. Raw `sql`
  fragments that name tables need the same treatment.
- `backend/test/global-setup.ts` wipes only `public` before applying
  migrations; it has to drop the new schemas too.
- The analysis CLI, smoke script, and `.testing/` probes that name tables.
- `CONTEXT.md` gains nothing; `PROJECT-KNOWLEDGE.md` records the map.

## Risks

- `set schema` takes a brief exclusive lock per table. The migration and
  the code that expects the new names must ship together, because neither
  works with the other's old layout.
- Take a database backup before running it in production.

## Done when

The gate passes against the new layout, `npm run migrate` moves an
existing dev database in place with no data lost, and `down` restores the
old layout.
