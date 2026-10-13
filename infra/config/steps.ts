/**
 * Every size aws-prod runs at. A step is one complete shape: database,
 * cache, the five services and the load that tests them. Every step runs
 * the API and the worker as separate services sharing Valkey. Runs step up
 * through roughly 10%, 50% and 100% of the target (100k signed-in users
 * with a tab open, 20k of them chatting), and each run's readings set the
 * next step's numbers. The values below are starting points, not findings.
 */

/** Fargate CPU units (1024 = one vCPU) and memory, per task, and how many tasks. */
export type ServiceSize = {
  cpu: 256 | 512 | 1024 | 2048 | 4096;
  memoryMiB: number;
  count: number;
};

export type Step = {
  name: StepName;
  /** `seed` creates the synthetic population; every other step restores it. */
  database: {
    instanceClass: string;
    storageGiB: number;
    source: 'empty' | 'seedSnapshot';
  };
  cache: {
    maxStorageGb: number;
    maxEcpuPerSecond: number;
  };
  services: {
    api: ServiceSize;
    /** Runs the queue; shares Valkey and the database with the API. */
    worker: ServiceSize;
    /**
     * Every sign-up and sign-in checks a deliberately slow password hash, about
     * four a second per vCPU (measured on smoke). Each step's auth handles its
     * ramp (users / rampSeconds) at about 60% busy; any less and sign-ins
     * queue, and the run measures the queue.
     */
    auth: ServiceSize;
    mock: ServiceSize;
    web: ServiceSize;
  };
  load: {
    generators: number;
    generator: ServiceSize;
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

export type StepName = 'seed' | 'smoke' | 'step10' | 'step50' | 'step100';

const GENERATOR: ServiceSize = { cpu: 4096, memoryMiB: 8192, count: 1 };
const WEB: ServiceSize = { cpu: 256, memoryMiB: 512, count: 2 };

export const STEPS: Record<StepName, Step> = {
  seed: {
    name: 'seed',
    database: { instanceClass: 'm7g.large', storageGiB: 100, source: 'empty' },
    cache: { maxStorageGb: 1, maxEcpuPerSecond: 5_000 },
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
      generator: GENERATOR,
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
    database: { instanceClass: 'm7g.large', storageGiB: 100, source: 'seedSnapshot' },
    cache: { maxStorageGb: 1, maxEcpuPerSecond: 5_000 },
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 1 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 1 },
      auth: { cpu: 2048, memoryMiB: 4096, count: 2 },
      mock: { cpu: 512, memoryMiB: 1024, count: 1 },
      web: { ...WEB, count: 1 },
    },
    load: {
      generators: 1,
      generator: GENERATOR,
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
    database: { instanceClass: 'm7g.xlarge', storageGiB: 100, source: 'seedSnapshot' },
    cache: { maxStorageGb: 1, maxEcpuPerSecond: 25_000 },
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 2 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 4 },
      auth: { cpu: 2048, memoryMiB: 4096, count: 4 },
      mock: { cpu: 512, memoryMiB: 1024, count: 1 },
      web: { ...WEB, count: 1 },
    },
    load: {
      generators: 2,
      generator: GENERATOR,
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
    database: { instanceClass: 'r7g.2xlarge', storageGiB: 400, source: 'seedSnapshot' },
    cache: { maxStorageGb: 5, maxEcpuPerSecond: 250_000 },
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 20 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 10 },
      auth: { cpu: 2048, memoryMiB: 4096, count: 12 },
      mock: { cpu: 1024, memoryMiB: 2048, count: 6 },
      web: WEB,
    },
    load: {
      generators: 5,
      generator: GENERATOR,
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
    database: { instanceClass: 'r7g.4xlarge', storageGiB: 800, source: 'seedSnapshot' },
    cache: { maxStorageGb: 10, maxEcpuPerSecond: 500_000 },
    services: {
      api: { cpu: 1024, memoryMiB: 2048, count: 40 },
      worker: { cpu: 1024, memoryMiB: 2048, count: 20 },
      auth: { cpu: 2048, memoryMiB: 4096, count: 18 },
      mock: { cpu: 1024, memoryMiB: 2048, count: 12 },
      web: { ...WEB, count: 3 },
    },
    load: {
      generators: 10,
      generator: GENERATOR,
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
};

export const STEP_NAMES = Object.keys(STEPS) as StepName[];

export function stepNamed(name: string): Step {
  const step = STEPS[name as StepName];
  if (step === undefined) {
    throw new Error(`Unknown step "${name}"; expected one of ${Object.keys(STEPS).join(', ')}`);
  }
  return step;
}
