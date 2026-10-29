import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT } from '../../records/index.ts';
import type { RunDescription } from '../manifestBuilder.ts';
import { archiveAwsRun, beginAwsRun } from './awsArchive.ts';
import { generatorTaskKeeper } from './keptTasks.ts';
import { SourceUnavailable } from './sources.ts';
import { ENDED, RUN, STARTED, at, fakeSources, generatorTask, raise } from './testing.ts';
import { unsealedRunsSince } from './unsealed.ts';

const description: RunDescription = {
  runId: RUN,
  step: 'smoke',
  config: { name: 'smoke', load: { rampSeconds: 20, holdSeconds: 60, users: 2 } },
  target: 'aws-prod',
  loadPath: 'direct',
  images: { backend: 'tag-1' },
  commits: { app: { sha: 'abc', dirty: false }, harness: { sha: 'abc', dirty: false } },
  limits: {},
  startedAt: STARTED,
  endedAt: null,
  trailingEndsAt: null,
};

const noWait = { pollMs: 1, mostMs: 0, settleMs: 0, sleep: async () => {} };

let runsDir: string;
let folder: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'runs-'));
  folder = join(runsDir, RUN);
});

const begin = () => beginAwsRun({ folder, raise, description });

function archive(
  overrides: Partial<Parameters<typeof archiveAwsRun>[0]> & {
    sources?: ReturnType<typeof fakeSources>;
  } = {},
) {
  const { sources = fakeSources(), ...rest } = overrides;
  return archiveAwsRun({
    runId: RUN,
    folder,
    sourcesFor: () => sources,
    wait: noWait,
    endedAt: ENDED,
    now: () => new Date(ENDED),
    ...rest,
  });
}

/** Every file the run's folder holds, by its path in the folder. */
const keysOf = () =>
  Object.keys(snapshotOf(folder))
    .map((file) => relative(folder, file))
    .sort();

function snapshotOf(root: string) {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[full] = `${statSync(full).mtimeMs}:${readFileSync(full, 'utf8')}`;
    }
  };
  walk(root);
  return files;
}

describe('beginAwsRun', () => {
  it('records how the run began in its folder, leaving it unsealed', async () => {
    await begin();

    expect(keysOf()).toEqual(['.sources/pending-run.json', '.sources/raise.json']);
  });
});

