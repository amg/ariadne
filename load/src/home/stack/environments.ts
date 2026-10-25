import { LOAD_ACCOUNTS } from '../loadAccounts.ts';
import type { Inference } from '../options.ts';
import type { DevConnections, Environment } from '../types.ts';

/**
 * The environment of the backend a home run starts. It reads dev's
 * database and auth core, and it answers on this machine only. Mock
 * inference switches the real provider's key off as well, so a mock run
 * cannot spend money by any path. Real inference blanks the mock switch,
 * so the backend uses the provider whatever dev's `.env` says. The
 * app leaves the auth routes unlimited, as aws-prod does, because every
 * virtual user arrives from one address. The backend's shape is set here
 * and never taken from `base`: one process doing both the API and the
 * worker, with no Valkey and no metrics published.
 */
export function backendEnvironment(input: {
  base: Environment;
  connections: DevConnections;
  inference: Inference;
  port: number;
  mockUrl: string;
}): Environment {
  const { base, connections, inference, port, mockUrl } = input;
  return {
    ...base,
    DATABASE_URL: connections.databaseUrl,
    SUPERTOKENS_CONNECTION_URI: connections.authCoreUrl,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_RATE_LIMIT_AT_EDGE: 'true',
    AUTH_SIGNUP_ENABLED: 'true',
    PROCESS_ROLE: 'all',
    VALKEY_URL: '',
    PUBLISH_METRICS: 'false',
    MOCK_AI_BASE_URL: inference === 'mock' ? mockUrl : '',
    ...(inference === 'mock' ? { DEEPINFRA_API_KEY: '' } : {}),
  };
}

/** The environment of the mock inference server: this machine only. */
export function mockEnvironment(base: Environment, port: number): Environment {
  return { ...base, PORT: String(port), HOST: '127.0.0.1' };
}

type GeneratorSlice = {
  runId: string;
  generator: number;
  attempt: number;
  mode: 'seed' | 'load';
  backendUrl: string;
  password: string;
  firstUser: number;
  userCount: number;
  chattingShare: number;
  rampSeconds: number;
  holdSeconds: number;
  /** When the generator's plan ends, in milliseconds; null for a plan that lasts its ramp and hold. */
  endsAt: number | null;
  thinkSeconds: number;
  seedConcurrency: number;
  /** How often the generator writes a line of its running state. */
  stateSeconds: number;
};

/**
 * The environment of a generator signing in the load accounts. It holds
 * nothing but what the generator reads, so none of dev's secrets reach it.
 */
export function generatorEnvironment(path: string | undefined, slice: GeneratorSlice): Environment {
  return {
    PATH: path,
    RUN_ID: slice.runId,
    MODE: slice.mode,
    GENERATOR: String(slice.generator),
    ATTEMPT: String(slice.attempt),
    TARGET_URL: slice.backendUrl,
    LOAD_KEY_HEADER: 'x-load-run',
    LOAD_KEY: slice.runId,
    USER_PASSWORD: slice.password,
    EMAIL_DOMAIN: LOAD_ACCOUNTS.emailDomain,
    FIRST_USER: String(slice.firstUser),
    USER_COUNT: String(slice.userCount),
    CHATTING_SHARE: String(slice.chattingShare),
    RAMP_SECONDS: String(slice.rampSeconds),
    HOLD_SECONDS: String(slice.holdSeconds),
    ...(slice.endsAt === null ? {} : { ENDS_AT: new Date(slice.endsAt).toISOString() }),
    THINK_SECONDS: String(slice.thinkSeconds),
    SEED_CONCURRENCY: String(slice.seedConcurrency),
    STATE_SECONDS: String(slice.stateSeconds),
  };
}
