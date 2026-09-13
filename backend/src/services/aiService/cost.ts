import { DEFAULT_MODEL_ID } from './config';

/**
 * Flat USD pricing per million tokens, keyed by model id (source of truth).
 * Folder-private: cost consumers go through `computeCostUsd`.
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [DEFAULT_MODEL_ID]: { input: 0.1, output: 0.15 },
};

/**
 * Server-side cost for a usage report. Flat input pricing for all prompt
 * tokens (cache hits included) — MVP pricing model.
 */
export function computeCostUsd(args: {
  model: string;
  promptTokens: number;
  completionTokens: number;
}): number {
  const pricing = PRICING_PER_MILLION_TOKENS[args.model];
  if (!pricing) return 0;
  const cost =
    (args.promptTokens * pricing.input + args.completionTokens * pricing.output) / 1_000_000;
  return Number(cost.toFixed(10));
}
