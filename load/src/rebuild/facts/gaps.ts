import { LAYOUT, type ManifestSlice, formattedUserRange } from '../../records/index.ts';
import { MINUTE_MS, SILENCE_LIMIT_MS, instantOf, minuteStartOf } from '../moments.ts';
import { compareText } from '../numbers.ts';
import { runWindowOf } from '../runData/index.ts';
import type { Gap, RunData } from '../types.ts';

/** The source a slice's own gaps are named by. */
const sliceSource = (generator: number) => `generator ${generator}`;

/** How long a window lasted, in whole seconds. */
export const secondsBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 1_000);

/**
 * Every window the run's records leave empty: files that are missing or
 * unusable, what the archive reported lacking, the windows each slice was
 * down, and series that went silent. A slice stopped by the guard is not a
 * gap; the verdict names the guard's stop separately.
 */
export function findGaps(data: RunData) {
  const { manifest } = data;
  const run = runWindowOf(data);
  const gaps: Gap[] = [
    ...data.trouble.map(({ path, reason }) => ({ source: path, ...run, reason })),
    ...(manifest.seal.status === 'incomplete' ? manifest.seal.reasons : []).map((finding) => ({
      source: finding.path ?? finding.check,
      ...run,
      reason: `the archive found: ${finding.detail}`,
    })),
    ...manifest.slices.flatMap(slicesDown),
    ...silentSeries(data),
  ];
  return gaps.sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      compareText(a.source, b.source) ||
      compareText(a.reason, b.reason),
  );
}

/** The windows a slice was down, each as a gap of the slice. */
function slicesDown(slice: ManifestSlice) {
  const users = formattedUserRange(slice);
  return slice.down.map(({ from, to, reason }) => ({
    source: sliceSource(slice.generator),
    from,
    to,
    reason: `users ${users} were down for ${secondsBetween(from, to)} s: ${reason}`,
  }));
}

/** A sampled series, and the window in which it should have readings. */
type Series = {
  source: string;
  window: { from: string; to: string };
  /** Whether silence between the window's edges and the first and last readings counts as a gap. */
  checkEdges: boolean;
  times: readonly string[];
  /** How long the series may be silent before it has a gap; the silence limit unless it says otherwise. */
  limitMs?: number;
  /** Windows already named as gaps of their own, so that a silence overlapping one is not named again. */
  excused?: readonly { from: string; to: string }[];
};

/**
 * Stretches inside each sampled series, and each slice's state lines, with
 * no reading for longer than the limit. A series that went quiet before
 * the end of its window, or had not begun at its start, has a gap there
 * too, and one with no readings at all has a gap for its whole window. A
 * series whose file is missing is left to the files' own gaps.
 */
function silentSeries(data: RunData): Gap[] {
  return seriesOf(data).flatMap(({ source, window, checkEdges, times, limitMs, excused }) => {
    const sorted = times.map((time) => Date.parse(time)).sort((a, b) => a - b);
    const first = sorted[0];
    const last = sorted.at(-1);
    if (first === undefined || last === undefined) {
      return window.to > window.from
        ? [
            {
              source,
              ...window,
              reason: `no readings at all for ${secondsBetween(window.from, window.to)} s`,
            },
          ]
        : [];
    }
    const edges = checkEdges ? [Date.parse(window.from), ...sorted, Date.parse(window.to)] : sorted;
    const isExcused = (from: number, to: number): boolean =>
      (excused ?? []).some((other) => from <= Date.parse(other.to) && to >= Date.parse(other.from));
    return edges.flatMap((time, index) => {
      const before = edges[index - 1];
      if (before === undefined || time - before <= (limitMs ?? SILENCE_LIMIT_MS)) return [];
      if (isExcused(before, time)) return [];
      return [
        {
          source,
          from: instantOf(before),
          to: instantOf(time),
          reason: `no reading for ${Math.round((time - before) / 1_000)} s`,
        },
      ];
    });
  });
}

function seriesOf(data: RunData) {
  const run = runWindowOf(data);
  const wholeRun = (source: string, readings: readonly { at: string }[] | null): Series[] =>
    readings === null
      ? []
      : [{ source, window: run, checkEdges: true, times: readings.map(({ at }) => at) }];
  return [
    ...wholeRun(LAYOUT.hostSamples, data.host),
    ...wholeRun(LAYOUT.appState, data.appStates),
    ...cloudWatchSeries(data, run),
    ...data.slices.flatMap(({ slice, states }): Series[] =>
      states === null
        ? []
        : [
            {
              source: LAYOUT.generatorState(slice.generator),
              window: { from: slice.startedAt, to: slice.endedAt ?? run.to },
              checkEdges: false,
              times: states.map(({ at }) => at),
              excused: slice.down,
            },
          ],
    ),
  ];
}

/**
 * Each file of CloudWatch metrics, read as one series: a minute in which
 * none of its metrics has a point, between two minutes that have one, is
 * a gap. CloudWatch gives a point a minute, so a gap is any longer
 * silence. The run's edges are not checked, because a resource may come
 * up after the run starts.
 */
function cloudWatchSeries(data: RunData, run: { from: string; to: string }): Series[] {
  const from = instantOf(minuteStartOf(Date.parse(run.from)));
  return data.awsMetrics.map(({ path, series }) => ({
    source: path,
    window: run,
    checkEdges: false,
    limitMs: MINUTE_MS,
    times: [...new Set(series.flatMap(({ points }) => points.map(({ at }) => at)))].filter(
      (at) => at >= from && at <= run.to,
    ),
  }));
}
