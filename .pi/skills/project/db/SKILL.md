---
name: db
description: Conventions for the Postgres/Kysely layer — migrations use the typed schema builder, and DB tests run against real Postgres, never mocks. Use when creating or editing migrations, or when writing database/repository tests.
---

# Database Conventions

## 1. Migrations

*   **Typed schema builder**: Write migration DDL with the typed Kysely schema
    builder (`db.schema.…`) and migration DML with the query builders
    (`insertInto().expression()`, `updateTable().from()`, `deleteFrom().using()`).
    Column types with no builder literal ride a raw `sql` expression inside the
    builder (`sql`numeric(14,10)``, `vector`).
*   **Raw `sql` escape hatch**: only what the builder cannot express
    (extensions, locks, triggers and functions), with the reason stated in a comment.
*   **Untyped connection**: migration signatures take `Kysely<any>` —
    mid-migration table shapes carry no app-side Database type, and the Migrator
    itself hands migrations that connection. The biome config turns
    `noExplicitAny` off for the migrations folder.

## 2. Queries

*   **Kysely Typed Builder**: All queries MUST use the Kysely typed builder where possible.
*   **Exception**: The ONLY exception is if it is proven that the current or available higher versions of Kysely cannot handle a certain query as a builder pattern.

## 3. Database Testing

*   **No Database Mocks**: NEVER mock the database (Kysely/Postgres).
*   **Real DB Testing**: All database/repository tests run against real PostgreSQL (Testcontainers).
*   **Test Isolation**: `useTestDb()` empties every table between tests. It reads the tables from the database catalog, so a new table needs no registration.
*   **Permitted Mocks**: ONLY at system boundaries for external network calls (e.g., DeepInfra API).
