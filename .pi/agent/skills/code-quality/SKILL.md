# Code Quality and Governance

## Overview
This skill acts as the agent's internal operating system for writing code, enforcing strict hygiene, readability, and a "real-evidence" testing posture.

## 1. Code Quality
*   **Simplicity First**: Reject cleverness. Code must be highly readable and declarative.
*   **Cognitive Complexity**: Strictly limit branching (`if`/`else`/`switch`). Use early returns (guard clauses) to flatten nested logic.
*   **Cyclomatic Complexity**: Functions must do one thing. If a function has too many paths, break it down. 
*   **Strategic Duplication**: Prefer extraction for core business logic and database queries. However, **allow duplication** in UI components (where visual/behavioral divergence is likely) and test setup data (where coupling tests to shared factories often creates brittle dependencies). "AHA" (Avoid Hasty Abstractions) is better than "DRY" (Don't Repeat Yourself) when divergence is expected.
*   **UI Variants Exception**: The strict anti-branching rule applies to business logic. For UI components, explicit `switch` cases are preferred for returning markup or distinct class clusters (variants). This ensures changes to one visual variant do not accidentally break another. Simple scaling attributes (like `size`) may use an object map, but visual styles and divergent markup should use explicit `switch` branching.

## 2. Testing Governance
*   **No Database Mocks**: NEVER mock the database (Kysely/Postgres) in tests. 
*   **Real DB Testing**: All database and repository tests must run against a real PostgreSQL instance (via Testcontainers).
*   **Test Isolation**: Ensure database tests are isolated by wrapping test cases in transactions and issuing a `ROLLBACK` after the test, or by completely truncating tables.
*   **Permitted Mocks**: Mocks are ONLY allowed at the absolute system boundaries for external network calls (e.g., the DeepInfra AI API endpoint).

## 3. Workflow Discipline
*   **Check Before Committing**: The agent must run the linter (Biome) and the test suite (Vitest) to gather evidence that the code works BEFORE asking the user to commit.
*   **Architectural Conflicts**: If you face a conflicted choice where instructions require keeping the architecture a certain way (e.g., limits on complexity or avoiding hasty abstractions) but CI/linter checks fail as a result, DO NOT bypass the checks with ignore directives (like `// biome-ignore`). You must pause and reach out to the human for a decision.