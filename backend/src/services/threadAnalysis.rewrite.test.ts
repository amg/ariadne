import { env } from '@config/env';
import type { Message } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DEFAULT_ANALYZE_OPTIONS,
  analyzeThread,
  renderThreadReport,
} from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../mock/inferenceServer';
import { parseJudgeLabel } from './aiService/judge';
import { simulateGateReplay } from './threadAnalysis/gateReplay';
import {
  REWRITE_CONTEXT_LIMITS,
  REWRITE_MAX_TRIGGER_LENGTH,
  capContext,
  needsRewriteHeuristic,
  parseRewrite,
  rewriteBackstopCandidates,
  rewriteCandidates,
} from './threadAnalysis/rewrite';
import { type Turn, formattedProspectiveTurn } from './threadAnalysis/turns';
import type { JudgingParams } from './threadAnalysis/verdict';

/**
 * The rewrite tier, tested at two levels: the pure policy (anaphora heuristic, candidate
 * selection, rewrite parsing) and crafted vectors against the verdict
 * layer, then real e2e through `analyzeThread` against the mock provider
 * — the mock's deterministic rewrite (`Rewritten: <follow-up> (refers to:
 * <prior user>)`) lets the dual signal's wiring, costs, graceful
 * degradation and renderer assertions run without a real model.
 */

const USER_ID = DEFAULT_USER_ID;

/* ------------------------------------------------------------------ */
/* Pure policy                                                         */
/* ------------------------------------------------------------------ */

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

  it('caps context text deterministically', () => {
    expect(capContext('short', 240)).toBe('short');
    const long = 'a'.repeat(REWRITE_CONTEXT_LIMITS.user + 40);
    const capped = capContext(long, REWRITE_CONTEXT_LIMITS.user);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped.length).toBe(REWRITE_CONTEXT_LIMITS.user + 1);
  });
});

describe('rewrite policy — candidate selection', () => {
  function fakeTurn(turnNumber: number, user: string, assistant = 'reply'): Turn {
    return {
      turnNumber,
      userMessage: { content: user } as unknown as Message,
      assistantMessage: { content: assistant } as unknown as Message,
    };
  }

  const turns = [
    fakeTurn(1, 'how much can a person lift?'),
    fakeTurn(2, 'and what are the records?'),
    fakeTurn(3, 'what about a motorcycle?'),
    fakeTurn(4, 'does it rain often in Melbourne?'),
  ];

  it('off yields nothing', () => {
    expect(rewriteCandidates(turns, 'off')).toEqual([]);
  });

  it('heuristic keeps only short anaphoric follow-ups, never Turn 1', () => {
    const candidates = rewriteCandidates(turns, 'heuristic');
    expect(candidates.map((c) => c.turnNumber)).toEqual([2, 3]);
    const motorcycle = candidates.find((c) => c.turnNumber === 3);
    expect(motorcycle?.contextUserText).toBe('and what are the records?');
    expect(motorcycle?.contextAssistantText).toBe('reply');
    expect(motorcycle?.incomingText).toBe('what about a motorcycle?');
  });

  it('always rewrites every Turn with a prior exchange', () => {
    expect(rewriteCandidates(turns, 'always').map((c) => c.turnNumber)).toEqual([2, 3, 4]);
  });
});

