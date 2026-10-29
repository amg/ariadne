import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import {
  SHARES,
  SIGNALS,
  type Share,
  type Signal,
  passLineOf,
} from '../../../lib/metrics/catalogue.ts';
import { sizedLinesOfLoad } from '../../../load/src/criteria/sized.ts';
import { PROJECT } from '../../config/names.ts';
import { STEPS } from '../../config/steps.ts';
import {
  MINUTE,
  graph,
  lineOf,
  perService,
  perValueOf,
  percentOf,
  row,
} from './dashboardMetrics.ts';

const MS_PER_SECOND = 1_000;
const MICROSECONDS_PER_MS = 1_000;
const BYTES_PER_GIB = 1024 ** 3;

/** The word the generator task definition's generated name carries. */
const GENERATOR_FAMILY = 'Generator';

const CHAT_FIRST_BYTE_PASS_LINE_MS = passLineOf(SIGNALS.load.chatFirstByteP95);
const BALANCER = SIGNALS.loadBalancer;
const DATABASE = SIGNALS.database;
const CACHE = SIGNALS.cache;
const AS_SECONDS = { divideBy: MS_PER_SECOND, zeroBetweenRuns: true };
const GENERATORS_ONLY = { contains: { TaskDefinitionFamily: GENERATOR_FAMILY } };

/**
 * The Fargate vCPU in use and its service quota, for one kind of capacity.
 * AWS publishes the vCPU count of each kind under its own class, and the
 * quota belongs to that series.
 */
function fargateVcpu(signal: Signal, label: string): cloudwatch.IMetric[] {
  const inUse = new cloudwatch.Metric({
    namespace: signal.namespace,
    metricName: signal.name,
    dimensionsMap: { ...signal.where },
    statistic: signal.statistic,
    period: Duration.seconds(MINUTE),
    label: `${label} in use`,
  });
  const quota = new cloudwatch.MathExpression({
    expression: 'SERVICE_QUOTA(inUse)',
    usingMetrics: { inUse },
    label: `${label} quota`,
    period: Duration.seconds(MINUTE),
    color: cloudwatch.Color.RED,
  });
  return [inUse, quota];
}

/** The steps whose pass lines follow their size. */
const SIZED_STEPS = [STEPS.step10, STEPS.step50];

/** The push streams and chatters each sized step must hold, named by step. */
function userLines() {
  return SIZED_STEPS.flatMap((step) => {
    const lines = sizedLinesOfLoad(step.load);
    return [
      {
        value: lines.minPushStreams,
        label: `${step.name} push streams at least ${lines.minPushStreams.toLocaleString('en-US')}`,
      },
      {
        value: lines.minChatters,
        label: `${step.name} chatters at least ${lines.minChatters.toLocaleString('en-US')}`,
      },
    ];
  });
}

/** The ECPU a second each sized step’s cache may use, named by step. */
function cacheCapLines() {
  return SIZED_STEPS.map((step) => ({
    value: step.cache.maxEcpuPerSecond,
    label: `${step.name} cap ${step.cache.maxEcpuPerSecond.toLocaleString('en-US')} a second`,
  }));
}

/** What the cache may use, by step, since the cap belongs to the step that was raised. */
function capsOfSteps() {
  return Object.values(STEPS)
    .map((step) => `${step.name} ${step.cache.maxEcpuPerSecond.toLocaleString('en-US')}`)
    .join(' · ');
}

/**
 * One page for reading a load run: what users experience, what the app
 * carries, how many tasks run, then traffic at the load balancer, each
 * service's CPU and memory, the database and the cache, on one time axis.
 *
 * It lives in core so it outlasts every raise. Every raise creates its
 * database, cluster and load balancer under new names, so each line finds
 * its metrics by pattern and combines whatever matched into one line;
 * only one raise runs at a time, so combining loses nothing. CloudWatch
 * keeps a torn-down raise's one-minute data for 15 days, so past runs stay
 * readable here too. A graph that carries a pass criterion draws its limit
 * as a red line.
 */
