import { describe, expect, it } from 'vitest';
import { replacementPlan } from './replacement.ts';

describe('replacementPlan', () => {
  it('brings users back over a minute and holds for the rest of the run', () => {
    expect(replacementPlan(400)).toEqual({ rampSeconds: 60, holdSeconds: 340 });
  });

  it('spends all the time that is left bringing users back when it is under a minute', () => {
    expect(replacementPlan(30)).toEqual({ rampSeconds: 30, holdSeconds: 0 });
  });

  it('ends with the run: the ramp and the hold add up to what is left', () => {
    for (const left of [5, 59.5, 60, 61, 1_000]) {
      const plan = replacementPlan(left);
      expect((plan?.rampSeconds ?? 0) + (plan?.holdSeconds ?? 0)).toBe(left);
    }
  });

  it('starts nothing when too little of the run is left to be worth it', () => {
    expect(replacementPlan(4.9)).toBeNull();
    expect(replacementPlan(0)).toBeNull();
  });
});
