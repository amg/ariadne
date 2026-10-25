import { describe, expect, it } from 'vitest';
import { at, requestWith, runDataWith, sliceDataWith, sliceWith } from '../runData/testing.ts';
import { summarizeSlices } from './slices.ts';

const lines = (count: number, outcome: 'streamed' | 'failed' = 'streamed') =>
  Array.from({ length: count }, () => requestWith({ outcome }));

const untouched = sliceWith({ generator: 0, firstUser: 0, userCount: 10 });
const lost = sliceWith({
  generator: 1,
  firstUser: 10,
  userCount: 5,
  down: [
    { from: at(60), to: at(122), reason: 'x' },
    { from: at(200), to: at(230), reason: 'y' },
  ],
});

const data = runDataWith({
  slices: [
    sliceDataWith(lost, { requests: [...lines(5), ...lines(1, 'failed')] }),
    sliceDataWith(untouched, { requests: lines(7) }),
  ],
});

describe('summarizeSlices', () => {
  it('lists the slices in generator order, each as its own lines make it', () => {
    expect(summarizeSlices(data)[0]).toEqual({
      generator: 0,
      firstUser: 0,
      lastUser: 9,
      requests: 7,
      failedRequests: 0,
      chatsStreamed: 7,
      down: [],
      downSeconds: 0,
    });
  });

  it('carries every window a slice was down, and adds up how long', () => {
    expect(summarizeSlices(data)[1]).toMatchObject({
      generator: 1,
      firstUser: 10,
      lastUser: 14,
      requests: 6,
      failedRequests: 1,
      chatsStreamed: 5,
      down: lost.down,
      downSeconds: 92,
    });
  });

  it('counts a slice whose request lines could not be read as having none', () => {
    const unread = runDataWith({ slices: [{ slice: untouched, requests: null, states: null }] });

    expect(summarizeSlices(unread)[0]?.requests).toBe(0);
  });
});
