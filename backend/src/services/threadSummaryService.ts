import type { MessageWithUsageRow } from '@queries/messages/listMessagesWithUsageByThread';
import { listMessagesWithUsageByThread } from '@queries/messages/listMessagesWithUsageByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { getModelConfig } from './modelConfigService';

/** Aggregated thread statistics computed on-the-fly from message_usage. */
export interface ThreadSummary {
  threadId: string;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  totalCostUsd: string;
  cachedCostUsd: string;
  totalTokens: {
    prompt: number;
    completion: number;
    cached: number;
    reasoning: number;
    total: number;
  };
  primaryModel: string | null;
  primaryModelPricing: {
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cachedPricePerMillion: number | null;
    cachedRateMultiplier: number | null;
  } | null;
  contextUsage: {
    used: number;
    limit: number | null;
    percentage: number | null;
  };
  createdAt: string;
}

interface AggregatedStats {
  totalCost: number;
  totalCached: number;
  totalPrompt: number;
  totalCompletion: number;
  totalReasoning: number;
  modelCounts: Record<string, number>;
  userCount: number;
  assistantCount: number;
}

/**
 * Aggregates statistics from message usage rows.
 */
function aggregateStats(messages: MessageWithUsageRow[]): AggregatedStats {
  const stats: AggregatedStats = {
    totalCost: 0,
    totalCached: 0,
    totalPrompt: 0,
    totalCompletion: 0,
    totalReasoning: 0,
    modelCounts: {},
    userCount: 0,
    assistantCount: 0,
  };

  for (const msg of messages) {
    if (msg.role === 'user') stats.userCount++;
    else if (msg.role === 'assistant') stats.assistantCount++;

    if (!msg.model || !msg.costUsd) continue;

    stats.modelCounts[msg.model] = (stats.modelCounts[msg.model] ?? 0) + 1;
    stats.totalCost += Number.parseFloat(msg.costUsd);
    stats.totalPrompt += msg.promptTokens ?? 0;
    stats.totalCompletion += msg.completionTokens ?? 0;
    stats.totalCached += msg.cachedInputTokens ?? 0;
    stats.totalReasoning += msg.reasoningTokens ?? 0;
  }

  return stats;
}

/**
 * Finds the most frequently used model from counts.
 */
function findPrimaryModel(modelCounts: Record<string, number>): string | null {
  let primaryModel: string | null = null;
  let maxCount = 0;
  for (const [model, count] of Object.entries(modelCounts)) {
    if (count > maxCount) {
      maxCount = count;
      primaryModel = model;
    }
  }
  return primaryModel;
}

/**
 * Computes thread summary statistics on-the-fly from message_usage rows.
 * Returns null if thread not found or user doesn't have access.
 */
export async function getThreadSummary(args: {
  userId: string;
  threadId: string;
}): Promise<ThreadSummary | null> {
  const { userId, threadId } = args;

  // Verify thread exists and belongs to user
  const thread = await findThreadByIdAndUser({ userId, threadId });

  if (!thread) return null;

  // Get all messages with their usage
  const messages = await listMessagesWithUsageByThread({ threadId });

  // Handle empty thread
  if (messages.length === 0) {
    return {
      threadId,
      totalMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      totalCostUsd: '0',
      cachedCostUsd: '0',
      totalTokens: { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0 },
      primaryModel: null,
      primaryModelPricing: null,
      contextUsage: { used: 0, limit: null, percentage: null },
      createdAt: thread.createdAt.toISOString(),
    };
  }

  // Aggregate statistics
  const stats = aggregateStats(messages);
  const primaryModel = findPrimaryModel(stats.modelCounts);

  // Get context window, pricing, and cached rate from DB cache (or fallback)
  let contextLimit: number | null = null;
  let primaryModelPricing: {
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cachedPricePerMillion: number | null;
    cachedRateMultiplier: number | null;
  } | null = null;
  let cachedCost = 0;

  if (primaryModel) {
    const config = await getModelConfig(primaryModel);
    if (config) {
      contextLimit = config.contextWindow;
      primaryModelPricing = {
        inputPricePerMillion: config.inputPricePerMillion,
        outputPricePerMillion: config.outputPricePerMillion,
        cachedPricePerMillion: config.cachedPricePerMillion,
        cachedRateMultiplier: config.cachedRateMultiplier,
      };

      // Calculate cached cost: cachedTokens × cachedPricePerMillion / 1M
      if (stats.totalCached > 0 && config.cachedPricePerMillion) {
        cachedCost = (stats.totalCached * config.cachedPricePerMillion) / 1_000_000;
      }
    }
  }

  const totalTokensUsed = stats.totalPrompt + stats.totalCompletion;
  const contextPercentage =
    contextLimit !== null && contextLimit > 0 ? (totalTokensUsed / contextLimit) * 100 : null;

  return {
    threadId,
    totalMessages: messages.length,
    userMessages: stats.userCount,
    assistantMessages: stats.assistantCount,
    totalCostUsd: stats.totalCost.toFixed(10),
    cachedCostUsd: cachedCost.toFixed(10),
    totalTokens: {
      prompt: stats.totalPrompt,
      completion: stats.totalCompletion,
      cached: stats.totalCached,
      reasoning: stats.totalReasoning,
      total: totalTokensUsed,
    },
    primaryModel,
    primaryModelPricing,
    contextUsage: {
      used: totalTokensUsed,
      limit: contextLimit,
      percentage: contextPercentage,
    },
    createdAt: thread.createdAt.toISOString(),
  };
}
