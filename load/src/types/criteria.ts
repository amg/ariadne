/**
 * What a run showed, as far as its pass criteria care. A figure is null
 * where the run recorded nothing to measure it by.
 */
export type RunFigures = {
  hostCpuPercentMax: number | null;
  memoryUsedPercentMax: number | null;
  /** The 95th percentile of the time to the first byte of every reply that streamed, in milliseconds. */
  chatFirstByteP95Ms: number | null;
  /** The share of sign-ins, Threads and chats that failed, from 0 to 1. */
  errorShare: number | null;
  /**
   * The fewest push streams the generators held together at any moment of
   * the hold. A user reopening, within seconds, a stream that was ended
   * under them counts as holding one.
   */
  pushStreamsLeastInHold: number | null;
  /** The fewest chatters the generators had active together in any minute of the hold. */
  chattersLeastInHold: number | null;
  /** The share of sign-ins that failed, from 0 to 1. */
  signInFailureShare: number | null;
  /** The share of the Drift gate's verdicts that were a wait which hit its limit, from 0 to 1. */
  gateWaitAtLimitShare: number | null;
  /** The busiest any generator's CPU got in any minute of the run, as a percent of what it reserved. */
  generatorCpuPercentMax: number | null;
};

/**
 * What a figure is measured in. A percent runs from 0 to 100, a share from
 * 0 to 1, and a count is a whole number of things, such as push streams.
 */
export type Unit = 'percent' | 'share' | 'ms' | 'count';

/** Which side of its limit a figure must stay on to pass. */
export type Direction = 'at-most' | 'at-least';

/** The limit of each line a run is judged by, by the line's name. */
export type Limits = Readonly<Record<string, number>>;

/**
 * How one criterion came out, with its limit and the figure observed as
 * numbers in `unit`. A criterion with nothing to measure it by is not
 * judged, and never counts as a pass.
 */
export type Judgement = {
  id: string;
  title: string;
  unit: Unit;
  /** Whether the figure had to stay at most, or at least, at the limit. */
  direction: Direction;
  limit: number;
  observed: number | null;
  result: 'pass' | 'fail' | 'not-judged';
};

/** The lines a home run may not cross. */
export type HomeLines = {
  maxHostCpuPercent: number;
  maxMemoryUsedPercent: number;
  maxFirstByteP95Ms: number;
  /** The share of requests that failed, from 0 to 1. */
  maxErrorShare: number;
};

/** The lines a home run may not cross. */
export type GuardLines = HomeLines;
