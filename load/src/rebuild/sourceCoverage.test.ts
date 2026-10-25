import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWS_METRIC_RESOURCES, LAYOUT, readManifest } from '../records/index.ts';
import { rebuildRun } from './rebuildRun.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

type Fixture = 'aws-smoke-pass' | 'home-smoke-pass';

/**
 * One kind of file a run can hold, the fixture that holds one, and the
 * entry of the layout or the CloudWatch resource it is. A kind the report
 * leaves out says why.
 */
type Kind = {
  kind: string;
  matches: (path: string) => boolean;
  fixture: Fixture;
  layout?: keyof typeof LAYOUT;
  aws?: keyof typeof AWS_METRIC_RESOURCES;
  leftOut?: string;
};

const exactly =
  (wanted: string) =>
  (path: string): boolean =>
    path === wanted;
const pattern =
  (wanted: RegExp) =>
  (path: string): boolean =>
    wanted.test(path);
const awsFile = (resource: string) => exactly(LAYOUT.awsMetrics(resource));

const KINDS: readonly Kind[] = [
  {
    kind: 'request lines',
    matches: pattern(/^requests\/generator-\d+\.jsonl$/),
    fixture: 'aws-smoke-pass',
    layout: 'requests',
  },
  {
    kind: 'generator state lines',
    matches: pattern(/^metrics\/generator-\d+\.state\.jsonl$/),
    fixture: 'aws-smoke-pass',
    layout: 'generatorState',
  },
  {
    kind: 'generator reports',
    matches: pattern(/^metrics\/generator-\d+-attempt-\d+\.report\.json$/),
    fixture: 'aws-smoke-pass',
    layout: 'generatorReport',
    leftOut:
      'A generator’s count of the request lines it wrote, and the phases it ran, kept as the history of its slice. The archive checks the request lines against the count before sealing, and the manifest carries the slice’s hold and the windows it was down.',
  },
  {
    kind: 'host samples',
    matches: exactly(LAYOUT.hostSamples),
    fixture: 'home-smoke-pass',
    layout: 'hostSamples',
  },
  {
    kind: 'Performance Insights',
    matches: exactly(LAYOUT.insights),
    fixture: 'aws-smoke-pass',
    layout: 'insights',
  },
  {
    kind: 'run events',
    matches: exactly(LAYOUT.events),
    fixture: 'aws-smoke-pass',
    layout: 'events',
  },
  {
    kind: 'AWS events',
    matches: exactly(LAYOUT.awsEvents),
    fixture: 'aws-smoke-pass',
    layout: 'awsEvents',
  },
  {
    kind: 'exchange lines',
    matches: exactly(LAYOUT.exchanges),
    fixture: 'aws-smoke-pass',
    layout: 'exchanges',
  },
  { kind: 'job lines', matches: exactly(LAYOUT.jobs), fixture: 'aws-smoke-pass', layout: 'jobs' },
  {
    kind: 'app request lines',
    matches: exactly(LAYOUT.appRequests),
    fixture: 'aws-smoke-pass',
    layout: 'appRequests',
  },
  {
    kind: 'app state lines',
    matches: exactly(LAYOUT.appState),
    fixture: 'aws-smoke-pass',
    layout: 'appState',
  },
  {
    kind: 'generator logs',
    matches: pattern(/^logs\/generator-\d+-attempt-\d+\.log$/),
    fixture: 'aws-smoke-pass',
    layout: 'generatorLog',
    leftOut:
      'What a generator printed, kept to read by hand. Its request, state and report lines are sorted out of it into their own files.',
  },
  {
    kind: 'service logs',
    matches: (path) => /^logs\/.*\.log$/.test(path) && !/^logs\/generator-/.test(path),
    fixture: 'aws-smoke-pass',
    layout: 'processLog',
    leftOut:
      'Free text kept to read by hand. The backend’s records are sorted out of it into app/, which the report draws.',
  },
  {
    kind: 'app cluster metrics',
    matches: awsFile(AWS_METRIC_RESOURCES.appCluster),
    fixture: 'aws-smoke-pass',
    aws: 'appCluster',
    leftOut:
      'The app cluster’s totals add up the services’ own files, which the report draws service by service.',
  },
  {
    kind: 'generator cluster metrics',
    matches: awsFile(AWS_METRIC_RESOURCES.generatorCluster),
    fixture: 'aws-smoke-pass',
    aws: 'generatorCluster',
  },
  {
    kind: 'service metrics',
    matches: pattern(/^metrics\/aws\/ecs-service-.+\.jsonl$/),
    fixture: 'aws-smoke-pass',
    aws: 'service',
  },
  {
    kind: 'load balancer metrics',
    matches: awsFile(AWS_METRIC_RESOURCES.loadBalancer),
    fixture: 'aws-smoke-pass',
    aws: 'loadBalancer',
  },
  {
    kind: 'target group metrics',
    matches: pattern(/^metrics\/aws\/target-group-.+\.jsonl$/),
    fixture: 'aws-smoke-pass',
    aws: 'targetGroup',
  },
  {
    kind: 'database metrics',
    matches: awsFile(AWS_METRIC_RESOURCES.database),
    fixture: 'aws-smoke-pass',
    aws: 'database',
  },
  {
    kind: 'cache metrics',
    matches: awsFile(AWS_METRIC_RESOURCES.cache),
    fixture: 'aws-smoke-pass',
    aws: 'cache',
  },
  {
    kind: 'Fargate usage',
    matches: awsFile(AWS_METRIC_RESOURCES.fargateUsage),
    fixture: 'aws-smoke-pass',
    aws: 'fargateUsage',
  },
];

