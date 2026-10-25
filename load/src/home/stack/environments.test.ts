import { describe, expect, it } from 'vitest';
import { parseRunOptions } from '../options.ts';
import { backendEnvironment, generatorEnvironment, mockEnvironment } from './environments.ts';

const connections = {
  databaseUrl: 'postgres://u:p@172.23.0.1:15432/chatbot',
  authCoreUrl: 'http://172.23.0.1:3567',
  hostBackendUrl: 'http://172.23.0.1:3001',
};
const dotenvValues = { DEEPINFRA_API_KEY: 'real-key', MOCK_AI_BASE_URL: 'http://elsewhere/v1' };

function backendFor(inference: 'mock' | 'real') {
  return backendEnvironment({
    base: dotenvValues,
    connections,
    inference,
    port: 3101,
    mockUrl: 'http://127.0.0.1:4141/v1',
  });
}

describe('backendEnvironment', () => {
  it('uses the mock when the run named no inference', () => {
    const { inference } = parseRunOptions([]);

    const env = backendFor(inference);

    expect(env.MOCK_AI_BASE_URL).toBe('http://127.0.0.1:4141/v1');
    expect(env.DEEPINFRA_API_KEY).toBe('');
  });

  it('uses the provider when the run asks for real inference', () => {
    const env = backendFor(parseRunOptions(['--inference', 'real']).inference);

    expect(env.MOCK_AI_BASE_URL).toBe('');
    expect(env.DEEPINFRA_API_KEY).toBe('real-key');
  });

  it('reads dev’s database and auth core and answers on this machine only', () => {
    const env = backendFor('mock');

    expect(env).toMatchObject({
      DATABASE_URL: connections.databaseUrl,
      SUPERTOKENS_CONNECTION_URI: connections.authCoreUrl,
      PORT: '3101',
      HOST: '127.0.0.1',
    });
  });

  it('leaves the auth routes unlimited, as every user arrives from one address', () => {
    expect(backendFor('mock').AUTH_RATE_LIMIT_AT_EDGE).toBe('true');
    expect(backendFor('real').AUTH_RATE_LIMIT_AT_EDGE).toBe('true');
  });

  it('pins one process doing both jobs, with no Valkey and no metrics, whatever the agent has set', () => {
    const inherited = {
      PROCESS_ROLE: 'worker',
      VALKEY_URL: 'redis://elsewhere:6379',
      PUBLISH_METRICS: 'true',
    };

    const env = backendEnvironment({
      base: inherited,
      connections,
      inference: 'mock',
      port: 3101,
      mockUrl: 'http://127.0.0.1:4141/v1',
    });

    expect(env).toMatchObject({ PROCESS_ROLE: 'all', VALKEY_URL: '', PUBLISH_METRICS: 'false' });
  });
});

describe('mockEnvironment', () => {
  it('answers on this machine only', () => {
    expect(mockEnvironment({}, 4141)).toEqual({ PORT: '4141', HOST: '127.0.0.1' });
  });
});

describe('generatorEnvironment', () => {
  const slice = {
    runId: 'run-1',
    generator: 2,
    attempt: 3,
    mode: 'load' as const,
    backendUrl: 'http://127.0.0.1:3101',
    password: 'pw',
    firstUser: 10,
    userCount: 5,
    chattingShare: 1,
    rampSeconds: 5,
    holdSeconds: 30,
    endsAt: null,
    thinkSeconds: 5,
    seedConcurrency: 4,
    stateSeconds: 2,
  };

  it('signs in the slice of load accounts it is given, named like the population', () => {
    const env = generatorEnvironment('/usr/bin', slice);

    expect(env).toMatchObject({
      EMAIL_DOMAIN: 'load.invalid',
      FIRST_USER: '10',
      USER_COUNT: '5',
      TARGET_URL: 'http://127.0.0.1:3101',
    });
  });

  it('names the generator and the attempt, which mark every record it writes', () => {
    expect(generatorEnvironment('/usr/bin', slice)).toMatchObject({ GENERATOR: '2', ATTEMPT: '3' });
  });

  it('gives the moment the generator’s plan ends, when it has one', () => {
    expect(generatorEnvironment('/usr/bin', slice)).not.toHaveProperty('ENDS_AT');
    expect(
      generatorEnvironment('/usr/bin', {
        ...slice,
        endsAt: Date.parse('2026-10-17T00:05:00.000Z'),
      }),
    ).toMatchObject({ ENDS_AT: '2026-10-17T00:05:00.000Z' });
  });

  it('holds nothing of the surrounding environment but its path', () => {
    expect(Object.keys(generatorEnvironment('/usr/bin', slice))).not.toContain('DATABASE_URL');
    expect(generatorEnvironment('/usr/bin', slice).ORIGIN_ADDRESS).toBeUndefined();
  });
});
