import { describe, expect, it } from 'vitest';
import type { AwsEvent } from '../../records/index.ts';
import { ENDED, STARTED, at, manifestWith, runDataWith, sliceWith } from '../runData/testing.ts';
import { timelineOf } from './timeline.ts';

const awsEvent = (seconds: number, summary: string): AwsEvent => ({
  at: at(seconds),
  source: 'scaling',
  resource: 'AriAwsApp-ServicesWorkerService-1',
  summary,
  detail: {},
});

describe('timelineOf', () => {
  const slice = sliceWith({
    hold: { from: at(60), to: at(150) },
    down: [{ from: at(100), to: at(130), reason: 'its generator stopped' }],
  });
  const data = runDataWith({
    manifest: manifestWith({
      slices: [slice],
      seal: { status: 'complete', sealedAt: at(200) },
    }),
    awsEvents: [awsEvent(90, 'desired count 2 to 4'), awsEvent(30, 'alarm went off')],
  });
  const entries = timelineOf(data);

  it('puts the run’s events, when each slice held and went down, AWS’s events and the seal on one timeline, oldest first', () => {
    expect(entries.map(({ text }) => text)).toEqual([
      'run started',
      'scaling AriAwsApp-ServicesWorkerService-1: alarm went off',
      'generator 0 holding users 0 to 9',
      'scaling AriAwsApp-ServicesWorkerService-1: desired count 2 to 4',
      'users 0 to 9 down for 30 s: its generator stopped',
      'run ended (finished)',
      'run sealed as complete',
    ]);
    expect(entries[0]).toEqual({ at: STARTED, text: 'run started' });
    expect(entries.at(-2)).toEqual({ at: ENDED, text: 'run ended (finished)' });
  });

  it('says nothing of holding for a slice that never held', () => {
    const neverHeld = runDataWith({
      manifest: manifestWith({ slices: [sliceWith({ hold: null })] }),
    });

    expect(timelineOf(neverHeld).some(({ text }) => text.includes('holding'))).toBe(false);
  });

  it('keeps events of the same moment in the order they were recorded', () => {
    const same = runDataWith({
      awsEvents: [awsEvent(50, 'first'), awsEvent(50, 'second')],
    });

    const texts = timelineOf(same).map(({ text }) => text);
    expect(texts.findIndex((text) => text.includes('first'))).toBeLessThan(
      texts.findIndex((text) => text.includes('second')),
    );
  });
});
