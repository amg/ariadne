import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('WORKER_JOB_CONCURRENCY', () => {
  it('defaults to 4 when unset or empty', () => {
    vi.stubEnv('WORKER_JOB_CONCURRENCY', undefined);
    expect(env.WORKER_JOB_CONCURRENCY).toBe(4);
    vi.stubEnv('WORKER_JOB_CONCURRENCY', '');
    expect(env.WORKER_JOB_CONCURRENCY).toBe(4);
  });

  it('reads a whole number', () => {
    vi.stubEnv('WORKER_JOB_CONCURRENCY', '12');
    expect(env.WORKER_JOB_CONCURRENCY).toBe(12);
  });

  it.each(['0', '-1', '2.5', 'many'])('refuses %s', (value) => {
    vi.stubEnv('WORKER_JOB_CONCURRENCY', value);
    expect(() => env.WORKER_JOB_CONCURRENCY).toThrow('WORKER_JOB_CONCURRENCY');
  });
});

describe('STATE_LOG_INTERVAL_SECONDS', () => {
  it('defaults to 20 when unset or empty', () => {
    vi.stubEnv('STATE_LOG_INTERVAL_SECONDS', undefined);
    expect(env.STATE_LOG_INTERVAL_SECONDS).toBe(20);
    vi.stubEnv('STATE_LOG_INTERVAL_SECONDS', '');
    expect(env.STATE_LOG_INTERVAL_SECONDS).toBe(20);
  });

  it('reads a whole number of seconds', () => {
    vi.stubEnv('STATE_LOG_INTERVAL_SECONDS', '5');
    expect(env.STATE_LOG_INTERVAL_SECONDS).toBe(5);
  });

  it.each(['0', '-1', '2.5', 'often'])('refuses %s', (value) => {
    vi.stubEnv('STATE_LOG_INTERVAL_SECONDS', value);
    expect(() => env.STATE_LOG_INTERVAL_SECONDS).toThrow('STATE_LOG_INTERVAL_SECONDS');
  });
});

describe('PUBLISH_METRICS', () => {
  it('is off unless set to true', () => {
    vi.stubEnv('PUBLISH_METRICS', undefined);
    expect(env.PUBLISH_METRICS).toBe(false);
    vi.stubEnv('PUBLISH_METRICS', 'true');
    expect(env.PUBLISH_METRICS).toBe(true);
  });
});

describe('CORS_ORIGINS', () => {
  it('names no origins when unset or empty', () => {
    vi.stubEnv('CORS_ORIGINS', undefined);
    expect(env.CORS_ORIGINS).toEqual([]);
    vi.stubEnv('CORS_ORIGINS', '');
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('splits the list, trims each origin and drops empty entries', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://ari.example, https://staging.ari.example ,,');
    expect(env.CORS_ORIGINS).toEqual(['https://ari.example', 'https://staging.ari.example']);
  });

  it('drops a trailing slash, since a browser Origin never has one', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://ari.example/,https://staging.ari.example/');
    expect(env.CORS_ORIGINS).toEqual(['https://ari.example', 'https://staging.ari.example']);
  });
});

describe('DAILY_SPEND_BUDGET_USD', () => {
  it('is no budget when unset or empty', () => {
    vi.stubEnv('DAILY_SPEND_BUDGET_USD', undefined);
    expect(env.DAILY_SPEND_BUDGET_USD).toBeUndefined();
    vi.stubEnv('DAILY_SPEND_BUDGET_USD', '');
    expect(env.DAILY_SPEND_BUDGET_USD).toBeUndefined();
  });

  it.each([
    ['5.0', 5],
    ['0', 0],
    ['12.75', 12.75],
  ])('reads %s as %d dollars', (value, dollars) => {
    vi.stubEnv('DAILY_SPEND_BUDGET_USD', value);
    expect(env.DAILY_SPEND_BUDGET_USD).toBe(dollars);
  });

  it.each(['abc', '5usd', '-1', 'Infinity'])(
    'refuses %s instead of dropping the budget',
    (value) => {
      vi.stubEnv('DAILY_SPEND_BUDGET_USD', value);
      expect(() => env.DAILY_SPEND_BUDGET_USD).toThrow('DAILY_SPEND_BUDGET_USD');
    },
  );
});
