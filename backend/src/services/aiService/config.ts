import { createDeepInfra } from '@ai-sdk/deepinfra';
import { env } from '@config/env';
import type { EmbeddingModel, LanguageModel } from 'ai';

/**
 * Provider configuration for the AI Connector boundary
 *. Uses centralized env config.
 */

export const SYSTEM_PROMPT = 'You are a helpful assistant.';

/**
 * Embedding model for thread-health Turn embeddings. A configuration
 * constant — no env toggle.
 */
export const EMBEDDING_MODEL_ID = 'BAAI/bge-m3';

/**
 * Expanded-signal rewrite model: the detached decontextualising rewriter
 * that turns an ambiguous incoming user message into a self-contained one
 * before its Prospective Turn embeds. Small, cheap instruct capacity is
 * enough — the task is bounded rephrasing, never answering. Tracks the
 * chat model; kept as its own constant — no env toggle — so the rewriter
 * can be repointed independently when a reliable small model appears.
 */
export const REWRITE_MODEL_ID = 'Qwen/Qwen3.5-9B';

/**
 * Expansion trigger judge model: the tiny classifier that decides whether
 * a short, non-heuristic incoming message dangles a referent into the
 * prior Turn before a rewrite is even attempted. Classification-only
 * (one verdict label out, nothing else), so cheap small-model capacity is
 * enough. Small models load on demand (cold starts up to ~15s), so the
 * judge call carries a load-tolerant timeout. Tracks the chat model; kept
 * as its own constant — no env toggle — so the judge can be repointed to
 * a cheap small model independently.
 */
export const JUDGE_MODEL_ID = 'Qwen/Qwen3.5-9B';

export const NOT_CONFIGURED_MESSAGE =
  'Neither MOCK_AI_BASE_URL (mock) nor DEEPINFRA_API_KEY (real provider) is set.';

export type InferenceConfig = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  idleTimeoutMs: number;
  enableReasoning: boolean;
};

export function resolveInferenceConfig(): InferenceConfig {
  const baseUrl = env.MOCK_AI_BASE_URL ? env.MOCK_AI_BASE_URL.replace(/\/+$/, '') : undefined;
  const config: InferenceConfig = {
    model: env.DEFAULT_MODEL,
    idleTimeoutMs: env.AI_STREAM_IDLE_TIMEOUT_MS,
    enableReasoning: env.ENABLE_REASONING,
  };
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  if (env.DEEPINFRA_API_KEY) config.apiKey = env.DEEPINFRA_API_KEY;
  return config;
}

/** Mock testing via `MOCK_AI_BASE_URL` counts as configured (no key needed). */
export function isInferenceConfigured(config: InferenceConfig): boolean {
  return config.baseUrl !== undefined || config.apiKey !== undefined;
}

/** DeepInfra provider instance with resolved base URL + api key (mock placeholder included). */
function createProvider(config: InferenceConfig) {
  const options: Parameters<typeof createDeepInfra>[0] = {};
  if (config.baseUrl !== undefined) options.baseURL = config.baseUrl;
  // The provider factory requires an apiKey even for overrides; the mock
  // server ignores auth, so send a placeholder.
  options.apiKey = config.apiKey ?? 'mock';
  return createDeepInfra(options);
}

/**
 * DeepInfra's official AI SDK provider. The mock
 * inference server switches in via `MOCK_AI_BASE_URL` (OpenAI-compatible surface).
 */
export function createModel(config: InferenceConfig): LanguageModel {
  return createProvider(config)(config.model);
}

/**
 * Embedding side of the same provider boundary: inherits the mock switch
 * (`MOCK_AI_BASE_URL`) and api-key resolution exactly like the chat path.
 */
export function createEmbeddingModel(config: InferenceConfig): EmbeddingModel {
  return createProvider(config).embeddingModel(EMBEDDING_MODEL_ID);
}
