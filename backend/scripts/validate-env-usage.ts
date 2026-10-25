#!/usr/bin/env tsx
/**
 * Code validation script with pluggable rules.
 *
 * Each rule defines:
 * - name: Identifier for the rule
 * - description: Human-readable explanation
 * - why: Why this rule exists (rationale)
 * - check: Function that returns violations
 * - fix: Suggested fix message
 *
 * Add new rules by adding to the RULES array below.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Rule Definitions
// ─────────────────────────────────────────────────────────────────────────────

interface Rule {
  /** Rule identifier */
  name: string;
  /** What the rule checks */
  description: string;
  /** Why this rule exists - the rationale */
  why: string;
  /** Files to skip (relative paths or patterns) */
  skip?: string[];
  /** Check function - returns violations */
  check: (file: { content: string; relativePath: string }) => Violation[];
  /** How to fix violations */
  fix: string;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

const RULES: Rule[] = [
  {
    name: 'no-process-env-outside-config',
    description: 'process.env should only be used in src/config/env.ts',
    why: `
      All environment variable access must go through the centralized config.
      This ensures:
      - Single source of truth for all defaults
      - Type-safe access throughout the codebase
      - Easy testing (override process.env before importing config)
      - No scattered defaults across the codebase
    `,
    skip: [
      'src/config/env.ts', // This is where process.env belongs
      'src/config/dotenv.ts', // Picks the env file to load, before env.ts can read anything
      '.test.ts', // Tests can set process.env
      '/test/', // Test files
      '/mock/', // Mock servers need process.env
      'validate-env-usage.ts', // This script itself
    ],
    check: ({ content, relativePath }) => {
      const violations: Violation[] = [];
      const lines = content.split('\n');
      const processEnvRegex = /process\.env/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
          continue;
        }

        if (processEnvRegex.test(line)) {
          violations.push({
            file: relativePath,
            line: i + 1,
            text: trimmed,
          });
        }
      }

      return violations;
    },
    fix: 'Use \'import { env } from "@config/env"\' instead of direct process.env access',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Add new rules here:
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Example rule template:
  // {
  //   name: 'rule-name',
  //   description: 'What this rule checks',
  //   why: `
  //     Multi-line explanation of why this rule exists.
  //     This helps developers understand the rationale.
  //   `,
  //   skip: ['pattern-to-skip'],
  //   check: ({ content, relativePath }) => {
  //     const violations: Violation[] = [];
  //     // Your validation logic here
  //     return violations;
  //   },
  //   fix: 'How to fix violations',
  // },
];

// ─────────────────────────────────────────────────────────────────────────────
// Validation Engine
// ─────────────────────────────────────────────────────────────────────────────

function findTsFiles(dir: string) {
  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip node_modules, dist, and other non-source directories
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function shouldSkipFile(relativePath: string, skipPatterns: string[] = []) {
  return skipPatterns.some((pattern) => {
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      // Directory pattern
      return relativePath.includes(pattern.slice(1, -1));
    }
    if (pattern.startsWith('.')) {
      // File extension pattern
      return relativePath.endsWith(pattern);
    }
    // Exact match or substring
    return relativePath === pattern || relativePath.includes(pattern);
  });
}

function runRule(rule: Rule, files: string[]) {
  const allViolations: Violation[] = [];

  for (const filePath of files) {
    const relativePath = path.relative(process.cwd(), filePath);

    // Skip files matching skip patterns
    if (shouldSkipFile(relativePath, rule.skip)) {
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const violations = rule.check({ content, relativePath });
      allViolations.push(...violations);
    } catch (error) {
      console.warn(`⚠️  Warning: Could not read ${relativePath}: ${error}`);
    }
  }

  return allViolations;
}

function reportViolations(rule: Rule, violations: Violation[]) {
  if (violations.length === 0) {
    return;
  }

  console.error(`\n❌ ${rule.name}: ${violations.length} violation(s)`);
  console.error(`   ${rule.description}\n`);

  for (const violation of violations.slice(0, 10)) {
    // Show first 10
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.text}`);
  }

  if (violations.length > 10) {
    console.error(`  ... and ${violations.length - 10} more`);
  }

  console.error(`\n💡 Fix: ${rule.fix}`);
  console.error(`📖 Why: ${rule.why.trim()}\n`);
}

/** The backend folders whose code must read configuration through `env`. */
const SOURCE_DIRS = ['src', 'app', 'queue', 'scripts'];

function main() {
  console.log('🔍 Running code validation rules...\n');

  const files: string[] = [];
  for (const dir of SOURCE_DIRS) {
    const dirPath = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      console.error(`❌ Source directory not found: ${dirPath}`);
      process.exit(1);
    }
    files.push(...findTsFiles(dirPath));
  }

  let totalViolations = 0;
  let failedRules = 0;

  for (const rule of RULES) {
    const violations = runRule(rule, files);
    totalViolations += violations.length;

    if (violations.length > 0) {
      failedRules++;
      reportViolations(rule, violations);
    } else {
      console.log(`✅ ${rule.name}`);
    }
  }

  console.log('');

  if (totalViolations > 0) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(
      `Validation failed: ${totalViolations} violation(s) across ${failedRules} rule(s)`,
    );
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  } else {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ All validation rules passed (${RULES.length} rules, ${files.length} files)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(0);
  }
}

main();
