import { env } from '@config/env';
import type { ExpandOutcome } from '@db/types';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { recordMessageExpansion } from '@queries/messageEmbeddings/recordMessageExpansion';
import { upsertExpansionCost } from '@queries/messageExpansionCosts/upsertExpansionCost';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { type Result, err, ok } from '../../../types/result';
import {
  EMBEDDING_MODEL_ID,
  type JudgeContextDependenceInput,
  judgeContextDependence,
  rewriteFollowUp,
} from '../../aiService';
import { computeInferenceCostUsd, round10 } from '../cost';
import {
  REWRITE_CONTEXT_LIMITS,
  REWRITE_MAX_TRIGGER_LENGTH,
  capContext,
  needsRewriteHeuristic,
  parseRewrite,
} from '../rewrite';
import { type LiveTurnRow, buildLiveTurns } from './liveTurns';
import type { MessageStep } from './messageStep';
import { naiveRefusalDetector } from './naiveRefusalDetector';

/**
 * Rewrite step: attempt a self-contained reading of the arriving message.
 * Decides whether a rewrite is warranted (anaphora heuristic, backed up by
 * a small-model judge for short messages in heuristic mode), runs the
 * bounded expansion, and writes the outcome once to the arrival row.
 *
 * This step fails open: every outcome — including all failures — is
 * persisted, the raw message stays the fallback, and the transformer never
 * stops here. A stored outcome row short-circuits the whole step so reruns
 * never redo the rewrite tier.
 */

/** Rewrite budget: one attempt at temperature 0, then a single retry. */
const MAX_REWRITE_ATTEMPTS = 2;

/** The bounding retry uses a higher temperature; the first attempt is frozen at 0. */
const RETRY_REWRITE_TEMPERATURE = 0.7;

/** Live-lane rewrite tier; mirrors the `THREAD_ANALYSIS_MODE` feature flag. */
type LiveRewriteMode = 'heuristic' | 'always';

/** The token counts one pipeline call reported, for the ledger row. */
interface ReportedUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Adds one call's usage onto the running step totals. */
function addUsage(into: ReportedUsage, usage: ReportedUsage | null): void {
  if (usage === null) return;
  into.promptTokens += usage.promptTokens;
  into.completionTokens += usage.completionTokens;
}

/** Inputs every rewrite variant shares: the arrival plus the prior turn. */
interface RewriteContext {
  incomingText: string;
  contextUserText: string;
  contextAssistantText: string;
}

/** Terminal state of one arrival's expansion attempt. */
interface ExpansionEnd {
  expandOutcome: ExpandOutcome;
  expandedText: string | null;
  /** Rewrite cost summed over every attempt this arrival spent. */
  rewriteCostUsd: number | null;
  /** Rewrite token counts summed over every attempt this arrival spent. */
  rewriteUsage: ReportedUsage | null;
}

/** Fails open: a judge error reads as "no rewrite needed". */
async function backstopVerdict(input: RewriteContext): Promise<{
  rewrite: boolean;
  judgeCostUsd: number | null;
  judgeUsage: ReportedUsage | null;
}> {
  const judgeInput: JudgeContextDependenceInput = {
    contextUserText: capContext(input.contextUserText, REWRITE_CONTEXT_LIMITS.user),
    contextAssistantText: capContext(input.contextAssistantText, REWRITE_CONTEXT_LIMITS.assistant),
    followUpText: input.incomingText,
  };
  const judged = await judgeContextDependence(judgeInput);
  if (judged.type === 'error') return { rewrite: false, judgeCostUsd: null, judgeUsage: null };
  const judgeCostUsd = await computeInferenceCostUsd(
    env.JUDGE_MODEL,
    judged.data.usage.promptTokens,
    judged.data.usage.completionTokens,
  );
  return {
    rewrite: judged.data.verdict === 'context-dependent',
    judgeCostUsd,
    judgeUsage: {
      promptTokens: judged.data.usage.promptTokens,
      completionTokens: judged.data.usage.completionTokens,
    },
  };
}

