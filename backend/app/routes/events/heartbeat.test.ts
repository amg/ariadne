import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { beatOrEnd } from './get';

/** A stream whose reader takes nothing: every write stays queued. */
function unreadStream() {
  const written: string[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, _taken) {
      written.push(chunk.toString());
    },
  });
  return { stream, written };
}

/** A stream whose reader takes every write at once. */
function readStream() {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, taken) {
      written.push(chunk.toString());
      taken();
    },
  });
  return { stream, written };
}

describe('the push stream heartbeat', () => {
  it('beats on a stream that takes what is written to it', () => {
    const { stream, written } = readStream();
    beatOrEnd(stream);
    beatOrEnd(stream);
    expect(written).toEqual([': heartbeat\n\n', ': heartbeat\n\n']);
    expect(stream.destroyed).toBe(false);
  });

  it('ends a stream that has not taken the last heartbeat by the next one, and so closes it', async () => {
    const { stream, written } = unreadStream();
    const closed = new Promise<void>((resolve) => stream.on('close', () => resolve()));

    beatOrEnd(stream);
    expect(stream.destroyed).toBe(false);
    beatOrEnd(stream);

    expect(stream.destroyed).toBe(true);
    await closed;
    expect(written).toEqual([': heartbeat\n\n']);
  });

  it('leaves a stream that has already ended alone', () => {
    const { stream, written } = readStream();
    stream.destroy();
    beatOrEnd(stream);
    expect(written).toEqual([]);
  });
});
