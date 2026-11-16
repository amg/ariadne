import { describe, expect, it } from 'vitest';
import type { RunEvent, StateLine } from '../../records/index.ts';
import { at, sliceWith } from './testing.ts';
import { downUntilUsersBack } from './usersBack.ts';

const LOST = 'its generator stopped (interrupted: Spot); a new generator brought the users back';

/** Slice 0 lost its generator at 60 s; the archive has it back at 90 s, when the replacement's ramp ended. */
const lost = sliceWith({ down: [{ from: at(60), to: at(90), reason: LOST }] });

/** The replacement, launched at 70 s for the slice's ten users. */
const replacement: RunEvent = {
  kind: 'generator-launched',
  at: at(70),
  generator: 0,
  attempt: 2,
  firstUser: 0,
  userCount: 10,
  task: 'pid-2',
  spot: false,
  planned: { rampEndsAt: at(90), holdEndsAt: at(150) },
};

const stateAt = (seconds: number, usersSignedIn: number, attempt = 2): StateLine => ({
  run: 'run-1',
  generator: 0,
  attempt,
  at: at(seconds),
  usersSignedIn,
  pushStreamsOpen: usersSignedIn,
  chattersActive: 0,
});

const downOf = (states: readonly StateLine[] | null, events: readonly RunEvent[] | null) =>
  downUntilUsersBack({ slice: lost, states, events }).down;

describe('downUntilUsersBack', () => {
  it('keeps a slice down until its replacement had every user signed in again', () => {
    expect(downOf([stateAt(90, 4), stateAt(100, 9), stateAt(110, 10)], [replacement])).toEqual([
      { from: at(60), to: at(110), reason: `${LOST}, all signed in again at ${at(110)}` },
    ]);
  });

  it('keeps the window as it was when the users were back by its end', () => {
    expect(downOf([stateAt(85, 10)], [replacement])).toEqual(lost.down);
  });

  it('keeps the window as it was when the users never all came back, so their failures are judged', () => {
    expect(downOf([stateAt(100, 9), stateAt(140, 9)], [replacement])).toEqual(lost.down);
  });

  it('takes the earliest line with every user signed in, whatever order the lines are in', () => {
    expect(downOf([stateAt(130, 10), stateAt(110, 10)], [replacement])[0]?.to).toBe(at(110));
  });

  it('reads only the replacement’s own state lines', () => {
    expect(downOf([stateAt(100, 10, 1), stateAt(120, 10)], [replacement])[0]?.to).toBe(at(120));
  });

  it('leaves a window no replacement ended as it is', () => {
    expect(downOf([stateAt(100, 10)], [])).toEqual(lost.down);
  });

  it('leaves the windows as they are when the events or the state lines are unusable', () => {
    expect(downOf(null, [replacement])).toEqual(lost.down);
    expect(downOf([stateAt(110, 10)], null)).toEqual(lost.down);
  });
});
