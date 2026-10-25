import { describe, expect, it } from 'vitest';
import { updateFact } from './facts.ts';

describe('a Fact update', () => {
  it('reads a suppression toggle and drops anything else sent with it', () => {
    expect(updateFact.body.parse({ suppressed: true, content: 'x' })).toEqual({ suppressed: true });
  });

  it('reads a content edit', () => {
    expect(updateFact.body.parse({ content: 'Lives in Lisbon.' })).toEqual({
      content: 'Lives in Lisbon.',
    });
  });

  it('refuses a body that is neither', () => {
    expect(updateFact.body.safeParse({}).success).toBe(false);
  });
});
