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
 * The duplicate check of the provider boundary: does a candidate Fact say
 * anything the closest stored Facts do not already say? One label out.
 * Runs on `env.MEMORY_MODEL` with the thinking phase disabled.
 */

// The opening sentence names the task, and stays stable so replies can be
// matched to it.
export const FACT_DUPLICATE_SYSTEM_PROMPT = `You compare facts about the user; you never answer them. Given a candidate fact and a numbered list of known facts, output exactly one label:
- DUPLICATE — a known fact already states everything the candidate states, even in other words.
- NEW — the candidate adds information no known fact states, including a more specific or changed detail.
Output only the label.`;

const DUPLICATE_TIMEOUT_MS = 20000;
const DUPLICATE_MAX_OUTPUT_TOKENS = 8;

export type FactDuplicateVerdict = 'duplicate' | 'new';

export interface FactDuplicateInput {
  candidate: string;
  /** Closest known Facts, nearest first. */
  knownFacts: string[];
}

export interface FactDuplicateData {
  verdict: FactDuplicateVerdict;
  usage: { promptTokens: number; completionTokens: number };
}

export function buildFactDuplicatePrompt(input: FactDuplicateInput): string {
  const known = input.knownFacts.map((fact, index) => `${index + 1}. ${fact}`).join('\n');
  return `Candidate: ${input.candidate}\n\nKnown facts:\n${known}`;
}

/** Maps raw model output onto a verdict; null when the label is unreadable. */
export function parseFactDuplicateLabel(raw: string): FactDuplicateVerdict | null {
  const normalized = raw.toUpperCase();
  if (normalized.includes('DUPLICATE')) return 'duplicate';
  if (normalized.includes('NEW')) return 'new';
  return null;
}

async function judgeOnce(
  config: ReturnType<typeof resolveInferenceConfig>,
  input: FactDuplicateInput,
): Promise<Result<FactDuplicateData>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DUPLICATE_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: createModel({ ...config, model: env.MEMORY_MODEL }),
      system: FACT_DUPLICATE_SYSTEM_PROMPT,
      prompt: buildFactDuplicatePrompt(input),
      maxRetries: 0,
      maxOutputTokens: DUPLICATE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: controller.signal,
      providerOptions: { deepinfra: { chat_template_kwargs: { enable_thinking: false } } },
    });
    const verdict = parseFactDuplicateLabel(result.text);
    if (verdict === null) {
      return err('fact_duplicate_unreadable', 'The duplicate check returned no readable label.');
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
    console.error('[judgeFactDuplicate] duplicate check failed:', error);
    return err('fact_duplicate_failed', `The duplicate check failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function judgeFactDuplicate(
  input: FactDuplicateInput,
): Promise<Result<FactDuplicateData>> {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }
  return withOnDemandBackoff(() => judgeOnce(config, input));
}
