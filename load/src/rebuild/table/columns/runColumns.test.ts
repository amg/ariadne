import { describe, expect, it } from 'vitest';
import type { RequestLine } from '../../../records/index.ts';
import { MINUTE_MS } from '../../moments.ts';
import {
  STARTED,
  at,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../../runData/testing.ts';
import { pushStreamColumns, requestColumns } from './runColumns.ts';

const MINUTE_0 = Date.parse(STARTED);

const push = (
  user: number,
  seconds: number,
  lastedSeconds: number,
  outcome: RequestLine['outcome'],
): RequestLine =>
  requestWith({
    kind: 'push',
    user,
    startedAt: at(seconds),
    totalMs: lastedSeconds * 1_000,
    status: 200,
    outcome,
  });

const dataWith = (...lines: RequestLine[]) =>
  runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] });

/** Each column's figure in one minute of the run, by the column's name. */
function figuresIn(columns: ReturnType<typeof pushStreamColumns>, minute: number) {
  return Object.fromEntries(
    columns.map((column) => [column.name, column.at(MINUTE_0 + minute * MINUTE_MS)]),
  );
}

describe('pushStreamColumns', () => {
  // Users 0 and 1 open in the first minute; both streams end in the third, after about two minutes.
  const data = dataWith(
    push(0, 5, 125, 'failed'),
    push(0, 133, 30, 'held'),
    push(1, 10, 110, 'dropped'),
    push(2, 10, 20, 'failed'),
  );

  it('counts the streams opened by the minute they opened in', () => {
    expect(figuresIn(pushStreamColumns(data), 0)).toMatchObject({ push_streams_opened: 3 });
    expect(figuresIn(pushStreamColumns(data), 2)).toMatchObject({ push_streams_opened: 1 });
  });

  it('counts the streams that ended early by the minute they ended in, how they ended, and how long they lasted', () => {
    expect(figuresIn(pushStreamColumns(data), 0)).toMatchObject({
      push_streams_ended_early: 1,
      push_streams_cut: 1,
      push_streams_reopened: 0,
      push_streams_ended_lasted_under_1m: 1,
    });
    expect(figuresIn(pushStreamColumns(data), 2)).toMatchObject({
      push_streams_ended_early: 2,
      push_streams_cut: 1,
      push_streams_reopened: 1,
      push_streams_ended_lasted_p50_s: 110,
      push_streams_ended_lasted_under_1m: 0,
      push_streams_ended_lasted_1m_to_5m: 2,
    });
  });

  it('keeps the bands of how long a stream lasted in their order, shortest first', () => {
    expect(
      pushStreamColumns(data)
        .filter((column) => column.of?.figure === 'push_streams_ended_lasted')
        .map((column) => column.of?.value),
    ).toEqual(['under_1m', '1m_to_5m', '5m_to_15m', '15m_or_more']);
  });

  it('has no columns for a run whose request lines are all missing', () => {
    expect(
      pushStreamColumns(runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: null })] })),
    ).toEqual([]);
  });
});

describe('requestColumns', () => {
  it('does not count a push stream cut off and reopened within seconds as a failure', () => {
    const data = dataWith(
      push(0, 5, 20, 'failed'),
      push(0, 26, 30, 'held'),
      push(1, 5, 20, 'failed'),
    );

    expect(figuresIn(requestColumns(data), 0)).toMatchObject({ failures: 1, failures_push: 1 });
  });
});
