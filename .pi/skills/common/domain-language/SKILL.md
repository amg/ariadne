---
name: domain-language
description: Enforces linguistic philosophy, naming conventions, and domain vocabulary rules to ensure clear, precise, and unambiguous communication across the codebase.
---

# Domain Language & Naming Philosophy

This skill defines the universal language standards for naming and communication. 

## 1. Simplicity & Directness
*   **Avoid Dense or Academic Terms**: Use simple, widely understood terms over fuzzy, academic, or complex synonyms.
    *   *Generic Example*: Use `source` instead of `provenance`, `user` instead of `principal`.
*   **Precision over Cleverness**: Never use clever metaphors or abstract math terms when a direct descriptive name exists.

## 2. Naming by Outcome & Result
Name functions and variables for exactly what they represent in the domain or the exact shape they return, not the internal mechanism used to produce them.
*   **Decisions & Values**: Name for the exact shape returned. 
    *   *Generic Example*: Use `needsRefresh` (returns a boolean decision), not `consultCache` (interaction verb hides the return).
*   **Formatting/Constructed Results**: Use adjectives to describe constructed results, not properties.
    *   *Generic Example*: Use `formattedAddress` instead of `addressText`.
*   **Actions & Side-Effects**: Use simple, domain-driven verbs for the result achieved, avoiding implementation jargon.
    *   *Generic Example*: Use `processPayment` (not `enqueueTransaction`—"enqueue" is a mechanism that obscures the domain action).
*   **Mechanism Nouns**: Words like `cache`, `query`, or `parse` are legitimate *only* on the layer that strictly owns that mechanism (e.g., `queryDatabase` in a repository layer, where the mechanism IS the contract).

## 3. Contextual Precision
*   **Attach Context to Stats/Math**: When dealing with statistics, math concepts, or generic data structures, attach them directly to the domain entity they describe.
    *   *Generic Example*: Use `UserSessionStats` instead of just `RollingStats` or `Baseline` to clarify exactly *what* is being measured.
*   **Maths Names Stay Inside the Maths Module**: A module that implements a formula may use the formula's own names and symbols inside it (`lambda`, `mu`, `sigma`). Its exported contract uses domain names, and each field's doc comment opens with the symbol, so a reader can go from the contract to the formula and its write-up. The module maps the domain names onto the maths names in one place.
    *   *Generic Example*: Export `retryBackoffFactor` with the doc `/** α: how much each retry's wait grows. */`; inside the backoff function, name it `alpha`.

## 4. Plain Language in Documentation
*   **Simple Words Over Elaborate Ones**: Use everyday words in comments and documentation. Avoid academic or literary terms that sound clever but slow readers down.
    *   *Use*: "work that must finish even after a request ends", "the bus is only for convenience", "replaced jobs"
    *   *Avoid*: "work that must outlive a request", "the bus is a courtesy", "superseded jobs"
*   **Direct Phrasing**: Say what something does in the simplest way possible. If a 5-year-old wouldn't understand the word, find a simpler one.
    *   *Use*: "checks the current state before acting", "failed with recoverable errors"
    *   *Avoid*: "idempotent by state", "died of recoverable failures"
*   **Code is Documentation**: Comments and docs explain *why* at a high level. The code itself explains *how*. Don't repeat implementation details in prose.

