import { env } from '@config/env';
import { FACT_CATEGORIES, type FactCategory } from '@db/types';
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
 * The Fact extraction call of the provider boundary: an ordered run of
 * Turns in, candidate Facts about the user out. The model reads the
 * conversation and never answers it; its JSON output is parsed and
 * validated here, so callers only ever see well-formed candidates. A
 * reply with no readable JSON still succeeds, with null candidates, so
 * the caller can record what the call cost.
 * Runs on `env.MEMORY_MODEL` with the thinking phase disabled.
 */

// The extraction contract. Phrased as checkable rules because small
// models follow those more reliably than loose guidance. The opening
// sentence names the task, and stays stable so replies can be matched
// to it.
export const FACT_EXTRACTION_SYSTEM_PROMPT = `You extract durable facts about the user from a conversation; you never answer it. Read the numbered turns and output JSON only, in this shape:
{"facts":[{"turn":1,"content":"The user ...","category":"preference","subject":"user","predicate":"likes","object":"dogs","validAt":null}]}
Rules:
- A fact is one self-contained sentence about the user: who they are, what they like or avoid, their circumstances, people, work, places, or a correction they gave. It must still be useful in a future conversation with no other context. Write it in the third person, starting with "The user".
- Extract only what the user states or clearly confirms about themselves. Never extract the assistant's suggestions, general knowledge, or the topic under discussion.
- Skip ephemeral details: one-off task requests, passing moods, anything true only for this conversation.
- turn is the number of the turn the fact comes from.
- Resolve relative time ("last week", "two years ago") into absolute dates using that turn's date. validAt is the date the fact became true as YYYY-MM-DD, only when the user states or directly implies it; otherwise null.
- category is one of: ${FACT_CATEGORIES.join(', ')}.
- subject is "user" unless the fact is about someone the user names; predicate is a short snake_case verb phrase such as likes, lives_in, works_as; object is the thing, lowercase; use null when there is none.
- If nothing qualifies, output {"facts":[]}.`;

/** Cold loads on the on-demand pool take ~15s; a list of facts is short. */
const EXTRACTION_TIMEOUT_MS = 30000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 800;
const MAX_FACT_CHARS = 300;
const MAX_ENTITY_CHARS = 120;

export interface FactExtractionTurn {
  /** When the Turn's user Message arrived; anchors relative dates. */
  date: Date;
  userText: string;
  /** Null when the Turn has no reply. */
  assistantText: string | null;
}

export interface FactExtractionInput {
  turns: FactExtractionTurn[];
  /** Categories the model is told never to extract. */
  blockedCategories: readonly FactCategory[];
}

export interface FactCandidate {
  /** Index into the input turns. */
  turnIndex: number;
  content: string;
  category: FactCategory;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  /** The date the Fact became true, when the conversation states it. */
  validAt: Date | null;
}

export interface FactExtractionData {
  /** Null when the reply carried no readable JSON. */
  candidates: FactCandidate[] | null;
  usage: { promptTokens: number; completionTokens: number };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildFactExtractionPrompt(input: FactExtractionInput): string {
  const blocked =
    input.blockedCategories.length > 0
      ? `Never extract facts in these categories: ${input.blockedCategories.join(', ')}.\n\n`
      : '';
  const turns = input.turns
    .map((turn, index) => {
      const reply = turn.assistantText === null ? '' : `\nAssistant: ${turn.assistantText}`;
      return `Turn ${index + 1} (${isoDay(turn.date)}):\nUser: ${turn.userText}${reply}`;
    })
    .join('\n\n');
  return `${blocked}${turns}`;
}

function trimmedOrNull(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, maxChars);
}

function normalizedPredicate(value: unknown): string | null {
  const text = trimmedOrNull(value, MAX_ENTITY_CHARS);
  if (text === null) return null;
  const snake = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return snake === '' ? null : snake;
}

function dayOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function categoryOrOther(value: unknown): FactCategory {
  return FACT_CATEGORIES.find((category) => category === value) ?? 'other';
}

function turnIndexOrLast(value: unknown, turnCount: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= turnCount) {
    return value - 1;
  }
  return turnCount - 1;
}

function candidateOrNull(entry: unknown, turnCount: number): FactCandidate | null {
  if (entry === null || typeof entry !== 'object') return null;
  // Narrowed to an object above; fields are validated one by one below.
  const raw = entry as Record<string, unknown>;
  const content = trimmedOrNull(raw.content, MAX_FACT_CHARS);
  if (content === null) return null;
  return {
    turnIndex: turnIndexOrLast(raw.turn, turnCount),
    content,
    category: categoryOrOther(raw.category),
    subject: trimmedOrNull(raw.subject, MAX_ENTITY_CHARS)?.toLowerCase() ?? null,
    predicate: normalizedPredicate(raw.predicate),
    object: trimmedOrNull(raw.object, MAX_ENTITY_CHARS)?.toLowerCase() ?? null,
    validAt: dayOrNull(raw.validAt),
  };
}

/**
 * Reads the model's JSON reply into candidates; null when no JSON object
 * can be found. Tolerates code fences and prose around the object, and
 * drops malformed entries one by one.
 */
export function parseFactCandidates(raw: string, turnCount: number): FactCandidate[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  // JSON.parse yields unknown; the optional access tolerates any shape,
  // and the array check below validates it.
  const facts = (parsed as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return null;
  return facts
    .map((entry) => candidateOrNull(entry, turnCount))
    .filter((candidate): candidate is FactCandidate => candidate !== null);
}

async function extractOnce(
  config: ReturnType<typeof resolveInferenceConfig>,
  input: FactExtractionInput,
): Promise<Result<FactExtractionData>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: createModel({ ...config, model: env.MEMORY_MODEL }),
      system: FACT_EXTRACTION_SYSTEM_PROMPT,
      prompt: buildFactExtractionPrompt(input),
      maxRetries: 0,
      maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: controller.signal,
      providerOptions: { deepinfra: { chat_template_kwargs: { enable_thinking: false } } },
    });
    const usage = {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
    };
    return ok({ candidates: parseFactCandidates(result.text, input.turns.length), usage });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    console.error('[extractFacts] extraction call failed:', error);
    return err('fact_extraction_failed', `The extraction call failed: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractFacts(
  input: FactExtractionInput,
): Promise<Result<FactExtractionData>> {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }
  return withOnDemandBackoff(() => extractOnce(config, input));
}
