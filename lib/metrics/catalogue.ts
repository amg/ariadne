/**
 * Every signal a load run or a live view reads: its name, unit, namespace,
 * dimensions, how a minute of it is combined, and its pass line if it has
 * one.
 */

/** What a figure is counted in, as CloudWatch names the unit. */
export type MetricUnit =
  | 'Count'
  | 'Count/Second'
  | 'Milliseconds'
  | 'Seconds'
  | 'Microseconds'
  | 'Bytes'
  | 'Megabytes'
  | 'Percent'
  | 'None';

export type Statistic = 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'p50' | 'p95' | 'p99';

/** How the series of one signal that CloudWatch holds for a minute become one figure. */
export type MinuteCombine = 'sum' | 'max';

/**
 * One figure of a metric, read at one statistic. Signals that read the same
 * metric at different statistics share its name, namespace, dimensions and
 * unit.
 */
export type Signal = {
  namespace: string;
  /** The metric's name in the namespace. */
  name: string;
  statistic: Statistic;
  /** The dimensions a series carries: all of them, and no others. */
  dimensions: readonly string[];
  /** Values that some of those dimensions must have. */
  where?: Readonly<Record<string, string>>;
  /** What the metric is counted in. */
  unit: MetricUnit;
  /** How a minute's series are combined: added up, or the highest of them. */
  minute: MinuteCombine;
  /** The most, in the signal's unit, a run may see and still pass. */
  passLine?: number;
};

/** Where a signal comes from. */
export type Origin = 'generator line' | 'backend record' | 'aws';

/** Where the figures of a signal come from, by the namespace they are in. */
export function originOf(signal: Pick<Signal, 'namespace'>) {
  if (signal.namespace === NAMESPACES.load) return 'generator line';
  if (signal.namespace === NAMESPACES.app) return 'backend record';
  return 'aws';
}

/** A share of one signal in another, as a percent. */
export type Share = {
  part: Signal;
  whole: Signal;
  /** The most a run may see, as a percent, and still pass. */
  passLine?: number;
};

/** Where the generators' and the backend's figures are published. */
export const NAMESPACES = { load: 'Ari/Load', app: 'Ari/App' } as const;

/** The dimensions the generators and the backend publish their figures under. */
export const DIMENSIONS = {
  /** The generator's number, on the figures that are levels rather than events. */
  generator: 'Generator',
  /** The kind of request, on the counts of requests and failures. */
  kind: 'Kind',
  /** The queue task a job ran, on the count of jobs. */
  task: 'Task',
  /** What the Drift gate answered, on the count of answers. */
  verdict: 'Verdict',
} as const;

/** What narrows a search to some of the resources a signal is published for. */
export type SearchNarrowing = {
  /** Dimensions whose value must equal the one given. */
  exact?: Readonly<Record<string, string>>;
  /** Dimensions whose value need only contain the word given, as a resource's generated name does. */
  contains?: Readonly<Record<string, string>>;
};

type Source = {
  namespace: string;
  dimensions: readonly string[];
  where?: Readonly<Record<string, string>>;
};

type Reading = {
  statistic: Statistic;
  unit: MetricUnit;
  /** Defaults to adding the series up for a `Sum` and taking the highest of them for any other statistic. */
  minute?: MinuteCombine;
  passLine?: number;
};

const defaultMinute = (statistic: Statistic) => (statistic === 'Sum' ? 'sum' : 'max');

/** Makes the signals of one namespace and set of dimensions. */
function signalsIn(source: Source) {
  return (name: string, reading: Reading): Signal => {
    const { minute, ...rest } = reading;
    return { ...source, name, ...rest, minute: minute ?? defaultMinute(reading.statistic) };
  };
}

const measuredAs = (statistic: Statistic, unit: MetricUnit, more: Partial<Reading> = {}) => ({
  statistic,
  unit,
  ...more,
});

