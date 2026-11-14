import { MINUTE_MS, instantOf } from '../moments.ts';
import { RUNNING_TASKS, splitOf } from '../table/index.ts';
import type { MinuteTable, RunFacts } from '../types.ts';

/**
 * How many of the table's last minutes count as the end of the watch. The
 * last minute or two may not have reached CloudWatch when the run was
 * archived, so a reading that close to the end still stands for it.
 */
const END_OF_WATCH_MINUTES = 3;

/**
 * How each service the step lets scale moved, read from its running tasks
 * a minute at a time through the run and the watch after it: its most
 * tasks and when, when it was back at its floor after the last minute it
 * ran above it, and what it ran at the end of the watch. The end is null
 * when none of the last few minutes recorded the service.
 */
export function scalingOf({ table, facts }: { table: MinuteTable; facts: Pick<RunFacts, 'run'> }) {
  const lastMinute = table.minutes.at(-1) ?? 0;
  const endOfWatchFrom = lastMinute - (END_OF_WATCH_MINUTES - 1) * MINUTE_MS;
  return facts.run.scalingServices.map(({ service, floor, ceiling }) => {
    const values =
      splitOf(table, RUNNING_TASKS).find((column) => column.of?.value === service)?.values ?? [];
    const readings = values.flatMap((tasks, index) => {
      const minute = table.minutes[index] ?? 0;
      return tasks === null ? [] : [{ tasks, at: minute, minute: instantOf(minute) }];
    });
    const peakReading = readings.reduce<(typeof readings)[number] | null>(
      (most, reading) => (most === null || reading.tasks > most.tasks ? reading : most),
      null,
    );
    const lastAboveFloorIndex = readings.findLastIndex((reading) => reading.tasks > floor);
    const backAtFloorReading =
      lastAboveFloorIndex === -1
        ? undefined
        : readings.slice(lastAboveFloorIndex + 1).find((reading) => reading.tasks <= floor);
    const finalReading = readings.at(-1);
    const atEnd =
      finalReading === undefined || finalReading.at < endOfWatchFrom ? null : finalReading;
    return {
      service,
      floor,
      ceiling,
      /** The most tasks it ran in a minute, and the first minute it ran that many. */
      peak: peakReading === null ? null : { tasks: peakReading.tasks, minute: peakReading.minute },
      /** The minute it was back at its floor after the last minute it ran above it; null when it never went above it, or never came back. */
      backAtFloor: backAtFloorReading?.minute ?? null,
      /** The tasks it ran in the last minute recorded, when that minute is at the end of the watch. */
      atEnd: atEnd === null ? null : { tasks: atEnd.tasks, minute: atEnd.minute },
    };
  });
}