/** Terminal state of a single rewrite attempt. */
interface RewriteAttemptResult {
  outcome: ExpandOutcome;
  expandedText: string | null;
  cost: number | null;
  usage: ReportedUsage | null;
}

/**
 * One rewrite inference plus its quality gate: refusal detection, then the
 * unusable-output rejection (empty, verbatim echo, answer voice). A
 * provider-level failure is reported before any cost or quality check.
 */
async function runRewriteAttempt(
  input: RewriteContext,
  temperature: number,
): Promise<RewriteAttemptResult> {
  const rewritten = await rewriteFollowUp(
    {
      contextUserText: capContext(input.contextUserText, REWRITE_CONTEXT_LIMITS.user),
      contextAssistantText: capContext(
        input.contextAssistantText,
        REWRITE_CONTEXT_LIMITS.assistant,
      ),
      followUpText: input.incomingText,
    },
    { temperature },
  );
  if (rewritten.type === 'error') {
    return { outcome: 'failed_inference', expandedText: null, cost: null, usage: null };
  }
  const cost = await computeInferenceCostUsd(
    env.REWRITE_MODEL,
    rewritten.data.usage.promptTokens,
    rewritten.data.usage.completionTokens,
  );
  const usage: ReportedUsage = {
    promptTokens: rewritten.data.usage.promptTokens,
    completionTokens: rewritten.data.usage.completionTokens,
  };
  if (naiveRefusalDetector(rewritten.data.text)) {
    return { outcome: 'failed_refused', expandedText: null, cost, usage };
  }
  const parsed = parseRewrite(rewritten.data.text, input.incomingText);
  if (parsed === null) return { outcome: 'failed', expandedText: null, cost, usage };
  return { outcome: 'accepted', expandedText: parsed, cost, usage };
}

/**
 * Bounded expansion: temperature-0 attempt → one retry at raised
 * temperature. Refusal and unusable output are quality-control failures, so
 * both consume the retry and the last refusal-like outcome is what lands;
 * a provider-level failure records `failed_inference` immediately without
 * paying for the retry.
 */
async function resolveExpansion(input: RewriteContext): Promise<ExpansionEnd> {
  let rewriteCostUsd: number | null = null;
  let rewriteUsage: ReportedUsage | null = null;
  let lastOutcome: ExpandOutcome = 'failed';
  for (let attempt = 1; attempt <= MAX_REWRITE_ATTEMPTS; attempt += 1) {
    const temperature = attempt === 1 ? 0 : RETRY_REWRITE_TEMPERATURE;
    const attemptResult = await runRewriteAttempt(input, temperature);
    if (attemptResult.outcome === 'failed_inference') {
      return {
        expandOutcome: 'failed_inference',
        expandedText: null,
        rewriteCostUsd,
        rewriteUsage,
      };
    }
    rewriteCostUsd = (rewriteCostUsd ?? 0) + (attemptResult.cost ?? 0);
    if (attemptResult.usage !== null) {
      rewriteUsage = rewriteUsage ?? { promptTokens: 0, completionTokens: 0 };
      addUsage(rewriteUsage, attemptResult.usage);
    }
    lastOutcome = attemptResult.outcome;
    if (attemptResult.outcome === 'accepted') {
      return {
        expandOutcome: 'accepted',
        expandedText: attemptResult.expandedText,
        rewriteCostUsd,
        rewriteUsage,
      };
    }
  }
  // Exhausted the budget on quality failures; the last refusal-like outcome lands.
  return { expandOutcome: lastOutcome, expandedText: null, rewriteCostUsd, rewriteUsage };
}

/**
 * Decides whether the arrival is rewritten at all. `tried` separates "no
 * rewrite was warranted" (outcome null) from "rewrite attempted" so the
 * caller can persist the right terminal state.
 */
