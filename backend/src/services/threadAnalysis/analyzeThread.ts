import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { upsertMessageEmbedding } from '@queries/messageEmbeddings/upsertMessageEmbedding';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { DEFAULT_USER_ID } from '@services/userService';
import { type Result, err, ok } from '../../types/result';
import {
  type ContextDependenceVerdict,
  EMBEDDING_MODEL_ID,
  JUDGE_MODEL_ID,
  type JudgeContextDependenceInput,
  REWRITE_MODEL_ID,
  embedText,
  judgeContextDependence,
  rewriteFollowUp,
} from '../aiService';
import {
  buildCostProfile,
  computeEmbeddingCostUsd,
  computeJudgeCostUsd,
  computeRewriteCostUsd,
  round10,
} from './cost';
import { type DriftScoring, scoreDrift } from './drift';
import { buildEmdMatrix } from './emd';
import {
  type ExpansionCandidate,
  expansionBackstopCandidates,
  expansionCandidates,
  parseRewrite,
} from './expansion';
import { scoreGateReplay } from './gateReplay';
import {
  type Turn,
  buildProspectiveBlocks,
  buildTurnBlocks,
  pairTurns,
  prospectiveText,
} from './turns';
import {
  type AnalyzeThreadOptions,
  DEFAULT_ANALYZE_OPTIONS,
  DEFAULT_EXPANSION_MODE,
  DEFAULT_GATE_REPLAY_OPTIONS,
  type ExpansionMode,
  type GateReplayParams,
  type GateReplaySection,
  type ThreadReport,
} from './types';
import type { JudgingParams } from './verdict';

/**
 * Analyzes a thread for conversational drift by scoring topic segments and boundaries.
 *
 * @param threadId The ID of the thread to analyze.
 * @param options Configuration options for the analysis, including thresholds and replay settings.
 * @returns A ThreadReport containing the drift series, topic segments, and cost totals.
 *
 * Failure codes:
 * - `thread_not_found`: The thread does not exist.
 * - `thread_too_short`: The thread lacks sufficient turns for analysis.
 * - `provider_not_configured`: The embedding provider is missing.
 * - `embed_failed`: An embedding call failed.
 */
