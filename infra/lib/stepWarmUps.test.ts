import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STEPS } from '../config/steps.ts';

/** Sign-ins per second one auth vCPU handles, measured on smoke. */
const SIGN_INS_PER_VCPU_SECOND = 4;

/** The busiest a warm-up may keep auth before its sign-ins queue. */
const MOST_AUTH_BUSY = 0.85;

describe('a load step’s warm-up', () => {
  it('signs its users in no faster than auth keeps up with', () => {
    for (const step of Object.values(STEPS)) {
      if (step.load.warmUp === null) continue;
      const { cpu, count } = step.services.auth;
      const signInsPerSecond = (cpu / 1024) * count * SIGN_INS_PER_VCPU_SECOND;
      const busy = step.load.users / step.load.warmUp.rampSeconds / signInsPerSecond;
      assert.ok(
        busy <= MOST_AUTH_BUSY,
        `${step.name}'s warm-up keeps auth ${Math.round(busy * 100)}% busy`,
      );
    }
  });

  it('ramps at least as fast as the measured run, so that run cannot outgrow it', () => {
    for (const step of Object.values(STEPS)) {
      if (step.load.warmUp === null) continue;
      assert.ok(step.load.warmUp.rampSeconds <= step.load.rampSeconds, step.name);
    }
  });
});
