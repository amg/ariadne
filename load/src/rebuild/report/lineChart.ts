import { MINUTE_MS, instantOf } from '../moments.ts';
import { roundTo } from '../numbers.ts';
import type { Gap } from '../types.ts';
import { escapeHtml } from './escapeHtml.ts';

/** One line of a chart: a figure per minute, and the gaps in the records this line alone is drawn from. */
type ChartLine = {
  label: string;
  values: readonly (number | null)[];
  gaps: readonly Gap[];
};

/** A limit a figure must stay at or under, drawn as a horizontal line. */
type PassLine = { label: string; value: number };

/** A moment marked on the time axis, by the number the report's list of moments gives it. */
type ChartMarker = { at: number; number: number };

export type LineChart = {
  title: string;
  /** What the figures are counted or measured in, written beside the title. */
  unit: string;
  /** Where each minute starts, in milliseconds; each line has one figure per minute. */
  minutes: readonly number[];
  lines: readonly ChartLine[];
  passLine: PassLine | null;
  /** The gaps of every line of the chart, which the chart shades and names. */
  gaps: readonly Gap[];
  markers: readonly ChartMarker[];
  /** Where the minutes after the run's end start, which the chart marks; null when it has none. */
  afterRunFrom: number | null;
};

const WIDTH = 640;
const HEIGHT = 240;
const LEFT = 60;
const RIGHT = 14;
const TOP = 14;
const BOTTOM = 30;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const MAX_TIME_TICKS = 8;
/** Markers closer than this, in the picture's units, share one line and one label. */
const MARKER_SPACING = 16;

/** Distinguishable by people who confuse red and green. */
const COLORS = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9'] as const;
const colorOf = (index: number): string => COLORS[index % COLORS.length] ?? COLORS[0];

const coordinate = (value: number) => String(roundTo(value, 2));

/** The top of the value axis and where its ticks fall: a round step, with the data under the top. */
function valueAxis(highest: number) {
  const wanted = highest > 0 ? highest : 1;
  const rough = wanted / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const size = magnitude * ([1, 2, 2.5, 5].find((factor) => factor * magnitude >= rough) ?? 10);
  // A tick count that lands a hair above a whole number from rounding would add an empty band.
  const count = Math.ceil(wanted / size - 1e-9);
  return {
    top: roundTo(count * size, 6),
    ticks: Array.from({ length: count + 1 }, (_, index) => roundTo(index * size, 6)),
  };
}

/** The minute boundaries to label along the time axis: few enough to read, each on a whole step of minutes. */
function timeTicks(start: number, end: number) {
  const minutes = (end - start) / MINUTE_MS;
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440].find(
    (candidate) => minutes / candidate <= MAX_TIME_TICKS,
  );
  const stepMs = (step ?? 1440) * MINUTE_MS;
  const ticks: number[] = [];
  for (let at = Math.ceil(start / stepMs) * stepMs; at <= end; at += stepMs) ticks.push(at);
  return ticks.length > 0 ? ticks : [start];
}

/** A stretch of time, in milliseconds. */
type Span = { from: number; to: number };

const spanOf = (gap: Gap) => ({ from: Date.parse(gap.from), to: Date.parse(gap.to) });

