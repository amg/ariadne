# Alex Chat Bot

A self-hosted chat application with real-time streaming, per-Turn cost tracking, and user authentication. Everything runs in Docker — your data stays yours.

## What You Get

- **Real chat experience** — Streaming Exchanges (SSE), multiple Threads, edit and Retry actions
- **Cost visibility** — See exactly what each Turn costs in tokens and USD; Running total per Thread
- **User accounts** — SuperTokens authentication (email/password), isolated Threads per user
- **Thread health** — Topic drift detection, segment boundaries, cost accumulation awareness
- **Self-hosted** — No cloud dependencies, runs on your hardware

## Quick Start

### Development (run locally with `npm run dev`)

This is how you'll work on the code. The database and auth run in Docker; the app runs on your machine for fast iteration.

```bash
# 1. Start infrastructure (PostgreSQL + SuperTokens)
docker compose -f compose.dev-services.yml --env-file .env.dev up -d

# 2. Run migrations (creates tables)
npm run migrate

# 3. Start the app
npm run dev
```

Access at `http://localhost:5173`. Backend runs on `3001`, database on `5432`.

### Full Docker Dev (everything in containers)

Use this when you want to test the exact Docker build without running locally.

```bash
docker compose -f compose.dev.yml --env-file .env.dev up -d
npm run migrate
```

Same access URLs, but everything's containerized.

### Production (Cloudflare Tunnel)

For actual deployment. The app has zero exposed ports — Cloudflare Tunnel handles ingress.

```bash
# 1. Set up your production env file
cp .env.prod.example .env.prod
# Edit .env.prod with your credentials (DB password, API keys, spend budget)

# 2. Run migrations
npm run migrate:prod

# 3. Deploy
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

**What happens:** Frontend joins your existing `cloudflare-network`, backend stays internal, database listens on port `15432` for LAN tooling. Configure your tunnel to route your domain to the `frontend` container by name.

## Environment Setup

Three separate env files for three contexts:

| File | When | What it configures |
|------|------|-------------------|
| `backend/.env` | `npm run dev` | Local backend only |
| `.env.dev` | `compose.dev.yml` | Full dev stack in Docker |
| `.env.prod` | `compose.prod.yml` | Production deployment |

**Required variables** (see `.env.prod.example` for templates):
- `DATABASE_URL` or `DB_USER`/`DB_PASSWORD`/`DB_NAME` — PostgreSQL connection
- `DEEPINFRA_API_KEY` — AI provider (DeepInfra)
- `SUPERTOKENS_CONNECTION_URI` — Auth service (defaults to `http://127.0.0.1:3567`)
- `CORS_ORIGINS` — Allowed origins (defaults to localhost for dev)
- `DAILY_SPEND_BUDGET_USD` — Safety cap on daily AI spend (e.g., `5.0`)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + React Router v7 + TypeScript + Vite |
| Backend | Node.js 22 + Fastify + TypeScript |
| Database | PostgreSQL 16 with pgvector |
| Auth | SuperTokens (self-hosted) |
| AI | DeepInfra (OpenAI-compatible) |
| Infrastructure | Docker Compose |

## Project Structure

```
alex-chat-bot/
├── frontend/           # React app (Vite build)
│   ├── src/
│   │   ├── components/ # UI components
│   │   ├── pages/      # Route pages (ChatPage, AboutPage)
│   │   ├── services/   # API client
│   │   └── config/     # SuperTokens config
│   └── nginx.conf      # Production nginx config
├── backend/
│   ├── app/            # Fastify server and routes
│   ├── src/
│   │   ├── db/         # Database layer (Kysely queries)
│   │   ├── services/   # Business logic (auth, AI, threads)
│   │   └── config/     # Environment variables
│   └── mock/           # Mock AI server for testing
├── compose.*.yml       # Docker Compose files (dev/prod/services-only)
├── adrs/               # Architecture Decision Records
└── docs/               # Deployment guides and technical notes
```

## Backend Notes

**Query isolation:** All database access lives in `backend/src/db/queries/<table>/<operation>.ts`. Services call queries, never touch Kysely directly. This makes testing and reasoning about data flow trivial.

**Testing:** Real end-to-end tests against actual PostgreSQL (via testcontainers). No mocks. Run with `npm test` in `backend/`.

**Auth flow:** SuperTokens handles sessions via HTTP-only cookies. Every protected route uses `verifySession()` middleware to extract the user ID. On signup, the SuperTokens user ID is synced to the local `users` table to satisfy foreign key constraints.

## Documentation

- **[Architecture Decisions](adrs/)** — Why we made key technical choices
- **[Cloudflare Deployment](docs/ideas/CLOUDFLARE-DEPLOYMENT.md)** — Private server + tunnel setup
- **[SSE vs WebSocket](docs/ideas/SSE-VS-WEBSOCKET.md)** — Why we chose SSE for streaming

## What's Not Done (Yet)

- **Factual memory (RAG)** — Decided in ADR 0003, storage foundation exists, extraction pipeline pending
