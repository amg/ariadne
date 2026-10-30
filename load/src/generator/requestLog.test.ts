import { describe, expect, it } from 'vitest';
import { requestSchema } from '../records/request.ts';
import { createRequestLog, startStopwatch } from './requestLog.ts';

const details = {
  kind: 'chat',
  startedAt: '2026-10-15T00:00:00.123Z',
  firstByteMs: 120.5,
  totalMs: 900.25,
  status: 200,
  outcome: 'streamed',
  errorCode: null,
} as const;

describe('createRequestLog', () => {
  it('writes one line per request, naming who made it', () => {
    const lines: string[] = [];
    const log = createRequestLog({
      who: { run: 'run-1', generator: 2, attempt: 3 },
      emit: (line) => lines.push(line),
    });

    log.forUser(7).record(details);

    expect(lines).toHaveLength(1);
    const [prefix, json] = (lines[0] ?? '').split(/ (.*)/s);
    expect(prefix).toBe('REQUEST');
    expect(requestSchema.parse(JSON.parse(json ?? ''))).toEqual({
      run: 'run-1',
      generator: 2,
      attempt: 3,
      user: 7,
      ...details,
    });
  });

  it('writes each line with its figures where metrics are published', () => {
    const lines: string[] = [];
    const log = createRequestLog({
      who: { run: 'run-1', generator: 2, attempt: 3 },
      emit: (line) => lines.push(line),
      publishMetrics: true,
    });

    log.forUser(7).record(details);

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      request: { user: 7, kind: 'chat' },
      ChatFirstByteMs: 120.5,
    });
  });

  it('counts the lines it wrote, in all and by kind', () => {
    const log = createRequestLog({
      who: { run: 'run-1', generator: 0, attempt: 1 },
      emit: () => undefined,
    });

    log.forUser(1).record(details);
    log.forUser(2).record(details);
    log.forUser(2).record({ ...details, kind: 'push' });

    expect(log.counts()).toEqual({ total: 3, byKind: { chat: 2, push: 1 } });
  });
});

describe('startStopwatch', () => {
  it('starts at the wall clock, in UTC with milliseconds', () => {
    expect(startStopwatch().startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('measures from a monotonic clock that never runs backwards', () => {
    const watch = startStopwatch();
    const first = watch.elapsedMs();

    expect(first).toBeGreaterThanOrEqual(0);
    expect(watch.elapsedMs()).toBeGreaterThanOrEqual(first);
  });
});
