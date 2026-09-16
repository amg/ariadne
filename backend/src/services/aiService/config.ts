import { createDeepInfra } from '@ai-sdk/deepinfra';
import type { LanguageModel } from 'ai';

/**
 * Provider configuration for the AI Connector boundary
 * (see features/ai-connector/MVP.md). Env is read lazily at call time so
 * tests can point `MOCK_AI_BASE_URL` at the mock inference server.
 */

export const DEFAULT_MODEL_ID = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';

export const SYSTEM_PROMPT = 'You are a helpful assistant.';

export type InferenceConfig = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  idleTimeoutMs: number;
  enableReasoning: boolean;
};

export function resolveInferenceConfig(): InferenceConfig {
  const rawBaseUrl = process.env.MOCK_AI_BASE_URL?.trim();
  const baseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/+$/, '') : undefined;
  const config: InferenceConfig = {
    model: process.env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
    idleTimeoutMs: Number(process.env.AI_STREAM_IDLE_TIMEOUT_MS ?? '5000'),
    enableReasoning: process.env.ENABLE_REASONING !== 'false', // Default: true
  };
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  if (process.env.DEEPINFRA_API_KEY) config.apiKey = process.env.DEEPINFRA_API_KEY;
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
