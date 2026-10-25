/**
 * Every size aws-prod runs at. A step is one complete shape: database,
 * cache, the five services and the load that tests them. Every step runs
 * the API and the worker as separate services sharing Valkey. Runs step up
 * through roughly 10%, 50% and 100% of the target (100k signed-in users
 * with a tab open, 20k of them chatting), and each run's readings set the
 * next step's numbers. The values below are starting points, not findings.
 */

/** Fargate CPU units (1024 = one vCPU) and memory, per task, and how many tasks. */
type ServiceSize = {
  cpu: 256 | 512 | 1024 | 2048 | 4096;
  memoryMiB: number;
  count: number;
};

/**
 * How a service scales between its `count`, the floor, and `maxCount`.
 * The service scales on average CPU, memory, or both, toward the targets
 * given. A service without scaling runs exactly `count` tasks.
 */
type ServiceScaling = {
  maxCount: number;
  /** Average CPU use, 0 to 100, that scaling holds the service near. */
  targetCpuPercent?: number;
  /** Average memory use, 0 to 100, that scaling holds the service near. */
  targetMemoryPercent?: number;
  /** Seconds between removing tasks; 300 when omitted. */
  scaleInCooldown?: number;
  /** Seconds between adding tasks; 60 when omitted. */
  scaleOutCooldown?: number;
};

/** A service's size, with scaling when it may grow past `count`. */
export type ServiceConfig = ServiceSize & { scaling?: ServiceScaling };

/**
 * How a deploy replaces a service's tasks, as percents of its task count:
 * the fewest that must stay healthy, and the most that may run at once.
 */
export type DeployPolicy = {
  minHealthyPercent: number;
  maxHealthyPercent: number;
};

/**
 * Every old task runs beside its new one. Capacity never dips. A deploy needs
 * twice the vCPU.
 */
const SURGE_DEPLOY: DeployPolicy = { minHealthyPercent: 100, maxHealthyPercent: 200 };

/**
 * Old tasks stop as new ones start. A deploy needs no extra vCPU. A service
 * with one task has none running while it is replaced, and a larger service
 * can drop to none; ECS rounds the healthy minimum up, so any other minimum
 * would leave a one-task service no room to replace its task.
 */
const REPLACE_DEPLOY: DeployPolicy = { minHealthyPercent: 0, maxHealthyPercent: 100 };

/** The most tasks a service can run: its ceiling when it scales, its count otherwise. */
export function maxTasksOf(service: ServiceConfig) {
  return service.scaling?.maxCount ?? service.count;
}

export type Step = {
  name: StepName;
  /** How a deploy replaces the services' tasks. Only step-prod keeps its capacity while it deploys. */
  deploy: DeployPolicy;
  /** `seed` creates the synthetic population; every other step restores it. */
  database: {
    instanceClass: string;
    /**
     * GiB of storage allocated to the instance. A restore cannot come
     * up smaller than its snapshot, so no step may sit below the size
     * `seed` allocates. A step above the snapshot grows the storage in
     * place after the restore; at these sizes that takes about an hour.
     */
    storageGiB: number;
    source: 'empty' | 'seedSnapshot';
  };
  cache: {
    maxStorageGb: number;
    maxEcpuPerSecond: number;
  };
  loadBalancer: {
    /**
     * Capacity units the load balancer keeps reserved for the raise's whole
     * life, so it is already big enough when the load arrives and does not
     * grow underneath it. Null leaves it to grow on its own.
     */
    reservedCapacityUnits: number | null;
  };
  services: {
    api: ServiceConfig;
    /**
     * Runs the queue; shares Valkey and the database with the API.
     * `jobConcurrency` sets how many jobs each task runs side by side;
     * the backend's own default applies when it is omitted.
     */
    worker: ServiceConfig & { jobConcurrency?: number };
    /**
     * Every sign-up and sign-in checks a deliberately slow password hash, about
     * four a second per vCPU (measured on smoke). Each step's auth handles its
     * ramp (users / rampSeconds) at about 60% busy; any less and sign-ins
     * queue, and the run measures the queue.
     */
    auth: ServiceConfig;
    mock: ServiceConfig;
    web: ServiceConfig;
  };
  load: {
    generators: number;
    generator: ServiceSize;
    /**
     * Whether the generators run on Fargate Spot. A reclaimed generator is
     * relaunched on its slice, which a seeding run cannot do, so seed stays
     * On-Demand.
     */
    spot: boolean;
    /** Signed-in users holding a tab open. */
    users: number;
    /** The share of those users who also chat. */
    chattingShare: number;
    rampSeconds: number;
    holdSeconds: number;
    /** Pause between one reply ending and the user's next message. */
    thinkSeconds: number;
    /** Rough ceilings for the usage-priced estimate only. */
    egressGbPerHour: number;
    logsGbPerHour: number;
  };
  signupOpen: boolean;
};