describe('rewrite policy — the judge backstop shortlist', () => {
  function fakeTurn(turnNumber: number, user: string, assistant = 'reply'): Turn {
    return {
      turnNumber,
      userMessage: { content: user } as unknown as Message,
      assistantMessage: { content: assistant } as unknown as Message,
    };
  }

  const turns = [
    fakeTurn(1, "let's talk gym. how much can a person lift?"),
    fakeTurn(2, 'keep it short. records?'),
    fakeTurn(3, 'and what are the records?'),
    fakeTurn(4, 'does it rain often in Melbourne?'),
    fakeTurn(5, 'is there a silver bullet for this?'),
    fakeTurn(6, `long miss ${'x'.repeat(REWRITE_MAX_TRIGGER_LENGTH)}`),
  ];

  it('shortlists every short miss of the heuristic — including Turn 1 anchors like the silver-bullet class', () => {
    // Turn 2 (bare trailing question) and Turn 4 (self-contained pivot)
    // both ask the judge: the shortlist is worth-asking, not a verdict.
    // Turn 5 is the motivating class — a dangling "for this" no token
    // list anticipates. The heuristic's own picks (Turn 3) and the
    // over-long Turn 6 never judge.
    const shortlist = rewriteBackstopCandidates(turns);
    expect(shortlist.map((c) => c.turnNumber)).toEqual([2, 4, 5]);
    const silverBullet = shortlist.find((c) => c.turnNumber === 5);
    expect(silverBullet?.contextUserText).toBe('does it rain often in Melbourne?');
    expect(silverBullet?.contextAssistantText).toBe('reply');
    expect(silverBullet?.incomingText).toBe('is there a silver bullet for this?');
  });

  it('never shortlists Turn 1 (no prior exchange to judge against)', () => {
    const shortlist = rewriteBackstopCandidates([fakeTurn(1, 'records?')]);
    expect(shortlist).toEqual([]);
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

/* ------------------------------------------------------------------ */
/* The dual channel at the verdict layer (crafted vectors)             */
/* ------------------------------------------------------------------ */

describe('scoreGateReplay — the composite verdict signal', () => {
  /** Basis direction in dimension d — nearly orthogonal synthetic vectors. */
  function basis(dim: number, index: number): number[] {
    const vector = new Array<number>(dim).fill(0);
    vector[index % dim] = 1;
    return vector;
  }

  const judging: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS, segmentThreshold: 0.45 };

  it('verdicts ride the rewritten readings; the raw reading is the fallback', () => {
    const dim = 8;
    const flat = basis(dim, 0);
    const climb = basis(dim, 1);
    const turnNumbers = [1, 2, 3, 4, 5];
    const scoring = simulateGateReplay({
      turnNumbers,
      // Raw stream climbs everywhere — the short-message collapse; the
      // rewrite restores the baseline on continuations and only the pivot
      // stays high.
      prospectiveVectorByTurn: new Map(turnNumbers.map((n) => [n, climb])),
      // Turn 1 holds no Gravity point (muted); Turn 2's rewrite resolves
      // back to the baseline, Turn 3's stays on the climb, Turn 4
      // resolves again, Turn 5 has no rewrite → raw fallback.
      rewrittenVectorByTurn: new Map([
        [2, flat],
        [3, climb],
        [4, flat],
      ]),
      rewrittenTextByTurn: new Map([
        [2, 'rewritten two'],
        [3, 'rewritten three'],
        [4, 'rewritten four'],
      ]),
      rewriteNoteByTurn: { 5: 'skip_unusable_rewrite' },
      // Stored Turn vectors: flat until the pivot lands — they carry the
      // fold's membership, not the verdict (the replay judges the
      // composite prospective reading alone).
      turnVectorByTurn: new Map([
        [1, flat],
        [2, flat],
        [3, climb],
        [4, climb],
        [5, climb],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        ...turnNumbers.slice(1).map((n): [number, number[]] => [n, flat]),
      ]),
      foldBoundaryTurns: new Set(),
      anchorVector: flat,
      userMessageIdByTurn: new Map(turnNumbers.map((t) => [t, 'msg'])),
      userMessageIndexByTurn: new Map(turnNumbers.map((n) => [n, n * 2 - 1])),
      judging,
    });
    const points = scoring.points;

    // Both readings are present; the source names the one that decided.
    expect(points[0]?.driftPGated).toBeNull(); // Turn 1 muted
    expect(points[1]?.driftP).toBeCloseTo(1, 5); // raw: climbs everywhere
    expect(points[1]?.driftPGated).toBeCloseTo(0, 5); // rewrite resolves the baseline
    expect(points[1]?.driftPSource).toBe('rewritten');
    expect(points[2]?.driftPGated).toBeCloseTo(1, 5); // the pivot stays high
    expect(points[2]?.rewrittenText).toBe('rewritten three');
    expect(points[4]?.driftPSource).toBe('raw-fallback'); // no rewrite → raw
    expect(points[4]?.rewriteNote).toBe('skip_unusable_rewrite');

    // Verdicts: the rewrite prevents firing on the baseline continuation
    // (Turn 2 stays quiet where the raw stream climbed); the pivot's
    // reading itself clears the segment's criterion — the immediate
    // channel decides at the arrival Turn. The verdict
    // shreds the baseline, so the replay re-bootstraps on T_segment —
    // and Turn 5's raw fallback then reads 1.0 against that constant
    // and fires again: the adjustment class gets no geometric
    // second-guess — its treatment is uniform (the rewrite tier), and
    // an arriving pivot is a pivot whatever it sits near.
    expect(points.map((point) => point.verdict)).toEqual(['muted', 'pass', 'fire', 'pass', 'fire']);
    expect(points[2]?.fireChannel).toBe('immediate');
    expect(points[4]?.fireChannel).toBe('immediate');
    expect(points[4]?.immediateThreshold).toBeCloseTo(0.45, 5); // re-bootstrapped
    // The Turn-4 continuation folded while the baseline was still warming:
    // one accepted member — the constant still stands in (A2's 0–1 rule).
    expect(points[4]?.segmentMu).toBeCloseTo(0, 5);
    expect(points[4]?.segmentSigma).toBeNull();
    // The fold is static in this synthetic (no cuts), so the pivot's
    // fire AND the raw-fallback re-fire both record the honest
    // disagreement row: gate fired, fold quiet. The second row is only
    // interesting now — the adjustment class is treated uniformly, so
    // it is just an arriving pivot like any other.
    expect(scoring.divergences).toEqual([
      { turnNumber: 3, kind: 'gate_fired_fold_quiet' },
      { turnNumber: 5, kind: 'gate_fired_fold_quiet' },
    ]);
  });

  it('no expansion maps → byte-stable original shape: raw readings, no annotations', () => {
    const dim = 8;
    const flat = basis(dim, 0);
    const climb = basis(dim, 1);
    const scoring = simulateGateReplay({
      turnNumbers: [1, 2, 3],
      prospectiveVectorByTurn: new Map([
        [1, flat],
        [2, flat],
        [3, climb],
      ]),
      turnVectorByTurn: new Map([
        [1, flat],
        [2, flat],
        [3, climb],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, flat],
        [3, flat],
      ]),
      foldBoundaryTurns: new Set(),
      anchorVector: flat,
      userMessageIdByTurn: new Map([
        [1, 'msg'],
        [2, 'msg'],
        [3, 'msg'],
      ]),
      userMessageIndexByTurn: new Map([
        [1, 1],
        [2, 3],
        [3, 5],
      ]),
      judging,
    });
    for (const point of scoring.points) {
      expect('driftPSource' in point).toBe(false);
      expect('rewriteNote' in point).toBe(false);
      expect('rewrittenText' in point).toBe(false);
      // No rewrite tier: the composite IS the raw reading.
      expect(point.driftPGated).toBe(point.driftP);
    }
  });

  it('annotates every gap: mute wins, rewrite overrides, otherwise the analyzer note', () => {
    const dim = 8;
    const flat = basis(dim, 0);
    const turnNumbers = [1, 2, 3];
    const scoring = simulateGateReplay({
      turnNumbers,
      prospectiveVectorByTurn: new Map(turnNumbers.map((n) => [n, flat])),
      rewrittenVectorByTurn: new Map([[2, flat]]),
      rewriteNoteByTurn: {
        1: 'skip_no_candidate',
        2: 'skip_no_candidate',
        3: 'skip_unusable_rewrite',
      },
      turnVectorByTurn: new Map(turnNumbers.map((n) => [n, flat])),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, flat],
        [3, flat],
      ]),
      foldBoundaryTurns: new Set(),
      anchorVector: flat,
      userMessageIdByTurn: new Map(turnNumbers.map((t) => [t, 'msg'])),
      userMessageIndexByTurn: new Map(turnNumbers.map((n) => [n, n * 2 - 1])),
      judging,
    });

    // Turn 1 is muted (no Gravity point): the mute explains the gap.
    expect(scoring.points[0]?.rewriteNote).toBe('muted');
    // Turn 2 is unmuted and carries a rewritten vector: 'rewrite' wins
    // over the stale analyzer note for the same Turn.
    expect(scoring.points[1]?.rewriteNote).toBe('rewrite');
    // Turn 3 is unmuted with no rewrite: the analyzer's reason carries.
    expect(scoring.points[2]?.rewriteNote).toBe('skip_unusable_rewrite');
  });
});