describe('archiveAwsRun', () => {
  it('seals a run complete with every source of the layout present', async () => {
    await begin();

    const result = await archive();

    expect(result.status).toBe('sealed');
    expect(result.manifest.seal).toMatchObject({ status: 'complete' });
    const keys = keysOf();
    for (const path of [
      LAYOUT.manifest,
      LAYOUT.events,
      LAYOUT.awsEvents,
      LAYOUT.requests(0),
      LAYOUT.generatorState(0),
      LAYOUT.generatorReport(0, 1),
      LAYOUT.generatorLog(0, 1),
      ...['api', 'worker', 'auth'].map((label) => LAYOUT.processLog(label)),
      LAYOUT.exchanges,
      LAYOUT.jobs,
      LAYOUT.appState,
      LAYOUT.awsMetrics('ecs-service-api'),
      LAYOUT.awsMetrics('database'),
      LAYOUT.awsMetrics('cache'),
      LAYOUT.awsMetrics('load-balancer'),
      LAYOUT.insights,
    ]) {
      expect(keys, path).toContain(`${path}`);
    }
    for (const label of ['mock', 'web']) {
      expect(keys).not.toContain(`${LAYOUT.processLog(label)}`);
    }
  });

  it('lists every file the folder holds, with its checksum, in the manifest it writes last', async () => {
    await begin();

    const { manifest } = await archive();

    const listed = manifest.files.map((file) => `${file.path}`).sort();
    expect(listed).toEqual(keysOf().filter((key) => !key.endsWith(LAYOUT.manifest)));
    for (const file of manifest.files) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(folder, file.path)))
          .digest('hex'),
      ).toBe(file.sha256);
    }
  });

  it('takes the sources it worked from out of the folder once the run is sealed', async () => {
    await begin();

    await archive();

    expect(keysOf().filter((key) => key.includes('.sources'))).toEqual([]);
    expect(existsSync(join(folder, LAYOUT.sourcesDir))).toBe(false);
  });

  it('records each generator from its task: where it ran, when, and how it stopped', async () => {
    await begin();

    const { manifest } = await archive();

    expect(manifest.slices).toEqual([
      expect.objectContaining({
        generator: 0,
        firstUser: 0,
        userCount: 2,
        startedAt: at(5),
        endedAt: at(115),
        down: [],
        attempts: [
          expect.objectContaining({
            attempt: 1,
            task: 'abc123',
            spot: true,
            startedAt: at(5),
            stoppedAt: at(115),
            stoppedBecause: 'finished',
          }),
        ],
      }),
    ]);
    expect(manifest).toMatchObject({ step: 'smoke', target: 'aws-prod', endedAt: ENDED });
  });

  it('records a generator ECS has forgotten from the task the run kept as it stopped', async () => {
    await begin();
    await generatorTaskKeeper(folder).keep({
      ...generatorTask,
      stopCode: 'SpotInterruption',
      stoppedReason: 'Your Spot Task was interrupted.',
    });
    const forgotten = fakeSources({ tasks: async () => [] });

    const { manifest } = await archive({ sources: forgotten });

    expect(manifest.slices.flatMap(({ attempts }) => attempts)).toEqual([
      expect.objectContaining({
        task: 'abc123',
        stoppedBecause: 'interrupted',
        stopDetail: 'SpotInterruption: Your Spot Task was interrupted.',
      }),
    ]);
  });

  it('sorts the API’s and the worker’s records out of their logs', async () => {
    await begin();

    await archive();

    const lines = (path: string) => readFileSync(join(folder, path), 'utf8').trim().split('\n');
    expect(lines(LAYOUT.exchanges)).toHaveLength(1);
    expect(lines(LAYOUT.jobs)).toHaveLength(1);
    expect(lines(LAYOUT.appState)).toHaveLength(1);
  });

  it('changes nothing when the same run is archived again, and does not ask AWS for anything', async () => {
    await begin();
    await archive();
    const before = snapshotOf(folder);
    const again = fakeSources();

    const result = await archive({ sources: again });

    expect(result.status).toBe('already-sealed');
    expect(snapshotOf(folder)).toEqual(before);
    expect(Object.values(again.calls).every((count) => count === 0)).toBe(true);
  });

  it('resumes an archive that stopped, without asking again for what it already has', async () => {
    await begin();
    const failing = fakeSources({
      serviceEvents: async () => {
        throw new Error('throttled');
      },
    });

    await expect(archive({ sources: failing })).rejects.toThrowError('throttled');

    expect(keysOf().some((key) => key.endsWith(LAYOUT.manifest))).toBe(false);
    const resumed = fakeSources();
    const result = await archive({ sources: resumed });
    expect(result.status).toBe('sealed');
    expect(resumed.calls.logMessages).toBe(0);
    expect(resumed.calls.metricSeries).toBe(1);
    expect(resumed.calls.serviceEvents).toBeGreaterThan(0);
  });

  it('seals as incomplete when a source is already gone, naming what could not be collected', async () => {
    await begin();
    const gone = fakeSources({
      scalingActivity: async () => {
        throw new SourceUnavailable('the service is gone');
      },
    });

    const { manifest } = await archive({ sources: gone });

    expect(manifest.seal.status).toBe('incomplete');
    const reasons = manifest.seal.status === 'incomplete' ? manifest.seal.reasons : [];
    expect(reasons.map((reason) => reason.detail)).toEqual([
      expect.stringContaining('the scaling activity'),
    ]);
  });

  it('keeps the backend’s records of this run only, when the raise carried an earlier run', async () => {
    await begin();
    const base = fakeSources();
    const earlier = JSON.stringify({
      level: 30,
      appRecord: { kind: 'exchange', userId: 'old', arrivedAt: '2026-10-15T00:05:00.000Z' },
    });
    const sources = fakeSources({
      logMessages: async function* (group, stream, window) {
        for await (const batch of base.logMessages(group, stream, window)) {
          yield group.endsWith('/api')
            ? [{ at: batch[0]?.at ?? '', message: earlier }, ...batch]
            : batch;
        }
      },
    });

    await archive({ sources });

    const lines = readFileSync(join(folder, LAYOUT.exchanges), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('old');
    expect(readFileSync(join(folder, LAYOUT.processLog('api')), 'utf8')).toContain('old');
  });

  describe('the stretch after the run', () => {
    const exchangeAt = (arrivedAt: string): string =>
      JSON.stringify({ level: 30, appRecord: { kind: 'exchange', userId: 'u', arrivedAt } });
    const AFTER = '2026-10-15T00:14:00.000Z';
    const MUCH_LATER = '2026-10-15T00:40:00.000Z';

    it('is recorded as ending five minutes after the run did', async () => {
      await begin();

      const { manifest } = await archive();

      expect(manifest.trailingEndsAt).toBe('2026-10-15T00:17:00.000Z');
    });

    it('is kept in the backend’s records, which stop where it ends', async () => {
      await begin();
      const base = fakeSources();
      const sources = fakeSources({
        logMessages: async function* (group, stream, window) {
          for await (const batch of base.logMessages(group, stream, window)) {
            yield group.endsWith('/api')
              ? [
                  ...batch,
                  { at: AFTER, message: exchangeAt(AFTER) },
                  { at: MUCH_LATER, message: exchangeAt(MUCH_LATER) },
                ]
              : batch;
          }
        },
      });

      await archive({ sources });

      const arrivals = readFileSync(join(folder, LAYOUT.exchanges), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).arrivedAt);
      expect(arrivals).toContain(AFTER);
      expect(arrivals).not.toContain(MUCH_LATER);
    });

    it('is collected only after CloudWatch has delivered it', async () => {
      await begin();
      const base = fakeSources();
      const delivered = '2026-10-15T00:16:00.000Z';
      let asked = 0;
      const sources = fakeSources({
        metricSeries: async (target, window) => {
          const found = await base.metricSeries(target, window);
          asked += 1;
          return asked < 3
            ? found
            : found.map((metric) => ({
                ...metric,
                points: [...metric.points, { at: delivered, value: 1 }],
              }));
        },
      });

      await archive({
        sources,
        wait: { pollMs: 1, mostMs: 10, settleMs: 0, sleep: async () => {} },
      });

      const kept = readFileSync(join(folder, LAYOUT.awsMetrics('ecs-service-api')), 'utf8');
      expect(kept).toContain(delivered);
    });
  });

  it('keeps each line of a service’s log after when it was logged and the stream it came from', async () => {
    await begin();

    await archive();

    const [first] = readFileSync(join(folder, LAYOUT.processLog('api')), 'utf8').split('\n');
    expect(first).toBe(`${at(5)} api/main/t1 listening`);
  });

  it('works out how the run ended from its generators when nobody says', async () => {
    await begin();

    await archive();

    const events = readFileSync(join(folder, LAYOUT.events), 'utf8').trim().split('\n');
    expect(JSON.parse(events.at(-1) ?? '')).toMatchObject({
      kind: 'run-ended',
      outcome: 'finished',
    });
  });

  it('works out when the run ended from its generators when nothing says', async () => {
    await begin();

    const { manifest } = await archive({ endedAt: undefined });

    expect(manifest.endedAt).toBe(at(115));
  });

  it('refuses a run that was never begun', async () => {
    await expect(archive()).rejects.toThrowError('holds no record of how');
  });
});

