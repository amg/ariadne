import { describe, expect, it } from 'vitest';
import type { RequestLine } from '../../records/index.ts';
import { at, requestWith, runDataWith, sliceDataWith, sliceWith } from '../runData/testing.ts';
import { holdFactsOf } from './hold.ts';

/** The slice holds from the 60th second to the 240th. */
const held = sliceWith({ endedAt: at(300), hold: { from: at(60), to: at(240) } });

const state = (seconds: number, streams: number, chatters: number) => ({
  run: 'run-1',
  generator: 0,
  attempt: 1,
  at: at(seconds),
  usersSignedIn: streams,
  pushStreamsOpen: streams,
  chattersActive: chatters,
});

const chatAt = (seconds: number, firstByteMs: number): RequestLine =>
  requestWith({ startedAt: at(seconds), firstByteMs });

describe('holdFactsOf', () => {
  it('names the fewest push streams and chatters of the hold, each with the first moment it was that few', () => {
    const facts = holdFactsOf(
      runDataWith({
        slices: [
          sliceDataWith(held, {
            states: [
              state(30, 1, 1),
              state(70, 100, 20),
              state(100, 60, 20),
              state(130, 60, 18),
              state(160, 100, 18),
              state(250, 0, 0),
            ],
          }),
        ],
      }),
    );

    expect(facts).toMatchObject({
      from: at(60),
      to: at(240),
      fewestPushStreams: { count: 60, at: at(100) },
      fewestChatters: { count: 18, at: at(130) },
    });
  });

  it('takes the chat first byte p95 of the chats that started in the hold alone', () => {
    const inHold = Array.from({ length: 20 }, (_, index) => chatAt(70 + index, 100 + index));
    const facts = holdFactsOf(
      runDataWith({
        slices: [
          sliceDataWith(held, {
            requests: [
              chatAt(10, 9_000),
              ...inHold,
              chatAt(250, 9_000),
              { ...chatAt(100, 50_000), outcome: 'failed' },
            ],
          }),
        ],
      }),
    );

    expect(facts).toMatchObject({ chatsStreamed: 20, chatFirstByteP95Ms: 118 });
  });

  it('is null for a run that records no hold', () => {
    expect(holdFactsOf(runDataWith({ slices: [sliceDataWith(sliceWith())] }))).toBeNull();
  });
});

describe('holdFactsOf, when streams are ended under their users', () => {
  /** A push stream of user `user` from `from` to `to` seconds, broken off unless the run let it go. */
  const push = (user: number, from: number, to: number, outcome: 'failed' | 'held') =>
    requestWith({
      kind: 'push',
      user,
      startedAt: at(from),
      totalMs: (to - from) * 1_000,
      status: 200,
      outcome,
    });

  it('counts a user reopening a stream within seconds as still holding one', () => {
    // Two of ten streams broke at second 99 and reopened at 102; the line at 100 saw eight.
    const facts = holdFactsOf(
      runDataWith({
        slices: [
          sliceDataWith(held, {
            states: [state(70, 10, 2), state(100, 8, 2), state(130, 10, 2)],
            requests: [
              push(0, 10, 99, 'failed'),
              push(0, 102, 300, 'held'),
              push(1, 10, 99, 'failed'),
              push(1, 102, 300, 'held'),
            ],
          }),
        ],
      }),
    );

    expect(facts?.fewestPushStreams?.count).toBe(10);
  });

  it('counts a user who did not come back within seconds as lost', () => {
    const facts = holdFactsOf(
      runDataWith({
        slices: [
          sliceDataWith(held, {
            states: [state(70, 10, 2), state(100, 9, 2), state(130, 10, 2)],
            requests: [push(0, 10, 99, 'failed'), push(0, 125, 300, 'held')],
          }),
        ],
      }),
    );

    expect(facts?.fewestPushStreams).toEqual({ count: 9, at: at(100) });
  });
});
