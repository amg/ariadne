import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { type RequestLine, requestRecords } from '../../records/index.ts';
import type { UsersSoFar } from '../types.ts';

const COUNTED_KINDS: ReadonlySet<RequestLine['kind']> = new Set([
  'signin',
  'thread',
  'chat',
  'chat-continue',
]);

/** The largest piece of a file read at once. */
const PIECE_BYTES = 1 << 20;

const NEWLINE = 0x0a;

/**
 * Follows the request lines that generators write into their output files,
 * reading only what was added since the last reading, to the end of each
 * file. A line that is not whole yet is read once it is.
 */
export function followRequests(): {
  /** Starts following one more output file. */
  follow: (file: string) => void;
  /** What every file followed so far adds up to now. */
  soFar: () => UsersSoFar;
} {
  const read = new Map<string, { offset: number; unfinished: Buffer }>();
  const chatFirstBytesMs: number[] = [];
  let attempts = 0;
  let failed = 0;
  const succeeded: Partial<Record<RequestLine['kind'], number>> = {};

  const take = (line: RequestLine): void => {
    if (line.outcome === 'ok' || line.outcome === 'streamed') {
      succeeded[line.kind] = (succeeded[line.kind] ?? 0) + 1;
    }
    if (line.kind === 'chat' || line.kind === 'chat-continue') {
      if (line.outcome === 'streamed') chatFirstBytesMs.push(line.firstByteMs);
    }
    if (!COUNTED_KINDS.has(line.kind)) return;
    attempts += 1;
    if (line.outcome === 'failed') failed += 1;
  };

  /** Takes every whole line of `bytes`, split on newlines before decoding so that no character is cut. */
  const takeWholeLines = (bytes: Buffer): Buffer => {
    let start = 0;
    for (let end = bytes.indexOf(NEWLINE, start); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
      const line = requestLineOrNull(bytes.subarray(start, end).toString('utf8'));
      if (line !== null) take(line);
      start = end + 1;
    }
    return Buffer.from(bytes.subarray(start));
  };

  const readMore = (file: string): void => {
    const state = read.get(file);
    if (state === undefined || !existsSync(file)) return;
    const size = statSync(file).size;
    if (size <= state.offset) return;
    const handle = openSync(file, 'r');
    try {
      while (state.offset < size) {
        const length = Math.min(size - state.offset, PIECE_BYTES);
        const piece = Buffer.alloc(length);
        const got = readSync(handle, piece, 0, length, state.offset);
        if (got === 0) break;
        state.offset += got;
        state.unfinished = takeWholeLines(
          Buffer.concat([state.unfinished, piece.subarray(0, got)]),
        );
      }
    } finally {
      closeSync(handle);
    }
  };

  return {
    follow: (file) => {
      if (!read.has(file)) read.set(file, { offset: 0, unfinished: Buffer.alloc(0) });
    },
    soFar: () => {
      for (const file of read.keys()) readMore(file);
      return {
        chatFirstBytesMs: [...chatFirstBytesMs],
        attempts,
        failed,
        succeeded: { ...succeeded },
      };
    },
  };
}

/** The request a `REQUEST` line of generator output carries; null for any other line, or one that does not read. */
function requestLineOrNull(text: string) {
  if (!text.startsWith('REQUEST ')) return null;
  try {
    return requestRecords.readLine(text.slice('REQUEST '.length), 1);
  } catch {
    return null;
  }
}
