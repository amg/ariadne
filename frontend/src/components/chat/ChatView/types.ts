export type ChatViewStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * Where an arrival with no reply stands while it waits on a retry: still
 * being judged, judged clear with its reply owed, or its judgment gave up.
 */
export type UnansweredArrival = 'pending' | 'cleared' | 'failed';
