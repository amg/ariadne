import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

/**
 * The lines of a text file, read a piece at a time, so that a file of any
 * size is read with the memory of one piece. A last line that a newline did
 * not end is given too, marked incomplete: whatever wrote it may have been
 * cut off.
 */
export async function* linesOfFile(file: string) {
  const source = createReadStream(file);
  source.setEncoding('utf8');
  let held = '';
  for await (const piece of source) {
    held += piece;
    let start = 0;
    for (let end = held.indexOf('\n', start); end !== -1; end = held.indexOf('\n', start)) {
      yield { text: held.slice(start, end), complete: true };
      start = end + 1;
    }
    held = held.slice(start);
  }
  if (held !== '') yield { text: held, complete: false };
}

/** Somewhere lines are written one at a time. */
export type LineSink = {
  /** Writes a line and its newline; resolves once the file can take more. */
  write: (line: string) => Promise<void>;
  /** Writes what is left and closes the file. */
  end: () => Promise<void>;
};

/** A sink into a file, which is made empty first. A write that outpaces the disk waits for it. */
export function lineSink(file: string): LineSink {
  const stream = createWriteStream(file);
  let failure: Error | null = null;
  stream.on('error', (error) => {
    failure = error;
  });
  const check = (): void => {
    if (failure !== null) throw failure;
  };
  return {
    async write(line) {
      check();
      if (!stream.write(`${line}\n`)) await once(stream, 'drain');
      check();
    },
    async end() {
      stream.end();
      await finished(stream);
      check();
    },
  };
}
