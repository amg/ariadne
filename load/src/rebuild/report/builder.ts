import { type Share, type Signal, passLineOf } from '@ari/lib/metrics/catalogue';
import { AWS_PROD_TARGET, LAYOUT } from '../../records/index.ts';
import type { Judgement } from '../../types/criteria.ts';
import { limitText } from '../derived/index.ts';
import { splitOf, valuesOf } from '../table/index.ts';
import type { Gap, MinuteTable, RunFacts, SeriesColumn } from '../types.ts';
import type { LineChart, chartLayout } from './lineChart.ts';

type ChartMarker = Parameters<typeof chartLayout>[0]['markers'][number];

type PassLine = NonNullable<Parameters<typeof chartLayout>[0]['passLine']>;

type ChartLine = Parameters<typeof chartLayout>[0]['lines'][number];

/** A table under a section's charts. `empty` is said instead when it has no rows. */
export type Table = {
  caption: string;
  header: readonly string[];
  rows: readonly (readonly (string | number | null)[])[];
  empty: string;
};

/** One section of the report: a heading, its charts side by side, then its tables. */
export type Section = { heading: string; charts: readonly LineChart[]; tables: readonly Table[] };

/** Tells whether a gap lies in the records a line is drawn from. */
type Touches = (gap: Gap) => boolean;

export const inFile =
  (path: string): Touches =>
  (gap) =>
    gap.source === path;

const inFolder =
  (prefix: string): Touches =>
  (gap) =>
    gap.source.startsWith(prefix);

/** Touched by a gap that touches any of them. */
export const anyOf =
  (...touches: readonly Touches[]): Touches =>
  (gap) =>
    touches.some((touch) => touch(gap));

/** A slice that was down has no state lines and no request lines then. */
export const GENERATOR_STATE = anyOf(inFolder('generator '), inFolder('metrics/generator-'));
export const GENERATOR_REQUESTS = anyOf(inFolder('generator '), inFolder('requests/'));

/** The file of CloudWatch metrics one resource's figures are read from. */
export const inAwsMetrics = (resource: string) => inFile(LAYOUT.awsMetrics(resource));

/** A signal or share whose pass line aws-prod is watched against live, as the live dashboard draws it. */
type WatchedLine = Signal | Share;

/** Builds the lines and charts of one run's report. */
export type Builder = {
  facts: RunFacts;
  table: MinuteTable;
  /** A line drawn from one series of the run. */
  line: (label: string, column: string, touches: Touches) => ChartLine;
  /** One line for each value of a split figure, labelled by the value, each touched by gaps in its own file. */
  split: (figure: string, keep?: (column: SeriesColumn) => boolean) => ChartLine[];
  chart: (
    title: string,
    unit: string,
    lines: readonly ChartLine[],
    passLine?: PassLine | null,
  ) => LineChart;
  /**
   * The limit a chart's figure is held to: the run's own criterion where it
   * has one, in the chart's unit, or else on aws-prod the live line the
   * dashboard draws. Null where neither applies.
   */
  passLine: (judgementId: string | null, what: string, live?: WatchedLine) => PassLine | null;
};

/** How a watched line reads in its own unit: a share is a percent, and a time is in milliseconds. */
function watchedText(line: WatchedLine) {
  const value = passLineOf(line);
  if ('part' in line) return `${value}%`;
  if (line.unit === 'Milliseconds') return `${value} ms`;
  throw new Error(`${line.name} has a pass line in ${line.unit}, which a chart cannot label`);
}

export function builderOf(input: {
  facts: RunFacts;
  table: MinuteTable;
  judgements: readonly Judgement[];
  markers: readonly ChartMarker[];
}): Builder {
  const { facts, table, judgements, markers } = input;
  const { gaps } = facts;
  const lineOf = (
    label: string,
    values: readonly (number | null)[],
    touches: Touches,
  ): ChartLine => ({ label, values, gaps: gaps.filter(touches) });
  return {
    facts,
    table,
    line: (label, column, touches) => lineOf(label, valuesOf(table, column), touches),
    split: (figure, keep = () => true) =>
      splitOf(table, figure)
        .filter(keep)
        .map((column) =>
          lineOf(
            column.of?.value ?? column.name,
            column.values,
            column.of?.source == null ? () => false : inFile(column.of.source),
          ),
        ),
    chart: (title, unit, lines, passLine = null) => ({
      title,
      unit,
      minutes: table.minutes,
      lines,
      passLine,
      gaps: gaps.filter((gap) => lines.some((line) => line.gaps.includes(gap))),
      markers,
      afterRunFrom: table.afterRunFrom,
    }),
    passLine: (judgementId, what, live) => {
      const judgement = judgements.find((candidate) => candidate.id === judgementId);
      if (judgement !== undefined) {
        const value = judgement.unit === 'share' ? judgement.limit * 100 : judgement.limit;
        return { label: `${what} ${limitText(judgement)}`, value };
      }
      if (live === undefined || facts.run.target !== AWS_PROD_TARGET) return null;
      return { label: `${what} pass line ${watchedText(live)}`, value: passLineOf(live) };
    },
  };
}

const hasValues = (line: ChartLine) => line.values.some((value) => value !== null);

/**
 * Leaves out what has nothing to show: a line with no value and no gap, a
 * chart none of whose lines has a value, and a section left with no chart
 * and no table. A line with no value but a gap stays, so that a missing
 * source shows as a gap and not as nothing.
 */
export function withoutEmpty(sections: readonly Section[]): Section[] {
  return sections
    .map((section) => ({
      ...section,
      charts: section.charts
        .filter((chart) => chart.lines.some(hasValues))
        .map((chart) => ({
          ...chart,
          lines: chart.lines.filter((line) => hasValues(line) || line.gaps.length > 0),
        })),
    }))
    .filter((section) => section.charts.length > 0 || section.tables.length > 0);
}
