# Validation Scripts

This directory contains custom validation scripts that enforce code quality rules.

## Available Scripts

### validate-env-usage.ts

Ensures all environment variable access goes through the centralized config.

```bash
npm run validate:env
```

## Adding New Rules

The validation script uses a pluggable rule pattern. To add a new rule:

1. Open `scripts/validate-env-usage.ts`
2. Add a new rule object to the `RULES` array
3. Each rule must define:

```typescript
{
  name: 'rule-name',
  description: 'Brief description of what the rule checks',
  why: `
    Multi-line explanation of why this rule exists.
    This helps developers understand the rationale.
    Keep it concise but informative.
  `,
  skip: [
    'patterns',
    'to-skip',
  ],
  check: (filePath, content, relativePath) => {
    const violations: Violation[] = [];
    const lines = content.split('\n');
    
    // Your validation logic here
    // Return array of violations with file, line, and text
    
    return violations;
  },
  fix: 'Clear instruction on how to fix violations',
}
```

### Rule Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | ✅ | Unique identifier for the rule |
| `description` | `string` | ✅ | One-line description |
| `why` | `string` | ✅ | Rationale - why this rule exists |
| `skip` | `string[]` | ❌ | Patterns to skip (file extensions, directories, exact paths) |
| `check` | `function` | ✅ | Validation logic |
| `fix` | `string` | ✅ | How to fix violations |

### Skip Patterns

The `skip` array supports:
- `.ext` - Skip files with this extension (e.g., `.test.ts`)
- `/dir/` - Skip files in this directory
- `filename.ts` - Skip exact filename
- `pattern` - Skip if path contains this substring

### Example Rules

**Example 1: Forbid console.log in production code**
```typescript
{
  name: 'no-console-log',
  description: 'console.log should not be used in production code',
  why: `
    console.log statements should be removed before merging.
    Use the centralized logger instead for proper formatting
    and log levels.
  `,
  skip: ['.test.ts', '/test/'],
  check: (filePath, content, relativePath) => {
    const violations: Violation[] = [];
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      if (/console\.(log|warn|error|info|debug)/.test(lines[i]!)) {
        violations.push({
          file: relativePath,
          line: i + 1,
          text: lines[i]!.trim(),
        });
      }
    }
    
    return violations;
  },
  fix: 'Remove console statements or use the centralized logger',
}
```

**Example 2: Require JSDoc on exported functions**
```typescript
{
  name: 'require-jsdoc-exports',
  description: 'Exported functions must have JSDoc comments',
  why: `
    Public API functions should be documented for maintainability
    and to help other developers understand the code.
  `,
  skip: ['.test.ts'],
  check: (filePath, content, relativePath) => {
    const violations: Violation[] = [];
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Check for exported functions without JSDoc
      if (/^export\s+(async\s+)?function/.test(line)) {
        // Check if previous line has JSDoc end
        const prevLine = lines[i - 1];
        if (!prevLine || !prevLine.trim().endsWith('*/')) {
          violations.push({
            file: relativePath,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
    
    return violations;
  },
  fix: 'Add JSDoc comment above the exported function',
}
```

## Running Validation

### Manually
```bash
npm run validate:env
```

### In CI/CD
Add to your CI pipeline to catch violations before merging.

### Pre-commit Hook
Consider adding to `.husky/pre-commit`:
```bash
#!/bin/sh
npm run validate:env
```

## Exit Codes

- `0` - All rules passed
- `1` - One or more rules failed

## Output Format

The script provides:
- ✅ Pass/fail status for each rule
- ❌ Detailed violations with file:line references
- 💡 Fix instructions for each failed rule
- 📖 Rationale explaining why the rule exists
