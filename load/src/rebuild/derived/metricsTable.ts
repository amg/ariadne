import { instantOf } from '../moments.ts';
import type { MinuteTable } from '../types.ts';

/**
 * The minute table as tab-separated text with a header row; an unknown
 * figure is an empty cell. A run that kept a stretch after its end gets a
 * last column, `after_run`, that is 1 in the minutes of that stretch and 0
 * in the others.
 */
export function metricsTable(table: MinuteTable) {
  const { afterRunFrom } = table;
  const marking =
    afterRunFrom === null
      ? []
      : [{ name: 'after_run', is: (minute: number) => (minute >= afterRunFrom ? '1' : '0') }];
  const rows = table.minutes.map((minute, index) => [
    instantOf(minute),
    ...table.columns.map((column) => String(column.values[index] ?? '')),
    ...marking.map(({ is }) => is(minute)),
  ]);
  const header = [
    'minute',
    ...table.columns.map((column) => column.name),
    ...marking.map(({ name }) => name),
  ];
  return `${header.join('\t')}\n${rows.map((row) => row.join('\t')).join('\n')}\n`;
}
