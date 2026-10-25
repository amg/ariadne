import { describe, expect, it } from 'vitest';
import { requestWith, runDataWith, sliceDataWith, sliceWith } from '../runData/testing.ts';
import { failureCounts } from './failures.ts';

const failed = (
  kind: 'signin' | 'chat',
  status: number | null,
  errorCode: string | null,
  user = 0,
) => requestWith({ kind, status, errorCode, outcome: 'failed', user });

const dataWith = (...lines: ReturnType<typeof requestWith>[]) =>
  runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] });

describe('failureCounts', () => {
  it('counts each kind, status and error code on its own, and leaves out requests that did not fail', () => {
    const data = dataWith(
      failed('chat', 503, 'overloaded'),
      failed('chat', 503, 'overloaded', 1),
      failed('chat', 429, 'rate_limited'),
      failed('chat', 503, 'unavailable'),
      requestWith({ kind: 'chat', outcome: 'streamed' }),
    );

    expect(failureCounts(data)).toEqual([
      { kind: 'chat', status: 429, errorCode: 'rate_limited', count: 1 },
      { kind: 'chat', status: 503, errorCode: 'overloaded', count: 2 },
      { kind: 'chat', status: 503, errorCode: 'unavailable', count: 1 },
    ]);
  });

  it('lists kinds in the order a user meets them, and a failure with no response before the others', () => {
    const data = dataWith(
      failed('chat', 500, null),
      failed('signin', 401, 'bad_credentials'),
      failed('signin', null, 'unreachable'),
    );

    expect(failureCounts(data).map(({ kind, status }) => [kind, status])).toEqual([
      ['signin', null],
      ['signin', 401],
      ['chat', 500],
    ]);
  });

  it('is empty when nothing failed', () => {
    expect(failureCounts(dataWith(requestWith()))).toEqual([]);
  });
});

describe('failureCounts of push streams', () => {
  const push = (user: number, seconds: number, outcome: 'failed' | 'held') =>
    requestWith({
      kind: 'push',
      user,
      startedAt: new Date(Date.parse('2026-10-15T00:00:00.000Z') + seconds * 1_000).toISOString(),
      totalMs: 30_000,
      status: 200,
      outcome,
    });

  it('leaves out a stream that was cut off and reopened within seconds, and keeps one that was not reopened', () => {
    const data = dataWith(push(0, 0, 'failed'), push(0, 31, 'held'), push(1, 0, 'failed'));

    expect(failureCounts(data)).toEqual([{ kind: 'push', status: 200, errorCode: null, count: 1 }]);
  });
});
