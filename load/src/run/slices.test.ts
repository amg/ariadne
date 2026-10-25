import { describe, expect, it } from 'vitest';
import { sliceUsers } from './slices.ts';

describe('sliceUsers', () => {
  it('gives each generator the same number of consecutive users when they divide', () => {
    expect(sliceUsers({ users: 20, generators: 4 })).toEqual([
      { generator: 0, firstUser: 0, userCount: 5 },
      { generator: 1, firstUser: 5, userCount: 5 },
      { generator: 2, firstUser: 10, userCount: 5 },
      { generator: 3, firstUser: 15, userCount: 5 },
    ]);
  });

  it('gives the first generators the extra users when they do not', () => {
    expect(sliceUsers({ users: 10, generators: 4 })).toEqual([
      { generator: 0, firstUser: 0, userCount: 3 },
      { generator: 1, firstUser: 3, userCount: 3 },
      { generator: 2, firstUser: 6, userCount: 2 },
      { generator: 3, firstUser: 8, userCount: 2 },
    ]);
  });
});
