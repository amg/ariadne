# ADR 0009: Deployment tiers: dev, staging, prod

## Status
Accepted.

## Context

The app runs in three shapes that must never be confused, because each is
trusted differently: the everyday working set on the developer's machine, a
rehearsal of the exact container images, and the live deployment behind the
Cloudflare Tunnel. One compose file per shape, one vocabulary for all of it,
so every README, check, and muscle memory points at the same three names.

## Decision

Three tiers, one compose file each, suffixed resource names (`_dev`,
`_staging`, `_prod`) so all three coexist on one host:

| Tier | File | Runs | Env | Data |
|---|---|---|---|---|
| **dev** | `compose.dev.yml` | Infrastructure only (PostgreSQL + SuperTokens); backend and frontend run on the host via `npm run dev` | `.env` | The working set — the only database that accumulates real Threads and accounts |
| **staging** | `compose.staging.yml` | The full Docker build, exercising the exact images before prod | `.env` | Disposable; starts empty |
| **prod** | `compose.prod.yml` | The full Docker build behind the tunnel; zero published ports except the dedicated DB port | `.env.prod` | Solemn; prod data never moves downward |

Rules:

- **Two env files.** `.env` feeds everything local; `.env.prod` feeds prod
  alone. Deployment topology is this ADR's concern; env files go nowhere
  else.
- **One local stack at a time.** Dev and staging share `.env`, so they
  publish the same ports (`${DB_PORT}`, SuperTokens 3567, backend 3001,
  frontend 5173). Bring one down before lifting the other; documented, not
  enforced.
- **Data ownership flows one way.** Threads and accounts are born in dev's
  database, and `npm run migrate` keeps each tier's schema current against
  its own database. Data itself is never copied to staging or prod.

## Consequences

Easier: one name per intent, and a revived backup has an obvious home (dev)
— create the account, reassign its Threads from the default user. Harder:
staging can never exercise dev's data by construction; a staging tier that
shared the working set would grow a "which database is real" problem.