export async function analyzeThread(
  threadId: string,
  options?: AnalyzeThreadOptions,
): Promise<Result<ThreadReport>> {
  const opts = resolveJudgingParams(options);
  const gateParams = resolveGateParams(options?.gateReplay);
  const expansionMode: ExpansionMode = options?.expansion ?? DEFAULT_EXPANSION_MODE;

  // Local single-user app: the analyzer operates under the same
  // placeholder user as every route (REQUEST_USER_ID pattern).
  const thread = await findThreadByIdAndUser({ userId: DEFAULT_USER_ID, threadId });
  if (!thread) return err('thread_not_found');

  const messages = await listMessagesByThread({ threadId });
  const turns = pairTurns(messages);
  if (turns.length === 0) {
    return err(
      'thread_too_short',
      'Thread has no complete turns; drift analysis needs at least one user-assistant Turn.',
    );
  }

  const blocks = buildTurnBlocks(turns);
  const storedRows = await listMessageEmbeddingsByMessageIds({
    messageIds: blocks.map((block) => block.assistantMessage.id),
  });
  const storedByKey = new Map(storedRows.map((row) => [row.messageId, row]));

  // Persist-upon-use: embed and upsert each Turn's row as soon as the
  // call succeeds so a later failure loses no progress. Provenance
  // identity is the embedding model alone.
  const onTurnEmbedded = options?.onTurnEmbedded;
  let embeddingCostUsd = 0;
  for (const block of blocks) {
    const stored = storedByKey.get(block.assistantMessage.id);
    if (stored && stored.modelId === EMBEDDING_MODEL_ID) {
      continue; // provenance matches: reused with zero embed calls
    }
    onTurnEmbedded?.(block.turnNumber, blocks.length);
    const embedded = await embedText(block.text);
    if (embedded.type === 'error') return embedded;
    await upsertMessageEmbedding({
      messageId: block.assistantMessage.id,
      embedding: embedded.data.embedding,
      modelId: EMBEDDING_MODEL_ID,
    });
    embeddingCostUsd = round10(
      embeddingCostUsd + computeEmbeddingCostUsd(embedded.data.promptTokens),
    );
  }

  // Embedding complete: score from the stored rows only. All runs compute
  // over the exact float4-rounded storage values, keeping reports
  // bit-stable repeat to repeat.
  const storedTurns = await listMessageEmbeddingsByMessageIds({
    messageIds: blocks.map((block) => block.assistantMessage.id),
  });
  const vectorByMessageId = new Map(storedTurns.map((row) => [row.messageId, row.embedding]));
  const messageIndexByMessageId = new Map(
    messages.map((message, index) => [message.id, index + 1]),
  );

  const drift = scoreDrift({
    blocks,
    turns,
    vectorByMessageId,
    messageIndexByMessageId,
    judging: opts,
  });

  const costProfile = buildCostProfile(messages);
  const lastPoint = costProfile[costProfile.length - 1];

  const report: ThreadReport = {
    threadId,
    title: thread.title ?? '',
    generatedAt: new Date().toISOString(),
    params: {
      segmentThreshold: opts.segmentThreshold,
      immediateK: opts.immediateK,
      sigmaFloor: opts.sigmaFloor,
      lambda: opts.lambda,
      delta: opts.delta,
      minSamples: opts.minSamples,
      coldStartTurns: opts.coldStartTurns,
      embeddingModelId: EMBEDDING_MODEL_ID,
    },
    totals: {
      turns: turns.length,
      messages: messages.length,
      totalCostUsd: lastPoint ? lastPoint.runningTotalUsd : 0,
      embeddingCostUsd,
      rewriteCostUsd: 0,
      judgeCostUsd: 0,
    },
    costProfile,
    driftSeries: drift.driftSeries,
    anchor: { builtFromTurns: drift.anchorBuiltFromTurns, counsel: drift.counsel },
    segments: drift.segments,
  };

  if (gateParams === null) return ok(report);

  const gateSection = await buildGateReplaySection({
    turns,
    blocks,
    drift,
    vectorByMessageId,
    messageIndexByMessageId: messageIndexByMessageId,
    gateParams,
    expansionMode,
    judging: opts,
    onProspectiveEmbedded: options?.onProspectiveEmbedded,
    onExpansionEmbedded: options?.onExpansionEmbedded,
  });
  if (gateSection.type === 'error') return gateSection;

  report.params.gateReplay = gateParams;
  recordGateSection(report, gateParams, expansionMode, embeddingCostUsd, gateSection.data);
  return ok(report);
}

/** Records gate-replay provenance and this run's spend onto the report. */
function recordGateSection(
  report: ThreadReport,
  gateParams: GateReplayParams,
  expansionMode: ExpansionMode,
  embeddingCostUsd: number,
  data: {
    section: GateReplaySection;
    prospectiveCostUsd: number;
    rewriteCostUsd: number;
    judgeCostUsd: number;
    judgeConsulted: boolean;
  },
): void {
  if (expansionMode !== 'off') {
    report.params.expansion = { mode: expansionMode, modelId: REWRITE_MODEL_ID };
    // The backstop only consults in `heuristic` mode; record its model
    // only when it actually ran.
    if (data.judgeConsulted) report.params.expansion.judgeModelId = JUDGE_MODEL_ID;
  }
  report.gateReplay = data.section;
  report.totals.embeddingCostUsd = round10(embeddingCostUsd + data.prospectiveCostUsd);
  report.totals.rewriteCostUsd = data.rewriteCostUsd;
  report.totals.judgeCostUsd = data.judgeCostUsd;
}

