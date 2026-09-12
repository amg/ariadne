# ADR 0002: AI Provider and Streaming Framework

## Status
Accepted

## Context
We need to connect to an external AI inference provider, generate responses, and stream them in real-time to the frontend chat UI using Server-Sent Events (SSE). Writing manual SSE parsing and chunk management can be tedious and prone to edge-case bugs (e.g., handling mid-stream network drops).

## Decision
*   **AI Provider**: DeepInfra.
*   **Integration Standard**: OpenAI-compatible API format (DeepInfra supports this natively).
*   **Streaming Framework**: Vercel AI SDK (`ai` and `@ai-sdk/openai`).

## Consequences
*   **Easier**: DeepInfra provides an OpenAI-compatible endpoint. By using the Vercel AI SDK, we can plug in the DeepInfra base URL and use standard OpenAI adapters. The SDK handles all the heavy lifting for SSE stream parsing, both on the backend (`streamText`) and the frontend (`useChat`). We do not need to build custom streaming adapters.
*   **Harder**: We add a dependency on the Vercel AI SDK ecosystem, but it is highly modular and standard in the JS/TS ecosystem.