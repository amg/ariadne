let open = 0;

/**
 * Counts a push stream as open on this copy. Call the result once when the
 * stream closes; calling it again changes nothing.
 */
export function countPushStream() {
  open += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open -= 1;
  };
}

/** How many push streams are open on this copy now. */
export function pushStreamsOpen() {
  return open;
}