const loadSignal = signalsIn({ namespace: NAMESPACES.load, dimensions: [] });
const loadByGeneratorSignal = signalsIn({
  namespace: NAMESPACES.load,
  dimensions: [DIMENSIONS.generator],
});
const loadByKindSignal = signalsIn({ namespace: NAMESPACES.load, dimensions: [DIMENSIONS.kind] });
const signInSignal = signalsIn({
  namespace: NAMESPACES.load,
  dimensions: [DIMENSIONS.kind],
  where: { [DIMENSIONS.kind]: 'signin' },
});
const appSignal = signalsIn({ namespace: NAMESPACES.app, dimensions: [] });
const appByTaskSignal = signalsIn({ namespace: NAMESPACES.app, dimensions: [DIMENSIONS.task] });
const appByVerdictSignal = signalsIn({
  namespace: NAMESPACES.app,
  dimensions: [DIMENSIONS.verdict],
});

const balancerSignal = signalsIn({ namespace: 'AWS/ApplicationELB', dimensions: ['LoadBalancer'] });
const balancerByZoneSignal = signalsIn({
  namespace: 'AWS/ApplicationELB',
  dimensions: ['AvailabilityZone', 'LoadBalancer'],
});
const targetGroupSignal = signalsIn({
  namespace: 'AWS/ApplicationELB',
  dimensions: ['LoadBalancer', 'TargetGroup'],
});
const databaseSignal = signalsIn({ namespace: 'AWS/RDS', dimensions: ['DBInstanceIdentifier'] });
const cacheSignal = signalsIn({ namespace: 'AWS/ElastiCache', dimensions: ['clusterId'] });
const serviceSignal = signalsIn({
  namespace: 'AWS/ECS',
  dimensions: ['ClusterName', 'ServiceName'],
});
const serviceInsightsSignal = signalsIn({
  namespace: 'ECS/ContainerInsights',
  dimensions: ['ClusterName', 'ServiceName'],
});
const generatorInsightsSignal = signalsIn({
  namespace: 'ECS/ContainerInsights',
  dimensions: ['ClusterName', 'TaskDefinitionFamily'],
});
const fargateVcpuSignal = (capacity: 'OnDemand' | 'Spot') =>
  signalsIn({
    namespace: 'AWS/Usage',
    dimensions: ['Type', 'Resource', 'Service', 'Class'],
    where: {
      Type: 'Resource',
      Resource: 'vCPU',
      Service: 'Fargate',
      Class: `Standard/${capacity}`,
    },
  })('ResourceCount', measuredAs('Maximum', 'Count'));

const COUNT = measuredAs('Sum', 'Count');

/** The slowest first byte of a chat reply that still passes, at the 95th percentile. */
const CHAT_FIRST_BYTE_P95_PASS_LINE_MS = 2_500;

