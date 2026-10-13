import { env } from '@config/env';
import type { ExpandOutcome } from '@db/types';
import { listMessageExpansionsByMessageIds } from '@queries/messageExpansions/listMessageExpansionsByMessageIds';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { type Result, ok } from '../../types/result';
import { EMBEDDING_MODEL_ID } from '../aiService';
import { DEFAULT_ANALYZE_OPTIONS, type GateVerdict } from './types';
import type { JudgingParams } from './verdict';

/**
 * The Analysis tab's data contract: a plain read of the thread's live
 * chain under the current embedding model — segments, one drift row per
 * arrival, and the judging params the points were produced with. No
 * recomputation, no provider calls: whatever the surface finds here is
 * what the thread last persisted; a retired model's chain stays stored
 * but invisible, and missing signals show up as `pending: true` so the
 * tab renders its loading state.
 */

/** One arrival as the Analysis tab reads it. */
export interface LiveAnalysisPoint {
  messageId: string;
  /** The arrival's user-message text — the segment table's rows. */
  messageText: string;
  /** 1-based arrival ordinal — the chart's x axis. */
  turnNumber: number;
  /**
   * 1-based index of the segment whose span holds the arrival —
   * membership, not the judging segment. A fired arrival is the Boundary
   * turn that closes one segment and seeds the next, so it lists under
   * the segment it opens; the drift log keeps the burned segment as the
   * judged-in one.
   */
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
   * k·max(σ, σ_floor) once the baseline warms, the flat T_segment while it
   * bootstraps. The chart's trigger series; derivable only for judged
   * arrivals.
   */
  immediateThreshold: number | null;
  /** The self-contained rewrite behind the reading, when one landed. */
  rewrittenText: string | null;
  /**
   * The recorded end of the arrival's try at a rewrite. `accepted` renders
   * the rewrite cell as today; any `failed_*` marks the cell so the tab can
   * surface why the arrival fell back to its raw text; null means no rewrite
   * was attempted and the raw message stood on its own.
   */
  expandOutcome: ExpandOutcome | null;
}

/** One live-chain segment as the Analysis tab lists it. */
export interface LiveAnalysisSegment {
  /** 1-based segment index in the live chain. */
  index: number;
  segmentId: string;
  /** The user Message whose arrival opened the segment. */
  startMessageId: string;
  /** Number of arrivals that landed in the segment's span (muted included). */
  arrivalCount: number;
  /** True when a fired arrival closed this segment. */
  closedByChannel: 'immediate' | 'slow' | null;
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
    params: {
      ...DEFAULT_ANALYZE_OPTIONS,
      embeddingModelId: EMBEDDING_MODEL_ID,
    },
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

  const params = {
    ...DEFAULT_ANALYZE_OPTIONS,
    embeddingModelId: EMBEDDING_MODEL_ID,
  };

  const [messageRows, allSegments, allLogs] = await Promise.all([
    listMessagesByThread({ threadId }),
    listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
    listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
  ]);

  // Abandoned arrivals stay out of the reading: their rows, segments and
  // drift logs stay stored (usage keeps tracking them) but the view only
  // composes the live thread.
  const abandonedIds = new Set(messageRows.filter((row) => row.abandoned).map((row) => row.id));
  const liveRows = messageRows.filter((row) => !row.abandoned);
  const segments = allSegments.filter((segment) => !abandonedIds.has(segment.startMessageId));
  const logs = allLogs.filter((log) => !abandonedIds.has(log.messageId));

  const messages = liveRows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  }));
  const userMessages = messages.filter((message) => message.role === 'user');

  const arrivalTurnByMessageId = new Map(
    userMessages.map((message, index) => [message.id, index + 1]),
  );

  // Membership follows the segment SPAN, not the judging row: the segment
  // a drift log names is the baseline that judged the arrival — for a fired
  // arrival that is the segment it burned — while the Boundary turn closes
  // the current Topic segment and seeds the next one, so it lists under
  // the segment it opens. An arrival belongs to the last segment whose own
  // opening arrival stands at or before it.
  const segmentOpeners = segments.map((segment, index) => ({
    openTurn: arrivalTurnByMessageId.get(segment.startMessageId) ?? 0,
    index: index + 1,
  }));
  const memberSegmentIndex = (turnNumber: number): number => {
    let index = 1;
    for (const opener of segmentOpeners) {
      if (opener.openTurn <= turnNumber) index = opener.index;
    }
    return index;
  };

  const arrivalRows = await listMessageExpansionsByMessageIds({
    messageIds: userMessages.map((message) => message.id),
  });
  const rewrittenTextById = new Map(
    arrivalRows.flatMap((row) =>
      row.expandedText === null ? [] : [[row.messageId, row.expandedText] as const],
    ),
  );
  const expandOutcomeById = new Map(arrivalRows.map((row) => [row.messageId, row.expandOutcome]));

  const loggedByMessageId = new Set(logs.map((log) => log.messageId));
  const contentById = new Map(messages.map((message) => [message.id, message.content]));

  const points: LiveAnalysisPoint[] = logs.map((log) => {
    const baselineWarm = log.mu !== null && log.sigma !== null;
    const immediateThreshold =
      log.driftP === null
        ? null
        : baselineWarm
          ? (log.mu as number) +
            params.immediateK * Math.max(log.sigma as number, params.sigmaFloor)
          : params.segmentThreshold;
    const turnNumber = arrivalTurnByMessageId.get(log.messageId) ?? 0;
    return {
      messageId: log.messageId,
      messageText: contentById.get(log.messageId) ?? '',
      turnNumber,
      segmentIndex: memberSegmentIndex(turnNumber),
      verdict: log.verdict as GateVerdict,
      fireChannel: log.fireChannel,
      driftP: log.driftP,
      mu: log.mu,
      sigma: log.sigma,
      zScore: log.zScore,
      immediateThreshold,
      rewrittenText: rewrittenTextById.get(log.messageId) ?? null,
      expandOutcome: expandOutcomeById.get(log.messageId) ?? null,
    };
  });

  // Live segment spans: a segment's arrivals run from its opening message
  // up to (not including) the next segment's — chronology, no end column;
  // a fired arrival already counts toward the segment it opened (above).
  const arrivalCountBySegment = new Map<number, number>();
  for (const point of points) {
    arrivalCountBySegment.set(
      point.segmentIndex,
      (arrivalCountBySegment.get(point.segmentIndex) ?? 0) + 1,
    );
  }
  const segmentView: LiveAnalysisSegment[] = segments.map((segment, index) => {
    const next = segments[index + 1];
    const nextLog = next ? logs.find((log) => log.messageId === next.startMessageId) : undefined;
    return {
      index: index + 1,
      segmentId: segment.id,
      startMessageId: segment.startMessageId,
      arrivalCount: arrivalCountBySegment.get(index + 1) ?? 0,
      closedByChannel: next ? (nextLog?.fireChannel as 'immediate' | 'slow') : null,
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
