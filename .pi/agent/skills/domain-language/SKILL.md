---
name: domain-language
description: Enforces linguistic philosophy, naming conventions, and domain vocabulary rules to ensure clear, precise, and unambiguous communication across the codebase.
---

# Domain Language & Naming Philosophy

This skill defines the universal language standards for naming and communication. It acts as the central reference for code quality (naming constraints) and docs quality (commenting and documentation vocabulary).

## 1. Simplicity & Directness
*   **Avoid Dense or Academic Terms**: Use simple, widely understood terms over fuzzy, academic, or complex synonyms.
    *   *Generic Example*: Use `source` instead of `provenance`, `user` instead of `principal`.
*   **Precision over Cleverness**: Never use clever metaphors or abstract math terms when a direct descriptive name exists.

## 2. Naming by Outcome & Result
Name functions and variables for exactly what they represent in the domain or the exact shape they return, not the internal mechanism used to produce them.
*   **Decisions & Values**: Name for the exact shape returned. 
    *   *Generic Example*: Use `needsRefresh` (returns a boolean decision), not `consultCache` (interaction verb hides the return).
*   **Explicitness of State**: If a function can return a null state, reflect that explicitly in the name.
    *   *Generic Example*: `getUserOrNull`, never `buildUser` or `resolveUser`.
*   **Formatting/Constructed Results**: Use adjectives to describe constructed results, not properties.
    *   *Generic Example*: Use `formattedAddress` instead of `addressText`.
*   **Actions & Side-Effects**: Use simple, domain-driven verbs for the result achieved, avoiding implementation jargon.
    *   *Generic Example*: Use `processPayment` (not `enqueueTransaction`—"enqueue" is a mechanism that obscures the domain action).
*   **Mechanism Nouns**: Words like `cache`, `query`, or `parse` are legitimate *only* on the layer that strictly owns that mechanism (e.g., `queryDatabase` in a repository layer, where the mechanism IS the contract).

## 3. Contextual Precision
*   **Attach Context to Stats/Math**: When dealing with statistics, math concepts, or generic data structures, attach them directly to the domain entity they describe.
    *   *Generic Example*: Use `UserSessionStats` instead of just `RollingStats` or `Baseline` to clarify exactly *what* is being measured.

## 4. Documentation Language
*   **Assumed Vocabulary**: Use the project's domain vocabulary (e.g. from its `CONTEXT.md`) naturally as the assumed language of the codebase. Do not explicitly cite markdown files to define or justify terms.
*   **Interface Over Mechanics**: Comments should explain *what* the interface does, completely free from internal mechanics, specific algorithm names, or underlying dependencies.
