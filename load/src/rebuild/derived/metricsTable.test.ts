import { describe, expect, it } from 'vitest';
import {
  STARTED,
  at,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { minuteTable } from '../table/index.ts';
import { metricsTable } from './metricsTable.ts';

describe('metricsTable', () => {
  const data = runDataWith({
    slices: [
      sliceDataWith(sliceWith(), {
        requests: [requestWith({ startedAt: at(10) }), requestWith({ startedAt: at(70) })],
      }),
    ],
  });
  const rows = metricsTable(minuteTable(data)).trimEnd().split('\n');

  it('has a header row, then one tab-separated row for each minute, with an empty cell for no figure', () => {
    const header = rows[0]?.split('\t') ?? [];
    expect(header[0]).toBe('minute');
    expect(rows).toHaveLength(5);
    expect(rows[1]?.split('\t')[0]).toBe(STARTED);

    const requests = header.indexOf('requests');
    expect(rows.slice(1).map((row) => row.split('\t')[requests])).toEqual(['1', '1', '0', '0']);
    const firstByte = header.indexOf('chat_first_byte_p50_ms');
    expect(rows.slice(1).map((row) => row.split('\t')[firstByte])).toEqual(['100', '100', '', '']);
  });

  it('is the same text every time it is made from the same run', () => {
    expect(metricsTable(minuteTable(data))).toBe(metricsTable(minuteTable(data)));
  });

  it('adds a last column that marks the minutes of the stretch kept after the run’s end', () => {
    const kept = runDataWith({
      slices: data.slices,
      afterRun: {
        from: at(180),
        to: at(360),
        exchanges: [],
        jobs: [],
        appRequests: [],
        appStates: [],
      },
    });
    const table = metricsTable(minuteTable(kept)).trimEnd().split('\n');

    expect(table[0]?.split('\t').at(-1)).toBe('after_run');
    expect(table.slice(1).map((row) => row.split('\t').at(-1))).toEqual([
      '0',
      '0',
      '0',
      '0',
      '1',
      '1',
    ]);
  });
});
