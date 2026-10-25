---
description: The wire contract and the app record shapes live once in a shared library that every app reads.
---

# ADR 0015: One Shared API Contract

## Status

Accepted.

## Context

Three apps speak to each other through the same words. The frontend calls
every endpoint and reads the push stream. The load harness drives the same
endpoints as its virtual users and reads the backend's app records back
out of a run. Each app used to keep its own copy of the shapes: the
frontend its hand-written request and reply types, the generator its own
Thread shape and its own paths, the backend its own record types. A copy
that drifts makes the harness measure the wrong thing silently, and
fidelity is the harness's whole value: it must speak exactly what a
browser speaks and read exactly what the backend writes.

## Decision

- The contract of the wire — each endpoint's path, parameters, body and
  replies by status, the entities they move, and the app records the
  backend logs — lives once, in the shared `lib` workspace.
- Every app reads it; none keeps a copy of its own. The lib reads nothing
  from any app, so it stays a contract and not a shared code bin.
- One schema serves both ends of a call: a value reads one way on the wire
  and another as the backend holds it.
- Inside the contract, schemas sit by the route they serve, so a route's
  schemas are found where the route is; what routes share sits by concept.

## Considered

- **tRPC** — the ready-made shape of this idea. Rejected: the API keeps
  plain HTTP endpoints and SSE streams, and a framework buys nothing the
  schemas do not already give.
- **An OpenAPI spec with generated clients** — pays off with outside
  consumers in other languages. There are none, and the schemas already
  validate both ends of every call.
- **A copy per app** — what was there. Cheap until it drifts, and the
  harness must not drift.

## Consequences

- **Easier**: one definition to change; the harness mirrors the app by
  construction; the backend's route types check against the same schemas
  the client reads.
- **Harder**: a change to the contract touches every app in one move, so
  the wire and the apps move together.
