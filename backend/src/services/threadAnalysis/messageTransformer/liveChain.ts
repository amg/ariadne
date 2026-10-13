import type { MessageEmbedding, SegmentDriftLog } from '@db/types';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { EMBEDDING_MODEL_ID } from '../../aiService';
import { type LiveTurnRow, buildLiveTurns } from './liveTurns';

/** What a stored verdict tells the gate about its arrival. */
export type LoggedVerdict = Pick<
  SegmentDriftLog,
  'segmentId' | 'verdict' | 'fireChannel' | 'slowDriftStartMessageId'
>;

/** A segment row as the chain knows it: its id and the arrival that starts it. */
export interface ChainSegment {
  id: string;
  startMessageId: string;
}

/** What the database holds for a live chain under the current embedding model. */
export interface StoredJudgments {
  /** Stored embedding rows of the live arrivals and their replies, by Message. */
  embeddings: ReadonlyMap<string, MessageEmbedding>;
  /** Stored verdicts by arrival. */
  verdicts: ReadonlyMap<string, LoggedVerdict>;
  /** Stored segment ids by the arrival that starts them. */
  segmentIdByStart: ReadonlyMap<string, string>;
}

/**
 * One gate pass's view of a Thread's live chain: read from the database
 * once, then carried from step to step. A step that stores rows returns a
 * new chain holding them, so no step reads the same rows again.
 */
export interface LiveChain extends StoredJudgments {
  threadId: string;
  /** The live conversation's arrivals in order; abandoned rows are out. */
  arrivals: readonly LiveTurnRow[];
}

/** Reads the Thread's live chain: four queries, whatever the Thread's length. */
export async function readLiveChain(threadId: string): Promise<LiveChain> {
  const rows = await listMessagesByThread({ threadId });
  const arrivals = buildLiveTurns(rows.filter((row) => !row.abandoned));
  return { threadId, arrivals, ...(await readStoredJudgments({ threadId, arrivals })) };
}

/** Reads what is stored now for the given arrivals and their replies. */
export async function readStoredJudgments({
  threadId,
  arrivals,
}: Pick<LiveChain, 'threadId' | 'arrivals'>): Promise<StoredJudgments> {
  const messageIds = arrivals.flatMap((arrival) =>
    arrival.assistantReply
      ? [arrival.userMessage.id, arrival.assistantReply.id]
      : [arrival.userMessage.id],
  );
  const [embeddings, logs, segments] = await Promise.all([
    listMessageEmbeddingsByMessageIds({ messageIds }),
    listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
    listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
  ]);
  return {
    embeddings: new Map(embeddings.map((row) => [row.messageId, row])),
    verdicts: new Map(logs.map((log) => [log.messageId, log])),
    segmentIdByStart: new Map(segments.map((segment) => [segment.startMessageId, segment.id])),
  };
}

/** The chain with one more stored embedding row. */
export function withEmbedding(chain: LiveChain, row: MessageEmbedding): LiveChain {
  return { ...chain, embeddings: new Map(chain.embeddings).set(row.messageId, row) };
}

/** The chain with an arrival's stored verdict, if any, and the segments it opened. */
export function withJudgment(
  chain: LiveChain,
  judgment: {
    messageId: string;
    verdict: LoggedVerdict | null;
    openedSegments: readonly ChainSegment[];
  },
): LiveChain {
  const segmentIdByStart = new Map(chain.segmentIdByStart);
  for (const segment of judgment.openedSegments) {
    segmentIdByStart.set(segment.startMessageId, segment.id);
  }
  const verdicts =
    judgment.verdict === null
      ? chain.verdicts
      : new Map(chain.verdicts).set(judgment.messageId, judgment.verdict);
  return { ...chain, verdicts, segmentIdByStart };
}

/** The stored vector under the current embedding model; null when none is stored. */
export function currentModelVectorOrNull(row: MessageEmbedding | undefined): number[] | null {
  if (!row || row.embedding === null || row.modelId !== EMBEDDING_MODEL_ID) return null;
  return row.embedding;
}

/** True when the arrival's completed Turn, if it has one, is embedded under the current model. */
export function isTurnFolded(chain: LiveChain, arrival: LiveTurnRow): boolean {
  if (!arrival.assistantReply) return true;
  return currentModelVectorOrNull(chain.embeddings.get(arrival.assistantReply.id)) !== null;
}

/** True when the arrival has its verdict stored and its completed Turn folded. */
export function isArrivalFinished(chain: LiveChain, arrival: LiveTurnRow): boolean {
  return chain.verdicts.has(arrival.userMessage.id) && isTurnFolded(chain, arrival);
}
