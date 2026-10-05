import type { UserFact } from '@/services/api';

type DateDetail = 'month' | 'day';

const DATE_OPTIONS: Record<DateDetail, Intl.DateTimeFormatOptions> = {
  month: { month: 'short', year: 'numeric' },
  day: { day: 'numeric', month: 'short', year: 'numeric' },
};

/** A stated date is a calendar day, so it reads in UTC and never shifts by a day. */
export function formattedStatedDate(validAt: string, detail: DateDetail): string {
  return new Date(validAt).toLocaleDateString('en-US', {
    ...DATE_OPTIONS[detail],
    timeZone: 'UTC',
  });
}

export function formattedNotedDate(createdAt: string, detail: DateDetail): string {
  return new Date(createdAt).toLocaleDateString('en-US', DATE_OPTIONS[detail]);
}

/** When a Fact became true if stated, else when it was noted, in epoch milliseconds. */
export function factRecencyMs(fact: UserFact): number {
  return new Date(fact.validAt ?? fact.createdAt).getTime();
}