/**
 * The flat judging params for the run: admission defaults, overridden
 * field-by-field. Overrides apply to the run's entire judgment —
 * offline fold and gate play read the same complete set.
 */
function resolveJudgingParams(options?: AnalyzeThreadOptions): JudgingParams {
  const opts: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS };
  if (!options) return opts;
  for (const key of Object.keys(DEFAULT_ANALYZE_OPTIONS) as Array<keyof JudgingParams>) {
    const override = options[key];
    if (override !== undefined) opts[key] = override;
  }
  return opts;
}

/** `gateReplay: true` runs defaults; an object overrides individual params. */
function resolveGateParams(
  gateReplay: AnalyzeThreadOptions['gateReplay'],
): GateReplayParams | null {
  if (gateReplay === undefined || gateReplay === false) return null;
  if (gateReplay === true) return { ...DEFAULT_GATE_REPLAY_OPTIONS };
  return { ...DEFAULT_GATE_REPLAY_OPTIONS, ...gateReplay };
}
interface BuildGateReplaySectionProps {
  turns: Turn[];
  blocks: ReturnType<typeof buildTurnBlocks>;
  drift: DriftScoring;
  vectorByMessageId: Map<string, number[]>;
  messageIndexByMessageId: Map<string, number>;
  gateParams: GateReplayParams;
  expansionMode: ExpansionMode;
  /** The flat judging params — the shared two-channel verdict's full set. */
  judging: JudgingParams;
  onProspectiveEmbedded?: ((turnNumber: number, totalTurns: number) => void) | undefined;
  onExpansionEmbedded?: ((position: number, totalCandidates: number) => void) | undefined;
}

/**
 * The gate replay: transient Prospective embeds (one per incoming user
 * Message, never persisted), the pretend-replay gate scoring over the
 * fold's live Gravity trajectory, and the post-fold EMD revisit matrix —
 * stored vectors only, zero additional embed calls.
 */
/** The outcome of one detached-rewrite attempt. */
type RewriteAttempt =
  | { kind: 'rewrite'; text: string; costUsd: number }
  | { kind: 'skip_rewrite_failed' | 'skip_unusable_rewrite'; costUsd: number };

/**
 * Runs the detached decontextualising rewrite for one expansion candidate
 * call the rewriter, parse its answer, account the cost —
 * and explain either class of gap. Embedding stays with the caller, next
 * to the other transient prospective embeds.
 */
async function attemptRewrite(candidate: ExpansionCandidate): Promise<RewriteAttempt> {
  const rewritten = await rewriteFollowUp({
    contextUserText: candidate.contextUserText,
    contextAssistantText: candidate.contextAssistantText,
    followUpText: candidate.incomingText,
  });
  if (rewritten.type === 'error') {
    return { kind: 'skip_rewrite_failed', costUsd: 0 };
  }
  const costUsd = computeRewriteCostUsd(
    rewritten.data.usage.promptTokens,
    rewritten.data.usage.completionTokens,
  );
  const text = parseRewrite(rewritten.data.text, candidate.incomingText);
  if (text === null) return { kind: 'skip_unusable_rewrite', costUsd };
  return { kind: 'rewrite', text, costUsd };
}

/** The judge backstop's outcome: extra candidates + this run's spend. */
interface JudgeBackstopOutcome {
  /** CONTEXT_DEPENDENT verdicts — shortlisted candidates that join the rewrite list. */
  addedCandidates: ExpansionCandidate[];
  judgeCostUsd: number;
  judgeConsulted: boolean;
}

/**
 * Consults the trigger judge over one shortlisted message: CONTEXT_DEPENDENT
 * joins the rewrite list; SELF_CONTAINED and unreadable verdicts explain
 * themselves on the Turn and keep the raw fast path. Fail-open by
 * construction — a broken judge behaves exactly like the heuristic's no,
 * and verdicts only ever ADD rewrite candidates.
 */
