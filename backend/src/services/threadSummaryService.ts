import { env } from '@config/env';
import { sumThreadSpend } from '@queries/messageUsage/sumThreadSpend';
import type { MessageWithUsageRow } from '@queries/messages/listMessagesWithUsageByThread';
import { listMessagesWithUsageByThread } from '@queries/messages/listMessagesWithUsageByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { EMBEDDING_MODEL_ID } from './aiService/config';
import { type ModelConfigRow, getModelConfig } from './modelConfigService';

/** Rounds to 10 decimals, matching the `cost_usd` numeric(14,10) precision. */
const round10 = (value: number): number => Number(value.toFixed(10));

/** A pipeline role a model serves in a thread's spend. */
export type ThreadModelRole = 'chat' | 'embedding' | 'rewrite' | 'judge' | 'memory';

/** Pricing for one model; null when the model has no known pricing. */
export type ModelPricing = {
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedPricePerMillion: number | null;
  cachedRateMultiplier: number | null;
} | null;

/** One model used by a thread, with every role it serves grouped together. */
export interface ThreadModelInfo {
  modelId: string;
  roles: ThreadModelRole[];
  pricing: ModelPricing;
}

/** Aggregated thread statistics computed on-the-fly from message_usage. */
export interface ThreadSummary {
  threadId: string;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  totalCostUsd: string;
  cachedCostUsd: string;
  /**
   * Composition of `totalCostUsd`: the chat exchanges' spend plus the
   * analyzer pipeline's embedding, rewrite, and judge spend, plus the Fact
   * capture spend.
   */
  costBreakdown: {
    chat: string;
    embedding: string;
    rewrite: string;
    judge: string;
    memory: string;
  };
  totalTokens: {
    prompt: number;
    completion: number;
    cached: number;
    reasoning: number;
    total: number;
  };
  primaryModel: string | null;
  /**
   * Every model the thread spent on, grouped by model id. The chat role
   * carries the primary model; analyzer roles carry the current pipeline
   * models and appear only when that category spent something.
   */
  models: ThreadModelInfo[];
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
    // Providers may report zero reasoning for a model that did think, so the
    // count estimated from the reasoning content takes precedence.
    stats.totalReasoning += msg.estimatedReasoningTokens ?? msg.reasoningTokens ?? 0;
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

/** Display pricing for a resolved model config. */
function pricingFromConfig(config: ModelConfigRow): ModelPricing {
  return {
    inputPricePerMillion: config.inputPricePerMillion,
    outputPricePerMillion: config.outputPricePerMillion,
    cachedPricePerMillion: config.cachedPricePerMillion,
    cachedRateMultiplier: config.cachedRateMultiplier,
  };
}

/** Per-request model config lookup that shares a row per model id. */
function createConfigLoader() {
  const cache = new Map<string, ModelConfigRow | null>();
  return async (modelId: string): Promise<ModelConfigRow | null> => {
    if (!cache.has(modelId)) cache.set(modelId, await getModelConfig(modelId));
    return cache.get(modelId) ?? null;
  };
}

interface ModelSlot {
  role: ThreadModelRole;
  modelId: string | null;
}

/**
 * Groups a thread's spent model slots by model id: slots sharing an id
 * collapse into one entry whose roles preserve pipeline order.
 */
async function listThreadModels(
  slots: ModelSlot[],
  loadConfig: (modelId: string) => Promise<ModelConfigRow | null>,
): Promise<ThreadModelInfo[]> {
  const models: ThreadModelInfo[] = [];
  for (const { role, modelId } of slots) {
    if (modelId === null) continue;
    let entry = models.find((candidate) => candidate.modelId === modelId);
    if (!entry) {
      entry = { modelId, roles: [], pricing: null };
      models.push(entry);
    }
    entry.roles.push(role);
  }
  for (const entry of models) {
    const config = await loadConfig(entry.modelId);
    if (config) entry.pricing = pricingFromConfig(config);
  }
  return models;
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
      totalCostUsd: '0.0000000000',
      cachedCostUsd: '0.0000000000',
      costBreakdown: {
        chat: '0.0000000000',
        embedding: '0.0000000000',
        rewrite: '0.0000000000',
        judge: '0.0000000000',
        memory: '0.0000000000',
      },
      totalTokens: { prompt: 0, completion: 0, cached: 0, reasoning: 0, total: 0 },
      primaryModel: null,
      models: [],
      contextUsage: { used: 0, limit: null, percentage: null },
      createdAt: thread.createdAt.toISOString(),
    };
  }

  // Aggregate statistics
  const stats = aggregateStats(messages);
  const primaryModel = findPrimaryModel(stats.modelCounts);

  // The thread's full spend: the chat exchanges' usage rows plus the
  // arrival pipeline's embedding, rewrite, and judge spend, plus Fact capture.
  const spendTotals = await sumThreadSpend({ threadId });
  const embeddingCost = round10(Number.parseFloat(spendTotals.embedding));
  const rewriteCost = round10(Number.parseFloat(spendTotals.rewrite));
  const judgeCost = round10(Number.parseFloat(spendTotals.judge));
  const memoryCost = round10(Number.parseFloat(spendTotals.memory));
  const grandTotalCost = round10(
    stats.totalCost + embeddingCost + rewriteCost + judgeCost + memoryCost,
  );

  // Get context window, pricing, and cached rate from DB cache (or fallback)
  const loadConfig = createConfigLoader();

  let contextLimit: number | null = null;
  let cachedCost = 0;

  if (primaryModel) {
    const config = await loadConfig(primaryModel);
    if (config) {
      contextLimit = config.contextWindow;

      // Calculate cached cost: cachedTokens × cachedPricePerMillion / 1M
      if (stats.totalCached > 0 && config.cachedPricePerMillion) {
        cachedCost = (stats.totalCached * config.cachedPricePerMillion) / 1_000_000;
      }
    }
  }

  // Analyzer slots list the current pipeline models and only appear when
  // their category spent something.
  const models = await listThreadModels(
    [
      { role: 'chat', modelId: primaryModel },
      { role: 'embedding', modelId: embeddingCost > 0 ? EMBEDDING_MODEL_ID : null },
      { role: 'rewrite', modelId: rewriteCost > 0 ? env.REWRITE_MODEL : null },
      { role: 'judge', modelId: judgeCost > 0 ? env.JUDGE_MODEL : null },
      { role: 'memory', modelId: memoryCost > 0 ? env.MEMORY_MODEL : null },
    ],
    loadConfig,
  );

  const totalTokensUsed = stats.totalPrompt + stats.totalCompletion;
  const contextPercentage =
    contextLimit !== null && contextLimit > 0 ? (totalTokensUsed / contextLimit) * 100 : null;

  return {
    threadId,
    totalMessages: messages.length,
    userMessages: stats.userCount,
    assistantMessages: stats.assistantCount,
    totalCostUsd: grandTotalCost.toFixed(10),
    cachedCostUsd: cachedCost.toFixed(10),
    costBreakdown: {
      chat: round10(stats.totalCost).toFixed(10),
      embedding: embeddingCost.toFixed(10),
      rewrite: rewriteCost.toFixed(10),
      judge: judgeCost.toFixed(10),
      memory: memoryCost.toFixed(10),
    },
    totalTokens: {
      prompt: stats.totalPrompt,
      completion: stats.totalCompletion,
      cached: stats.totalCached,
      reasoning: stats.totalReasoning,
      total: totalTokensUsed,
    },
    primaryModel,
    models,
    contextUsage: {
      used: totalTokensUsed,
      limit: contextLimit,
      percentage: contextPercentage,
    },
    createdAt: thread.createdAt.toISOString(),
  };
}