export type StepName = 'seed' | 'smoke' | 'step10' | 'step50' | 'step100' | 'step-prod';

/**
 * A load generator is one Node process and uses one core, so many small
 * ones beat a few big ones. Each carries about 5,000 users.
 */
const GENERATOR: ServiceSize = { cpu: 1024, memoryMiB: 4096, count: 1 };
/** Seeding signs accounts up as fast as it can, so it wants cores a load generator cannot use. */
const SEEDING_GENERATOR: ServiceSize = { cpu: 4096, memoryMiB: 8192, count: 1 };
const WEB: ServiceSize = { cpu: 256, memoryMiB: 512, count: 2 };
/**
 * Jobs a worker task runs side by side on step50. A worker mostly waits on
 * I/O, so it can run many at once. Step10 carries the same number, so that a
 * step10 run says something about step50's.
 */
const STEP50_WORKER_JOBS_AT_ONCE = 16;

/**
 * Load balancer capacity units reserved for every thousand users, so that
 * a load step's users never make the load balancer grow during a run.
 * Growing breaks the push streams open at the time. Step10's readings
 * set it: its 10,000 users took the load balancer to about 140 units.
 */
const CAPACITY_UNITS_PER_THOUSAND_USERS = 14;

/** The load balancer of a step whose users arrive faster than it would grow by itself. */
function reservedFor(users: number): Step['loadBalancer'] {
  return {
    reservedCapacityUnits: Math.ceil((users / 1_000) * CAPACITY_UNITS_PER_THOUSAND_USERS),
  };
}

/** The load balancer of a step that leaves it to grow on its own. */
const GROWS_ON_ITS_OWN: Step['loadBalancer'] = { reservedCapacityUnits: null };

