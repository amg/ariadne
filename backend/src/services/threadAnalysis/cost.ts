import type { CostPoint } from './types';

/**
 * Cost math for the analyzer (folder-private). Call rates resolve through
 * `@services/aiService/pricing`, so this file keeps no rate table.
 */

/** Rounds to 10 decimals, matching the `cost_usd` numeric(14,10) precision. */
export function round10(value: number): number {
  return Number(value.toFixed(10));
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
