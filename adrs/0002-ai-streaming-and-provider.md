# ADR 0002: AI Provider and Streaming Framework

## Status
Accepted, amended 2026 (see Amendment 1 below)

## Context
We need to connect to an external AI inference provider, generate responses, and stream them in real-time to the frontend chat UI using Server-Sent Events (SSE). Writing manual SSE parsing and chunk management can be tedious and prone to edge-case bugs (e.g., handling mid-stream network drops).

## Decision
*   **AI Provider**: DeepInfra.
*   **Integration Standard**: OpenAI-compatible API format (DeepInfra supports this natively).
*   **Streaming Framework**: Vercel AI SDK (`ai` and `@ai-sdk/openai`).

## Consequences
*   **Easier**: DeepInfra provides an OpenAI-compatible endpoint. By using the Vercel AI SDK, we can plug in the DeepInfra base URL and use standard OpenAI adapters. The SDK handles all the heavy lifting for SSE stream parsing, both on the backend (`streamText`) and the frontend (`useChat`). We do not need to build custom streaming adapters.
*   **Harder**: We add a dependency on the Vercel AI SDK ecosystem, but it is highly modular and standard in the JS/TS ecosystem.

## Amendment 1 (2026): provider package
The Decision above named the generic `@ai-sdk/openai` adapter with a manually
configured DeepInfra base URL. DeepInfra has since published an official AI SDK
provider package; we pivot to it.

**Used**
*   `ai` + `@ai-sdk/deepinfra` (`createDeepInfra({ apiKey })`, then
    `deepinfra(modelId)` in `streamText`/`generateText`). Same Vercel AI SDK
    mechanics as before; the provider integration is now first-class rather
    than assembled by hand.

**Rejected**
*   `@ai-sdk/openai` with manual base URL — works, but no DeepInfra-specific
    typing/defaults. The mock-server escape hatch it was held back for ended
    up riding the provider package itself: `createDeepInfra({ baseURL })`
    with `MOCK_AI_BASE_URL`, so `@ai-sdk/openai` never entered the code.
*   DeepInfra's hosted AI-SDK-style endpoint (`AISDKIn`/`AISDKOut` schemas) —
    parallel surface with a slimmer `UsageInfo` (no `estimated_cost`, no cache
    details); our provider package already speaks the OpenAI-compatible wire
    format directly, so no reason to route through it.
*   Hand-rolled SSE parsing — unchanged rejection from the original Context.

## Consequences (Amendment 1)
*   Plan/implementation docs (`features/ai-connector/MVP.md`) now specify
    `@ai-sdk/deepinfra`; this amendment supersedes the package named in the
    original Decision. `useChat` on the frontend is unaffected.