import { describe, expect, it } from 'vitest';
import { awaitMetricsUntil } from './metricsWait.ts';
import type { MetricTarget } from './raise.ts';
import type { RaiseSources } from './sources.ts';

const until = new Date('2026-10-15T00:17:30.000Z');
const probe: MetricTarget = { label: 'ecs-service-api', namespaces: ['AWS/ECS'], dimensions: {} };

/** Just as the stretch ends, as when a run has only just been archived. */
const now = () => until;

/** The last whole minute that ends by the stretch's end. */
const LAST_MINUTE = '2026-10-15T00:16:00.000Z';

const series = (...times: string[]) => [
  {
    namespace: 'AWS/ECS',
    name: 'CPUUtilization',
    dimensions: {},
    statistic: 'Average' as const,
    periodSeconds: 60,
    points: times.map((at) => ({ at, value: 1 })),
  },
];

function delivering(
  ...answers: string[][]
): RaiseSources['metricSeries'] & { asked: () => number } {
  let asked = 0;
  const ask = async () => series(...(answers[Math.min(asked++, answers.length - 1)] ?? []));
  return Object.assign(ask, { asked: () => asked });
}

function waiting(mostMs = 120_000) {
  const slept: number[] = [];
  return {
    slept,
    wait: {
      pollMs: 30_000,
      mostMs,
      settleMs: 5_000,
      sleep: async (ms: number) => void slept.push(ms),
    },
  };
}

describe('awaitMetricsUntil', () => {
  it('returns at once when the end of the stretch was delivered long ago', async () => {
    const { slept, wait } = waiting();

    await awaitMetricsUntil({ metrics: delivering([LAST_MINUTE]), probe, until, wait, now });

    expect(slept).toEqual([]);
  });

  it('waits for the last whole minute of the stretch, then once more for slower resources', async () => {
    const { slept, wait } = waiting();
    const metrics = delivering(
      ['2026-10-15T00:13:00.000Z'],
      ['2026-10-15T00:15:00.000Z'],
      [LAST_MINUTE],
    );

    await awaitMetricsUntil({ metrics, probe, until, wait, now });

    expect(slept).toEqual([30_000, 30_000, 5_000]);
  });

  it('gives up after the longest wait when the minute never comes, without waiting for slower resources', async () => {
    const { slept, wait } = waiting(90_000);

    await awaitMetricsUntil({
      metrics: delivering(['2026-10-15T00:13:00.000Z']),
      probe,
      until,
      wait,
      now,
    });

    expect(slept).toEqual([30_000, 30_000, 30_000]);
  });

  it('does not wait when the stretch ended so long ago that nothing is still to be delivered', async () => {
    const { slept, wait } = waiting();
    const metrics = delivering(['2026-10-15T00:13:00.000Z']);

    await awaitMetricsUntil({
      metrics,
      probe,
      until,
      wait,
      now: () => new Date(until.getTime() + 24 * 60 * 60_000),
    });

    expect(slept).toEqual([]);
    expect(metrics.asked()).toBe(0);
  });
});
