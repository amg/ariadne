/**
 * Model configuration - FALLBACK ONLY.
 *
 * Primary source: DB (model_configs table) - populated from DeepInfra API
 * Secondary source: This fallback for unknown models
 *
 * Keep only essential fallback config for when DB is unavailable.
 */

export interface ModelConfig {
  contextWindow: number | null;
  pricing?: { input: number; output: number }; // per million tokens
}

/**
 * Fallback config for critical model when DB is unavailable.
 * This is the ONLY hardcoded config - everything else comes from DB.
 */
const FALLBACK_CONFIG: ModelConfig = {
  contextWindow: 32768,
  pricing: { input: 0.1, output: 0.15 },
};

/**
 * Gets fallback config for a model.
 * Should only be used when DB is unavailable.
 */
export function getFallbackModelConfig(modelId: string): ModelConfig | null {
  // Only provide fallback for the critical default model
  if (modelId === 'Qwen/Qwen3.5-9B') {
    return FALLBACK_CONFIG;
  }
  return null;
}
