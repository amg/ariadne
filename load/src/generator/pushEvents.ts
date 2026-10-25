/** The longest a line of a push stream may grow before it is given up on, so that a stream without line breaks cannot fill memory. */
const MOST_LINE_LENGTH = 1_048_576;

/**
 * Counts the events of a push stream as its text arrives in pieces of any
 * size. A line is read once it is whole, so a line split between two
 * pieces is counted once. Each `data:` line is an event; a comment line,
 * such as a heartbeat, is not.
 */
export function createEventReader(onEvent: () => void): { feed: (text: string) => void } {
  let unfinished = '';
  // A line that outgrew the limit is skipped to its end, which is not read as a line of its own.
  let skipping = false;
  return {
    feed(text) {
      const lines = (unfinished + text).split('\n');
      unfinished = lines.pop() ?? '';
      for (const line of lines) {
        if (skipping) skipping = false;
        else if (line.startsWith('data:')) onEvent();
      }
      if (unfinished.length > MOST_LINE_LENGTH) {
        unfinished = '';
        skipping = true;
      }
    },
  };
}
