/**
 * What one generator does, read from its environment. Every generator
 * runs the same image; the load command hands each one its own slice of
 * the synthetic population through FIRST_USER and USER_COUNT.
 */

/** `seed` creates accounts with one Thread each; `load` signs them in and holds them. */
type Mode = 'seed' | 'load';

export type Plan = {
  mode: Mode;
  runId: string;
  generator: number;
  /** Which try at running this generator's slice this is; a replacement takes the next number. */
  attempt: number;
  targetUrl: string;
  loadKeyHeader: string;
  loadKey: string;
  password: string;
  emailDomain: string;
  firstUser: number;
  userCount: number;
  chattingShare: number;
  rampSeconds: number;
  holdSeconds: number;
  /**
   * How long the users take to leave after the hold, one at a time, the
   * last to arrive the first to go. 0 stops them all at once.
   */
  fallSeconds: number;
  /**
   * When the plan ends, in milliseconds; null for a plan that lasts as long
   * as its ramp, hold and fall. `planAt` fits them to the time left.
   */
  endsAt: number | null;
  thinkSeconds: number;
  /** How many accounts a seeding generator creates at once. */
  seedConcurrency: number;
  /** How often the generator writes a line of its running state. */
  stateSeconds: number;
  /** Whether the request and state lines also publish their figures as metrics. */
  publishMetrics: boolean;
};

export function readPlan(env: NodeJS.ProcessEnv): Plan {
  return {
    mode: env.MODE === 'seed' ? 'seed' : 'load',
    runId: required(env, 'RUN_ID'),
    generator: number({ env, key: 'GENERATOR', fallback: 0 }),
    attempt: number({ env, key: 'ATTEMPT', fallback: 1 }),
    targetUrl: required(env, 'TARGET_URL'),
    loadKeyHeader: required(env, 'LOAD_KEY_HEADER'),
    loadKey: required(env, 'LOAD_KEY'),
    password: required(env, 'USER_PASSWORD'),
    emailDomain: required(env, 'EMAIL_DOMAIN'),
    firstUser: number({ env, key: 'FIRST_USER', fallback: 0 }),
    userCount: number({ env, key: 'USER_COUNT', fallback: 0 }),
    chattingShare: number({ env, key: 'CHATTING_SHARE', fallback: 0 }),
    rampSeconds: number({ env, key: 'RAMP_SECONDS', fallback: 60 }),
    holdSeconds: number({ env, key: 'HOLD_SECONDS', fallback: 300 }),
    fallSeconds: number({ env, key: 'FALL_SECONDS', fallback: 0 }),
    endsAt: env.ENDS_AT ? instant(env, 'ENDS_AT') : null,
    thinkSeconds: number({ env, key: 'THINK_SECONDS', fallback: 30 }),
    seedConcurrency: number({ env, key: 'SEED_CONCURRENCY', fallback: 200 }),
    stateSeconds: number({ env, key: 'STATE_SECONDS', fallback: 5 }),
    publishMetrics: env.PUBLISH_METRICS === 'true',
  };
}

/**
 * The plan as it stands at `now`. A plan that has an end moment keeps its
 * fall last. It ramps for its ramp, or for the time left before the fall if
 * that is shorter, and holds for the rest, so that it ends at that moment
 * however late it began. One that begins after its fall should have begun
 * falls for the time left, with only the users who would not have left by
 * then.
 */
export function planAt(plan: Plan, now: number) {
  if (plan.endsAt === null) return plan;
  const secondsLeft = Math.max(0, (plan.endsAt - now) / 1_000);
  const fallSeconds = Math.min(plan.fallSeconds, secondsLeft);
  const rampSeconds = Math.min(plan.rampSeconds, secondsLeft - fallSeconds);
  const userCount =
    fallSeconds === plan.fallSeconds
      ? plan.userCount
      : Math.min(plan.userCount, Math.ceil((plan.userCount * fallSeconds) / plan.fallSeconds));
  return {
    ...plan,
    userCount,
    rampSeconds,
    holdSeconds: secondsLeft - fallSeconds - rampSeconds,
    fallSeconds,
  };
}

/** The synthetic account behind a user number: the same number always names the same account. */
export function emailOf(plan: Plan, userNumber: number) {
  return `user-${String(userNumber).padStart(6, '0')}@${plan.emailDomain}`;
}

/** Whether a user chats as well as holding a tab open; spread evenly across the population. */
export function isChatting(plan: Plan, userNumber: number) {
  return userNumber % 100 < plan.chattingShare * 100;
}

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`${key} is not set`);
  return value;
}

function number({ env, key, fallback }: { env: NodeJS.ProcessEnv; key: string; fallback: number }) {
  const value = Number(env[key] ?? fallback);
  if (Number.isNaN(value)) throw new Error(`${key} must be a number`);
  return value;
}

function instant(env: NodeJS.ProcessEnv, key: string) {
  const value = Date.parse(env[key] ?? '');
  if (Number.isNaN(value)) throw new Error(`${key} must be a time`);
  return value;
}
