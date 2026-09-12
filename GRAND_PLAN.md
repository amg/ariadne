# End-to-End Chat Bot Grand Plan

## Core Objective
A production-ready, Dockerized chatbot application emphasizing real-time streaming, contextual memory, cost observability, and multi-user support. Hosted on Cubi, with externalized AI inference.

## Main Stack Selection
*   **Frontend**: React (with React Router), TypeScript.
*   **Backend / API**: Node.js (Fastify/Express) using TypeScript.
*   **Database**: PostgreSQL.
*   **Query Builder**: Kysely (Strict type-safe SQL query builder, replacing heavy ORMs).
*   **AI Inference**: DeepInfra (using OpenAI-compatible endpoints).
*   **AI Streaming Framework**: Vercel AI SDK.
*   **Infrastructure**: Docker & Docker Compose (Cubi hosting).

## High-Level Requirements
1.  **Chat Interface**: Real-time streaming via Server-Sent Events (SSE).
2.  **State Management**: Multiple threads/sessions per user.
3.  **Factual Memory**: Long-term memory extraction to recall user facts across sessions.
4.  **Observability**: Track token usage, calculate cost per message, and monitor AI cache hits.
5.  **Storage**: Persist all raw messages alongside extracted factual context.
6.  **Compactisation (Optional)**: Token threshold management and context summarization.
7.  **Authentication (Optional)**: Multi-user support with secure session/refresh token flows and CSRF protection.

## Architecture Guidelines
*   **ADRs (Architecture Decision Records)**: All major technical decisions reside in `/adrs`.
*   **Feature Modularity**: Each feature domain has its own directory in `/features` with a high-level `PLAN.md`.
*   **Keep it High-Level**: Plans should focus on requirements, interfaces, and constraints rather than implementation details.