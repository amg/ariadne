/**
 * The arrival rewrite policy: which incoming user messages read as
 * continuations and get a self-contained rewrite before they embed, how
 * much prior context the rewriter sees, and which rewrites are usable.
 * Self-contained messages embed raw, so only follow-ups pay for a rewrite.
 */

/** Messages longer than this carry enough content to stand alone. */
export const REWRITE_MAX_TRIGGER_LENGTH = 120;

/** Openers that mark a message as continuing the previous Turn's topic. */
const ANAPHORIC_OPENERS = new Set(['so', 'and', 'but', 'also', 'plus', 'then', 'now', 'anyway']);

/** Token patterns that refer back instead of naming a topic. */
const ANAPHORIC_TOKENS =
  /\b(what about|how about|as for|the same|the other|that one|this one|those|these|as well|it too|one too)\b/i;

/**
 * The deterministic anaphora trigger: short AND (continuing-opener OR
 * referential token). Self-contained pivots skip this → raw fast path,
 * zero rewrite spend, zero added latency on the arrival decision.
 */
export function needsRewriteHeuristic(text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > REWRITE_MAX_TRIGGER_LENGTH) return false;
  const firstWord = (trimmed.split(/\s/, 1)[0] ?? '').toLowerCase().replace(/[^a-z']/g, '');
  return ANAPHORIC_OPENERS.has(firstWord) || ANAPHORIC_TOKENS.test(trimmed);
}

/** How much of the prior Turn the judge and the rewriter each see.
 * Both read the same prior context: half of the rewrite model's context
 * window (~4 chars per token), sized so real exchanges pass through
 * whole. `output` bounds the parsed rewrite text itself. */
export const REWRITE_CONTEXT_LIMITS = { user: 20_000, assistant: 40_000, output: 500 } as const;

/** Caps context at the last sentence boundary inside the budget — a
 * clean sentence the model can read whole. The budget itself is the
 * fallback when the slice holds no sentence end to cut at. */
export function capContext(text: string, limit: number) {
  if (text.length <= limit) return text;
  const budget = text.slice(0, limit);
  const cut = Math.max(
    budget.lastIndexOf('. '),
    budget.lastIndexOf('? '),
    budget.lastIndexOf('! '),
  );
  if (cut < 0) return budget.trimEnd();
  return budget.slice(0, cut + 1).trimEnd();
}

/** Strips a prompting leak a model may echo back ("Rewritten:", quotes). */
function stripDecorations(text: string) {
  return text
    .replace(/^[\s"'`]+/, '')
    .replace(/^(rewritten|rewrite|expanded|result)\s*:\s*/i, '')
    .replace(/[\s"'`]+$/, '');
}

const QUESTION_OPENERS =
  /^(?:why|what|how|when|where|who|which|do|does|did|is|are|was|were|can|could|should|would|will|shall|have|has|had)\b/i;
const AFFIRMATIVE_OPENERS =
  /^(?:yes|no|yeah|yep|nah|nope|absolutely|correct|exactly|right|indeed|sure)\b[\s,.!]/i;

function looksLikeAQuestion(text: string) {
  const trimmed = text.trim();
  return trimmed.endsWith('?') || QUESTION_OPENERS.test(trimmed);
}

/**
 * The role-drift guard: a rewrite must stay in the user's
 * voice. Small models answer instead of rewriting — "Should I carry an
 * umbrella?" came back as "Yes, you should carry an umbrella when you're
 * in Melbourne, because…". An affirmative opening (the user's own message
 * did not start affirmative), or a plain statement where the user's
 * message carried a question mark, marks the rewrite unusable: the Turn
 * reads better on its raw arrival-time text than on a manufactured
 * answer.
 */
function rewriteLooksLikeAnAnswer(rewrite: string, incomingText: string) {
  if (!looksLikeAQuestion(incomingText)) return false;
  const trimmedRewrite = rewrite.trim();
  const affirmative = AFFIRMATIVE_OPENERS.test(trimmedRewrite);
  const incomingAffirmative = AFFIRMATIVE_OPENERS.test(incomingText.trim());
  if (affirmative && !incomingAffirmative) return true;
  return !trimmedRewrite.includes('?');
}

/**
 * Sanitizes the rewriter's raw output into an embeddable message, or
 * `null` when it produced nothing usable (empty, whitespace-only, a bare
 * echo of the original — a rewrite that says nothing new would only
 * duplicate the raw signal — or an answer in the assistant's voice, which
 * would corrupt the signal toward the previous segment). Unusable output
 * means the Turn keeps its raw-only verdict; the rewrite tier is
 * strictly additive.
 */
export function parseRewrite(raw: string, incomingText: string) {
  const cleaned = stripDecorations(raw).trim();
  if (cleaned.length === 0) return null;
  if (cleaned.toLowerCase() === incomingText.trim().toLowerCase()) return null;
  if (rewriteLooksLikeAnAnswer(cleaned, incomingText)) return null;
  if (cleaned.length <= REWRITE_CONTEXT_LIMITS.output) return cleaned;
  return `${cleaned.slice(0, REWRITE_CONTEXT_LIMITS.output)}…`;
}
