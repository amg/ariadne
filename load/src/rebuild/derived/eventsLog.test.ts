import { describe, expect, it } from 'vitest';
import { eventsLog } from './eventsLog.ts';

describe('eventsLog', () => {
  it('writes one line a moment, the time and then what happened, in the order given', () => {
    expect(
      eventsLog([
        { at: '2026-10-15T00:00:00.000Z', text: 'run started' },
        { at: '2026-10-15T00:01:00.000Z', text: 'run ended (finished)' },
      ]),
    ).toBe(
      '2026-10-15T00:00:00.000Z  run started\n2026-10-15T00:01:00.000Z  run ended (finished)\n',
    );
  });
});
