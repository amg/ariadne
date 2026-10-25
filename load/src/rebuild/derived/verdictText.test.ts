import { describe, expect, it } from 'vitest';
import type { Judgement } from '../../types/criteria.ts';
import { runFactsOf } from '../facts/index.ts';
import { summarizeSlices } from '../facts/slices.ts';
import { at, requestWith, runDataWith, sliceDataWith, sliceWith } from '../runData/testing.ts';
import {
  cellText,
  holdLines,
  limitText,
  pushStreamLines,
  reasonText,
  refreshLines,
  sliceLines,
  slicesWhenAnyDown,
  verdictText,
} from './verdictText.ts';

const judgement = (unit: Judgement['unit'], limit: number): Judgement => ({
  id: 'x',
  title: 'The figure',
  unit,
  direction: 'at-most',
  limit,
  observed: null,
  result: 'fail',
});

describe('reasonText', () => {
  it('words a missed criterion in the unit it is measured in', () => {
    expect(
      reasonText({
        kind: 'criterion-missed',
        judgement: judgement('percent', 70),
        observed: 81.04,
      }),
    ).toBe('The figure was 81%, past its limit (at most 70%)');
    expect(
      reasonText({ kind: 'criterion-missed', judgement: judgement('ms', 2_500), observed: 2_800 }),
    ).toBe('The figure was 2800 ms, past its limit (at most 2500 ms)');
    expect(
      reasonText({
        kind: 'criterion-missed',
        judgement: judgement('share', 0.01),
        observed: 0.0512,
      }),
    ).toBe('The figure was 5.12%, past its limit (at most 1%)');
  });

  it('words every other thing that stands between a run and a pass', () => {
    expect(reasonText({ kind: 'criterion-not-judged', title: 'Memory in use' })).toBe(
      'Memory in use was not judged: the run recorded nothing to judge it by',
    );
    expect(reasonText({ kind: 'guard-stopped', message: 'host CPU was 81%' })).toBe(
      'the guard stopped the run: host CPU was 81%',
    );
    expect(reasonText({ kind: 'sealed-incomplete', findings: 1 })).toBe(
      'the archive sealed the run as incomplete (1 finding)',
    );
    expect(reasonText({ kind: 'sealed-incomplete', findings: 3 })).toBe(
      'the archive sealed the run as incomplete (3 findings)',
    );
    expect(
      reasonText({
        kind: 'file-unusable',
        path: 'a.jsonl',
        why: 'is gone since the run was sealed',
      }),
    ).toBe('a.jsonl is gone since the run was sealed');
    expect(
      reasonText({ kind: 'records-disagree', what: 'replies streamed', against: 'the API' }),
    ).toBe('the generators and the API disagree on replies streamed');
    expect(
      reasonText({
        kind: 'records-disagree',
        what: 'server errors (500s)',
        against: 'the load balancer',
      }),
    ).toBe('the generators and the load balancer disagree on server errors (500s)');
    expect(
      reasonText({
        kind: 'cross-check-not-made',
        against: 'the load balancer',
        why: 'the load balancer’s metrics are missing',
      }),
    ).toBe(
      'the generators could not be checked against the load balancer: the load balancer’s metrics are missing',
    );
    expect(reasonText({ kind: 'never-ended' })).toBe('the run never recorded its end');
    expect(reasonText({ kind: 'ended-early', outcome: 'guard' })).toBe(
      'the run ended early (guard)',
    );
  });
});

describe('refreshLines', () => {
  const dataWith = (...lines: ReturnType<typeof requestWith>[]) =>
    runFactsOf(runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] })).summary;
  const refresh = (overrides: Parameters<typeof requestWith>[0]) =>
    requestWith({ kind: 'refresh', status: 200, outcome: 'ok', ...overrides });

  it('says so when no session was refreshed', () => {
    expect(refreshLines(dataWith(requestWith()))).toContain('None recorded.');
  });

  it('counts the refreshes and says no session was ended when every one renewed', () => {
    const lines = refreshLines(dataWith(refresh({}), refresh({})));
    expect(lines).toContain('2 refreshes: 2 renewed a session and 0 failed.');
    expect(lines).toContain('No session was ended.');
  });

  it('names the sessions the auth core ended, by the reason it gave', () => {
    const lines = refreshLines(
      dataWith(
        refresh({}),
        refresh({ outcome: 'failed', status: 401, errorCode: 'token theft detected' }),
        refresh({ outcome: 'failed', status: 401, errorCode: 'token theft detected' }),
        refresh({ outcome: 'failed', status: null, errorCode: 'unreachable' }),
      ),
    );
    expect(lines).toContain('4 refreshes: 1 renewed a session and 3 failed.');
    expect(lines).toContain('Sessions the auth core ended: 2 (token theft detected: 2).');
  });
});

