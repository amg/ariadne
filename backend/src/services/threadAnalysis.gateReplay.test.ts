import type { Message } from '@db/types';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DEFAULT_ANALYZE_OPTIONS,
  DEFAULT_GATE_REPLAY_OPTIONS,
  analyzeThread,
  renderThreadReport,
} from '@services/threadAnalysis';
import type {
  AnchorCounselRow,
  EmdBaselineRow,
  EmdPairRow,
  EmdRevisitRow,
  GateDivergenceRow,
  GateReplayParams,
  GateReplayPoint,
  GateReplaySection,
  GateVerdict,
} from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  countMockEmbeddingPromptTokens,
  startMockInferenceServer,
} from '../../mock/inferenceServer';
import { buildEmdMatrix, sinkhornEmd } from './threadAnalysis/emd';
import { scoreGateReplay } from './threadAnalysis/gateReplay';
import { createPageHinkley } from './threadAnalysis/pageHinkley';
import { createRollingStats } from './threadAnalysis/rollingStats';
import { prospectiveText } from './threadAnalysis/turns';

/**
 * gate replay, tested at two levels:
 *  - deterministic synthetic vectors against the folder-private pure
 *    cores (PageHinkley, the pretend-replay verdict logic, Sinkhorn-EMD)
 *    — the mock embedding server's content-hash geometry can only build
 *    "identical or near-orthogonal", never the near-topic proximities the
 *    gate math separates, so the math is verified on crafted vectors;
 *  - real e2e through `analyzeThread`'s public seam for everything the
 *    mock CAN verify: mode wiring, cold-start mute, transient (never
 *    persisted) prospective embeds, cost accounting, failure paths,
 *    renderer rows.
 */

const USER_ID = DEFAULT_USER_ID;
const EMBEDDING_COST_PER_MILLION_USD = 0.01;

function embeddingCostUsd(text: string): number {
  return Number(
    ((countMockEmbeddingPromptTokens(text) * EMBEDDING_COST_PER_MILLION_USD) / 1_000_000).toFixed(
      10,
    ),
  );
}

/** Basis direction in dimension d — nearly orthogonal synthetic vectors. */
function basis(dim: number, index: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  vector[index % dim] = 1;
  return vector;
}

type TurnSpec = { user: string; assistant?: string };

async function seedThread(
  title: string,
  specs: TurnSpec[],
): Promise<{ threadId: string; messages: Message[] }> {
  await insertUserIfNotExists({ id: USER_ID });
  const thread = await insertThread({ userId: USER_ID, title });
  const messages: Message[] = [];
  for (const spec of specs) {
    const userMessage = await insertMessage({
      threadId: thread.id,
      role: 'user',
      content: spec.user,
    });
    messages.push(userMessage);
    if (spec.assistant === undefined) continue;
    messages.push(
      await insertMessage({ threadId: thread.id, role: 'assistant', content: spec.assistant }),
    );
  }
  return { threadId: thread.id, messages };
}

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
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  await mock.stop();
});

describe('PageHinkley — the crawling channel detector', () => {
  // The slow half of the two-channel verdict: it speaks only
  // while the immediate channel stays silent, and hard-resets after any
  // verdict.
  it('stays silent on a flat stream and fires on a sustained rise', () => {
    const gate = createPageHinkley({ lambda: 0.2, delta: 0.02, minSamples: 2 });
    // Flat baseline: nothing accumulates past the allowance.
    for (const sample of [0.3, 0.31, 0.29, 0.3, 0.305]) {
      expect(gate.update(sample)).toBe(false);
    }
    // Sustained rise above baseline + allowance fires.
    const verdicts = [0.62, 0.66, 0.7].map((sample) => gate.update(sample));
    expect(verdicts).toContain(true);
  });

  it('is blind to rises smaller than the allowance delta', () => {
    const gate = createPageHinkley({ lambda: 0.05, delta: 0.1, minSamples: 2 });
    const verdicts = [0.3, 0.31, 0.35, 0.33, 0.32, 0.36].map((sample) => gate.update(sample));
    expect(verdicts).toEqual([false, false, false, false, false, false]);
  });

  it('respects minSamples before any fire is admitted', () => {
    const gate = createPageHinkley({ lambda: 0.01, delta: 0, minSamples: 4 });
    // A true rise begins at sample 3, but the detector is locked until it
    // has seen minSamples — the valuable early evidence is deliberately
    // spent to keep the baseline honest.
    expect(gate.update(0.1)).toBe(false);
    expect(gate.update(0.1)).toBe(false);
    expect(gate.update(0.9)).toBe(false); // rising already, still locked
    expect(gate.update(0.9)).toBe(true); // sample 4: admitted and firing
  });

  it('learns the new regime after a fire: an equal rise does not re-fire', () => {
    const gate = createPageHinkley({ lambda: 0.2, delta: 0.02, minSamples: 2 });
    for (const sample of [0.3, 0.3, 0.75, 0.78, 0.8]) gate.update(sample);
    // The fire happened; state was reset (O(1): four scalars, nothing kept).
    expect(gate.sampleCount).toBeLessThan(5);
    // The elevated-but-flat new regime is the new baseline: no re-fire.
    const verdicts = [0.8, 0.79, 0.81, 0.8].map((sample) => gate.update(sample));
    expect(verdicts).toEqual([false, false, false, false]);
  });

  it('records the per-sample mean and rise — a fire sample keeps its firing rise', () => {
    const gate = createPageHinkley({ lambda: 0.2, delta: 0.02, minSamples: 2 });
    expect(gate.lastMean).toBeNull();
    expect(gate.lastRise).toBeNull();
    gate.update(0.3);
    expect(gate.lastMean).toBeCloseTo(0.3);
    expect(gate.lastRise).toBeCloseTo(0);
    gate.update(0.3);
    expect(gate.lastRise).toBeCloseTo(0);
    // The spike fires on the third sample; the recording keeps the
    // firing rise even though the detector reset its own state.
    expect(gate.update(0.9)).toBe(true);
    expect(gate.lastMean).toBeCloseTo(0.5);
    expect(gate.lastRise).toBeCloseTo(0.38);
    expect(gate.rise).toBe(0); // post-reset state, not the recorded sample
  });

  it('an external reset clears the accumulator AND its recording', () => {
    const gate = createPageHinkley({ lambda: 0.1, delta: 0.01, minSamples: 1 });
    expect(gate.update(0.1)).toBe(false);
    expect(gate.update(0.2)).toBe(false);
    expect(gate.lastMean).toBeCloseTo(0.15);
    expect(gate.lastRise).not.toBeNull();
    // An immediate-channel verdict hard-resets the accumulator: the spike
    // was never its sample, so its recording goes dormant too (the
    // segment ledger is a separate counter — it gets shredded the same
    // way by the replay, the task).
    gate.reset();
    expect(gate.sampleCount).toBe(0);
    expect(gate.lastRise).toBeNull();
    expect(gate.lastMean).toBeNull();
  });

  it('accumulates a sustained creep and fires within the λ budget on raw drift steps, stays silent on ±0.04 white noise', () => {
    // The patrol consumes the RAW drift readings themselves, so both the allowance and the fire budget live in
    // drift units — λ = 0.5, δ = 0, minSamples floor 3 as shipped.
    const gate = createPageHinkley({ lambda: 0.5, delta: 0, minSamples: 3 });
    // ±0.04 white noise around a quiet baseline: nothing accumulates and
    // the detector stays silent across 10 turns.
    const noise = [0.3, 0.34, 0.26, 0.32, 0.28, 0.33, 0.27, 0.31, 0.29, 0.3].map((step) =>
      gate.update(step),
    );
    expect(noise).toEqual(new Array(10).fill(false));
    // A sustained creep: a quiet baseline step, then +0.06 per turn.
    // Every post-baseline sample rises above the detector's own chasing
    // mean, so the accumulated rise grows monotonically and fires once
    // it crosses the λ budget.
    gate.reset();
    expect(gate.update(0.3)).toBe(false); // baseline
    const rises: number[] = [];
    const verdicts: boolean[] = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      verdicts.push(gate.update(0.3 + 0.06 * turn));
      rises.push(gate.lastRise as number);
      if (verdicts[verdicts.length - 1]) break;
    }
    // Fires within 8 creep turns of a +0.06/turn climb.
    expect(verdicts).toContain(true);
    expect(verdicts.filter((v) => v)).toHaveLength(1);
    // The climb accumulates — no dip in the recorded rise before the fire.
    expect(rises.every((rise, i) => i === 0 || rise >= (rises[i - 1] as number))).toBe(true);
    // The rise that fired reached the λ budget, in drift units.
    expect(rises[rises.length - 1] as number).toBeGreaterThanOrEqual(0.5);
  });
});

