/**
 * What one generator does, read from its environment. Every generator
 * runs the same image; the load command hands each one its own slice of
 * the synthetic population through FIRST_USER and USER_COUNT.
 */

/** `seed` creates accounts with one Thread each; `load` signs them in and holds them. */
export type Mode = 'seed' | 'load';

export type Plan = {
  mode: Mode;
  runId: string;
  generator: number;
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
  thinkSeconds: number;
  /** How many accounts a seeding generator creates at once. */
  seedConcurrency: number;
};

export function readPlan(env: NodeJS.ProcessEnv): Plan {
  return {
    mode: env.MODE === 'seed' ? 'seed' : 'load',
    runId: required(env, 'RUN_ID'),
    generator: number(env, 'GENERATOR', 0),
    targetUrl: required(env, 'TARGET_URL'),
    loadKeyHeader: required(env, 'LOAD_KEY_HEADER'),
    loadKey: required(env, 'LOAD_KEY'),
    password: required(env, 'USER_PASSWORD'),
    emailDomain: required(env, 'EMAIL_DOMAIN'),
    firstUser: number(env, 'FIRST_USER', 0),
    userCount: number(env, 'USER_COUNT', 0),
    chattingShare: number(env, 'CHATTING_SHARE', 0),
    rampSeconds: number(env, 'RAMP_SECONDS', 60),
    holdSeconds: number(env, 'HOLD_SECONDS', 300),
    thinkSeconds: number(env, 'THINK_SECONDS', 30),
    seedConcurrency: number(env, 'SEED_CONCURRENCY', 200),
  };
}

/** The synthetic account behind a user number: the same number always names the same account. */
export function emailOf(plan: Plan, userNumber: number): string {
  return `user-${String(userNumber).padStart(6, '0')}@${plan.emailDomain}`;
}

/** Whether a user chats as well as holding a tab open; spread evenly across the population. */
export function isChatting(plan: Plan, userNumber: number): boolean {
  return userNumber % 100 < plan.chattingShare * 100;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`${key} is not set`);
  return value;
}

function number(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key] ?? fallback);
  if (Number.isNaN(value)) throw new Error(`${key} must be a number`);
  return value;
}
