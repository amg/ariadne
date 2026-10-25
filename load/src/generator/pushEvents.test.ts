import { describe, expect, it } from 'vitest';
import { createEventReader } from './pushEvents.ts';

function eventsIn(pieces: readonly string[]) {
  let events = 0;
  const reader = createEventReader(() => {
    events += 1;
  });
  for (const piece of pieces) reader.feed(piece);
  return events;
}

describe('createEventReader', () => {
  it('counts each data line and leaves heartbeats and other fields alone', () => {
    expect(eventsIn([': heartbeat\n\nevent: x\ndata: {}\n\ndata: {}\n\n'])).toBe(2);
  });

  it('counts a line once when it arrives in two pieces, even when the piece breaks inside "data:"', () => {
    expect(eventsIn(['da', 'ta: {}\n\n'])).toBe(1);
    expect(eventsIn(['data: {"a":', '1}\n', '\ndata: {}', '\n\n'])).toBe(2);
  });

  it('counts a line only once it is whole', () => {
    expect(eventsIn(['data: {}'])).toBe(0);
  });

  it('counts lines ended by a carriage return and a line feed', () => {
    expect(eventsIn(['data: {}\r\n\r\ndata: {}\r\n\r\n'])).toBe(2);
  });

  it('does not count a data line that is not at the start of its line', () => {
    expect(eventsIn([': not data: here\n'])).toBe(0);
  });

  it('gives up on a line that never ends, and carries on with the lines after it', () => {
    const endless = 'x'.repeat(2 * 1_048_576);
    expect(eventsIn([endless, '\ndata: {}\n\n'])).toBe(1);
  });

  it('does not read the end of a line it gave up on as a line of its own', () => {
    const endless = 'x'.repeat(2 * 1_048_576);
    expect(eventsIn([endless, 'data: not an event\ndata: {}\n\n'])).toBe(1);
  });
});
