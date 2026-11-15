import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STEPS } from '../config/steps.ts';

/** Sign-ins per second one auth vCPU handles, measured on smoke. */
const SIGN_INS_PER_VCPU_SECOND = 4;

/** The busiest auth may run while users arrive; any busier and sign-ins queue. */
const MOST_AUTH_BUSY = 0.6;

describe('a load step’s auth', () => {
  it('signs its users in over the ramp at its starting count, without waiting to scale', () => {
    for (const step of Object.values(STEPS)) {
      if (step.load.generators === 0 || step.load.rampSeconds === 0) continue;
      const { cpu, count } = step.services.auth;
      const signInsPerSecond = (cpu / 1024) * count * SIGN_INS_PER_VCPU_SECOND;
      const busy = step.load.users / step.load.rampSeconds / signInsPerSecond;
      assert.ok(
        busy <= MOST_AUTH_BUSY,
        `${step.name}'s auth starts ${Math.round(busy * 100)}% busy on its ramp`,
      );
    }
  });
});
