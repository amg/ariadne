# Alex Chat Bot

A production-ready, Dockerized chatbot application with real-time streaming and cost observability; factual memory (RAG) is decided (ADR 0003) but not yet implemented.

## Features

- 💬 **Real-time Chat** - Streaming responses via Server-Sent Events (SSE)
- 🧵 **Multi-thread Support** - Multiple conversation sessions per user
- 🧠 **Factual Memory** *(planned — ADR 0003)* - Long-term memory extraction for cross-session context recall; storage foundation landed, pipeline pending
- 📊 **Cost Observability** - Token usage tracking and cost calculation per message
- 🐳 **Dockerized** - Easy deployment with Docker Compose
- ☁️ **Cloud-Ready** - Environment-based configuration for any deployment

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

### Local Development

```bash
# Copy environment template
cp .env.example .env

# Configure your environment variables
# Edit .env with your database credentials and API keys

# Start all services
docker compose up -d

# Access the application
# Frontend: http://localhost:5173
# Backend: http://localhost:3001
```

### Environment Variables

All configuration is externalized via environment variables. See `.env.example` for the complete list:

```bash
# Server Configuration
PORT=3001                    # Backend server port
HOST=0.0.0.0                 # Backend server host

# Database Configuration
DATABASE_URL=postgres://...  # Full connection string (recommended)
# OR individual components:
DB_USER=postgres
DB_PASSWORD=postgrespassword
DB_NAME=chatbot
DB_PORT=5432

# AI Provider
DEEPINFRA_API_KEY=your-key   # DeepInfra API key (required)
DEFAULT_MODEL=Qwen/Qwen3.5-9B
AI_STREAM_IDLE_TIMEOUT_MS=5000
EXCHANGE_STALENESS_MS=300000 # pending assistant rows older than this are declared lost

# Thread Analysis (live drift gate)
THREAD_ANALYSIS_MODE=heuristic  # off | heuristic | always (default: heuristic)
```

## Deployment

### Production Deployment (Cloudflare Tunnel)

**Topology:** Every documented deployment runs the app behind Cloudflare. The edge and the tunnel already know client IPs. IP-keyed limiting belongs at the edge; the app carries a global spend budget as the last defense against fund loss.

```bash
# 1. Copy production environment template
cp .env.prod.example .env.prod
# Edit .env.prod with your production credentials and API keys

# 2. Run production migrations
npm run migrate:prod

# 3. Start production services (zero published ports except dedicated DB port)
docker compose -f compose.prod.yml --env-file .env.prod up -d

# 4. Add tunnel ingress rule in Zero Dashboard (host-side)
# Route your domain to the frontend container by name
```

**Architecture:**
- Frontend joins external `cloudflare-network` (tunnel resolves by container name)
- Backend stays internal — no published ports
- Database publishes on dedicated port (`15432`) for LAN tooling from 50.x/57.x nets
- Global spend budget enforced via `DAILY_SPEND_BUDGET_USD` (default 5.0 USD)
- Deployment-wide caps on non-chat billing routes

**Benefits:**
- ✅ Zero exposed attack surface (tunnel ingress only)
- ✅ No `trustProxy` in codebase — app reads no forwarding headers
- ✅ Per-replica rate limit fuse (global 100/min, chat 20/min)
- ✅ Global daily spend budget prevents fund loss
- ✅ Free SSL/TLS via Cloudflare
- ✅ DDoS protection at the edge

### Development Deployment

```bash
# 1. Copy development environment template
cp .env.dev.example .env.dev

# 2. Start development services (loopback DB access)
docker compose -f compose.dev.yml --env-file .env.dev up -d

# 3. Run development migrations (defaults to dev database)
npm run migrate

# Access:
# Frontend: http://localhost:5173
# Backend: http://localhost:3001
# DB: 127.0.0.1:5432 (loopback only)
```

**Note:** Dev and prod use separate databases, volumes, and container names — they coexist on the same host without conflict.

### Self-Hosted (Local Network - Legacy)

The original `docker-compose.yml` remains for simple local network deployments. For production use, migrate to the split compose files above.

### Rate Limiting

The deployment enforces rate limits at two layers:

**Cloudflare Edge (recommended):** IP-keyed limits at the tunnel ingress.

**App-level (per-replica fuse):**
- Global: 100 requests/minute
- Chat: 20 requests/minute
- Generate title: 5 requests/minute
- Analysis: 10 requests/minute (backfill bounded to 20 arrivals per request)
- Models refresh: 2 requests/minute

**Global spend budget:** Checked before any chat exchange starts. When `DAILY_SPEND_BUDGET_USD` is set, all provider-metered USD for the current UTC day is summed across cost tables. Over budget → 429 with `Retry-After` header (seconds until UTC midnight). In-flight exchanges may overshoot — allowed by design.

## Project Structure

```
alex-chat-bot/
├── frontend/          # React frontend application
│   ├── .env.example   # Frontend environment variables
│   └── vite.config.ts # Vite configuration
├── backend/           # Node.js backend API
│   ├── .env.example   # Backend environment variables
│   ├── app/           # Fastify routes and server
│   ├── src/           # Services and database layer
│   └── mock/          # Mock inference server for testing
├── docs/
│   └── ideas/         # Deployment guides and technical analysis
│       ├── CLOUDFLARE-DEPLOYMENT.md
│       ├── AWS-DEPLOYMENT.md
│       └── SSE-VS-WEBSOCKET.md
├── features/          # Feature domain modules
├── adrs/              # Architecture Decision Records
└── scripts/           # Utility scripts
```

## Backend Architecture & Testing

The backend separates data access from business logic:

- `backend/src/db/queries/<table>/<query>.ts` — one Kysely query per file; the only place that touches Kysely/the database.
- `backend/src/services/*` — business logic; receives a `Kysely<Database>` instance and delegates all SQL to queries.
- `backend/app/**` — Fastify routes and server wiring.

Tests are real end-to-end tests against an actual PostgreSQL (`pgvector/pgvector:pg16`, started via testcontainers) — no mocks.

```bash
cd backend
npm test                 # Run tests
npm run test:watch       # Watch mode
```

## Documentation

- [Architecture Decisions](adrs/) - Technical decision records
- [Ideas](docs/ideas/) - Deployment and design explorations
- [Cloudflare Deployment](docs/ideas/CLOUDFLARE-DEPLOYMENT.md) - Private server + tunnel guide
- [AWS Deployment](docs/ideas/AWS-DEPLOYMENT.md) - Cloud deployment considerations
- [SSE vs WebSocket](docs/ideas/SSE-VS-WEBSOCKET.md) - Protocol analysis

## License

MIT
