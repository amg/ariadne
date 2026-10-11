---
description: Message transformer steps communicate only through the database, never through memory.
---

# ADR 0007: Message transformer steps communicate through the database

## Status
Accepted.

## Context
Before this decision, the live pipeline handed results from one step to the
next in memory: the rewrite step passed its text to the embed step as a
function argument, and the embed step passed its vector to the verdict step
the same way. Two problems followed from that shape.

First, every time a new step had to be slotted between two existing steps,
either the signatures of the steps around it had to change, or the whole
pipeline had to be duplicated.

Second, a failure while running lost everything in between. Since nothing was
persisted between steps, retrying a broken message re-ran every step,
including the steps that had already succeeded.

## Decision
Each transformer step talks to the others only through the database. A step
takes the thread and messages it is running for, reads the rows it needs,
does its work, and writes its result before finishing. Each step writes once,
at the end. Nothing is held in memory from one step to the next; there is no
in-memory handoff.

Steps still run in a fixed order, and the pipeline stops at the first step
that fails. The failure shows up as an exchange error, and when the user
regenerates, the pipeline starts over from the first step. Because each step
checks for its own saved output before doing its work, the steps that already
succeeded are skipped, and only the work that is still missing is done.

The database schema is the contract between steps. The columns a step writes
are introduced in the migration that ships that step; when a step is later
removed, its columns are left in place instead of being dropped by a reverse
migration.

## Consequences
- a step can be added or removed without changing the signature of
  any other step or any in-memory glue. The interface stays the same — a
  thread id, a message id, and a success-or-failure result.
- a failure now leaves a saved stopping point, so recovery
  only repeats the steps that did not finish.
- the vector column was relaxed to allow nulls
  so the rewrite outcome can be saved before the vector exists. As a result,
  the short-circuit that avoids re-embedding must check that a vector is
  actually stored, not just that the embedding model matches.
