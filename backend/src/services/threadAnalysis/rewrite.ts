import type { Turn } from './turns';
import type { RewriteMode } from './types';

/**
 * The rewrite tier of the gate replay: which incoming user
 * messages get a detached decontextualising rewrite before their
 * Prospective Turn embeds, and how the rewriter's context and output are
 * shaped. Everything here is pure policy — the rewrite and judge calls
 * themselves live at the provider boundary (`aiService/rewrite.ts`,
 * `aiService/judge.ts`), the verdict layer never sees this folder. All
 * knobs are module constants so a future calibration session tunes one
 * place.
 *
 * Why the trigger is a heuristic first, not every Turn: self-contained
 * pivots ("why do flowers need watering?") embed fine raw and would burn
 * a rewrite call for nothing — the ambiguous anaphoric follow-ups ("what
 * about a motorcycle?") are the class that collapses the prospective
 * signal, so they are the only class that pays. And why the heuristic's
 * misses get a judge backstop in `heuristic` mode: the trigger regex
 * false-negates on quirks it cannot anticipate ("Is there a silver
 * bullet for this?"), silently letting an anaphoric arrival embed raw;
 * one cheap small-model verdict per short miss plugs that hole —
 * verdicts only ADD candidates, failures fail open to the raw path.
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
export function needsRewriteHeuristic(text: string): boolean {
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
export function capContext(text: string, limit: number): string {
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

export interface RewriteCandidate {
  /** The Turn whose incoming user message gets rewritten. */
  turnNumber: number;
  /** Prior Turn content, already capped for the rewrite prompt. */
  contextUserText: string;
  contextAssistantText: string;
  /** The incoming user message, verbatim. */
  incomingText: string;
}

/**
 * The Turns that take the rewrite path for a given mode: `off` — none;
 * `heuristic` — only short anaphoric follow-ups (Turn 1 never qualifies:
 * no prior exchange to resolve against); `always` — every Turn with a
 * prior exchange (the corpus-benchmark mode, never a production default).
 * `heuristic` mode's misses have a second chance: see
 * `rewriteBackstopCandidates` and the analyzer's judge consultation.
 */
export function rewriteCandidates(turns: Turn[], mode: RewriteMode): RewriteCandidate[] {
  if (mode === 'off') return [];
  const candidates: RewriteCandidate[] = [];
  for (let index = 1; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) continue;
    const incoming = turn.userMessage.content;
    if (mode === 'heuristic' && !needsRewriteHeuristic(incoming)) continue;
    const prior = turns[index - 1];
    if (!prior) continue;
    candidates.push({
      turnNumber: turn.turnNumber,
      contextUserText: capContext(prior.userMessage.content, REWRITE_CONTEXT_LIMITS.user),
      contextAssistantText: capContext(
        prior.assistantMessage.content,
        REWRITE_CONTEXT_LIMITS.assistant,
      ),
      incomingText: incoming,
    });
  }
  return candidates;
}

/** Strips a prompting leak a model may echo back ("Rewritten:", quotes). */
/**
 * The judge backstop shortlist for `heuristic` mode: every short message
 * the anaphora trigger let through (and that has a prior Turn to consult
 * against). Language quirks outrun regex — "Is there a silver bullet for
 * this?" carries a dangling referent no token list anticipates — so the
 * heuristic's misses ask a small classifier instead of silently embedding
 * raw. Pure policy: deciding that a message is WORTH JUDGING; the judge
 * call itself lives at the provider boundary (`aiService/judge.ts`), and
 * its verdict only ever ADDS rewrite candidates — never vetoes the
 * heuristic's own picks. Same length bounds as the heuristic: long
 * messages carry enough content to stand alone and never pay for a
 * verdict. Empty in `off`/`always` modes (nothing to backstop on / every
 * Turn already rides a rewrite).
 */
export function rewriteBackstopCandidates(turns: Turn[]): RewriteCandidate[] {
  const candidates: RewriteCandidate[] = [];
  for (let index = 1; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) continue;
    const incoming = turn.userMessage.content;
    if (needsRewriteHeuristic(incoming)) continue;
    const trimmed = incoming.trim();
    if (trimmed.length === 0 || trimmed.length > REWRITE_MAX_TRIGGER_LENGTH) continue;
    const prior = turns[index - 1];
    if (!prior) continue;
    candidates.push({
      turnNumber: turn.turnNumber,
      contextUserText: capContext(prior.userMessage.content, REWRITE_CONTEXT_LIMITS.user),
      contextAssistantText: capContext(
        prior.assistantMessage.content,
        REWRITE_CONTEXT_LIMITS.assistant,
      ),
      incomingText: incoming,
    });
  }
  return candidates;
}

function stripDecorations(text: string): string {
  return text
    .replace(/^[\s"'`]+/, '')
    .replace(/^(rewritten|rewrite|expanded|result)\s*:\s*/i, '')
    .replace(/[\s"'`]+$/, '');
}

const QUESTION_OPENERS =
  /^(?:why|what|how|when|where|who|which|do|does|did|is|are|was|were|can|could|should|would|will|shall|have|has|had)\b/i;
const AFFIRMATIVE_OPENERS =
  /^(?:yes|no|yeah|yep|nah|nope|absolutely|correct|exactly|right|indeed|sure)\b[\s,.!]/i;

function looksLikeAQuestion(text: string): boolean {
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
function rewriteLooksLikeAnAnswer(rewrite: string, incomingText: string): boolean {
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
export function parseRewrite(raw: string, incomingText: string): string | null {
  const cleaned = stripDecorations(raw).trim();
  if (cleaned.length === 0) return null;
  if (cleaned.toLowerCase() === incomingText.trim().toLowerCase()) return null;
  if (rewriteLooksLikeAnAnswer(cleaned, incomingText)) return null;
  if (cleaned.length <= REWRITE_CONTEXT_LIMITS.output) return cleaned;
  return `${cleaned.slice(0, REWRITE_CONTEXT_LIMITS.output)}…`;
}
