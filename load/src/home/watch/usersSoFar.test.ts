import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RequestLine } from '../../records/index.ts';
import { followRequests } from './usersSoFar.ts';

const request = (overrides: Partial<RequestLine>) =>
  `REQUEST ${JSON.stringify({
    run: 'run-1',
    generator: 0,
    attempt: 1,
    user: 0,
    kind: 'chat',
    startedAt: '2026-10-15T00:00:00.000Z',
    firstByteMs: 100,
    totalMs: 200,
    status: 200,
    outcome: 'streamed',
    errorCode: null,
    ...overrides,
  })}\n`;

const outputFile = () => join(mkdtempSync(join(tmpdir(), 'users-')), 'generator.out');

describe('followRequests', () => {
  it('adds up the requests of every file it follows, and skips other lines', () => {
    const one = outputFile();
    const two = outputFile();
    writeFileSync(
      one,
      `starting\n${request({ firstByteMs: 120 })}${request({ kind: 'signin', outcome: 'failed', status: 500 })}`,
    );
    writeFileSync(
      two,
      `STATE {}\n${request({ kind: 'push', outcome: 'held' })}${request({ kind: 'signup', outcome: 'ok' })}`,
    );
    const requests = followRequests();
    requests.follow(one);
    requests.follow(two);

    expect(requests.soFar()).toEqual({
      chatFirstBytesMs: [120],
      attempts: 2,
      failed: 1,
      succeeded: { chat: 1, signup: 1 },
    });
  });

  it('reads only what was added since, and a line once it is whole', () => {
    const file = outputFile();
    const line = request({});
    writeFileSync(file, line.slice(0, 20));
    const requests = followRequests();
    requests.follow(file);

    expect(requests.soFar().attempts).toBe(0);
    appendFileSync(file, `${line.slice(20)}${request({})}`);
    expect(requests.soFar().attempts).toBe(2);
    expect(requests.soFar().attempts).toBe(2);
  });

  it('counts a chat turned away for load as tried, and not as failed', () => {
    const file = outputFile();
    writeFileSync(file, request({ outcome: 'refused', status: 429 }));
    const requests = followRequests();
    requests.follow(file);

    expect(requests.soFar()).toMatchObject({ attempts: 1, failed: 0 });
  });

  it('follows a file that is not there yet, and reads it once it is', () => {
    const file = outputFile();
    const requests = followRequests();
    requests.follow(file);

    expect(requests.soFar().attempts).toBe(0);
    writeFileSync(file, request({}));
    expect(requests.soFar().attempts).toBe(1);
  });
});

describe('followRequests on a long output', () => {
  it('reads to the end of a file far longer than one piece, in one reading', () => {
    const file = outputFile();
    const lines = Array.from({ length: 8_000 }, () => request({ kind: 'signup', outcome: 'ok' }));
    writeFileSync(file, lines.join(''));
    const requests = followRequests();
    requests.follow(file);

    expect(requests.soFar().succeeded.signup).toBe(8_000);
  });

  it('keeps a character whole when a line is longer than a piece', () => {
    const file = outputFile();
    writeFileSync(file, request({ errorCode: 'é'.repeat(600_000) }));
    const requests = followRequests();
    requests.follow(file);

    expect(requests.soFar().succeeded.chat).toBe(1);
  });
});
