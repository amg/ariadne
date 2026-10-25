import type { MessageFinishReason, NewMessageUsage } from '@db/types';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { type Tiktoken, encodingForModel } from 'js-tiktoken';
import { getModelConfig } from '../modelConfigService';
import { computeCostUsd } from './cost';

/** Whether the provider reported any token counts at all. */
export function hasUsageReport(usage: LanguageModelUsage | undefined): usage is LanguageModelUsage {
  return (
    usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
  );
}

/** Built on first use: building an encoder loads the whole vocabulary (~130 ms). */
let encoder: Tiktoken | null = null;

/**
 * Counts tokens in a text with tiktoken (cl100k_base — a reasonable
 * stand-in for Qwen, Llama, and other modern models). No tokenizer
 * available: falls back to the rough 1-token-per-4-characters ratio.
 */
export function countTextTokens(text: string) {
  if (text === '') return 0;
  try {
    encoder ??= encodingForModel('gpt-4'); // cl100k_base encoding
    return encoder.encode(text).length;
  } catch (error) {
    console.warn('[usageMap] Failed to count text tokens:', error);
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimates reasoning token count from reasoning content using tiktoken.
 * Returns NULL when no reasoning content is provided.
 */
function countReasoningTokens(reasoningContent: string | undefined) {
  if (!reasoningContent || reasoningContent.trim() === '') return null;
  return countTextTokens(reasoningContent);
}

/**
 * Locally counted prompt tokens for an exchange's stream input: the
 * system prompt plus every replayed message, one naive token count per
 * text with no chat-template overhead. Used as the estimate when a
 * provider usage report never arrives.
 */
export function estimateChatPromptTokens({
  systemPrompt,
  messages,
}: {
  systemPrompt: string;
  messages: ModelMessage[];
}) {
  let tokens = countTextTokens(systemPrompt);
  for (const message of messages) {
    const text =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    tokens += countTextTokens(text);
  }
  return tokens;
}

/**
 * Reads cache telemetry from the provider's raw usage block.
 * DeepInfra returns `usage.prompt_tokens_details { cached_tokens, cache_write_tokens }`.
 * Used when the normalized usage carries no cache counts.
 */
function readRawCacheTokens(usage: LanguageModelUsage) {
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

/**
 * Maps a provider usage report onto a `billing.message_usage` insert row.
 * Fields the provider didn't report are left out (nullable columns).
 */
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
}) {
  const promptTokens = args.usage.inputTokens ?? 0;
  const completionTokens = args.usage.outputTokens ?? 0;

  // Cache tokens: the normalized counts first, the raw response otherwise.
  const sdkCacheRead = args.usage.inputTokenDetails?.cacheReadTokens;
  const sdkCacheWrite = args.usage.inputTokenDetails?.cacheWriteTokens;
  const rawCache = readRawCacheTokens(args.usage);
  const cachedInputTokens = sdkCacheRead ?? rawCache.cacheReadTokens;

  // Pricing resolved via the single fallback source (DB → FALLBACK_CONFIG
  // in modelConfigService); null → cost recorded as 0.
  const pricing = await resolveModelPricing(args.model);

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

  // DeepInfra counts reasoning tokens inside completionTokens and reports a
  // reasoning count of 0, so cost stays correct while the reported count is
  // missing. The estimate below fills that gap from the reasoning text.
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

/** Pricing through the single fallback source; null → cost recorded as 0. */
async function resolveModelPricing(model: string) {
  const modelConfig = await getModelConfig(model);
  if (!modelConfig) return null;
  return {
    input: modelConfig.inputPricePerMillion,
    output: modelConfig.outputPricePerMillion,
    cachedRateMultiplier: modelConfig.cachedRateMultiplier,
  };
}

/**
 * The spend row for an exchange that ended without a provider usage
 * report — stopped, disconnected, idled out, or aborted by the provider.
 * The provider still bills the partial work, so the row accounts it the
 * best way available: the locally counted prompt tokens of the exchange's
 * stream input and a token count over the text that made it out, marked
 * `estimated` and without a provider id or cache detail.
 */
export async function buildEstimatedUsageRow(args: {
  messageId: string;
  model: string;
  /** Locally counted tokens of the exchange's stream input. */
  promptTokens: number;
  /** The text that made it out of the exchange before it ended. */
  streamedText: string;
  finishReason: MessageFinishReason;
  latencyMs: number | null;
}) {
  const promptTokens = args.promptTokens;
  const completionTokens = countTextTokens(args.streamedText);
  const pricing = await resolveModelPricing(args.model);

  const row: NewMessageUsage = {
    messageId: args.messageId,
    estimated: true,
    model: args.model,
    promptTokens,
    completionTokens,
    costUsd: computeCostUsd({ pricing, promptTokens, completionTokens }).toFixed(10),
    finishReason: args.finishReason,
  };
  if (args.latencyMs !== null) row.latencyMs = args.latencyMs;
  return row;
}
