import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../../records/layout.ts';
import { SILENCE_LIMIT_MS } from '../moments.ts';
import { STARTED, at, manifestWith, runDataWith, sliceWith } from '../runData/testing.ts';
import type { RunData } from '../types.ts';
import { findGaps } from './gaps.ts';

const hostAt = (seconds: number) => ({
  at: at(seconds),
  cpuPercent: 10,
  perCorePercent: [],
  memoryAvailableBytes: 0,
  memoryUsedPercent: 40,
  swapUsedBytes: 0,
  swapInBytes: 0,
  swapOutBytes: 0,
  loadAverage1: 0,
});

/** A host reading every ten seconds from `from` to `to`. */
const hostBetween = (from: number, to: number) =>
  Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, index) => hostAt(from + index * 10));

/** A run whose host was read all the way through, and whose other sampled sources were never collected. */
const runWith = (overrides: Partial<RunData> = {}) =>
  runDataWith({ host: hostBetween(0, 180), appStates: null, ...overrides });

describe('findGaps', () => {
  it('finds none in a run whose sources are whole', () => {
    expect(findGaps(runWith())).toEqual([]);
  });

  it('names the window a sampled series went silent, and leaves a short pause alone', () => {
    const quiet = SILENCE_LIMIT_MS / 1_000;
    const data = runWith({
      host: [...hostBetween(0, 0), hostAt(quiet), ...hostBetween(quiet + 60, 180)],
    });

    expect(findGaps(data)).toEqual([
      {
        source: LAYOUT.hostSamples,
        from: at(quiet),
        to: at(quiet + 60),
        reason: 'no reading for 60 s',
      },
    ]);
  });

  it('shows a sampler that died mid-run as a gap to the end of the run', () => {
    expect(findGaps(runWith({ host: hostBetween(0, 60) }))).toEqual([
      { source: LAYOUT.hostSamples, from: at(60), to: at(180), reason: 'no reading for 120 s' },
    ]);
  });

  it('shows a sampler that started late as a gap from the start of the run', () => {
    expect(findGaps(runWith({ host: hostBetween(100, 180) }))).toEqual([
      { source: LAYOUT.hostSamples, from: at(0), to: at(100), reason: 'no reading for 100 s' },
    ]);
  });

  it('names a source with no readings at all for the whole run', () => {
    expect(findGaps(runWith({ host: [] }))).toEqual([
      {
        source: LAYOUT.hostSamples,
        from: at(0),
        to: at(180),
        reason: 'no readings at all for 180 s',
      },
    ]);
  });

  it('leaves a source whose file was never collected to the gaps of its file', () => {
    expect(findGaps(runWith({ host: null }))).toEqual([]);
  });

  it('reads a run that never recorded its end up to its last record, not to its start', () => {
    const data = runWith({
      manifest: manifestWith({ endedAt: null }),
      events: [{ kind: 'run-started', at: STARTED }],
      host: hostBetween(0, 100),
      trouble: [{ path: LAYOUT.exchanges, reason: 'is gone since the run was sealed' }],
    });

    expect(findGaps(data)).toEqual([
      {
        source: LAYOUT.exchanges,
        from: STARTED,
        to: at(100),
        reason: 'is gone since the run was sealed',
      },
    ]);
  });

  it('names a source whose file is gone, with the window of the whole run', () => {
    const data = runWith({
      trouble: [{ path: LAYOUT.exchanges, reason: 'is gone since the run was sealed' }],
    });

    expect(findGaps(data)).toEqual([
      {
        source: LAYOUT.exchanges,
        from: data.manifest.startedAt,
        to: data.manifest.endedAt,
        reason: 'is gone since the run was sealed',
      },
    ]);
  });

  it('carries what the archive found lacking into the gaps', () => {
    const manifest = manifestWith({
      seal: {
        status: 'incomplete',
        sealedAt: at(181),
        reasons: [
          { check: 'services-recorded', detail: 'postgres: its metrics are missing', path: 'x' },
        ],
      },
    });

    expect(findGaps(runWith({ manifest }))).toMatchObject([
      { source: 'x', reason: 'the archive found: postgres: its metrics are missing' },
    ]);
  });

  describe('a slice that was down', () => {
    it('is named as a gap of the slice, for each window the manifest records', () => {
      const slice = sliceWith({
        down: [
          {
            from: at(60),
            to: at(125),
            reason: 'its generator stopped; a new generator brought the users back',
          },
          { from: at(150), to: at(160), reason: 'its generator stopped' },
        ],
      });

      expect(findGaps(runWith({ manifest: manifestWith({ slices: [slice] }) }))).toEqual([
        {
          source: 'generator 0',
          from: at(60),
          to: at(125),
          reason:
            'users 0 to 9 were down for 65 s: its generator stopped; a new generator brought the users back',
        },
        {
          source: 'generator 0',
          from: at(150),
          to: at(160),
          reason: 'users 0 to 9 were down for 10 s: its generator stopped',
        },
      ]);
    });

    it('is no gap for a slice that was never down', () => {
      const manifest = manifestWith({
        slices: [sliceWith(), sliceWith({ generator: 1, firstUser: 10 })],
      });

      expect(findGaps(runWith({ manifest }))).toEqual([]);
    });
  });
});

describe('findGaps and the CloudWatch metrics', () => {
  /** A file of one resource's metrics whose two series have points at the given minutes of the run. */
  const metricsAt = (cpuMinutes: readonly number[], connectionMinutes: readonly number[]) => [
    {
      resource: 'database',
      path: 'metrics/aws/database.jsonl',
      series: [
        { name: 'CPUUtilization', minutes: cpuMinutes },
        { name: 'DatabaseConnections', minutes: connectionMinutes },
      ].map(({ name, minutes }) => ({
        namespace: 'AWS/RDS',
        name,
        dimensions: { DBInstanceIdentifier: 'db' },
        statistic: 'Maximum',
        periodSeconds: 60,
        points: minutes.map((minute) => ({ at: at(minute * 60), value: 1 })),
      })),
    },
  ];

  it('names a minute in which none of a file’s metrics has a point, between two that have one', () => {
    expect(findGaps(runWith({ awsMetrics: metricsAt([0, 2], []) }))).toEqual([
      {
        source: 'metrics/aws/database.jsonl',
        from: at(0),
        to: at(120),
        reason: 'no reading for 120 s',
      },
    ]);
  });

  it('finds no gap where another metric of the same file has the missing minute', () => {
    expect(findGaps(runWith({ awsMetrics: metricsAt([0, 2], [1]) }))).toEqual([]);
  });

  it('leaves the run’s edges alone, because a resource may come up after the run starts', () => {
    expect(findGaps(runWith({ awsMetrics: metricsAt([1, 2], []) }))).toEqual([]);
  });

  it('looks only at the run’s minutes, not at the raise around it', () => {
    expect(findGaps(runWith({ awsMetrics: metricsAt([-10, 0, 1, 2], []) }))).toEqual([]);
  });
});
