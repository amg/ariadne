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
- **`docs/architecture/`** — HTML reports of the aws-prod architecture,
  and the load testing architecture: how a
  run is driven, recorded and judged, and why.
- **`docs/architecture/load-run-learnings.md`** — what each load run hit,
  what we changed, and what we now believe. Read it before planning a run,
  and add to it after reading one.
- **`docs/ideas/`** — open explorations, high level only.
- **`docs/maths/`** — how the Drift gate's maths works, told as a story
  (no implementation detail).
- **`load/`** — the load harness, split into records (what a run
  stores, under one schema version for the run folder), generator (the virtual users), archive
  (collects a run into a sealed folder) and rebuild (stored records to
  numbers). Each part may import only records; the home commands also use
  archive. A run folder lives in `load/.runs/<run id>/` on the operator's
  machine, with the same layout on aws-prod and cubi, and its manifest,
  written last, seals it. The aws-prod stack that runs it is
  in `infra/lib/load/`.
- **App records** — in every environment the backend logs a line per chat
  request, per queue attempt, and a state line every few seconds, under an
  `appRecord` key and without message text. The archive sorts them out of
  the backend's log into `app/`, and its self-check fails a run that lacks
  them. Every telemetry call is named `log*` (`logAppRecord`,
  `record.logFirstToken`, `keepLoggingState`); `logMetric*` is reserved
  for emitting a metric directly.
- **`infra/README.md`** — operating aws-prod.
- **`.pi/FUTURE-IMPROVEMENTS.md`** — backlog (gitignored).

## Agent Tips

- **Tests** run from the agent container too (`cd backend && npm test`).
  Probing the host database, and throwaway scripts, live in `.work/testing/`
  (gitignored; start with `.work/testing/db.md`), never in the repo.
- **Redis vs Valkey.** The server is Valkey everywhere; code says
  "Redis" for the protocol and the ioredis client (`connectRedis`,
  `redisCarrier`), while deployment names (`VALKEY_URL`, infra, compose)
  say "Valkey".
- **Tables are schema-qualified** in code (`billing.messageUsage`): one
  Postgres schema per domain, with the auth provider's tables in `auth`
  and the queue in `queues`.
- **aws-prod runs on the host, not here.** The agent container has no
  AWS CLI or credentials, so the operator runs every AWS command. Give
  them a standalone script, or a one-off helper call wrapped as
  `bash -c 'source scripts/lib/command.sh && load_names <step> && <helper>'`.
  Sourcing `command.sh` straight into their login shell turns on strict
  mode there, and the first error closes the session. A run's
  `load/.runs/<run>/logs/generator-<n>-attempt-<m>.log` holds each
  generator's first errors;
  requests blocked at the edge show in Cloudflare under Security, Events.
- **Load paths.** `aws-prod load` skips Cloudflare to measure aws-prod
  alone: generators present their own client certificate, and leave the
  load stack's network through one NAT address that the stack itself lets
  into the origin, so the way in lasts exactly as long as the load stack.
  Steps are proven on the
  direct path first, then repeated through Cloudflare with `--edge`.
- **Query tags.** A query file tags its query with
  `db.withPlugin(tagQuery('<folder>/<file>'))` inside the function, on
  each call, so it follows a request scope's handle. Postgres and
  Performance Insights then see `/* query:<folder>/<file> */` at the
  front of the SQL.
- **Load tests check behaviour, not output.** Rebuild tests read run
  folders from `load/src/rebuild/fixtures/` and check verdicts, logic and
  determinism. No expected output or HTML markup is stored.

## Skills

`.pi/skills/` holds the agent skills in layers: `common/` (any language),
`typescript/`, `react/`, and `project/` (this repo only). A skill refers
only to skills in its own layer or a lower one, so the lower layers can be
lifted into another repo unchanged. Pi lists every skill at startup; load
each one whose description matches the task before starting, because the
skill file is the specification. Keep Markdown files out of the
`.pi/skills/` root, since Pi reads any `.md` there as a skill.
