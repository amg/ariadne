import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sortAppRecordsOfFiles } from './appRecords.ts';

const pino = (appRecord: object) =>
  JSON.stringify({ level: 30, time: 1, pid: 7, hostname: 'h', appRecord, msg: 'app record' });

/** Sorts logs through sinks that collect lines, as a file does. */
async function sortedFrom(logs: readonly string[], window: { from: Date; to: Date } | null) {
  const folder = mkdtempSync(join(tmpdir(), 'app-records-'));
  const files = logs.map((log, index) => {
    const file = join(folder, `${index}.log`);
    writeFileSync(file, log);
    return file;
  });
  const taken: Record<'exchanges' | 'jobs' | 'requests' | 'states', string[]> = {
    exchanges: [],
    jobs: [],
    requests: [],
    states: [],
  };
  const sink = (list: keyof typeof taken) => ({
    write: async (line: string) => void taken[list].push(line),
    end: async () => undefined,
  });
  await sortAppRecordsOfFiles(
    files,
    {
      exchanges: sink('exchanges'),
      jobs: sink('jobs'),
      requests: sink('requests'),
      states: sink('states'),
    },
    window,
  );
  return taken;
}

describe('sortAppRecordsOfFiles', () => {
  it('picks each kind of record out of the log, without the logger’s own fields', async () => {
    const log = [
      '◇ injected env (23) from ../.env',
      JSON.stringify({ level: 30, msg: 'Server listening' }),
      pino({ kind: 'exchange', userId: 'u1', outcome: 'completed' }),
      pino({ kind: 'job', task: 'driftGateJudgeArrival' }),
      pino({ kind: 'state', at: 'a', pushStreamsOpen: 2 }),
      pino({ kind: 'exchange', userId: 'u2', outcome: 'paused' }),
      '',
    ].join('\n');

    expect(await sortedFrom([log], null)).toEqual({
      exchanges: ['{"userId":"u1","outcome":"completed"}', '{"userId":"u2","outcome":"paused"}'],
      jobs: ['{"task":"driftGateJudgeArrival"}'],
      requests: [],
      states: ['{"at":"a","pushStreamsOpen":2}'],
    });
  });

  it('sorts a request record into its own list and keeps it by when its response ended', async () => {
    const window = {
      from: new Date('2026-10-15T00:10:00.000Z'),
      to: new Date('2026-10-15T00:12:00.000Z'),
    };
    const log = [
      pino({ kind: 'request', endedAt: '2026-10-15T00:09:59.000Z', route: '/early' }),
      pino({ kind: 'request', endedAt: '2026-10-15T00:11:00.000Z', route: '/inside' }),
      '',
    ].join('\n');

    expect((await sortedFrom([log], null)).requests).toHaveLength(2);
    expect((await sortedFrom([log], window)).requests).toEqual([
      '{"endedAt":"2026-10-15T00:11:00.000Z","route":"/inside"}',
    ]);
  });

  it('keeps only the records that happened inside a window, by when each kind says it did', async () => {
    const window = {
      from: new Date('2026-10-15T00:10:00.000Z'),
      to: new Date('2026-10-15T00:12:00.000Z'),
    };
    const log = [
      pino({ kind: 'exchange', arrivedAt: '2026-10-15T00:09:59.000Z' }),
      pino({ kind: 'exchange', arrivedAt: '2026-10-15T00:11:00.000Z' }),
      pino({
        kind: 'job',
        queuedAt: '2026-10-15T00:09:00.000Z',
        startedAt: '2026-10-15T00:10:30.000Z',
      }),
      pino({
        kind: 'job',
        queuedAt: '2026-10-15T00:11:00.000Z',
        startedAt: '2026-10-15T00:13:00.000Z',
      }),
      pino({ kind: 'state', at: '2026-10-15T00:12:00.000Z' }),
      pino({ kind: 'state', at: 'not a time' }),
      '',
    ].join('\n');

    const sorted = await sortedFrom([log], window);

    expect(sorted.exchanges).toEqual(['{"arrivedAt":"2026-10-15T00:11:00.000Z"}']);
    expect(sorted.jobs).toHaveLength(1);
    expect(sorted.jobs[0]).toContain('00:10:30');
    expect(sorted.states).toEqual(['{"at":"2026-10-15T00:12:00.000Z"}']);
  });

  it('reads a record whose line leads with when and where it was logged', async () => {
    const log = `2026-10-15T00:10:00.000Z api/api/0f1e2d ${pino({ kind: 'state', at: 'a' })}\n`;

    expect((await sortedFrom([log], null)).states).toEqual(['{"at":"a"}']);
  });

  it('leaves out a half-written last line', async () => {
    const log = `${pino({ kind: 'state', at: 'a' })}\n${pino({ kind: 'state', at: 'b' }).slice(0, 40)}`;

    expect((await sortedFrom([log], null)).states).toEqual(['{"at":"a"}']);
  });

  it('leaves out what only looks like a record', async () => {
    const log = [
      'the word "appRecord" in a plain line',
      JSON.stringify({ appRecord: 'a string' }),
      JSON.stringify({ appRecord: [1] }),
      pino({ kind: 'mystery', field: 1 }),
      pino({ kind: 'toString' }),
      '',
    ].join('\n');

    expect(await sortedFrom([log], null)).toEqual({
      exchanges: [],
      jobs: [],
      requests: [],
      states: [],
    });
  });

  it('is empty for an empty log', async () => {
    expect(await sortedFrom([''], null)).toEqual({
      exchanges: [],
      jobs: [],
      requests: [],
      states: [],
    });
  });
});

describe('sortAppRecordsOfFiles across logs', () => {
  const logs = [
    `${[
      'listening',
      pino({ kind: 'exchange', userId: 'u1', arrivedAt: '2026-10-15T00:11:00.000Z' }),
      pino({ kind: 'job', task: 't', startedAt: '2026-10-15T00:01:00.000Z' }),
      pino({ kind: 'state', at: '2026-10-15T00:11:30.000Z' }),
    ].join('\n')}\n`,
    `${pino({ kind: 'exchange', userId: 'u2', arrivedAt: '2026-10-15T00:11:10.000Z' })}\n${pino({ kind: 'exchange', userId: 'cut' }).slice(0, 40)}`,
  ];
  const window = {
    from: new Date('2026-10-15T00:10:00.000Z'),
    to: new Date('2026-10-15T00:12:00.000Z'),
  };

  it('keeps the records of each log in the order the logs are given', async () => {
    expect(await sortedFrom(logs, null)).toEqual({
      exchanges: [
        '{"userId":"u1","arrivedAt":"2026-10-15T00:11:00.000Z"}',
        '{"userId":"u2","arrivedAt":"2026-10-15T00:11:10.000Z"}',
      ],
      jobs: ['{"task":"t","startedAt":"2026-10-15T00:01:00.000Z"}'],
      requests: [],
      states: ['{"at":"2026-10-15T00:11:30.000Z"}'],
    });
  });

  it('keeps those inside a window, from every log', async () => {
    const sorted = await sortedFrom(logs, window);

    expect(sorted.exchanges).toHaveLength(2);
    expect(sorted.jobs).toEqual([]);
    expect(sorted.states).toHaveLength(1);
  });

  it('leaves out the half line a cut-off backend left at the end of its log', async () => {
    const sorted = await sortedFrom(logs, null);

    expect(sorted.exchanges.some((line) => line.includes('cut'))).toBe(false);
  });
});
