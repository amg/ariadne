import { env } from '@config/env';
import type { FactCategory } from '@db/types';
import { generateText } from 'ai';
import { type Result, err, ok } from '../../types/result';
import {
  NOT_CONFIGURED_MESSAGE,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import {
  FACT_FIELD_RULES,
  type FactFields,
  factFieldsOf,
  isoDay,
  jsonObjectOrNull,
} from './factFields';
import { withOnDemandBackoff } from './onDemandRetry';

/**
 * The Fact classification call of the provider boundary: one Fact
 * sentence in, its filing fields out — category, entity columns, and the
 * date the sentence itself states. Filed by the same rules as extraction.
 * Runs on `env.MEMORY_MODEL` with the thinking phase disabled.
 */

// The opening sentence names the task, and stays stable so replies can be
// matched to it.
export const FACT_CLASSIFICATION_SYSTEM_PROMPT = `You classify one fact about the user; you never answer it. Read the fact and output JSON only, in this shape:
{"category":"preference","subject":"user","predicate":"likes","object":"dogs","validAt":null}
Rules:
${FACT_FIELD_RULES}
- validAt is the date the fact became true as YYYY-MM-DD, only when the fact itself states it; resolve relative time ("last week", "two years ago") against today's date. Otherwise null.
- The fact's current category and subject are given. Keep them unless the fact no longer supports them.`;

/** Cold loads on the on-demand pool take ~15s; the reply is one small object. */
const CLASSIFICATION_TIMEOUT_MS = 30000;
const CLASSIFICATION_MAX_OUTPUT_TOKENS = 200;

export interface FactClassificationInput {
  content: string;
  /** Anchors relative dates in the sentence. */
  today: Date;
  current: { category: FactCategory; subject: string | null };
}

export interface FactClassificationData {
  fields: FactFields;
  usage: { promptTokens: number; completionTokens: number };
}

export function buildFactClassificationPrompt(input: FactClassificationInput): string {
  return [
    `Today: ${isoDay(input.today)}`,
    `Current category: ${input.current.category}`,
    `Current subject: ${input.current.subject ?? 'null'}`,
    `Fact: ${input.content}`,
  ].join('\n');
}

async function classifyOnce(
  config: ReturnType<typeof resolveInferenceConfig>,
  input: FactClassificationInput,
): Promise<Result<FactClassificationData>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFICATION_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: createModel({ ...config, model: env.MEMORY_MODEL }),
      system: FACT_CLASSIFICATION_SYSTEM_PROMPT,
      prompt: buildFactClassificationPrompt(input),
      maxRetries: 0,
      maxOutputTokens: CLASSIFICATION_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: controller.signal,
      providerOptions: { deepinfra: { chat_template_kwargs: { enable_thinking: false } } },
    });
    const raw = jsonObjectOrNull(result.text);
    if (raw === null) {
      return err('fact_classification_unreadable', 'The classification reply carried no JSON.');
    }
    return ok({
      fields: factFieldsOf(raw),
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    console.error('[classifyFact] classification call failed:', error);
    return err('fact_classification_failed', `The classification call failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function classifyFact(
  input: FactClassificationInput,
): Promise<Result<FactClassificationData>> {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }
  return withOnDemandBackoff(() => classifyOnce(config, input));
}
