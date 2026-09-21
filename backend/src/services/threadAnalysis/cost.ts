import type { CostPoint } from './types';

/**
 * Cost math for the analyzer (folder-private; verified through
 * `analyzeThread`). Key concepts: Marginal cost, Running total.
 */

/** Rounds to 10 decimals, matching the `cost_usd` numeric(14,10) precision. */
export function round10(value: number): number {
  return Number(value.toFixed(10));
}

/**
 * Embedding-model pricing: $0.01 per 1M prompt tokens (research doc
 * fallback constant). Recorded in the report only, never in chat data.
 */
export const EMBEDDING_COST_PER_MILLION_USD = 0.01;

export function computeEmbeddingCostUsd(promptTokens: number): number {
  return round10((promptTokens * EMBEDDING_COST_PER_MILLION_USD) / 1_000_000);
}

/**
 * Rewrite-model pricing: small-instruct estimates for the
 * detached decontextualising call — Mistral-7B-Instruct-v0.3 class
 * (input $0.05 / output $0.10 per 1M, conservative until the real
 * billing settles). Recorded in the report only, never in chat data.
 */
export const REWRITE_COST_PER_MILLION_USD = { input: 0.05, output: 0.1 } as const;

export function computeRewriteCostUsd(promptTokens: number, completionTokens: number): number {
  return round10(
    (promptTokens * REWRITE_COST_PER_MILLION_USD.input +
      completionTokens * REWRITE_COST_PER_MILLION_USD.output) /
      1_000_000,
  );
}

/**
 * Trigger-judge pricing: small-instruct estimate for the
 * context-clarity verdict call — gemma-3-4b-it class (input $0.02 /
 * output $0.06 per 1M, conservative until the real billing settles).
 * Recorded in the report only, never in chat data.
 */
export const JUDGE_COST_PER_MILLION_USD = { input: 0.02, output: 0.06 } as const;

export function computeJudgeCostUsd(promptTokens: number, completionTokens: number): number {
  return round10(
    (promptTokens * JUDGE_COST_PER_MILLION_USD.input +
      completionTokens * JUDGE_COST_PER_MILLION_USD.output) /
      1_000_000,
  );
}

interface CostProfileMessage {
  role: string;
  /** Stored `message_usage.cost_usd`; null when the message has no usage row. */
  usageCostUsd: string | null;
}

/**
 * The cost series, defined at every message (spec 002): marginal cost is
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
