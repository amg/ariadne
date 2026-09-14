# Alex Chat Bot

A production-ready, Dockerized chatbot application with real-time streaming, contextual memory, and cost observability.

## Features

- 💬 **Real-time Chat** - Streaming responses via Server-Sent Events (SSE)
- 🧵 **Multi-thread Support** - Multiple conversation sessions per user
- 🧠 **Factual Memory** - Long-term memory extraction for cross-session context recall
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
```

## Deployment

### Private Server + Cloudflare Tunnel (Recommended)

Deploy on a home server or VPS and expose securely via Cloudflare Tunnel:

```bash
# 1. Deploy to your server
git clone <repo>
docker compose up -d

# 2. Set up Cloudflare Tunnel
# See docs/ideas/CLOUDFLARE-DEPLOYMENT.md for complete guide

# 3. Access via your domain
# https://chat.yourdomain.com
```

**Benefits:**
- ✅ No port forwarding required
- ✅ Free SSL/TLS via Cloudflare
- ✅ DDoS protection
- ✅ Hidden origin IP
- ✅ Global CDN

**Cost:** ~$1-2/month (domain only, if hosting at home)

**Architecture:** Combined deployment (frontend + backend + database on same server)
- Simple one-command deployment
- No CORS configuration needed
- Perfect for personal/small-scale use
- Can split later if needed

### Self-Hosted (Local Network)

```bash
# Start services
docker compose up -d

# Access from local network
# http://<server-ip>:5173
```

**Note:** Only accessible within your network. For external access, use Cloudflare Tunnel or configure port forwarding.

### Cloud Deployment (AWS/GCP/Azure)

For production cloud deployment:

- See `docs/ideas/AWS-DEPLOYMENT.md` for AWS-specific guidance
- All configuration via environment variables (cloud-ready)
- Combined or split deployment both supported

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

- [Grand Plan](GRAND_PLAN.md) - High-level project requirements
- [Architecture Decisions](adrs/) - Technical decision records
- [Cloudflare Deployment](docs/ideas/CLOUDFLARE-DEPLOYMENT.md) - Private server + tunnel guide
- [AWS Deployment](docs/ideas/AWS-DEPLOYMENT.md) - Cloud deployment considerations
- [SSE vs WebSocket](docs/ideas/SSE-VS-WEBSOCKET.md) - Protocol analysis

## License

MIT