async function rewriteDecision(input: {
  arrival: LiveTurnRow;
  prior: LiveTurnRow | null;
  mode: LiveRewriteMode;
}): Promise<
  ExpansionEnd & { tried: boolean; judgeCostUsd: number | null; judgeUsage: ReportedUsage | null }
> {
  const none: ExpansionEnd & {
    tried: boolean;
    judgeCostUsd: number | null;
    judgeUsage: ReportedUsage | null;
  } = {
    tried: false,
    expandOutcome: 'failed',
    expandedText: null,
    rewriteCostUsd: null,
    rewriteUsage: null,
    judgeCostUsd: null,
    judgeUsage: null,
  };
  if (!input.prior) return none;

  const incomingText = input.arrival.userMessage.content;
  const context = {
    incomingText,
    contextUserText: input.prior.userMessage.content,
    contextAssistantText: input.prior.assistantReply?.content ?? '',
  };

  if (input.mode === 'always' || needsRewriteHeuristic(incomingText)) {
    const expansion = await resolveExpansion(context);
    return { ...expansion, tried: true, judgeCostUsd: null, judgeUsage: null };
  }

  const trimmed = incomingText.trim();
  const shortEnough = trimmed.length > 0 && trimmed.length <= REWRITE_MAX_TRIGGER_LENGTH;
  if (input.mode !== 'heuristic' || !shortEnough) return none;

  // Second chance for short messages the heuristic missed.
  const checked = await backstopVerdict(context);
  if (!checked.rewrite)
    return { ...none, judgeCostUsd: checked.judgeCostUsd, judgeUsage: checked.judgeUsage };

  const expansion = await resolveExpansion(context);
  return {
    ...expansion,
    tried: true,
    judgeCostUsd: checked.judgeCostUsd,
    judgeUsage: checked.judgeUsage,
  };
}

export const rewriteMessageStep: MessageStep = {
  name: 'rewrite',
  async run({ threadId, userMessageId }) {
    const stored = await listMessageEmbeddingsByMessageIds({ messageIds: [userMessageId] });
    if (stored.length > 0) return ok(undefined);

    const rows = await listMessagesByThread({ threadId });
    const arrivals = buildLiveTurns(rows);
    const index = arrivals.findIndex((turn) => turn.userMessage.id === userMessageId);
    const arrival = index >= 0 ? arrivals[index] : undefined;
    if (!arrival) return err('thread_not_found');

    const mode: LiveRewriteMode = env.THREAD_ANALYSIS_MODE === 'always' ? 'always' : 'heuristic';
    const decision = await rewriteDecision({
      arrival,
      prior: index > 0 ? (arrivals[index - 1] ?? null) : null,
      mode,
    });

    // Persists the terminal state on the arrival row. The embedding column
    // is left null for the embed step to fill.
    await recordMessageExpansion({
      messageId: userMessageId,
      modelId: EMBEDDING_MODEL_ID,
      expandOutcome: decision.tried ? decision.expandOutcome : null,
      expandedText: decision.tried ? decision.expandedText : null,
    });

    // The rewrite/judge spends land in `message_expansion_costs`, keyed by step.
    if (decision.tried && decision.rewriteCostUsd !== null) {
      await upsertExpansionCost({
        messageId: userMessageId,
        kind: 'rewrite',
        model: env.REWRITE_MODEL,
        costUsd: round10(decision.rewriteCostUsd).toFixed(10),
        promptTokens: decision.rewriteUsage?.promptTokens ?? null,
        completionTokens: decision.rewriteUsage?.completionTokens ?? null,
      });
    }
    if (decision.judgeCostUsd !== null) {
      await upsertExpansionCost({
        messageId: userMessageId,
        kind: 'judge',
        model: env.JUDGE_MODEL,
        costUsd: round10(decision.judgeCostUsd).toFixed(10),
        promptTokens: decision.judgeUsage?.promptTokens ?? null,
        completionTokens: decision.judgeUsage?.completionTokens ?? null,
      });
    }
    return ok(undefined);
  },
};
