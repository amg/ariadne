import { describe, expect, it } from 'vitest';
import { GUARD_LINES } from '../criteria/guardLines.ts';
import { parseAccountsCount, parseRunOptions } from './options.ts';
import { TargetRefused } from './stack/targets.ts';

describe('parseRunOptions', () => {
  it('uses the mock inference when none is named', () => {
    expect(parseRunOptions([]).inference).toBe('mock');
    expect(parseRunOptions(['--users', '10']).inference).toBe('mock');
  });

  it('uses real inference only when asked for it', () => {
    expect(parseRunOptions(['--inference', 'real']).inference).toBe('real');
  });

  it('refuses an inference it does not know rather than falling back', () => {
    expect(() => parseRunOptions(['--inference', 'reel'])).toThrow(/"mock" or "real"/);
  });

  it('runs against dev when no target is named', () => {
    expect(parseRunOptions(['--target', 'dev'])).toEqual(parseRunOptions([]));
  });

  it.each(['prod', 'production', 'staging', 'somewhere-else'])(
    'refuses the target %s',
    (target) => {
      expect(() => parseRunOptions(['--target', target])).toThrow(TargetRefused);
    },
  );

  it('sends an aws-prod step to the aws-prod command', () => {
    expect(() => parseRunOptions(['--target', 'step50'])).toThrow(/aws-prod load/);
  });

  it('runs tens of users unless told otherwise', () => {
    expect(parseRunOptions([]).users).toBe(20);
    expect(parseRunOptions(['--users', '35']).users).toBe(35);
  });

  it('refuses a run too large to be small, and users that make no sense', () => {
    expect(() => parseRunOptions(['--users', '51'])).toThrow(/--users/);
    expect(() => parseRunOptions(['--users', '0'])).toThrow(/--users/);
    expect(() => parseRunOptions(['--users', 'many'])).toThrow(/--users/);
  });

  it('holds a run for longer than dev’s five-minute access token unless told otherwise', () => {
    expect(parseRunOptions([]).holdSeconds).toBeGreaterThan(5 * 60);
  });

  it('holds a run for the minutes asked, within a limit', () => {
    expect(parseRunOptions(['--users', '5', '--hold-minutes', '11']).holdSeconds).toBe(660);
    expect(() => parseRunOptions(['--hold-minutes', '0'])).toThrow(/--hold-minutes/);
    expect(() => parseRunOptions(['--hold-minutes', '21'])).toThrow(/--hold-minutes/);
  });

  it('refuses the shapes and stages it no longer has', () => {
    expect(() => parseRunOptions(['--shape', 'cost'])).toThrow(/--shape/);
    expect(() => parseRunOptions(['--stages', '10,40'])).toThrow(/--stages/);
  });

  it('guards with the house lines unless one is tightened', () => {
    expect(parseRunOptions([]).guard).toEqual(GUARD_LINES);
    const guard = parseRunOptions(['--max-host-cpu', '1', '--max-memory-percent', '40']).guard;
    expect(guard.maxHostCpuPercent).toBe(1);
    expect(guard.maxMemoryUsedPercent).toBe(40);
    expect(guard.maxFirstByteP95Ms).toBe(GUARD_LINES.maxFirstByteP95Ms);
  });

  it('reads the error line in percent', () => {
    expect(parseRunOptions(['--max-error-percent', '0.5']).guard.maxErrorShare).toBe(0.005);
  });

  it('refuses to loosen a guard line', () => {
    expect(() => parseRunOptions(['--max-host-cpu', '80'])).toThrow(/loosen/);
    expect(() => parseRunOptions(['--max-memory-percent', '90'])).toThrow(/loosen/);
    expect(() => parseRunOptions(['--max-first-byte-ms', 'slow'])).toThrow(/--max-first-byte-ms/);
  });

  it('refuses an option it does not know', () => {
    expect(() => parseRunOptions(['--user', '3'])).toThrow();
  });
});

describe('parseAccountsCount', () => {
  it('makes a few hundred accounts by default', () => {
    expect(parseAccountsCount([])).toBe(300);
    expect(parseAccountsCount(['--users', '50'])).toBe(50);
  });

  it('refuses a count outside the account numbering', () => {
    expect(() => parseAccountsCount(['--users', '5000'])).toThrow(/--users/);
  });
});

describe('parseRunOptions generators', () => {
  it('shares the users between four generators, so that losing one leaves the others', () => {
    expect(parseRunOptions([]).generators).toBe(4);
  });

  it('never has more generators than users', () => {
    expect(parseRunOptions(['--users', '3']).generators).toBe(3);
    expect(() => parseRunOptions(['--users', '3', '--generators', '4'])).toThrow(/needs a user/);
  });

  it('takes the number of generators from its option, within a limit', () => {
    expect(parseRunOptions(['--users', '20', '--generators', '2']).generators).toBe(2);
    expect(() => parseRunOptions(['--generators', '11'])).toThrow(/--generators/);
    expect(() => parseRunOptions(['--generators', '0'])).toThrow(/--generators/);
  });
});
