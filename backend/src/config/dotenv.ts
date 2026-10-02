import { fileURLToPath } from 'node:url';
/**
 * Loads the repo-root `.env` — the single unified config file for local
 * development. Plain `import 'dotenv/config'` resolves against
 * process.cwd(), and npm runs workspace scripts from backend/, so it would
 * look for backend/.env and miss the root file entirely. The path here is
 * resolved relative to this module, so it works regardless of cwd.
 *
 * Pointing at another file: set ENV_FILE before starting the process,
 * e.g. `ENV_FILE=.env.prod npm run migrate:prod`. The value is resolved
 * against the repo root.
 *
 * Entry points import this as their first import, before any module reads
 * process.env (db.ts resolves its connection at import time).
 */
import { config } from 'dotenv';

const repoRoot = new URL('../../../', import.meta.url);
const envPath = fileURLToPath(
  process.env.ENV_FILE ? new URL(process.env.ENV_FILE, repoRoot) : new URL('.env', repoRoot),
);

config({ path: envPath });
