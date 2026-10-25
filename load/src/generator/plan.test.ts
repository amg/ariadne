import { describe, expect, it } from 'vitest';
import { planAt, readPlan } from './plan.ts';

const env = {
  RUN_ID: 'run-1',
  TARGET_URL: 'https://example.test',
  LOAD_KEY_HEADER: 'x-load-run',
  LOAD_KEY: 'run-1',
  USER_PASSWORD: 'pw',
  EMAIL_DOMAIN: 'load.invalid',
  RAMP_SECONDS: '60',
  HOLD_SECONDS: '240',
};

const T0 = Date.parse('2026-10-17T00:00:00.000Z');

describe('planAt', () => {
  it('leaves a plan with no end moment as it is', () => {
    const plan = readPlan(env);

    expect(plan.endsAt).toBeNull();
    expect(planAt(plan, T0 + 500_000)).toBe(plan);
  });

  it('keeps the ramp and hold when it begins in time to ramp and hold them in full', () => {
    const plan = readPlan({ ...env, ENDS_AT: '2026-10-17T00:05:00.000Z' });

    expect(planAt(plan, T0)).toMatchObject({ rampSeconds: 60, holdSeconds: 240 });
  });

  it('holds for the time left after the ramp, when it begins late', () => {
    const plan = readPlan({ ...env, ENDS_AT: '2026-10-17T00:05:00.000Z' });

    expect(planAt(plan, T0 + 120_000)).toMatchObject({ rampSeconds: 60, holdSeconds: 120 });
  });

  it('spends the whole time left on the ramp when too little is left to hold', () => {
    const plan = readPlan({ ...env, ENDS_AT: '2026-10-17T00:05:00.000Z' });

    expect(planAt(plan, T0 + 270_000)).toMatchObject({ rampSeconds: 30, holdSeconds: 0 });
  });

  it('has nothing to ramp or hold once the end has passed', () => {
    const plan = readPlan({ ...env, ENDS_AT: '2026-10-17T00:05:00.000Z' });

    expect(planAt(plan, T0 + 400_000)).toMatchObject({ rampSeconds: 0, holdSeconds: 0 });
  });

  it('refuses an end moment that is not a time', () => {
    expect(() => readPlan({ ...env, ENDS_AT: 'soon' })).toThrow('ENDS_AT must be a time');
  });
});
