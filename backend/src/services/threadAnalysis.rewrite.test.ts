import { describe, expect, it } from 'vitest';
import { parseJudgeLabel } from './aiService/judge';
import {
  REWRITE_CONTEXT_LIMITS,
  REWRITE_MAX_TRIGGER_LENGTH,
  capContext,
  needsRewriteHeuristic,
  parseRewrite,
} from './threadAnalysis/rewrite';

describe('rewrite policy — the anaphora heuristic', () => {
  it('flags short anaphoric follow-ups', () => {
    expect(needsRewriteHeuristic('what about a motorcycle?')).toBe(true);
    expect(needsRewriteHeuristic('so how heavy was that one?')).toBe(true);
    expect(needsRewriteHeuristic('and should I carry an umbrella?')).toBe(true);
    expect(needsRewriteHeuristic('does the same apply to cars?')).toBe(true);
  });

  it('skips self-contained messages', () => {
    expect(needsRewriteHeuristic('why do flowers need watering?')).toBe(false);
    expect(needsRewriteHeuristic('does it rain often in Melbourne?')).toBe(false);
    expect(needsRewriteHeuristic('What is the capital of France?')).toBe(false);
  });

  it('skips empty and over-long messages', () => {
    expect(needsRewriteHeuristic('')).toBe(false);
    expect(needsRewriteHeuristic('   ')).toBe(false);
    const longAnaphoric = `what about ${'x'.repeat(REWRITE_MAX_TRIGGER_LENGTH + 10)}`;
    expect(needsRewriteHeuristic(longAnaphoric)).toBe(false);
  });

  it('keeps context within budget unchanged', () => {
    expect(capContext('short', 240)).toBe('short');
    expect(capContext('Exactly at budget.', 18)).toBe('Exactly at budget.');
  });

  it('cuts at the last sentence boundary inside the budget', () => {
    const text = `First sentence. Second one. ${'tail words '.repeat(50)}`;
    const capped = capContext(text, 40);
    expect(capped).toBe('First sentence. Second one.');
  });

  it('hard-cuts at the budget when the slice holds no sentence end', () => {
    const capped = capContext(
      'a'.repeat(REWRITE_CONTEXT_LIMITS.user + 40),
      REWRITE_CONTEXT_LIMITS.user,
    );
    expect(capped.length).toBe(REWRITE_CONTEXT_LIMITS.user);
    expect(capped).toBe('a'.repeat(REWRITE_CONTEXT_LIMITS.user));
  });
});

describe('rewrite policy — judge label parsing', () => {
  it('reads both labels through surrounding noise', () => {
    expect(parseJudgeLabel('CONTEXT_DEPENDENT')).toBe('context-dependent');
    expect(parseJudgeLabel(' context_dependent ')).toBe('context-dependent');
    expect(parseJudgeLabel('Label: SELF_CONTAINED')).toBe('self-contained');
  });

  it('rejects anything that is not a label', () => {
    expect(parseJudgeLabel('Yes, it refers back.')).toBeNull();
    expect(parseJudgeLabel('')).toBeNull();
  });
});

describe('rewrite policy — rewrite parsing', () => {
  const incoming = 'what about a motorcycle?';

  it('keeps a genuinely different rewrite, stripping prompt decorations', () => {
    expect(parseRewrite('Rewritten: can a man bench a motorcycle?', incoming)).toBe(
      'can a man bench a motorcycle?',
    );
    expect(parseRewrite('  "Can a man bench a motorcycle?"  ', incoming)).toBe(
      'Can a man bench a motorcycle?',
    );
  });

  it('rejects empty or bare-echo rewrites', () => {
    expect(parseRewrite('', incoming)).toBeNull();
    expect(parseRewrite('   ', incoming)).toBeNull();
    expect(parseRewrite('Rewritten: what about a motorcycle?', incoming)).toBeNull();
    expect(parseRewrite('"What about a motorcycle?"', incoming)).toBeNull();
  });

  it('caps runaway output', () => {
    const runaway = `w${'o'.repeat(REWRITE_CONTEXT_LIMITS.output + 50)}?`;
    const capped = parseRewrite(runaway, incoming);
    expect(capped?.length).toBe(REWRITE_CONTEXT_LIMITS.output + 1);
    expect(capped?.endsWith('…')).toBe(true);
  });

  it('rejects rewrites that drifted into the assistant role (voice guard)', () => {
    // An affirmative answer to a question the user never opened with Yes/No.
    expect(
      parseRewrite(
        'Yes, you should carry an umbrella when in Melbourne.',
        'Should I carry an umbrella?',
      ),
    ).toBeNull();
    // A question flattened into a statement — the '?' is gone.
    expect(
      parseRewrite(
        'Flowers need sunlight for photosynthesis, growth, and survival.',
        'do flowers need light?',
      ),
    ).toBeNull();
    // User voice kept: the question stays a question.
    expect(parseRewrite('Do flowers need sunlight?', 'do flowers need light?')).toBe(
      'Do flowers need sunlight?',
    );
    // A legitimate affirmative follow-up keeps its opening (the guard only
    // fires on *new* affirmatives the user never spoke).
    expect(parseRewrite('Yes, but how much for two bikes?', 'yes, and how much for one?')).toBe(
      'Yes, but how much for two bikes?',
    );
    // The guard stays silent for non-question incoming (statement follow-ups).
    expect(parseRewrite('Rain in Melbourne is common even in summer.', 'sounds good')).toBe(
      'Rain in Melbourne is common even in summer.',
    );
  });
});
