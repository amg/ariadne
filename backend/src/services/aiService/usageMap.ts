import type { MessageFinishReason, NewMessageUsage } from '@db/types';
import type { LanguageModelUsage } from 'ai';
import { encodingForModel } from 'js-tiktoken';
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

/**
 * Estimates reasoning token count from reasoning content using tiktoken.
 * Returns NULL when no reasoning content is provided.
 * Uses cl100k_base encoding (works well for Qwen, Llama, and other modern models).
 */
function countReasoningTokens(reasoningContent: string | undefined): number | null {
  if (!reasoningContent || reasoningContent.trim() === '') return null;
  try {
    const encoder = encodingForModel('gpt-4'); // cl100k_base encoding
    const tokens = encoder.encode(reasoningContent);
    return tokens.length;
  } catch (error) {
    // Fallback: rough character-to-token estimate (1 token ≈ 4 chars)
    console.warn('[usageMap] Failed to count reasoning tokens:', error);
    return Math.ceil(reasoningContent.length / 4);
  }
}

/**
 * Reads cache telemetry from the provider's raw usage block (see MVP.md).
 * DeepInfra returns `usage.prompt_tokens_details { cached_tokens, cache_write_tokens }`.
 * The AI SDK normalizes these to inputTokenDetails, but we also check raw for compatibility.
 */
function readRawCacheTokens(usage: LanguageModelUsage): {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
} {
  // Check raw provider response for OpenAI-style prompt_tokens_details
  const raw = usage.raw as { prompt_tokens_details?: unknown } | undefined;
  const details = raw?.prompt_tokens_details;
  if (typeof details !== 'object' || details === null) {
    return { cacheReadTokens: null, cacheWriteTokens: null };
  }
  // DeepInfra/OpenAI use snake_case in raw response
  const d = details as { cached_tokens?: unknown; cache_write_tokens?: unknown };
  const cacheRead = typeof d.cached_tokens === 'number' ? d.cached_tokens : null;
  const cacheWrite = typeof d.cache_write_tokens === 'number' ? d.cache_write_tokens : null;
  return { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

export async function buildUsageRow(args: {
  messageId: string;
  model: string;
  /** Provider response id, when available. */
  providerId?: string;
  usage: LanguageModelUsage;
  finishReason: MessageFinishReason;
  latencyMs: number | null;
  /** Reasoning content for token estimation. */
  reasoningContent?: string;
}): Promise<NewMessageUsage> {
  // Note: DeepInfra includes reasoning tokens in completionTokens (billed as output).
  // reasoningTokens field will be 0 even when model thinks - this is their API limitation.
  const promptTokens = args.usage.inputTokens ?? 0;
  const completionTokens = args.usage.outputTokens ?? 0;

  // Cache tokens: AI SDK normalizes to inputTokenDetails, fall back to raw response.
  // Note: AI SDK v4+ uses inputTokenDetails.{cacheReadTokens,cacheWriteTokens}
  const sdkCacheRead = args.usage.inputTokenDetails?.cacheReadTokens;
  const sdkCacheWrite = args.usage.inputTokenDetails?.cacheWriteTokens;
  const rawCache = readRawCacheTokens(args.usage);
  const cachedInputTokens = sdkCacheRead ?? rawCache.cacheReadTokens;

  // Pricing resolved via the single fallback source (DB → FALLBACK_CONFIG
  // in modelConfigService); null → cost recorded as 0.
  const modelConfig = await getModelConfig(args.model);
  const pricing = modelConfig
    ? {
        input: modelConfig.inputPricePerMillion,
        output: modelConfig.outputPricePerMillion,
        cachedRateMultiplier: modelConfig.cachedRateMultiplier,
      }
    : null;

  const row: NewMessageUsage = {
    messageId: args.messageId,
    model: args.model,
    providerId: args.providerId ?? `local-${args.messageId}`,
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    costUsd: computeCostUsd({
      pricing,
      promptTokens,
      completionTokens,
      cachedInputTokens,
    }).toFixed(10),
    finishReason: args.finishReason,
  };

  if (typeof cachedInputTokens === 'number') row.cachedInputTokens = cachedInputTokens;

  const cacheWrite = sdkCacheWrite ?? rawCache.cacheWriteTokens;
  if (typeof cacheWrite === 'number') row.cacheWriteTokens = cacheWrite;

  // Reasoning tokens: AI SDK normalizes to outputTokenDetails.reasoningTokens.
  // IMPORTANT: DeepInfra lumps reasoning tokens into textTokens instead of separating them.
  // The reasoning token count will be 0 even when the model thinks - this is a DeepInfra API
  // limitation, not a code issue. Cost calculation is still correct (reasoning tokens are
  // included in completionTokens and billed as output tokens).
  const sdkReasoning = args.usage.outputTokenDetails?.reasoningTokens;

  // Check raw response for provider-specific fields (OpenAI style)
  const rawUsage = args.usage.raw as
    | {
        reasoning_tokens?: unknown;
        completion_tokens_details?: unknown;
      }
    | undefined;

  const rawReasoning =
    typeof rawUsage?.reasoning_tokens === 'number' ? rawUsage.reasoning_tokens : null;
  const completionDetails = rawUsage?.completion_tokens_details as
    | { reasoning_tokens?: unknown }
    | undefined;
  const rawCompletionReasoning =
    typeof completionDetails?.reasoning_tokens === 'number'
      ? completionDetails.reasoning_tokens
      : null;

  const reasoning =
    typeof sdkReasoning === 'number' ? sdkReasoning : (rawReasoning ?? rawCompletionReasoning);
  if (typeof reasoning === 'number') row.reasoningTokens = reasoning;

  // Estimate reasoning tokens from content (works even when provider reports 0)
  row.estimatedReasoningTokens = countReasoningTokens(args.reasoningContent);

  if (args.latencyMs !== null) row.latencyMs = args.latencyMs;
  return row;
}
