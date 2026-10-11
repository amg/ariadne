---
description: aws-prod is production while under test, defined in code in three lifetimes, and torn down after every run.
---

# ADR 0014: aws-prod hosting: production while under test

## Status
Accepted. Builds on the aws-prod tier in ADR 0009, the cross-process
bus in ADR 0012, the optimistic Thread passes in ADR 0011, and the
edge rate limits in ADR 0008.

## Context
aws-prod exists to prove Ari at scale: 100k signed-in users with a tab
open, 20k of them chatting. While it is up and under test, it must be
production in every sense that bears on the result: how it is built,
secured, reached and scaled. It must also cost nothing once it is down,
and every piece of it must be defined in code. It holds no real data.
It lives for one test run at a time, then goes away.

## Decision

### Production, with named exceptions
aws-prod is built to an enterprise production standard. It knowingly
falls short in four places, each because it lives for a single run and
holds nothing worth keeping:

| Exception | Why |
|---|---|
| **Data care**: no backups, no deletion protection, nothing kept between raises | There is no data worth keeping |
| **No database standby** | A failure mid-run is simply run again |
| **No alerting**, cost safety included | aws-prod only exists while the operator watches a run; leftovers are caught by checking the console and billing by hand |
| **Deploys from the operator's machine**, not CI | CI is parked |

Everything else is built as a real production would build it.

### Defined in code, in three lifetimes
AWS is defined with CDK and Cloudflare with Terraform. Three things are
done by hand, all of them account steps rather than infrastructure: the
Cloudflare zone, the account's sign-in setup, and service quota
requests. The zone stays on Cloudflare's Free plan; ADR 0008 records
what that costs the edge.
aws-prod has its own member account under AWS Organizations, so its
costs and its teardown sweep cover nothing else. The operator signs in
through IAM Identity Center with short-lived credentials and only
assumes CDK's deploy roles, which a permissions boundary fences.

| Lifetime | Holds | Exists |
|---|---|---|
| **core** | CDK bootstrap, the vault bucket (run data, Terraform state), image repositories, the secret, the seeded database snapshot, the safety net | Always; a few dollars a month |
| **app** | Network, database, cache, services, load balancer, bastion, DNS record | While aws-prod is up |
| **load** | Load generators in their own network | During a test run |

Every resource is tagged with its lifetime, so a sweep can find
anything that outlived its teardown.

### Compute: ECS Fargate first
Containers run on ECS Fargate. EKS follows as a second phase on the
same images, data, edge and teardown. Fargate comes up in minutes, while
an EKS control plane takes a quarter of an hour. Everything it creates
belongs to CloudFormation, so deleting the stacks deletes everything,
and CDK supports it far better than EKS. The backend API, worker, auth
core, mock inference and nginx run as separate services. Each API task
is one Node process on one vCPU: Fargate charges per vCPU either way,
and ECS already supervises processes. Long-lived connections never move
to new tasks and barely use CPU, so the API is pre-scaled to a run's
target before load starts rather than left to react.

### Edge: Cloudflare's proxy to a locked origin
The operator's configured hostname is proxied by Cloudflare, which owns public
HTTPS and the WAF. It points at a
public load balancer; there is no tunnel. Cloudflare's address ranges
and its default client certificate are shared by every Cloudflare
customer, so another customer's zone could reach an origin that
trusted only those. The origin therefore requires aws-prod's own client
certificate (per-hostname authenticated origin pulls) and refuses any
Host but its own. Cloudflare reaches it over strict TLS with an origin
certificate.

An allow-list admits only the operator and requests carrying the load
generators' per-run secret header, until it is switched off. The load
balancer sends `/api/*` to the backend and everything else to nginx,
which serves static files only.

### Network and data
Two availability zones, the fewest the load balancer, RDS and
ElastiCache accept. There is no NAT gateway, because nothing inside
starts a connection to the internet. AWS services are reached through
VPC endpoints, every image comes from aws-prod's own repositories, and
the mock runs inside the VPC. The database and Valkey sit in isolated
subnets. The only way in for a person is SSM port forwarding through a
bastion with no open ports.

Postgres is RDS at a fixed size on gp3 storage, so I/O is not billed per
request and the hourly cost is known. There is one instance, and all
traffic goes to it, so nothing reads its own write from a lagging
replica. It has no connection proxy: once Thread passes stop holding
connections across inference, the API pools and the workers' working
connections fit the instance's limit. Every raise creates the database
from a seeded snapshot kept in core. It then reads every table once
before load starts, because a restored database fetches each block from
S3 on first read, and a cold start would skew the run. Valkey runs on ElastiCache
Serverless with explicit limits on request rate and storage.

Data is encrypted at rest everywhere with AWS-managed keys and in
transit everywhere with TLS. The audit record is CloudTrail's default
90-day event history. A permanent trail or a customer-managed key can
be added later. Because every raise rebuilds everything, either takes
effect at the next raise with nothing to migrate.

### Sizing is configuration; runs step up
Instance class, task sizes and counts, ceilings and the load profile
live in one configuration file per stage. Runs step up through roughly
10%, 50% and 100% of the target load, and each run's readings set the
next stage's sizes.

### Lifecycle and cost
The operator raises and tears down by hand: one command for everything,
and each step on its own. Terraform removes the Cloudflare pieces, CDK
removes the AWS stacks, and deleting the stacks in the console is the
fallback. Tearing down always beats leaving it idle: idle costs on the
order of a thousand dollars a month, and a rebuild about twenty
minutes.

One silent safety net remains, because a forgotten stack is the most
expensive mistake. A scheduled function in core deletes the app stacks
three hours after a raise and the load stack sixty minutes after it
starts. It does not touch Cloudflare. A Cloudflare record left pointing
at a deleted load balancer serves errors until the next Terraform run.
Nobody else can claim that load balancer's hostname.

AWS billing data lags by hours, so cost is bounded by time instead.
Within the safety net's limits, capacity-priced items are capped by the
stage's configured sizes. Usage-priced items (egress, cache requests,
logs) only accrue under load, which the load stack's own limit bounds.
Each raise records that worst case, and a raise is refused when the
day's recorded worst cases would pass $50.

## Considered
* **EKS first**: slower to raise, and resources Kubernetes creates
  escape CloudFormation and block teardown. Its CDK support is weaker.
  Deferred to a second phase, not rejected.
* **Aurora Serverless v2**: a capacity ceiling looked like a cost
  ceiling, but I/O is billed per request at this write rate, and peak
  compute is an order of magnitude dearer than a fixed instance.
* **RDS Proxy**: only needed while background passes held connections
  across inference. It also pins connections for the auth core's
  prepared statements.
* **NAT gateways**: nothing inside needs to reach the internet. A run
  against an external provider adds one through configuration.
* **Cloudflare Tunnel, as on the home server**: a second load balancer
  would still be needed behind it, and the tunnel would become part of
  what is being measured.
* **S3 and CloudFront for the frontend**: a second CDN behind
  Cloudflare, and the API path would have to be split away from it.
* **Automatic teardown with email notices, and dump and restore of real
  accounts**: designed, then dropped once aws-prod was settled as
  holding no real data and torn down by hand.

## Consequences
* **Easier**: one command per intent, every run starts from the same
  seeded state, and each run's data is kept apart. Adding a trail, a
  customer-managed key or a database standby later is a configuration
  change that lands at the next raise.
* **Harder**: a raise takes about twenty minutes, most of it creating
  the database. The origin lock and allow-list mean aws-prod is
  reachable only through Cloudflare, and only by those allowed.
* **Deferred**: EKS, Graviton images, deploys from CI.
