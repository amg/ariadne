# ADR 0003: Memory and RAG Strategy (pgvector)

## Status
Accepted. The extraction pipeline and the read side are decided and built
in ADR 0010: Facts are captured at segment close and fresh Threads are
seeded with a snapshot. Per-turn retrieval by query similarity is still to
come.

## Context
The chatbot needs to remember factual information about a user across multiple sessions (e.g., preferences, personal facts). We evaluated standard relational databases vs. vector search, as well as whether to adopt the Model Context Protocol (MCP) for extensible data fetching.

## Decision
*   **Memory Architecture**: We will use **Retrieval-Augmented Generation (RAG)**.
*   **Storage**: PostgreSQL with the `pgvector` extension.
*   **Mechanism**: 
    1. Facts are extracted from chats asynchronously.
    2. Facts are converted into vector embeddings.
    3. During a chat, the user's query is embedded, and relevant facts are retrieved via cosine similarity search in Kysely.
    4. Retrieved facts are injected into the system prompt.
*   **MCP**: Skipped (Out of Scope). We do not need the Model Context Protocol right now, as our data sources are internal (just our Postgres database) and we are not currently building external tool integrations.

## Consequences
*   **Easier**: Keeps the architecture self-contained within our Postgres database. Avoids the overhead of implementing an MCP client/server architecture.
*   **Harder**: Requires an embedding model (either hosted locally or via DeepInfra) to convert text into vectors, and requires writing raw SQL or Kysely helpers to perform `pgvector` similarity searches (e.g., `<->` operator).