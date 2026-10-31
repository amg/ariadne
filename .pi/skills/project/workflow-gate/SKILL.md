---
name: workflow-gate
description: Runs this repo's validation gate (`npm run gate`) after code changes, so type checking, linting, tests, and builds stay green.
---

# Workflow Gate Skill

## When to Activate

After completing ANY code modification that could impact type checking, linting, tests, or build.

## Workflow

1. **Run the gate**: `offload npm run gate`. It runs on the PC when the PC is switched on and reachable, and on cubi otherwise. Where `offload` isn't installed, run `npm run gate`.
2. **If passes**: Report success and declare task complete
3. **If fails**: Fix all errors, re-run gate, repeat until clean

## Rules

1. **NEVER** declare a coding task complete without running the gate
2. **ALWAYS** fix gate errors before presenting work to user
3. **REPORT** gate status explicitly: `**Command:** npm run gate` + `**Result:** ✅ Passed` or `❌ Failed`, and where it ran (offload's first line says)

## What the gate holds

- The `comment-hygiene` check blocks the gross comment violations mechanically. Fix its findings by following the **docs-quality** skill.
- A Biome failure on a design rule follows the **code-quality** skill: ask the user rather than adding a `// biome-ignore`.
- Once the gate passes, the **change-report** skill produces the report.
