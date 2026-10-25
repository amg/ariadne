export const MINUTE_MS = 60_000;

/** A series that is silent for longer than this has a gap, and a reading older than this says nothing about now. */
export const SILENCE_LIMIT_MS = 30_000;

/** UTC with milliseconds, as the records write it. */
export function instantOf(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

/** The start of the minute a moment falls in, in milliseconds. */
export function minuteStartOf(milliseconds: number) {
  return Math.floor(milliseconds / MINUTE_MS) * MINUTE_MS;
}

/** A stretch of time in milliseconds, both ends included. */
type Window = { from: number; to: number };

/** The windows the records give as instants, in milliseconds. */
export function windowsInMs(windows: readonly { from: string; to: string }[]) {
  return windows.map(({ from, to }) => ({ from: Date.parse(from), to: Date.parse(to) }));
}

/** Whether a moment, in milliseconds, falls inside any of the windows. */
export function isInsideAny(windows: readonly Window[], moment: number) {
  return windows.some(({ from, to }) => moment >= from && moment <= to);
}
