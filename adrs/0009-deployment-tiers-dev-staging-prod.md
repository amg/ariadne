---
description: Four deployment tiers (dev, staging, prod, aws-prod), kept apart, with data flowing one way.
---

# ADR 0009: Deployment tiers: dev, staging, prod, aws-prod

## Status
Accepted.

## Context
The app runs in several shapes that must never be confused, because each
is trusted differently: the everyday working set on the developer's
machine, a rehearsal of the exact container images, the live deployment
behind a Cloudflare Tunnel, and a production-scale deployment raised
only to be load tested. One name per shape, one vocabulary for all of
it, so every README, check and habit points at the same names.

## Decision

| Tier | Runs | Data |
|---|---|---|
| **dev** | Infrastructure in containers (Postgres, SuperTokens); backend and frontend on the host | The working set: the only database that accumulates real Threads and accounts |
| **staging** | The full container build, exercising the exact images before prod | Disposable; starts empty |
| **prod** | The full container build behind the tunnel, publishing nothing but the database port | Solemn; prod data never moves downward |
| **aws-prod** | A multi-copy production deployment on AWS behind Cloudflare's proxy, raised for a test run and then torn down (ADR 0014) | Synthetic only, restored from a seeded snapshot at every raise; nothing outlives a teardown |

Rules:

- **The three local tiers coexist on one host.** One compose file each,
  with suffixed resource names. Dev and staging share one env file and
  publish the same ports, so only one of them runs at a time; this is
  documented, not enforced. Prod has its own env file. Env files belong
  to deployment topology and go nowhere else.
- **Data flows one way.** Threads and accounts are born in dev's
  database. Each tier migrates its own schema against its own database,
  and data is never copied into staging, prod or aws-prod, nor out of
  aws-prod.
- **aws-prod sits beside prod, not above it.** While it is up it is
  production, built to an enterprise standard with the exceptions ADR
  0014 names. It holds no real accounts, sign-up is closed, and its
  inference is mocked during load tests. It replaces nothing: prod stays
  where it is.

## Consequences
* **Easier**: one name per intent, and a revived backup has an obvious
  home (dev): create the account, reassign its Threads from the default
  user.
* **Harder**: staging can never exercise dev's data, by construction; a
  staging tier that shared the working set would grow a "which database
  is real" problem. aws-prod measures the system under load but never
  with real data.
