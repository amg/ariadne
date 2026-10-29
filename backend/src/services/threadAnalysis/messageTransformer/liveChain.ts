import type { MessageEmbedding, MessageExpansion } from '@db/types';
import { listStoredEmbeddings } from '@queries/messageEmbeddings/listStoredEmbeddings';
import { listMessageExpansionsByMessageIds } from '@queries/messageExpansions/listMessageExpansionsByMessageIds';
import { listLiveMessagesByThread } from '@queries/messages/listLiveMessagesByThread';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { EMBEDDING_MODEL_ID } from '../../aiService';
import type { LiveArrival, LiveChain, LoggedVerdict } from '../types';
import { liveArrivalsOf } from './liveArrivals';

/** A segment row as the chain knows it: its id and the arrival that starts it. */
interface ChainSegment {
  id: string;
  startMessageId: string;
}

/**
 * How many of the newest arrivals have their vectors, and their replies'
 * vectors, read with the chain. A judgment needs the arriving Message's
 * vector and the previous reply's. Older vectors are read only by a pass
 * that has to rebuild the gate's state from the first arrival.
 */
const ARRIVALS_READ_WITH_VECTORS = 2;

/**
 * Reads the Thread's live chain in a fixed number of queries, whatever
 * the Thread's length, with the vectors of its newest arrivals alone.
 */
export async function readLiveChain(threadId: string): Promise<LiveChain> {
  const arrivals = liveArrivalsOf(await listLiveMessagesByThread({ threadId }));
  return {
    threadId,
    arrivals,
    ...(await readStoredJudgments({ threadId, arrivals })),
  };
}

/** Reads what is stored now for the given arrivals and their replies. */
export async function readStoredJudgments({
  threadId,
  arrivals,
}: Pick<LiveChain, 'threadId' | 'arrivals'>) {
  const [embeddings, expansions, logs, segments] = await Promise.all([
    listStoredEmbeddings({
      messageIds: messageIdsOf(arrivals),
      vectorsFor: messageIdsOf(arrivals.slice(-ARRIVALS_READ_WITH_VECTORS)),
      modelId: EMBEDDING_MODEL_ID,
    }),
    listMessageExpansionsByMessageIds({
      messageIds: arrivals.map((arrival) => arrival.userMessage.id),
    }),
    listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
    listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
  ]);
  return {
    embedded: new Set(embeddings.map((row) => row.messageId)),
    vectors: new Map(
      embeddings.flatMap((row) =>
        row.vectorOrNull === null ? [] : [[row.messageId, row.vectorOrNull] as const],
      ),
    ),
    expansions: new Map(expansions.map((row) => [row.messageId, row])),
    verdicts: new Map(logs.map((log) => [log.messageId, log])),
    segmentIdByStart: new Map(segments.map((segment) => [segment.startMessageId, segment.id])),
  };
}

/** The arrivals' Messages and their replies', in chronology. */
function messageIdsOf(arrivals: readonly LiveArrival[]) {
  return arrivals.flatMap((arrival) =>
    arrival.assistantReply
      ? [arrival.userMessage.id, arrival.assistantReply.id]
      : [arrival.userMessage.id],
  );
}

/** The chain with one more stored embedding row. */
export function withEmbedding(chain: LiveChain, row: MessageEmbedding): LiveChain {
  return {
    ...chain,
    embedded: new Set(chain.embedded).add(row.messageId),
    vectors: new Map(chain.vectors).set(row.messageId, row.embedding),
  };
}

/**
 * The Message's stored vector, with the chain that holds it. A vector
 * the chain knows is stored but has not read yet is read from the
 * database. Null when none is stored under the current embedding model.
 */
export async function storedVectorAndChainOrNull(chain: LiveChain, messageId: string) {
  const held = chain.vectors.get(messageId);
  if (held !== undefined) return { vector: held, chain };
  if (!chain.embedded.has(messageId)) return null;
  const withRead = await withVectorsOf(chain, [messageId]);
  const vector = withRead.vectors.get(messageId);
  return vector === undefined ? null : { vector, chain: withRead };
}

/** The chain holding every stored vector of its arrivals and replies, as a walk from the first arrival needs. */
export function withEveryVector(chain: LiveChain) {
  return withVectorsOf(chain, messageIdsOf(chain.arrivals));
}

/** The chain with the stored vectors of the given Messages, read in one query for those it does not hold yet. */
async function withVectorsOf(chain: LiveChain, messageIds: readonly string[]) {
  const missing = messageIds.filter((id) => chain.embedded.has(id) && !chain.vectors.has(id));
  if (missing.length === 0) return chain;
  const rows = await listStoredEmbeddings({
    messageIds: missing,
    vectorsFor: missing,
    modelId: EMBEDDING_MODEL_ID,
  });
  const vectors = new Map(chain.vectors);
  for (const row of rows) {
    if (row.vectorOrNull !== null) vectors.set(row.messageId, row.vectorOrNull);
  }
  return { ...chain, vectors };
}

/** The chain with one more stored expansion row. */
export function withExpansion(chain: LiveChain, row: MessageExpansion): LiveChain {
  return {
    ...chain,
    expansions: new Map(chain.expansions).set(row.messageId, row),
  };
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

/** True when the arrival's completed Turn, if it has one, is embedded under the current model. */
function isTurnFolded(chain: LiveChain, arrival: LiveArrival) {
  if (!arrival.assistantReply) return true;
  return chain.embedded.has(arrival.assistantReply.id);
}

/** True when the arrival has its verdict stored and its completed Turn folded. */
export function isArrivalFinished(chain: LiveChain, arrival: LiveArrival) {
  return chain.verdicts.has(arrival.userMessage.id) && isTurnFolded(chain, arrival);
}
