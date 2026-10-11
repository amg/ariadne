# Chat Bot Project Knowledge

Ari: a self-hosted chatbot with streaming replies, cost tracking,
topic-drift detection and opt-in memory.

## Start Here

The root `README.md` covers features, quick start, configuration,
testing, tech stack and structure. It is the single source of project
truth; nothing here repeats it.

## Knowledge Map

- **`CONTEXT.md`** — the domain vocabulary the code assumes.
- **`adrs/`** — architectural decisions. Each opens with a one-line
  `description`; `adrs/README.md` holds the format and upkeep rules.
- **`docs/flows/`** — how a message and background work move through the
  system. Concepts only.
- **`docs/architecture/`** — HTML reports of deployment shapes (aws-prod
  architecture and deployment).
- **`docs/ideas/`** — open explorations, high level only.
- **`docs/project-management/`** — WIP tickets and bugs; deleted when the
  work lands.
- **`infra/README.md`** — operating aws-prod.
- **`.pi/FUTURE-IMPROVEMENTS.md`** — backlog (gitignored).

## Agent Tips

- **Tests** run from the agent container too (`cd backend && npm test`).
  Probing the host database, and throwaway scripts, live in `.testing/`
  (gitignored; start with `.testing/db.md`), never in the repo.
- **Redis vs Valkey.** The server is Valkey everywhere; code says
  "Redis" for the protocol and the ioredis client (`connectRedis`,
  `redisCarrier`), while deployment names (`VALKEY_URL`, infra, compose)
  say "Valkey".
- **Tables are schema-qualified** in code (`billing.messageUsage`): one
  Postgres schema per domain, with the auth provider's tables in `auth`
  and the queue in `queues`.

## Skill Loading (CRITICAL)

Before any task, read `.pi/SKILLS-INDEX.md`, load every `SKILL.md` that
matches the task, then proceed. The skill file is the specification.
