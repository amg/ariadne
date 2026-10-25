import { env } from '@config/env';
import type { FactCategory } from '@db/types';
import { generateText } from 'ai';
import { err, ok } from '../../types/result';
import {
  type InferenceConfig,
  NOT_CONFIGURED_MESSAGE,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import {
  FACT_FIELD_RULES,
  factFieldsOf,
  isoDay,
  jsonObjectOrNull,
  trimmedOrNull,
} from './factFields';
import { withOnDemandBackoff } from './onDemandRetry';

type FactFields = NonNullable<ReturnType<typeof factFieldsOf>>;

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
// to it. Blocked categories join as a rule just before the last one.
const NOTHING_QUALIFIES_RULE = '- If nothing qualifies, output {"facts":[]}.';
const FACT_EXTRACTION_SYSTEM_PROMPT = `You extract durable facts about the user from a conversation; you never answer it. Read the numbered turns and output JSON only, in this shape:
{"facts":[{"turn":1,"content":"The user ...","category":"preference","subject":"user","predicate":"likes","object":"dogs","validAt":null}]}
Rules:
- A fact is one self-contained sentence about the user: who they are, what they like or avoid, their circumstances, people, work, places, or a correction they gave. It must still be useful in a future conversation with no other context. Write it in the third person, starting with "The user".
- Extract only what the user states or clearly confirms about themselves, their family, or people and pets they mention. Take every detail, dates included, from the user's own words; assistant replies only help you follow the conversation. Never extract the assistant's suggestions or general knowledge.
- Skip ephemeral details: one-off task requests, passing moods, anything true only for this conversation.
- turn is the number of the turn the fact comes from.
- Resolve relative time ("last week", "two years ago") into absolute dates using that turn's date. validAt is the date the fact became true as YYYY-MM-DD, only when the user states or directly implies it; otherwise null. A fact's own date (someone's birth, a move, a start) is its validAt.
- Read dates the way this user writes them: work out their day/month order from their other dates and the turn dates the conversation gives you. When the order stays ambiguous, leave validAt null rather than guess.
${FACT_FIELD_RULES}
${NOTHING_QUALIFIES_RULE}`;

/**
 * The extraction contract with the user's blocked categories as one rule
 * among the others. Stated as a line ahead of the conversation instead,
 * "Never extract facts in these categories: credentials." made the memory
 * model return no facts at all for whole conversations.
 */
export function factExtractionSystemPrompt(blockedCategories: readonly FactCategory[]) {
  if (blockedCategories.length === 0) return FACT_EXTRACTION_SYSTEM_PROMPT;
  return FACT_EXTRACTION_SYSTEM_PROMPT.replace(
    NOTHING_QUALIFIES_RULE,
    `- Leave out any fact whose category would be one of: ${blockedCategories.join(', ')}.\n${NOTHING_QUALIFIES_RULE}`,
  );
}

/**
 * Cold loads on the on-demand pool take ~15s (chats observed at 11.5s),
 * and a full pass over several turns can run ~30s to read out the facts;
 * 60s covers that with room to spare, and capture runs in the background.
 */
const EXTRACTION_TIMEOUT_MS = 60000;
const EXTRACTION_MAX_OUTPUT_TOKENS = 800;
const MAX_FACT_CHARS = 300;

interface FactExtractionTurn {
  /** When the Turn's user Message arrived; anchors relative dates. */
  date: Date;
  userText: string;
  /** Null when the Turn has no reply. */
  assistantText: string | null;
}

interface FactExtractionInput {
  turns: FactExtractionTurn[];
  /**
   * Turns already captured on an earlier pass: they are sent as context
   * (0-based count from the front) but facts are extracted only from the
   * later turns. 0 or undefined means everything is new.
   */
  contextCount?: number;
  /**
   * Fact sentences the Memory already holds about what the turns mention,
   * given as background for reading them.
   */
  knownFacts?: readonly string[];
  /** Categories the model is told never to extract. */
  blockedCategories: readonly FactCategory[];
}

interface FactCandidate extends FactFields {
  /** Index into the input turns. */
  turnIndex: number;
  content: string;
}

// Ahead of the turns: placed after them, the memory model dropped facts
// it extracts from the same turns without the section.
function knownFactsSection(knownFacts: readonly string[]) {
  if (knownFacts.length === 0) return '';
  const lines = knownFacts.map((fact) => `- ${fact}`).join('\n');
  return `Already known about the user from earlier conversations, as background for who and what the turns mention:\n${lines}\n\n`;
}

export function buildFactExtractionPrompt(
  input: Pick<FactExtractionInput, 'turns' | 'contextCount' | 'knownFacts'>,
) {
  const contextCount = input.contextCount ?? 0;
  const contextNote =
    contextCount > 0
      ? 'Turns marked [CONTEXT] were read on an earlier pass; use them only to resolve names and references. Extract facts only from turns marked [NEW].\n\n'
      : '';
  const turns = input.turns
    .map((turn, index) => {
      const tag = contextCount > 0 ? (index < contextCount ? ' [CONTEXT]' : ' [NEW]') : '';
      const reply = turn.assistantText === null ? '' : `\nAssistant: ${turn.assistantText}`;
      return `Turn ${index + 1}${tag} (${isoDay(turn.date)}):\nUser: ${turn.userText}${reply}`;
    })
    .join('\n\n');
  return `${knownFactsSection(input.knownFacts ?? [])}${contextNote}${turns}`;
}

function turnIndexOrLast(value: unknown, turnCount: number) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= turnCount) {
    return value - 1;
  }
  return turnCount - 1;
}

function candidateOrNull(entry: unknown, turnCount: number) {
  if (entry === null || typeof entry !== 'object') return null;
  // Narrowed to an object above; fields are validated one by one below.
  const raw = entry as Record<string, unknown>;
  const content = trimmedOrNull(raw.content, MAX_FACT_CHARS);
  if (content === null) return null;
  return {
    turnIndex: turnIndexOrLast(raw.turn, turnCount),
    content,
    ...factFieldsOf(raw),
  };
}

/**
 * Reads the model's JSON reply into candidates; null when no JSON object
 * can be found. Tolerates code fences and prose around the object, and
 * drops malformed entries one by one.
 */
export function parseFactCandidates(raw: string, turnCount: number) {
  const facts = jsonObjectOrNull(raw)?.facts;
  if (!Array.isArray(facts)) return null;
  return facts
    .map((entry) => candidateOrNull(entry, turnCount))
    .filter((candidate): candidate is FactCandidate => candidate !== null);
}

async function extractOnce(config: InferenceConfig, input: FactExtractionInput) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: createModel({ ...config, model: env.MEMORY_MODEL }),
      system: factExtractionSystemPrompt(input.blockedCategories),
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

export async function extractFacts(input: FactExtractionInput) {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }
  return withOnDemandBackoff(() => extractOnce(config, input));
}