/** The windows the gaps cover, clipped to the chart and joined where they overlap. */
function shadedSpans(gaps: readonly Gap[], start: number, end: number) {
  const clipped = gaps
    .map(spanOf)
    .map((span) => ({ from: Math.max(start, span.from), to: Math.min(end, span.to) }))
    .filter((span) => span.from <= span.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const joined: Span[] = [];
  for (const span of clipped) {
    const last = joined.at(-1);
    if (last === undefined || span.from > last.to) joined.push({ ...span });
    else last.to = Math.max(last.to, span.to);
  }
  return joined;
}

/** One reading of a line, at the middle of its minute. */
type Reading = { moment: number; value: number };

/** The runs of consecutive readings a line is drawn through. A missing reading, or a gap between two readings, ends a run. */
function runsOf(readings: readonly (Reading | null)[], gaps: readonly Span[]) {
  const runs: Reading[][] = [];
  let previous: Reading | null = null;
  for (const point of readings) {
    const before = previous;
    previous = point;
    if (point === null) continue;
    const run = runs.at(-1);
    const split =
      before === null ||
      run === undefined ||
      gaps.some((gap) => gap.from < point.moment && gap.to > before.moment);
    if (split) runs.push([point]);
    else run.push(point);
  }
  return runs;
}

/** A line drawn at a marked moment: the first of the markers too close to tell apart, labelled with the range of their numbers. */
type MarkedMoment = { at: number; label: string };

/** What a chart shows, decided before it is drawn. */
type ChartLayout = {
  /** Where the chart's time starts and ends, in milliseconds. */
  start: number;
  end: number;
  /** The top of the value axis, which holds every reading and the pass line. */
  valueTop: number;
  valueTicks: readonly number[];
  timeTicks: readonly number[];
  /** The windows shaded as gaps, clipped to the chart and joined where they overlap. */
  shaded: readonly Span[];
  /** The stretch after the run's end, which is marked; null for a chart that has none. */
  afterRun: Span | null;
  /** For each line, the stretches drawn as one stroke; a stretch of a single reading is a dot. */
  strokes: readonly (readonly (readonly Reading[])[])[];
  markers: readonly MarkedMoment[];
  hasReadings: boolean;
};

/**
 * The markers inside the chart's time. Markers closer than the picture can
 * tell apart share the first one's line, labelled with the range of their
 * numbers.
 */
function markedMoments(markers: readonly ChartMarker[], start: number, end: number) {
  const spacingMs = (MARKER_SPACING / PLOT_WIDTH) * (end - start);
  const clusters: ChartMarker[][] = [];
  for (const marker of [...markers].sort((a, b) => a.at - b.at || a.number - b.number)) {
    if (marker.at < start || marker.at > end) continue;
    const last = clusters.at(-1);
    const first = last?.[0];
    if (last !== undefined && first !== undefined && marker.at - first.at < spacingMs) {
      last.push(marker);
    } else {
      clusters.push([marker]);
    }
  }
  return clusters.flatMap((cluster) => {
    const first = cluster[0];
    const last = cluster.at(-1);
    if (first === undefined || last === undefined) return [];
    const label = first === last ? String(first.number) : `${first.number}–${last.number}`;
    return [{ at: first.at, label }];
  });
}

/**
 * What a chart shows: its axes, the gaps it shades, the stretches each
 * line is drawn through and the moments it marks.
 * A line is not drawn through a gap of its own records, nor through a minute with no reading.
 */
export function chartLayout(chart: LineChart): ChartLayout {
  const start = chart.minutes[0] ?? 0;
  const end = (chart.minutes.at(-1) ?? start) + MINUTE_MS;
  const values = chart.lines.flatMap((line) => line.values.flatMap((value) => value ?? []));
  const axis = valueAxis(Math.max(0, chart.passLine?.value ?? 0, ...values));
  return {
    start,
    end,
    valueTop: axis.top,
    valueTicks: axis.ticks,
    timeTicks: timeTicks(start, end),
    shaded: shadedSpans(chart.gaps, start, end),
    afterRun:
      chart.afterRunFrom === null || chart.afterRunFrom >= end
        ? null
        : { from: Math.max(start, chart.afterRunFrom), to: end },
    strokes: chart.lines.map((line) =>
      runsOf(
        line.values.map((value, minute) =>
          value === null ? null : { moment: (chart.minutes[minute] ?? 0) + MINUTE_MS / 2, value },
        ),
        line.gaps.map(spanOf),
      ),
    ),
    markers: markedMoments(chart.markers, start, end),
    hasReadings: values.length > 0,
  };
}

function legend(chart: LineChart) {
  const items = [
    ...chart.lines.map(
      (line, index) =>
        `<li><span class="swatch" style="background:${colorOf(index)}"></span>${escapeHtml(line.label)}</li>`,
    ),
    ...(chart.passLine === null
      ? []
      : [`<li><span class="swatch limit"></span>${escapeHtml(chart.passLine.label)}</li>`]),
  ];
  return `<ul class="legend">${items.join('')}</ul>`;
}

function gapNotes(gaps: readonly Gap[]) {
  if (gaps.length === 0) return '';
  const items = gaps.map(
    (gap) =>
      `<li>${escapeHtml(gap.source)}, ${escapeHtml(gap.from)} to ${escapeHtml(gap.to)}: ${escapeHtml(gap.reason)}</li>`,
  );
  return `<ul class="gap-notes">${items.join('')}</ul>`;
}

/** Where a chart's moments and values land in its picture. */
type Frame = { xAt: (moment: number) => number; yAt: (value: number) => number };

function frameOf({ start, end, valueTop }: ChartLayout): Frame {
  return {
    xAt: (moment) => LEFT + ((moment - start) / (end - start)) * PLOT_WIDTH,
    yAt: (value) => TOP + PLOT_HEIGHT - (value / valueTop) * PLOT_HEIGHT,
  };
}

function gridParts(layout: ChartLayout, { xAt, yAt }: Frame) {
  return [
    ...layout.valueTicks.flatMap((tick) => [
      `<line class="grid" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${coordinate(yAt(tick))}" y2="${coordinate(yAt(tick))}"/>`,
      `<text class="tick" x="${LEFT - 6}" y="${coordinate(yAt(tick) + 4)}" text-anchor="end">${roundTo(tick, 2)}</text>`,
    ]),
    ...layout.timeTicks.map(
      (tick) =>
        `<text class="tick" x="${coordinate(xAt(tick))}" y="${HEIGHT - 10}" text-anchor="middle">${instantOf(tick).slice(11, 16)}</text>`,
    ),
  ];
}

function gapParts(layout: ChartLayout, { xAt }: Frame) {
  return layout.shaded.flatMap((span) => [
    `<rect class="gap" x="${coordinate(xAt(span.from))}" y="${TOP}" width="${coordinate(Math.max(2, xAt(span.to) - xAt(span.from)))}" height="${PLOT_HEIGHT}"/>`,
    `<text class="gap-label" x="${coordinate(xAt(span.from) + 3)}" y="${TOP + 11}">gap</text>`,
  ]);
}

function afterRunParts(layout: ChartLayout, { xAt }: Frame) {
  const { afterRun } = layout;
  if (afterRun === null) return [];
  return [
    `<rect class="after-run" x="${coordinate(xAt(afterRun.from))}" y="${TOP}" width="${coordinate(xAt(afterRun.to) - xAt(afterRun.from))}" height="${PLOT_HEIGHT}"/>`,
    `<text class="after-run-label" x="${coordinate(xAt(afterRun.to) - 3)}" y="${TOP + 11}" text-anchor="end">after the run</text>`,
  ];
}

function lineParts(layout: ChartLayout, { xAt, yAt }: Frame) {
  return layout.strokes.flatMap((runs, index) => {
    const color = colorOf(index);
    return runs.map((run) => {
      const [only] = run;
      return only !== undefined && run.length === 1
        ? `<circle cx="${coordinate(xAt(only.moment))}" cy="${coordinate(yAt(only.value))}" r="3" fill="${color}"/>`
        : `<polyline fill="none" stroke="${color}" stroke-width="2" points="${run.map((reading) => `${coordinate(xAt(reading.moment))},${coordinate(yAt(reading.value))}`).join(' ')}"/>`;
    });
  });
}

function markerParts(layout: ChartLayout, { xAt }: Frame) {
  return layout.markers.flatMap((marked) => {
    const x = coordinate(xAt(marked.at));
    return [
      `<line class="marker" x1="${x}" x2="${x}" y1="${TOP}" y2="${TOP + PLOT_HEIGHT}"/>`,
      `<text class="marker-label" x="${x}" y="${TOP - 3}" text-anchor="middle">${marked.label}</text>`,
    ];
  });
}

function passLineParts(passLine: PassLine | null, { yAt }: Frame) {
  if (passLine === null) return [];
  const y = coordinate(yAt(passLine.value));
  return [
    `<line class="limit" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${y}" y2="${y}"/>`,
    `<text class="limit-label" x="${WIDTH - RIGHT}" y="${coordinate(yAt(passLine.value) - 4)}" text-anchor="end">${escapeHtml(passLine.label)}</text>`,
  ];
}

/**
 * One chart as an inline SVG with its legend and a note per gap, drawn as
 * its layout says. Time runs along the bottom in UTC, one point per minute.
 * A gap is shaded and labelled.
 * The stretch after the run is shaded and labelled too.
 * A pass line is drawn across the chart.
 * Each marked moment is a dotted vertical line, numbered at the top.
 */
export function lineChartHtml(chart: LineChart) {
  const layout = chartLayout(chart);
  const frame = frameOf(layout);
  const parts = [
    ...gridParts(layout, frame),
    ...afterRunParts(layout, frame),
    ...gapParts(layout, frame),
    ...markerParts(layout, frame),
    ...lineParts(layout, frame),
    ...(layout.hasReadings
      ? []
      : [
          `<text class="empty" x="${coordinate(LEFT + PLOT_WIDTH / 2)}" y="${coordinate(TOP + PLOT_HEIGHT / 2)}" text-anchor="middle">no readings</text>`,
        ]),
    ...passLineParts(chart.passLine, frame),
    `<line class="axis" x1="${LEFT}" x2="${LEFT}" y1="${TOP}" y2="${TOP + PLOT_HEIGHT}"/>`,
    `<line class="axis" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${TOP + PLOT_HEIGHT}" y2="${TOP + PLOT_HEIGHT}"/>`,
  ];
  return [
    '<figure class="chart">',
    `<figcaption>${escapeHtml(chart.title)} <span class="unit">${escapeHtml(chart.unit)}</span></figcaption>`,
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(chart.title)}">${parts.join('')}</svg>`,
    legend(chart),
    gapNotes(chart.gaps),
    '</figure>',
  ].join('');
}