/** Every signal, by where its figures come from and what it measures. */
export const SIGNALS = {
  /** What the generators publish: what users experience. */
  load: {
    usersSignedIn: loadByGeneratorSignal(
      'UsersSignedIn',
      measuredAs('Average', 'Count', { minute: 'sum' }),
    ),
    pushStreamsOpen: loadByGeneratorSignal(
      'PushStreamsOpen',
      measuredAs('Average', 'Count', { minute: 'sum' }),
    ),
    chattersActive: loadByGeneratorSignal(
      'ChattersActive',
      measuredAs('Average', 'Count', { minute: 'sum' }),
    ),
    chatFirstByteP50: loadSignal('ChatFirstByteMs', measuredAs('p50', 'Milliseconds')),
    chatFirstByteP95: loadSignal(
      'ChatFirstByteMs',
      measuredAs('p95', 'Milliseconds', { passLine: CHAT_FIRST_BYTE_P95_PASS_LINE_MS }),
    ),
    chatFirstByteP99: loadSignal('ChatFirstByteMs', measuredAs('p99', 'Milliseconds')),
    /** One for every request. */
    requests: loadByKindSignal('Requests', COUNT),
    /** One for every request that failed. */
    failures: loadByKindSignal('Failures', COUNT),
    signInRequests: signInSignal('Requests', COUNT),
    signInFailures: signInSignal('Failures', COUNT),
  },
  /**
   * What each backend task publishes from its exchange, job and state
   * records. None carries the task's own name: the average of a figure over
   * every task's samples is the figure for one task.
   */
  app: {
    /** The push streams open on an API task. */
    pushStreamsOpenAverage: appSignal('PushStreamsOpen', measuredAs('Average', 'Count')),
    pushStreamsOpenBusiest: appSignal('PushStreamsOpen', measuredAs('Maximum', 'Count')),
    /** How long the oldest job due to run has waited, as a worker task sees it. */
    oldestJobWaitMs: appSignal('QueueWaitMs', measuredAs('Maximum', 'Milliseconds')),
    /** How long a copy's one thread was kept from its work. */
    eventLoopDelayP99Ms: appSignal('EventLoopDelayP99Ms', measuredAs('Maximum', 'Milliseconds')),
    heapUsedBytes: appSignal('HeapUsedBytes', measuredAs('Maximum', 'Bytes')),
    residentBytes: appSignal('ResidentBytes', measuredAs('Maximum', 'Bytes')),
    dbConnectionsInUse: appSignal('DbConnectionsInUse', measuredAs('Maximum', 'Count')),
    dbConnectionsWaiting: appSignal('DbConnectionsWaiting', measuredAs('Maximum', 'Count')),
    /** The jobs a worker task is running now. */
    workerSlotsBusy: appSignal('WorkerSlotsBusy', measuredAs('Maximum', 'Count')),
    /** Sends and subscriptions between copies that failed. */
    pushBusFailures: appSignal('PushBusFailures', measuredAs('Maximum', 'Count')),
    /** How long a job waited from when it was due until a worker began it. */
    jobWaitP50: appSignal('JobWaitMs', measuredAs('p50', 'Milliseconds')),
    jobWaitP95: appSignal('JobWaitMs', measuredAs('p95', 'Milliseconds')),
    /** One for every attempt at a job. */
    jobsRun: appByTaskSignal('JobsRun', COUNT),
    /** One for every answer the Drift gate gave. */
    gateVerdicts: appByVerdictSignal('GateVerdicts', COUNT),
    /** One for every chat request that gave up waiting for the Drift gate. */
    gateWaitsAtLimit: appSignal('GateWaitsAtLimit', COUNT),
  },
  loadBalancer: {
    requests: balancerSignal('RequestCount', COUNT),
    answeredByServiceWith2xx: balancerSignal('HTTPCode_Target_2XX_Count', COUNT),
    answeredByServiceWith3xx: balancerSignal('HTTPCode_Target_3XX_Count', COUNT),
    answeredByServiceWith4xx: balancerSignal('HTTPCode_Target_4XX_Count', COUNT),
    answeredByServiceWith5xx: balancerSignal('HTTPCode_Target_5XX_Count', COUNT),
    answeredItselfWith3xx: balancerSignal('HTTPCode_ELB_3XX_Count', COUNT),
    answeredItselfWith4xx: balancerSignal('HTTPCode_ELB_4XX_Count', COUNT),
    answeredItselfWith5xx: balancerSignal('HTTPCode_ELB_5XX_Count', COUNT),
    responseTimeAverage: balancerSignal('TargetResponseTime', measuredAs('Average', 'Seconds')),
    responseTimeSlowest: balancerSignal('TargetResponseTime', measuredAs('Maximum', 'Seconds')),
    responseTimeP50: balancerSignal('TargetResponseTime', measuredAs('p50', 'Seconds')),
    responseTimeP95: balancerSignal('TargetResponseTime', measuredAs('p95', 'Seconds')),
    responseTimeP99: balancerSignal('TargetResponseTime', measuredAs('p99', 'Seconds')),
    newConnections: balancerSignal('NewConnectionCount', COUNT),
    activeConnections: balancerSignal('ActiveConnectionCount', COUNT),
    clientTlsErrors: balancerSignal('ClientTLSNegotiationErrorCount', COUNT),
    /** The share of its present capacity the load balancer used. */
    capacityUsed: balancerSignal('CapacityUtilization', measuredAs('Maximum', 'Percent')),
    /** The most capacity units the load balancer needed in the minute. */
    capacityUnitsPeak: balancerSignal('PeakLCUs', measuredAs('Maximum', 'Count')),
    /** The capacity units kept reserved, which it never shrinks below. */
    capacityUnitsReserved: balancerSignal('ReservedLCUs', measuredAs('Maximum', 'Count')),
    targetTlsErrors: balancerSignal('TargetTLSNegotiationErrorCount', COUNT),
  },
  /** The load balancer in each availability zone, one series for each. */
  loadBalancerByZone: {
    requests: balancerByZoneSignal('RequestCount', COUNT),
    newConnections: balancerByZoneSignal('NewConnectionCount', COUNT),
    activeConnections: balancerByZoneSignal('ActiveConnectionCount', COUNT),
  },
  targetGroup: {
    requests: targetGroupSignal('RequestCount', COUNT),
    healthyHosts: targetGroupSignal('HealthyHostCount', measuredAs('Minimum', 'Count')),
    unhealthyHosts: targetGroupSignal('UnHealthyHostCount', measuredAs('Maximum', 'Count')),
  },
  /** The app's services, one series for each. */
  service: {
    runningTasks: serviceInsightsSignal('RunningTaskCount', measuredAs('Average', 'Count')),
    desiredTasks: serviceInsightsSignal('DesiredTaskCount', measuredAs('Average', 'Count')),
    pendingTasks: serviceInsightsSignal('PendingTaskCount', measuredAs('Average', 'Count')),
    cpuAverage: serviceSignal('CPUUtilization', measuredAs('Average', 'Percent')),
    cpuBusiest: serviceSignal('CPUUtilization', measuredAs('Maximum', 'Percent')),
    memoryAverage: serviceSignal('MemoryUtilization', measuredAs('Average', 'Percent')),
  },
  /** The generators' tasks, as Container Insights measures them. */
  generators: {
    cpuUsedTotal: generatorInsightsSignal(
      'CpuUtilized',
      measuredAs('Average', 'None', { minute: 'sum' }),
    ),
    cpuUsedBusiest: generatorInsightsSignal('CpuUtilized', measuredAs('Maximum', 'None')),
    cpuReservedTotal: generatorInsightsSignal(
      'CpuReserved',
      measuredAs('Average', 'None', { minute: 'sum' }),
    ),
    /** Every generator reserves the same, so the highest of them is one generator's. */
    cpuReservedEach: generatorInsightsSignal('CpuReserved', measuredAs('Average', 'None')),
    memoryUsedTotal: generatorInsightsSignal(
      'MemoryUtilized',
      measuredAs('Average', 'Megabytes', { minute: 'sum' }),
    ),
    memoryReservedTotal: generatorInsightsSignal(
      'MemoryReserved',
      measuredAs('Average', 'Megabytes', { minute: 'sum' }),
    ),
  },
  database: {
    cpu: databaseSignal('CPUUtilization', measuredAs('Maximum', 'Percent')),
    sessionsBusy: databaseSignal('DBLoad', measuredAs('Average', 'None')),
    sessionsOnCpu: databaseSignal('DBLoadCPU', measuredAs('Average', 'None')),
    sessionsWaiting: databaseSignal('DBLoadNonCPU', measuredAs('Average', 'None')),
    connections: databaseSignal('DatabaseConnections', measuredAs('Maximum', 'Count')),
    freeStorage: databaseSignal('FreeStorageSpace', measuredAs('Average', 'Bytes')),
    readIops: databaseSignal('ReadIOPS', measuredAs('Average', 'Count/Second')),
    writeIops: databaseSignal('WriteIOPS', measuredAs('Average', 'Count/Second')),
    readLatency: databaseSignal('ReadLatency', measuredAs('Average', 'Seconds')),
    writeLatency: databaseSignal('WriteLatency', measuredAs('Average', 'Seconds')),
  },
  cache: {
    reads: cacheSignal('GetTypeCmds', COUNT),
    writes: cacheSignal('SetTypeCmds', COUNT),
    commands: cacheSignal('TotalCmdsCount', COUNT),
    processingUnits: cacheSignal('ElastiCacheProcessingUnits', COUNT),
    throttled: cacheSignal('ThrottledCmds', COUNT),
    readLatency: cacheSignal('SuccessfulReadRequestLatency', measuredAs('Average', 'Microseconds')),
    writeLatency: cacheSignal(
      'SuccessfulWriteRequestLatency',
      measuredAs('Average', 'Microseconds'),
    ),
  },
  fargateUsage: {
    onDemandVcpu: fargateVcpuSignal('OnDemand'),
    spotVcpu: fargateVcpuSignal('Spot'),
  },
} as const;

