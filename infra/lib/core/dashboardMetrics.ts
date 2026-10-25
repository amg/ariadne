import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import {
  type SearchNarrowing,
  type Share,
  type Signal,
  searchOf,
} from '../../../lib/metrics/catalogue.ts';

export const MINUTE = 60;
const WIDTH = 8;
const HEIGHT = 6;

/**
 * The app's services: the word each one's generated ECS name carries, and
 * the label and colour it keeps on every graph.
 */
const SERVICES = [
  { label: 'api', nameWord: 'Api', color: cloudwatch.Color.BLUE },
  { label: 'worker', nameWord: 'Worker', color: cloudwatch.Color.ORANGE },
  { label: 'auth', nameWord: 'Auth', color: cloudwatch.Color.GREEN },
  { label: 'web', nameWord: 'Web', color: cloudwatch.Color.PURPLE },
  { label: 'mock', nameWord: 'Mock', color: cloudwatch.Color.GREY },
];

/** A section heading on its own row, then its graphs side by side. */
export function row(title: string, graphs: cloudwatch.IWidget[]) {
  return [[new cloudwatch.TextWidget({ markdown: `#### ${title}`, width: 24, height: 1 })], graphs];
}

/** A limit a run is judged by, drawn across a graph. */
type PassLine = { value: number; label: string };

type GraphOptions = {
  /** Top of the left axis: 100 for percentages. */
  leftMax?: number;
  stacked?: boolean;
  /** Where the graph carries pass criteria, each drawn as a red line. */
  passLines?: readonly PassLine[];
};

export function graph(
  title: string,
  lines: cloudwatch.IMetric[],
  { leftMax, stacked = false, passLines = [] }: GraphOptions = {},
) {
  return new cloudwatch.GraphWidget({
    title,
    left: lines,
    stacked,
    width: WIDTH,
    height: HEIGHT,
    leftYAxis: { min: 0, ...(leftMax === undefined ? {} : { max: leftMax }) },
    ...(passLines.length === 0
      ? {}
      : {
          leftAnnotations: passLines.map(({ value, label }) => ({
            value,
            label,
            color: cloudwatch.Color.RED,
          })),
        }),
  });
}

/** How a signal's series are combined into one line. */
const combineOf = (signal: Signal) => (signal.minute === 'sum' ? 'SUM' : 'MAX');

/** A signal's series, combined as the signal says: added up, or the highest of them. */
export function lineOf(
  signal: Signal,
  label: string,
  options: {
    divideBy?: number;
    zeroBetweenRuns?: boolean;
    narrowedTo?: SearchNarrowing;
    color?: string;
  } = {},
) {
  return combined({
    combine: combineOf(signal),
    search: searchOf(signal, options.narrowedTo),
    statistic: signal.statistic,
    label,
    ...(options.divideBy === undefined ? {} : { divideBy: options.divideBy }),
    ...(options.zeroBetweenRuns === undefined ? {} : { zeroBetweenRuns: options.zeroBetweenRuns }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
}

/** One line per service, matched by the word in its generated name. */
export function perService(signal: Signal) {
  return SERVICES.map((service) =>
    lineOf(signal, service.label, {
      narrowedTo: { contains: { ServiceName: service.nameWord } },
      color: service.color,
    }),
  );
}

/**
 * One line for each value of a dimension, labelled by that value, such as
 * a count for each kind of failure. Only values that have been published
 * are drawn. A minute with no point counts zero, so a line does not run
 * straight from the end of one run to the start of the next.
 */
export function perValueOf(signal: Signal) {
  const [dimension] = signal.dimensions;
  if (dimension === undefined)
    throw new Error(`${signal.name} has no dimension to draw a line for`);
  return new cloudwatch.MathExpression({
    expression: `FILL(SEARCH('${searchOf(signal)}', '${signal.statistic}', ${MINUTE}), 0)`,
    usingMetrics: {},
    label: `\${PROP('Dim.${dimension}')}`,
    period: Duration.seconds(MINUTE),
  });
}

/**
 * Every series a search finds, combined into one labelled line. Set
 * `zeroBetweenRuns` for a figure that is published only while a run lasts.
 * Each series then counts zero in a minute where it has no point, so the line
 * does not run straight from the end of one run to the start of the next.
 */
function combined(line: {
  combine: 'SUM' | 'MAX';
  search: string;
  statistic: string;
  label: string;
  color?: string;
  divideBy?: number;
  zeroBetweenRuns?: boolean;
}) {
  const search = `SEARCH('${line.search}', '${line.statistic}', ${MINUTE})`;
  const found = `${line.combine}(${line.zeroBetweenRuns === true ? `FILL(${search}, 0)` : search})`;
  return new cloudwatch.MathExpression({
    expression:
      line.divideBy === undefined || line.divideBy === 1 ? found : `${found}/${line.divideBy}`,
    usingMetrics: {},
    label: line.label,
    period: Duration.seconds(MINUTE),
    ...(line.color === undefined ? {} : { color: line.color }),
  });
}

/**
 * What a share of two signals comes to as a percent. Each side is its
 * signal's series combined as the signal says. With `zeroBetweenRuns`, a
 * minute with no events counts zero, so a line of counts does not run
 * straight from the end of one run to the start of the next.
 */
export function percentOf(
  label: string,
  { part, whole }: Share,
  options: { zeroBetweenRuns?: boolean; narrowedTo?: SearchNarrowing } = {},
) {
  const total = (signal: Signal): string =>
    `${combineOf(signal)}(SEARCH('${searchOf(signal, options.narrowedTo)}', '${signal.statistic}', ${MINUTE}))`;
  const expression =
    options.zeroBetweenRuns === true
      ? `100 * FILL(${total(part)}, 0) / FILL(${total(whole)}, 1)`
      : `100 * ${total(part)} / ${total(whole)}`;
  return new cloudwatch.MathExpression({
    expression,
    usingMetrics: {},
    label,
    period: Duration.seconds(MINUTE),
  });
}
