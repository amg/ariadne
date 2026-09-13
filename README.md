# Alex Chat Bot

A production-ready, Dockerized chatbot application with real-time streaming, contextual memory, and cost observability.

## Features

- 💬 **Real-time Chat** - Streaming responses via Server-Sent Events (SSE)
- 🧵 **Multi-thread Support** - Multiple conversation sessions per user
- 🧠 **Factual Memory** - Long-term memory extraction for cross-session context recall
- 📊 **Cost Observability** - Token usage tracking and cost calculation per message
- 🐳 **Dockerized** - Easy deployment with Docker Compose

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + React Router v7 + TypeScript |
| Backend | Node.js (Fastify) + TypeScript |
| Database | PostgreSQL |
| Query Builder | Kysely (type-safe SQL) |
| AI Inference | DeepInfra (OpenAI-compatible endpoints) |
| AI Streaming | Vercel AI SDK |
| Infrastructure | Docker & Docker Compose |

## Quick Start

```bash
# Start all services
docker compose up -d

# Access the application
# Frontend: http://localhost:3000
# Backend: http://localhost:3001
```

## Project Structure

```
alex-chat-bot/
├── frontend/          # React frontend application
├── backend/           # Node.js backend API
├── features/          # Feature domain modules
├── adrs/              # Architecture Decision Records
└── scripts/           # Utility scripts
```

## Backend Architecture & Testing

The backend separates data access from business logic:

- `backend/src/db/queries/<table>/<query>.ts` — one Kysely query per file; the only place that touches Kysely/the database.
- `backend/src/services/*` — business logic (default titles, echo response, seeding semantics); receives a `Kysely<Database>` instance and delegates all SQL to queries.
- `backend/app/**` — Fastify routes and server wiring; the only place that hands pool connections to services.

Tests are real end-to-end tests against an actual PostgreSQL (`pgvector/pgvector:pg16`, started via testcontainers) — no mocks. Query and service tests each cover their own edge cases.

The test database URL is resolved in this order:

1. `TEST_DATABASE_URL` env var — explicit, always wins.
2. A disposable testcontainers Postgres when Docker is available (`npm test` on a dev host / CI).
3. Sandbox fallback: the dev `chat_db` Postgres reached through the agent container's network gateway, using a dedicated auto-created `chatbot_test` database (dev data is never touched).

```bash
cd backend
npm test                 # container or sandbox fallback automatically
npm run test:watch

# Reuse an existing database instead:
TEST_DATABASE_URL=postgres://postgres:postgrespassword@127.0.0.1:5432/chatbot_test npm test
```

## Documentation

- [Grand Plan](GRAND_PLAN.md) - High-level project requirements and architecture
- [Architecture Decisions](adrs/) - Technical decision records

## License

MIT
