import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

/** How much of a file is read at a time when it is checksummed. */
const CHECKSUM_PIECE_BYTES = 1_048_576;

/** The SHA-256 of some content in hex. */
export function sha256Of(content: string | Uint8Array) {
  return createHash('sha256').update(content).digest('hex');
}

/** The SHA-256 of a file in hex, read a piece at a time so that a file of any size is read with the memory of one piece. */
export function sha256OfFile(file: string) {
  const hash = createHash('sha256');
  const piece = Buffer.allocUnsafe(CHECKSUM_PIECE_BYTES);
  const descriptor = openSync(file, 'r');
  try {
    for (let read = readSync(descriptor, piece); read > 0; read = readSync(descriptor, piece)) {
      hash.update(piece.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}
