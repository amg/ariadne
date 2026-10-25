import type { FireChannel, LiveAnalysisView } from '@/services/api';

type JudgedPoint = {
  turnNumber: number;
  segmentIndex: number;
  driftP: number;
  threshold: number;
  mu: number | null;
  zScore: number | null;
  verdict: 'pass' | 'fire';
  fireChannel: FireChannel | null;
};

type TriggerPoint = {
  turnNumber: number;
  threshold: number;
};

/** One segment's trigger line: the level each of its arrivals was judged against. */
type TriggerSegment = {
  segmentIndex: number;
  points: TriggerPoint[];
};

export const DRIFT_COLORS = {
  drift: '#ec4899',
  trigger: '#a855f7',
  ledgerMean: '#64748b',
  fire: '#c084fc',
  pass: '#60a5fa',
} as const;

export function buildChartModel(view: LiveAnalysisView) {
  const judged: JudgedPoint[] = [];
  const mutedTurns: number[] = [];
  for (const point of view.points) {
    if (point.verdict === 'muted' || point.driftP === null || point.immediateThreshold === null) {
      mutedTurns.push(point.turnNumber);
      continue;
    }
    judged.push({
      turnNumber: point.turnNumber,
      segmentIndex: point.segmentIndex,
      driftP: point.driftP,
      threshold: point.immediateThreshold,
      mu: point.mu,
      zScore: point.zScore,
      verdict: point.verdict,
      fireChannel: point.fireChannel,
    });
  }
  judged.sort((a, b) => a.turnNumber - b.turnNumber);

  const triggerSegments = triggerSegmentsOf(view);

  const turns = view.points.map((point) => point.turnNumber);
  const xMin = turns.length > 0 ? Math.min(...turns) : 1;
  const xMax = turns.length > 0 ? Math.max(...turns) : 1;

  const values = [
    view.params.immediate.bootstrapThreshold,
    ...judged.flatMap((point) => [point.driftP, point.threshold]),
    ...judged.filter((point) => point.mu !== null).map((point) => point.mu as number),
    ...triggerSegments.flatMap((segment) => segment.points.map((point) => point.threshold)),
  ];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max((rawMax - rawMin) * 0.15, 0.02);

  const segmentStarts = view.segments
    .map((segment) => {
      const opening = view.points.find((point) => point.messageId === segment.startMessageId);
      return opening ? { turn: opening.turnNumber, index: segment.index } : null;
    })
    .filter((entry): entry is { turn: number; index: number } => entry !== null);

  return {
    judged,
    mutedTurns,
    segmentStarts,
    bootstrapThreshold: view.params.immediate.bootstrapThreshold,
    immediateStdDevs: view.params.immediate.stdDevs,
    triggerSegments,
    yMin: rawMin - pad,
    yMax: rawMax + pad,
    xMin,
    xMax: Math.max(xMax, xMin + 1),
  };
}

/**
 * The trigger line split by the segments the view reports. A segment's
 * line runs up to the arrival that opens the next segment, at the level
 * that judged that arrival. The next segment's line starts on the same
 * turn, at the bootstrap threshold.
 */
function triggerSegmentsOf(view: LiveAnalysisView) {
  const standing = view.params.immediate.bootstrapThreshold;
  const sorted = [...view.points].sort((a, b) => a.turnNumber - b.turnNumber);
  const segments: TriggerSegment[] = [];
  let current: TriggerSegment | null = null;
  for (const point of sorted) {
    const judgedAt = {
      turnNumber: point.turnNumber,
      threshold: point.immediateThreshold ?? standing,
    };
    if (current !== null && current.segmentIndex !== point.segmentIndex) {
      current.points.push(judgedAt);
      segments.push(current);
      current = {
        segmentIndex: point.segmentIndex,
        points: [{ turnNumber: point.turnNumber, threshold: standing }],
      };
      continue;
    }
    current ??= { segmentIndex: point.segmentIndex, points: [] };
    current.points.push(judgedAt);
  }
  if (current !== null) segments.push(current);
  return segments;
}

export function polylinePoints(
  xs: number[],
  ys: number[],
  sx: (value: number) => number,
  sy: (value: number) => number,
) {
  return xs
    .map((value, index) => `${sx(value).toFixed(1)},${sy(ys[index] as number).toFixed(1)}`)
    .join(' ');
}

/** How far, in pixels, a lone point's level reaches to each side. */
const LONE_LEVEL_HALF_WIDTH = 12;

/**
 * An SVG path that holds each level until the next point. The level
 * between two points is the later point's: it is the level that point
 * was judged against. A lone point gets a short level centred on it,
 * kept inside `bounds`.
 */
export function stepPath(
  points: readonly { x: number; y: number }[],
  bounds: { left: number; right: number },
) {
  const [first, second] = points;
  if (first === undefined) return '';
  if (second === undefined) {
    const left = Math.max(bounds.left, first.x - LONE_LEVEL_HALF_WIDTH);
    const right = Math.min(bounds.right, first.x + LONE_LEVEL_HALF_WIDTH);
    return `M ${left.toFixed(1)} ${first.y.toFixed(1)} H ${right.toFixed(1)}`;
  }
  const steps = points
    .slice(1)
    .map(
      (point, index) => `${index > 0 ? ` V ${point.y.toFixed(1)}` : ''} H ${point.x.toFixed(1)}`,
    );
  return `M ${first.x.toFixed(1)} ${second.y.toFixed(1)}${steps.join('')}`;
}
