/**
 * Centralized environment configuration.
 *
 * All environment variables and their defaults are defined in this single module.
 * This class acts as a stateless singleton proxy - it reads directly from process.env
 * at access time (lazy evaluation) so tests can override env vars before use.
 *
 * Usage: import { env } from '@config/env';
 */

export type EnvConfig = {
  // Server (optional - have sensible defaults)
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  DEBUG: boolean;

  // Database (required - no defaults)
  /** Explicit URL, else assembled from the DB_* parts; always defined. */
  DATABASE_URL: string;
  /** Second standing pool for bench review (same backend, other database). */
  BENCH_DATABASE_URL: string | undefined;
  DB_HOST: string;
  DB_PORT: number;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;

  // AI Provider
  DEEPINFRA_API_KEY: string | undefined;
  DEFAULT_MODEL: string;
  MOCK_AI_BASE_URL: string | undefined;
  AI_STREAM_IDLE_TIMEOUT_MS: number;
  ENABLE_REASONING: boolean;

  // Exchange lifecycle (required - no defaults)
  /** How long an assistant row may stay `pending` before being declared lost. */
  EXCHANGE_STALENESS_MS: number;
  /** How long a chat request holds its response open for the drift gate's verdict. */
  GATE_WAIT_MS: number;
  /** How long a handover request holds for the closed segment's capture. */
  HANDOVER_WAIT_MS: number;

  // Global spend budget (rate limiting ticket)
  /** Daily spend budget in USD. Unset = no gate, fail open. */
  DAILY_SPEND_BUDGET_USD: number | undefined;

  // Titling Service
  AI_TITLING_TIMEOUT_MS: number | undefined;
  TITLING_MODEL: string | undefined;

  // Thread analysis (live drift gate) - required
  THREAD_ANALYSIS_MODE: 'off' | 'heuristic' | 'always';
  JUDGE_MODEL: string;
  REWRITE_MODEL: string;

  // User memory: Fact extraction and duplicate checks
  MEMORY_MODEL: string;

  // Feature toggles, read once at boot
  FEATURE_MEMORY: boolean;

  // CORS (required for SuperTokens)
  CORS_ORIGINS: string;

  // Logger
  FORCE_COLOR: string | undefined;
  NO_COLOR: string | undefined;

  // SuperTokens (required)
  SUPERTOKENS_CONNECTION_URI: string;
  SUPERTOKENS_API_KEY: string | undefined;
};

/**
 * Helper to get a string from env with fallback.
 * Defaults live here — consumers use env.X without fallbacks.
 */
