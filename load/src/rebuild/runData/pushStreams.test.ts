import { describe, expect, it } from 'vitest';
import type { RequestLine } from '../../records/index.ts';
import { endedPushStreamsOf, isCutAndReopenedIn } from './pushStreams.ts';
import { at, requestWith, runDataWith, sliceDataWith, sliceWith } from './testing.ts';

/** A push stream of `user` that opened at `seconds` and stayed open `lastedSeconds`. */
const push = (
  user: number,
  seconds: number,
  lastedSeconds: number,
  overrides: Partial<RequestLine> = {},
): RequestLine =>
  requestWith({
    kind: 'push',
    user,
    startedAt: at(seconds),
    firstByteMs: 20,
    totalMs: lastedSeconds * 1_000,
    status: 200,
    outcome: 'held',
    ...overrides,
  });

const dataWith = (...lines: RequestLine[]) =>
  runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] });

describe('the push streams that ended early', () => {
  it('finds streams the server closed or cut off, with when they ended and how long they lasted', () => {
    const data = dataWith(
      push(0, 10, 100, { outcome: 'failed' }),
      push(1, 10, 50, { outcome: 'dropped' }),
      push(2, 10, 160),
    );

    expect(
      endedPushStreamsOf(data).map(({ line, endedAt, lastedMs, cut }) => ({
        user: line.user,
        endedAt,
        lastedMs,
        cut,
      })),
    ).toEqual([
      { user: 1, endedAt: Date.parse(at(60)), lastedMs: 50_000, cut: false },
      { user: 0, endedAt: Date.parse(at(110)), lastedMs: 100_000, cut: true },
    ]);
  });

  it('leaves out a stream that never opened, and one its user let go at the run’s end', () => {
    const data = dataWith(
      push(0, 10, 1, { status: null, outcome: 'failed' }),
      push(1, 10, 1, { status: 502, outcome: 'failed' }),
      push(2, 10, 150, { outcome: 'held' }),
    );

    expect(endedPushStreamsOf(data)).toEqual([]);
  });

  it('counts a stream as reopened only when its own user opened another within ten seconds', () => {
    const data = dataWith(
      push(0, 10, 40, { outcome: 'failed' }),
      push(0, 53, 100),
      push(1, 10, 40, { outcome: 'failed' }),
      push(1, 61, 100),
      push(2, 52, 100),
    );

    expect(
      endedPushStreamsOf(data).map(({ line, reopened }) => ({ user: line.user, reopened })),
    ).toEqual([
      { user: 0, reopened: true },
      { user: 1, reopened: false },
    ]);
  });

  it('tells a stream cut off and reopened apart from one that was not reopened, or closed cleanly', () => {
    const cutReopened = push(0, 10, 40, { outcome: 'failed' });
    const cutLeft = push(1, 10, 40, { outcome: 'failed' });
    const closedReopened = push(2, 10, 40, { outcome: 'dropped' });
    const isCutAndReopened = isCutAndReopenedIn(
      dataWith(cutReopened, push(0, 51, 100), cutLeft, closedReopened, push(2, 51, 100)),
    );

    expect([cutReopened, cutLeft, closedReopened].map(isCutAndReopened)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe('a push stream that lasted no time at all', () => {
  it('is not counted as reopened by its own start', () => {
    const [stream] = endedPushStreamsOf(dataWith(push(0, 10, 0, { outcome: 'failed' })));
    expect(stream?.reopened).toBe(false);
  });
});
