import { cosineDistance } from './drift';
import type { EmdBaselineRow, EmdPairRow, EmdRevisitRow, GateReplaySection } from './types';

/**
 * The EMD revisit matrix: post-fold,
 * each pair of Topic segments becomes a uniform-mass cloud over its
 * stored member Turn vectors; their Wasserstein-1 distance (via Sinkhorn
 * with entropic regularization, log-domain — segments hold ~2–20 vectors)
 * measures geometric affiliation between topics. Self-calibrating: the
 * thread's own baseline tauMerge comes from splitting same-segment halves
 * and measuring their W. Zero embed calls — stored vectors only. Never
 * auto-merges: merging stays not drift math's job; this is its
 * geometric advisor, reported only.
 */

/** Pairwise cosine-distance cost matrix between two vector clouds. */
function costMatrix(a: number[][], b: number[][]): number[][] {
  return a.map((u) => b.map((v) => cosineDistance(u, v)));
}

/** Numerically stable log-sum-exp over one row of values. */
function logSumExp(values: number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) max = Math.max(max, value);
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const value of values) sum += Math.exp(value - max);
  return max + Math.log(sum);
}

/**
 * One Sinkhorn sweep in the log domain: dual updates
 * u_i ← ε·log u_i − ε·logsumexp_j((v_j − c_ij)/ε) and its mirror
 * (Gauss–Seidel), until the duals stop moving. Returns both dual
 * vectors; the plan they imply is the entropically-smoothed optimum.
 */
function sinkhornDuals(
  cost: number[][],
  logU: number,
  logV: number,
  epsilon: number,
): { dualA: number[]; dualB: number[] } {
  let dualA = new Array<number>(cost.length).fill(0);
  let dualB = new Array<number>(cost[0]?.length ?? 0).fill(0);
  const tolerance = 1e-9;

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const nextA = dualA.map((_value, i) => {
      const row = cost[i];
      if (!row) throw new Error('cost row missing');
      return epsilon * (logU - logSumExp(row.map((c, j) => ((dualB[j] ?? 0) - c) / epsilon)));
    });
    const nextB = dualB.map((_value, j) => {
      const inner = nextA.map((dual, i) => (dual - (cost[i]?.[j] ?? 0)) / epsilon);
      return epsilon * (logV - logSumExp(inner));
    });
    let maxShift = 0;
    for (let i = 0; i < nextA.length; i += 1) {
      maxShift = Math.max(maxShift, Math.abs((nextA[i] ?? 0) - (dualA[i] ?? 0)));
    }
    for (let j = 0; j < nextB.length; j += 1) {
      maxShift = Math.max(maxShift, Math.abs((nextB[j] ?? 0) - (dualB[j] ?? 0)));
    }
    dualA = nextA;
    dualB = nextB;
    if (maxShift < tolerance) break;
  }
  return { dualA, dualB };
}

/** Transport cost W = Σ_ij p_ij · c_ij with p_ij = exp((u_i + v_j − c_ij)/ε). */
function transportCost(
  cost: number[][],
  dualA: number[],
  dualB: number[],
  epsilon: number,
): number {
  let w = 0;
  for (let i = 0; i < cost.length; i += 1) {
    const row = cost[i];
    if (!row) throw new Error('cost row missing');
    for (let j = 0; j < row.length; j += 1) {
      const logP = ((dualA[i] ?? 0) + (dualB[j] ?? 0) - (row[j] ?? 0)) / epsilon;
      w += Math.exp(logP) * (row[j] ?? 0);
    }
  }
  return w;
}

/**
 * Sinkhorn-EMD: uniform marginals (1/n, 1/m) over the cost matrix C,
 * dual iteration until convergence. Returns W_ε — the
 * entropic-smoothed transport cost between the two clouds.
 */
export function sinkhornEmd(a: number[][], b: number[][], epsilon: number): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error('EMD needs at least one member vector per side');
  }
  const cost = costMatrix(a, b);
  const { dualA, dualB } = sinkhornDuals(
    cost,
    Math.log(1 / a.length),
    Math.log(1 / b.length),
    epsilon,
  );
  return transportCost(cost, dualA, dualB, epsilon);
}

export interface BuildEmdMatrixProps {
  /** Topic segments in fold order, each with its stored member Turn vectors. */
  segmentVectors: Array<{ index: number; vectors: number[][] }>;
  /** Sinkhorn entropic regularization (provenance in the report). */
  epsilon: number;
}

/**
 * The complete revisit result: every off-diagonal pair (matrix is
 * symmetric with a zero diagonal by construction — a cloud's distance to
 * itself is 0 by definition, pairs are computed once and mirrored),
 * the same-segment-halves rows, tauMerge as the WIDEST such self-distance
 * (anything closer than even the thread's loosest same-topic split reads
 * as a revisit), and the revisit rows below it.
 */
export function buildEmdMatrix({
  segmentVectors,
  epsilon,
}: BuildEmdMatrixProps): GateReplaySection['emd'] {
  const pairs: EmdPairRow[] = [];
  for (let i = 0; i < segmentVectors.length; i += 1) {
    for (let j = i + 1; j < segmentVectors.length; j += 1) {
      const left = segmentVectors[i];
      const right = segmentVectors[j];
      if (!left || !right) continue;
      pairs.push({
        fromSegment: left.index,
        toSegment: right.index,
        w: sinkhornEmd(left.vectors, right.vectors, epsilon),
      });
    }
  }

  const halves: EmdBaselineRow[] = [];
  for (const segment of segmentVectors) {
    if (segment.vectors.length < 2) continue; // unsplittable single-member segment
    const splitAt = Math.floor(segment.vectors.length / 2);
    halves.push({
      segmentIndex: segment.index,
      w: sinkhornEmd(segment.vectors.slice(0, splitAt), segment.vectors.slice(splitAt), epsilon),
    });
  }

  const tauMerge = halves.length === 0 ? null : Math.max(...halves.map((row) => row.w));
  const revisits: EmdRevisitRow[] =
    tauMerge === null
      ? []
      : pairs
          .filter((pair) => pair.w < tauMerge)
          .map((pair) => ({ fromSegment: pair.fromSegment, toSegment: pair.toSegment, w: pair.w }));

  return { pairs, tauMerge, halves, revisits };
}
