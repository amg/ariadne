import { roundTo } from '../numbers.ts';
import { drawnMinutesOf, withAfterRun } from '../runData/index.ts';
import type { MinuteTable, RunData, SeriesColumn } from '../types.ts';
import {
  apiRequestColumns,
  appColumns,
  copyLoadColumns,
  eachCopyColumns,
  gateColumns,
  jobsByTaskColumns,
} from './columns/appColumns.ts';
import { awsColumns, waitColumns } from './columns/awsColumns.ts';
import { cpuPerJobColumns } from './columns/cpuPerJobColumns.ts';
import {
  hostColumns,
  pushStreamColumns,
  requestColumns,
  slicesDownColumns,
  userColumns,
} from './columns/runColumns.ts';

/**
 * Every series of the run at one-minute resolution, each figure rounded to
 * a tenth unless it needs more places. A figure is null where the minute
 * holds no reading of its series; nothing is carried forward or averaged
 * across a gap. A series with no figure in any minute is left out.
 */
export function minuteTable(judged: RunData): MinuteTable {
  const drawn = withAfterRun(judged);
  const columns = [
    ...userColumns(drawn),
    ...requestColumns(drawn),
    ...pushStreamColumns(drawn),
    ...slicesDownColumns(drawn),
    ...hostColumns(drawn),
    ...appColumns(drawn),
    ...copyLoadColumns(drawn),
    ...eachCopyColumns(drawn),
    ...jobsByTaskColumns(drawn),
    ...apiRequestColumns(drawn),
    ...gateColumns(drawn),
    ...awsColumns(drawn),
    ...cpuPerJobColumns(drawn),
    ...waitColumns(drawn),
  ];
  const { minutes, afterRunFrom } = drawnMinutesOf(judged);
  return {
    minutes,
    afterRunFrom,
    columns: columns
      .map((column) => ({
        name: column.name,
        of: column.of ?? null,
        values: minutes.map((minute) => {
          const value = column.at(minute);
          return value === null ? null : roundTo(value, column.places ?? 1);
        }),
      }))
      .filter((column) => column.values.some((value) => value !== null)),
  };
}

/** The figures of one series by minute; all null for a series the run does not have. */
export function valuesOf(table: MinuteTable, name: string) {
  return (
    table.columns.find((column) => column.name === name)?.values ?? table.minutes.map(() => null)
  );
}

/** The series that are the values of one split figure, in the order they were made. */
export function splitOf(table: MinuteTable, figure: string): readonly SeriesColumn[] {
  return table.columns.filter((column) => column.of?.figure === figure);
}

/** The minutes of the run itself, without those of the stretch after its end. */
export function judgedMinutesOf(table: MinuteTable) {
  const { afterRunFrom } = table;
  return afterRunFrom === null
    ? table.minutes
    : table.minutes.filter((minute) => minute < afterRunFrom);
}
