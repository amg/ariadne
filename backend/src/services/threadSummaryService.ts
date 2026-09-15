import { db } from '@db/db';
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
    input_price_per_million: number | null;
    output_price_per_million: number | null;
    cached_price_per_million: number | null;
    cached_rate_multiplier: number | null;
  } | null;
  contextUsage: {
    used: number;
    limit: number | null;
    percentage: number | null;
  };
  createdAt: string;
}

interface MessageWithUsage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  model: string | null;
  cost_usd: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
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
function aggregateStats(messages: MessageWithUsage[]): AggregatedStats {
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

    if (!msg.model || !msg.cost_usd) continue;

    stats.modelCounts[msg.model] = (stats.modelCounts[msg.model] ?? 0) + 1;
    stats.totalCost += Number.parseFloat(msg.cost_usd);
    stats.totalPrompt += msg.prompt_tokens ?? 0;
    stats.totalCompletion += msg.completion_tokens ?? 0;
    stats.totalCached += msg.cached_input_tokens ?? 0;
    stats.totalReasoning += msg.reasoning_tokens ?? 0;
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
  const thread = await db
    .selectFrom('threads')
    .select(['id', 'created_at'])
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!thread) return null;

  // Get all messages with their usage
  const messages = (await db
    .selectFrom('messages')
    .leftJoin('message_usage', 'messages.id', 'message_usage.message_id')
    .select([
      'messages.id as id',
      'messages.role as role',
      'message_usage.model as model',
      'message_usage.cost_usd as cost_usd',
      'message_usage.prompt_tokens as prompt_tokens',
      'message_usage.completion_tokens as completion_tokens',
      'message_usage.cached_input_tokens as cached_input_tokens',
      'message_usage.reasoning_tokens as reasoning_tokens',
    ])
    .where('messages.thread_id', '=', threadId)
    .orderBy('messages.created_at')
    .execute()) as unknown as MessageWithUsage[];

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
      createdAt: thread.created_at.toISOString(),
    };
  }

  // Aggregate statistics
  const stats = aggregateStats(messages);
  const primaryModel = findPrimaryModel(stats.modelCounts);

  // Get context window, pricing, and cached rate from DB cache (or fallback)
  let contextLimit: number | null = null;
  let primaryModelPricing: {
    input_price_per_million: number | null;
    output_price_per_million: number | null;
    cached_price_per_million: number | null;
    cached_rate_multiplier: number | null;
  } | null = null;
  let cachedCost = 0;

  if (primaryModel) {
    const config = await getModelConfig(primaryModel);
    if (config) {
      contextLimit = config.context_window;
      primaryModelPricing = {
        input_price_per_million: config.input_price_per_million,
        output_price_per_million: config.output_price_per_million,
        cached_price_per_million: config.cached_price_per_million,
        cached_rate_multiplier: config.cached_rate_multiplier,
      };

      // Calculate cached cost: cachedTokens × cached_price_per_million / 1M
      if (stats.totalCached > 0 && config.cached_price_per_million) {
        cachedCost = (stats.totalCached * config.cached_price_per_million) / 1_000_000;
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
    createdAt: thread.created_at.toISOString(),
  };
}
