import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { instant } from '../common/instant.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';

/** What a model did for a Thread: chat, or one of the analysis and memory steps. */
export const MODEL_ROLES = ['chat', 'embedding', 'rewrite', 'judge', 'memory'] as const;

const usd = z.string();

/** A Thread's spend and token totals. Message counts cover only the messages the chat shows. */
export const threadSummarySchema = z.object({
  threadId: id,
  totalMessages: z.number(),
  userMessages: z.number(),
  assistantMessages: z.number(),
  totalCostUsd: usd,
  cachedCostUsd: usd,
  /** What `totalCostUsd` is made of. */
  costBreakdown: z.object({
    chat: usd,
    embedding: usd,
    rewrite: usd,
    judge: usd,
    memory: usd,
  }),
  totalTokens: z.object({
    prompt: z.number(),
    completion: z.number(),
    cached: z.number(),
    reasoning: z.number(),
    total: z.number(),
  }),
  primaryModel: z.string().nullable(),
  /** Every model the Thread spent on, with the roles it served. */
  models: z.array(
    z.object({
      modelId: z.string(),
      roles: z.array(z.enum(MODEL_ROLES)),
      /** Null when the model's prices are unknown. */
      pricing: z
        .object({
          inputPricePerMillion: z.number().nullable(),
          outputPricePerMillion: z.number().nullable(),
          cachedPricePerMillion: z.number().nullable(),
          cachedRateMultiplier: z.number().nullable(),
        })
        .nullable(),
    }),
  ),
  /** How much of its model's window the latest exchange filled. */
  contextUsage: z.object({
    used: z.number(),
    limit: z.number().nullable(),
    percentage: z.number().nullable(),
  }),
  createdAt: instant,
});
export type ThreadSummary = Wire<typeof threadSummarySchema>;

export const threadSummary = endpoint({
  method: 'GET',
  path: '/api/threads/:id/summary',
  params: threadParams,
  replies: { 200: threadSummarySchema, 400: errorBody, 404: errorBody },
});
