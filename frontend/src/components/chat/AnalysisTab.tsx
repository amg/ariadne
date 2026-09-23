import { type LiveAnalysisView, fetchThreadAnalysis } from '@/services/api';
import { useEffect, useState } from 'react';

/**
 * The Analysis tab: the thread's live reading straight from the persisted
 * liveness plan. Charted by hand (inline SVG, no chart library — same
 * discipline as the CLI artifact): arrival drift versus the standing
 * trigger on the judged scale, and the same arrivals in z-score space.
 */

const ONE_LINERS = [
  'Reading the room…',
  'Consulting the gravity point…',
  'Counting baggage…',
  'Weighing the anchor…',
  'Checking drift…',
] as const;

/** Rotating loading copy while signals are missing or in flight. */
function AnalysisSpinner() {
  const [lineIndex, setLineIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setLineIndex((index) => (index + 1) % ONE_LINERS.length);
    }, 2400);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
      <p className="text-sm italic">{ONE_LINERS[lineIndex] ?? ''}</p>
    </div>
  );
}

type JudgedPoint = {
  turnNumber: number;
  segmentIndex: number;
  driftP: number;
  threshold: number;
  mu: number | null;
  zScore: number | null;
  verdict: 'pass' | 'fire';
  fireChannel: 'immediate' | 'slow' | null;
};

type ChartModel = {
  judged: JudgedPoint[];
  /** Muted arrivals: verdicts on a flat ledger — tick mark, no reading. */
  mutedTurns: number[];
  /** Vertical segment-boundary positions in turn space. */
  segmentStarts: { turn: number; index: number }[];
  segmentThreshold: number;
  immediateK: number;
  yMin: number;
  yMax: number;
  xMin: number;
  xMax: number;
};

