# ADR 0008: Spending governance: one daily budget, not per-client rate limits

## Status
Accepted.

## Context

The app needs spending governance: a guarantee that a flood of requests —
malicious or accidental — cannot burn through the provider account. The rule
must fit both of the app's deployments: the home server behind a Cloudflare
Tunnel today, and the planned production shape on managed infrastructure,
also behind Cloudflare, running more than one app replica.

The deployment is single-user, so there is no crowd of clients to share
capacity between — the need is a spend number that holds, not fairness
across clients. Around $5/day at home, whatever production traffic
justifies. And the app cannot tell its real clients apart: every request
arrives through proxies, so per-client limits inside the app would rely on
forwarded headers an attacker can influence. Spending governance therefore
belongs to a number the deployment chooses, while client identity stays
where it actually exists — at the Cloudflare edge.

## Decision

Client identity stays with Cloudflare. The edge knows the real client IP and
the tunnel carries it; the app never reads forwarded headers, and no proxy
trust is ever configured.

The app enforces one deployment-wide spending budget instead:

| Aspect | Value |
|---|---|
| Setting | `DAILY_SPEND_BUDGET_USD`, default **5.0** |
| Unset | No budget check — behavior is exactly as today |
| Window | Calendar day, UTC |
| Checked | Once, when a chat message is submitted, before any Exchange starts |
| Counts | All provider-metered spend for the day, including estimated rows from interrupted exchanges |
| Refused with | `429` + `Retry-After` (seconds until the day resets) |
| In-flight work | Finishes; the exchange already streaming is not stopped |
| Reads | Never blocked — thread lists, messages, analysis remain open |

The budget is read from Postgres, summing the spend the app already records,
so it naturally survives restarts and crashes and works the same with
several replicas — no extra infrastructure.

The routes that bill outside chat get their own caps. Without them, an
attack could spend through the edges of the budget without ever submitting
chat, so these sit as the second layer:

| Route | Limit |
|---|---|
| `POST /api/threads/:id/generate-title` | 5/min |
| `GET /api/threads/:id/analysis` | 10/min |
| Analysis backfill per request | at most 20 arrivals; the rest fills on the next read |
| `POST /api/models/refresh` | 2/min |
| Global (all routes) | 100/min, unchanged |
| `POST /api/chat` | 20/min, unchanged |

These are shared limits for the whole deployment, not per-user — without
auth and without proxy trust, the app has no client identity to key on.
They are documented in the code exactly as they are: a coarse guard against
runaway request volume, one bucket per replica.

Dev and prod are separate stacks because they are different deployments:
`compose.dev.yml` runs only the database on loopback next to `npm run dev`;
`compose.prod.yml` publishes nothing and joins the existing tunnel network.
Each reads its own env file (`.env.dev` / `.env.prod`), and migrations run
against the dev database by default with an explicit switch for prod.

## Consequences

- Spend can no longer run past the configured daily number while a client
  is submitting chat; the cap holds through crashes, restarts, and extra
  replicas.
- One deployment is one budget — every device of the owner draws from the
  same pool, which suits a single-user app.
- Per-user limits must wait for auth. Until then, the budget is the whole
  defense against multi-account abuse; when per-user limits arrive, the 429
  they produce and the budget's 429 should surface together in the chat UI
  (tracked separately).
- Clients are identified by Cloudflare only; the app ignores forwarding
  headers and configures no proxy trust.
- Estimated spend counts as spent. An exchange that ends before the provider
  reports usage still charged an estimate, and the budget counts it.