function getString(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Helper to get a required string — throws if not set.
 */
function getRequiredString(key: string): string {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

/**
 * Helper to get a number from env with fallback.
 */
function getNumber(key: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[key] ?? String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Helper to get a required number — throws if not set or invalid.
 */
function getRequiredNumber(key: string): number {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number, got: ${value}`);
  }
  return parsed;
}

function getBoolean(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value === 'true';
}

/** Thread-analysis feature flag values; anything else falls back. */
type ThreadAnalysisMode = 'off' | 'heuristic' | 'always';
const THREAD_ANALYSIS_MODES: readonly ThreadAnalysisMode[] = ['off', 'heuristic', 'always'];

function getThreadAnalysisMode(key: string, fallback: ThreadAnalysisMode): ThreadAnalysisMode {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return THREAD_ANALYSIS_MODES.find((mode) => mode === normalized) ?? fallback;
}

/**
 * Environment configuration proxy.
 * Reads from process.env at access time (lazy) with fallback to defaults.
 * This allows tests to override process.env before the values are read.
 */
export const env: EnvConfig = {
  // Server
  get NODE_ENV() {
    return getString('NODE_ENV', 'development');
  },
  get PORT() {
    return getNumber('PORT', 3001);
  },
  get HOST() {
    return getString('HOST', '0.0.0.0');
  },
  get DEBUG() {
    return getBoolean('DEBUG', false);
  },

  // Database — explicit URL wins; parts only feed the fallback assembly.
  get DATABASE_URL() {
    const explicit = process.env.VITEST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (explicit) return explicit;
    const user = encodeURIComponent(env.DB_USER);
    const password = encodeURIComponent(env.DB_PASSWORD);
    return `postgres://${user}:${password}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
  },
  get BENCH_DATABASE_URL() {
    return process.env.BENCH_DATABASE_URL;
  },
  get DB_HOST() {
    return getString('DB_HOST', '127.0.0.1');
  },
  get DB_PORT() {
    return getNumber('DB_PORT', 5432);
  },
  get DB_NAME() {
    return getString('DB_NAME', 'chatbot');
  },
  get DB_USER() {
    return getString('DB_USER', 'postgres');
  },
  get DB_PASSWORD() {
    return getString('DB_PASSWORD', 'postgrespassword');
  },

  // AI Provider
  get DEEPINFRA_API_KEY() {
    return process.env.DEEPINFRA_API_KEY;
  },
  get DEFAULT_MODEL() {
    return getString('DEFAULT_MODEL', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo');
  },
  get MOCK_AI_BASE_URL() {
    const value = process.env.MOCK_AI_BASE_URL;
    return value ? value.trim() : undefined;
  },
  get AI_STREAM_IDLE_TIMEOUT_MS() {
    return getNumber('AI_STREAM_IDLE_TIMEOUT_MS', 5000);
  },
  get ENABLE_REASONING() {
    const value = process.env.ENABLE_REASONING;
    return value !== 'false';
  },

  // Exchange lifecycle: a `pending` assistant row older than this window
  // belongs to an exchange whose process died before settling it. The
  // window should sit well above the longest real exchange (~3x the
  // observed maximum settled latency).
  get EXCHANGE_STALENESS_MS() {
    return getNumber('EXCHANGE_STALENESS_MS', 300_000);
  },
  // Past this wait the request answers "still checking"; the judgment
  // itself carries on in the background.
  get GATE_WAIT_MS() {
    return getNumber('GATE_WAIT_MS', 10_000);
  },
  // Past this wait the handover answers "still saving" and the browser asks
  // again; the capture itself carries on in the background.
  get HANDOVER_WAIT_MS() {
    return getNumber('HANDOVER_WAIT_MS', 10_000);
  },

  // Global spend budget (rate limiting ticket)
  /** Daily spend budget in USD. Unset = no gate, fail open by design. */
  get DAILY_SPEND_BUDGET_USD() {
    const value = process.env.DAILY_SPEND_BUDGET_USD;
    if (value === undefined) return undefined;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  },

  // Titling Service
  get AI_TITLING_TIMEOUT_MS() {
    const value = process.env.AI_TITLING_TIMEOUT_MS;
    return value ? Number.parseInt(value, 10) : undefined;
  },
  get TITLING_MODEL() {
    return process.env.TITLING_MODEL;
  },

  // Thread analysis (live drift gate):
  // off = surface gone (pipeline skipped, Analysis tab hidden, bubbles
  // untinted); heuristic/always = live lane runs with that rewrite tier.
  // Stored signals survive an `off` period and reappear when flipped back.
  get THREAD_ANALYSIS_MODE() {
    return getThreadAnalysisMode('THREAD_ANALYSIS_MODE', 'heuristic');
  },
  // Expansion-trigger judge and rewrite calls run on small, cheap models —
  // classification and bounded rephrasing, never answering. Overridable so
  // each can be repointed independently when a better small model appears.
  // Empty values fall back to the pinned default: deployments pass these
  // through compose as `VAR=${VAR:-}`, so "" is indistinguishable from unset.
  get JUDGE_MODEL() {
    return process.env.JUDGE_MODEL?.trim() || 'Qwen/Qwen3.5-9B';
  },
  get REWRITE_MODEL() {
    return process.env.REWRITE_MODEL?.trim() || 'Qwen/Qwen3.5-9B';
  },
  // Fact extraction and the duplicate check share one small model.
  get MEMORY_MODEL() {
    return process.env.MEMORY_MODEL?.trim() || 'Qwen/Qwen3.5-9B';
  },

  // Feature toggles: whether a feature exists in this deployment at all.
  get FEATURE_MEMORY() {
    return getBoolean('FEATURE_MEMORY', false);
  },

  // CORS (required for SuperTokens - defaults to local dev)
  get CORS_ORIGINS() {
    return getString('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173');
  },

  // Logger
  get FORCE_COLOR() {
    return process.env.FORCE_COLOR;
  },
  get NO_COLOR() {
    return process.env.NO_COLOR;
  },

  // SuperTokens
  get SUPERTOKENS_CONNECTION_URI() {
    return getString('SUPERTOKENS_CONNECTION_URI', 'http://127.0.0.1:3567');
  },
  get SUPERTOKENS_API_KEY() {
    return process.env.SUPERTOKENS_API_KEY;
  },
};

/**
 * Check if AI inference is configured (real provider or mock).
 * @internal - kept for potential future use
 */
function isInferenceConfigured(): boolean {
  return env.MOCK_AI_BASE_URL !== undefined || env.DEEPINFRA_API_KEY !== undefined;
}

/**
 * Get CORS origins as an array.
 * @internal - kept for potential future use
 */
function getCorsOrigins(): string[] | undefined {
  if (!env.CORS_ORIGINS) return undefined;
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