describe('a criterion held from below', () => {
  const atLeast = (unit: Judgement['unit'], limit: number): Judgement => ({
    ...judgement(unit, limit),
    direction: 'at-least',
  });

  it('words its limit as at least, and a miss as short of it', () => {
    expect(limitText(atLeast('count', 49_000))).toBe('at least 49,000');
    expect(limitText(judgement('count', 49_000))).toBe('at most 49,000');
    expect(
      reasonText({
        kind: 'criterion-missed',
        judgement: atLeast('count', 49_000),
        observed: 48_120,
      }),
    ).toBe('The figure was 48,120, short of its limit (at least 49,000)');
  });

  it('keeps a limit held from above worded as past it', () => {
    expect(
      reasonText({ kind: 'criterion-missed', judgement: judgement('count', 100), observed: 120 }),
    ).toBe('The figure was 120, past its limit (at most 100)');
  });
});

describe('cellText', () => {
  it('keeps a bar from starting a new cell and a line break from ending the row', () => {
    expect(cellText('a | b')).toBe('a \\| b');
    expect(cellText('first\nsecond\r\nthird')).toBe('first second third');
  });

  it('escapes a backslash, so that it cannot escape the bar after it', () => {
    expect(cellText('a\\|b')).toBe('a\\\\\\|b');
  });

  it('writes a missing figure as n/a and a number as itself', () => {
    expect(cellText(null)).toBe('n/a');
    expect(cellText(12)).toBe('12');
  });
});

describe('the verdict’s tables', () => {
  it('keep every row to its columns when a cell holds a bar', () => {
    const text = verdictText({
      facts: {
        ...runFactsOf(runDataWith()),
        gaps: [
          {
            source: 'metrics/x.jsonl',
            from: at(0),
            to: at(60),
            reason: 'a | b went quiet\nfor a while',
          },
        ],
      },
      decision: { verdict: 'pass', reasons: [] },
      judgements: [],
      crossChecks: [],
    });

    const row = text.split('\n').find((line) => line.includes('went quiet'));
    expect(row).toBe(`| metrics/x.jsonl | ${at(0)} | ${at(60)} | a \\| b went quiet for a while |`);
  });
});

describe('sliceLines', () => {
  const down = sliceWith({
    generator: 1,
    firstUser: 10,
    userCount: 5,
    down: [{ from: at(60), to: at(122), reason: 'x' }],
  });
  const slices = summarizeSlices(
    runDataWith({
      slices: [
        sliceDataWith(sliceWith({ generator: 0, userCount: 10 }), {
          requests: Array.from({ length: 7 }, () => requestWith({ outcome: 'streamed' })),
        }),
        sliceDataWith(down, {
          requests: Array.from({ length: 6 }, () => requestWith({ outcome: 'streamed' })),
        }),
      ],
    }),
  );

  it('says nothing when no slice was down', () => {
    expect(sliceLines(null)).toEqual([]);
    expect(slicesWhenAnyDown(slices.slice(0, 1))).toBeNull();
  });

  it('lists every slice, and says what the criteria left out', () => {
    const text = sliceLines(slicesWhenAnyDown(slices)).join('\n');

    expect(text).toContain('| 1 | 10 to 14 | 1 | 6 | 0 | 6 | 62 |');
    expect(text).toContain('| 0 | 0 to 9 | 0 | 7 | 0 | 7 | 0 |');
    expect(text).toContain('judged without');
  });
});

describe('the verdict’s account of the hold', () => {
  it('names the fewest streams and chatters with their moments, and the hold’s own p95', () => {
    const text = holdLines({
      from: at(60),
      to: at(240),
      fewestPushStreams: { count: 9_575, at: at(68) },
      fewestChatters: { count: 1_999, at: at(61) },
      chatsStreamed: 74_909,
      chatFirstByteP95Ms: 4_923.6,
    }).join('\n');

    expect(text).toContain(`| Fewest push streams | 9,575 | ${at(68)} |`);
    expect(text).toContain(`| Fewest chatters | 1,999 | ${at(61)} |`);
    expect(text).toContain(
      '| Chat first byte p95, in the hold alone | 4923.6 ms over 74,909 chats |',
    );
  });

  it('says nothing of a run with no hold', () => {
    expect(holdLines(null)).toEqual([]);
  });
});

describe('the verdict’s account of push streams that ended early', () => {
  it('says how many were cut off and reopened, and the minute the most ended in', () => {
    const text = pushStreamLines({
      pushStreams: {
        opened: 18_797,
        endedEarly: 8_797,
        cut: 8_797,
        reopened: 8_790,
        reopenedWithinSeconds: 10,
        mostEndedInAMinute: { minute: at(60), count: 3_656 },
      },
    }).join('\n');

    expect(text).toContain('| Opened | 18,797 |');
    expect(text).toContain('| Ended before their users let them go | 8,797 |');
    expect(text).toContain('| Of those, cut off rather than closed | 8,797 |');
    expect(text).toContain('| Of those, opened again within 10 s | 8,790 |');
    expect(text).toContain(`| Most that ended in one minute | 3,656, at ${at(60)} |`);
  });

  it('says nothing of a run whose generators opened no push stream', () => {
    expect(
      pushStreamLines({
        pushStreams: {
          opened: 0,
          endedEarly: 0,
          cut: 0,
          reopened: 0,
          reopenedWithinSeconds: 10,
          mostEndedInAMinute: null,
        },
      }),
    ).toEqual([]);
  });
});
