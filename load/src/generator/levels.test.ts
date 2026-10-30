import { describe, expect, it } from 'vitest';
import { createLevels } from './levels.ts';

describe('createLevels', () => {
  it('starts every figure at zero, and moves each up and down on its own', () => {
    const levels = createLevels();
    expect(levels.now()).toEqual({ usersSignedIn: 0, pushStreamsOpen: 0, chattersActive: 0 });

    levels.move('usersSignedIn', 2);
    levels.move('pushStreamsOpen', 1);
    levels.move('usersSignedIn', -1);

    expect(levels.now()).toEqual({ usersSignedIn: 1, pushStreamsOpen: 1, chattersActive: 0 });
  });

  it('gives a copy, so a later move does not change what was read', () => {
    const levels = createLevels();
    const before = levels.now();

    levels.move('chattersActive', 1);

    expect(before.chattersActive).toBe(0);
  });

  it('holds a figure up while work runs, and lets it down when the work fails', async () => {
    const levels = createLevels();
    let during = -1;

    await expect(
      levels.during('chattersActive', async () => {
        during = levels.now().chattersActive;
        throw new Error('down');
      }),
    ).rejects.toThrow('down');

    expect(during).toBe(1);
    expect(levels.now().chattersActive).toBe(0);
  });

  it('gives back what the work returned', async () => {
    await expect(createLevels().during('usersSignedIn', async () => 7)).resolves.toBe(7);
  });
});