describe('resuming an archive', () => {
  it('still seals incomplete, after resuming, when a source was gone the first time', async () => {
    await begin();
    const gone = fakeSources({
      scalingActivity: async () => {
        throw new SourceUnavailable('the service is gone');
      },
      databaseInsights: async () => {
        throw new Error('throttled');
      },
    });
    await expect(archive({ sources: gone })).rejects.toThrowError('throttled');

    const { manifest } = await archive({ sources: fakeSources() });

    const reasons = manifest.seal.status === 'incomplete' ? manifest.seal.reasons : [];
    expect(reasons.map((reason) => reason.detail)).toEqual([
      expect.stringContaining('the scaling activity'),
    ]);
  });

  it('keeps no file for a log group that was gone, so that it is asked for again', async () => {
    await begin();
    const goneLogs = (): ReturnType<typeof fakeSources> => {
      const sources = fakeSources();
      return fakeSources({
        logStreams: async (group, window) => {
          if (group.endsWith('/api')) throw new SourceUnavailable('the log group is gone');
          return sources.logStreams(group, window);
        },
        databaseInsights: async () => {
          throw new Error('throttled');
        },
      });
    };
    await expect(archive({ sources: goneLogs() })).rejects.toThrowError('throttled');
    expect(existsSync(join(folder, LAYOUT.processLog('api')))).toBe(false);

    const { manifest } = await archive({
      sources: fakeSources({
        logStreams: async (group) => {
          if (group.endsWith('/api')) throw new SourceUnavailable('the log group is gone');
          return [];
        },
      }),
    });

    const reasons = manifest.seal.status === 'incomplete' ? manifest.seal.reasons : [];
    expect(reasons).toContainEqual(
      expect.objectContaining({
        check: 'sources-collected',
        detail: expect.stringContaining('the log group api'),
      }),
    );
    expect(manifest.files.map((file) => file.path)).not.toContain(LAYOUT.processLog('api'));
  });
});

