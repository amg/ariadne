# Setting Up Ari

How to run Ari for development, staging and production at home, how to
configure it, and how to run its tests. What Ari is and how it fits together
is in the [README](../README.md).

## Running It

### Development

The database and auth run in Docker; the app runs on your machine for fast iteration.

```bash
cp .env.dev.example .env          # one-time; fill in your API key
docker compose -f compose.dev.yml --env-file .env up -d
npm run migrate
npm run dev
```

Open `http://localhost:5173`.

Without a DeepInfra key, uncomment `MOCK_AI_BASE_URL` in `.env` and start the
mock inference server with `npm run mock --workspace=backend`. Its replies
are made up, and so is its sense of topic, so expect most messages to be
flagged as a change of subject.

### Staging

The full container build, to exercise the exact images before prod. It shares
`.env` and its ports with dev, so run one or the other:

```bash
docker compose -f compose.dev.yml --env-file .env down
docker compose -f compose.staging.yml --env-file .env up -d
npm run migrate
```

### Production (Cloudflare Tunnel)

A Cloudflare Tunnel lets people reach a server at home without opening any
ports on your router. A small program, `cloudflared`, runs next to the app and
opens an outgoing connection to Cloudflare. When someone visits your domain,
Cloudflare sends the request down that connection. Your home address stays
hidden, and Cloudflare handles HTTPS. You need a domain on Cloudflare (the free
plan is enough) and a tunnel created in Cloudflare's dashboard. Cloudflare's
Tunnel documentation walks through both.

The production setup expects `cloudflared` to be running already, in a Docker
network called `cloudflare-network`. The `frontend` container joins that
network and publishes no ports. Point the tunnel at it by container name:
`http://chat_frontend_prod:8080`.

Without a tunnel, staging is the easiest way to run the full containers on
your own machine. To put production behind a different reverse proxy instead,
publish the frontend's port 8080 and remove `cloudflare-network` from
`compose.prod.yml`.

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

A multi-copy production deployment on AWS, defined in code and raised only for
load tests, then torn down. See [`infra/README.md`](../infra/README.md).

## Configuration

`.env` configures dev and staging; `.env.prod` configures production. Both are
gitignored; the `.example` files list every variable with its meaning. The ones
that matter most:

| Variable | What it does |
|---|---|
| `DATABASE_URL` or `DB_*` | Postgres connection |
| `DEEPINFRA_API_KEY` | Your DeepInfra key. Ari is built against DeepInfra; another provider needs code changes |
| `MOCK_AI_BASE_URL` | Use the mock inference server instead (`backend/mock`); dev only |
| `DAILY_SPEND_BUDGET_USD` | The daily spend cap; unset means no cap |
| `DEFAULT_MODEL`, `TITLING_MODEL`, `REWRITE_MODEL`, `JUDGE_MODEL`, `MEMORY_MODEL` | The model for each task |
| `THREAD_ANALYSIS_MODE` | The drift gate: `off`, `heuristic` (default) or `always` |
| `FEATURE_MEMORY` | Turns Memory on; off by default |

Feature toggles are read at boot, so a change needs a backend restart.

## Running the Tests

```bash
cd backend && npm test
```

Tests run against real Postgres in a dedicated `chatbot_test` database that is
created next to the one configured in `.env` (or at `TEST_DATABASE_URL`). Test
files run in parallel, each on its own clone of it, so the database user needs
`CREATEDB`. `npm run gate` at the root runs every check, the tests and the
frontend build.
