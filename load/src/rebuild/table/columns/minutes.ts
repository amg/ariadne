import { minuteStartOf } from '../../moments.ts';
import { compareText, maxOf } from '../../numbers.ts';
import type { Cell, Split } from '../../types.ts';

/** One column of the table: its name, the figure it holds in a minute, and how many decimal places that figure keeps. */
export type Column = {
  name: string;
  at: (minute: number) => Cell;
  /** One decimal place unless a figure needs more to say anything. */
  places?: number;
  of?: Split;
};

/** The name of the column that holds one value of a split figure. */
export function splitName(figure: string, value: string) {
  const slug = value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${figure}_${slug}`;
}

/** Groups items by the minute they fall in. */
export function byMinute<T>(items: readonly T[], atOf: (item: T) => string): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const minute = minuteStartOf(Date.parse(atOf(item)));
    const group = groups.get(minute);
    if (group === undefined) groups.set(minute, [item]);
    else group.push(item);
  }
  return groups;
}

/** The highest reading of each minute; null for a minute with none. */
export function maxInMinute<T extends { at: string }>(
  samples: readonly T[] | null,
  pick: (sample: T) => number | null,
): (minute: number) => Cell {
  const minutes = byMinute(samples ?? [], (sample) => sample.at);
  return (minute) => maxOf((minutes.get(minute) ?? []).flatMap((sample) => pick(sample) ?? []));
}

/**
 * One column for each value the items take, counting the items of that
 * value in each minute; the values in sorted order. A minute with none of
 * a value counts 0, because the items cover the run. A source the run
 * does not hold gives no columns.
 */
export function countsByValue<T>(input: {
  figure: string;
  items: readonly T[] | null;
  value: (item: T) => string | null;
  atOf: (item: T) => string;
  source: string;
}): Column[] {
  const { figure, items, value: valueOfItem, atOf, source } = input;
  if (items === null) return [];
  const values = [...new Set(items.flatMap((item) => valueOfItem(item) ?? []))].sort(compareText);
  const minutes = byMinute(items, atOf);
  return values.map((value) => ({
    name: splitName(figure, value),
    of: { figure, value, source },
    at: (minute) =>
      (minutes.get(minute) ?? []).filter((item) => valueOfItem(item) === value).length,
  }));
}
