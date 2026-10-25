import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../moments.ts';
import { at } from '../runData/testing.ts';
import type { Gap } from '../types.ts';
import { type LineChart, chartLayout, lineChartHtml } from './lineChart.ts';

const START = Date.parse(at(0));
const minutes = [0, 1, 2, 3].map((index) => START + index * MINUTE_MS);

const gapBetween = (from: number, to: number, source = 'metrics/host.jsonl') => ({
  source,
  from: at(from),
  to: at(to),
  reason: 'no reading',
});

const lineWith = (
  values: readonly (number | null)[],
  gaps: readonly Gap[] = [],
  label = 'p95',
) => ({ label, values, gaps });

const chartWith = (overrides: Partial<LineChart> = {}) => ({
  title: 'Chat first byte',
  unit: 'ms',
  minutes,
  lines: [lineWith([100, 200, 300, 400])],
  passLine: null,
  gaps: [],
  markers: [],
  afterRunFrom: null,
  ...overrides,
});

/** How many readings each stroke of each line holds; a stroke of one is a dot. */
const strokeLengths = (chart: LineChart) =>
  chartLayout(chart).strokes.map((runs) => runs.map((run) => run.length));

describe('chartLayout', () => {
  it('draws a line through readings that follow one another', () => {
    const layout = chartLayout(chartWith());

    expect(strokeLengths(chartWith())).toEqual([[4]]);
    expect(layout.shaded).toEqual([]);
  });

  it('lifts the value axis to hold the pass line above every reading', () => {
    const layout = chartLayout(chartWith({ passLine: { label: 'p95', value: 2_500 } }));

    expect(layout.valueTop).toBeGreaterThanOrEqual(2_500);
    expect(layout.valueTicks.at(-1)).toBe(layout.valueTop);
  });

  it('holds every reading under the top of the value axis', () => {
    const layout = chartLayout(chartWith({ lines: [lineWith([1, 7, 13, 2])] }));

    expect(layout.valueTop).toBeGreaterThanOrEqual(13);
  });

  it('shades a gap', () => {
    const layout = chartLayout(chartWith({ gaps: [gapBetween(70, 100)] }));

    expect(layout.shaded).toEqual([{ from: Date.parse(at(70)), to: Date.parse(at(100)) }]);
  });

  it('shades two overlapping gaps as one window', () => {
    const layout = chartLayout(chartWith({ gaps: [gapBetween(70, 100), gapBetween(90, 130)] }));

    expect(layout.shaded).toEqual([{ from: Date.parse(at(70)), to: Date.parse(at(130)) }]);
  });

  it('clips a gap to the chart’s time', () => {
    const layout = chartLayout(chartWith({ gaps: [gapBetween(-60, 30)] }));

    expect(layout.shaded).toEqual([{ from: START, to: Date.parse(at(30)) }]);
  });

  it('does not draw a line through a gap of its own records', () => {
    const own = gapBetween(100, 140);

    expect(
      strokeLengths(chartWith({ lines: [lineWith([100, 200, 300, 400], [own])], gaps: [own] })),
    ).toEqual([[2, 2]]);
  });

  it('keeps a line whole when the gap is in another line’s records', () => {
    const chart = chartWith({
      lines: [lineWith([100, 200, 300, 400]), lineWith([1, 2, 3, 4], [], 'other')],
      gaps: [gapBetween(100, 140)],
    });

    expect(strokeLengths(chart)).toEqual([[4], [4]]);
    expect(chartLayout(chart).shaded).toHaveLength(1);
  });

  it('does not draw a line through a minute with no reading', () => {
    expect(strokeLengths(chartWith({ lines: [lineWith([100, null, 300, 400])] }))).toEqual([
      [1, 2],
    ]);
  });

  it('keeps a line whole when a gap lies outside the stretch between two readings', () => {
    const own = gapBetween(0, 20);

    expect(
      strokeLengths(chartWith({ lines: [lineWith([100, 200, 300, 400], [own])], gaps: [own] })),
    ).toEqual([[4]]);
  });

  it('knows when a chart has no reading at all', () => {
    expect(chartLayout(chartWith({ lines: [lineWith([null, null])] })).hasReadings).toBe(false);
    expect(chartLayout(chartWith()).hasReadings).toBe(true);
  });
});

describe('the stretch after the run', () => {
  it('is marked from where it starts to the chart’s end', () => {
    const layout = chartLayout(chartWith({ afterRunFrom: minutes[2] ?? 0 }));

    expect(layout.afterRun).toEqual({ from: minutes[2], to: layout.end });
  });

  it('is not marked on a chart that has none', () => {
    expect(chartLayout(chartWith()).afterRun).toBeNull();
  });

  it('is drawn and labelled as after the run', () => {
    const html = lineChartHtml(chartWith({ afterRunFrom: minutes[2] ?? 0 }));

    expect(html).toContain('class="after-run"');
    expect(html).toContain('after the run');
  });
});

describe('the moments a chart marks', () => {
  const labels = (markers: LineChart['markers']): string[] =>
    chartLayout(chartWith({ markers })).markers.map((marked) => marked.label);

  it('marks each moment inside its time, by its number', () => {
    expect(
      labels([
        { at: START + 30_000, number: 1 },
        { at: START + 150_000, number: 2 },
      ]),
    ).toEqual(['1', '2']);
  });

  it('gives moments too close to tell apart one mark, labelled with the range of their numbers', () => {
    expect(
      labels([
        { at: START + 30_000, number: 1 },
        { at: START + 31_000, number: 2 },
        { at: START + 32_000, number: 3 },
      ]),
    ).toEqual(['1–3']);
  });

  it('leaves out a moment outside its time', () => {
    expect(labels([{ at: START - MINUTE_MS, number: 1 }])).toEqual([]);
  });
});

describe('lineChartHtml', () => {
  it('escapes every text it is given', () => {
    const html = lineChartHtml(
      chartWith({
        title: '<b>title</b>',
        unit: '<u>',
        lines: [lineWith([1], [], '"<script>"')],
        passLine: { label: '<i>limit</i>', value: 2 },
        gaps: [{ source: '<s>', from: at(0), to: at(1), reason: 'a & b' }],
      }),
    );

    for (const raw of ['<b>', '<u>', '<script>', '<i>', '<s>']) expect(html).not.toContain(raw);
  });
});