describe('RollingStats — the immediate channel noise state', () => {
  it('folds Welford-style, mean from the first sample, SAMPLE std from the second', () => {
    const stats = createRollingStats();
    expect(stats.mean).toBeNull();
    expect(stats.std).toBeNull();
    stats.add(0.2);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBeCloseTo(0.2);
    expect(stats.std).toBeNull(); // warming up: the sample σ needs two folds
    stats.add(0.6);
    expect(stats.mean).toBeCloseTo(0.4);
    // Sample σ divides by n−1: √(0.08/1) ≈ 0.2828, not the population's 0.2.
    expect(stats.std).toBeCloseTo(Math.sqrt(0.08), 10);
  });

  it('keeps moments honest over many mixed folds (sample variance)', () => {
    const stats = createRollingStats();
    const samples = [0.1, 0.5, 0.3, 0.9, 0.2, 0.4, 0.8, 0.6];
    for (const sample of samples) stats.add(sample);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance =
      samples.reduce((a, sample) => a + (sample - mean) * (sample - mean), 0) /
      (samples.length - 1);
    expect(stats.mean).toBeCloseTo(mean, 10);
    expect(stats.std).toBeCloseTo(Math.sqrt(variance), 10);
  });
});

describe('scoreGateReplay — pretend-replay verdict logic (synthetic vectors)', () => {
  const four = 4;

  /** Gate params for the seeded scenarios; deterministic by construction. */
  function scenarioParams(overrides?: Partial<GateReplayParams>): GateReplayParams {
    return {
      lambda: 0.3,
      delta: 0,
      coldStartTurns: 1,
      minSamples: 2,
      adjustmentRadius: 0.2,
      sinkhornEpsilon: 0.05,
      // k = 2: the corpus-calibrated z criterion of the immediate channel
      //: fire at two ledger σ above the segment mean.
      immediateK: 2,
      // The σ floor under the ledger's sample σ (corpus continuation-noise
      // magnitude).
      sigmaFloor: 0.02,
      ...overrides,
    };
  }

  /** Runs the core over explicit prospective/gravity streams. */
  function run(args: {
    prospectiveByTurn: Map<number, number[]>;
    turnVectorByTurn: Map<number, number[]>;
    preGravityByTurn: Map<number, number[] | null>;
    foldBoundaryTurns?: Set<number>;
    /** The fold's T_segment — the immediate channel's bootstrap criterion. */
    segmentThreshold?: number;
    params?: GateReplayParams;
  }) {
    const turnNumbers = [...args.prospectiveByTurn.keys()].sort((a, b) => a - b);
    return scoreGateReplay({
      turnNumbers,
      prospectiveVectorByTurn: args.prospectiveByTurn,
      turnVectorByTurn: args.turnVectorByTurn,
      preGravityByTurn: args.preGravityByTurn,
      foldBoundaryTurns: args.foldBoundaryTurns ?? new Set(),
      anchorVector: args.preGravityByTurn.get(1) ?? basis(four, 0),
      userMessageIndexByTurn: new Map(turnNumbers.map((turn) => [turn, 2 * turn - 1])),
      segmentThreshold: args.segmentThreshold ?? 0.45,
      params: args.params ?? scenarioParams(),
    });
  }

  it('fires on a seeded flip and records no divergence when the fold cut too', () => {
    // Turns 2-3 continue topic e0 (drift_p ≈ 0); Turn 4 flips to e1 —
    // scored against e0 it is a full-distance spike; Turn 5 continues e1
    // against the RESEEDED gravity (drift_p ≈ 0 again).
    const e0 = basis(four, 0);
    const e1 = basis(four, 1);
    const result = run({
      prospectiveByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1],
        [5, e1],
      ]),
      turnVectorByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1],
        [5, e1],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null], // no Gravity point before the first Turn
        [2, e0],
        [3, e0],
        [4, e0], // judged against the old segment at arrival
        [5, e1], // fold reseeded after the Turn 4 boundary
      ]),
      foldBoundaryTurns: new Set([4]),
    });

    expect(result.points.map((p) => p.verdict)).toEqual(['muted', 'pass', 'pass', 'fire', 'pass']);
    expect(result.points[0]?.driftP).toBeNull();
    expect(result.points[3]?.driftP).toBeCloseTo(1, 5); // the spike
    // The verdict arrives at the flip Turn itself: after two zero folds the segment ledger sits at μ = 0
    // with zero spread — the σ floor keeps it honest, so the criterion
    // is μ + k·σ_floor = 0.04; the spike clears it at first touch and
    // never reaches the slow accumulator — no baseline reading rides
    // the spike point.
    expect(result.points[3]?.fireChannel).toBe('immediate');
    expect(result.points[3]?.immediateThreshold).toBeCloseTo(0.04, 5);
    expect(result.points[3]?.immediateZ).toBeCloseTo(50, 3); // 1.0 / σ_floor
    expect(result.points[3]?.gateMean).toBeUndefined();
    // The segment ledger rides each judged point, exactly as it stood at
    // judgment: absent during bootstrap, then the accepted members' moments.
    expect(result.points[1]?.segmentMu).toBeUndefined(); // bootstrapping
    expect(result.points[2]?.segmentMu).toBeCloseTo(0, 5); // first fold
    expect(result.points[3]?.segmentMu).toBeCloseTo(0, 5);
    expect(result.points[4]?.segmentMu).toBeUndefined(); // shredded by the verdict
    // Every sampled Turn records the immediate criterion it was judged
    // against, taken BEFORE the reading folded.
    const sampled = result.points.filter((p) => p.immediateThreshold !== undefined);
    expect(sampled.map((p) => p.turnNumber)).toEqual([2, 3, 4, 5]);
    expect(result.divergences).toEqual([]); // gate fired AND the fold cut: agreement
  });

  it('bootstraps the immediate criterion on T_segment until the segment ledger warms up', () => {
    // A segment with fewer than 2 accepted members has no true spread
    // yet — the constant T_segment adjudicates (0 accepted, AND 1
    // accepted). Once two quiet folds land, the criterion becomes the
    // segment's own statistic — with the σ floor under a zero spread.
    const e0 = basis(four, 0);
    const e1 = basis(four, 1);
    const result = run({
      prospectiveByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1],
        [5, e1],
      ]),
      turnVectorByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1],
        [5, e1],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, e0],
        [3, e0],
        [4, e0],
        [5, e1],
      ]),
      foldBoundaryTurns: new Set([4]),
    });
    // 0 accepted members: flat constant, no z, no ledger to chart.
    expect(result.points[1]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(result.points[1]?.immediateZ).toBeUndefined();
    expect(result.points[1]?.segmentMu).toBeUndefined();
    // 1 accepted member: still the flat constant — but the ledger's mean
    // already exists for the chart (σ not yet).
    expect(result.points[2]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(result.points[2]?.immediateZ).toBeUndefined();
    expect(result.points[2]?.segmentMu).toBeCloseTo(0, 5);
    expect(result.points[2]?.segmentSigma).toBeNull();
    // 2 accepted members: the ledger speaks — zero spread floors to
    // σ_floor, so the criterion is μ + k·σ_floor, not the constant.
    expect(result.points[3]?.immediateThreshold).toBeCloseTo(0.04, 5);
    expect(result.points[3]?.fireChannel).toBe('immediate');
    // The verdict shredded the ledger: the next segment re-bootstraps.
    expect(result.points[4]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(result.points[4]?.segmentMu).toBeUndefined();
    // The slow channel stays silent throughout: the spike never reaches
    // it, and nothing accumulates after.
    expect(result.points.every((p) => p.fireChannel !== 'slow')).toBe(true);
  });

  it('withholds on a message near V_last even when drift_p spikes (adjustment class)', () => {
    // Turn 4's Prospective is far from G_live (drift_p = 1) but identical
    // to the Turn 3 Turn vector (V_last): an adjustment to the current
    // topic — the dual reference withholds the fire. Earlier Prospectives
    // stay in-topic so the spike lands exactly at Turn 4.
    const e0 = basis(four, 0);
    const e1 = basis(four, 1);
    const result = run({
      prospectiveByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1], // Turn 4's Prospective: far from G_live, near V_last
        [5, e0],
      ]),
      turnVectorByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e1], // Turn 3's completed vector becomes V_last at Turn 4
        [4, e0],
        [5, e0],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, e0],
        [3, e0],
        [4, e0],
        [5, e0],
      ]),
      foldBoundaryTurns: new Set([4]),
    });

    expect(result.points.map((p) => p.verdict)).toEqual([
      'muted',
      'pass',
      'pass',
      'withheld',
      'pass',
    ]);
    // The immediate channel fired on the arriving reading; the dual
    // reference recognised the adjustment class and withheld.
    expect(result.points[3]?.fireChannel).toBe('immediate');
    // A withheld verdict is still a verdict: the ledger is shredded and
    // the patrol hard-resets — the next segment re-bootstraps on the
    // constant with an empty ledger of its own.
    expect(result.points[4]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(result.points[4]?.segmentMu).toBeUndefined();
    // The corrected patrol re-warms from its first consumed step: the
    // reseed Turn's own raw reading (0 against the reseeded gravity)
    // becomes the detector's fresh baseline.
    expect(result.points[4]?.gateMean).toBeCloseTo(0, 5);
    expect(result.divergences).toEqual([{ turnNumber: 4, kind: 'gate_withheld_fold_cut' }]);
  });

  it('records gate/fold divergence rows in both disagreement directions', () => {
    // Spike at Turn 4 with NO fold cut → gate_fired_fold_quiet;
    // fold cut at Turn 5 with a flat gate stream → fold_cut_gate_quiet.
    const e0 = basis(four, 0);
    const e1 = basis(four, 1);
    const result = run({
      prospectiveByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1], // fires (spike) but the fold found nothing
        [5, e0], // flat — meanwhile the fold cut a boundary here
      ]),
      turnVectorByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e1],
        [5, e0],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, e0],
        [3, e0],
        [4, e0],
        [5, e0],
      ]),
      foldBoundaryTurns: new Set([5]),
    });

    expect(result.divergences).toEqual([
      { turnNumber: 4, kind: 'gate_fired_fold_quiet' },
      { turnNumber: 5, kind: 'fold_cut_gate_quiet' },
    ]);
  });

  it('mutes the whole cold-start stretch: no baseline, no verdicts', () => {
    const e0 = basis(four, 0);
    const e1 = basis(four, 1);
    const result = run({
      prospectiveByTurn: new Map([
        [1, e0],
        [2, e1], // huge spikes inside the cold start: still muted
        [3, e1],
      ]),
      turnVectorByTurn: new Map([
        [1, e0],
        [2, e1],
        [3, e1],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, e0],
        [3, e1],
      ]),
      params: scenarioParams({ coldStartTurns: 5 }),
    });

    expect(result.points.map((p) => p.verdict)).toEqual(['muted', 'muted', 'muted']);
    expect(result.divergences).toEqual([]);
  });

  it('raises anchor-wander counsel on a sustained rise, verdict-neutral', () => {
    // Anchor at e0; the prospective stream walks away steadily (e0 → e1)
    // — the counsel detector fires advisory rows while the drift gate
    // (flat drift_p against a FOLLOWING gravity) stays quiet. The
    // Anchor is Segment 1, so the wander reading exists from Turn 1 and
    // the counsel watches every Turn, cold start included.
    const e0 = basis(four, 0);
    const half = [Math.SQRT1_2, Math.SQRT1_2, 0, 0];
    const e1 = basis(four, 1);
    const result = run({
      prospectiveByTurn: new Map([
        [1, e0],
        [2, half],
        [3, half],
        [4, e1],
        [5, e1],
      ]),
      turnVectorByTurn: new Map([
        [1, e0],
        [2, e0],
        [3, e0],
        [4, e0],
        [5, e0],
      ]),
      preGravityByTurn: new Map<number, number[] | null>([
        [1, null],
        [2, e0],
        [3, e0],
        [4, e0],
        [5, e1], // the fold reseeded after the Turn 4 boundary
      ]),
      params: scenarioParams({ lambda: 0.2, minSamples: 2 }),
    });

    // The fire lands mid-walk, the moment the sustained 0 → 0.29 rise
    // clears λ over the minSamples floor — the row carries the distance
    // as it stood at fire, not a post-selection high-water value.
    expect(result.anchorCounsel).toHaveLength(1);
    expect(result.anchorCounsel[0]?.turnNumber).toBe(3);
    expect(result.anchorCounsel[0]?.anchorDistance).toBeCloseTo(1 - Math.SQRT1_2, 5);
    // Counsel is verdict-neutral: it neither suppresses nor creates fires —
    // the verdict stream here contains passes and the walk's own drift spike.
    expect(result.points.filter((p) => p.verdict === 'pass').length).toBeGreaterThanOrEqual(3);
  });
});

