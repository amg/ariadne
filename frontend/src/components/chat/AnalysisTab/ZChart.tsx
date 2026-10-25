import { DRIFT_COLORS, type buildChartModel } from './model';

type ChartModel = ReturnType<typeof buildChartModel>;

export function ZChart({ model }: { model: ChartModel }) {
  const withZ = model.judged.filter((point) => point.zScore !== null);
  if (withZ.length === 0) return null;

  const width = 720;
  const height = 160;
  const margin = { top: 12, right: 16, bottom: 30, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const zs = withZ.map((point) => point.zScore as number);
  const zMax = Math.max(...zs, model.immediateStdDevs) + 0.5;
  const zMin = Math.min(0, ...zs) - 0.5;

  const zTicks: number[] = [];
  for (let z = Math.ceil(zMin); z <= Math.floor(zMax); z += 1) zTicks.push(z);

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
        y1={sy(model.immediateStdDevs)}
        x2={width - margin.right}
        y2={sy(model.immediateStdDevs)}
        stroke={DRIFT_COLORS.trigger}
        strokeDasharray="6 4"
        strokeWidth={1.5}
        opacity={0.8}
      >
        <title>{`immediate fire level z = ${model.immediateStdDevs}`}</title>
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
      {zTicks.map((z) => (
        <text
          key={`z-${z}`}
          x={margin.left - 6}
          y={sy(z) + 3}
          textAnchor="end"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          {z}
        </text>
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
        z (σ)
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
