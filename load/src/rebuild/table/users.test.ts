import { describe, expect, it } from 'vitest';
import { minuteStartOf } from '../moments.ts';
import { ENDED, at, runDataWith, sliceDataWith, sliceWith } from '../runData/testing.ts';
import { usersByMinute } from './users.ts';

const state = (generator: number, attempt: number, second: number, users: number) => ({
  run: 'run-1',
  generator,
  attempt,
  at: at(second),
  usersSignedIn: users,
  pushStreamsOpen: users,
  chattersActive: users,
});

describe('usersByMinute', () => {
  const steady = sliceWith({ generator: 0 });
  const lostFor = (from: string, to: string) =>
    sliceWith({
      generator: 1,
      down: [{ from, to, reason: 'its generator stopped' }],
    });
  const steadyLines = sliceDataWith(steady, {
    states: [10, 30, 50, 70, 90, 110, 130, 150].map((second) => state(0, 1, second, 5)),
  });
  const lostLines = (slice: ReturnType<typeof lostFor>) =>
    sliceDataWith(slice, {
      states: [
        ...[10, 30, 50, 70].map((second) => state(1, 1, second, 5)),
        ...[80, 100, 120, 140, 160].map((second) => state(1, 2, second, 5)),
      ],
    });

  it('counts a slice once while its replacement takes over, and not at all while it was down', () => {
    const minutes = usersByMinute(
      runDataWith({ slices: [steadyLines, lostLines(lostFor(at(70), at(75)))] }),
    );

    // Before the slice went down, both slices were up.
    expect(minutes.get(minuteStartOf(Date.parse(at(0))))?.signedIn).toBe(10);
    // Once the replacement is back, both slices hold users again.
    expect(minutes.get(minuteStartOf(Date.parse(at(120))))?.signedIn).toBe(10);
  });

  it('counts no users of a slice from when it went down, though its task was torn down later', () => {
    const minuteOfTeardown = minuteStartOf(Date.parse(at(70)));
    const countedWith = (down: ReturnType<typeof lostFor>) =>
      usersByMinute(runDataWith({ slices: [steadyLines, lostLines(down)] })).get(minuteOfTeardown)
        ?.signedIn;

    expect(countedWith(lostFor(at(75), at(80)))).toBe(10);
    expect(countedWith(lostFor(at(30), at(115)))).toBe(5);
  });

  it('holds only the steady slice’s users in the window no one held the other', () => {
    const lonely = runDataWith({
      slices: [steadyLines, lostLines(lostFor(at(70), ENDED))],
    });

    expect(usersByMinute(lonely).get(minuteStartOf(Date.parse(at(120))))?.signedIn).toBe(5);
  });
});

describe('usersByMinute on a run of step50’s size', () => {
  it('counts twenty generators with twenty thousand state lines each in a moment', () => {
    const slices = Array.from({ length: 20 }, (_, index) =>
      sliceDataWith(sliceWith({ generator: index, endedAt: null }), {
        // Each generator’s lines fall between the others’, so that every line is a moment of its own.
        states: Array.from({ length: 20_000 }, (_, line) =>
          state(index, 1, line * 0.2 + index * 0.01, 5),
        ),
      }),
    );
    const started = performance.now();

    const minutes = usersByMinute(runDataWith({ slices }));

    expect(minutes.size).toBeGreaterThan(60);
    expect(Math.max(...[...minutes.values()].map(({ signedIn }) => signedIn))).toBe(100);
    // Looking back through a generator’s lines for every moment takes minutes at this size.
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
