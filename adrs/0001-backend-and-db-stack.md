# ADR 0001: Backend Runtime and Database Stack

## Status
Accepted

## Context
We need a robust, type-safe backend to orchestrate the chat interface, manage multiple threads, interface with the AI provider, and store long-term factual memory. The frontend is built in React/TypeScript, making a TypeScript backend highly desirable for sharing types and standardizing the development experience. Additionally, we need a way to interact with PostgreSQL without the overhead or "magic" of a heavy ORM.

## Decision
*   **Backend Runtime**: Node.js (using Fastify or Express).
*   **Database**: PostgreSQL.
*   **Query Builder**: Kysely.

## Consequences
*   **Easier**: Code sharing between frontend and backend. Kysely provides excellent, strict type safety by introspecting or defining database schemas, without the heavy abstraction layers of traditional ORMs (like Prisma). It keeps us close to SQL, which is beneficial for complex queries (like vector similarity searches for memory).
*   **Harder**: We will need to manage database migrations ourselves (or using Kysely's migration system) rather than relying on declarative schema pushes like Prisma.