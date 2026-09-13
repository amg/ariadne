#!/bin/bash
# Pre-commit hook to run Biome linting and Tests

# Skip when nothing in Biome's scope is staged (e.g. docs-only commits).
STAGED_SUPPORTED=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|css)$' || true)
if [ -z "$STAGED_SUPPORTED" ]; then
  echo "✅ No Biome-supported files staged — skipping Biome check."
  exit 0
fi

echo "🔍 Running Biome checks (Cognitive & Cyclomatic Complexity, Formatting, Linting)..."
npx @biomejs/biome check --staged
if [ $? -ne 0 ]; then
  echo "❌ Biome check failed. Please fix the complexity or linting errors above."
  exit 1
fi

echo "✅ Pre-commit checks passed!"
exit 0
