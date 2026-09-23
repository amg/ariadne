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
  // Server
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  DEBUG: boolean;

  // Database
  DATABASE_URL: string | undefined;
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

  // Titling Service
  AI_TITLING_TIMEOUT_MS: number | undefined;
  TITLING_MODEL: string | undefined;

  // Thread analysis (live drift gate)
  THREAD_ANALYSIS_MODE: 'off' | 'heuristic' | 'always';
  JUDGE_MODEL: string;
  REWRITE_MODEL: string;

  // CORS
  CORS_ORIGINS: string | undefined;

  // Logger
  FORCE_COLOR: string | undefined;
  NO_COLOR: string | undefined;
};

/**
 * Default configuration values (used when env vars are not set).
 * @internal - kept for potential future use
 */
const defaultConfig: Omit<EnvConfig, 'NODE_ENV'> = {
  // Server
  PORT: 3001,
  HOST: '0.0.0.0',
  DEBUG: false,

  // Database
  DB_HOST: '127.0.0.1',
  DB_PORT: 5432,
  DB_NAME: 'chatbot',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgrespassword',
  DATABASE_URL: undefined,

  // AI Provider
  DEFAULT_MODEL: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  AI_STREAM_IDLE_TIMEOUT_MS: 5000,
  ENABLE_REASONING: true,
  DEEPINFRA_API_KEY: undefined,
  MOCK_AI_BASE_URL: undefined,

  // Titling Service
  AI_TITLING_TIMEOUT_MS: undefined,
  TITLING_MODEL: undefined,

  // Thread analysis (live drift gate)
  THREAD_ANALYSIS_MODE: 'heuristic',
  JUDGE_MODEL: 'Qwen/Qwen3.5-9B',
  REWRITE_MODEL: 'Qwen/Qwen3.5-9B',

  // CORS
  CORS_ORIGINS: undefined,

  // Logger
  FORCE_COLOR: undefined,
  NO_COLOR: undefined,
};

/**
 * Helper to get a string from env with fallback.
 */
function getString(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Helper to get a number from env with fallback.
 */
function getNumber(key: string, fallback: number): number {
  return Number.parseInt(process.env[key] ?? String(fallback), 10);
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

  // Database - parts win over connection string if both provided
  get DATABASE_URL() {
    return process.env.VITEST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
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
  get JUDGE_MODEL() {
    return process.env.JUDGE_MODEL?.trim() || 'Qwen/Qwen3.5-9B';
  },
  get REWRITE_MODEL() {
    return process.env.REWRITE_MODEL?.trim() || 'Qwen/Qwen3.5-9B';
  },

  // CORS
  get CORS_ORIGINS() {
    return process.env.CORS_ORIGINS;
  },

  // Logger
  get FORCE_COLOR() {
    return process.env.FORCE_COLOR;
  },
  get NO_COLOR() {
    return process.env.NO_COLOR;
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
