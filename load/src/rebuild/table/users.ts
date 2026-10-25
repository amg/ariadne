import type { ManifestSlice } from '../../records/index.ts';
import { SILENCE_LIMIT_MS, isInsideAny, minuteStartOf, windowsInMs } from '../moments.ts';
import type { RunData } from '../types.ts';

type Window = ReturnType<typeof windowsInMs>[number];

/** How many users, push streams and chatters the generators held. */
type UserCounts = { signedIn: number; pushStreams: number; chatters: number };

type Reading = { at: number } & UserCounts;

/** The moments a slice could hold no users: inside a window it was down, and after it ended. */
function heldNothing(slice: ManifestSlice): {
  down: readonly Window[];
  endedAt: number;
} {
  return {
    down: windowsInMs(slice.down),
    endedAt: slice.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(slice.endedAt),
  };
}

/**
 * The users the generators held together, at each moment any of them wrote
 * a state line. A slice counts with its latest line, but only while the
 * line is fresh and the slice is held: a slice holds no users inside a
 * window it was down or after it ended, and a line written before it went
 * down says nothing about it once it has. A line older than the silence
 * limit says nothing about now.
 */
export function usersAtEachReading(data: Pick<RunData, 'slices'>) {
  const slices = data.slices.map(({ slice, states }) => ({
    ...heldNothing(slice),
    lines: (states ?? [])
      .map((state) => ({
        at: Date.parse(state.at),
        signedIn: state.usersSignedIn,
        pushStreams: state.pushStreamsOpen,
        chatters: state.chattersActive,
      }))
      .sort((a, b) => a.at - b.at),
  }));
  const moments = [...new Set(slices.flatMap(({ lines }) => lines.map(({ at }) => at)))].sort(
    (a, b) => a - b,
  );
  // Moments come oldest first, so each slice's latest line only moves forward.
  const latestOf = slices.map(() => -1);
  return moments.map((moment) => {
    const total: Reading = { at: moment, signedIn: 0, pushStreams: 0, chatters: 0 };
    for (const [index, { down, endedAt, lines }] of slices.entries()) {
      let latestIndex = latestOf[index] ?? -1;
      while ((lines[latestIndex + 1]?.at ?? Number.POSITIVE_INFINITY) <= moment) latestIndex += 1;
      latestOf[index] = latestIndex;
      const latest = lines[latestIndex];
      if (latest === undefined || moment > endedAt || moment - latest.at > SILENCE_LIMIT_MS) {
        continue;
      }
      const notHeld = down.some(
        (window) =>
          isInsideAny([window], moment) || (latest.at <= window.from && window.from < moment),
      );
      if (notHeld) continue;
      total.signedIn += latest.signedIn;
      total.pushStreams += latest.pushStreams;
      total.chatters += latest.chatters;
    }
    return total;
  });
}

/**
 * The most users the generators held in each minute that has a state line.
 * A minute with none is absent, never filled in.
 */
export function usersByMinute(data: Pick<RunData, 'slices'>) {
  const minutes = new Map<number, UserCounts>();
  for (const reading of usersAtEachReading(data)) {
    const minute = minuteStartOf(reading.at);
    const most = minutes.get(minute) ?? { signedIn: 0, pushStreams: 0, chatters: 0 };
    minutes.set(minute, {
      signedIn: Math.max(most.signedIn, reading.signedIn),
      pushStreams: Math.max(most.pushStreams, reading.pushStreams),
      chatters: Math.max(most.chatters, reading.chatters),
    });
  }
  return minutes;
}