/* ------------------------------------------------------------------ */
/* e2e through analyzeThread (mock provider)                           */
/* ------------------------------------------------------------------ */

type TurnSpec = { user: string; assistant: string };

async function seedThread(title: string, specs: TurnSpec[]): Promise<string> {
  await insertUserIfNotExists({ id: USER_ID });
  const thread = await insertThread({ userId: USER_ID, title });
  for (const spec of specs) {
    await insertMessage({ threadId: thread.id, role: 'user', content: spec.user });
    await insertMessage({ threadId: thread.id, role: 'assistant', content: spec.assistant });
  }
  return thread.id;
}

const CORPUS: TurnSpec[] = [
  {
    user: "let's talk gym. how much can a person lift?",
    assistant: 'depends on training, body weight and technique.',
  },
  {
    user: 'keep it short. records?',
    assistant: 'record deadlifts are exceptional cases.',
  },
  {
    user: 'what about a motorcycle?',
    assistant: 'some strong men might lift a small one.',
  },
  {
    user: 'does it rain in melbourne?',
    assistant: 'yes, frequently across the year.',
  },
  {
    user: 'so shall I bring an umbrella?',
    assistant: 'yes, especially in the cooler months.',
  },
];

useTestDb();

let mock: MockInferenceServer;
let savedMockUrl: string | undefined;

