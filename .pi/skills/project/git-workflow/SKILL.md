---
name: git-workflow
description: Branching and committing in this repo (a feature branch from spec inception, Lefthook hooks never bypassed). Load before cutting a branch or committing.
---

# Git Workflow

Merging and squashing follow the **git-merging** skill.

## 1. Branch Hygiene
*   **Branch at spec inception**: When asked to work on a feature and handoff or spec documentation starts being produced, cut a feature branch (or confirm one exists) before writing anything. Announce the branch name in the same turn.
*   **Everything rides the branch**: All subsequent changes — spec, tickets, docs, code, commits — land on the branch. Master stays untouched until the work is accepted.
*   **Why**: The work folds cleanly onto master when done, and if the direction proves wrong, the whole line drops with one rewind instead of surgical cleanup.

## 2. Never bypass commit hooks
*  **Do not bypass hooks**: The project uses Lefthook to run a comprehensive test suite on every commit. You must never bypass these hooks (e.g., with `--no-verify`), as they are essential for maintaining code quality and integrity.
*  **When in doubt ask human**
