---
description: Query modules own the database connection singleton instead of receiving it; replaces the injection convention of 0001.
---

# ADR 0004: Query Modules Own the Database Connection Singleton

## Status
Accepted — supersedes the DI convention from ADR 0001 ("queries and services
receive a `Kysely<Database>` instance").

## Context
After ADR 0001, every service and query function took `db: Kysely<Database>`
as its first argument so tests could inject a connection. As the service
signatures filled up with real context (`userId` threaded everywhere for the
future page-level auth), the `db` parameter became pure plumbing that rode
through every layer without ever varying: there is exactly one database, and
the only code that ever needs a second connection is `test/global-setup.ts`
(schema reset before workers start), which builds its own short-lived
instance via `createDbFromPool`.

## Decision
- Query modules (`src/db/queries/**`) import the singleton `db` directly from
  `src/db/db.ts`; their signatures carry only domain arguments.
- Services take no `Kysely` parameter at all — signatures are
  `(userId, …args)`, matching how context will flow once page-level auth
  resolves the user.
- `src/db/db.ts` resolves its connection from the environment **at import
  time**: `VITEST_TEST_DATABASE_URL` → `DATABASE_URL` → `DB_*` parts.
  The pg Pool connects lazily, so importing never opens a connection.
- Testing: `test/global-setup.ts` provisions and migrates the real test
  database, then clones it once per vitest worker; a setup file points each
  worker's `VITEST_TEST_DATABASE_URL` at its own clone before any test file
  imports the singleton, so it binds to that clone automatically.
  `useTestDb()` is a lifecycle hook (empty every table between tests,
  destroy the pool after the file) instead of a connection factory. Test
  files run in parallel; clearing never crosses workers because no two
  workers share a database.
- `createDbFromPool` remains exported for global-setup's schema reset.

## Consequences
- **Easier**: No DI ceremony anywhere; services read as pure business logic;
  test files lost the `db` argument at every call site.
- **Easier**: Auth pass-down has a clean target shape — only `userId` flows
  top-to-bottom; swapping `REQUEST_USER_ID` for a resolved user touches only
  the route layer.
- **Harder**: A service can no longer run against an arbitrary second
  database in the same process (unit-testing a service still requires the
  real test DB — which is already the convention).
- **Constraint**: Anything importing a query transitively imports the
  singleton; database env must be present/resolvable in every environment
  that runs tests or the app. Guarded in practice: a worker fails loudly
  when it cannot resolve its own database clone.