export const STEPS: Record<StepName, Step> = {
  seed: {
    name: 'seed',
    deploy: REPLACE_DEPLOY,
    database: { instanceClass: 'm7g.large', storageGiB: 400, source: 'empty' },
    cache: { maxStorageGb: 1, maxEcpuPerSecond: 5_000 },
    loadBalancer: GROWS_ON_ITS_OWN,
    services: {
      api: { cpu: 2048, memoryMiB: 4096, count: 1 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 1 },
      // 16 vCPU signs up the population in about half an hour, inside the
      // load stack's hour.
      auth: { cpu: 2048, memoryMiB: 4096, count: 8 },
      mock: { cpu: 512, memoryMiB: 1024, count: 1 },
      web: { ...WEB, count: 1 },
    },
    load: {
      generators: 2,
      generator: SEEDING_GENERATOR,
      spot: false,
      users: 100_000,
      chattingShare: 1,
      rampSeconds: 0,
      holdSeconds: 0,
      thinkSeconds: 0,
      egressGbPerHour: 2,
      logsGbPerHour: 2,
    },
    signupOpen: true,
  },

  smoke: {
    name: 'smoke',
    deploy: REPLACE_DEPLOY,
    database: { instanceClass: 'm7g.large', storageGiB: 400, source: 'seedSnapshot' },
    cache: { maxStorageGb: 1, maxEcpuPerSecond: 5_000 },
    loadBalancer: GROWS_ON_ITS_OWN,
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 1 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 1 },
      auth: { cpu: 2048, memoryMiB: 4096, count: 2 },
      mock: { cpu: 512, memoryMiB: 1024, count: 1 },
      web: { ...WEB, count: 1 },
    },
    load: {
      // Several generators, so that a lost one can be replaced while the others carry on.
      generators: 4,
      generator: GENERATOR,
      spot: true,
      users: 1_000,
      chattingShare: 0.2,
      rampSeconds: 120,
      holdSeconds: 600,
      thinkSeconds: 30,
      egressGbPerHour: 1,
      logsGbPerHour: 0.5,
    },
    signupOpen: false,
  },

  step10: {
    name: 'step10',
    deploy: REPLACE_DEPLOY,
    database: { instanceClass: 'm7g.xlarge', storageGiB: 400, source: 'seedSnapshot' },
    cache: { maxStorageGb: 1, maxEcpuPerSecond: 25_000 },
    loadBalancer: reservedFor(10_000),
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 2 },
      worker: {
        cpu: 1024,
        memoryMiB: 2048,
        count: 8,
        jobConcurrency: STEP50_WORKER_JOBS_AT_ONCE,
      },
      auth: { cpu: 2048, memoryMiB: 4096, count: 4 },
      mock: { cpu: 512, memoryMiB: 1024, count: 1 },
      web: { ...WEB, count: 1 },
    },
    load: {
      generators: 2,
      generator: GENERATOR,
      spot: true,
      users: 10_000,
      chattingShare: 0.2,
      rampSeconds: 600,
      holdSeconds: 1_200,
      thinkSeconds: 30,
      egressGbPerHour: 2,
      logsGbPerHour: 0.5,
    },
    signupOpen: false,
  },

  step50: {
    name: 'step50',
    deploy: REPLACE_DEPLOY,
    database: { instanceClass: 'r7g.2xlarge', storageGiB: 400, source: 'seedSnapshot' },
    cache: { maxStorageGb: 5, maxEcpuPerSecond: 250_000 },
    loadBalancer: reservedFor(50_000),
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 20 },
      // Queue work waits on I/O and runs in parallel, so more 1 vCPU tasks
      // beat fewer larger ones.
      worker: {
        cpu: 1024,
        memoryMiB: 2048,
        count: 40,
        jobConcurrency: STEP50_WORKER_JOBS_AT_ONCE,
      },
      auth: { cpu: 2048, memoryMiB: 4096, count: 16 },
      mock: { cpu: 1024, memoryMiB: 2048, count: 6 },
      web: WEB,
    },
    load: {
      generators: 10,
      generator: GENERATOR,
      spot: true,
      users: 50_000,
      chattingShare: 0.2,
      rampSeconds: 900,
      holdSeconds: 1_200,
      thinkSeconds: 30,
      egressGbPerHour: 8,
      logsGbPerHour: 3,
    },
    signupOpen: false,
  },

  step100: {
    name: 'step100',
    deploy: REPLACE_DEPLOY,
    database: { instanceClass: 'r7g.4xlarge', storageGiB: 400, source: 'seedSnapshot' },
    cache: { maxStorageGb: 10, maxEcpuPerSecond: 500_000 },
    loadBalancer: reservedFor(100_000),
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 40 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 20 },
      auth: { cpu: 2048, memoryMiB: 4096, count: 18 },
      mock: { cpu: 1024, memoryMiB: 2048, count: 12 },
      web: { ...WEB, count: 3 },
    },
    load: {
      generators: 20,
      generator: GENERATOR,
      spot: true,
      users: 100_000,
      chattingShare: 0.2,
      rampSeconds: 1_200,
      holdSeconds: 1_200,
      thinkSeconds: 30,
      egressGbPerHour: 15,
      logsGbPerHour: 5,
    },
    signupOpen: false,
  },

  /**
   * The production shape: the API, worker and auth scale between a floor
   * and a ceiling. It runs no generators, so its only traffic is real
   * users; `load.users` sizes the usage-priced estimate.
   */
  'step-prod': {
    name: 'step-prod',
    deploy: SURGE_DEPLOY,
    database: { instanceClass: 'r7g.large', storageGiB: 400, source: 'seedSnapshot' },
    cache: { maxStorageGb: 2, maxEcpuPerSecond: 50_000 },
    // Reserve ahead of a known peak; idle, a reservation costs as much as it would at that peak.
    loadBalancer: GROWS_ON_ITS_OWN,
    services: {
      api: {
        cpu: 512,
        memoryMiB: 1024,
        count: 2,
        scaling: { maxCount: 8, targetCpuPercent: 65 },
      },
      // Queue work comes in bursts, so the worker adds tasks sooner and drops them sooner.
      worker: {
        cpu: 512,
        memoryMiB: 1024,
        count: 3,
        scaling: {
          maxCount: 12,
          targetCpuPercent: 70,
          scaleInCooldown: 180,
          scaleOutCooldown: 45,
        },
      },
      auth: {
        cpu: 1024,
        memoryMiB: 2048,
        count: 2,
        scaling: { maxCount: 6, targetCpuPercent: 60 },
      },
      mock: { cpu: 256, memoryMiB: 512, count: 1 },
      web: WEB,
    },
    load: {
      generators: 0,
      generator: GENERATOR,
      spot: true,
      users: 10_000,
      chattingShare: 0.2,
      rampSeconds: 0,
      holdSeconds: 0,
      thinkSeconds: 0,
      egressGbPerHour: 1,
      logsGbPerHour: 0.5,
    },
    signupOpen: true,
  },
};

export const STEP_NAMES = Object.keys(STEPS) as StepName[];

export function stepNamed(name: string) {
  const step = STEPS[name as StepName];
  if (step === undefined) {
    throw new Error(`Unknown step "${name}"; expected one of ${Object.keys(STEPS).join(', ')}`);
  }
  return step;
}
