/**
 * Cost math for a usage report. Pure functions — no pricing table of its
 * own: pricing is resolved by the caller through `getModelConfig`
 * (`@services/modelConfigService`, DB `model_configs` → FALLBACK_CONFIG).
 */

/** Flat USD pricing per million tokens (null = unknown → no charge). */
export interface UsagePricing {
  input: number | null;
  output: number | null;
  /**
   * Multiplier of input price charged for cached prompt tokens
   * (e.g., 0.5 = 50% discount). Defaults to full price when unset.
   */
  cachedRateMultiplier?: number | null;
}

function round10(n: number): number {
  return Number(n.toFixed(10));
}

/**
 * Server-side cost for a usage report.
 * Non-cached prompt tokens at full input price, cached tokens at the
 * discounted rate, completion tokens at output price.
 */
export function computeCostUsd(args: {
  pricing: UsagePricing | null;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number | null;
}): number {
  const { pricing } = args;
  if (!pricing || pricing.input === null || pricing.output === null) return 0;

  const cachedTokens = args.cachedInputTokens ?? 0;
  const nonCachedPromptTokens = args.promptTokens - cachedTokens;
  const cachedMultiplier = pricing.cachedRateMultiplier ?? 1.0;

  const inputCost =
    (nonCachedPromptTokens * pricing.input + cachedTokens * pricing.input * cachedMultiplier) /
    1_000_000;
  const outputCost = (args.completionTokens * pricing.output) / 1_000_000;

  return round10(inputCost + outputCost);
}

/**
 * Cost attributed to cached tokens (discounted portion only).
 * Returns 0 if no cached tokens or pricing unavailable.
 */
export function computeCachedCostUsd(args: {
  pricing: UsagePricing | null;
  cachedInputTokens?: number | null;
}): number {
  const { pricing } = args;
  const cachedTokens = args.cachedInputTokens ?? 0;
  if (!pricing || pricing.input === null || !cachedTokens) return 0;

  const cachedMultiplier = pricing.cachedRateMultiplier ?? 1.0;
  return round10((cachedTokens * pricing.input * cachedMultiplier) / 1_000_000);
}
