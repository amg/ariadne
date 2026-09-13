#!/bin/bash
# Pre-commit gate: stages run only when staged files make them relevant,
# so docs-only / hook-only commits pass cleanly.
#   Biome (lint, format, complexity) → backend (tsc + vitest) → frontend (tsc -b + vite build)

STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
if [ -z "$STAGED" ]; then
  echo "✅ No staged changes — skipping pre-commit checks."
  exit 0
fi

# --- Biome (lint, formatting, cognitive & cyclomatic complexity) -------------
CODE_STAGED=$(echo "$STAGED" | grep -E '^(backend|frontend)/' | grep -E '\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|css)$' || true)
if [ -n "$CODE_STAGED" ]; then
  echo "🔍 Biome checks on staged files..."
  if ! npx @biomejs/biome check --staged; then
    echo "❌ Biome check failed — fix the complexity/format/lint errors above."
    exit 1
  fi
fi

# --- Backend: typecheck + test suite ----------------------------------------
BACKEND_STAGED=$(echo "$STAGED" | grep -E '^backend/|^package(-lock)?\.json$' || true)
if [ -n "$BACKEND_STAGED" ]; then
  echo "🧪 Backend: tsc --noEmit + vitest run..."
  if ! (cd backend && npm run typecheck && npx vitest run); then
    echo "❌ Backend gate failed (typecheck or tests)."
    exit 1
  fi
fi

# --- Frontend: typecheck + build ---------------------------------------------
FRONTEND_STAGED=$(echo "$STAGED" | grep -E '^frontend/|^package(-lock)?\.json$' || true)
if [ -n "$FRONTEND_STAGED" ]; then
  echo "🧪 Frontend: tsc -b + vite build..."
  if ! (cd frontend && npm run build); then
    echo "❌ Frontend gate failed (typecheck or build)."
    exit 1
  fi
fi

echo "✅ Pre-commit checks passed!"
exit 0
