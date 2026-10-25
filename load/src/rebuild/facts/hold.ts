import { isChat } from '../../records/index.ts';
import { instantOf, isInsideAny, windowsInMs } from '../moments.ts';
import { percentileOf, roundTo } from '../numbers.ts';
import { endedPushStreamsOf } from '../runData/index.ts';
import { usersAtEachReading } from '../table/index.ts';
import type { Fewest, RunData } from '../types.ts';
import { downWindowsOf, insideAnyOf } from './slices.ts';

/**
 * The window the generators held their users together: from the last
 * moment a slice's hold began to the first moment one was planned to end.
 * Null when the run records no hold.
 */
function holdWindowOrNull(data: Pick<RunData, 'manifest'>) {
  const holds = data.manifest.slices.flatMap(({ hold }) => hold ?? []);
  if (holds.length === 0) return null;
  return {
    from: Math.max(...holds.map((hold) => Date.parse(hold.from))),
    to: Math.min(...holds.map((hold) => Date.parse(hold.to))),
  };
}

/** How many places in a sorted list hold a value at or below `value`. */
function countAtOrBelow(sorted: readonly number[], value: number) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? 0) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * How many users were between a push stream that the server, or something
 * between, ended and the one they opened within seconds after, at a
 * moment. A tab reopens a stream on its own, so its user never noticed.
 */
function reopeningAt(data: RunData, generator: number): (moment: number) => number {
  const gaps = endedPushStreamsOf(data).flatMap(({ line, endedAt, reopenedAt }) =>
    reopenedAt === null || line.generator !== generator ? [] : [{ from: endedAt, to: reopenedAt }],
  );
  const froms = gaps.map(({ from }) => from).sort((a, b) => a - b);
  const tos = gaps.map(({ to }) => to).sort((a, b) => a - b);
  return (moment) => countAtOrBelow(froms, moment) - countAtOrBelow(tos, moment);
}

/**
 * The fewest push streams and chatters the generators held together at any
 * moment of the hold, each with the first moment it was that few. A user
 * reopening a stream that was ended under them, within seconds, still
 * holds one: the infrastructure changing beneath a run is not the app
 * failing. A moment inside a window a slice was down is left out, because
 * its users could not hold anything. Both are null when no state line falls
 * in the hold.
 */
export function fewestUsersInHold(data: RunData) {
  const hold = holdWindowOrNull(data);
  if (hold === null) return { pushStreams: null, chatters: null };
  const down = windowsInMs(downWindowsOf(data));
  // Each state line counts its own slice's users reopening at the moment it was written.
  const slices = data.slices.map((sliceData) => {
    const reopening = reopeningAt(data, sliceData.slice.generator);
    return {
      ...sliceData,
      states:
        sliceData.states?.map((state) => ({
          ...state,
          pushStreamsOpen: state.pushStreamsOpen + reopening(Date.parse(state.at)),
        })) ?? null,
    };
  });
  const readings = usersAtEachReading({ slices }).filter(
    ({ at }) => at >= hold.from && at <= hold.to && !isInsideAny(down, at),
  );
  const fewestOf = (pick: (reading: (typeof readings)[number]) => number): Fewest | null => {
    const fewest = readings.reduce<(typeof readings)[number] | null>(
      (least, reading) => (least === null || pick(reading) < pick(least) ? reading : least),
      null,
    );
    return fewest === null ? null : { count: pick(fewest), at: instantOf(fewest.at) };
  };
  return {
    pushStreams: fewestOf((reading) => reading.pushStreams),
    chatters: fewestOf((reading) => reading.chatters),
  };
}

/**
 * The hold alone: what the generators held at their fewest, and how fast
 * chats were answered, without the ramp's quiet start or the ramp-down. A
 * slice's requests inside a window it was down are left out. Null when the
 * run records no hold.
 */
export function holdFactsOf(data: RunData) {
  const hold = holdWindowOrNull(data);
  if (hold === null) return null;
  const fewest = fewestUsersInHold(data);
  const firstBytes = data.slices.flatMap(({ slice, requests }) => {
    const down = insideAnyOf(slice.down);
    return (requests ?? [])
      .filter((line) => {
        const startedAt = Date.parse(line.startedAt);
        return (
          isChat(line) &&
          line.outcome === 'streamed' &&
          startedAt >= hold.from &&
          startedAt <= hold.to &&
          !down(line.startedAt)
        );
      })
      .map((line) => line.firstByteMs);
  });
  const p95 = percentileOf(firstBytes, 0.95);
  return {
    from: instantOf(hold.from),
    to: instantOf(hold.to),
    fewestPushStreams: fewest.pushStreams,
    fewestChatters: fewest.chatters,
    chatsStreamed: firstBytes.length,
    chatFirstByteP95Ms: p95 === null ? null : roundTo(p95, 1),
  };
}
