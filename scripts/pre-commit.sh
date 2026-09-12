#!/bin/bash
# Pre-commit hook to run Biome linting and Tests

echo "🔍 Running Biome checks (Cognitive & Cyclomatic Complexity, Formatting, Linting)..."
npx @biomejs/biome check --staged
if [ $? -ne 0 ]; then
  echo "❌ Biome check failed. Please fix the complexity or linting errors above."
  exit 1
fi

echo "✅ Pre-commit checks passed!"
exit 0
