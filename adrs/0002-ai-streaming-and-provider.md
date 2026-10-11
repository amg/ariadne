---
description: Inference goes through the Vercel AI SDK; provider and model are chosen per task in configuration, the mock stands in by configuration, and the embedding model is pinned.
---

# ADR 0002: AI Provider and Streaming Framework

## Status
Accepted.

## Context
The app sends prompts to an external inference provider and streams the
replies to the chat UI over Server-Sent Events. Hand-written SSE parsing
and chunk handling is tedious and easy to get wrong, especially around
mid-stream network drops.

Inference may move between providers, and load tests replace it with a
mock. Changing provider must be a configuration change and nothing more.

## Decision

### One SDK in front of every provider
Inference goes through the **Vercel AI SDK**, which handles streaming on
the backend and the chat state on the frontend. Each provider is reached
through its official AI SDK provider package, so the code beneath speaks
only the SDK. Providers are reached over the OpenAI-compatible API, and
the mock inference server speaks the same wire format, so it stands in
for a provider by configuration, as it does for load tests.

### Provider and model are chosen per task
Each task (chat, titling, rewrite, judge, memory) names its model, and
its provider, in configuration. Several providers can be configured at
once, and the mock is simply one more of them.

### The embedding model is pinned
The embedding model is the exception: its identity is fixed in code, and
only the provider serving it may change. Stored vectors and the drift
calibration are measurements in that one model's space, so a different
embedding model is a data migration (re-embed, recalibrate), never a
configuration flip. The pinned model is open-weight so that several
providers can serve it. A new provider for it is accepted only once its
vectors match the current provider's on a reference set, because the
same weights at a different precision can drift.

## Considered
* **Hand-rolled SSE parsing**: the bugs the SDK already solves.
* **A generic OpenAI adapter pointed at the provider's URL**: works, but
  loses the provider's own typing and defaults.
* **The provider's hosted AI-SDK-shaped endpoint**: a parallel surface
  that reports less usage detail (no cost estimate, no cache details)
  than the OpenAI-compatible API the provider package already speaks.

## Consequences
* **Easier**: no custom streaming code on either side; moving a task to
  another provider touches configuration only.
* **Harder**: the app depends on the AI SDK ecosystem. The choice of
  embedding provider is constrained by who hosts the pinned model, not
  by preference: a provider that does not host it can take over the
  generating tasks only, while embeddings stay with one that does, or
  run on our own hardware.
