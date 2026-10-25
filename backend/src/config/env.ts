import {
  THREAD_ANALYSIS_MODES,
  type ThreadAnalysisMode,
} from '@ari/lib/api/schemas/threads/analysis';
import type { ProcessRole } from '../types/config';

const PROCESS_ROLES: readonly ProcessRole[] = ['all', 'api', 'worker'];

/** The role named in the environment; anything unknown refuses to start. */
function getProcessRole(key: string) {
  const value = process.env[key]?.trim().toLowerCase() || 'all';
  const role = PROCESS_ROLES.find((known) => known === value);
  if (role === undefined) {
    throw new Error(`${key} must be one of ${PROCESS_ROLES.join(', ')}, got: ${value}`);
  }
  return role;
}

/** A number of at least zero, or undefined when unset or empty; anything else is refused. */
function getNonNegativeNumberOrUndefined(key: string) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a number of at least 0, got: ${raw}`);
  }
  return value;
}

/** A whole number of at least one; anything else refuses to start. */
function getPositiveInteger(key: string, raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a whole number of at least 1, got: ${raw}`);
  }
  return value;
}

/**
 * Helper to get a string from env with fallback.
 * Defaults live here — consumers use env.X without fallbacks.
 */
function getString(key: string, fallback: string) {
  return process.env[key] ?? fallback;
}

/** A whole number from env; anything unreadable falls back. */
function getNumber(key: string, fallback: number) {
  const parsed = Number.parseInt(process.env[key] ?? String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getBoolean(key: string, fallback: boolean) {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value === 'true';
}

/** Thread-analysis feature flag values; anything else falls back. */
function getThreadAnalysisMode(key: string, fallback: ThreadAnalysisMode) {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return THREAD_ANALYSIS_MODES.find((mode) => mode === normalized) ?? fallback;
}

/** The environment, each value read on access with its default applied. */
export const env = {
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
  /**
   * Explicit URL, else assembled from the DB_* parts; always defined. The
   * annotation is needed because the getter reads other fields of `env`.
   */
  get DATABASE_URL(): string {
    const explicit = process.env.VITEST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (explicit) return explicit;
    const user = encodeURIComponent(env.DB_USER);
    const password = encodeURIComponent(env.DB_PASSWORD);
    return `postgres://${user}:${password}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
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

  // Global spend budget: unset or empty means no gate, by design.
  get DAILY_SPEND_BUDGET_USD() {
    return getNonNegativeNumberOrUndefined('DAILY_SPEND_BUDGET_USD');
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

  /**
   * The website origins `CORS_ORIGINS` names: split on commas, each origin
   * trimmed, empty entries and trailing slashes dropped, since a browser's
   * `Origin` never has one. Unset names none; each entry point applies its
   * own deployment fallback.
   */
  get CORS_ORIGINS() {
    return getString('CORS_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter((origin) => origin !== '');
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
  /** Whether new accounts can be created; sign-in is unaffected. */
  get AUTH_SIGNUP_ENABLED() {
    return getBoolean('AUTH_SIGNUP_ENABLED', true);
  },
  /**
   * Whether a Cloudflare rule limits the auth routes by real client
   * address, so the app leaves them unlimited. Off: the app limits them.
   */
  get AUTH_RATE_LIMIT_AT_EDGE() {
    return getBoolean('AUTH_RATE_LIMIT_AT_EDGE', false);
  },

  // Running as several backend copies
  /**
   * The Redis every backend copy shares for news and stops (event bus).
   * Unset: everything stays inside this one process. Rate-limit counts are
   * in-memory (home) or at the Cloudflare edge (prod).
   */
  get VALKEY_URL() {
    return process.env.VALKEY_URL?.trim() || undefined;
  },
  /** What this process runs: the API, the background worker, or both. */
  get PROCESS_ROLE() {
    return getProcessRole('PROCESS_ROLE');
  },
  /** How many queue jobs one process runs side by side. */
  get WORKER_JOB_CONCURRENCY() {
    return getPositiveInteger('WORKER_JOB_CONCURRENCY', process.env.WORKER_JOB_CONCURRENCY, 4);
  },
  /** Seconds between the state records a process writes of what it is carrying. */
  get STATE_LOG_INTERVAL_SECONDS() {
    return getPositiveInteger(
      'STATE_LOG_INTERVAL_SECONDS',
      process.env.STATE_LOG_INTERVAL_SECONDS,
      20,
    );
  },
  /** Whether each app record also publishes its figures as metrics. Only aws-prod does. */
  get PUBLISH_METRICS() {
    return getBoolean('PUBLISH_METRICS', false);
  },
  /** Where ECS answers what task this process runs in; unset outside ECS. */
  get ECS_CONTAINER_METADATA_URI_V4() {
    return process.env.ECS_CONTAINER_METADATA_URI_V4?.trim() || undefined;
  },
};