describe('scoreGateReplay — segment ledger, z verdict, verdict resets', () => {
  const four = 4;
  const e0 = basis(four, 0);

  /** A unit vector at cosine distance `d` from e0. */
  function atDistance(d: number): number[] {
    const angle = Math.acos(1 - d);
    return [Math.cos(angle), Math.sin(angle), 0, 0];
  }

  /**
   * Replays one flat e0 segment: Turn 1 seeds the Gravity point (null
   * preGravity), every later Turn is judged against e0 and reads the
   * given distance. Vectors at exactly the wanted separation keep the
   * numbers hand-computable.
   */
  function replayReadings(readings: Array<number | null>, overrides?: Partial<GateReplayParams>) {
    const turnNumbers = readings.map((_, index) => index + 1);
    const params: GateReplayParams = {
      lambda: 0.5,
      delta: 0,
      coldStartTurns: 1,
      minSamples: 2,
      adjustmentRadius: 0.2,
      sinkhornEpsilon: 0.05,
      immediateK: 2,
      sigmaFloor: 0.02,
      ...overrides,
    };
    return scoreGateReplay({
      turnNumbers,
      prospectiveVectorByTurn: new Map(
        turnNumbers.map((t, i) => [
          t,
          readings[i] === null ? e0 : atDistance(readings[i] as number),
        ]),
      ),
      turnVectorByTurn: new Map(turnNumbers.map((t) => [t, e0])),
      preGravityByTurn: new Map<number, number[] | null>(
        turnNumbers.map((t) => [t, t === 1 ? null : e0]),
      ),
      foldBoundaryTurns: new Set(),
      anchorVector: e0,
      userMessageIndexByTurn: new Map(turnNumbers.map((t) => [t, 2 * t - 1])),
      segmentThreshold: 0.45,
      params,
    });
  }

  it('fires when the arrival clears μ + 2·max(σ, σ_floor), passes just below', () => {
    // Two quiet accepted members: 0.30 and 0.32 → μ = 0.31, sample
    // σ = 0.02/√2 ≈ 0.0141 BELOW the floor → σ_eff = 0.02, criterion
    // μ + k·σ_eff = 0.35.
    const fire = replayReadings([null, 0.3, 0.32, 0.355, 0.33]);
    expect(fire.points.map((p) => p.verdict)).toEqual(['muted', 'pass', 'pass', 'fire', 'pass']);
    const spike = fire.points[3];
    expect(spike?.fireChannel).toBe('immediate');
    expect(spike?.immediateThreshold).toBeCloseTo(0.35, 5);
    expect(spike?.immediateZ).toBeCloseTo(2.25, 4);
    // The criterion was judged against the ledger as it stood BEFORE the
    // spike — the rejected arrival never widened σ (ratchet guard).
    expect(spike?.segmentMu).toBeCloseTo(0.31, 5);
    expect(spike?.segmentSigma).toBeCloseTo(0.01414, 4); // σ pre-spike
    expect(spike?.gateMean).toBeUndefined(); // the spike never reaches the patrol
    // After the verdict the ledger is shredded: the arrival that seeds
    // the next segment is judged by the bootstrap constant, and it did
    // NOT enter either ledger — the new one starts empty.
    const reseed = fire.points[4];
    expect(reseed?.verdict).toBe('pass');
    expect(reseed?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(reseed?.immediateZ).toBeUndefined();
    expect(reseed?.segmentMu).toBeUndefined();
    expect(reseed?.segmentSigma).toBeUndefined();

    // The identical segment, arrival at μ + 1.9·σ_eff instead: z = 1.895
    // stays below k = 2 — pass, and the ledger simply grows.
    const pass = replayReadings([null, 0.3, 0.32, 0.3479, 0.33]);
    expect(pass.points.map((p) => p.verdict)).toEqual(['muted', 'pass', 'pass', 'pass', 'pass']);
    const quiet = pass.points[3];
    expect(quiet?.fireChannel).toBeUndefined();
    expect(quiet?.immediateZ).toBeCloseTo(1.895, 3);
    // Accepted into the segment's ledger (a pass folds) — T5 judges
    // against the moments that PRECEDED its own fold.
    expect(pass.points[4]?.segmentMu).toBeCloseTo((0.3 + 0.32 + 0.3479) / 3, 5);
  });

  it('uses the ledger σ itself once it outgrows the floor', () => {
    // 0.30 and 0.40: μ = 0.35, sample σ = 0.1/√2 ≈ 0.0707 > σ_floor —
    // the spread, not the floor, sets the bar: criterion ≈ 0.4914.
    const spread = replayReadings([null, 0.3, 0.4, 0.5]);
    expect(spread.points.map((p) => p.verdict)).toEqual(['muted', 'pass', 'pass', 'fire']);
    expect(spread.points[3]?.immediateThreshold).toBeCloseTo(0.49142, 4);
    expect(spread.points[3]?.immediateZ).toBeCloseTo(2.1213, 3);
    expect(spread.points[3]?.segmentSigma).toBeCloseTo(0.07071, 4);
  });

  it('bootstraps flat 0.45 at both 0 and 1 accepted members, and fires just above it', () => {
    const below = replayReadings([null, 0.449, 0.445]);
    expect(below.points.map((p) => p.verdict)).toEqual(['muted', 'pass', 'pass']);
    expect(below.points[1]?.immediateThreshold).toBeCloseTo(0.45, 5); // 0 accepted
    expect(below.points[2]?.immediateThreshold).toBeCloseTo(0.45, 5); // 1 accepted
    expect(below.points[2]?.segmentMu).toBeCloseTo(0.449, 5);
    expect(below.points[2]?.segmentSigma).toBeNull(); // not 2 members yet

    const above = replayReadings([null, 0.451]);
    expect(above.points.map((p) => p.verdict)).toEqual(['muted', 'fire']);
    expect(above.points[1]?.fireChannel).toBe('immediate');
    expect(above.points[1]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(above.points[1]?.immediateZ).toBeUndefined(); // bootstrap has no z
  });

  it('a slow-channel verdict empties the ledger AND the patrol, rejects the creep, and re-bootstraps', () => {
    // A calibrated crawl on the RAW drift readings: two quiet warm-up folds, then a consistent +0.015
    // climb 0.315 → 0.45. Every arrival stays inside the immediate
    // criterion — the peak z is 1.81, never reaching k = 2 — but the
    // patrol accumulates the raw steps against its own chasing mean
    // until the rise crosses λ = 0.5 on Turn 13.
    const readings: Array<number | null> = [
      null,
      0.28,
      0.3,
      0.315,
      0.33,
      0.345,
      0.36,
      0.375,
      0.39,
      0.405,
      0.42,
      0.435,
      0.45,
      0.3,
    ];
    const result = replayReadings(readings, { lambda: 0.5, minSamples: 2 });
    expect(result.points.map((p) => p.verdict)).toEqual([
      'muted',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'fire', // Turn 13: the accumulated raw rise reaches λ
      'pass', // Turn 14: reseed against the fresh segment
    ]);
    // The immediate channel watched the whole walk and never spoke: spot-
    // check the z scores stay well under k = 2 throughout.
    expect(result.points[3]?.immediateZ).toBeCloseTo(1.25, 2);
    expect(result.points[11]?.immediateZ).toBeCloseTo(1.79, 2);
    expect(result.points[3]?.fireChannel).toBeUndefined();
    // The slow channel fired: the detector's own mean of its 12 consumed
    // raw steps, and the rise that reached the λ budget.
    const slowFire = result.points[12];
    expect(slowFire?.fireChannel).toBe('slow');
    expect(slowFire?.gateMean).toBeCloseTo(0.367, 2); // mean of 0.28…0.45
    expect(slowFire?.gateRise as number).toBeGreaterThanOrEqual(0.5); // reached λ
    // The verdict shredded the ledger: the arrival seeding the next
    // segment sees the bootstrap constant and an empty ledger, and the
    // rejected creep reading did NOT enter the old segment's ledger —
    // every ledger reading along the way is the ACCEPTED members' moments.
    const reseed = result.points[13];
    expect(reseed?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(reseed?.segmentMu).toBeUndefined();
    expect(reseed?.segmentSigma).toBeUndefined();
    expect(result.points[3]?.segmentMu).toBeCloseTo((0.28 + 0.3) / 2, 5);
    expect(result.points[6]?.segmentMu).toBeCloseTo((0.28 + 0.3 + 0.315 + 0.33 + 0.345) / 5, 5);
    // The corrected patrol re-warms from its first consumed step: the
    // reseed Turn's own raw reading becomes the detector's fresh baseline.
    expect(reseed?.gateMean).toBeCloseTo(0.3, 5);
    expect(reseed?.gateRise).toBeCloseTo(0, 5);
  });
});

describe('Sinkhorn-EMD and the revisit matrix (synthetic vectors)', () => {
  const two = 2;

  it('reads a cloud against itself as (near) zero — the zero diagonal', () => {
    const cloud = [basis(two, 0), [Math.SQRT1_2, Math.SQRT1_2]];
    expect(sinkhornEmd(cloud, cloud, 0.05)).toBeLessThan(0.02);
  });

  it('is symmetric within numerical tolerance', () => {
    const a = [basis(two, 0)];
    const b = [[0.6, 0.8]];
    const c = [basis(two, 1), [Math.SQRT1_2, Math.SQRT1_2]];
    expect(sinkhornEmd(a, c, 0.05)).toBeCloseTo(sinkhornEmd(c, a, 0.05), 5);
    expect(sinkhornEmd(b, c, 0.05)).toBeCloseTo(sinkhornEmd(c, b, 0.05), 5);
  });

  it('orders near clouds below far clouds', () => {
    const a = [basis(two, 0)];
    const near = [[Math.cos(0.15), Math.sin(0.15)]];
    const far = [basis(two, 1)];
    expect(sinkhornEmd(a, near, 0.05)).toBeLessThan(sinkhornEmd(a, far, 0.05));
  });

  it('builds a symmetric pair matrix with the thread’s own tauMerge baseline', () => {
    // Segment 1: e0 plus a slight tilt (splittable, gives tauMerge);
    // Segment 3: back at e0 — a revisit of Segment 1's topic;
    // Segment 2: e1 — distant from either.
    const e0 = basis(two, 0);
    const tilt = [Math.cos(0.1), Math.sin(0.1)];
    const e1 = basis(two, 1);
    const emd = buildEmdMatrix({
      segmentVectors: [
        { index: 1, vectors: [e0, tilt] },
        { index: 2, vectors: [e1, e1] },
        { index: 3, vectors: [e0] },
      ],
      epsilon: 0.05,
    });

    // Three unordered pairs, mirrored by construction (computed once).
    expect(emd.pairs.map((p) => `${p.fromSegment}-${p.toSegment}`)).toEqual(['1-2', '1-3', '2-3']);
    for (const pair of emd.pairs) {
      expect(pair.w).toBeGreaterThan(0);
      expect(pair.w).toBeLessThanOrEqual(2);
    }
    // Both splittable segments contribute a half row; Segment 2's halves
    // are identical vectors, so its W is (almost exactly) zero.
    expect(emd.halves.map((row) => row.segmentIndex)).toEqual([1, 2]);
    expect(emd.halves[1]?.w).toBeLessThan(1e-9);
    expect(emd.tauMerge).toBe(emd.halves[0]?.w);

    // Section 3 revisits Section 1: closer than the thread's own baseline.
    expect(emd.revisits).toEqual([
      { fromSegment: 1, toSegment: 3, w: emd.pairs.find((p) => p.toSegment === 3)?.w },
    ]);
    const pair13 = emd.pairs.find((p) => p.fromSegment === 1 && p.toSegment === 3);
    expect(pair13?.w).toBeLessThan(emd.tauMerge ?? 0);
  });

  it('reports no baseline and no revisits when no segment can split', () => {
    const emd = buildEmdMatrix({
      segmentVectors: [
        { index: 1, vectors: [basis(two, 0)] },
        { index: 2, vectors: [basis(two, 1)] },
      ],
      epsilon: 0.05,
    });
    expect(emd.halves).toEqual([]);
    expect(emd.tauMerge).toBeNull();
    expect(emd.revisits).toEqual([]);
    expect(emd.pairs).toHaveLength(1);
  });
});

describe('analyzeThread — gate-replay mode (e2e via the public seam)', () => {
  const flipSpecs: TurnSpec[] = [
    { user: 'alpha opening question', assistant: 'alpha opening answer' },
    { user: 'alpha again', assistant: 'alpha reply' },
    { user: 'alpha once more', assistant: 'alpha third' },
    { user: 'beta flips here', assistant: 'beta answer' },
    { user: 'beta follows up', assistant: 'beta reply' },
  ];

  it('adds the gate section, mutes Turn 1, and never persists Prospective rows', async () => {
    const { threadId, messages } = await seedThread('gate replay thread', flipSpecs);

    const report = await analyzeThread(threadId, { gateReplay: true });
    expect(report.type).toBe('success');
    if (report.type !== 'success') throw new Error('expected success');
    const data = report.data;

    // Params block carries the gate provenance.
    const expectedParams: GateReplayParams = DEFAULT_GATE_REPLAY_OPTIONS;
    expect(data.params.gateReplay).toEqual(expectedParams);
    const section: GateReplaySection | undefined = data.gateReplay;
    expect(section).toBeDefined();
    if (!section) throw new Error('expected gate section');

    // The section is the data contract a later UI renders from — drive
    // it across the public surface, row type by row type.
    const points: GateReplayPoint[] = section.points;
    const verdicts: GateVerdict[] = points.map((point) => point.verdict);
    expect(verdicts).toHaveLength(section.points.length);
    const divergences: GateDivergenceRow[] = section.divergences;
    expect(divergences.length).toBeGreaterThanOrEqual(0);
    const counselRows: AnchorCounselRow[] = section.anchorCounsel;
    expect(counselRows.length).toBeGreaterThanOrEqual(0);

    // One point per Turn; Turn 1 has no Gravity point (null) and is the
    // only muted arrival (coldStartTurns 1): Turn 2 onward is judged,
    // bootstrapping on the flat constant while the segment ledger holds
    // fewer than two accepted members.
    expect(points).toHaveLength(5);
    expect(points[0]?.driftP).toBeNull();
    expect(points.map((p) => p.turnNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(points.map((p) => p.messageIndex)).toEqual([1, 3, 5, 7, 9]);
    expect(points[0]?.verdict).toBe('muted');
    for (const point of points.slice(1)) {
      expect(point.driftP).not.toBeNull();
      expect(point.anchorDistance).toBeGreaterThanOrEqual(0);
    }
    // The mock's prospective readings are near-orthogonal (≈1, far above
    // the constant), so the immediate channel fires on every judged
    // arrival against the BOOTSTRAP criterion — the ledger never warms
    // because a fired reading never folds (ratchet guard) — and the fold
    // cuts those same near-orthogonal Turns, so gate and fold never
    // disagree here.
    expect(points.slice(1).map((p) => p.verdict)).toEqual(['fire', 'fire', 'fire', 'fire']);
    expect(points.slice(1).every((p) => p.fireChannel === 'immediate')).toBe(true);
    expect(
      points
        .slice(1)
        .every((p) => p.immediateThreshold === DEFAULT_ANALYZE_OPTIONS.segmentThreshold),
    ).toBe(true);
    expect(divergences).toEqual([]);

    // The two-channel verdict rides each point: the slow
    // detector's reading only where the accumulator consumed the sample
    // (an immediate fire skips it), the immediate criterion where a
    // sample was judged at all. The muted Turn 1 carries neither, nor a
    // fire channel.
    expect(
      points
        .slice(0, 1)
        .every(
          (p) =>
            p.gateMean === undefined &&
            p.gateRise === undefined &&
            p.immediateThreshold === undefined &&
            p.fireChannel === undefined,
        ),
    ).toBe(true);
    expect(points.slice(1).every((p) => p.gateMean === undefined)).toBe(true);
    // Every sampled Turn records the immediate criterion it was judged
    // against, taken BEFORE the reading folded.
    const sampledPoints = points.slice(1);
    expect(sampledPoints.every((p) => typeof p.immediateThreshold === 'number')).toBe(true);
    // The immediate channel fires on the arriving reading: the verdict
    // lands at Turn 2 — the first judged arrival — and the spike never
    // reaches the slow channel.
    const immediateFire = points.find((p) => p.fireChannel === 'immediate');
    expect(immediateFire?.turnNumber).toBe(2);
    expect(immediateFire?.verdict).toBe('fire');
    expect(immediateFire?.gateMean).toBeUndefined();
    // Structural invariant: slow-channel readings ride only on points the
    // accumulator consumed — never muted Turns, never verdicts (a verdict
    // either reset the detector or skipped it altogether).
    expect(points.filter((p) => p.gateMean !== undefined).every((p) => p.verdict === 'pass')).toBe(
      true,
    );
    // Any slow-channel fire's recorded rise reached λ, by construction.
    expect(
      points
        .filter((p) => p.fireChannel === 'slow')
        .every((p) => (p.gateRise as number) >= DEFAULT_GATE_REPLAY_OPTIONS.lambda),
    ).toBe(true);

    // EMD structure over the fold's segments.
    const segmentCount = data.segments.length;
    const pairRows: EmdPairRow[] = section.emd.pairs;
    expect(pairRows).toHaveLength((segmentCount * (segmentCount - 1)) / 2);
    for (const pair of pairRows) {
      expect(pair.fromSegment).toBeLessThan(pair.toSegment);
      expect(pair.w).toBeGreaterThanOrEqual(0);
    }
    const baselineRows: EmdBaselineRow[] = section.emd.halves;
    for (const row of baselineRows) {
      expect(row.w).toBeGreaterThanOrEqual(0);
    }
    // Every revisit cites an ordered pair that exists in the matrix.
    const revisitRows: EmdRevisitRow[] = section.emd.revisits;
    for (const revisit of revisitRows) {
      const pair = pairRows.find(
        (p) => p.fromSegment === revisit.fromSegment && p.toSegment === revisit.toSegment,
      );
      expect(pair).toBeDefined();
    }

    // Storage contract: rows exist exactly for the Turns' assistant
    // messages — Prospective blocks left zero rows (they have no
    // assistant message to key to; nothing to persist).
    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: messages.map((message) => message.id),
    });
    const assistantIds = messages.filter((m) => m.role === 'assistant').map((m) => m.id);
    expect(rows.map((row) => row.messageId).sort()).toEqual(assistantIds.sort());
  });

  it('counts each prospective embed transiently: cost accrues, re-runs still spend', async () => {
    const { threadId } = await seedThread('gate replay costs', flipSpecs);

    const callsBefore = mock.embeddings.requestCount();
    const first = await analyzeThread(threadId, { gateReplay: true });
    expect(first.type).toBe('success');
    if (first.type !== 'success') throw new Error('expected success');
    // 5 Turn embeds + 5 transient prospective embeds.
    expect(mock.embeddings.requestCount() - callsBefore).toBe(10);
    const prospectiveCost = flipSpecs.reduce(
      (sum, spec) => Number((sum + embeddingCostUsd(prospectiveText(spec.user))).toFixed(10)),
      0,
    );
    const turnCost = flipSpecs.reduce((sum, spec) => {
      const block = `User:\n${spec.user}\n\nAssistant:\n${spec.assistant ?? ''}\n\n`;
      return Number((sum + embeddingCostUsd(block)).toFixed(10));
    }, 0);
    expect(first.data.totals.embeddingCostUsd).toBeCloseTo(
      Number((turnCost + prospectiveCost).toFixed(10)),
      10,
    );

    // Re-run: Turn rows reused (provenance match), prospective blocks
    // re-embed by design — they were never persisted.
    const second = await analyzeThread(threadId, { gateReplay: true });
    expect(second.type).toBe('success');
    if (second.type !== 'success') throw new Error('expected success');
    expect(mock.embeddings.requestCount() - callsBefore).toBe(15); // +5 prospective only
    expect(second.data.totals.embeddingCostUsd).toBeCloseTo(prospectiveCost, 10);

    // Without gate replay the same thread costs nothing to re-run.
    const plain = await analyzeThread(threadId);
    expect(plain.type).toBe('success');
    if (plain.type !== 'success') throw new Error('expected success');
    expect(mock.embeddings.requestCount() - callsBefore).toBe(15); // unchanged
    expect(plain.data.totals.embeddingCostUsd).toBe(0);
    expect(plain.data.gateReplay).toBeUndefined();
    expect(plain.data.params.gateReplay).toBeUndefined();
  });

  it('fires the prospective progress hook once per transient embed', async () => {
    const { threadId } = await seedThread('gate progress', flipSpecs);
    const events: Array<[number, number]> = [];
    await analyzeThread(threadId, {
      gateReplay: true,
      onProspectiveEmbedded: (turn, total) => events.push([turn, total]),
    });
    expect(events).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('overrides gate params per run and honors a cold start covering the thread', () => {
    return (async () => {
      const { threadId } = await seedThread('gate overrides', flipSpecs);
      const report = await analyzeThread(threadId, {
        gateReplay: { coldStartTurns: 50, lambda: 0.1 },
      });
      expect(report.type).toBe('success');
      if (report.type !== 'success') throw new Error('expected success');
      expect(report.data.params.gateReplay).toEqual({
        ...DEFAULT_GATE_REPLAY_OPTIONS,
        coldStartTurns: 50,
        lambda: 0.1,
      });
      // Cold start beyond the thread: every verdict muted, no fires, no
      // counsel — a quiet gate is the safe failure mode.
      expect(report.data.gateReplay?.points.every((p) => p.verdict === 'muted')).toBe(true);
      expect(report.data.gateReplay?.anchorCounsel).toEqual([]);
    })();
  });

  it('aborts a prospective embed failure without touching the persisted Turn rows', async () => {
    const { threadId, messages } = await seedThread('gate abort', flipSpecs);
    const assistantIds = messages.filter((m) => m.role === 'assistant').map((m) => m.id);

    // Persist the Turn rows first…
    const warm = await analyzeThread(threadId);
    expect(warm.type).toBe('success');

    // …then make the FIRST prospective call fail.
    mock.embeddings.failFrom(mock.embeddings.requestCount() + 1);
    const failed = await analyzeThread(threadId, { gateReplay: true });
    expect(failed).toMatchObject({ type: 'error', code: 'embed_failed' });

    // Turn rows untouched: the abort lost nothing that isn't recomputable.
    const rows = await listMessageEmbeddingsByMessageIds({ messageIds: assistantIds });
    expect(rows).toHaveLength(assistantIds.length);
  });

  it('returns provider_not_configured when only the prospective phase needs the provider', async () => {
    const { threadId } = await seedThread('gate no provider', flipSpecs);
    await analyzeThread(threadId); // Turn rows persist against the mock…

    const previousMockUrl = process.env.MOCK_AI_BASE_URL;
    const previousApiKey = process.env.DEEPINFRA_API_KEY;
    process.env.MOCK_AI_BASE_URL = '';
    process.env.DEEPINFRA_API_KEY = '';
    try {
      const result = await analyzeThread(threadId, { gateReplay: true });
      expect(result).toMatchObject({ type: 'error', code: 'provider_not_configured' });
    } finally {
      process.env.MOCK_AI_BASE_URL = previousMockUrl ?? '';
      process.env.DEEPINFRA_API_KEY = previousApiKey ?? '';
    }
  });

  it('renders the gate rows: verdict table, divergences, revisits, chart series', async () => {
    const { threadId } = await seedThread('gate render', flipSpecs);
    const report = await analyzeThread(threadId, { gateReplay: true });
    expect(report.type).toBe('success');
    if (report.type !== 'success') throw new Error('expected success');

    const { html, json } = renderThreadReport(report.data);

    // Section + tables + params provenance.
    expect(html).toContain('Drift gate — pretend replay');
    expect(html).toContain('EMD revisit matrix');
    expect(html).toContain('Gate lambda (λ, drift units)');
    expect(html).toContain('Gate cold start (K_gate)');
    expect(html).toContain('verdict-muted');
    // The prospective drift series joins the chart; every muted point has
    // no gate-fire mark.
    expect(html).toContain('series-prospective-drift');
    const fireCount = report.data.gateReplay?.points.filter((p) => p.verdict === 'fire').length;
    expect((html.match(/gate-fire-mark/g) ?? []).length).toBe(fireCount);
    // Weight contrast: the recorded fold series draws thick, the live
    // gate view thin; every scored point carries a native-tooltip marker.
    expect(html).toContain('stroke-width="2.5"');
    expect(html).toContain('stroke-width="1.25"');
    const scoredPoints =
      report.data.gateReplay?.points.filter((p) => p.driftPGated !== null).length ?? 0;
    expect((html.match(/<circle class="gate-point-/g) ?? []).length).toBe(scoredPoints);
    // Offline fold markers plus the raw audit lane (expansion runs add one
    // drift-point marker per scored Turn).
    const rawAuditMarkers =
      report.data.gateReplay?.points.filter(
        (p) => p.driftP !== null && p.driftPSource !== undefined,
      ).length ?? 0;
    expect((html.match(/<circle class="drift-point"/g) ?? []).length).toBe(
      report.data.driftSeries.filter((p) => p.segmentDrift !== null).length + rawAuditMarkers,
    );
    expect(html).toContain('<title>Turn ');
    // The legend states the recorded-vs-live contrast outright.
    expect(html).toContain('recorded by the fold (thick)');
    expect(html).toContain(
      'drift_p — the arrival reading the gate judged (rewrite when one landed, raw fallback; thin)',
    );
    expect(html).toContain('Gate withheld (hollow dot)');
    // Toggle groups ship scoped to their own chart block.
    expect(html).toContain('data-toggle="prospective"');
    expect(html).toContain('data-toggle="fires"');
    expect(html).toContain('data-controls="live"');
    // JSON sidecar round-trips the gate section too.
    expect(JSON.parse(json)).toEqual(report.data);

    // Without gate replay the sections stay absent (renderer shell reuse).
    const plain = await analyzeThread(threadId);
    if (plain.type !== 'success') throw new Error('expected success');
    const plainHtml = renderThreadReport(plain.data).html;
    expect(plainHtml).not.toContain('Drift gate — pretend replay');
    expect(plainHtml).not.toContain('series-prospective-drift');
  });

  it('never mutates chat data in gate-replay runs', async () => {
    const { threadId } = await seedThread('gate read only', flipSpecs);
    const before = await analyzeThread(threadId);
    expect(before.type).toBe('success');
    const gateRun = await analyzeThread(threadId, { gateReplay: true });
    expect(gateRun.type).toBe('success');

    // Byte-stable rerun contract carries into gate mode: the deterministic
    // parts of the report are identical run to run.
    if (before.type !== 'success' || gateRun.type !== 'success') throw new Error('success');
    expect(gateRun.data.driftSeries).toEqual(before.data.driftSeries);
    expect(gateRun.data.segments).toEqual(before.data.segments);
  });
});
