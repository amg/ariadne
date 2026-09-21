import { createDeepInfra } from '@ai-sdk/deepinfra';
import { env } from '@config/env';
import type { EmbeddingModel, LanguageModel } from 'ai';

/**
 * Provider configuration for the AI Connector boundary
 *. Uses centralized env config.
 */

export const SYSTEM_PROMPT = 'You are a helpful assistant.';

/**
 * Embedding model for thread-health Turn embeddings.
 * A configuration constant by decision — no env toggle (env-sync gate
 * untouched).
 */
export const EMBEDDING_MODEL_ID = 'BAAI/bge-m3';

/**
 * Expanded-signal rewrite model: the detached decontext-
 * ualising rewriter that turns an ambiguous incoming user message into a
 * self-contained one before its Prospective Turn embeds. A small, cheap
 * instruct model — the task is bounded rephrasing, never answering.
 * Probed 2026-09: Mistral-7B-v0.3 resolves ellipsis reliably (Qwen2.5-7B
 * answered empty, Gemma-2-9B kept the anaphora, Llama-3.1-8B absent from
 * the provider). A configuration constant by decision — no env toggle.
 */
export const REWRITE_MODEL_ID = 'mistralai/Mistral-7B-Instruct-v0.3';

/**
 * Expansion trigger judge model: the tiny classifier that decides whether
 * a short, non-heuristic incoming message dangles a referent into the
 * prior Turn before a rewrite is even attempted. Classification-only
 * (one verdict label out, nothing else), so the cheapest small instruct
 * model on the provider is enough.
 * Probed 2026-09 via /v1/openai/models: no sub-4B text instruct on
 * DeepInfra anymore (no Qwen2.5 0.5B–3B, no SmolLM); gemma-3-4b-it is
 * the smallest fit. Caveat observed on first corpus run: DeepInfra hosts
 * it on-demand (cold starts up to ~15s, "Model busy" while loading), so
 * the judge call carries a load-tolerant timeout — see `judge.ts`. A configuration constant by decision — no env
 * toggle (same stance as the rewriter); a future local endpoint can host
 * this model behind the same OpenAI-compatible seam.
 */
export const JUDGE_MODEL_ID = 'google/gemma-3-4b-it';

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
