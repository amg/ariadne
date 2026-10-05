import { env } from '@config/env';
import type { FactCategory, Message } from '@db/types';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { listNearestUserFacts } from '@queries/userFacts/listNearestUserFacts';
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

/** One Turn of the scope Facts are captured from. */
export interface CaptureTurn {
  userMessage: Message;
  assistantReply: Message | null;
}

type CaptureFactsProps = {
  userId: string;
  /** The scope, in conversation order. */
  turns: CaptureTurn[];
  blockedCategories: readonly FactCategory[];
  /** The message the capture's spend is recorded against. */
  spendMessageId: string;
  /**
   * The segment's `captured_through_at` pointer: Turns at or before it have
   * already been captured, and go to the model only as context. Null on a
   * first pass, when every Turn is new.
   */
  capturedThroughAt: Date | null;
};

export interface CaptureFactsOutcome {
  added: number;
  skippedAsDuplicate: number;
}

/** Closer than this a candidate is the same sentence again; no check needed. */
const IDENTICAL_DISTANCE = 0.02;
/** Closer than this a candidate may restate a known Fact; the duplicate check decides. */
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

/** Spend of one capture run, summed per call kind. */
interface CaptureSpend {
  extraction: CallSpend;
  duplicateCheck: CallSpend;
  embedding: CallSpend;
}

function emptySpend(): CaptureSpend {
  return {
    extraction: { costUsd: 0, promptTokens: 0, completionTokens: 0 },
    duplicateCheck: { costUsd: 0, promptTokens: 0, completionTokens: 0 },
    embedding: { costUsd: 0, promptTokens: 0, completionTokens: 0 },
  };
}

/**
 * Records each call kind's spend. A line the ledger rejects (a cost that
 * is not a finite number, which means a pricing bug) is logged and
 * skipped: failing the capture over it would only re-run the extraction
 * and spend again.
 */
async function recordSpend(spendMessageId: string, spend: CaptureSpend): Promise<void> {
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
      console.error(`[captureFacts] ${kind} spend not recorded:`, error);
    }
  }
}

/**
 * Decides whether a candidate is already known. Identical sentences and
 * far-away ones need no model call; only near neighbours are checked.
 */
async function isKnownFact(
  userId: string,
  candidate: string,
  embedding: number[],
  spend: CaptureSpend,
): Promise<Result<boolean>> {
  const neighbours = await listNearestUserFacts({
    userId,
    embedding,
    modelId: EMBEDDING_MODEL_ID,
    limit: NEIGHBOUR_COUNT,
  });
  const near = neighbours.filter((fact) => fact.distance < NEAR_DUPLICATE_DISTANCE);
  if (near.length === 0) return ok(false);
  if ((near[0]?.distance ?? 1) < IDENTICAL_DISTANCE) return ok(true);

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
  return ok(judged.data.verdict === 'duplicate');
}

/** Embeds, checks, and stores one candidate; true when a new Fact landed. */
async function storeCandidate(input: {
  userId: string;
  candidate: FactCandidate;
  turns: CaptureTurn[];
  spend: CaptureSpend;
}): Promise<Result<boolean>> {
  const { userId, candidate, turns, spend } = input;
  const embedded = await embedText(candidate.content);
  if (embedded.type === 'error') return embedded;
  spend.embedding.promptTokens += embedded.data.promptTokens;
  spend.embedding.costUsd += await computeEmbeddingCostUsd(embedded.data.promptTokens);

  const known = await isKnownFact(userId, candidate.content, embedded.data.embedding, spend);
  if (known.type === 'error') return known;
  if (known.data) return ok(false);

  const sourceTurn = turns[candidate.turnIndex] ?? turns[turns.length - 1];
  await insertUserFact({
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
  });
  return ok(true);
}

/**
 * Captures Facts about the user from an ordered run of Turns, extracting
 * only the ones newer than the segment's pointer (earlier turns ride along
 * as context): drops blocked categories, skips what the Memory already
 * knows, stores the rest. Spend is recorded even when the run fails
 * part-way; Rows stored before a failure stay, and a repeated read finds
 * them known.
 */
export async function captureFacts({
  userId,
  turns,
  blockedCategories,
  spendMessageId,
  capturedThroughAt,
}: CaptureFactsProps): Promise<Result<CaptureFactsOutcome>> {
  const outcome: CaptureFactsOutcome = { added: 0, skippedAsDuplicate: 0 };
  if (turns.length === 0) return ok(outcome);

  // Turns through the pointer are context; anything after is new.
  const contextCount =
    capturedThroughAt === null
      ? 0
      : turns.filter((turn) => turn.userMessage.createdAt.getTime() <= capturedThroughAt.getTime())
          .length;
  if (contextCount === turns.length) return ok(outcome);

  const spend = emptySpend();
  try {
    const extracted = await extractFacts({
      turns: turns.map((turn) => ({
        date: turn.userMessage.createdAt,
        userText: turn.userMessage.content.slice(0, MAX_USER_CHARS),
        assistantText: turn.assistantReply?.content.slice(0, MAX_ASSISTANT_CHARS) ?? null,
      })),
      contextCount,
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
    for (const candidate of allowed) {
      const stored = await storeCandidate({ userId, candidate, turns, spend });
      if (stored.type === 'error') return stored;
      if (stored.data) outcome.added += 1;
      else outcome.skippedAsDuplicate += 1;
    }
    return ok(outcome);
  } finally {
    await recordSpend(spendMessageId, spend);
  }
}
