import { env } from '@config/env';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { type Result, ok } from '../../types/result';
import { EMBEDDING_MODEL_ID } from '../aiService';
import { DEFAULT_ANALYZE_OPTIONS, type GateVerdict } from './types';
import type { JudgingParams } from './verdict';

/**
 * The Analysis tab's data contract: a plain read of the
 * persisted live chain — segments, one drift row per arrival, and the
 * judging params the points were produced with. No recomputation, no
 * provider calls: whatever the surface finds here is what the thread last
 * persisted; missing signals show up as `pending: true` and the tab
 * renders its loading state.
 */

/** One arrival as the Analysis tab charts it. */
export interface LiveAnalysisPoint {
  messageId: string;
  /** 1-based arrival ordinal — the chart's x axis. */
  turnNumber: number;
  /** 1-based index of the segment the arrival was judged in. */
  segmentIndex: number;
  verdict: GateVerdict;
  fireChannel: 'immediate' | 'slow' | null;
  /** The composite reading judged; null on muted arrivals. */
  driftP: number | null;
  /** Ledger snapshot at judgment — BEFORE the arrival joined it. */
  mu: number | null;
  sigma: number | null;
  zScore: number | null;
  /**
   * The immediate criterion the reading was judged against: μ +
   * k·max(σ, σ_floor) once the ledger warms, the flat T_segment while it
   * bootstraps. The chart's trigger series; derivable only for judged
   * arrivals.
   */
  immediateThreshold: number | null;
  /** The self-contained rewrite behind the reading, when one landed. */
  expandedText: string | null;
}

/** One live-chain segment as the Analysis tab lists it. */
export interface LiveAnalysisSegment {
  /** 1-based segment index in the live chain. */
  index: number;
  segmentId: string;
  /** The user Message whose arrival opened the segment. */
  startMessageId: string;
  /** The opening user message's content — the segment's label. */
  label: string;
  /** Number of arrivals judged inside the segment (muted included). */
  arrivalCount: number;
  /** True when a fired arrival closed this segment. */
  closed: boolean;
  createdAt: string;
}

/** The thread's live reading: exactly what the store has persisted. */
export interface LiveAnalysisView {
  threadId: string;
  mode: 'off' | 'heuristic' | 'always';
  params: JudgingParams & { embeddingModelId: string };
  segments: LiveAnalysisSegment[];
  points: LiveAnalysisPoint[];
  /** True while user arrivals have no verdict row yet — the tab's loading state. */
  pending: boolean;
}

/** Emitted when the feature flag is off: the surface is gone entirely. */
async function analyzeModeOffView(threadId: string): Promise<LiveAnalysisView> {
  return {
    threadId,
    mode: 'off',
    params: { ...DEFAULT_ANALYZE_OPTIONS, embeddingModelId: EMBEDDING_MODEL_ID },
    segments: [],
    points: [],
    pending: false,
  };
}

/**
 * Reads the persisted live chain for a thread. `pending` marks threads
 * whose arrivals outrun the stored verdict rows — regardless of why the
 * surface (a failed pipeline, a pre-feature thread, a fresh `off` period)
 * left them unfilled.
 */
export async function buildLiveAnalysisView(threadId: string): Promise<Result<LiveAnalysisView>> {
  const mode = env.THREAD_ANALYSIS_MODE;
  if (mode === 'off') return ok(await analyzeModeOffView(threadId));

  const params = { ...DEFAULT_ANALYZE_OPTIONS, embeddingModelId: EMBEDDING_MODEL_ID };

  const [messageRows, segments, logs] = await Promise.all([
    listMessagesByThread({ threadId }),
    listThreadSegmentsByThread({ threadId }),
    listSegmentDriftLogsByThread({ threadId }),
  ]);

  const messages = messageRows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  }));
  const userMessages = messages.filter((message) => message.role === 'user');

  const segmentIndexById = new Map(segments.map((segment, index) => [segment.id, index + 1]));

  const arrivalTurnByMessageId = new Map(
    userMessages.map((message, index) => [message.id, index + 1]),
  );

  const arrivalRows = await listMessageEmbeddingsByMessageIds({
    messageIds: userMessages.map((message) => message.id),
  });
  const expandedTextById = new Map(
    arrivalRows
      .filter((row) => row.modelId === EMBEDDING_MODEL_ID && row.expandedText !== null)
      .map((row) => [row.messageId, row.expandedText]),
  );

  const loggedByMessageId = new Set(logs.map((log) => log.messageId));
  const contentById = new Map(messages.map((message) => [message.id, message.content]));

  const points: LiveAnalysisPoint[] = logs.map((log) => {
    const ledgerWarm = log.mu !== null && log.sigma !== null;
    const immediateThreshold =
      log.driftP === null
        ? null
        : ledgerWarm
          ? (log.mu as number) +
            params.immediateK * Math.max(log.sigma as number, params.sigmaFloor)
          : params.segmentThreshold;
    return {
      messageId: log.messageId,
      turnNumber: arrivalTurnByMessageId.get(log.messageId) ?? 0,
      segmentIndex: segmentIndexById.get(log.segmentId) ?? 0,
      verdict: log.verdict as GateVerdict,
      fireChannel: log.fireChannel as 'immediate' | 'slow' | null,
      driftP: log.driftP,
      mu: log.mu,
      sigma: log.sigma,
      zScore: log.zScore,
      immediateThreshold,
      expandedText: expandedTextById.get(log.messageId) ?? null,
    };
  });

  // Live segment spans: a segment's arrivals run from its opening message
  // up to (not including) the next segment's — chronology, no end column.
  const arrivalCountBySegment = new Map<number, number>();
  for (const point of points) {
    arrivalCountBySegment.set(
      point.segmentIndex,
      (arrivalCountBySegment.get(point.segmentIndex) ?? 0) + 1,
    );
  }

  const segmentView: LiveAnalysisSegment[] = segments.map((segment, index) => {
    const next = segments[index + 1];
    return {
      index: index + 1,
      segmentId: segment.id,
      startMessageId: segment.startMessageId,
      label: contentById.get(segment.startMessageId) ?? '',
      arrivalCount: arrivalCountBySegment.get(index + 1) ?? 0,
      closed: next !== undefined,
      createdAt: segment.createdAt.toISOString(),
    };
  });

  return ok({
    threadId,
    mode,
    params,
    segments: segmentView,
    points,
    pending: userMessages.length > loggedByMessageId.size,
  });
}