beforeAll(async () => {
  savedMockUrl = process.env.MOCK_AI_BASE_URL;
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  mock.embeddings.clearFailures();
  mock.rewrites.clearFailures();
  mock.judges.clearFailures();
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  await mock.stop();
});

describe('analyzeThread — rewrite e2e', () => {
  it('heuristic mode: dual signal on triggered Turns, raw fast path elsewhere', async () => {
    const threadId = await seedThread('expansion-corpus', CORPUS);
    const before = mock.embeddings.requestCount();

    const result = await analyzeThread(threadId, { gateReplay: true, rewrite: 'heuristic' });
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const report = result.data;

    // Provenance block carries mode + both models: the rewriter (always)
    // and the judge (consulted in heuristic mode), exactly once.
    expect(report.params.rewrite).toEqual({
      mode: 'heuristic',
      modelId: env.REWRITE_MODEL,
      judgeModelId: env.JUDGE_MODEL,
    });

    // Turns 2, 3 and 5 ride the rewritten reading: 3 and 5 via the
    // anaphora heuristic, 2 via the judge backstop ("keep it short.
    // records?" dangles a referent no token list catches). The rest
    // score the raw fallback reading for the verdict.
    const rewrittenTurns = report.gateReplay
      ? report.gateReplay.points
          .filter((point) => point.driftPSource === 'rewritten')
          .map((point) => point.turnNumber)
      : [];
    expect(rewrittenTurns).toEqual([2, 3, 5]);

    // The judge-driven rewrite lands exactly like a heuristic one:
    // same expanded embed, same composite verdict signal.
    const turnTwo = report.gateReplay?.points[1];
    expect(turnTwo?.rewrittenText).toContain('keep it short. records? (refers to:');
    expect(turnTwo?.driftPSource).toBe('rewritten');
    expect(turnTwo?.driftPGated).toBeGreaterThanOrEqual(0);
    expect(turnTwo?.driftPGated).toBeLessThanOrEqual(2);

    const turnThree = report.gateReplay?.points[2];
    expect(turnThree?.rewrittenText).toBe(
      'what about a motorcycle? (refers to: keep it short. records?)',
    );
    // The verdict signal is drift_p on the deterministic mock embed of the
    // rewritten block (mock geometry → finite on the cosine scale).
    expect(turnThree?.driftPGated).toBeGreaterThanOrEqual(0);
    expect(turnThree?.driftPGated).toBeLessThanOrEqual(2);

    // Skipped Turns decide on the raw fallback: same number as the raw
    // reading, flagged as such, gap explained — and a judge-considered
    // self-contained message explains itself as judged, not unconsidered.
    const turnFour = report.gateReplay?.points[3];
    expect('rewrittenText' in (turnFour ?? {})).toBe(false);
    expect(turnFour?.driftPSource).toBe('raw-fallback');
    expect(turnFour?.driftPGated).toBe(turnFour?.driftP);
    expect(turnFour?.rewriteNote).toBe('skip_judge_self_contained');

    // Two heuristic rewrites (T3, T5) + one judge-added rewrite (T2),
    // each with its transient expanded embed: 5 stored Turns +
    // 5 prospected + 3 expanded.
    expect(mock.embeddings.requestCount() - before).toBe(13);
    expect(report.totals.rewriteCostUsd).toBeGreaterThan(0);
    expect(report.totals.embeddingCostUsd).toBeGreaterThan(0);
    expect(report.totals.judgeCostUsd).toBeGreaterThan(0);

    // Renderer: composite verdict series, raw audit series, dual columns
    // — and the audit trail.
    const { html } = renderThreadReport(report);
    expect(html).toContain('series-raw-drift');
    expect(html).toContain('drift_p (verdict)');
    expect(html).toContain('Expansion pipeline active');
    expect(html).toContain('(refers to: keep it short. records?)');
    expect(html).toContain('data-toggle="raw"');
    // The lanes spelled out, one checkbox each.
    expect(html).toContain('Live gate — two scales of the same arrivals.');
    expect(html).toContain('drift_p on the raw message (audit)');
    expect(html).toContain('rewritten user message (the expanded embed)');

    // JSON sidecar carries the composite fields verbatim.
    const parsed = JSON.parse(renderThreadReport(report).json) as typeof report;
    expect(parsed.params.rewrite?.mode).toBe('heuristic');
    expect(parsed.gateReplay?.points[2]?.rewrittenText).toBe(turnThree?.rewrittenText);
    expect(parsed.gateReplay?.points[2]?.driftPSource).toBe('rewritten');

    // Every un-rewritten gated Turn explains its fallback.
    for (const point of report.gateReplay?.points ?? []) {
      if (point.driftPSource !== 'rewritten') {
        expect(point.rewriteNote).toBeDefined();
      }
    }
  });

  it('off stays byte-compatible with legacy replays', async () => {
    const threadId = await seedThread('expansion-off', CORPUS);
    const before = mock.embeddings.requestCount();

    const result = await analyzeThread(threadId, { gateReplay: true, rewrite: 'off' });
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const report = result.data;

    expect(report.params.rewrite).toBeUndefined();
    expect(report.totals.rewriteCostUsd).toBe(0);
    expect(report.totals.judgeCostUsd).toBe(0);
    // No extra embed calls, no expansion fields anywhere.
    expect(mock.embeddings.requestCount() - before).toBe(10);
    for (const point of report.gateReplay?.points ?? []) {
      expect('driftPSource' in point).toBe(false);
      expect('rewrittenText' in point).toBe(false);
      // No composite distinction either: the verdict signal IS the raw one.
      expect(point.driftPGated).toBe(point.driftP);
      // 'off' explains itself by carrying no annotation at all — the
      // report stays byte-compatible with previous versions replay.
      expect('rewriteNote' in point).toBe(false);
    }
    const { html } = renderThreadReport(report);
    expect(html).not.toContain('series-raw-drift');
    expect(html).not.toContain('drift_p (verdict)');
    expect(html).not.toContain('Expansion pipeline active');
    // No raw audit lane, no expansion UI — the live chart stays minimal
    // without the rewrite tier's audit reading.
    expect(html).not.toContain('drift_p on the raw message (audit)');
    expect(html).not.toContain('rewritten user message');
  });

  it('rewrite failures degrade gracefully: the raw-only verdict stands', async () => {
    const threadId = await seedThread('expansion-fail', CORPUS);
    mock.rewrites.failAll();
    const before = mock.embeddings.requestCount();

    const result = await analyzeThread(threadId, { gateReplay: true, rewrite: 'heuristic' });
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const report = result.data;

    // Rewrites failed for all three candidates — the two heuristic picks
    // plus the judge-added bare-question Turn: no rewritten embeds, zero
    // rewrite cost, and the report still carries the expansion provenance
    // (it ran, judge included). The verdict is decided on the raw
    // fallback everywhere.
    expect(mock.embeddings.requestCount() - before).toBe(10);
    expect(report.totals.rewriteCostUsd).toBe(0);
    expect(report.totals.judgeCostUsd).toBeGreaterThan(0);
    expect(report.params.rewrite).toEqual({
      mode: 'heuristic',
      modelId: env.REWRITE_MODEL,
      judgeModelId: env.JUDGE_MODEL,
    });
    for (const point of report.gateReplay?.points ?? []) {
      expect(point.driftPSource).toBe('raw-fallback');
      expect(point.driftPGated).toBe(point.driftP);
    }
    // Unmuted candidate Turns explain the failed rewrite — including the
    // judge-added Turn 2 (its verdict landed, the rewrite didn't); the
    // self-contained Turn 4 explains itself as judged. Muted Turns
    // explain themselves as mute (the fold wins the annotation).
    const turnTwo = report.gateReplay?.points[1];
    expect(turnTwo?.rewriteNote).toBe('skip_rewrite_failed');
    const turnFour = report.gateReplay?.points[3];
    expect(turnFour?.rewriteNote).toBe('skip_judge_self_contained');
    const turnFive = report.gateReplay?.points[4];
    expect(turnFive?.rewriteNote).toBe('skip_rewrite_failed');
    // Every Turn still carries its drift_p and verdict.
    expect(report.gateReplay?.points.every((point) => point.driftP !== undefined)).toBe(true);
  });

  it('always mode rewrites every Turn with a prior exchange', async () => {
    const threadId = await seedThread('expansion-always', CORPUS);

    const result = await analyzeThread(threadId, { gateReplay: true, rewrite: 'always' });
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const report = result.data;

    // Turns 2–5 all ride the rewritten reading; Turn 1 has no prior
    // exchange (and no Gravity point), so it never does.
    const rewrittenTurns =
      report.gateReplay?.points
        .filter((point) => point.driftPSource === 'rewritten')
        .map((point) => point.turnNumber) ?? [];
    expect(rewrittenTurns).toEqual([2, 3, 4, 5]);
    expect(report.params.rewrite).toEqual({ mode: 'always', modelId: env.REWRITE_MODEL });
    // Always mode rewrites everything — the judge has nothing to add.
    expect(report.totals.judgeCostUsd).toBe(0);
  });

  it('judge failures fail open: the heuristic-only path stands', async () => {
    const threadId = await seedThread('expansion-judge-down', CORPUS);
    mock.judges.failAll();
    const before = mock.embeddings.requestCount();

    const result = await analyzeThread(threadId, { gateReplay: true, rewrite: 'heuristic' });
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const report = result.data;

    // No verdicts landed: only the heuristic's own picks ride rewritten
    // readings — exactly the pre-judge behavior. Two expanded embeds.
    const rewrittenTurns =
      report.gateReplay?.points
        .filter((point) => point.driftPSource === 'rewritten')
        .map((point) => point.turnNumber) ?? [];
    expect(rewrittenTurns).toEqual([3, 5]);
    expect(mock.embeddings.requestCount() - before).toBe(12);
    expect(report.totals.judgeCostUsd).toBe(0);
    // The failed consultations explain themselves on both shortlisted
    // Turns, and provenance still carries the attempted judge model.
    expect(report.gateReplay?.points[1]?.rewriteNote).toBe('skip_judge_failed');
    expect(report.gateReplay?.points[3]?.rewriteNote).toBe('skip_judge_failed');
    expect(report.params.rewrite).toEqual({
      mode: 'heuristic',
      modelId: env.REWRITE_MODEL,
      judgeModelId: env.JUDGE_MODEL,
    });
  });
});
