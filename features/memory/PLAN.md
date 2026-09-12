# Memory & Storage Feature Plan

## High-Level Requirements
*   **Database**: PostgreSQL for all relational and vector storage.
*   **Raw Messages**: Append-only storage for all user and assistant messages linked to a specific chat thread.
*   **Shared Factual Memory (RAG)**:
    *   Extract factual information about the user asynchronously (e.g., "User lives in New York").
    *   Embed and store facts globally per user (shared across all threads) using `pgvector`.
    *   Implement **Retrieval-Augmented Generation (RAG)**: retrieve relevant facts based on current conversation context and inject them into the system prompt.
*   **Scope**: Database schemas, ORM/query requirements, and fact extraction logic.