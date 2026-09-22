import { round10 } from './cost';
import type {
  CostPoint,
  DriftPoint,
  GateReplayPoint,
  GateVerdict,
  ThreadReport,
  ThreadReportParams,
  TopicSegmentTurn,
} from './types';

/**
 * The analyzer's pure rendering half: turns a complete `ThreadReport` into its two
 * artifacts — a fully self-contained HTML document (inline SVG charts,
 * inline CSS, zero external references, opens offline in any browser)
 * and the JSON sidecar (the exact report serialized, the data contract
 * wave 2's UI will later serve). String transforms only; no I/O — the
 * CLI performs every filesystem write.
 *
 * The two scoring flows share one verdict but read different signals, so
 * they get separate charts: the offline fold (every completed Turn
 * judged on the full-turn reading against its segment's own state, with
 * T_segment drawn as the bootstrap prior) renders its own chart; the
 * live gate (arrivals judged on the composite prospective reading against
 * the same per-segment trigger) renders its own chart in two stacked
 * panels — arrival drift in drift units against the per-segment trigger
 * line above, the same arrivals standardised to z against the flat
 * z = k trigger below.
 */

export interface RenderedThreadReport {
  html: string;
  json: string;
}

export function renderThreadReport(report: ThreadReport): RenderedThreadReport {
  return {
    html: renderHtml(report),
    json: JSON.stringify(report, null, 2),
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** User-controlled strings (titles, labels, ids) are always escaped. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Costs at `numeric(14,10)` precision — small fractions stay legible. */
function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** Rounds an SVG coordinate to 2 decimals to keep the artifact compact. */
function coord(value: number): number {
  return Number(value.toFixed(2));
}

/* ------------------------------------------------------------------ */
/* Chart geometry — every chart speaks the shared turn-number axis     */
/* ------------------------------------------------------------------ */

const WIDTH = 1040;
const HEIGHT = 460;
const MARGIN = { top: 52, right: 70, bottom: 48, left: 88 };

/** Any plane that can place a drift value at a Turn number. */
interface DriftPlane {
  x: (turnNumber: number) => number;
  driftY: (value: number) => number;
}

/** The offline chart's geometry: cost scale on the left, drift on the right. */
interface OfflineFrame extends DriftPlane {
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  turnCount: number;
  costMax: number;
  driftMax: number;
  costY: (value: number) => number;
}

function buildOfflineFrame(report: ThreadReport): OfflineFrame {
  const plotLeft = MARGIN.left;
  const plotRight = WIDTH - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = HEIGHT - MARGIN.bottom;
  const turnCount = Math.max(1, report.totals.turns);
  const costValues = report.costProfile.flatMap((point) => [
    point.runningTotalUsd,
    point.marginalCostUsd,
  ]);
  // The offline axis fits the fold's own world: its two scored series
  // plus the fixed criterion they are judged against. Cosine distances
  // can technically reach 2 but the chart keeps [0, 1] in view.
  const driftValues = [
    ...report.driftSeries.flatMap((point) => [point.anchorDistance, point.segmentDrift ?? 0]),
  ];
  const costMax = Math.max(1e-9, ...costValues);
  const driftMax = Math.max(1, ...driftValues, report.params.segmentThreshold);
  const span = Math.max(1, turnCount - 1);
  return {
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    turnCount,
    costMax,
    driftMax,
    x: (turnNumber) => coord(plotLeft + ((turnNumber - 1) / span) * (plotRight - plotLeft)),
    costY: (value) => coord(plotBottom - (value / costMax) * (plotBottom - plotTop)),
    driftY: (value) => coord(plotBottom - (value / driftMax) * (plotBottom - plotTop)),
  };
}

/**
 * The live chart's geometry (two panels, one turn axis): the drift
 * panel above plots arrival readings against their trigger levels in
 * drift units; the z panel below replays the same arrivals on their
 * segments' z scale. The axis tick row sits once under the z panel.
 */
const LIVE_LAYOUT = { mainTop: 40, mainBottom: 340, zTop: 374, zBottom: 494, bottom: 540 } as const;

interface LiveFrame extends DriftPlane {
  plotLeft: number;
  plotRight: number;
  turnCount: number;
  driftMax: number;
  zMin: number;
  zMax: number;
  zY: (value: number) => number;
}

function buildLiveFrame(report: ThreadReport): LiveFrame {
  const plotLeft = MARGIN.left;
  const plotRight = WIDTH - MARGIN.right;
  const turnCount = Math.max(1, report.totals.turns);
  const gatePoints = report.gateReplay?.points ?? [];
  // The drift panel owns the arrival readings and their trigger levels;
  // the fold's constant rides them (bootstrap criteria carry it).
  const driftValues = [
    ...gatePoints.flatMap((point) => [point.driftP ?? 0, point.driftPGated ?? 0]),
    ...gatePoints.flatMap((point) =>
      point.immediateThreshold === undefined ? [] : [point.immediateThreshold],
    ),
    // The standing default too — the trigger's lead-in and post-fire
    // tail ride it.
    report.params.segmentThreshold,
  ];
  const driftMax = Math.max(1, ...driftValues);
  // The z panel's scale fits the thread's own spread: always the trigger
  // at comfortable height (≥ 2k), padded for the tallest spike; negative
  // readings (arrivals calmer than the segment mean) extend downward.
  const k = report.params.immediateK;
  const zValues = gatePoints.flatMap((point) =>
    point.immediateZ === undefined ? [] : [point.immediateZ],
  );
  const zFloor = zValues.length > 0 ? Math.min(0, ...zValues) : 0;
  const zPeak = zValues.length > 0 ? Math.max(...zValues) : 0;
  const zMin = zFloor - (zFloor < 0 ? 0.4 : 0);
  const zMax = Math.max(k * 2, zPeak) + 0.4;
  const span = Math.max(1, turnCount - 1);
  const { mainTop, mainBottom, zTop, zBottom } = LIVE_LAYOUT;
  return {
    plotLeft,
    plotRight,
    turnCount,
    driftMax,
    zMin,
    zMax,
    x: (turnNumber) => coord(plotLeft + ((turnNumber - 1) / span) * (plotRight - plotLeft)),
    driftY: (value) => coord(mainBottom - (value / driftMax) * (mainBottom - mainTop)),
    zY: (value) => coord(zBottom - ((value - zMin) / (zMax - zMin)) * (zBottom - zTop)),
  };
}

function polyline(
  points: Array<{ turnNumber: number; value: number }>,
  x: (turnNumber: number) => number,
  y: (value: number) => number,
): string {
  return points.map((point) => `${x(point.turnNumber)},${y(point.value)}`).join(' ');
}

/** Turn numbers to tick — ~ten evenly spaced, always the first and last. */
function xTicks(turnCount: number): number[] {
  const step = Math.max(1, Math.ceil(turnCount / 10));
  const ticks: number[] = [];
  for (let tick = 1; tick <= turnCount; tick += step) ticks.push(tick);
  if (ticks[ticks.length - 1] !== turnCount) ticks.push(turnCount);
  return ticks;
}

interface TurnCostPoint {
  turnNumber: number;
  marginalCostUsd: number;
  runningTotalUsd: number;
}

/**
 * Projects the per-message cost profile onto the chart's turn axis: turn t
 * owns messages 2t−1..2t. User messages never carry usage rows, so the
 * turn's marginal cost is its assistant marginal; the running total is the
 * roll-up at the turn's last message. Messages beyond the last complete
 * Turn (a trailing unpaired user message) are dropped — they add no spend
 * and no Turn to plot.
 */
function turnCostSeries(costProfile: CostPoint[], turnCount: number): TurnCostPoint[] {
  const byTurn = new Map<number, TurnCostPoint>();
  for (const point of costProfile) {
    const turnNumber = Math.ceil(point.messageIndex / 2);
    if (turnNumber > turnCount) continue;
    const entry = byTurn.get(turnNumber) ?? { turnNumber, marginalCostUsd: 0, runningTotalUsd: 0 };
    entry.marginalCostUsd = round10(entry.marginalCostUsd + point.marginalCostUsd);
    entry.runningTotalUsd = point.runningTotalUsd;
    byTurn.set(turnNumber, entry);
  }
  return [...byTurn.values()].sort((a, b) => a.turnNumber - b.turnNumber);
}

/* ------------------------------------------------------------------ */
/* The offline chart — the fold's own world                            */
/* ------------------------------------------------------------------ */

function renderOfflineChart(report: ThreadReport): string {
  const frame = buildOfflineFrame(report);
  const parts: string[] = [];

  parts.push(
    `<svg class="chart chart-offline" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Cost and drift over the thread’s turns (offline fold)">`,
    renderGridAndAxes(frame),
  );

  // Every toggleable family lives in a data-toggle group scoped to this
  // chart's block; the inline script at the document's bottom shows or
  // hides them. Groups render even when empty so checkboxes always have
  // a target.
  const group = (name: string, body: string) => `<g data-toggle="${name}">${body}</g>`;

  // Boundary turns (fold output): vertical marks behind the series,
  // exactly at the Boundary Turn.
  const boundaryMarks = report.driftSeries
    .filter((point) => point.isBoundary)
    .map((point) => {
      const x = frame.x(point.turnNumber);
      return `<line class="boundary-mark" x1="${x}" y1="${frame.plotTop}" x2="${x}" y2="${frame.plotBottom}" stroke="#c62828" stroke-width="1" stroke-dasharray="2 3" opacity="0.7"/>`;
    })
    .join('');
  parts.push(group('boundary', boundaryMarks));

  // The fold judges every completed Turn with the shared two-channel
  // verdict against its segment's OWN state; the flat constant is drawn
  // as the bootstrap prior — the level a segment's arrivals face while
  // its noise ledger warms (< 2 accepted members). The live gate's
  // trigger steps live in the live chart, never here; the drawn constant
  // is landmark and prior both. Not toggleable.
  parts.push(
    thresholdLine(
      frame,
      report.params.segmentThreshold,
      'segment threshold (bootstrap prior)',
      '#ef6c00',
    ),
  );

  // Cost is context, not signal — drawn deliberately faint (thin line,
  // pale bars) so the drift families own the eye.
  const costSeries = turnCostSeries(report.costProfile, frame.turnCount);
  const costBars = costSeries
    .filter((point) => point.marginalCostUsd > 0)
    .map((point) => {
      const x = frame.x(point.turnNumber);
      return `<rect class="bar-marginal" x="${coord(x - 1.5)}" y="${frame.costY(point.marginalCostUsd)}" width="3" height="${coord(frame.plotBottom - frame.costY(point.marginalCostUsd))}" fill="#a5d6a7" opacity="0.45"/>`;
    })
    .join('');
  const costLines = turnCostSeriesRunningTotal(costSeries)
    .map(
      (series) =>
        `<polyline class="series-running-total" points="${polyline(series, frame.x, frame.costY)}" fill="none" stroke="#2e7d32" stroke-width="1" stroke-linejoin="round" opacity="0.55"/>`,
    )
    .join('');
  parts.push(group('cost', costBars + costLines));

  // Drift series on the shared axis (drift scale). Weight hierarchy:
  // the recorded fold series is the thick ground truth; the Anchor
  // wander gauge is the medium line.
  const recordPoints = report.driftSeries
    .filter((point): point is DriftPoint & { segmentDrift: number } => point.segmentDrift !== null)
    .map((point) => ({ turnNumber: point.turnNumber, value: point.segmentDrift }));
  const pointByTurn = new Map(report.driftSeries.map((point) => [point.turnNumber, point]));
  const anchorBody = driftSeriesElement(
    'series-anchor-distance',
    '#1565c0',
    report.driftSeries.map((point) => ({
      turnNumber: point.turnNumber,
      value: point.anchorDistance,
    })),
    frame,
  );
  const recordBody =
    driftSeriesElement('series-segment-drift', '#ef6c00', recordPoints, frame, '7 4', 2.5) +
    driftPointMarkers(recordPoints, frame, 'drift-point', '#ef6c00', 1.75, (point) => {
      const full = pointByTurn.get(point.turnNumber);
      return full && hasJudgedDrift(full) ? driftPointTooltip(full) : '';
    });
  parts.push(group('anchor', anchorBody), group('segments', recordBody));

  // Anchor-wander counsel (the fold's own rows) rides the Anchor series
  // it warns about — a ring on the counsel Turn's wander point.
  const counselMarks = report.anchor.counsel
    .map((row) => {
      const cx = frame.x(row.turnNumber);
      const cy = frame.driftY(row.anchorDistance);
      return `<circle class="counsel-mark" cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="#1565c0" stroke-width="1.5"><title>${escapeHtml(
        `Turn ${row.turnNumber} — slow-drift counsel: sustained rise in Anchor wander (complete-turn reading, distance ${row.anchorDistance.toFixed(3)}) — advisory only`,
      )}</title></circle>`;
    })
    .join('');
  parts.push(group('counsel', counselMarks));

  // One “?” badge per Topic segment, top-center of its turn span;
  // hovering (or focusing) it pops the segment's messages.
  parts.push(
    group('badges', report.segments.map((segment) => renderSegmentBadge(segment, frame)).join('')),
  );

  parts.push('</svg>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* The live chart — arrival drift vs the per-segment trigger, + z view */
/* ------------------------------------------------------------------ */

function renderLiveChart(report: ThreadReport): string {
  const frame = buildLiveFrame(report);
  const gate = report.gateReplay;
  if (!gate) return '';
  const params = report.params;
  const immediateK = params.immediateK;
  const parts: string[] = [];

  parts.push(
    `<svg class="chart chart-live" viewBox="0 0 ${WIDTH} ${LIVE_LAYOUT.bottom}" role="img" aria-label="Live gate: arrival drift against the per-segment trigger, and the same arrivals in z">`,
    renderLiveGridAndAxes(frame, immediateK),
  );
  const group = (name: string, body: string) => `<g data-toggle="${name}">${body}</g>`;

  // Fires get a full-height translucent band centred on the fired Turn
  // (drift panel only — the z panel carries its own verdict markers).
  const spacing = (frame.plotRight - frame.plotLeft) / Math.max(1, frame.turnCount - 1);
  const fireHalf = coord(Math.max(2, Math.min(6, spacing * 0.4)));
  const fireMarks = gate.points
    .filter((point) => point.verdict === 'fire')
    .map((point) => {
      const x = frame.x(point.turnNumber);
      return `<g class="gate-fire-mark"><rect class="gate-fire-band" x="${coord(x - fireHalf)}" y="${LIVE_LAYOUT.mainTop}" width="${coord(fireHalf * 2)}" height="${coord(LIVE_LAYOUT.mainBottom - LIVE_LAYOUT.mainTop)}" fill="#6a1b9a" opacity="0.12"/><line x1="${x}" y1="${LIVE_LAYOUT.mainTop}" x2="${x}" y2="${LIVE_LAYOUT.mainBottom}" stroke="#6a1b9a" stroke-width="1" opacity="0.55"/></g>`;
    })
    .join('');
  parts.push(group('fires', fireMarks));

  // The live trigger: each live segment's threshold line — flat T_segment
  // while the segment's ledger warms, the learned μ + k·max(σ, σ_floor)
  // once it speaks, resetting to T_segment on every fired Turn. Not
  // toggleable: it is the live lane's landmark.
  parts.push(liveTriggerElement(frame, gate.points, params, report.params.segmentThreshold));

  // The arrival drift series: drift_p — the non-standardised reading of
  // the judged signal (the expansion tier's rewritten user message when
  // one landed, the raw arrival-time text as fallback) — with one
  // verdict-carrying marker per point.
  const verdictPoints = gate.points.filter(
    (point): point is GateReplayPoint & { driftPGated: number } => point.driftPGated !== null,
  );
  const verdictBody =
    driftSeriesElement(
      'series-prospective-drift',
      '#6a1b9a',
      verdictPoints.map((point) => ({ turnNumber: point.turnNumber, value: point.driftPGated })),
      frame,
      '2 3',
      1.25,
    ) + gatePointMarkers(verdictPoints, frame, params.lambda);
  parts.push(group('prospective', verdictBody));

  // The raw audit series: the arrival-time message exactly
  // as received, drawn only when the expansion tier ran.
  const rawSeries = verdictPoints
    .filter((point) => point.driftP !== null)
    .map((point) => ({ turnNumber: point.turnNumber, value: point.driftP as number }));
  if (verdictPoints.some((point) => point.driftPSource !== undefined)) {
    const rawBody =
      driftSeriesElement('series-raw-drift', '#9e9e9e', rawSeries, frame, '3 3', 0.9) +
      driftPointMarkers(rawSeries, frame, 'drift-point', '#9e9e9e', 1.2, (point) => {
        return `Turn ${point.turnNumber} — drift_p on the raw message (audit) ${point.value.toFixed(3)}`;
      });
    parts.push(group('raw', rawBody));
  }

  parts.push(zPanelElement(frame, gate.points, params));
  parts.push('</svg>');
  return parts.join('\n');
}

/** The live chart's grid, scales and turn axis. */
function renderLiveGridAndAxes(frame: LiveFrame, immediateK: number): string {
  const { mainTop, mainBottom, zTop, zBottom } = LIVE_LAYOUT;
  const parts: string[] = [];
  const plotWidth = frame.plotRight - frame.plotLeft;

  // The drift panel: gridlines + right-hand drift labels.
  const divisions = 4;
  for (let i = 0; i <= divisions; i += 1) {
    const fraction = i / divisions;
    const y = coord(mainBottom - fraction * (mainBottom - mainTop));
    parts.push(
      `<line x1="${frame.plotLeft}" y1="${y}" x2="${frame.plotRight}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${frame.plotRight + 6}" y="${coord(y + 3)}" text-anchor="start" ` +
        `font-size="10" fill="#616161">${(frame.driftMax * fraction).toFixed(2)}</text>`,
    );
  }
  // The z panel: gridlines + right-hand z labels.
  for (let i = 0; i <= divisions; i += 1) {
    const fraction = i / divisions;
    const y = coord(zBottom - fraction * (zBottom - zTop));
    const value = frame.zMin + fraction * (frame.zMax - frame.zMin);
    parts.push(
      `<line x1="${frame.plotLeft}" y1="${y}" x2="${frame.plotRight}" y2="${y}" stroke="#eeeeee" stroke-width="1"/>`,
      `<text x="${frame.plotRight + 6}" y="${coord(y + 3)}" text-anchor="start" ` +
        `font-size="10" fill="#616161">${value.toFixed(1)}</text>`,
    );
  }

  // Panel frames + the trigger landmark's own label above the drift
  // panel (the plot top leaves the badge tier unused here on purpose).
  parts.push(
    `<rect x="${frame.plotLeft}" y="${mainTop}" width="${plotWidth}" height="${coord(mainBottom - mainTop)}" fill="none" stroke="#9e9e9e" stroke-width="1"/>`,
    `<rect x="${frame.plotLeft}" y="${zTop}" width="${plotWidth}" height="${coord(zBottom - zTop)}" fill="none" stroke="#9e9e9e" stroke-width="1"/>`,
  );
  if (frame.plotRight - frame.plotLeft > 0) {
    parts.push(
      `<text x="${frame.plotLeft + 6}" y="${mainTop - 10}" text-anchor="start" font-size="10" fill="#6a1b9a">live trigger — each segment's threshold: T_segment while the ledger warms, μ + k·max(σ, σ_floor) once it learns, reset on every fired Turn</text>`,
      `<text x="${frame.plotLeft + 6}" y="${zTop - 8}" text-anchor="start" font-size="10" fill="#6a1b9a">same arrivals, z-standardised to their own segment — fires at z ≥ k = ${immediateK}</text>`,
    );
  }

  // Axis titles plus the shared turn-number axis under the z panel.
  parts.push(
    `<text x="${coord(frame.plotRight + 52)}" y="${coord((mainTop + mainBottom) / 2)}" text-anchor="middle" font-size="11" fill="#424242" transform="rotate(90 ${coord(frame.plotRight + 52)} ${coord((mainTop + mainBottom) / 2)})">drift</text>`,
    `<text x="${coord(frame.plotRight + 52)}" y="${coord((zTop + zBottom) / 2)}" text-anchor="middle" font-size="11" fill="#424242" transform="rotate(90 ${coord(frame.plotRight + 52)} ${coord((zTop + zBottom) / 2)})">z (σ above segment μ)</text>`,
  );
  for (const tick of xTicks(frame.turnCount)) {
    const x = frame.x(tick);
    parts.push(
      `<line x1="${x}" y1="${zBottom}" x2="${x}" y2="${coord(zBottom + 4)}" stroke="#9e9e9e" stroke-width="1"/>`,
      `<text x="${x}" y="${coord(zBottom + 16)}" text-anchor="middle" ` +
        `font-size="10" fill="#616161">${tick}</text>`,
    );
  }
  parts.push(
    `<text x="${coord((frame.plotLeft + frame.plotRight) / 2)}" y="${coord(zBottom + 34)}" text-anchor="middle" font-size="11" fill="#424242">turn number</text>`,
  );
  return parts.join('\n');
}

/** One judged Turn and the trigger level that judged it. */
interface TriggerStep {
  turnNumber: number;
  threshold: number;
  mu: number | null;
  sigma: number | null;
  /** The live segment the Turn belongs to (see liveTriggerElement). */
  segment: number;
}

/**
 * Tooltip on a judged Turn's trigger marker: the level the arrival was
 * judged against — bootstrap flat vs the learned formula — and the live
 * segment the Turn belongs to.
 */
function triggerPointTooltip(step: TriggerStep, params: ThreadReportParams): string {
  const base = `Turn ${step.turnNumber} — arrival judged against ${step.threshold.toFixed(3)}`;
  const tail = ` · live segment ${step.segment}`;
  if (step.mu === null || step.sigma === null) {
    return `${base} — bootstrap: flat T_segment until the ledger holds 2 accepted members${tail}`;
  }
  const { immediateK, sigmaFloor } = params;
  const mu = (step.mu ?? 0).toFixed(3);
  const sigma = (step.sigma ?? 0).toFixed(3);
  return `${base} — z-adjusted: μ ${mu} + ${immediateK}·max(σ ${sigma}, σ_floor ${sigmaFloor})${tail}`;
}

/**
 * The live trigger, drawn as segment STATE, not as the judge moment:
 * the level over [Turn i, Turn i+1) is the state Turn i's fold left
 * behind — the very criterion that judges the next arrival. Consequences
 * the reader can see: a learned adjustment steps up inside its OWN
 * segment, the moment the ledger warms; a fired Turn's reset lands ON
 * the boundary turn (boundary turns belong to the segment they start); and the level reaching into a boundary turn is the
 * closing segment's FINAL criterion — which is why fired readings
 * visibly cross it before the drop.
 *
 * Three drawn pieces: a faint dashed lead-in of the standing T_segment
 * across the cold-start mute, one solid slab per judged interval (each
 * with its own hover title), and a short T_segment tail after a final
 * fire. Live segment numbering: the mute span is segment 1, every fired
 * Turn opens the next one.
 */
function liveTriggerElement(
  frame: LiveFrame,
  points: GateReplayPoint[],
  params: ThreadReportParams,
  segmentThreshold: number,
): string {
  const segmentByTurn = new Map<number, number>();
  let segmentIndex = 1;
  for (const point of points) {
    if (point.verdict === 'fire') segmentIndex += 1;
    segmentByTurn.set(point.turnNumber, segmentIndex);
  }
  const steps = points
    .filter(
      (point): point is GateReplayPoint & { immediateThreshold: number } =>
        point.immediateThreshold !== undefined,
    )
    .map((point) => ({
      turnNumber: point.turnNumber,
      threshold: point.immediateThreshold,
      mu: point.segmentMu ?? null,
      sigma: point.segmentSigma ?? null,
      segment: segmentByTurn.get(point.turnNumber) ?? 1,
    }));
  const first = steps[0] as TriggerStep | undefined;
  if (!first) return '';
  const spacing = (frame.plotRight - frame.plotLeft) / Math.max(1, frame.turnCount - 1);
  const constantY = frame.driftY(segmentThreshold);
  const constantLabel = segmentThreshold.toFixed(2);
  const parts: string[] = [];

  // The muted lead-in: the standing default while the gate says nothing.
  if (first.turnNumber > 1) {
    const muteEnd = first.turnNumber - 1;
    const muteLabel = muteEnd === 1 ? 'Turn 1' : `Turns 1–${muteEnd}`;
    parts.push(
      `<path class="series-live-trigger-lead" d="M ${frame.x(1)} ${constantY} H ${frame.x(first.turnNumber)}" fill="none" stroke="#6a1b9a" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.55"><title>${escapeHtml(`standing T_segment ${constantLabel} — the gate is muted on cold start (${muteLabel}); the first judged arrival sees this level · live segment 1`)}</title></path>`,
    );
  }

  // One slab per judged interval: [x_i, x_{i+1}) at the level left
  // behind by Turn i's fold, with the vertical into the following state
  // drawn at the slab's end.
  for (let i = 0; i < steps.length - 1; i += 1) {
    const current = steps[i] as TriggerStep;
    const following = steps[i + 1] as TriggerStep;
    const level = following.threshold;
    const xA = frame.x(current.turnNumber);
    const xB = frame.x(following.turnNumber);
    const after = steps[i + 2] as TriggerStep | undefined;
    const step = after ? ` V ${frame.driftY(after.threshold)}` : '';
    parts.push(
      `<path class="series-live-trigger" d="M ${xA} ${frame.driftY(level)} H ${xB}${step}" fill="none" stroke="#6a1b9a" stroke-width="2" stroke-linejoin="round"><title>${escapeHtml(`trigger ${level.toFixed(3)} in force between Turn ${current.turnNumber} and Turn ${following.turnNumber} · live segment ${current.segment}`)}</title></path>`,
    );
  }

  // The tail after a final fire: the shredded ledger leaves the standing
  // default for whatever arrives next.
  const last = steps[steps.length - 1] as TriggerStep;
  const lastPoint = points.find((point) => point.turnNumber === last.turnNumber);
  if (lastPoint?.verdict === 'fire') {
    const xTail = Math.min(coord(frame.x(last.turnNumber) + spacing * 0.8), frame.plotRight);
    if (xTail > frame.x(last.turnNumber)) {
      parts.push(
        `<path class="series-live-trigger" d="M ${frame.x(last.turnNumber)} ${constantY} H ${xTail}" fill="none" stroke="#6a1b9a" stroke-width="2"><title>${escapeHtml(`after Turn ${last.turnNumber} (fire): the ledger is shredded — the next arrival judges against T_segment ${constantLabel} · live segment ${last.segment}`)}</title></path>`,
      );
    }
  }

  // Markers where each arrival was actually judged: the dot sits on the
  // level reaching into that Turn — the level that condemned or passed it.
  const marks = steps
    .map((step) => {
      const cx = frame.x(step.turnNumber);
      const cy = frame.driftY(step.threshold);
      return `<circle class="live-trigger-point" cx="${cx}" cy="${cy}" r="2.2" fill="#6a1b9a"><title>${escapeHtml(triggerPointTooltip(step, params))}</title></circle>`;
    })
    .join('');
  return [...parts, marks].join('');
}

/** The tooltip for one z reading: the same arrival on its segment's scale. */
function zPointTooltip(point: GateReplayPoint & { driftPGated: number }): string {
  const z = point.immediateZ;
  if (z === undefined) return '';
  const mu = point.segmentMu ?? 0;
  const sigmaText = `μ ${mu.toFixed(3)} · σ_eff ${(point.segmentSigma ?? 0).toFixed(3)}`;
  return `Turn ${point.turnNumber} — z ${z.toFixed(2)} — reading ${point.driftPGated.toFixed(3)} vs trigger ${(point.immediateThreshold ?? 0).toFixed(3)} (${sigmaText}) · verdict: ${point.verdict}`;
}

/** The drift panel's z view: a strip where the segment-local trigger is flat. */
function zPanelElement(
  frame: LiveFrame,
  points: GateReplayPoint[],
  params: ThreadReportParams,
): string {
  const { zTop, zBottom } = LIVE_LAYOUT;
  const immediateK = params.immediateK;
  const zTriggerY = frame.zY(immediateK);
  const zMeanY = frame.zY(0);

  const zeroLine =
    `<line class="z-mean-line" x1="${frame.plotLeft}" y1="${zMeanY}" x2="${frame.plotRight}" y2="${zMeanY}" stroke="#6a1b9a" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>` +
    `<text x="${frame.plotLeft + 4}" y="${coord(zMeanY - 3)}" text-anchor="start" font-size="10" fill="#6a1b9a" opacity="0.7">segment mean μ (z 0)</text>`;
  if (immediateK < frame.zMin || immediateK > frame.zMax) return zeroLine;
  const triggerLine =
    `<line class="z-trigger-line" x1="${frame.plotLeft}" y1="${zTriggerY}" x2="${frame.plotRight}" y2="${zTriggerY}" stroke="#6a1b9a" stroke-width="1.5"/>` +
    `<text x="${frame.plotRight - 4}" y="${coord(zTriggerY - 4)}" text-anchor="end" font-size="10" fill="#6a1b9a">fires at z ≥ k = ${immediateK}</text>`;

  const zPoints = points.filter(
    (point): point is GateReplayPoint & { driftPGated: number; immediateZ: number } =>
      point.immediateZ !== undefined && point.driftPGated !== null,
  );
  const marks =
    zPoints.length === 0
      ? `<text class="z-empty-note" x="${coord((frame.plotLeft + frame.plotRight) / 2)}" y="${coord((zTop + zBottom) / 2)}" text-anchor="middle" font-size="11" fill="#9e9e9e">no z readings — every judged arrival landed in the bootstrap phase (the flat T_segment judged it raw)</text>`
      : zPoints
          .map((point) => {
            const cx = frame.x(point.turnNumber);
            const cy = frame.zY(point.immediateZ);
            const shape = VERDICT_MARKER[point.verdict];
            const stroke = shape.stroke ? ` stroke="${shape.stroke}" stroke-width="1.5"` : '';
            const opacity = shape.opacity !== undefined ? ` opacity="${shape.opacity}"` : '';
            return `<circle class="z-point ${shape.className}" cx="${cx}" cy="${cy}" r="${shape.radius}" fill="${shape.fill}"${stroke}${opacity}><title>${escapeHtml(zPointTooltip(point))}</title></circle>`;
          })
          .join('');
  return zeroLine + triggerLine + marks;
}

/* ------------------------------------------------------------------ */
/* Shared chart furniture                                              */
/* ------------------------------------------------------------------ */

/** Running-total polyline points, grouped for the chart. */
function turnCostSeriesRunningTotal(
  costSeries: TurnCostPoint[],
): Array<Array<{ turnNumber: number; value: number }>> {
  const points = costSeries.map((point) => ({
    turnNumber: point.turnNumber,
    value: point.runningTotalUsd,
  }));
  return points.length > 0 ? [points] : [];
}

/**
 * The segment's “?” badge: top-center of the segment's turn span, just
 * above the plot frame. Toggling is the inline script's job; content
 * comes from the pre-rendered popover below the chart.
 */
function renderSegmentBadge(
  segment: ThreadReport['segments'][number],
  frame: OfflineFrame,
): string {
  const cx = coord(frame.x((segment.fromTurn + segment.toTurn) / 2));
  const cy = coord(frame.plotTop - 16);
  return `<g class="segment-badge" data-segment="${segment.index}" tabindex="0" role="button" aria-label="Section ${segment.index}, turns ${segment.fromTurn}–${segment.toTurn}: hover for messages"><circle cx="${cx}" cy="${cy}" r="8" fill="#ffffff" stroke="#9e9e9e" stroke-width="1"/><text x="${cx}" y="${coord(cy + 3.5)}" text-anchor="middle" font-size="10" fill="#616161">?</text></g>`;
}

/**
 * The popover body for one segment: subheading + every Turn's messages
 * (same preview format as the segment table below the chart).
 */
function renderSegmentPopover(segment: ThreadReport['segments'][number]): string {
  const turnLines = segment.turns.map((turn) => renderTurnLines(turn)).join('');
  return (
    `<div class="segment-popover" id="segment-pop-${segment.index}" role="tooltip" hidden>` +
    `<div class="segment-popover-title">Section ${segment.index} — turns ${segment.fromTurn}–${segment.toTurn}` +
    `${segment.boundaryTurnNumber === null ? '' : ` · boundary turn ${segment.boundaryTurnNumber}`}` +
    `</div>${turnLines}</div>`
  );
}

/**
 * Drift series polylines. Anchor distance draws solid; Segment drift
 * draws with a dash pattern so coincident stretches stay individually
 * legible instead of overpainting each other; the prospective gate view
 * is deliberately thin against the thick recorded fold series.
 */
function driftSeriesElement(
  className: string,
  color: string,
  points: Array<{ turnNumber: number; value: number }>,
  plane: DriftPlane,
  dashArray?: string,
  strokeWidth = 1.75,
): string {
  if (points.length === 0) return '';
  const dash = dashArray ? ` stroke-dasharray="${dashArray}"` : '';
  return (
    `<polyline class="${className}" points="${polyline(points, plane.x, plane.driftY)}" ` +
    `fill="none" stroke="${color}"${dash} stroke-width="${strokeWidth}" stroke-linejoin="round"/>`
  );
}

/** Hover targets for charted drift points (SVG-native `<title>` tooltips). */
function driftPointMarkers(
  points: Array<{ turnNumber: number; value: number }>,
  plane: DriftPlane,
  className: string,
  color: string,
  radius: number,
  tooltip: (point: { turnNumber: number; value: number }) => string,
): string {
  return points
    .map((point) => {
      const cx = plane.x(point.turnNumber);
      const cy = plane.driftY(point.value);
      return (
        `<circle class="${className}" cx="${cx}" cy="${cy}" r="${radius}" fill="${color}">` +
        `<title>${escapeHtml(tooltip(point))}</title></circle>`
      );
    })
    .join('');
}

/**
 * Verdict markers on the live gate series: fire = filled dot (plus the
 * vertical mark), pass = faint dot; muted Turns carry no point. Tooltip
 * carries the verdict language verbatim and names which reading fed the
 * signal so a chart alone tells the row's story.
 */
type MarkerShape = {
  className: string;
  radius: number;
  fill: string;
  stroke?: string;
  opacity?: number;
};

const VERDICT_MARKER: Record<GateVerdict, MarkerShape> = {
  fire: { className: 'gate-point-fire', radius: 3, fill: '#6a1b9a' },
  pass: { className: 'gate-point-pass', radius: 1.6, fill: '#6a1b9a', opacity: 0.6 },
  muted: { className: 'gate-point-pass', radius: 1.6, fill: '#6a1b9a', opacity: 0.6 },
};

/**
 * Drift-point tooltip on the offline fold series: the Turn's recorded
 * Segment drift plus its two-channel judgment trail when one exists —
 * the criterion that judged it (with the z once the ledger could
 * standardize), the channel that cut a Boundary turn, and the patrol's
 * own reading when it consumed the step.
 */
/** Type guard: a DriftPoint whose recorded Segment drift is present. */
function hasJudgedDrift(point: DriftPoint): point is DriftPoint & { segmentDrift: number } {
  return point.segmentDrift !== null;
}

function driftPointTooltip(point: DriftPoint & { segmentDrift: number }): string {
  const base = `Turn ${point.turnNumber} — recorded Segment drift ${point.segmentDrift.toFixed(3)}`;
  if (point.immediateThreshold === undefined) return base;
  const boundary = point.isBoundary
    ? ` — Boundary turn (fired by the ${point.fireChannel === 'slow' ? 'slow' : 'immediate'} channel)`
    : '';
  const z =
    point.immediateZ === undefined
      ? `${base}${boundary} · criterion ${point.immediateThreshold.toFixed(3)} (bootstrap — the constant stands in until the ledger holds 2 accepted members)`
      : `${base}${boundary} · criterion ${point.immediateThreshold.toFixed(3)} (z ${point.immediateZ.toFixed(2)})`;
  const patrol =
    point.gateMean === undefined || point.gateRise === undefined
      ? ''
      : ` · patrol baseline ${point.gateMean.toFixed(3)} · accumulated rise ${point.gateRise.toFixed(3)}`;
  return z + patrol;
}

/**
 * Names the reading that fed the verdict signal: the
 * rewritten user message with its audit text, or the raw fallback with
 * its skip reason. It is empty when expansion ran not.
 */
function sourceSuffix(point: GateReplayPoint): string {
  if (point.driftPSource === 'rewritten' && point.expandedText) {
    const short = point.expandedText.slice(0, 90);
    const ellipsis = point.expandedText.length > 90 ? '…' : '';
    return ` · reading: rewritten user message “${short}${ellipsis}”`;
  }
  if (point.driftPSource === 'raw-fallback') {
    const note = point.expansionNote ? ` — ${point.expansionNote}` : '';
    return ` · reading: raw message (fallback${note})`;
  }
  return '';
}

/**
 * The slow patrol's own reading at this sample, when it rode one — the
 * detector's mean of the raw drift steps it has consumed and the
 * accumulated rise above low water, both in drift units.
 */
function patrolSuffix(point: GateReplayPoint, lambda?: number): string {
  if (point.gateMean === undefined || point.gateRise === undefined) return '';
  const budget = lambda === undefined ? '' : ` (fires at λ ${lambda.toFixed(2)}, drift units)`;
  return ` · patrol baseline ${point.gateMean.toFixed(3)} · accumulated rise ${point.gateRise.toFixed(3)}${budget}`;
}

/**
 * The immediate criterion the reading was judged against — with its z
 * score once the segment ledger is warm enough to standardize; below
 * that the constant T_segment stands in alone.
 */
function criterionSuffix(point: GateReplayPoint): string {
  if (point.immediateThreshold === undefined) return '';
  if (point.immediateZ === undefined) {
    return ` · criterion ${point.immediateThreshold.toFixed(3)} (bootstrap — the constant stands in until the ledger holds 2 accepted members)`;
  }
  return ` · criterion ${point.immediateThreshold.toFixed(3)} (z ${point.immediateZ.toFixed(2)})`;
}

function gatePointTooltip(
  point: GateReplayPoint & { driftPGated: number },
  lambda?: number,
): string {
  const channelSuffix =
    point.fireChannel === undefined ? '' : ` · fired by the ${point.fireChannel} channel`;
  return `Turn ${point.turnNumber} — drift_p ${point.driftPGated.toFixed(3)} · Anchor ${point.anchorDistance.toFixed(3)} — verdict: ${point.verdict}${patrolSuffix(point, lambda)}${criterionSuffix(point)}${channelSuffix}${sourceSuffix(point)}`;
}

function gatePointMarkers(
  points: Array<GateReplayPoint & { driftPGated: number }>,
  plane: DriftPlane,
  lambda?: number,
): string {
  return points
    .map((point) => {
      const cx = plane.x(point.turnNumber);
      const cy = plane.driftY(point.driftPGated);
      const shape = VERDICT_MARKER[point.verdict];
      const stroke = shape.stroke ? ` stroke="${shape.stroke}" stroke-width="1.5"` : '';
      const opacity = shape.opacity !== undefined ? ` opacity="${shape.opacity}"` : '';
      return (
        `<circle class="${shape.className}" cx="${cx}" cy="${cy}" r="${shape.radius}" ` +
        `fill="${shape.fill}"${stroke}${opacity}><title>${escapeHtml(gatePointTooltip(point, lambda))}</title></circle>`
      );
    })
    .join('');
}

function thresholdLine(
  frame: OfflineFrame,
  threshold: number,
  label: string,
  color = '#757575',
): string {
  const y = frame.driftY(threshold);
  return `<g class="threshold-line"><line x1="${frame.plotLeft}" y1="${y}" x2="${frame.plotRight}" y2="${y}" stroke="${color}" stroke-width="1" stroke-dasharray="6 4"/><text x="${frame.plotRight - 4}" y="${coord(y - 4)}" text-anchor="end" font-size="10" fill="${color}">${escapeHtml(label)} ${threshold.toFixed(2)}</text></g>`;
}

function renderGridAndAxes(frame: OfflineFrame): string {
  const parts: string[] = [];
  const divisions = 4;
  for (let i = 0; i <= divisions; i += 1) {
    const fraction = i / divisions;
    const y = coord(frame.plotBottom - fraction * (frame.plotBottom - frame.plotTop));
    parts.push(
      `<line x1="${frame.plotLeft}" y1="${y}" x2="${frame.plotRight}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      // Left axis: cost (USD). Right axis: drift.
      `<text x="${frame.plotLeft - 6}" y="${coord(y + 3)}" text-anchor="end" ` +
        `font-size="10" fill="#616161">${formatUsd(frame.costMax * fraction)}</text>`,
      `<text x="${frame.plotRight + 6}" y="${coord(y + 3)}" text-anchor="start" ` +
        `font-size="10" fill="#616161">${(frame.driftMax * fraction).toFixed(2)}</text>`,
    );
  }
  // X ticks on the shared turn-number axis.
  for (const tick of xTicks(frame.turnCount)) {
    const x = frame.x(tick);
    parts.push(
      `<line x1="${x}" y1="${frame.plotBottom}" x2="${x}" y2="${frame.plotBottom + 4}" stroke="#9e9e9e" stroke-width="1"/>`,
      `<text x="${x}" y="${frame.plotBottom + 16}" text-anchor="middle" ` +
        `font-size="10" fill="#616161">${tick}</text>`,
    );
  }
  // Frame + axis titles.
  parts.push(
    `<rect x="${frame.plotLeft}" y="${frame.plotTop}" width="${frame.plotRight - frame.plotLeft}" height="${frame.plotBottom - frame.plotTop}" fill="none" stroke="#9e9e9e" stroke-width="1"/>`,
    `<text x="${coord((frame.plotLeft + frame.plotRight) / 2)}" y="${frame.plotBottom + 34}" text-anchor="middle" font-size="11" fill="#424242">turn number</text>`,
    `<text x="${coord(frame.plotLeft - 64)}" y="${coord((frame.plotTop + frame.plotBottom) / 2)}" text-anchor="middle" font-size="11" fill="#424242" transform="rotate(-90 ${coord(frame.plotLeft - 64)} ${coord((frame.plotTop + frame.plotBottom) / 2)})">cost (USD)</text>`,
    `<text x="${coord(frame.plotRight + 52)}" y="${coord((frame.plotTop + frame.plotBottom) / 2)}" text-anchor="middle" font-size="11" fill="#424242" transform="rotate(90 ${coord(frame.plotRight + 52)} ${coord((frame.plotTop + frame.plotBottom) / 2)})">drift</text>`,
  );
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* Chart controls + legends (one set per chart)                        */
/* ------------------------------------------------------------------ */

interface LegendEntry {
  color: string;
  label: string;
  bar?: boolean;
  /** Inline style overrides on the swatch (line thickness, hollow dot). */
  style?: string;
}

interface ToggleEntry {
  series: string;
  label: string;
  /** Present in the report → the checkbox renders at all. */
  available: boolean;
}

/** Which offline-chart toggle groups exist for this report, in display order. */
function offlineToggleEntries(report: ThreadReport): ToggleEntry[] {
  const drift = report.driftSeries.length > 0;
  return [
    { series: 'cost', label: 'Cost', available: report.costProfile.length > 0 },
    { series: 'anchor', label: 'Anchor wander', available: drift },
    { series: 'segments', label: 'Segment drift (offline)', available: drift },
    {
      series: 'boundary',
      label: 'Boundary marks',
      available: report.driftSeries.some((point) => point.isBoundary),
    },
    { series: 'badges', label: 'Section ?-marks', available: report.segments.length > 0 },
    {
      series: 'counsel',
      label: 'Slow drift counsel marks',
      available: report.anchor.counsel.length > 0,
    },
  ];
}

/** Which live-chart toggle groups exist for this report, in display order. */
function liveToggleEntries(report: ThreadReport): ToggleEntry[] {
  const points = report.gateReplay?.points ?? [];
  return [
    {
      series: 'prospective',
      label: 'drift_p — arrival drift (verdict signal)',
      available: points.some((point) => point.driftPGated !== null),
    },
    { series: 'fires', label: 'Gate fire marks', available: points.length > 0 },
    {
      series: 'raw',
      label: 'drift_p on the raw message (audit)',
      available: points.some((point) => point.driftPSource !== undefined),
    },
  ];
}

/** One chart's checkbox row; the inline script scopes it to its block. */
function renderChartControls(entries: ToggleEntry[], chartBlock: string): string {
  if (entries.every((entry) => !entry.available)) return '';
  const checkboxes = entries
    .filter((entry) => entry.available)
    .map(
      (entry) =>
        `<label><input type="checkbox" data-series="${entry.series}" checked>${entry.label}</label>`,
    )
    .join('');
  return `<div class="chart-controls" data-controls="${chartBlock}">${checkboxes}</div>`;
}

/**
 * The report's inline script: per-chart series visibility (each control
 * row toggles only its own chart's data-toggle groups) and the
 * segment-badge popovers below the offline chart. Zero external
 * references — every datum it needs is already in the document.
 */
function renderToggleScript(): string {
  return `<script>
(function () {
  var apply = function (controls) {
    var block = document.querySelector('[data-chart-block="' + controls.dataset.controls + '"]');
    if (!block) return;
    controls.querySelectorAll('input[data-series]').forEach(function (input) {
      var series = input.dataset.series;
      var on = input.checked;
      block.querySelectorAll('[data-toggle="' + series + '"]').forEach(function (el) {
        el.style.display = on ? '' : 'none';
      });
    });
  };
  document.querySelectorAll('.chart-controls[data-controls]').forEach(function (controls) {
    controls.querySelectorAll('input[data-series]').forEach(function (input) {
      input.addEventListener('change', function () { apply(controls); });
    });
    apply(controls);
  });

  // Segment badges (offline chart): hover (or keyboard focus) pops the
  // segment's messages; moving onto the popover keeps it open.
  var wrap =
    document.querySelector('[data-chart-block="offline"] .chart-wrap') ||
    document.querySelector('.chart-wrap');
  document.querySelectorAll('.segment-badge').forEach(function (badge) {
    var pop = document.getElementById('segment-pop-' + badge.dataset.segment);
    if (!pop || !wrap) return;
    var show = function () {
      var r = badge.getBoundingClientRect();
      var w = wrap.getBoundingClientRect();
      pop.hidden = false;
      var left = Math.max(8, Math.min(r.left - w.left + r.width / 2 - 180, w.width - 400));
      pop.style.left = left + 'px';
      pop.style.top = (r.bottom - w.top + 6) + 'px';
    };
    var hide = function () {
      window.setTimeout(function () {
        if (pop.matches(':hover') || badge.matches(':hover') || badge.matches(':focus')) return;
        pop.hidden = true;
      }, 120);
    };
    badge.addEventListener('mouseenter', show);
    badge.addEventListener('mouseleave', hide);
    badge.addEventListener('focus', show);
    badge.addEventListener('blur', hide);
    pop.addEventListener('mouseleave', function () { pop.hidden = true; });
  });
})();
</script>`;
}

function legendItems(entries: LegendEntry[]): string {
  return entries
    .map((entry) => {
      const swatch = entry.bar
        ? `<span class="swatch swatch-bar" style="background:${entry.color}"></span>`
        : `<span class="swatch" style="background:${entry.color}${entry.style ? `;${entry.style}` : ''}"></span>`;
      return `<li>${swatch}${escapeHtml(entry.label)}</li>`;
    })
    .join('');
}

/** The offline chart's legend + fold note. */
function renderOfflineLegend(report: ThreadReport, hasLiveChart: boolean): string {
  const hasDrift = report.driftSeries.length > 0;
  const hasCounsel = report.anchor.counsel.length > 0;
  const entries: LegendEntry[] = [
    { color: '#a5d6a7', label: 'marginal cost (per turn)', bar: true },
    { color: '#2e7d32', label: 'running total cost' },
    ...(hasDrift
      ? [
          { color: '#1565c0', label: 'Anchor wander (opening-topic gauge)' },
          {
            color: '#ef6c00',
            label: 'Segment drift — recorded by the fold (thick)',
            style: 'width:18px;height:4.5px',
          },
        ]
      : []),
    ...(hasCounsel
      ? [
          {
            color: '#ffffff',
            label:
              'Slow-drift counsel — sustained Anchor-wander rise (ring on the blue series; advisory)',
            style:
              'width:9px;height:9px;border:1.5px solid #1565c0;border-radius:50%;background:transparent',
          },
        ]
      : []),
    { color: '#c62828', label: 'Boundary turn' },
    {
      color: '#ef6c00',
      label: 'segment threshold — the bootstrap prior T_segment (flat only while the ledger warms)',
    },
  ];
  const followUp = hasLiveChart
    ? ' The live gate’s view of the same thread — arrivals on the prospective reading against the same per-segment trigger — lives in its own chart below.'
    : '';
  const laneNote = hasDrift
    ? `<p class="lane-note"><strong>Offline fold.</strong> Every Turn is scored once, after it completes, on the full Turn vector including the assistant reply — the SAME two-channel verdict the live gate runs, just on the complete-turn reading. A Turn is judged against its segment's OWN state: the arrival's distance from the rolling Gravity point, standardized against the segment's noise ledger (μ, σ with the σ_floor) — the flat orange line drawn here is only the bootstrap prior, in force while the ledger holds fewer than 2 accepted members. A fire from either channel is a Boundary Turn: immediate (the reading cleared the segment's level) or slow (the Page–Hinkley patrol accumulated a λ-budgeted sustained rise); the cut shreds the ledger and the rejected Turn seeds the next segment but joins no ledger. The Anchor IS Segment 1 — the opening segment's own members, frozen at its cut — so Anchor wander measures the thread's flight from its pure opening topic; it replays from Turn 1 and stays advisory: no threshold, no vote. The fold's own counsel rows (sustained rise in this wander series) are the rings on the blue series.${followUp}</p>`
    : '';
  return `<ul class="legend">${legendItems(entries)}</ul>${laneNote}`;
}

/** The live chart's legend + reading guide. */
function renderLiveLegend(report: ThreadReport): string {
  const hasRawLane =
    report.gateReplay?.points.some((point) => point.driftPSource !== undefined) ?? false;
  const entries: LegendEntry[] = [
    {
      color: '#6a1b9a',
      label:
        'drift_p — the arrival reading the gate judged (rewrite when one landed, raw fallback; thin)',
      style: 'width:18px;height:2px',
    },
    {
      color: '#6a1b9a',
      label:
        "live trigger — each live segment's threshold: flat T_segment while the ledger warms (dashed lead-in = standing default during the cold-start mute), learned μ + k·max(σ, σ_floor) once it speaks, reset to T_segment on every fired Turn (the fired Turn opens the next segment)",
      style: 'width:18px;height:3.5px',
    },
    {
      color: '#6a1b9a',
      label:
        'z reading — the same arrival standardised onto its own segment (bottom panel; fires at z ≥ k)',
    },
    { color: '#6a1b9a', label: 'Gate fire (vertical band; channel named in tooltip)' },
    ...(hasRawLane
      ? [
          {
            color: '#9e9e9e',
            label: 'drift_p on the raw message as received (audit, dotted)',
            style: 'width:18px;height:2px',
          },
        ]
      : []),
  ];
  const laneNote =
    `<p class="lane-note"><strong>Live gate — two scales of the same arrivals.</strong> ` +
    `<em>Top panel (drift units).</em> The thin purple line is drift_p: the arriving message's drift exactly as measured, before any standardisation — the expansion tier's decontextualised rewrite when one landed, else the raw message. The bold solid line is the <em>live trigger</em>: each live segment's threshold, drawn as the segment's <em>state</em> — flat at T_segment while its ledger warms (fewer than 2 accepted members), stepping up to μ + k·max(σ, σ_floor) <em>inside its own segment</em> the moment the ledger learns. When a fired Turn shreds the ledger, the reset to T_segment lands on the boundary Turn itself (boundary turns belong to the segment they start); the level reaching into a boundary Turn is the CLOSING segment's final criterion, which is exactly why a fired reading is seen to cross it before the drop. Hover the dashed lead-in (the standing default through the cold-start mute), any slab or marker for the exact state; markers carry their live segment number. ` +
    `<em>Bottom panel (z units).</em> The same arrivals re-expressed as z = (reading − μ) / max(σ, σ_floor) against their own segment's ledger: the segment-local trigger is the flat line at z = k, and the dashed z = 0 line is the segment mean. Arrivals judged during bootstrap have no μ/σ yet and therefore no z point — the flat T_segment judged them raw on top. Purple bands mark fired Turns; each point's tooltip names the channel that fired it (immediate: the reading cleared the segment's criterion; slow: the accumulated Page–Hinkley rise reached λ in drift units).</p>`;
  return `<ul class="legend">${legendItems(entries)}</ul>${laneNote}`;
}

/* ------------------------------------------------------------------ */
/* HTML document                                                       */
/* ------------------------------------------------------------------ */

function renderMeta(report: ThreadReport): string {
  const { params, totals } = report;
  const gate = params.gateReplay;
  const entries: Array<[string, string]> = [
    ['Thread', `${escapeHtml(report.title || '(untitled)')} · ${escapeHtml(report.threadId)}`],
    ['Generated', escapeHtml(report.generatedAt)],
    ['Segment threshold (T_segment, bootstrap prior)', String(params.segmentThreshold)],
    ['Immediate k (z ≥ k)', String(params.immediateK)],
    ['σ floor (σ_floor)', String(params.sigmaFloor)],
    ['Slow patrol λ (drift units)', String(params.lambda)],
    ['Slow patrol δ (drift units)', String(params.delta)],
    ['Slow patrol min samples', String(params.minSamples)],
    ['Cold start (K_gate)', String(params.coldStartTurns)],
    ['Embedding model', escapeHtml(params.embeddingModelId)],
    [
      'Anchor built from turns',
      `${report.anchor.builtFromTurns[0]}–${report.anchor.builtFromTurns[1]}`,
    ],
    ['Turns', String(totals.turns)],
    ['Messages', String(totals.messages)],
    ['Total cost', formatUsd(totals.totalCostUsd)],
    ['Embedding cost (this run)', formatUsd(totals.embeddingCostUsd)],
  ];
  if (gate) {
    entries.push(['EMD Sinkhorn epsilon (ε)', String(gate.sinkhornEpsilon)]);
  }
  const items = entries
    .map(([term, detail]) => `<div><dt>${escapeHtml(term)}</dt><dd>${detail}</dd></div>`)
    .join('');
  return `<dl class="meta">${items}</dl>`;
}

function renderSegmentTable(report: ThreadReport): string {
  const rows = report.segments
    .map(
      (segment) =>
        `<tr class="segment-row"><td>${segment.index}</td><td>${segment.fromTurn}–${segment.toTurn}</td><td>${segment.boundaryTurnNumber === null ? '—' : String(segment.boundaryTurnNumber)}</td><td class="segment-messages">${segment.turns.map((turn) => renderTurnLines(turn)).join('')}</td></tr>`,
    )
    .join('\n');
  return `<table class="segments"><thead><tr><th>#</th><th>Turns</th><th>Boundary turn</th><th>Messages</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

/** A message line in the segment table stays one visual line. */
const MESSAGE_PREVIEW_LIMIT = 110;

/** One-line preview of a message: whitespace collapses to single spaces. */
function previewLine(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim();
  return collapsed.length > MESSAGE_PREVIEW_LIMIT
    ? `${collapsed.slice(0, MESSAGE_PREVIEW_LIMIT)}…`
    : collapsed;
}

/**
 * Every message of one Turn: the user message always, the assistant reply
 * when present. The report's JSON sidecar carries the full texts.
 */
function renderTurnLines(turn: TopicSegmentTurn): string {
  const lines = [
    `<div class="turn-line"><span class="turn-line-from">T${turn.turnNumber} user:</span>${escapeHtml(previewLine(turn.userContent))}</div>`,
  ];
  if (turn.assistantContent !== null) {
    lines.push(
      `<div class="turn-line"><span class="turn-line-from">T${turn.turnNumber} assistant:</span>${escapeHtml(previewLine(turn.assistantContent))}</div>`,
    );
  }
  return lines.join('');
}

/* ------------------------------------------------------------------ */
/* Gate replay section                                    */
/* ------------------------------------------------------------------ */

const VERDICT_LABEL: Record<GateVerdict, string> = {
  muted: 'muted (cold start)',
  pass: 'pass',
  fire: 'fire — pause before this Turn',
};

/**
 * The gate table's verdict-signal cell: drift_p as the gate
 * actually sees it — the rewritten Prospective when the expansion tier
 * landed one, the raw reading as fallback — with its audit-trail tooltip
 * (source + rewritten text, or the skip reason). Empty when the column
 * is absent (off replays stay byte-identical to the task).
 */
function gatedCell(point: GateReplayPoint, hasExpanded: boolean): string {
  if (!hasExpanded) return '';
  const cellTitle =
    point.driftPSource === 'rewritten'
      ? `verdict signal: rewritten user message${point.expandedText ? ` — “${point.expandedText}”` : ''}`
      : `verdict signal: raw message fallback${point.expansionNote ? ` (${point.expansionNote})` : ''}`;
  return `<td title="${escapeHtml(cellTitle)}">${point.driftPGated === null ? '—' : point.driftPGated.toFixed(3)}</td>`;
}

/**
 * The gate table's rewrite column: the decontextualised
 * message itself — what the expanded drift actually embeds. Truncated for
 * width; the full text rides the tooltip. Empty when the column is absent.
 */
function expandedRewriteCell(point: GateReplayPoint, hasExpanded: boolean): string {
  if (!hasExpanded) return '';
  if (point.expandedText === undefined) return '<td>—</td>';
  const short =
    point.expandedText.length > 48 ? `${point.expandedText.slice(0, 48)}…` : point.expandedText;
  return `<td title="${escapeHtml(point.expandedText)}">${escapeHtml(short)}</td>`;
}

/** One Turn's messages carried by the gate replay table — mirrors TopicSegmentTurn. */
export interface GateReplayTurn {
  turnNumber: number;
  userContent: string;
  assistantContent: string | null;
}

function renderGateTable(points: GateReplayPoint[], turns: GateReplayTurn[]): string {
  // The expansion columns appear only on expansion runs — off replays
  // render byte-identical to the task.
  const hasExpanded = points.some((point) => point.driftPSource !== undefined);
  const gatedHeader = hasExpanded
    ? '<th title="The signal the gate judges: drift on the rewritten message when a rewrite landed, else the raw fallback. Hover the number for its provenance.">drift_p (verdict)</th>'
    : '';
  const rewriteHeader = hasExpanded
    ? '<th title="The exact decontextualised text the verdict drift embeds (truncated here; full text on hover). Blank where no rewrite landed.">rewritten user message (the expanded embed)</th>'
    : '';
  const anchorHead = hasExpanded
    ? `<th title="How far the arrival wanders from the thread's opening topic (the Anchor). Advisory only — it never drives a verdict.">Anchor distance</th>`
    : '<th>Anchor distance</th>';
  const turnByNumber = new Map(turns.map((turn) => [turn.turnNumber, turn]));
  const rows = points
    .map((point) => {
      const gatedCellHtml = gatedCell(point, hasExpanded);
      const rewriteCellHtml = expandedRewriteCell(point, hasExpanded);
      const turn = turnByNumber.get(point.turnNumber);
      const messagesCell = turn
        ? `<td class="segment-messages">${renderTurnLines({ turnNumber: turn.turnNumber, userContent: turn.userContent, assistantContent: turn.assistantContent })}</td>`
        : '<td>—</td>';
      return (
        `<tr class="gate-point${point.verdict === 'fire' ? ' gate-point-fire' : ''}">` +
        `<td>${point.turnNumber}</td><td>${point.messageIndex}</td>` +
        `<td>${point.driftP === null ? '—' : point.driftP.toFixed(3)}</td>${gatedCellHtml}${rewriteCellHtml}` +
        `<td>${point.anchorDistance.toFixed(3)}</td>` +
        `${messagesCell}` +
        `<td><span class="verdict verdict-${point.verdict}">${escapeHtml(VERDICT_LABEL[point.verdict])}</span></td></tr>`
      );
    })
    .join('\n');
  const baseHeaders = hasExpanded
    ? `<th title="The Turn being measured (your message arriving; the reply is folded in when the Turn completes).">Turn</th><th title="The global index of the message across the thread, for cross-referencing raw data.">Msg #</th><th title="Drift of the arriving message exactly as it came in, against the segment baseline — the measurement lane. It never alone decides a verdict.">drift_p (raw)</th>${gatedHeader}${rewriteHeader}${anchorHead}`
    : '<th>Turn</th><th>Msg #</th><th>drift_p (raw)</th><th>Anchor distance</th>';
  return `<table class="segments gate"><thead><tr>${baseHeaders}<th title="The messages in this Turn (user + assistant reply when present).">Messages</th><th title="The outcome for the Turn: muted (cold start, not yet observed), pass, fire (pause before this Turn) — the segment-local two-channel verdict.">Gate verdict</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

const DIVERGENCE_LABEL: Record<string, string> = {
  gate_fired_fold_quiet: 'gate fired, fold found no boundary',
  fold_cut_gate_quiet: 'fold cut a boundary, gate stayed quiet',
};

function renderDivergenceRows(report: ThreadReport): string {
  const gate = report.gateReplay;
  if (!gate) return '';

  // Flatten all turns from segments into a lookup by turnNumber for the gate table
  const allTurns: GateReplayTurn[] = [];
  for (const segment of report.segments) {
    for (const turn of segment.turns) {
      allTurns.push({
        turnNumber: turn.turnNumber,
        userContent: turn.userContent,
        assistantContent: turn.assistantContent,
      });
    }
  }

  const divergenceSection =
    gate.divergences.length === 0
      ? '<p class="empty">No gate/fold divergences on this replay.</p>'
      : `<ul class="divergences">${gate.divergences
          .map(
            (row) =>
              `<li>Turn ${row.turnNumber}: ${escapeHtml(DIVERGENCE_LABEL[row.kind] ?? row.kind)}</li>`,
          )
          .join('')}</ul>`;
  const counselSection =
    gate.anchorCounsel.length === 0
      ? '<p class="empty">No Anchor-wander counsel on the prospective side: no sustained rise recorded.</p>'
      : `<ul class="divergences">${gate.anchorCounsel
          .map(
            (row) =>
              `<li>Turn ${row.turnNumber}: the thread has gone somewhere (prospective wander ${row.anchorDistance.toFixed(3)}) — advisory only</li>`,
          )
          .join('')}</ul>`;
  const hasExpanded = gate.points.some((point) => point.driftPSource !== undefined);
  const expansionNote = hasExpanded
    ? '<p class="gate-note">Expansion pipeline active: the drift_p (verdict) column is the live signal — the recomposed user message for ambiguous Turns, the raw message where no rewrite landed (falls back explained via expansion note); the drift_p (raw) column keeps the arrival-time reading for inspection.</p>\n'
    : '';
  const readingGuide = hasExpanded
    ? '<p class="gate-note"><strong>Reading the table.</strong> Each row is one Turn&#39;s arrival-time measurement, not its history. <em>drift_p (raw)</em> is how the message looked as it arrived — a measurement; it never fires the gate by itself. <em>drift_p (verdict)</em> is what the gate judges: drift on the rewritten (decontextualised) message when a rewrite landed, on the raw message otherwise. <em>Anchor distance</em> is distance from the thread&#39;s opening topic — advisory only. The outcome in <em>Gate verdict</em> comes from the segment-local criterion in the chart (the live trigger line), not from the raw drift alone: a large raw drift can pass when its segment accepts large steps, and a modest one can fire when the segment has learned a tight band.</p>\n'
    : '';
  return `<p class="gate-note">Pretend replay: every stored user message scored as a Prospective Turn through the live-gate logic — the SAME two-channel verdict the offline fold runs; only the reading differs (user-only message vs the complete exchange). Advisory only — the fold stays authoritative, and with identical judging logic a divergence row can only come from that reading difference: calibration data, not failures. The fold's own Anchor-wander counsel carries this report's slow signal on the offline chart; the rows below are the prospective side's.</p>
${expansionNote}${readingGuide}${renderGateTable(gate.points, allTurns)}
<h3>Gate/fold divergences</h3>
${divergenceSection}
<h3>Anchor-wander counsel</h3>
${counselSection}`;
}

/** EMD numbers keep 3 decimals — distances on the cosine scale. */
function formatW(value: number): string {
  return value.toFixed(3);
}

function renderEmdSection(report: ThreadReport): string {
  const gate = report.gateReplay;
  if (!gate) return '';
  const { emd } = gate;
  if (emd.pairs.length === 0) {
    return '<p class="empty">No EMD pairs: fewer than two Topic segments in this thread.</p>';
  }
  const revisitPairs = new Set(emd.revisits.map((row) => `${row.fromSegment}-${row.toSegment}`));
  const pairRows = emd.pairs
    .map((pair) => {
      const revisits = revisitPairs.has(`${pair.fromSegment}-${pair.toSegment}`);
      return `<tr${revisits ? ' class="emd-revisit"' : ''}><td>Section ${pair.fromSegment}</td><td>Section ${pair.toSegment}</td><td>${formatW(pair.w)}</td><td>${revisits ? `<strong>Section ${pair.toSegment} revisits Section ${pair.fromSegment}</strong>` : '—'}</td></tr>`;
    })
    .join('\n');
  const baselineLine =
    emd.tauMerge === null
      ? '<p class="empty">No revisit baseline: no segment holds 2+ members to split.</p>'
      : `<p class="emd-baseline">Baseline τ_merge = ${formatW(emd.tauMerge)} — the widest same-segment half split:${emd.halves
          .map((row) => ` Section ${row.segmentIndex} halves ${formatW(row.w)}`)
          .join(
            ',',
          )}. Pairs closer than the thread’s own baseline read as topic revisits; merging is never this layer’s job.</p>`;
  return `${baselineLine}
<table class="segments emd"><thead><tr><th>From</th><th>To</th><th>W (Sinkhorn-EMD)</th><th>Revisit</th></tr></thead><tbody>
${pairRows}
</tbody></table>`;
}

const STYLES = `
      :root { color-scheme: light; }
      body {
        margin: 0; padding: 2rem clamp(1rem, 4vw, 3rem);
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        color: #212121; background: #fafafa;
      }
      header h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
      header .subtitle { margin: 0; color: #616161; font-size: 0.9rem; }
      dl.meta {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 0.5rem 1.5rem; margin: 1.25rem 0; padding: 1rem 1.25rem;
        background: #fff; border: 1px solid #e0e0e0; border-radius: 6px;
      }
      dl.meta div { display: flex; flex-direction: column; }
      dl.meta dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #757575; }
      dl.meta dd { margin: 0.1rem 0 0; font-size: 0.9rem; word-break: break-word; }
      section { margin: 2rem 0; }
      section h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
      /* The chart owns the full width; everything else stacks below it. */
      .block-chart { max-width: 1200px; }
      .chart-wrap { position: relative; }
      .chart { width: 100%; height: auto; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
      .chart-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.9rem; margin: 0 0 0.5rem; font-size: 0.8rem; }
      .chart-controls label { display: flex; align-items: center; gap: 0.25rem; cursor: pointer; white-space: nowrap; }
      .segment-badge { cursor: pointer; outline-offset: 2px; }
      .segment-badge:hover circle, .segment-badge:focus circle { stroke: #6a1b9a; fill: #f3e5f5; }
      .segment-popover { position: absolute; z-index: 10; width: 360px; max-height: 280px; overflow: auto; padding: 0.6rem 0.75rem; background: #fff; border: 1px solid #bdbdbd; border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14); font-size: 0.8rem; }
      .segment-popover-title { font-weight: 600; margin-bottom: 0.4rem; color: #424242; }
      ul.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; padding: 0.75rem 0 0; margin: 0; font-size: 0.8rem; }
      ul.legend li { display: flex; align-items: center; }
      .lane-note { margin: 0.5rem 0 0; font-size: 0.8rem; color: #424242; line-height: 1.5; max-width: 72rem; }
      .lane-note em { font-style: normal; font-weight: 600; }
      .swatch { display: inline-block; width: 14px; height: 3px; margin-right: 0.4rem; border-radius: 1px; }
      .swatch-bar { height: 10px; width: 6px; }
      table.segments { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; font-size: 0.85rem; table-layout: fixed; }
      table.segments th, table.segments td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eeeeee; vertical-align: top; }
      table.segments th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #757575; }
      table.segments th:nth-child(1), table.segments td:nth-child(1) { width: 3rem; }
      table.segments th:nth-child(2), table.segments td:nth-child(2) { width: 8rem; }
      table.segments th:nth-child(3), table.segments td:nth-child(3) { width: 8rem; }
      .segment-messages { overflow-wrap: anywhere; }
      .turn-line { margin: 0.1rem 0 0.45rem; }
      .turn-line:last-child { margin-bottom: 0.1rem; }
      .turn-line-from { font-size: 0.72rem; letter-spacing: 0.03em; color: #757575; margin-right: 0.4rem; white-space: nowrap; }
      .empty { color: #616161; font-style: italic; }
      h3 { font-size: 0.95rem; margin: 1.25rem 0 0.5rem; }
      .gate-note { color: #616161; font-size: 0.85rem; margin: 0 0 0.75rem; }
      .verdict { font-size: 0.8rem; }
      .verdict-fire { color: #6a1b9a; font-weight: 600; }
      .verdict-muted { color: #9e9e9e; }
      .gate-point-fire td { background: #f3e5f5; }
      ul.divergences { margin: 0; padding-left: 1.25rem; font-size: 0.85rem; }
      ul.divergences li { margin: 0.15rem 0; }
      .emd-baseline { font-size: 0.85rem; margin: 0 0 0.75rem; color: #424242; }
      .emd-revisit td { background: #f3e5f5; }
      /* Gate table column widths — mirrors the Topic segments table layout. */
      table.segments.gate th:nth-child(1), table.segments.gate td:nth-child(1) { width: 3rem; }
      table.segments.gate th:nth-child(2), table.segments.gate td:nth-child(2) { width: 5rem; }
      table.segments.gate th:nth-child(3), table.segments.gate td:nth-child(3) { width: 6rem; }
      table.segments.gate th:nth-child(4), table.segments.gate td:nth-child(4) { width: 7rem; }
      table.segments.gate th:nth-child(5), table.segments.gate td:nth-child(5) { width: 18rem; }
      table.segments.gate th:nth-child(6), table.segments.gate td:nth-child(6) { width: 6rem; }
      table.segments.gate th:nth-child(7), table.segments.gate td:nth-child(7) { width: 30%; }
      table.segments.gate th:nth-child(8), table.segments.gate td:nth-child(8) { width: 10rem; }
`;

function renderHtml(report: ThreadReport): string {
  const hasDrift = report.driftSeries.length > 0;
  const hasCost = report.costProfile.length > 0;
  const hasGate = report.gateReplay !== undefined && report.gateReplay.points.length > 0;
  const hasOfflineChart = hasDrift || hasCost;
  const hasChart = hasOfflineChart || hasGate;

  const offlineSection = hasOfflineChart
    ? `<section class="block-chart">
<h2>Cost and drift over the thread — offline fold</h2>
${renderChartControls(offlineToggleEntries(report), 'offline')}
<div class="chart-wrap" data-chart-block="offline">
${renderOfflineChart(report)}
${report.segments.map((segment) => renderSegmentPopover(segment)).join('\n')}
</div>
${renderOfflineLegend(report, hasGate)}
</section>`
    : '';
  const liveSection = hasGate
    ? `<section class="block-chart">
<h2>Live gate — arrival drift against the per-segment trigger</h2>
${renderChartControls(liveToggleEntries(report), 'live')}
<div class="chart-wrap" data-chart-block="live">
${renderLiveChart(report)}
</div>
${renderLiveLegend(report)}
</section>`
    : '';
  const chartSections = hasChart
    ? offlineSection + liveSection
    : '<p class="empty">No chart data: the report carries neither cost nor drift points.</p>';

  const segmentsSection =
    report.segments.length > 0
      ? renderSegmentTable(report)
      : '<p class="empty">No topic segments: no Turns were scored.</p>';
  const gateSection = report.gateReplay ? renderDivergenceRows(report) : '';
  const emdSection = report.gateReplay ? renderEmdSection(report) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thread analysis — ${escapeHtml(report.title || report.threadId)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
<h1>Thread analysis</h1>
<p class="subtitle">Replay report for ${escapeHtml(report.title || '(untitled)')} · ${escapeHtml(
    report.threadId,
  )} · generated ${escapeHtml(report.generatedAt)}</p>
${renderMeta(report)}
</header>
${chartSections}
<section>
<h2>Topic segments</h2>
${segmentsSection}
</section>
${
  report.gateReplay
    ? `<section>
<h2>Drift gate — pretend replay</h2>
${gateSection}
</section>
<section>
<h2>EMD revisit matrix — judge layer (advisory)</h2>
${emdSection}
</section>`
    : ''
}
${hasChart ? renderToggleScript() : ''}
</body>
</html>
`;
}
