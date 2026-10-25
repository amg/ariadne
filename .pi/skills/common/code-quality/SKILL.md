---
name: code-quality
description: Language-independent code principles (simplicity, guard clauses, AHA over DRY, immutability at boundaries, respecting the user's reverts). Load before writing or editing any code.
---

# Code Quality

## 1. Principles
*   **Simplicity First**: Reject cleverness. Code must be readable and declarative.
*   **Complexity**: Limit branching and function scope. In business logic, strictly limit `if`/`else`/`switch` and use guard clauses for early returns.
*   **Naming**: Name things by outcome and result, following the **domain-language** skill.
*   **Strategic Duplication**: Extract core business logic and queries. Allow duplication in UI components and test setup where divergence is expected (AHA > DRY).
*   **Immutable at boundaries**: Treat whatever a function is handed as read-only, and return a new value instead of changing it.
    - A function that adds to its input returns a copy with the addition, and the caller uses that copy from then on.
    - Mutating is fine for values a function creates itself (a running sum, a builder, an accumulator in a hot loop), as long as they never leave it.

## 2. Enforcing Quality

**Comments & Docs**: Writing or modifying comments, docstrings, or project documents requires the **docs-quality** skill.

**Validation**: After any code modification, run the project's validation gate and fix what it reports before presenting the work.

**Architectural Conflicts**: If the gate fails on a rule that guards a design decision (complexity limits, avoiding hasty abstractions), keep the rule active and leave ignore directives out. Pause and ask the user for a decision.

## 3. Human Decisions

If you notice code changes from under you (e.g., you fix something and the user reverts it), DO NOT re-add it back. The user has made a deliberate decision. Pause and ask for clarification.
