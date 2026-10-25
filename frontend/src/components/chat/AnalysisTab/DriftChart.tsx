import { DRIFT_COLORS, type buildChartModel, polylinePoints, stepPath } from './model';

type ChartModel = ReturnType<typeof buildChartModel>;

export function DriftChart({ model }: { model: ChartModel }) {
  const width = 720;
  const height = 260;
  const margin = { top: 16, right: 16, bottom: 34, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const sx = (turn: number) =>
    margin.left + ((turn - model.xMin) / (model.xMax - model.xMin)) * innerW;
  const sy = (value: number) =>
    margin.top + innerH - ((value - model.yMin) / (model.yMax - model.yMin)) * innerH;

  const xs = model.judged.map((point) => point.turnNumber);
  const driftYs = model.judged.map((point) => point.driftP);
  const muXs = model.judged.filter((point) => point.mu !== null).map((point) => point.turnNumber);
  const muYs = model.judged.filter((point) => point.mu !== null).map((point) => point.mu as number);

  const gridLevels = [0.25, 0.5, 0.75].map(
    (fraction) => model.yMin + (model.yMax - model.yMin) * fraction,
  );

  const turnStep = Math.max(1, Math.ceil((model.xMax - model.xMin) / 10));
  const turnTicks: number[] = [];
  for (let turn = model.xMin; turn <= model.xMax; turn += turnStep) turnTicks.push(turn);

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
      <line
        x1={margin.left}
        y1={height - margin.bottom}
        x2={width - margin.right}
        y2={height - margin.bottom}
        stroke="currentColor"
        strokeOpacity={0.35}
      />
      {turnTicks.map((turn) => (
        <g key={`turn-${turn}`}>
          <line
            x1={sx(turn)}
            y1={height - margin.bottom}
            x2={sx(turn)}
            y2={height - margin.bottom + 4}
            stroke="currentColor"
            strokeOpacity={0.45}
          />
          <text
            x={sx(turn)}
            y={height - margin.bottom + 14}
            textAnchor="middle"
            fontSize={9}
            fill="currentColor"
            opacity={0.6}
          >
            {turn}
          </text>
        </g>
      ))}
      <text
        transform={`rotate(-90 12 ${margin.top + innerH / 2})`}
        x={12}
        y={margin.top + innerH / 2}
        textAnchor="middle"
        fontSize={10}
        fill="currentColor"
        opacity={0.6}
      >
        arrival drift
      </text>
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
      {model.triggerSegments.map((segment) => (
        <path
          key={segment.segmentIndex}
          d={stepPath(
            segment.points.map((point) => ({
              x: sx(point.turnNumber),
              y: sy(point.threshold),
            })),
            { left: margin.left, right: width - margin.right },
          )}
          fill="none"
          stroke={DRIFT_COLORS.trigger}
          strokeWidth={2}
          strokeLinejoin="round"
        >
          <title>{`Live trigger (segment ${segment.segmentIndex})`}</title>
        </path>
      ))}
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
      {xs.length > 1 && (
        <polyline
          points={polylinePoints(xs, driftYs, sx, sy)}
          fill="none"
          stroke={DRIFT_COLORS.drift}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
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
