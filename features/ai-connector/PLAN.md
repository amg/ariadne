# AI Connector Feature Plan

## High-Level Requirements
*   **Integration**: Connect to external AI APIs — DeepInfra via the Vercel AI SDK (resolved in ADR-0002).
*   **MVP scope**: See `MVP.md` in this directory (streaming inference, per-message cost/metadata, cost sidebar). Caching/resilience below are post-MVP.
*   **Streaming Adapter**: Translate AI provider streaming responses into standard SSE format for the frontend.
*   **Caching**: Intercept requests to check for cache hits before calling the provider to reduce costs.
*   **System Prompting**: Inject dynamic context (from Memory feature) into the system prompt securely.
*   **Resilience**: Implement timeouts, retries, and error handling for external API limits.