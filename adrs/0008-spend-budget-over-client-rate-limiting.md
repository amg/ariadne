---
description: One daily spend budget per deployment, read from Postgres; client identity stays at the Cloudflare edge; request limits are placed by deployment shape.
---

# ADR 0008: Spending governance: one daily budget, client identity at the edge

## Status
Accepted.

## Context
The app needs spending governance: a guarantee that a flood of requests,
malicious or accidental, cannot burn through the provider account. The
rule must fit every deployment shape: a single process behind a
Cloudflare Tunnel, and several backend copies behind Cloudflare's proxy
and a load balancer.

The long-lived deployment is a single self-hosted server with one user,
or a handful. The multi-copy shape exists to be load tested, with its
inference mocked, so it spends nothing real. What has to hold is a spend
number the owner chooses, not fairness between many paying users.

The app cannot tell its real clients apart by address. Every request
arrives through proxies, so per-address limits inside the app would rely
on forwarded headers an attacker can influence. Client identity exists
where the connection actually lands: at the Cloudflare edge.

## Decision

### Client identity stays with Cloudflare
The edge knows the real client address. The app never reads forwarded
headers, and no proxy trust is ever configured. A signed-in user is the
only identity the app keys anything on.

### One daily budget governs spend
Each deployment sets one daily spend budget, in configuration. It is
checked when a chat message is submitted, before any Exchange starts,
against all provider-metered spend recorded for the current UTC day,
estimated spend from interrupted Exchanges included. Past it, chat is
refused with a `429` and a `Retry-After` until the day resets. An
Exchange already streaming finishes, and reads are never blocked. A
deployment that sets no budget has no check.

The budget is read from the spend Postgres already records, so it
survives restarts and crashes and holds the same across any number of
backend copies, with nothing extra to run. It is a safety cap on what
the deployment can spend, not a share for each user, which suits a
deployment with few users who all trust each other.

### Request limits are a second layer, placed by deployment shape
Request limits stop runaway volume and keep users from crowding each
other out. The routes that bill outside chat (titling, analysis, model
refresh) carry tighter caps of their own, so no one can spend around
the budget without submitting chat.

* **A single process** limits in the app, with counts in memory. A
  request counts against its signed-in user; requests without a session
  share one bucket. The auth routes share that bucket too, unless the
  deployment's configuration says an edge rule covers them.
* **Several copies** limit at the edge, keyed on the real client
  address, and the app's own limits are off. Counts held in each copy
  would multiply every limit by the number of copies, and a shared
  counter would be one more thing to fail exactly when load is highest.
* **A deployment whose edge cannot express the rule** (a plan that
  cannot scope it to the hostname, or let its own load generators
  through) keeps its door closed instead: an allow-list admits only the
  operator and the generators, and opening it is refused until an edge
  limit is in place.

## Considered
* **Per-address limits in the app**: need trusted forwarded headers.
* **Counters shared through Valkey across copies**: tried, then removed.
  Under load Valkey became unreachable, the counters fell back to each
  process, and every limit loosened by the number of copies at the
  worst moment. The edge never degrades when the backend is slammed.

## Consequences
* **Easier**: spend cannot run past the daily number while chat is
  being submitted, through crashes, restarts and extra copies. Limits
  live where identity is real.
* **Harder**: one deployment is one budget, so a single user can
  exhaust it for everyone on that deployment; per-user limits soften
  that but do not prevent it. A deployment serving many real users
  would need a budget per user, and this decision revisited. Estimated
  spend counts as spent. A
  multi-copy deployment depends on its edge plan for request limits,
  and on its allow-list where the plan falls short.
