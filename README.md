# Alex Chat Bot

A self-hosted chat application with real-time streaming, per-Turn cost tracking, and user authentication. Everything runs in Docker — your data stays yours.

## What You Get

- **Real chat experience** — Streaming Exchanges (SSE), multiple Threads, edit and Retry actions
- **Cost visibility** — See exactly what each Turn costs in tokens and USD; Running total per Thread
- **User accounts** — SuperTokens authentication (email/password), isolated Threads per user
- **Thread health** — Topic drift detection, segment boundaries, cost accumulation awareness
- **Memory (opt-in)** — Facts captured at segment close, fresh Threads seeded with what mattered before, per-user toggle
- **Self-hosted** — No cloud dependencies, runs on your hardware

## Quick Start

### Development (run locally with `npm run dev`)

This is how you'll work on the code. The database and auth run in Docker; the app runs on your machine for fast iteration.

```bash
# 1. Copy the env template (one-time setup)
cp .env.dev.example .env
# Edit .env with your API keys and preferences

# 2. Start infrastructure (PostgreSQL + SuperTokens)
docker compose -f compose.dev.yml --env-file .env up -d

# 3. Run migrations (creates tables)
npm run migrate

# 4. Start the app
npm run dev
```

Access at `http://localhost:5173`. Backend runs on `3001`, database on `15432`, SuperTokens on `3567`.

### Staging (full Docker build)

Use this to exercise the exact container images before they go to prod. Shares `.env` with the dev tier, so they publish the same ports — bring dev infrastructure down before lifting staging, and vice versa. Separate container, volume, and network names, so staging never touches dev or prod data.

```bash
docker compose -f compose.dev.yml --env-file .env down
docker compose -f compose.staging.yml --env-file .env up -d
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
ENV_FILE=.env.prod npm run migrate:prod

# 3. Deploy
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

**What happens:** Frontend joins your existing `cloudflare-network`, backend stays internal, database listens on port `15432` for LAN tooling. Configure your tunnel to route your domain to the `frontend` container by name.

**Background work:** the backend runs its own job queue in Postgres and installs the queue's `queues` schema on every boot, so the database user needs `CREATE` on the database. A job that runs out of attempts stays failed until you put it back in line. A chat whose drift check failed for good shows "couldn't check this message" until then:

```bash
ENV_FILE=.env.prod npm run queue:retry-failed   # prints what it re-queued
```

Run it after fixing the cause (usually a missing or rejected API key). Failed jobs that a newer job has already taken over are listed and left alone.

## Environment Setup

Two env files — one for local dev, one for production. Both are gitignored.

| File | Git? | When | What it configures |
|------|------|------|-------------------|
| `.env` | ❌ | `npm run dev`, `compose.dev.yml`, `compose.staging.yml` | Local development and staging |
| `.env.prod` | ❌ | `compose.prod.yml` | Production deployment |

**Setup:**
```bash
# Local dev
cp .env.dev.example .env
# Edit .env with your keys

# Production
cp .env.prod.example .env.prod
# Edit .env.prod with prod credentials
```

**Required variables** (see `.env.prod.example` for templates):
- `DATABASE_URL` or `DB_USER`/`DB_PASSWORD`/`DB_NAME` — PostgreSQL connection
- `DEEPINFRA_API_KEY` — AI provider (DeepInfra)
- `SUPERTOKENS_CONNECTION_URI` — Auth service (defaults to `http://127.0.0.1:3567`)
- `CORS_ORIGINS` — Allowed origins (defaults to localhost for dev)
- `DAILY_SPEND_BUDGET_USD` — Safety cap on daily AI spend (e.g., `5.0`)

**Optional variables:**
- `FEATURE_MEMORY` — User memory (Fact capture, Thread Seeds, the Memory and Settings screens). Off by default; the backend reads it at boot, so restart it after a change.
- `THREAD_ANALYSIS_MODE` — Live drift gate: `off` (disabled), `heuristic` (cheap checks, the default), `always` (rewrite + judge runs on every arrival).
- `DEFAULT_MODEL`, `TITLING_MODEL`, `REWRITE_MODEL`, `JUDGE_MODEL`, `MEMORY_MODEL` — Model per task, all defaulting to `Qwen/Qwen3.5-9B` on DeepInfra.
- `GATE_WAIT_MS`, `HANDOVER_WAIT_MS` — How long a chat waits for its drift check, and a handover for the old chat's memory, before telling the browser to try again. Both default to 10 seconds.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + React Router v7 + TypeScript 6 + Vite 8 |
| Backend | Node.js 22 + Fastify 5 + TypeScript 7 |
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
│   │   ├── pages/      # Route pages (Chat, Memory, Settings, About)
│   │   ├── services/   # API client
│   │   └── config/     # SuperTokens and feature-toggle config
│   └── nginx.conf      # Production nginx config
├── backend/
│   ├── app/            # Fastify server and routes
│   ├── src/
│   │   ├── db/         # Database layer (Kysely queries)
│   │   ├── services/   # Business logic (AI, threads, drift gate, memory)
│   │   └── config/     # Environment variables
│   └── mock/           # Mock AI server for testing
├── compose.*.yml       # Docker Compose files (dev/staging/prod)
├── adrs/               # Architecture Decision Records
└── docs/               # Deployment guides and technical notes
```

## Backend Notes

**Query isolation:** All database access lives in `backend/src/db/queries/<table>/<operation>.ts`. Services call queries, never touch Kysely directly. This makes testing and reasoning about data flow trivial.

**Testing:** Real end-to-end tests against actual PostgreSQL. No mocks. They always run against a dedicated `chatbot_test` database, never the dev DB. By default it is auto-provisioned next to the database configured in the root `.env` (`DATABASE_URL` or `DB_*` parts); from the agent container it is reached via the Docker gateway instead. Point elsewhere explicitly with `TEST_DATABASE_URL`. Run with `npm test` in `backend/`.

**Auth flow:** SuperTokens handles sessions via HTTP-only cookies. Every protected route uses `verifySession()` middleware to extract the user ID. On signup, the SuperTokens user ID is synced to the local `users` table to satisfy foreign key constraints.

## Documentation

- **[Domain vocabulary](CONTEXT.md)** — The terms (Threads, Turns, Drift, Facts, Seeds, Handovers) the codebase assumes everywhere
- **[Architecture Decisions](adrs/)** — Why we made key technical choices
- **[A new message in a Thread](docs/flows/NEW-MESSAGE.md)** — Submit, Drift gate, Retry, pause and Handover, end to end
- **[Background work](docs/flows/BACKGROUND-WORK.md)** — The queue, the event bus, push to the browser, and how failures surface
- **[Cloudflare Deployment](docs/ideas/CLOUDFLARE-DEPLOYMENT.md)** — Private server + tunnel setup
- **[SSE vs WebSocket](docs/ideas/SSE-VS-WEBSOCKET.md)** — Why we chose SSE for streaming

## What's Not Done (Yet)

- **Per-turn memory recall** — Facts are captured and each fresh Thread is seeded from the one before it; retrieving relevant Facts into a reply by query similarity (ADR 0003's RAG read side) is still pending
