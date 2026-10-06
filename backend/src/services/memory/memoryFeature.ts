/** The segment of a Thread whose Facts are owed a capture. */
export interface SegmentToCapture {
  userId: string;
  threadId: string;
  segmentId: string;
}

/**
 * The shape of Memory this deployment runs as: off means nothing is
 * captured and no Seed is written or read.
 */
export function memoryFeature(): { kind: 'off' } | { kind: 'on' } {
  return { kind: 'on' };
}
