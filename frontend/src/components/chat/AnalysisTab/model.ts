import type { LiveAnalysisView } from '@/services/api';

export type JudgedPoint = {
  turnNumber: number;
  segmentIndex: number;
  driftP: number;
  threshold: number;
  mu: number | null;
  zScore: number | null;
  verdict: 'pass' | 'fire';
  fireChannel: 'immediate' | 'slow' | null;
};

export type ChartModel = {
  judged: JudgedPoint[];
  mutedTurns: number[];
  segmentStarts: { turn: number; index: number }[];
  segmentThreshold: number;
  immediateK: number;
  yMin: number;
  yMax: number;
  xMin: number;
  xMax: number;
};

export const DRIFT_COLORS = {
  drift: '#ec4899',
  trigger: '#a855f7',
  ledgerMean: '#64748b',
  fire: '#c084fc',
  pass: '#60a5fa',
} as const;

export function buildChartModel(view: LiveAnalysisView): ChartModel {
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

  const turns = view.points.map((point) => point.turnNumber);
  const xMin = turns.length > 0 ? Math.min(...turns) : 1;
  const xMax = turns.length > 0 ? Math.max(...turns) : 1;

  const values = [
    view.params.segmentThreshold,
    ...judged.flatMap((point) => [point.driftP, point.threshold]),
    ...judged.filter((point) => point.mu !== null).map((point) => point.mu as number),
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
    segmentThreshold: view.params.segmentThreshold,
    immediateK: view.params.immediateK,
    yMin: rawMin - pad,
    yMax: rawMax + pad,
    xMin,
    xMax: Math.max(xMax, xMin + 1),
  };
}

export function polylinePoints(
  xs: number[],
  ys: number[],
  sx: (value: number) => number,
  sy: (value: number) => number,
): string {
  return xs
    .map((value, index) => `${sx(value).toFixed(1)},${sy(ys[index] as number).toFixed(1)}`)
    .join(' ');
}
