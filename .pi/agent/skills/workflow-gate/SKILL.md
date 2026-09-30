---
name: workflow-gate
description: Runs the project's validation gate (`npm run gate`) after code changes.
---

# Workflow Gate Skill

## When to Activate

After completing ANY code modification that could impact type checking, linting, tests, or build.

## Workflow

1. **Run the gate**: `npm run gate`
2. **If passes**: Report success and declare task complete
3. **If fails**: Fix all errors, re-run gate, repeat until clean

## Rules

1. **NEVER** declare a coding task complete without running the gate
2. **ALWAYS** fix gate errors before presenting work to user
3. **REPORT** gate status explicitly: `**Command:** npm run gate` + `**Result:** ✅ Passed` or `❌ Failed`

## Integration

- **code-quality**: Defines quality standards and decision framework
- **db**: Postgres/Kysely conventions — migrations, database testing
- **workflow-gate**: Executes validation gate
- **git-guardian**: Manages commits (requires explicit user confirmation)
