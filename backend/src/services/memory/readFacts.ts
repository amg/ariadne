import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import type { FactCategory, Message } from '@db/types';
import type { CapturedFact } from '@queries/memoryCaptureProgress/recordSegmentCapture';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { type NearUserFact, listNearestUserFacts } from '@queries/userFacts/listNearestUserFacts';
import { listSeedableUserFacts } from '@queries/userFacts/listSeedableUserFacts';
import {
  EMBEDDING_MODEL_ID,
  type FactCandidate,
  computeEmbeddingCostUsd,
  computeInferenceCostUsd,
  embedText,
  extractFacts,
  judgeFactDuplicate,
} from '@services/aiService';
import { type Result, err, ok } from '../../types/result';
import { factsNamedIn } from './factsNamedIn';

/** One Turn of the scope Facts are captured from. */
export interface CaptureTurn {
  userMessage: Message;
  assistantReply: Message | null;
}

type ReadFactsProps = {
  userId: string;
  /** The scope, in conversation order. */
  turns: CaptureTurn[];
  blockedCategories: readonly FactCategory[];
  /** The message the read's spend is recorded against. */
  spendMessageId: string;
  /**
   * The segment's `captured_through_at` pointer: Turns at or before it have
   * already been captured, and go to the model only as context. Null on a
   * first pass, when every Turn is new.
   */
  capturedThroughAt: Date | null;
};

/** Closer than this a candidate is the same sentence again; no check needed. */
const IDENTICAL_DISTANCE = 0.02;
/**
 * Closer than this a candidate may restate or correct a known Fact; the
 * duplicate check decides.
 */
const NEAR_DUPLICATE_DISTANCE = 0.15;
const NEIGHBOUR_COUNT = 5;
/** Per-message caps keep one long reply from crowding the scope out. */
const MAX_USER_CHARS = 4000;
const MAX_ASSISTANT_CHARS = 1500;

interface CallSpend {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
}

/** Spend of one read, summed per call kind. */
interface ReadSpend {
  extraction: CallSpend;
  duplicateCheck: CallSpend;
  embedding: CallSpend;
}

function emptySpend(): ReadSpend {
  return {
    extraction: { costUsd: 0, promptTokens: 0, completionTokens: 0 },
    duplicateCheck: { costUsd: 0, promptTokens: 0, completionTokens: 0 },
    embedding: { costUsd: 0, promptTokens: 0, completionTokens: 0 },
  };
}

/**
 * Records each call kind's spend. A line the ledger rejects (a cost that
 * is not a finite number, which means a pricing bug) is logged and
 * skipped: failing the read over it would only re-run the extraction
 * and spend again.
 */
async function recordSpend(spendMessageId: string, spend: ReadSpend): Promise<void> {
  const lines = [
    { kind: 'fact_extraction', model: env.MEMORY_MODEL, spent: spend.extraction },
    { kind: 'fact_duplicate_check', model: env.MEMORY_MODEL, spent: spend.duplicateCheck },
    { kind: 'fact_embedding', model: EMBEDDING_MODEL_ID, spent: spend.embedding },
  ] as const;
  for (const { kind, model, spent } of lines) {
    if (spent.promptTokens === 0) continue;
    try {
      await addSideCost({
        messageId: spendMessageId,
        kind,
        model,
        costUsd: spent.costUsd.toFixed(10),
        promptTokens: spent.promptTokens,
        completionTokens: spent.completionTokens,
      });
    } catch (error) {
      console.error(`[readFacts] ${kind} spend not recorded:`, error);
    }
  }
}

/** Cosine distance between two vectors, 0 = identical direction. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const norms = Math.sqrt(normA) * Math.sqrt(normB);
  return norms === 0 ? 1 : 1 - dot / norms;
}

/**
 * The user's current Facts closest to a vector, nearest first, as they
 * stand once the Facts read so far are stored: those read so far count as
 * known, and the stored Facts they replace no longer do.
 */
async function nearestKnownFacts(
  userId: string,
  embedding: number[],
  readSoFar: CapturedFact[],
): Promise<NearUserFact[]> {
  const replacedIds = new Set(
    readSoFar.flatMap((fact) => (fact.replacesFactId === null ? [] : [fact.replacesFactId])),
  );
  const stored = await listNearestUserFacts({
    userId,
    embedding,
    modelId: EMBEDDING_MODEL_ID,
    limit: NEIGHBOUR_COUNT + replacedIds.size,
  });
  const pending = readSoFar
    .filter((fact) => !replacedIds.has(fact.id))
    .map((fact) => ({
      id: fact.id,
      content: fact.row.content,
      suppressed: fact.row.suppressed ?? false,
      distance: cosineDistance(embedding, fact.row.embedding),
    }));
  return [...stored.filter((fact) => !replacedIds.has(fact.id)), ...pending]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, NEIGHBOUR_COUNT);
}

/**
 * The known Fact a candidate restates or corrects, or null when it is
 * about something new. Identical sentences and far-away ones need no
 * model call; only near neighbours are checked.
 */
