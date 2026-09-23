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
 * constant — deliberately not env-toggleable: the segment chain and its
 * stored signals are keyed by this model id, so repointing it mid-life
 * silently starts a new chain.
 */
export const EMBEDDING_MODEL_ID = 'BAAI/bge-m3';

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
