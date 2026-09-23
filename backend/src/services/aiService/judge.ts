import { env } from '@config/env';
import { generateText } from 'ai';
import { type Result, err, ok } from '../../types/result';
import {
  NOT_CONFIGURED_MESSAGE,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import { withOnDemandBackoff } from './onDemandRetry';

/**
 * The expansion trigger's judge call of the provider boundary.
 * The anaphora heuristic cannot chase language quirks forever ("Is there
 * a silver bullet for this?" carries a dangling referent no token list
 * would anticipate), so short messages the heuristic lets through consult
 * a small classifier instead: does the follow-up refer back into the
 * prior exchange, or does it stand on its own? The verdict only ever
 * ADDS rewrite candidates — the heuristic's own picks never touch this
 * path, and a failed or unreadable verdict fails open to the raw fast
 * path, exactly like the heuristic said no. Crawling on the configured
 * judge model (`env.JUDGE_MODEL`); inherits the established provider config
 * resolution (mock switch, configured check) exactly like the chat,
 * embedding and rewrite paths, and the shared on-demand busy-backoff
 * (`onDemandRetry`) that absorbs the provider's instance-loading stall.
 */

// The judge contract: classification, never conversation. The output is
// one of two labels and nothing else — the output feeds a branch, not
// an embedding. The system prompt's opening sentence is a marker the
// mock server keys its deterministic verdict on.
export const JUDGE_SYSTEM_PROMPT = `You classify chat follow-ups; you never answer them. Given a prior exchange and a follow-up, output exactly one label:
- CONTEXT_DEPENDENT — the follow-up only makes sense with the prior exchange (pronoun, bare ellipsis, "for this/that", implied topic like "records?" after a lifting question).
- SELF_CONTAINED — the follow-up names its own topic and makes sense on its own, or is a genuine topic switch.
Output only the label. Never answer, explain or add anything.

Examples:
Prior exchange:
User: what's the best way to wear a backpack?
Assistant: On both shoulders, straps snug.
Follow-up: is there a silver bullet for this?
Label: CONTEXT_DEPENDENT

Prior exchange:
User: what's the best way to wear a backpack?
Assistant: On both shoulders, straps snug.
Follow-up: Is rosemary easier to keep alive than basil?
Label: SELF_CONTAINED`;

/**
 * Own time budget so a stalled judge never drags the analysis out.
 * Generous on purpose: DeepInfra serves the tiny judge model on-demand
 * and every cold start takes up to ~15s — aborting a loading instance
 * kills the warm-up in flight, so the next call re-colds. A verdict is
 * one label; the timeout is bounded by model load, not by tokens. The
 * production plan is a local judge behind the same seam, where this
 * budget shrinks back to seconds.
 */
const JUDGE_TIMEOUT_MS = 20000;

/** A verdict is one label; bound output so nothing rambles. */
const JUDGE_MAX_OUTPUT_TOKENS = 8;

export type ContextDependenceVerdict = 'context-dependent' | 'self-contained';

export interface JudgeContextDependenceInput {
  /** Prior Turn's user content — already capped by the caller. */
  contextUserText: string;
  /** Prior Turn's assistant content — already capped by the caller. */
  contextAssistantText: string;
  /** The incoming user message to classify. */
  followUpText: string;
}

export interface JudgeContextDependenceData {
  verdict: ContextDependenceVerdict;
  usage: { promptTokens: number; completionTokens: number };
}

export function buildJudgePrompt(input: JudgeContextDependenceInput): string {
  return (
    `Prior exchange:\nUser: ${input.contextUserText}\n` +
    `Assistant: ${input.contextAssistantText}\n\n` +
    `Follow-up: ${input.followUpText}`
  );
}

/** Maps raw model output onto a verdict; null when the label is unreadable. */
export function parseJudgeLabel(raw: string): ContextDependenceVerdict | null {
  const normalized = raw.toUpperCase();
  if (normalized.includes('CONTEXT_DEPENDENT')) return 'context-dependent';
  if (normalized.includes('SELF_CONTAINED')) return 'self-contained';
  return null;
}

async function judgeOnce(
  config: ReturnType<typeof resolveInferenceConfig>,
  input: JudgeContextDependenceInput,
): Promise<Result<JudgeContextDependenceData>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    // maxRetries 0, like every other boundary call: busyness retries are
    // bounded in judgeContextDependence's backoff instead.
    const result = await generateText({
      model: createModel({ ...config, model: env.JUDGE_MODEL }),
      system: JUDGE_SYSTEM_PROMPT,
      prompt: buildJudgePrompt(input),
      maxRetries: 0,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: controller.signal,
    });
    const verdict = parseJudgeLabel(result.text);
    if (verdict === null) {
      return err(
        'judge_failed',
        'The judge returned no readable label; the Turn keeps its heuristic-only verdict.',
      );
    }
    return ok({
      verdict,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    console.error('[judgeContextDependence] judge call failed:', error);
    // The busy marker rides in the message so the caller's backoff can see it.
    return err('judge_failed', `The judge call failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function judgeContextDependence(
  input: JudgeContextDependenceInput,
): Promise<Result<JudgeContextDependenceData>> {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }

  return withOnDemandBackoff(() => judgeOnce(config, input));
}
