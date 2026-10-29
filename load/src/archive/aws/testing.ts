import type { Report } from '../../records/index.ts';
import type { TaskInfo } from '../../types/archive.ts';
import type { Raise } from './raise.ts';
import type { RaiseSources } from './sources.ts';

/** The run the fixture's generator task ran under. */
export const RUN = '20261015T001000Z-smoke-load-direct';
export const RAISED = '2026-10-15T00:00:00.000Z';
export const STARTED = '2026-10-15T00:10:00.000Z';
export const ENDED = '2026-10-15T00:12:00.000Z';

/** A moment `seconds` after the run began. */
export const at = (seconds: number) =>
  new Date(Date.parse(STARTED) + seconds * 1_000).toISOString();

export const raise: Raise = {
  account: '123456789012',
  region: 'ap-southeast-2',
  startedAt: RAISED,
  stacks: {
    app: {
      name: 'AwsProdApp',
      id: 'arn:aws:cloudformation:ap-southeast-2:123456789012:stack/AwsProdApp/a',
    },
    load: {
      name: 'AwsProdLoad',
      id: 'arn:aws:cloudformation:ap-southeast-2:123456789012:stack/AwsProdLoad/b',
    },
  },
  clusters: { app: 'AwsProdApp-Cluster', load: 'AwsProdLoad-Cluster' },
  services: ['api', 'worker', 'auth', 'mock', 'web'].map((label) => ({
    label,
    cluster: 'AwsProdApp-Cluster',
    name: `AwsProdApp-${label}-service`,
  })),
  logGroups: [
    ...['api', 'worker', 'auth', 'mock', 'web'].map((label) => ({
      label,
      name: `/aws-prod-app/${label}`,
      stack: 'app' as const,
    })),
    { label: 'generator', name: '/aws-prod-load/generators', stack: 'load' as const },
  ],
  loadBalancer: { dimension: 'app/aws-prod-origin/50dc6c495c0c9188' },
  targetGroups: ['targetgroup/api/73e2d6bc24d8a067', 'targetgroup/web/83e2d6bc24d8a068'],
  database: { identifier: 'awsprodapp-database', resourceId: 'db-ABCDEF' },
  cache: { name: 'aws-prod' },
};

const request = (user: number, kind: string, start: number, totalMs: number, outcome: string) =>
  `REQUEST ${JSON.stringify({
    run: 'run-1',
    generator: 0,
    attempt: 1,
    user,
    kind,
    startedAt: at(start),
    firstByteMs: 10,
    totalMs,
    status: 200,
    outcome,
    errorCode: null,
  })}`;

const report: Report = {
  runId: 'run-1',
  generator: 0,
  attempt: 1,
  startedAt: at(6),
  endedAt: at(114),
  interrupted: false,
  requests: { total: 3, byKind: { signin: 1, chat: 1, push: 1 } },
  phases: {
    ramp: { startedAt: at(6), endedAt: at(26) },
    hold: { startedAt: at(26), endedAt: at(86) },
    rampDown: { startedAt: at(86), endedAt: at(114) },
  },
};

/** What the generator printed to its log stream: its lines among its other output. */
const generatorMessages = [
  'generator starting',
  request(0, 'signin', 6, 80, 'ok'),
  `STATE ${JSON.stringify({ run: 'run-1', generator: 0, attempt: 1, at: at(10), usersSignedIn: 1, pushStreamsOpen: 1, chattersActive: 1 })}`,
  request(0, 'chat', 8, 900, 'streamed'),
  request(0, 'push', 7, 108_000, 'held'),
  `REPORT ${JSON.stringify(report)}`,
];

const appRecord = (record: object) =>
  JSON.stringify({ level: 30, time: 1, appRecord: record, msg: 'app record' });

const apiMessages = [
  'listening',
  appRecord({
    kind: 'exchange',
    userId: 'u1',
    trigger: 'submit',
    arrivedAt: at(8),
    verdict: 'pass',
    verdictAfterMs: 40,
    firstTokenAfterMs: 300,
    endedAfterMs: 880,
    outcome: 'completed',
    errorCode: null,
    assistantMessageId: 'm2',
  }),
];

const workerMessages = [
  appRecord({
    kind: 'job',
    task: 'driftGateFoldTurn',
    jobId: '5',
    attempt: 1,
    queuedAt: at(9),
    startedAt: at(9),
    finishedAt: at(10),
    durationMs: 30,
    outcome: 'succeeded',
    errorClass: null,
    errorCode: null,
  }),
  appRecord({ kind: 'state', at: at(7), pushStreamsOpen: 1, oldestJobWaitMs: 0 }),
];

export const generatorTask: TaskInfo = {
  taskId: 'abc123',
  cluster: raise.clusters.load,
  createdAt: at(2),
  startedAt: at(5),
  stoppingAt: null,
  stoppedAt: at(115),
  stopCode: 'EssentialContainerExited',
  stoppedReason: 'Essential container in task exited',
  exitCode: 0,
  capacityProvider: 'FARGATE_SPOT',
  environment: { GENERATOR: '0', FIRST_USER: '0', USER_COUNT: '2', RUN_ID: RUN },
};

/** A raise as the fixture run left it: every source holds something, and counts how often it was asked. */
export function fakeSources(overrides: Partial<RaiseSources> = {}) {
  const calls = {
    logStreams: 0,
    logMessages: 0,
    metricSeries: 0,
    tasks: 0,
    serviceEvents: 0,
    scalingActivity: 0,
    databaseInsights: 0,
  };
  const logs: Record<string, readonly string[]> = {
    '/aws-prod-load/generators|generator/generator/abc123': generatorMessages,
    '/aws-prod-app/api|api/main/t1': apiMessages,
    '/aws-prod-app/worker|worker/main/t2': workerMessages,
    '/aws-prod-app/auth|auth/main/t3': ['auth started'],
    '/aws-prod-app/mock|mock/main/t4': ['mock started'],
    '/aws-prod-app/web|web/main/t5': ['GET / 200'],
  };
  const sources: RaiseSources = {
    logStreams: async (group) => {
      calls.logStreams += 1;
      return Object.keys(logs)
        .filter((key) => key.startsWith(`${group}|`))
        .map((key) => key.split('|')[1] ?? '');
    },
    logMessages: async function* (group, stream) {
      calls.logMessages += 1;
      yield (logs[`${group}|${stream}`] ?? []).map((message) => ({ at: at(5), message }));
    },
    metricSeries: async (target) => {
      calls.metricSeries += 1;
      return [
        {
          namespace: target.namespaces[0] ?? '',
          name: 'CPUUtilization',
          dimensions: {},
          statistic: 'Average',
          periodSeconds: 60,
          points: [{ at: at(30), value: 12.5 }],
        },
      ];
    },
    tasks: async (cluster) => {
      calls.tasks += 1;
      return cluster === raise.clusters.load ? [generatorTask] : [];
    },
    serviceEvents: async () => {
      calls.serviceEvents += 1;
      return [
        {
          at: at(0),
          source: 'ecs-service',
          resource: 'api',
          summary: 'has reached a steady state',
          detail: { id: 'e1' },
        },
      ];
    },
    scalingActivity: async () => {
      calls.scalingActivity += 1;
      return [];
    },
    databaseInsights: async () => {
      calls.databaseInsights += 1;
      return [
        {
          group: 'wait',
          dimensions: { 'db.wait_event.name': 'CPU' },
          at: at(60),
          averageActiveSessions: 0.4,
        },
      ];
    },
    ...overrides,
  };
  return Object.assign(sources, { calls });
}