async function factReplacedByOrNull(
  candidate: string,
  neighbours: NearUserFact[],
  spend: ReadSpend,
): Promise<Result<NearUserFact | null>> {
  const near = neighbours.filter((fact) => fact.distance < NEAR_DUPLICATE_DISTANCE);
  const nearest = near[0];
  if (nearest === undefined) return ok(null);
  if (nearest.distance < IDENTICAL_DISTANCE) return ok(nearest);

  const judged = await judgeFactDuplicate({
    candidate,
    knownFacts: near.map((fact) => fact.content),
  });
  if (judged.type === 'error') return judged;
  const { promptTokens, completionTokens } = judged.data.usage;
  spend.duplicateCheck.promptTokens += promptTokens;
  spend.duplicateCheck.completionTokens += completionTokens;
  spend.duplicateCheck.costUsd += await computeInferenceCostUsd(
    env.MEMORY_MODEL,
    promptTokens,
    completionTokens,
  );
  const { verdict } = judged.data;
  return ok(verdict.type === 'same' ? (near[verdict.knownIndex] ?? null) : null);
}

/**
 * Embeds and checks one candidate against the Facts known so far: it is a
 * new Fact, or it takes the place of the known Fact it restates or
 * corrects, whose suppression it keeps. The newest statement wins, even
 * over a sentence edited by hand.
 */
async function readCandidate(input: {
  userId: string;
  candidate: FactCandidate;
  turns: CaptureTurn[];
  readSoFar: CapturedFact[];
  spend: ReadSpend;
}): Promise<Result<CapturedFact>> {
  const { userId, candidate, turns, readSoFar, spend } = input;
  const embedded = await embedText(candidate.content);
  if (embedded.type === 'error') return embedded;
  spend.embedding.promptTokens += embedded.data.promptTokens;
  spend.embedding.costUsd += await computeEmbeddingCostUsd(embedded.data.promptTokens);

  const neighbours = await nearestKnownFacts(userId, embedded.data.embedding, readSoFar);
  const replaced = await factReplacedByOrNull(candidate.content, neighbours, spend);
  if (replaced.type === 'error') return replaced;

  const sourceTurn = turns[candidate.turnIndex] ?? turns[turns.length - 1];
  return ok({
    id: randomUUID(),
    row: {
      userId,
      content: candidate.content,
      category: candidate.category,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      embedding: embedded.data.embedding,
      modelId: EMBEDDING_MODEL_ID,
      sourceMessageId: sourceTurn?.userMessage.id ?? null,
      validAt: candidate.validAt,
      suppressed: replaced.data?.suppressed ?? false,
    },
    replacesFactId: replaced.data?.id ?? null,
  });
}

/**
 * The Memory's Facts that name someone or something the Turns mention,
 * as background for reading them: a segment opening on "he and Kuro"
 * learns what Kuro is from the Fact that says so.
 */
async function knownFactsFor(
  userId: string,
  blockedCategories: readonly FactCategory[],
  turns: { userText: string; assistantText: string | null }[],
): Promise<string[]> {
  const facts = await listSeedableUserFacts({ userId, blockedCategories });
  const text = turns.map((turn) => `${turn.userText}\n${turn.assistantText ?? ''}`).join('\n');
  return factsNamedIn(
    facts.map((fact) => fact.content),
    text,
  );
}

/**
 * Reads Facts about the user from an ordered run of Turns, extracting
 * only the ones newer than the segment's pointer (earlier turns ride along
 * as context), with the Facts already known about what they mention as
 * background. Drops blocked categories, then checks each candidate
 * against the known Facts and the ones read before it, so the result says
 * which are new and which replace a known Fact. Stores no Fact; the spend
 * is recorded, even when the read fails part-way.
 */
export async function readFacts({
  userId,
  turns,
  blockedCategories,
  spendMessageId,
  capturedThroughAt,
}: ReadFactsProps): Promise<Result<CapturedFact[]>> {
  if (turns.length === 0) return ok([]);

  // Scope Turns through the pointer are context; anything after is new.
  const contextCount =
    capturedThroughAt === null
      ? 0
      : turns.filter((turn) => turn.userMessage.createdAt.getTime() <= capturedThroughAt.getTime())
          .length;
  if (contextCount === turns.length) return ok([]);

  const spend = emptySpend();
  try {
    const extractionTurns = turns.map((turn) => ({
      date: turn.userMessage.createdAt,
      userText: turn.userMessage.content.slice(0, MAX_USER_CHARS),
      assistantText: turn.assistantReply?.content.slice(0, MAX_ASSISTANT_CHARS) ?? null,
    }));
    const extracted = await extractFacts({
      turns: extractionTurns,
      contextCount,
      knownFacts: await knownFactsFor(userId, blockedCategories, extractionTurns),
      blockedCategories,
    });
    if (extracted.type === 'error') return extracted;
    const { promptTokens, completionTokens } = extracted.data.usage;
    spend.extraction = {
      promptTokens,
      completionTokens,
      costUsd: await computeInferenceCostUsd(env.MEMORY_MODEL, promptTokens, completionTokens),
    };

    if (extracted.data.candidates === null) {
      return err('fact_extraction_unreadable', 'The extraction reply carried no readable facts.');
    }
    const allowed = extracted.data.candidates.filter(
      // Only facts from the new Turns count; whatever the model pulls out
      // of context turns is already captured (or edited away).
      (candidate) =>
        candidate.turnIndex >= contextCount && !blockedCategories.includes(candidate.category),
    );
    const readSoFar: CapturedFact[] = [];
    for (const candidate of allowed) {
      const read = await readCandidate({ userId, candidate, turns, readSoFar, spend });
      if (read.type === 'error') return read;
      readSoFar.push(read.data);
    }
    return ok(readSoFar);
  } finally {
    await recordSpend(spendMessageId, spend);
  }
}
