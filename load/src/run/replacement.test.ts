import { describe, expect, it } from 'vitest';
import { replacementPlan } from './replacement.ts';

/** How fast the run's users arrived: fast enough that a slice of 500 comes back within the shortest ramp. */
const QUICK_ARRIVAL = 100;

/** A replacement's plan in a run with no fall, for a slice of 500 users. */
const withoutFall = (secondsLeft: number) =>
  replacementPlan({ secondsLeft, fallSeconds: 0, userCount: 500, usersPerSecond: QUICK_ARRIVAL });

describe('replacementPlan', () => {
  it('brings users back over a minute and holds for the rest of the run', () => {
    expect(withoutFall(400)).toEqual({
      rampSeconds: 60,
      holdSeconds: 340,
      fallSeconds: 0,
      userCount: 500,
    });
  });

  it('brings users back no faster than the run’s users arrived', () => {
    expect(
      replacementPlan({ secondsLeft: 1_000, fallSeconds: 0, userCount: 5_000, usersPerSecond: 20 }),
    ).toMatchObject({ rampSeconds: 250, holdSeconds: 750 });
  });

  it('takes a minute at least, however fast the run’s users arrived', () => {
    expect(
      replacementPlan({
        secondsLeft: 1_000,
        fallSeconds: 0,
        userCount: 500,
        usersPerSecond: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({ rampSeconds: 60 });
  });

  it('spends all the time that is left bringing users back when it is under a minute', () => {
    expect(withoutFall(30)).toMatchObject({ rampSeconds: 30, holdSeconds: 0, userCount: 500 });
  });

  it('ends with the run: the ramp, the hold and the fall add up to what is left', () => {
    for (const left of [5, 59.5, 60, 61, 1_000, 1_300]) {
      for (const fallSeconds of [0, 1_200]) {
        for (const usersPerSecond of [QUICK_ARRIVAL, 1]) {
          const plan = replacementPlan({
            secondsLeft: left,
            fallSeconds,
            userCount: 500,
            usersPerSecond,
          });
          if (plan === null) continue;
          expect(plan.rampSeconds + plan.holdSeconds + plan.fallSeconds).toBe(left);
        }
      }
    }
  });

  it('starts nothing when too little of the run is left to be worth it', () => {
    expect(withoutFall(4.9)).toBeNull();
    expect(withoutFall(0)).toBeNull();
  });

  it('lets its users go over the whole fall when it starts before the fall', () => {
    expect(
      replacementPlan({
        secondsLeft: 1_500,
        fallSeconds: 1_200,
        userCount: 500,
        usersPerSecond: QUICK_ARRIVAL,
      }),
    ).toEqual({
      rampSeconds: 60,
      holdSeconds: 240,
      fallSeconds: 1_200,
      userCount: 500,
    });
  });

  it('brings back, mid-fall, only the users still there when it has brought them back', () => {
    // A quarter of the fall is left once the minute of bringing users back is over.
    expect(
      replacementPlan({
        secondsLeft: 360,
        fallSeconds: 1_200,
        userCount: 500,
        usersPerSecond: QUICK_ARRIVAL,
      }),
    ).toEqual({
      rampSeconds: 60,
      holdSeconds: 0,
      fallSeconds: 300,
      userCount: 125,
    });
  });

  it('keeps the last user who is still there, rounding the users up', () => {
    expect(
      replacementPlan({
        secondsLeft: 61,
        fallSeconds: 1_200,
        userCount: 500,
        usersPerSecond: QUICK_ARRIVAL,
      }),
    ).toMatchObject({
      fallSeconds: 1,
      userCount: 1,
    });
  });

  it('starts nothing when every user of the slice will have left by the time they are back', () => {
    expect(
      replacementPlan({
        secondsLeft: 50,
        fallSeconds: 1_200,
        userCount: 500,
        usersPerSecond: QUICK_ARRIVAL,
      }),
    ).toBeNull();
  });
});
