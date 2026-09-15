import type { MessageFinishReason, NewMessageUsage } from '@db/types';
import type { LanguageModelUsage } from 'ai';
import { getModelConfig } from '../modelConfigService';
import { computeCostUsd } from './cost';

/**
 * Maps a provider usage report onto a `message_usage` insert row.
 * Fields the provider didn't report are simply omitted (nullable columns).
 */

export function hasUsageReport(usage: LanguageModelUsage | undefined): usage is LanguageModelUsage {
  return (
    usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
  );
}

/** `cache_write_tokens` rides on the provider's raw usage block (see MVP.md). */
function readRawCacheWriteTokens(usage: LanguageModelUsage): number | null {
  const raw = usage.raw as { prompt_tokens_details?: unknown } | undefined;
  const details = raw?.prompt_tokens_details;
  if (typeof details !== 'object' || details === null) return null;
  const cacheWrite = (details as { cache_write_tokens?: unknown }).cache_write_tokens;
  return typeof cacheWrite === 'number' ? cacheWrite : null;
}

export async function buildUsageRow(args: {
  messageId: string;
  model: string;
  /** Provider response id, when available. */
  providerId?: string;
  usage: LanguageModelUsage;
  finishReason: MessageFinishReason;
  latencyMs: number | null;
}): Promise<NewMessageUsage> {
  const promptTokens = args.usage.inputTokens ?? 0;
  const completionTokens = args.usage.outputTokens ?? 0;
  const cachedInputTokens =
    args.usage.inputTokenDetails?.cacheReadTokens ?? readRawCacheWriteTokens(args.usage);

  // Get cached rate multiplier from model config
  const modelConfig = await getModelConfig(args.model);
  const cachedRateMultiplier = modelConfig?.cached_rate_multiplier ?? null;

  const row: NewMessageUsage = {
    message_id: args.messageId,
    model: args.model,
    provider_id: args.providerId ?? `local-${args.messageId}`,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cost_usd: computeCostUsd({
      model: args.model,
      promptTokens,
      completionTokens,
      cachedInputTokens,
      cachedRateMultiplier,
    }).toFixed(10),
    finish_reason: args.finishReason,
  };

  if (typeof cachedInputTokens === 'number') row.cached_input_tokens = cachedInputTokens;

  const cacheWrite =
    args.usage.inputTokenDetails?.cacheWriteTokens ?? readRawCacheWriteTokens(args.usage);
  if (typeof cacheWrite === 'number') row.cache_write_tokens = cacheWrite;

  const reasoning = args.usage.outputTokenDetails?.reasoningTokens;
  if (typeof reasoning === 'number') row.reasoning_tokens = reasoning;

  if (args.latencyMs !== null) row.latency_ms = args.latencyMs;
  return row;
}
