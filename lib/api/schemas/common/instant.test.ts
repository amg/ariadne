import { describe, expect, it } from 'vitest';
import { instant } from './instant.ts';

describe('instant', () => {
  it('reads ISO text into a Date', () => {
    expect(instant.parse('2026-01-02T03:04:05.678Z')).toEqual(new Date('2026-01-02T03:04:05.678Z'));
  });

  it('refuses text that is not an ISO moment', () => {
    expect(instant.safeParse('yesterday').success).toBe(false);
  });
});
