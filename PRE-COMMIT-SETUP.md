# Pre-Commit Validation Setup

## Overview

This project uses **lefthook** to run validations on every pre-commit. The setup ensures both frontend and backend code passes all checks before commits are allowed.

## Architecture

```
alex-chat-bot/ (root workspace)
├── lefthook.yml              # Pre-commit hook configuration
├── package.json              # Root "gate" command
├── frontend/                 # Frontend workspace
│   ├── package.json
│   └── src/
└── backend/                  # Backend workspace
    ├── package.json
    ├── scripts/validate-env-usage.ts
    └── src/
```

## Pre-Commit Flow

When you run `git commit`:

```bash
git commit
  ↓
lefthook pre-commit hook (lefthook.yml)
  ↓
┌─────────────────────────────────────┐
│ 1. backend-validate (fast check)    │
│    npm run validate:env             │
│    - Checks process.env usage       │
│    - Only in backend/src/           │
└─────────────────────────────────────┘
  ↓
┌─────────────────────────────────────┐
│ 2. gate (full validation suite)     │
│    npm run gate                     │
│    ├─ npm run checks                │
│    │  ├─ typecheck (both)           │
│    │  ├─ lint (biome)               │
│    │  ├─ enforce-cn                 │
│    │  ├─ audit:deps (knip)          │
│    │  ├─ audit:boundaries (depcruise)│
│    │  ├─ audit:env                  │
│    │  └─ audit:docker               │
│    ├─ npm run test (both)           │
│    └─ npm run build:frontend        │
└─────────────────────────────────────┘
  ↓
✅ Commit allowed (or ❌ blocked)
```

## Adding New Validations

### Backend-Specific Rules

Add to `backend/package.json`:

```json
{
  "scripts": {
    "validate:env": "tsx scripts/validate-env-usage.ts",
    "validate:custom": "tsx scripts/your-validation.ts"
  }
}
```

Add to `lefthook.yml`:

```yaml
pre-commit:
  commands:
    backend-custom:
      root: "backend/"
      run: npm run validate:custom
      skip: [merge, rebase]
```

### Frontend-Specific Rules

Add to `frontend/package.json`:

```json
{
  "scripts": {
    "validate:custom": "tsx scripts/your-validation.ts"
  }
}
```

Add to `lefthook.yml`:

```yaml
pre-commit:
  commands:
    frontend-custom:
      root: "frontend/"
      run: npm run validate:custom
      skip: [merge, rebase]
```

### Root-Level (Both Workspaces)

Add to root `package.json`:

```json
{
  "scripts": {
    "validate:all": "npm run validate:env --workspace=backend && npm run validate:custom --workspace=frontend"
  }
}
```

Add to `lefthook.yml`:

```yaml
pre-commit:
  commands:
    validate-all:
      run: npm run validate:all
      skip: [merge, rebase]
```

## Skipping Pre-Commit

For emergency commits (not recommended):

```bash
git commit --no-verify
```

⚠️ **Warning**: This bypasses all validations. Only use for urgent fixes.

## CI/CD Integration

The same validations run in CI:

```yaml
# .github/workflows/ci.yml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run gate  # Same as pre-commit
```

## Performance Tips

1. **Fast checks first**: Run quick validations (like env checks) before slow ones (tests, builds)
2. **Skip on merge/rebase**: Use `skip: [merge, rebase]` to avoid blocking merges
3. **Parallel execution**: Lefthook can run independent checks in parallel
4. **Cached results**: Consider caching for expensive operations

## Troubleshooting

### Hook Not Running

```bash
# Reinstall hooks
npx lefthook install

# Check if lefthook is installed
npx lefthook version
```

### Validation Fails

```bash
# Run specific validation manually
cd backend
npm run validate:env

# Run full gate
npm run gate

# Fix and retry
npm run lint:fix  # Auto-fix biome issues
```

### See What Will Run

```bash
# Dry run (see commands without executing)
npx lefthook run pre-commit --dry-run
```

## Other Projects

For other projects in your workspace (alex-agent, alex-libre-chat, etc.):

1. Copy the validation scripts to each project
2. Add lefthook to each project's `package.json`:
   ```json
   {
     "devDependencies": {
       "lefthook": "^2.1.14"
     },
     "scripts": {
       "prepare": "lefthook install"
     }
   }
   ```
3. Create `lefthook.yml` with project-specific validations
4. Run `npm install` and `npx lefthook install`

Each project maintains its own validation rules based on its architecture.
