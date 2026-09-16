import { createDeepInfra } from '@ai-sdk/deepinfra';
import { env } from '@config/env';
import type { LanguageModel } from 'ai';

/**
 * Provider configuration for the AI Connector boundary
 * (see features/ai-connector/MVP.md). Uses centralized env config.
 */

export const SYSTEM_PROMPT = 'You are a helpful assistant.';

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

/**
 * DeepInfra's official AI SDK provider (ADR-0002 Amendment 1). The mock
 * inference server switches in via `MOCK_AI_BASE_URL` (OpenAI-compatible surface).
 */
export function createModel(config: InferenceConfig): LanguageModel {
  const options: Parameters<typeof createDeepInfra>[0] = {};
  if (config.baseUrl !== undefined) options.baseURL = config.baseUrl;
  // The provider factory requires an apiKey even for overrides; the mock
  // server ignores auth, so send a placeholder.
  options.apiKey = config.apiKey ?? 'mock';
  return createDeepInfra(options)(config.model);
}
