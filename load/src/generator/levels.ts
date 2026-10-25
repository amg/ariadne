/** What a generator's users hold at a moment: each figure rises and falls as users come and go. */
type Level = 'usersSignedIn' | 'pushStreamsOpen' | 'chattersActive';

export type Levels = {
  /** Moves one figure up or down by `change`. */
  move: (level: Level, change: number) => void;
  /** Every figure as it stands now; each is zero before it has moved. */
  now: () => Readonly<Record<Level, number>>;
};

/** The levels of one generator's users, all at zero. */
export function createLevels(): Levels {
  const held: Record<Level, number> = { usersSignedIn: 0, pushStreamsOpen: 0, chattersActive: 0 };
  return {
    move(level, change) {
      held[level] += change;
    },
    now: () => ({ ...held }),
  };
}
