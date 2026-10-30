import { useState } from 'react';

/** The ids of rows hidden at once, before the server's rows agree that they are gone. */
export function useDroppedIds() {
  const [droppedIds, setDroppedIds] = useState<ReadonlySet<string>>(new Set());
  return {
    droppedIds,
    dropIds: (ids: readonly string[]) => setDroppedIds((prev) => new Set([...prev, ...ids])),
  };
}
