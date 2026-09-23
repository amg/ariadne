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
*   **Language & Naming**: Naming must strictly follow the `domain-language` skill. Name things by outcome and result, not by mechanism. Be explicit about nullability.
*   **Strategic Duplication**: Extract core business logic and queries. Allow duplication in UI components and test setup where divergence is expected (AHA > DRY).

## 2. Testing Governance
*   **No Database Mocks**: NEVER mock the database (Kysely/Postgres).
*   **Real DB Testing**: All database/repository tests run against real PostgreSQL (Testcontainers).
*   **Test Isolation**: Wrap tests in transactions with `ROLLBACK`, or truncate tables.
*   **Permitted Mocks**: ONLY at system boundaries for external network calls (e.g., DeepInfra API).

## 3. Enforcing Quality

**Comments & Docs**: Writing or modifying comments, JSDoc, or project documents requires the **docs-quality** skill. The `comment-hygiene` gate check blocks the gross violation classes mechanically; the skill carries the rest.

**Validation**: After any code modification, activate **workflow-gate** to run `npm run gate`.

**Architectural Conflicts**: If the gate fails due to architectural decisions (complexity limits, avoiding hasty abstractions), DO NOT bypass with ignore directives (`// biome-ignore`). Pause and ask the user for a decision.

## 4. Human Decisions

If you notice code changes from under you (e.g., you fix something and the user reverts it), DO NOT re-add it back. The user has made a deliberate decision. Pause and ask for clarification.

## 5. Branch Hygiene

*   **Branch at spec inception**: When asked to work on a feature and handoff or spec documentation starts being produced, cut a feature branch (or confirm one exists) before writing anything. Announce the branch name in the same turn.
*   **Everything rides the branch**: All subsequent changes — spec, tickets, docs, code, commits — land on the branch. Master stays untouched until the work is accepted.
*   **Why**: The work folds cleanly onto master when done, and if the direction proves wrong, the whole line drops with one rewind instead of surgical cleanup.