function buildChartModel(view: LiveAnalysisView): ChartModel {
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

const DRIFT_COLORS = {
  drift: '#ec4899',
  trigger: '#a855f7',
  ledgerMean: '#64748b',
  fire: '#c084fc',
  pass: '#60a5fa',
} as const;

/** Polyline `points` for a series, on an (x, y) chart frame. */
function polylinePoints(
  xs: number[],
  ys: number[],
  sx: (value: number) => number,
  sy: (value: number) => number,
): string {
  return xs
    .map((value, index) => `${sx(value).toFixed(1)},${sy(ys[index] as number).toFixed(1)}`)
    .join(' ');
}

function DriftChart({ model }: { model: ChartModel }) {
  const width = 720;
  const height = 260;
  const margin = { top: 16, right: 16, bottom: 34, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const sx = (turn: number) =>
    margin.left + ((turn - model.xMin) / (model.xMax - model.xMin)) * innerW;
  const sy = (value: number) =>
    margin.top + innerH - ((value - model.yMin) / (model.yMax - model.yMin)) * innerH;

  // The trigger is a step rule: each judged arrival's level holds until the
  // next judged arrival; before the first judgment the flat T_segment adjudicates.
  const triggerPath = (() => {
    const parts: string[] = [];
    const first = (model.judged[0]?.turnNumber ?? model.xMin) as number;
    if (first > model.xMin) {
      parts.push(
        `M ${sx(model.xMin).toFixed(1)} ${sy(model.segmentThreshold).toFixed(1)} H ${sx(first).toFixed(1)}`,
      );
    }
    model.judged.forEach((point, index) => {
      const next = model.judged[index + 1];
      const xEnd = next ? next.turnNumber : model.xMax;
      parts.push(
        `M ${sx(point.turnNumber).toFixed(1)} ${sy(point.threshold).toFixed(1)} H ${sx(xEnd).toFixed(1)}`,
      );
    });
    return parts.join(' ');
  })();

  const xs = model.judged.map((point) => point.turnNumber);
  const driftYs = model.judged.map((point) => point.driftP);
  const muXs = model.judged.filter((point) => point.mu !== null).map((point) => point.turnNumber);
  const muYs = model.judged.filter((point) => point.mu !== null).map((point) => point.mu as number);

  const gridLevels = [0.25, 0.5, 0.75].map(
    (fraction) => model.yMin + (model.yMax - model.yMin) * fraction,
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Arrival drift against the per-segment trigger"
      className="w-full"
    >
      {gridLevels.map((level) => (
        <g key={level}>
          <line
            x1={margin.left}
            y1={sy(level)}
            x2={width - margin.right}
            y2={sy(level)}
            stroke="currentColor"
            strokeOpacity={0.12}
          />
          <text
            x={margin.left - 6}
            y={sy(level) + 3}
            textAnchor="end"
            fontSize={9}
            fill="currentColor"
            opacity={0.6}
          >
            {level.toFixed(2)}
          </text>
        </g>
      ))}
      {/* Segment spans — one tick one per live-chain segment. */}
      {model.segmentStarts.map((segment) => (
        <g key={segment.index}>
          <line
            x1={sx(segment.turn)}
            y1={margin.top}
            x2={sx(segment.turn)}
            y2={height - margin.bottom}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeDasharray="4 4"
          />
          <text
            x={sx(segment.turn) + 4}
            y={margin.top + 10}
            fontSize={9}
            fill="currentColor"
            opacity={0.55}
          >
            S{segment.index}
          </text>
        </g>
      ))}
      {/* Trigger step rule */}
      <path d={triggerPath} fill="none" stroke={DRIFT_COLORS.trigger} strokeWidth={2} />
      {/* Ledger mean under the arrivals */}
      {muXs.length > 1 && (
        <polyline
          points={polylinePoints(muXs, muYs, sx, sy)}
          fill="none"
          stroke={DRIFT_COLORS.ledgerMean}
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.7}
        />
      )}
      {/* Arrival drift readings */}
      {xs.length > 1 && (
        <polyline
          points={polylinePoints(xs, driftYs, sx, sy)}
          fill="none"
          stroke={DRIFT_COLORS.drift}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
      {/* Verdict markers + muted ticks */}
      {model.judged.map((point) => (
        <circle
          key={point.turnNumber}
          cx={sx(point.turnNumber)}
          cy={sy(point.driftP)}
          r={point.verdict === 'fire' ? 5 : 3.5}
          fill={point.verdict === 'fire' ? DRIFT_COLORS.fire : DRIFT_COLORS.pass}
          stroke={point.verdict === 'fire' ? '#f3e8ff' : 'none'}
          strokeWidth={1}
        >
          <title>
            {[
              `Turn ${point.turnNumber}`,
              `drift ${point.driftP.toFixed(3)}`,
              `trigger ${point.threshold.toFixed(3)}`,
              [point.verdict, point.fireChannel ? `(${point.fireChannel})` : null]
                .filter(Boolean)
                .join(' '),
            ].join(' · ')}
          </title>
        </circle>
      ))}
      {model.mutedTurns.map((turn) => (
        <line
          key={turn}
          x1={sx(turn)}
          y1={height - margin.bottom}
          x2={sx(turn)}
          y2={height - margin.bottom - 6}
          stroke="currentColor"
          strokeOpacity={0.45}
        >
          <title>{`Turn ${turn} · muted (ledger warming up)`}</title>
        </line>
      ))}
      <text
        x={width / 2}
        y={height - 8}
        textAnchor="middle"
        fontSize={10}
        fill="currentColor"
        opacity={0.6}
      >
        user-arrival turn number
      </text>
    </svg>
  );
}

function ZChart({ model }: { model: ChartModel }) {
  const withZ = model.judged.filter((point) => point.zScore !== null);
  if (withZ.length === 0) return null;

  const width = 720;
  const height = 160;
  const margin = { top: 12, right: 16, bottom: 30, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const zs = withZ.map((point) => point.zScore as number);
  const zMax = Math.max(...zs, model.immediateK) + 0.5;
  const zMin = Math.min(0, ...zs) - 0.5;

  const sx = (turn: number) =>
    margin.left + ((turn - model.xMin) / (model.xMax - model.xMin)) * innerW;
  const sy = (z: number) => margin.top + innerH - ((z - zMin) / (zMax - zMin)) * innerH;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Arrivals in z-score space against the immediate fire level"
      className="w-full"
    >
      <line
        x1={margin.left}
        y1={sy(model.immediateK)}
        x2={width - margin.right}
        y2={sy(model.immediateK)}
        stroke={DRIFT_COLORS.trigger}
        strokeDasharray="6 4"
        strokeWidth={1.5}
        opacity={0.8}
      >
        <title>{`immediate fire level z = ${model.immediateK}`}</title>
      </line>
      {withZ.map((point) => (
        <circle
          key={point.turnNumber}
          cx={sx(point.turnNumber)}
          cy={sy(point.zScore as number)}
          r={point.verdict === 'fire' && point.fireChannel === 'immediate' ? 5 : 3.5}
          fill={point.verdict === 'fire' ? DRIFT_COLORS.fire : DRIFT_COLORS.pass}
        >
          <title>{`Turn ${point.turnNumber} · z ${(point.zScore as number).toFixed(2)}`}</title>
        </circle>
      ))}
      <text
        x={margin.left - 6}
        y={sy(0) + 3}
        textAnchor="end"
        fontSize={9}
        fill="currentColor"
        opacity={0.6}
      >
        0
      </text>
      <text
        x={width / 2}
        y={height - 6}
        textAnchor="middle"
        fontSize={10}
        fill="currentColor"
        opacity={0.6}
      >
        same arrivals, standardized: z = (drift − μ) / max(σ, σ_floor)
      </text>
    </svg>
  );
}

function Legend() {
  const entries = [
    { color: DRIFT_COLORS.drift, label: 'Arrival drift (composite reading)' },
    { color: DRIFT_COLORS.trigger, label: 'Trigger (μ + k·max(σ, σ_floor), or T_segment)' },
    { color: DRIFT_COLORS.fire, label: 'Gate fire — segment ends' },
    { color: DRIFT_COLORS.pass, label: 'Accepted arrival' },
  ];
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

function SegmentTable({ view }: { view: LiveAnalysisView }) {
  if (view.segments.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1.5">Segment</th>
            <th className="px-2 py-1.5">Opened by</th>
            <th className="px-2 py-1.5 text-right">Arrivals</th>
            <th className="px-2 py-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {view.segments.map((segment) => (
            <tr key={segment.segmentId} className="border-b border-border/50">
              <td className="px-2 py-1.5 font-medium">#{segment.index}</td>
              <td className="max-w-[360px] truncate px-2 py-1.5" title={segment.label}>
                {segment.label}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{segment.arrivalCount}</td>
              <td className="px-2 py-1.5">
                {segment.closed ? (
                  <span className="text-purple-400">closed by fire</span>
                ) : (
                  <span className="text-emerald-400">open</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AnalysisTab({
  threadId,
  refreshKey,
}: { threadId: string; refreshKey?: number }) {
  const [view, setView] = useState<LiveAnalysisView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a refetch trigger, not a read value
  useEffect(() => {
    let stale = false;
    setView(null);
    setError(null);
    fetchThreadAnalysis(threadId)
      .then((loaded) => {
        if (!stale) setView(loaded);
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : 'Failed to load the analysis.');
      });
    return () => {
      stale = true;
    };
  }, [threadId, refreshKey]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-red-400">
        {error}
      </div>
    );
  }
  if (!view || view.pending) return <AnalysisSpinner />;
  if (view.points.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No arrivals judged yet — send a message and the live reading will fill in here.
      </div>
    );
  }

  const model = buildChartModel(view);
  const fires = view.points.filter((point) => point.verdict === 'fire').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mx-auto flex w-full min-w-0 max-w-[760px] flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Live reading</h2>
          <p className="text-xs text-muted-foreground">
            {view.points.length} judged arrivals · {view.segments.length} segment
            {view.segments.length === 1 ? '' : 's'} · {fires} fire{fires === 1 ? '' : 's'} —
            persisted as they were judged (embedding {view.params.embeddingModelId})
          </p>
        </header>
        <Legend />
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <DriftChart model={model} />
        </div>
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <ZChart model={model} />
        </div>
        <SegmentTable view={view} />
      </div>
    </div>
  );
}