describe('what a run must hold to pass', () => {
  it('seals as incomplete when no generator task was found', async () => {
    await begin();

    const { manifest } = await archive({ sources: fakeSources({ tasks: async () => [] }) });

    const reasons = manifest.seal.status === 'incomplete' ? manifest.seal.reasons : [];
    expect(reasons).toContainEqual(
      expect.objectContaining({
        check: 'request-coverage',
        detail: expect.stringContaining('no generator task'),
      }),
    );
  });
});

describe('unsealedRunsSince', () => {
  const RAISED_AT = '2026-10-15T00:00:00.000Z';
  /** A run folder of an aws-prod run, begun and maybe sealed. */
  const leaveRun = (id: string, sealed: boolean): void => {
    mkdirSync(join(runsDir, id, LAYOUT.sourcesDir), { recursive: true });
    writeFileSync(join(runsDir, id, LAYOUT.raise), '{}');
    if (sealed) writeFileSync(join(runsDir, id, LAYOUT.manifest), '{}');
  };

  it('refuses a run id that does not begin with a time, because it cannot be placed in the raise', () => {
    leaveRun('odd-name', false);

    expect(() => unsealedRunsSince(runsDir, new Date(RAISED_AT))).toThrowError(
      'does not begin with a time',
    );
  });

  it('refuses a moment that is not a time, so that no run reads as sealed by mistake', () => {
    expect(() => unsealedRunsSince(runsDir, new Date('not a time'))).toThrowError(
      'not a valid time',
    );
  });

  it('lists the runs a raise began that have no manifest yet, and not those sealed, before it or at home', async () => {
    begin();
    leaveRun('20261014T230000Z-smoke-load-direct', false);
    leaveRun('20261015T002000Z-smoke-load-direct', true);
    mkdirSync(join(runsDir, '20261015T003000Z-home-smoke-mock'));

    expect(unsealedRunsSince(runsDir, new Date(RAISED_AT))).toEqual([RUN]);

    await archive();

    expect(unsealedRunsSince(runsDir, new Date(RAISED_AT))).toEqual([]);
  });
});
