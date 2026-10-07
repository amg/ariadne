import { env } from '@config/env';
import type { FactCategory, Message } from '@db/types';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { type NearUserFact, listNearestUserFacts } from '@queries/userFacts/listNearestUserFacts';
import { listSeedableUserFacts } from '@queries/userFacts/listSeedableUserFacts';
import { replaceCurrentUserFactOrNull } from '@queries/userFacts/replaceCurrentUserFactOrNull';
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
  /** Known Facts a candidate restated or corrected, now superseded by it. */
  replaced: number;
}

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
 * The known Fact a candidate restates or corrects, or null when it is
 * about something new. Identical sentences and far-away ones need no
 * model call; only near neighbours are checked.
 */
async function factReplacedByOrNull(
  userId: string,
  candidate: string,
  embedding: number[],
  spend: CaptureSpend,
): Promise<Result<NearUserFact | null>> {
  const neighbours = await listNearestUserFacts({
    userId,
    embedding,
    modelId: EMBEDDING_MODEL_ID,
    limit: NEIGHBOUR_COUNT,
  });
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
 * Embeds, checks, and stores one candidate: as a new Fact, or in place of
 * the known Fact it restates or corrects, whose suppression it keeps. The
 * newest statement wins, even over a sentence edited by hand.
 */
async function storeCandidate(input: {
  userId: string;
  candidate: FactCandidate;
  turns: CaptureTurn[];
  spend: CaptureSpend;
}): Promise<Result<'added' | 'replaced'>> {
  const { userId, candidate, turns, spend } = input;
  const embedded = await embedText(candidate.content);
  if (embedded.type === 'error') return embedded;
  spend.embedding.promptTokens += embedded.data.promptTokens;
  spend.embedding.costUsd += await computeEmbeddingCostUsd(embedded.data.promptTokens);

  const replaced = await factReplacedByOrNull(
    userId,
    candidate.content,
    embedded.data.embedding,
    spend,
  );
  if (replaced.type === 'error') return replaced;

  const sourceTurn = turns[candidate.turnIndex] ?? turns[turns.length - 1];
  const fact = {
    content: candidate.content,
    category: candidate.category,
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    embedding: embedded.data.embedding,
    modelId: EMBEDDING_MODEL_ID,
    sourceMessageId: sourceTurn?.userMessage.id ?? null,
    validAt: candidate.validAt,
  };
  if (replaced.data === null) {
    await insertUserFact({ userId, ...fact });
    return ok('added');
  }
  // Null when a pass running alongside superseded it first; its reading stands.
  await replaceCurrentUserFactOrNull({
    factId: replaced.data.id,
    userId,
    replacement: { ...fact, suppressed: replaced.data.suppressed },
  });
  return ok('replaced');
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
 * Captures Facts about the user from an ordered run of Turns, extracting
 * only the ones newer than the segment's pointer (earlier turns ride along
 * as context), with the Facts already known about what they mention as
 * background: drops blocked categories, then stores each candidate as a
 * new Fact or in place of the known Fact it restates or corrects. Spend
 * is recorded even when the run fails part-way; rows stored before a
 * failure stay, and a repeated read replaces them with its own reading.
 */
export async function captureFacts({
  userId,
  turns,
  blockedCategories,
  spendMessageId,
  capturedThroughAt,
}: CaptureFactsProps): Promise<Result<CaptureFactsOutcome>> {
  const outcome: CaptureFactsOutcome = { added: 0, replaced: 0 };
  if (turns.length === 0) return ok(outcome);

  // Scope Turns through the pointer are context; anything after is new.
  const contextCount =
    capturedThroughAt === null
      ? 0
      : turns.filter((turn) => turn.userMessage.createdAt.getTime() <= capturedThroughAt.getTime())
          .length;
  if (contextCount === turns.length) return ok(outcome);

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
    for (const candidate of allowed) {
      const stored = await storeCandidate({ userId, candidate, turns, spend });
      if (stored.type === 'error') return stored;
      outcome[stored.data] += 1;
    }
    return ok(outcome);
  } finally {
    await recordSpend(spendMessageId, spend);
  }
}
