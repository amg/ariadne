import { EMBEDDING_MODEL_ID } from '@services/aiService/config';
import { type UsagePricing, computeCostUsd } from '@services/aiService/cost';
import { getFallbackPricing, getModelConfig } from '@services/modelConfigService';
import type { CostPoint } from './types';

/**
 * Cost math for the analyzer (folder-private). Rewrite, judge, and
 * embedding rates resolve through the same seam chat usage uses — the DB
 * pricing table, falling through to the central fallback pricing — so
 * this file keeps no private rate table.
 */

/** Rounds to 10 decimals, matching the `cost_usd` numeric(14,10) precision. */
export function round10(value: number): number {
  return Number(value.toFixed(10));
}

/**
 * Embedding-model pricing fallback: $0.01 per 1M prompt tokens. Used
 * only when the DB has no `model_configs` row pricing
 * `EMBEDDING_MODEL_ID` — the central fallback is a chat-tier price and
 * does not extend to embeddings. Recorded in the report only, never in
 * chat data.
 */
export const EMBEDDING_COST_PER_MILLION_USD = 0.01;

// Resolved-pricing cache (process lifetime): one PK lookup per model per
// process. Rates stay as fresh as the process start; a
// `refreshModelConfigs` mid-process won't repoint them — acceptable for
// report-only numbers.
const callPricingCache = new Map<string, UsagePricing>();
let embeddingPricePerMillionUsd: number | null = null;

/**
 * Per-call pricing from the shared seam: the DB `model_configs` row for
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

interface CostProfileMessage {
  role: string;
  /** Stored `message_usage.cost_usd`; null when the message has no usage row. */
  usageCostUsd: string | null;
}

/**
 * The cost series, defined at every message: marginal cost is
 * the assistant message's stored `cost_usd` (already per-message per chat
 * model, so mixed-model Threads are exact); missing usage rows (user
 * messages, failed exchanges) contribute 0; the Running total accumulates
 * across the whole Thread.
 */
export function buildCostProfile(messages: CostProfileMessage[]): CostPoint[] {
  let runningTotalUsd = 0;
  return messages.map((message, index) => {
    const marginalCostUsd = Number(message.usageCostUsd ?? 0);
    runningTotalUsd = round10(runningTotalUsd + marginalCostUsd);
    return {
      messageIndex: index + 1,
      role: message.role === 'assistant' ? 'assistant' : 'user',
      marginalCostUsd,
      runningTotalUsd,
    };
  });
}
