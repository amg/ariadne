import type { DownWindow, ManifestSlice, Report } from '../records/index.ts';
import { type Attempt, attemptsBySlice } from './attempts.ts';

/** What the run left that tells when each slice was down. */
type SliceSources = {
  /** The report an attempt printed; null where it never lived to print one. */
  reportOf: (generator: number, attempt: number) => Report | null;
  /** When an attempt wrote its last state line; null where it wrote none. */
  lastStateAt: (generator: number, attempt: number) => string | null;
  /** When the run ended, which no down window passes. */
  runEndedAt: string;
};

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Every slice of the run, with the windows it was down worked out once,
 * here, and every attempt at running it kept as its history.
 */
export function slicesOf(attempts: readonly Attempt[], sources: SliceSources) {
  return attemptsBySlice(attempts).flatMap(({ attempts: own }): ManifestSlice[] => {
    const [first] = own;
    const last = own.at(-1);
    if (first === undefined || last === undefined) return [];
    return [
      {
        generator: first.generator,
        firstUser: first.firstUser,
        userCount: first.userCount,
        startedAt: first.startedAt,
        endedAt: last.toldToStopAt ?? last.stoppedAt,
        hold: holdOrNull(first, sources),
        down: joinOverlapping(own.flatMap((attempt) => downWindowsOf(attempt, own, sources))),
        attempts: own.map((attempt) => ({
          attempt: attempt.attempt,
          task: attempt.task,
          spot: attempt.spot,
          startedAt: attempt.startedAt,
          stoppedAt: attempt.stoppedAt,
          stoppedBecause: attempt.stoppedBecause,
          stopDetail: attempt.stopDetail,
          toldToStopAt: attempt.toldToStopAt,
          stoppedForRunEnd: attempt.stoppedForRunEnd,
        })),
      },
    ];
  });
}

/** When a slice held its users: from when its first generator began holding them, by its report or else its plan, to the end of the hold its plan gave it. */
function holdOrNull(first: Attempt, sources: SliceSources) {
  if (first.planned === null) return null;
  const ran = sources.reportOf(first.generator, first.attempt)?.phases?.hold.startedAt;
  return { from: ran ?? first.planned.rampEndsAt, to: first.planned.holdEndsAt };
}

/**
 * The window a slice was without the given generator, when it was lost:
 * from the moment it was told to stop until its replacement had brought
 * the users back, or until the end of its hold when nothing replaced it,
 * and never past the end of the run. A generator that finished, or that
 * the end of the run or the guard stopped, was not lost.
 */
function downWindowsOf(attempt: Attempt, slice: readonly Attempt[], sources: SliceSources) {
  if (!wasLost(attempt)) return [];
  const runEnd = sources.runEndedAt;
  const replacement = slice.find((other) => other.attempt === attempt.replacedByAttempt);
  const from = earlier(toldToStopAt(attempt, sources), runEnd);
  const back = replacement === undefined ? null : usersBackAt(replacement, sources);
  const to = later(earlier(back ?? attempt.planned?.holdEndsAt ?? runEnd, runEnd), from);
  const after =
    replacement === undefined
      ? 'no generator took its place'
      : 'a new generator brought the users back';
  return [{ from, to, reason: `${stopReasonText(attempt)}; ${after}` }];
}

/**
 * Down windows in order, with those that overlap joined into one. A
 * replacement lost before it had brought the users back leaves two windows
 * that run into each other, and the slice was down once, not twice.
 */
function joinOverlapping(windows: readonly DownWindow[]) {
  const joined: DownWindow[] = [];
  for (const window of [...windows].sort((a, b) => {
    if (a.from < b.from) return -1;
    return a.from > b.from ? 1 : 0;
  })) {
    const last = joined.at(-1);
    if (last === undefined || window.from > last.to) {
      joined.push(window);
      continue;
    }
    joined[joined.length - 1] = {
      from: last.from,
      to: later(last.to, window.to),
      reason: `${last.reason}; then ${window.reason}`,
    };
  }
  return joined;
}

function wasLost(attempt: Attempt) {
  if (attempt.stoppedForRunEnd) return false;
  return attempt.stoppedBecause !== 'finished' && attempt.stoppedBecause !== 'guard';
}

/**
 * When a generator was told to stop: as the record says, else at its last
 * state line, which comes before ECS has torn its task down, else when it
 * stopped.
 */
function toldToStopAt(attempt: Attempt, sources: SliceSources) {
  return (
    attempt.toldToStopAt ??
    sources.lastStateAt(attempt.generator, attempt.attempt) ??
    attempt.stoppedAt ??
    attempt.startedAt
  );
}

/** When a replacement had brought all its users back: the end of its ramp, or its start when it had no plan. */
function usersBackAt(replacement: Attempt, sources: SliceSources) {
  if (replacement.planned === null) return replacement.startedAt;
  const ran = sources.reportOf(replacement.generator, replacement.attempt)?.phases?.ramp.endedAt;
  return ran ?? replacement.planned.rampEndsAt;
}

function stopReasonText(attempt: Attempt) {
  if (attempt.stoppedBecause === null) return 'its generator has no recorded stop';
  const detail = attempt.stopDetail === null ? '' : `: ${attempt.stopDetail}`;
  return `its generator stopped (${attempt.stoppedBecause}${detail})`;
}
