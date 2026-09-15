import { DEFAULT_MODEL_ID } from './config';

/**
 * Flat USD pricing per million tokens, keyed by model id (source of truth).
 * Folder-private: cost consumers go through `computeCostUsd`.
 *
 * Note: Cached tokens are charged at a separate rate (cachedRateMultiplier × inputPrice).
 * DeepInfra provides rate_per_input_token_cached as a multiplier (e.g., 0.5 = 50% of input price).
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [DEFAULT_MODEL_ID]: { input: 0.1, output: 0.15 },
};

/**
 * Server-side cost for a usage report.
 * Calculates total cost including cached tokens at their discounted rate.
 */
export function computeCostUsd(args: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number | null;
  cachedRateMultiplier?: number | null;
}): number {
  const pricing = PRICING_PER_MILLION_TOKENS[args.model];
  if (!pricing) return 0;

  const cachedTokens = args.cachedInputTokens ?? 0;
  const nonCachedPromptTokens = args.promptTokens - cachedTokens;
  const cachedMultiplier = args.cachedRateMultiplier ?? 1.0; // Default to full price if not specified

  // Non-cached tokens at full input price + cached tokens at discounted rate
  const inputCost =
    (nonCachedPromptTokens * pricing.input + cachedTokens * pricing.input * cachedMultiplier) /
    1_000_000;
  const outputCost = (args.completionTokens * pricing.output) / 1_000_000;

  const cost = inputCost + outputCost;
  return Number(cost.toFixed(10));
}

/**
 * Computes the portion of cost attributed to cached tokens.
 * Returns 0 if no cached tokens or pricing unavailable.
 */
export function computeCachedCostUsd(args: {
  model: string;
  cachedInputTokens?: number | null;
  cachedRateMultiplier?: number | null;
}): number {
  const pricing = PRICING_PER_MILLION_TOKENS[args.model];
  const cachedTokens = args.cachedInputTokens ?? 0;
  const cachedMultiplier = args.cachedRateMultiplier ?? 1.0;

  if (!pricing || !cachedTokens) return 0;

  // Cached tokens cost: cachedTokens × inputPrice × cachedRateMultiplier / 1M
  const cost = (cachedTokens * pricing.input * cachedMultiplier) / 1_000_000;
  return Number(cost.toFixed(10));
}