/** Figures that only mean something as a share of another signal. */
export const SHARES = {
  /** The sign-ins that failed, of all sign-ins. */
  signInFailures: {
    part: SIGNALS.load.signInFailures,
    whole: SIGNALS.load.signInRequests,
    passLine: 0.5,
  },
  /** The Drift gate's answers that were a wait which hit its limit, of all its answers. */
  gateWaitsAtLimit: {
    part: SIGNALS.app.gateWaitsAtLimit,
    whole: SIGNALS.app.gateVerdicts,
    passLine: 0.5,
  },
  /** What every generator used of the CPU they reserve. */
  generatorCpuTotal: {
    part: SIGNALS.generators.cpuUsedTotal,
    whole: SIGNALS.generators.cpuReservedTotal,
  },
  /** What the busiest generator used of the CPU it reserves, past which it limits the run itself. */
  generatorCpuBusiest: {
    part: SIGNALS.generators.cpuUsedBusiest,
    whole: SIGNALS.generators.cpuReservedEach,
    passLine: 70,
  },
  generatorMemoryTotal: {
    part: SIGNALS.generators.memoryUsedTotal,
    whole: SIGNALS.generators.memoryReservedTotal,
  },
} as const satisfies Record<string, Share>;

/** The pass line of a signal or share. Asking for one that has none is a mistake and throws. */
export function passLineOf(line: { passLine?: number }) {
  if (line.passLine === undefined) throw new Error('This signal has no pass line.');
  return line.passLine;
}

/**
 * The text CloudWatch's search takes to find a signal's series. A term in
 * `exact` must equal a dimension's value. A term in `contains` need only
 * appear in it, which finds a resource by a word of its generated name.
 */
export function searchOf(signal: Signal, narrowedTo: SearchNarrowing = {}) {
  const schema = [signal.namespace, ...signal.dimensions].join(',');
  const terms = [
    `MetricName="${signal.name}"`,
    ...Object.entries({ ...signal.where, ...narrowedTo.exact }).map(
      ([dimension, value]) => `${dimension}="${value}"`,
    ),
    ...Object.entries(narrowedTo.contains ?? {}).map(([dimension, word]) => `${dimension}=${word}`),
  ];
  return `{${schema}} ${terms.join(' ')}`;
}

/** The namespaces whose metrics a group of signals lives in, by name. */
export function namespacesOf(signals: Readonly<Record<string, Signal>>) {
  return [...new Set(Object.values(signals).map(({ namespace }) => namespace))].sort();
}

/** Every signal of the catalogue. */
export function allSignals() {
  return Object.values(SIGNALS).flatMap((group) => Object.values<Signal>(group));
}
