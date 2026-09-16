---
name: code-quality
description: Defines code quality standards, complexity limits, testing governance, and architectural decision framework.
---

# Code Quality and Governance

## 1. Code Quality
*   **Simplicity First**: Reject cleverness. Code must be readable and declarative.
*   **Complexity**: Limit branching and function scope.
    - *Business logic*: Strictly limit `if`/`else`/`switch`. Use guard clauses for early returns.
    - *UI components*: Explicit `switch` cases for visual variants and divergent markup. Object maps only for simple scaling attributes (e.g., `size`).
*   **Strategic Duplication**: Extract core business logic and queries. Allow duplication in UI components and test setup where divergence is expected (AHA > DRY).

## 2. Testing Governance
*   **No Database Mocks**: NEVER mock the database (Kysely/Postgres).
*   **Real DB Testing**: All database/repository tests run against real PostgreSQL (Testcontainers).
*   **Test Isolation**: Wrap tests in transactions with `ROLLBACK`, or truncate tables.
*   **Permitted Mocks**: ONLY at system boundaries for external network calls (e.g., DeepInfra API).

## 3. Enforcing Quality

**Validation**: After any code modification, activate **workflow-gate** to run `npm run gate`.

**Architectural Conflicts**: If the gate fails due to architectural decisions (complexity limits, avoiding hasty abstractions), DO NOT bypass with ignore directives (`// biome-ignore`). Pause and ask the user for a decision.

## 4. Human Decisions

If you notice code changes from under you (e.g., you fix something and the user reverts it), DO NOT re-add it back. The user has made a deliberate decision. Pause and ask for clarification.