async function consultJudgeBackstop(
  shortlist: ExpansionCandidate[],
  expansionNoteByTurn: Record<number, string>,
): Promise<JudgeBackstopOutcome> {
  const addedCandidates: ExpansionCandidate[] = [];
  let judgeCostUsd = 0;
  let judgeConsulted = false;
  for (const backstop of shortlist) {
    judgeConsulted = true;
    const judgeInput: JudgeContextDependenceInput = {
      contextUserText: backstop.contextUserText,
      contextAssistantText: backstop.contextAssistantText,
      followUpText: backstop.incomingText,
    };
    const judged = await judgeContextDependence(judgeInput);
    if (judged.type === 'error') {
      // Fail open: no readable verdict behaves like the heuristic's no.
      expansionNoteByTurn[backstop.turnNumber] = 'skip_judge_failed';
      continue;
    }
    const verdict: ContextDependenceVerdict = judged.data.verdict;
    judgeCostUsd = round10(
      judgeCostUsd +
        computeJudgeCostUsd(judged.data.usage.promptTokens, judged.data.usage.completionTokens),
    );
    if (verdict === 'context-dependent') {
      addedCandidates.push(backstop);
    } else {
      expansionNoteByTurn[backstop.turnNumber] = 'skip_judge_self_contained';
    }
  }
  return { addedCandidates, judgeCostUsd, judgeConsulted };
}

/** The rewrite pipeline's outcome: this run's spend. */
interface RewriteEmbedOutcome {
  rewriteCostUsd: number;
  prospectiveCostUsd: number;
}

/**
 * Rewrites each candidate and embeds the usable results as transient
 * Prospective blocks (never persisted). Strictly additive: a rewrite
 * failure or unusable output explains itself on the Turn and its
 * raw-only verdict stands; an embed failure aborts like any other.
 * Mutates the two expanded maps in place.
 */
async function embedRewriteCandidates(
  candidates: ExpansionCandidate[],
  expandedVectorByTurn: Map<number, number[]>,
  expandedTextByTurn: Map<number, string>,
  expansionNoteByTurn: Record<number, string> | undefined,
  onExpansionEmbedded?: ((position: number, totalCandidates: number) => void) | undefined,
): Promise<Result<RewriteEmbedOutcome>> {
  let rewriteCostUsd = 0;
  let prospectiveCostUsd = 0;
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    if (!candidate) continue;
    onExpansionEmbedded?.(position + 1, candidates.length);
    const attempted = await attemptRewrite(candidate);
    if (attempted.kind !== 'rewrite') {
      if (expansionNoteByTurn) expansionNoteByTurn[candidate.turnNumber] = attempted.kind;
      continue;
    }
    rewriteCostUsd = round10(rewriteCostUsd + attempted.costUsd);
    const embedded = await embedText(prospectiveText(attempted.text));
    if (embedded.type === 'error') return embedded;
    expandedVectorByTurn.set(candidate.turnNumber, embedded.data.embedding);
    expandedTextByTurn.set(candidate.turnNumber, attempted.text);
    prospectiveCostUsd = round10(
      prospectiveCostUsd + computeEmbeddingCostUsd(embedded.data.promptTokens),
    );
  }
  return ok({ rewriteCostUsd, prospectiveCostUsd });
}

async function buildGateReplaySection({
  turns,
  blocks,
  drift,
  vectorByMessageId,
  messageIndexByMessageId,
  gateParams,
  expansionMode,
  judging,
  onProspectiveEmbedded,
  onExpansionEmbedded,
}: BuildGateReplaySectionProps): Promise<
  Result<{
    section: GateReplaySection;
    prospectiveCostUsd: number;
    rewriteCostUsd: number;
    judgeCostUsd: number;
    judgeConsulted: boolean;
  }>
