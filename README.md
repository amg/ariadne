# Ari

A self-hosted chat application with streaming replies, per-Turn cost
tracking, topic-drift awareness and opt-in memory. Everything but
inference runs in Docker on your own hardware, so your data stays yours.

## What You Get

- **Chat** — Streaming Exchanges over SSE, multiple Threads, edit and Retry
- **Cost visibility** — What each Turn costs in tokens and USD, with a running total per Thread
- **User accounts** — Email and password sign-in, Threads isolated per user
- **Thread health** — Topic drift detection, so a Thread that wanders off its topic is noticed before the reply
- **Memory (opt-in)** — Facts captured as a conversation moves on, and fresh Threads seeded with what mattered before
- **A daily spend budget** — A hard cap on what the deployment can spend on inference each day

## Quick Start

### Development

The database and auth run in Docker; the app runs on your machine for fast iteration.

```bash
cp .env.dev.example .env          # one-time; fill in your API key
docker compose -f compose.dev.yml --env-file .env up -d
npm run migrate
npm run dev
```

Open `http://localhost:5173`.

### Staging

The full container build, to exercise the exact images before prod. It shares
`.env` and its ports with dev, so run one or the other:

```bash
docker compose -f compose.dev.yml --env-file .env down
docker compose -f compose.staging.yml --env-file .env up -d
npm run migrate
```

### Production (Cloudflare Tunnel)

No ports are exposed to the internet; a Cloudflare Tunnel routes your domain to
the `frontend` container, which joins an existing external `cloudflare-network`.

```bash
cp .env.prod.example .env.prod    # one-time; fill in credentials and the spend budget
ENV_FILE=.env.prod npm run migrate:prod
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

The backend runs its job queue in Postgres and installs the queue's schema on
boot, so the database user needs `CREATE` on the database. A job that runs out
of attempts stays failed (a chat whose drift check failed shows "couldn't check
this message") until you fix the cause and put it back in line:

```bash
ENV_FILE=.env.prod npm run queue:retry-failed
```

### aws-prod

A multi-copy production deployment on AWS, raised only for load tests and torn
down afterwards. See [`infra/README.md`](infra/README.md).

## Configuration

`.env` configures dev and staging; `.env.prod` configures production. Both are
gitignored; the `.example` files list every variable with its meaning. The ones
that matter most:

| Variable | What it does |
|---|---|
| `DATABASE_URL` or `DB_*` | Postgres connection |
| `DEEPINFRA_API_KEY` | The inference provider's key |
| `MOCK_AI_BASE_URL` | Use the mock inference server instead (`backend/mock`) |
| `DAILY_SPEND_BUDGET_USD` | The daily spend cap; unset means no cap |
| `DEFAULT_MODEL`, `TITLING_MODEL`, `REWRITE_MODEL`, `JUDGE_MODEL`, `MEMORY_MODEL` | The model for each task |
| `THREAD_ANALYSIS_MODE` | The drift gate: `off`, `heuristic` (default) or `always` |
| `FEATURE_MEMORY` | Turns Memory on; off by default |

Feature toggles are read at boot, so a change needs a backend restart.

## Testing

```bash
cd backend && npm test
```

Tests run against real Postgres, never mocks, in a dedicated `chatbot_test`
database that is created next to the one configured in `.env` (or at
`TEST_DATABASE_URL`). Test files run in parallel, each on its own clone of it,
so the database user needs `CREATEDB`. `npm run gate` at the root runs every
check, the tests and the frontend build.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, React Router, Vite, TypeScript |
| Backend | Node.js, Fastify, Kysely, TypeScript |
| Database | PostgreSQL with pgvector |
| Background work | graphile-worker (in Postgres) |
| Auth | SuperTokens (self-hosted) |
| AI | Vercel AI SDK, any OpenAI-compatible provider |
| Deployment | Docker Compose; CDK and Terraform for aws-prod |

## Project Structure

```
├── frontend/   React app
├── backend/    API, background worker, mock inference server
├── infra/      aws-prod: CDK, Terraform, load generator, operator scripts
├── scripts/    Repository checks
├── adrs/       Architecture decisions
├── docs/       Flows, architecture, ideas
└── CONTEXT.md  Domain vocabulary
```

## Documentation

- **[Domain vocabulary](CONTEXT.md)** — The terms (Threads, Turns, Drift, Facts, Seeds, Handovers) the codebase assumes everywhere
- **[Architecture decisions](adrs/)** — Why the key technical choices were made
- **[A new message in a Thread](docs/flows/NEW-MESSAGE.md)** — Submit, Drift gate, Retry, pause and Handover, end to end
- **[Background work](docs/flows/BACKGROUND-WORK.md)** — The queue, the event bus, push to the browser, and how failures surface
- **[aws-prod architecture](docs/architecture/AWS-PROD-ARCHITECTURE.html)** — The multi-copy AWS deployment: services, the way in, why Valkey
- **[aws-prod deployment](docs/architecture/AWS-PROD-DEPLOYMENT.html)** — Raising, running, recovering and the step gates
- **[Drift maths](docs/maths/)** — How the Drift gate judges a message, how it keeps running totals, and the alternatives considered
- **[Ideas](docs/ideas/)** — Open explorations

## Not Done Yet

- **Memory recall per reply** — Facts are captured and fresh Threads are seeded, but relevant Facts are not yet retrieved into each reply by similarity
