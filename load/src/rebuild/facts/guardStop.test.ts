import { describe, expect, it } from 'vitest';
import { at, manifestWith, runDataWith, sliceWith } from '../runData/testing.ts';
import { guardStopOf } from './guardStop.ts';

describe('guardStopOf', () => {
  const tripped = {
    kind: 'guard-tripped',
    at: at(100),
    line: 'host-cpu',
    observed: 81,
    limit: 70,
    message: 'host CPU was 81.0%, over the 70% line',
  } as const;

  it('is null when no line stopped the run', () => {
    expect(guardStopOf(runDataWith())).toBeNull();
  });

  it('names the line, and the window from the stop to the end of the plan it cut short', () => {
    const manifest = manifestWith({
      slices: [sliceWith({ endedAt: at(100), hold: { from: at(10), to: at(400) } })],
    });
    const data = runDataWith({ manifest, events: [tripped] });

    expect(guardStopOf(data)).toMatchObject({
      line: 'host-cpu',
      observed: 81,
      limit: 70,
      from: at(100),
      to: at(400),
    });
  });

  it('ends its window with the run when the plan ended sooner', () => {
    expect(guardStopOf(runDataWith({ events: [tripped] }))).toMatchObject({
      from: at(100),
      to: at(180),
    });
  });
});
