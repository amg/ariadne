import { z } from 'zod';
import { FIRE_CHANNELS, GATE_VERDICTS } from '../common/driftGate.ts';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { instant } from '../common/instant.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';

/** Off hides the Analysis tab and the bubble tints; the stored signals stay. */
export const THREAD_ANALYSIS_MODES = ['off', 'heuristic', 'always'] as const;
export type ThreadAnalysisMode = (typeof THREAD_ANALYSIS_MODES)[number];

/** How an arrival's try at a self-contained rewrite ended. */
export const EXPAND_OUTCOMES = [
  'accepted',
  'failed_refused',
  'failed_quality',
  'failed_inference',
  'failed',
  'not_needed',
] as const;

/** One arrival as the Analysis tab reads it. */
export const liveAnalysisPointSchema = z.object({
  messageId: id,
  messageText: z.string(),
  /** The arrival's place among the Thread's user messages, from 1. */
  turnNumber: z.number(),
  /** The segment whose span holds the arrival, from 1. A fired arrival lists under the segment it opens. */
  segmentIndex: z.number(),
  verdict: z.enum(GATE_VERDICTS),
  fireChannel: z.enum(FIRE_CHANNELS).nullable(),
  /** The reading judged; null on muted arrivals. */
  driftP: z.number().nullable(),
  /** The segment's baseline before the arrival joined it. */
  mu: z.number().nullable(),
  sigma: z.number().nullable(),
  zScore: z.number().nullable(),
  /** The level the reading was judged against, as stored; null on muted arrivals. */
  immediateThreshold: z.number().nullable(),
  /** The rewrite behind the reading, when one landed. */
  rewrittenText: z.string().nullable(),
  /** Null when no rewrite was tried. */
  expandOutcome: z.enum(EXPAND_OUTCOMES).nullable(),
});

export const liveAnalysisSegmentSchema = z.object({
  /** The segment's place in the live chain, from 1. */
  index: z.number(),
  segmentId: id,
  /** The user message whose arrival opened the segment. */
  startMessageId: id,
  arrivalCount: z.number(),
  /** The channel of the fired arrival that closed the segment; null while it is open. */
  closedByChannel: z.enum(FIRE_CHANNELS).nullable(),
  createdAt: instant,
});

/** A Thread's live reading, exactly as the store has it. */
export const liveAnalysisViewSchema = z.object({
  threadId: id,
  mode: z.enum(THREAD_ANALYSIS_MODES),
  params: z.object({
    coldStartTurns: z.number(),
    immediate: z.object({
      stdDevs: z.number(),
      minStdDev: z.number(),
      bootstrapThreshold: z.number(),
    }),
    slow: z.object({
      fireBudget: z.number(),
      minRiseRequired: z.number(),
      minSamples: z.number(),
    }),
    embeddingModelId: z.string(),
  }),
  segments: z.array(liveAnalysisSegmentSchema),
  points: z.array(liveAnalysisPointSchema),
  /** True while some user arrivals have no verdict yet. */
  pending: z.boolean(),
});
export type ExpandOutcome = (typeof EXPAND_OUTCOMES)[number];
export type LiveAnalysisPoint = Wire<typeof liveAnalysisPointSchema>;
export type LiveAnalysisSegment = Wire<typeof liveAnalysisSegmentSchema>;
export type LiveAnalysisView = Wire<typeof liveAnalysisViewSchema>;

const analysisReplies = {
  200: liveAnalysisViewSchema,
  400: errorBody,
  403: errorBody,
  404: errorBody,
  502: errorBody,
};

/** The Thread's live reading. */
export const threadAnalysis = endpoint({
  method: 'GET',
  path: '/api/threads/:id/analysis',
  params: threadParams,
  replies: analysisReplies,
});

/** Fills the Thread's missing verdicts, then answers its live reading. 403 while analysis is off. */
export const backfillThreadAnalysis = endpoint({
  method: 'POST',
  path: '/api/threads/:id/analysis/backfill',
  params: threadParams,
  replies: analysisReplies,
});