/** Entries of the layout that are not files a sealed run holds, or are its folders. */
const NOT_RUN_FILES: readonly (keyof typeof LAYOUT)[] = [
  'manifest',
  'sourcesDir',
  'raise',
  'generatorOutput',
  'awsMetricsDir',
  'awsMetrics',
  'derivedDir',
  'summary',
  'verdict',
  'metricsTable',
  'eventsLog',
  'report',
];

const manifestOf = (fixture: Fixture) =>
  readManifest(readFileSync(join(FIXTURES, fixture, LAYOUT.manifest), 'utf8'));

/** The report of a fixture rebuilt from a copy, with the files of one kind taken out of its manifest. */
function reportWithout(fixture: Fixture, leaveOut: (path: string) => boolean) {
  const folder = join(mkdtempSync(join(tmpdir(), 'coverage-')), fixture);
  cpSync(join(FIXTURES, fixture), folder, { recursive: true });
  const manifest = manifestOf(fixture);
  const files = manifest.files.filter((entry) => !leaveOut(entry.path));
  writeFileSync(join(folder, LAYOUT.manifest), JSON.stringify({ ...manifest, files }));
  rebuildRun(folder);
  return readFileSync(join(folder, LAYOUT.report), 'utf8');
}

describe('the sources the report draws from', () => {
  it('knows every entry of the layout as a kind of file, or as no file of a sealed run', () => {
    const known = new Set<string>([
      ...KINDS.flatMap((kind) => kind.layout ?? []),
      ...NOT_RUN_FILES,
    ]);

    expect(Object.keys(LAYOUT).filter((key) => !known.has(key))).toEqual([]);
  });

  it('knows every resource whose CloudWatch metrics a run keeps', () => {
    const known = new Set<string>(KINDS.flatMap((kind) => kind.aws ?? []));

    expect(Object.keys(AWS_METRIC_RESOURCES).filter((key) => !known.has(key))).toEqual([]);
  });

  it.each(['aws-smoke-pass', 'home-smoke-pass'] as const)(
    'finds each file of the %s fixture to be of exactly one kind',
    (fixture) => {
      const unsorted = manifestOf(fixture)
        .files.map((entry) => entry.path)
        .filter((path) => KINDS.filter((kind) => kind.matches(path)).length !== 1);

      expect(unsorted).toEqual([]);
    },
  );

  it.each(KINDS)('finds the $kind in its fixture', ({ fixture, matches }) => {
    expect(manifestOf(fixture).files.some((entry) => matches(entry.path))).toBe(true);
  });

  const whole = new Map<Fixture, string>();
  /** The report of a fixture with every file it holds, rebuilt once. */
  const full = (fixture: Fixture): string => {
    const known = whole.get(fixture) ?? reportWithout(fixture, () => false);
    whole.set(fixture, known);
    return known;
  };

  it.each(KINDS.filter((kind) => kind.leftOut === undefined))(
    'draws from the $kind: the report changes without them',
    ({ fixture, matches }) => {
      expect(reportWithout(fixture, matches)).not.toBe(full(fixture));
    },
  );

  it.each(KINDS.filter((kind) => kind.leftOut !== undefined))(
    'leaves out the $kind, for a reason, and the report is the same without them',
    ({ fixture, matches, leftOut }) => {
      expect(leftOut?.length).toBeGreaterThan(0);
      expect(reportWithout(fixture, matches)).toBe(full(fixture));
    },
  );
});
