import { describe, expect, it } from 'vitest';
import { countPushStream, pushStreamsOpen } from './pushStreams';

describe('pushStreamsOpen', () => {
  it('counts each stream until it is closed, and a stream closed twice only once', () => {
    const baseline = pushStreamsOpen();

    const first = countPushStream();
    const second = countPushStream();
    expect(pushStreamsOpen()).toBe(baseline + 2);

    first();
    first();
    expect(pushStreamsOpen()).toBe(baseline + 1);
    second();
    expect(pushStreamsOpen()).toBe(baseline);
  });
});