> {
  const prospectiveBlocks = buildProspectiveBlocks(turns);
  const prospectiveVectorByTurn = new Map<number, number[]>();
  let prospectiveEmbedCostUsd = 0;
  for (const block of prospectiveBlocks) {
    onProspectiveEmbedded?.(block.turnNumber, prospectiveBlocks.length);
    const embedded = await embedText(block.text);
    if (embedded.type === 'error') return embedded;
    prospectiveVectorByTurn.set(block.turnNumber, embedded.data.embedding);
    prospectiveEmbedCostUsd = round10(
      prospectiveEmbedCostUsd + computeEmbeddingCostUsd(embedded.data.promptTokens),
    );
  }

  // The expanded signal: ambiguous incoming messages get a
  // detached decontextualising rewrite, embedded as a second Prospective
  // block — transient, never persisted, like the raw blocks.
  const expandedVectorByTurn = new Map<number, number[]>();
  const expandedTextByTurn = new Map<number, string>();
  // Gate points must explain every missing rewritten reading.
  // 'off' mode explains itself downstream; other modes annotate each Turn.
  const expansionNoteByTurn =
    expansionMode === 'off'
      ? undefined
      : Object.fromEntries(turns.map((turn) => [turn.turnNumber, 'skip_no_candidate']));
  const candidates = expansionCandidates(turns, expansionMode);
  // The judge backstop (heuristic mode only): short messages the anaphora
  // trigger let through ask a small classifier whether they dangle a
  // referent into the prior Turn.
  let judgeCostUsd = 0;
  let judgeConsulted = false;
  if (expansionMode === 'heuristic' && expansionNoteByTurn) {
    const backstop = await consultJudgeBackstop(
      expansionBackstopCandidates(turns),
      expansionNoteByTurn,
    );
    candidates.push(...backstop.addedCandidates);
    judgeCostUsd = backstop.judgeCostUsd;
    judgeConsulted = backstop.judgeConsulted;
  }
  let prospectiveCostUsd = prospectiveEmbedCostUsd;
  const rewritten = await embedRewriteCandidates(
    candidates,
    expandedVectorByTurn,
    expandedTextByTurn,
    expansionNoteByTurn,
    onExpansionEmbedded,
  );
  if (rewritten.type === 'error') return rewritten;
  const rewriteCostUsd = rewritten.data.rewriteCostUsd;
  prospectiveCostUsd = round10(prospectiveCostUsd + rewritten.data.prospectiveCostUsd);

  const turnVectorByTurn = new Map<number, number[]>(
    blocks.map((block) => [
      block.turnNumber,
      vectorByMessageId.get(block.assistantMessage.id) ?? [],
    ]),
  );
  const scoring = scoreGateReplay({
    turnNumbers: turns.map((turn) => turn.turnNumber),
    prospectiveVectorByTurn,
    // Off mode: no expansion props at all — the gate replays raw-only and
    // stays byte-stable with the task reports.
    ...(expansionMode === 'off'
      ? {}
      : { expandedVectorByTurn, expandedTextByTurn, expansionNoteByTurn }),
    turnVectorByTurn,
    preGravityByTurn: drift.preGravityByTurn,
    foldBoundaryTurns: new Set(
      drift.driftSeries.filter((point) => point.isBoundary).map((point) => point.turnNumber),
    ),
    anchorVector: drift.anchorVector,
    userMessageIndexByTurn: new Map(
      turns.map((turn) => [turn.turnNumber, messageIndexByMessageId.get(turn.userMessage.id) ?? 0]),
    ),
    judging,
  });

  const emd = buildEmdMatrix({
    segmentVectors: drift.segments.map((segment) => ({
      index: segment.index,
      vectors: segment.turns
        .map((turn) => turnVectorByTurn.get(turn.turnNumber))
        .filter((vector): vector is number[] => vector !== undefined && vector.length > 0),
    })),
    epsilon: gateParams.sinkhornEpsilon,
  });

  return ok({
    section: {
      points: scoring.points,
      divergences: scoring.divergences,
      anchorCounsel: scoring.anchorCounsel,
      emd,
    },
    prospectiveCostUsd,
    rewriteCostUsd,
    judgeCostUsd,
    judgeConsulted,
  });
}
