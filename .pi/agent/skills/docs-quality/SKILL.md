---
name: docs-quality
description: Enforces strict rules for code comments and project documentation to prevent bloat, drift, and noise.
---

# Code Quality: Documentation & Comments

This skill must be followed during every implementation loop, code modification, or documentation update. It enforces strict standards for what goes into comments and external documentation.

## 1. Code Comments
- **Describe the Interface**: Comments should explain *what* the interface does, not where it is used, why it was built, or who uses it.
- **Explain Non-Obvious Behavior**: Only write comments for behavior that is truly non-obvious. 
- **One Idea per Sentence**: Give each idea in a comment its own sentence, ordered cause before effect. Fusing several steps into one clause forces pronoun bridges whose referent shifts mid-sentence and hides the actor of each action, leaving the reader to reconstruct who does what to what. Repeat the noun when two things compete for the same pronoun, and name who acts in every sentence.
- **NO Implementation Details in JSDocs**: Interface comments (JSDocs, function headers) must focus purely on parameters, return values, and consumer-facing behavior. They must NEVER leak internal mechanics, specific algorithm names, or underlying dependencies (e.g., avoid mentioning `aiService` or `PageHinkley` inside a top-level service comment).
- **NO Narration or Detective Work**: Do not write comments that narrate the history of the code, how it was written, or where the functionality comes from.
- **NO External References**: Never mention work tickets, Jira issues, or tracking numbers (e.g., avoid "ticket 42", "JIRA-107").
- **NO ADR References in Code**: Do not reference ADRs (Architecture Decision Records) or other external docs in code comments (e.g., avoid "see ADR 12").
- **NO Documentation Citations**: Do not explicitly cite project markdown files (e.g., "see CONTEXT.md", "Vocabulary per MVP.md") to define or justify terms in code. Use the project's domain vocabulary naturally as the assumed language of the codebase.

## 2. Project Documentation & Knowledge Base
- **High-Level Context Only**: Documentation must stick to what the project does at a very high level.
- **NO Implementation Details**: Documentation must *never* go into implementation specifics. Encoding code implementation details into docs causes immediate drift as the code changes.
- **Core Project Knowledge**: Project knowledge consists strictly of:
  1. `Context.md` (Domain terms)
  2. ADRs (Architecture Decision Records)
  3. The Code itself
- **Extra Documentation (`docs/`)**: Additional documents should reside in a `docs/` folder. They should be pointed to and only read when explicitly required. They must be kept in sync only at a high level.

## 3. High level document Guidelines
- **Theory & Math Docs**: Should strictly describe how the approach works. They must be math-centric but human-readable in a story form, completely free from code bloat or implementation specifics.

## Enforcement Loop
Before completing any task that involves writing code or updating documents, you must verify that your changes comply with these rules. Proactively remove any violating comments (like ticket numbers or narration) or implementation details in documentation as you encounter them in your work.
