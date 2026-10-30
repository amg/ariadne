/** What a generator's users hold at a moment: each figure rises and falls as users come and go. */
type Level = 'usersSignedIn' | 'pushStreamsOpen' | 'chattersActive';

export type Levels = {
  /** Moves one figure up or down by `change`. */
  move: (level: Level, change: number) => void;
  /** Holds a figure one higher for as long as `work` runs, however it ends. */
  during: <T>(level: Level, work: () => Promise<T>) => Promise<T>;
  /** Every figure as it stands now; each is zero before it has moved. */
  now: () => Readonly<Record<Level, number>>;
};

/** The levels of one generator's users, all at zero. */
export function createLevels(): Levels {
  const held: Record<Level, number> = { usersSignedIn: 0, pushStreamsOpen: 0, chattersActive: 0 };
  const move = (level: Level, change: number) => {
    held[level] += change;
  };
  return {
    move,
    async during(level, work) {
      move(level, 1);
      try {
        return await work();
      } finally {
        move(level, -1);
      }
    },
    now: () => ({ ...held }),
  };
}
