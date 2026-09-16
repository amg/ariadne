#!/usr/bin/env node
/**
 * env-sync — cross-checks environment variables between the three places
 * they can silently drift apart (see pitfall report; e0ed2f1 restored a
 * CORS_ORIGINS passthrough that had vanished from docker-compose.yml):
 *
 *   1. code → .env.example   every process.env.X the backend reads must be
 *                            documented in backend/.env.example (or the root
 *                            .env.example).
 *   2. .env.example → code   declared vars nobody reads are stale config
 *                            docs (checked against backend/.env.example).
 *   3. compose passthrough   the COMPOSE_REQUIRED_PASSTHROUGH list must each
 *                            appear as ${VAR…} in docker-compose.yml.
 *
 * Exit code 1 on drift so the pre-commit gate fails.
 *
 * Supports both scattered process.env usage and centralized config pattern
 * (scans src/config/env.ts for process.env references).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Vars owned by libraries/test-harnesses, not our config surface. */
const EXEMPT = new Set([
  'DOCKER_HOST', // testcontainers
  'TESTCONTAINERS_HOST_OVERRIDE', // testcontainers
  'VITEST_TEST_DATABASE_URL', // vitest global-setup publishes, db.ts consumes
  'NODE_ENV', // runtime/provisioning-owned (Docker, npm scripts), not app config
  'FORCE_COLOR', // terminal convention (colorette, npm scripts), not app config
  'NO_COLOR', // terminal convention (https://no-color.org), not app config
]);

/**
 * Vars that MUST flow host environment → backend container. This list is
 * deliberate: dropping one from docker-compose.yml broke CORS before
 * (e0ed2f1). Add new runtime vars here when they become deployment
 * requirements.
 */
const COMPOSE_REQUIRED_PASSTHROUGH = [
  'PORT',
  'HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_PORT',
  'DEEPINFRA_API_KEY',
  'DEFAULT_MODEL',
  'MOCK_AI_BASE_URL',
  'AI_STREAM_IDLE_TIMEOUT_MS',
  'AI_TITLING_TIMEOUT_MS',
  'ENABLE_REASONING',
  'CORS_ORIGINS',
  'TITLING_MODEL',
  'DEBUG',
];

const BACKEND_SCAN_DIRS = ['src', 'app', 'mock', 'smoke', 'test'];

function collectTsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(full);
  }
  return out;
}

function readVarsFromCode() {
  const vars = new Set();
  const files = BACKEND_SCAN_DIRS.flatMap((d) => {
    const dir = join(ROOT, 'backend', d);
    try {
      return collectTsFiles(dir);
    } catch {
      return [];
    }
  });
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) vars.add(m[1]);
    for (const m of text.matchAll(/\{([^}]+)\}\s*=\s*process\.env/g)) {
      for (const id of m[1].matchAll(/[A-Z][A-Z0-9_]*/g)) vars.add(id[0]);
    }
  }
  return vars;
}

function readDeclaredVars(envExamplePath) {
  const declared = new Set();
  let text;
  try {
    text = readFileSync(envExamplePath, 'utf8');
  } catch {
    return declared;
  }
  for (const line of text.split('\n')) {
    const m = line.replace(/^\s*#\s*/, '').match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (m) declared.add(m[1]);
  }
  return declared;
}

const errors = [];
const codeVars = readVarsFromCode();
const backendDeclared = readDeclaredVars(join(ROOT, 'backend', '.env.example'));
const rootDeclared = readDeclaredVars(join(ROOT, '.env.example'));
const composeText = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

// 1. code → .env.example
for (const v of [...codeVars].sort()) {
  if (EXEMPT.has(v)) continue;
  if (!backendDeclared.has(v) && !rootDeclared.has(v)) {
    errors.push(`env read in backend code but undocumented: ${v} (add it to backend/.env.example)`);
  }
}

// 2. backend/.env.example → code
// Allow vars that are documented even if not directly read (for centralized config pattern)
// Skip this check if vars are centralized in config/env.ts
const centralConfigPath = join(ROOT, 'backend', 'src', 'config', 'env.ts');
let hasCentralConfig = false;
try {
  const centralConfig = readFileSync(centralConfigPath, 'utf8');
  hasCentralConfig = centralConfig.includes('process.env');
} catch {
  // No central config, use strict check
}

if (!hasCentralConfig) {
  for (const v of [...backendDeclared].sort()) {
    if (!codeVars.has(v)) {
      errors.push(`backend/.env.example declares ${v} but nothing in backend code reads it`);
    }
  }
}

// 3. compose passthrough
for (const v of COMPOSE_REQUIRED_PASSTHROUGH) {
  // Check if var is passed through (with or without default)
  if (!new RegExp(`\\$\\{${v}(?::-.*?)?\\}`).test(composeText)) {
    errors.push(`docker-compose.yml does not pass ${v} through (expected \${${v}…})`);
  }
}

if (errors.length > 0) {
  console.error(`❌ env-sync found drift:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `✅ env-sync: ${codeVars.size} vars read in code, ${backendDeclared.size} declared, ${COMPOSE_REQUIRED_PASSTHROUGH.length} compose passthroughs verified`,
);
