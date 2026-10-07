import { getFallbackPricing, getModelConfig } from '@services/modelConfigService';
import { EMBEDDING_MODEL_ID } from './config';
import { type UsagePricing, computeCostUsd } from './cost';

/**
 * Prices side calls (analysis, memory) through the same seam chat usage
 * uses: the DB pricing table, falling through to the central fallback
 * pricing, so no caller keeps a private rate table.
 */

function round10(value: number): number {
  return Number(value.toFixed(10));
}

/**
 * Embedding-model pricing fallback: $0.01 per 1M prompt tokens. Used
 * only when the DB has no `billing.model_configs` row pricing
 * `EMBEDDING_MODEL_ID`: the central fallback is a chat-tier price and
 * does not extend to embeddings.
 */
const EMBEDDING_COST_PER_MILLION_USD = 0.01;

// Resolved-pricing cache (process lifetime): one PK lookup per model per
// process. Rates stay as fresh as the process start; a
// `refreshModelConfigs` mid-process won't repoint them, which side-call
// spend tolerates.
const callPricingCache = new Map<string, UsagePricing>();
let embeddingPricePerMillionUsd: number | null = null;

/**
 * Per-call pricing from the shared seam: the DB `billing.model_configs` row for
 * the actual model being called, falling through to the central fallback
 * pricing for models the billing table doesn't know.
 */
async function resolveCallPricing(modelId: string): Promise<UsagePricing> {
  const cached = callPricingCache.get(modelId);
  if (cached) return cached;
  const row = await getModelConfig(modelId);
  const fallback = getFallbackPricing();
  const pricing: UsagePricing =
    row !== null && row.inputPricePerMillion !== null && row.outputPricePerMillion !== null
      ? {
          input: row.inputPricePerMillion,
          output: row.outputPricePerMillion,
          cachedRateMultiplier: row.cachedRateMultiplier,
        }
      : { input: fallback.inputPerMillionUsd, output: fallback.outputPerMillionUsd };
  callPricingCache.set(modelId, pricing);
  return pricing;
}

export async function computeEmbeddingCostUsd(promptTokens: number): Promise<number> {
  if (embeddingPricePerMillionUsd === null) {
    const row = await getModelConfig(EMBEDDING_MODEL_ID);
    embeddingPricePerMillionUsd = row?.inputPricePerMillion ?? EMBEDDING_COST_PER_MILLION_USD;
  }
  return round10((promptTokens * embeddingPricePerMillionUsd) / 1_000_000);
}

export async function computeInferenceCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): Promise<number> {
  const pricing = await resolveCallPricing(modelId);
  return computeCostUsd({ pricing, promptTokens, completionTokens });
}
