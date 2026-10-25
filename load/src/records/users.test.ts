import { describe, expect, it } from 'vitest';
import { formattedUserRange, lastUserOf } from './users.ts';

describe('user slices', () => {
  it('ends on the last of the users it holds', () => {
    expect(lastUserOf({ firstUser: 3, userCount: 3 })).toBe(5);
    expect(lastUserOf({ firstUser: 7, userCount: 1 })).toBe(7);
  });

  it('is written as a range', () => {
    expect(formattedUserRange({ firstUser: 3, userCount: 3 })).toBe('3 to 5');
  });
});