export class LoadDashboard extends Construct {
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${PROJECT}-load`,
      start: '-PT3H',
      widgets: [
        [
          new cloudwatch.TextWidget({
            markdown: [
              `### ${PROJECT} load runs`,
              'Shows whichever raise ran in the time range, up or torn down. The first rows are what users experience, drawn from the generators; red lines are the limits a run is judged by. The full run is rebuilt with its verdict and charts from its folder on the machine that ran it.',
            ].join('\n\n'),
            width: 24,
            height: 2,
          }),
        ],
        ...row('What users see', [
          graph(
            'Users online',
            [
              levelLine(SIGNALS.load.usersSignedIn, 'signed in'),
              levelLine(SIGNALS.load.pushStreamsOpen, 'push streams open'),
              levelLine(SIGNALS.load.chattersActive, 'chatters active'),
            ],
            { passLines: userLines() },
          ),
          graph(
            'Chat first byte (seconds)',
            [
              lineOf(SIGNALS.load.chatFirstByteP50, 'p50', AS_SECONDS),
              lineOf(SIGNALS.load.chatFirstByteP95, 'p95', AS_SECONDS),
              lineOf(SIGNALS.load.chatFirstByteP99, 'p99', AS_SECONDS),
            ],
            {
              passLines: [
                {
                  value: CHAT_FIRST_BYTE_PASS_LINE_MS / MS_PER_SECOND,
                  label: `p95 pass line ${CHAT_FIRST_BYTE_PASS_LINE_MS / MS_PER_SECOND} s`,
                },
              ],
            },
          ),
          graph('Failures per minute, by kind of request', [perValueOf(SIGNALS.load.failures)]),
        ]),
        ...row('What the generators see against their limits', [
          graph(
            'Sign-in failures (% of sign-ins)',
            [percentOf('sign-ins that failed', SHARES.signInFailures, { zeroBetweenRuns: true })],
            { passLines: [sharePassLine(SHARES.signInFailures)] },
          ),
          graph(
            'Generator CPU %',
            [
              percentOf('all generators together', SHARES.generatorCpuTotal, {
                narrowedTo: GENERATORS_ONLY,
              }),
              percentOf('busiest generator', SHARES.generatorCpuBusiest, {
                narrowedTo: GENERATORS_ONLY,
              }),
            ],
            { leftMax: 100, passLines: [sharePassLine(SHARES.generatorCpuBusiest)] },
          ),
          graph(
            'Generator memory % (all generators together)',
            [percentOf('memory', SHARES.generatorMemoryTotal, { narrowedTo: GENERATORS_ONLY })],
            { leftMax: 100 },
          ),
        ]),
        ...row('What the app sees', [
          graph('Push streams per API task', [
            levelLine(SIGNALS.app.pushStreamsOpenAverage, 'average task'),
            levelLine(SIGNALS.app.pushStreamsOpenBusiest, 'busiest task'),
          ]),
          graph('Time jobs wait in the queue (ms)', [
            levelLine(SIGNALS.app.jobWaitP50, 'job wait p50'),
            levelLine(SIGNALS.app.jobWaitP95, 'job wait p95'),
            levelLine(SIGNALS.app.oldestJobWaitMs, 'oldest job waiting'),
          ]),
          graph('Jobs run per minute, by queue task', [perValueOf(SIGNALS.app.jobsRun)], {
            stacked: true,
          }),
        ]),
        ...row('The Drift gate', [
          graph('Verdicts per minute, by outcome', [perValueOf(SIGNALS.app.gateVerdicts)], {
            stacked: true,
          }),
          graph(
            'Gate waits that hit the limit (% of verdicts)',
            [percentOf('waits at the limit', SHARES.gateWaitsAtLimit, { zeroBetweenRuns: true })],
            { passLines: [sharePassLine(SHARES.gateWaitsAtLimit)] },
          ),
        ]),
        ...row('How many tasks run', [
          graph('Running tasks', perService(SIGNALS.service.runningTasks)),
          graph('Desired tasks', perService(SIGNALS.service.desiredTasks)),
          graph('Pending tasks', perService(SIGNALS.service.pendingTasks)),
        ]),
        ...row('Fargate vCPU against its quota', [
          graph(
            'On-Demand vCPU (the app)',
            fargateVcpu(SIGNALS.fargateUsage.onDemandVcpu, 'On-Demand'),
          ),
          graph('Spot vCPU (the generators)', fargateVcpu(SIGNALS.fargateUsage.spotVcpu, 'Spot')),
        ]),
        ...row('Traffic at the load balancer', [
          graph('Requests per minute', [lineOf(BALANCER.requests, 'requests')]),
          graph('Response time (seconds)', [
            lineOf(BALANCER.responseTimeP50, 'p50'),
            lineOf(BALANCER.responseTimeP95, 'p95'),
            lineOf(BALANCER.responseTimeP99, 'p99'),
          ]),
          graph('Errors per minute', [
            lineOf(BALANCER.answeredByServiceWith5xx, 'app 5xx'),
            lineOf(BALANCER.answeredByServiceWith4xx, 'app 4xx'),
            lineOf(BALANCER.answeredItselfWith5xx, 'balancer 5xx'),
          ]),
        ]),
        ...row('Load balancer connections', [
          graph('Connections', [
            lineOf(BALANCER.newConnections, 'new connections'),
            lineOf(BALANCER.activeConnections, 'active connections'),
          ]),
          graph('TLS Errors', [
            lineOf(BALANCER.clientTlsErrors, 'client TLS errors'),
            lineOf(BALANCER.targetTlsErrors, 'target TLS errors'),
          ]),
        ]),
        ...row('Services', [
          graph('CPU %, average task', perService(SIGNALS.service.cpuAverage), { leftMax: 100 }),
          graph('CPU %, busiest task', perService(SIGNALS.service.cpuBusiest), { leftMax: 100 }),
          graph('Memory %, average task', perService(SIGNALS.service.memoryAverage), {
            leftMax: 100,
          }),
        ]),
        ...row('Database', [
          graph('CPU %', [lineOf(DATABASE.cpu, 'CPU')], { leftMax: 100 }),
          graph(
            'Database sessions: working or waiting',
            [lineOf(DATABASE.sessionsOnCpu, 'on CPU'), lineOf(DATABASE.sessionsWaiting, 'waiting')],
            { stacked: true },
          ),
          graph('Connections', [lineOf(DATABASE.connections, 'connections')]),
        ]),
        ...row('Database disk', [
          graph('Database Free Storage (GiB)', [
            lineOf(DATABASE.freeStorage, 'free space', { divideBy: BYTES_PER_GIB }),
          ]),
          graph('Database IOPS', [
            lineOf(DATABASE.readIops, 'read'),
            lineOf(DATABASE.writeIops, 'write'),
          ]),
          graph('Database disk latency (seconds)', [
            lineOf(DATABASE.readLatency, 'read'),
            lineOf(DATABASE.writeLatency, 'write'),
          ]),
        ]),
        ...row(`Cache (ECPU per second allowed, by step: ${capsOfSteps()})`, [
          graph('Cache commands per minute', [
            lineOf(CACHE.reads, 'reads'),
            lineOf(CACHE.writes, 'writes'),
          ]),
          graph(
            'Cache ECPU consumed per second',
            [lineOf(CACHE.processingUnits, 'ECPU per second', { divideBy: MINUTE })],
            { passLines: cacheCapLines() },
          ),
          graph('Cache requests throttled, and latency (ms)', [
            lineOf(CACHE.throttled, 'throttled commands'),
            lineOf(CACHE.readLatency, 'read latency', { divideBy: MICROSECONDS_PER_MS }),
            lineOf(CACHE.writeLatency, 'write latency', { divideBy: MICROSECONDS_PER_MS }),
          ]),
        ]),
      ],
    });
  }
}

/** A level that is published only while a run lasts, as one line over every task that publishes it. */
function levelLine(signal: Signal, label: string) {
  return lineOf(signal, label, { zeroBetweenRuns: true });
}

/** A share's pass line, drawn across the graph of that share. */
function sharePassLine(share: Share) {
  const value = passLineOf(share);
  return { value, label: `pass line ${value}%` };
}
