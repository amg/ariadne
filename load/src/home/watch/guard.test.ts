import { describe, expect, it } from 'vitest';
import { GUARD_LINES } from '../../criteria/guardLines.ts';
import type { HostSample } from '../../records/samples.ts';
import type { UsersSoFar } from '../types.ts';
import { judgeHost, judgeUsers, tightened } from './guard.ts';

const GIB = 1024 ** 3;

function hostAt(second: number, overrides: Partial<HostSample> = {}) {
  return {
    at: new Date(Date.UTC(2026, 9, 15, 0, 0, second)).toISOString(),
    cpuPercent: 10,
    perCorePercent: [10],
    memoryAvailableBytes: 9 * GIB,
    memoryUsedPercent: 45,
    swapUsedBytes: 1.9 * GIB,
    swapInBytes: 10 * GIB,
    swapOutBytes: 18 * GIB,
    loadAverage1: 0.5,
    ...overrides,
  };
}

function usersWith(input: Partial<UsersSoFar> = {}) {
  return { chatFirstBytesMs: [], attempts: 0, failed: 0, succeeded: {}, ...input };
}

describe('judgeHost', () => {
  it('passes a host at rest', () => {
    expect(judgeHost(GUARD_LINES, hostAt(2))).toBeNull();
  });

  it('stops when host CPU is over the line, and not when it is on it', () => {
    const line = GUARD_LINES.maxHostCpuPercent;
    expect(judgeHost(GUARD_LINES, hostAt(0, { cpuPercent: line }))).toBeNull();
    const breach = judgeHost(GUARD_LINES, hostAt(0, { cpuPercent: line + 0.1 }));
    expect(breach?.line).toBe('host-cpu');
    expect(breach?.message).toMatch(new RegExp(`${line + 0.1}%.*${line}% line`));
  });

  it('stops when memory in use is over the line, and not when it is on it', () => {
    const line = GUARD_LINES.maxMemoryUsedPercent;
    expect(judgeHost(GUARD_LINES, hostAt(0, { memoryUsedPercent: line }))).toBeNull();
    const breach = judgeHost(GUARD_LINES, hostAt(0, { memoryUsedPercent: line + 0.1 }));
    expect(breach?.line).toBe('memory');
    expect(breach?.message).toMatch(/80\.1%.*80% line/);
  });

  it('ignores swap, which is in use at rest and brings pages back in as load first touches them', () => {
    const sample = hostAt(2, { swapUsedBytes: 3.9 * GIB, swapInBytes: 20 * GIB });
    expect(judgeHost(GUARD_LINES, sample)).toBeNull();
  });

  it('names the first line crossed when several are', () => {
    const sample = hostAt(2, { cpuPercent: 90, memoryUsedPercent: 95 });
    expect(judgeHost(GUARD_LINES, sample)?.line).toBe('host-cpu');
  });
});

describe('judgeUsers', () => {
  const fast = Array.from({ length: 30 }, () => 200);

  it('judges nothing before any request was made', () => {
    expect(judgeUsers(GUARD_LINES, usersWith())).toBeNull();
  });

  it('passes users who were served fast with no failures', () => {
    expect(judgeUsers(GUARD_LINES, usersWith({ chatFirstBytesMs: fast, attempts: 30 }))).toBeNull();
  });

  it('stops when the first byte p95 is over the line', () => {
    const slow = [...Array.from({ length: 27 }, () => 200), 4_000, 4_000, 4_000];
    const breach = judgeUsers(GUARD_LINES, usersWith({ chatFirstBytesMs: slow }));
    expect(breach?.line).toBe('first-byte-p95');
    expect(breach?.message).toMatch(/4000 ms.*2500 ms line/);
  });

  it('lets a few slow replies through when the p95 holds', () => {
    const mostlyFast = [...Array.from({ length: 29 }, () => 200), 4_000];
    expect(judgeUsers(GUARD_LINES, usersWith({ chatFirstBytesMs: mostlyFast }))).toBeNull();
  });

  it('does not judge a percentile from too few replies', () => {
    expect(judgeUsers(GUARD_LINES, usersWith({ chatFirstBytesMs: [9_000, 9_000] }))).toBeNull();
  });

  it('stops when more than 1% of requests failed', () => {
    const breach = judgeUsers(GUARD_LINES, usersWith({ attempts: 100, failed: 2 }));
    expect(breach?.line).toBe('errors');
    expect(breach?.message).toMatch(/2\.0% of requests failed/);
  });

  it('passes exactly 1% failed', () => {
    expect(judgeUsers(GUARD_LINES, usersWith({ attempts: 100, failed: 1 }))).toBeNull();
  });

  it('does not judge a share from too few requests', () => {
    expect(judgeUsers(GUARD_LINES, usersWith({ attempts: 3, failed: 3 }))).toBeNull();
  });
});

describe('tightened', () => {
  it('lowers a line on purpose', () => {
    expect(tightened(GUARD_LINES, { maxHostCpuPercent: 1 }).maxHostCpuPercent).toBe(1);
    expect(tightened(GUARD_LINES, { maxMemoryUsedPercent: 40 }).maxMemoryUsedPercent).toBe(40);
  });

  it('refuses to loosen any line', () => {
    expect(() => tightened(GUARD_LINES, { maxHostCpuPercent: 80 })).toThrow(/loosen/);
    expect(() => tightened(GUARD_LINES, { maxMemoryUsedPercent: 90 })).toThrow(/loosen/);
    expect(() => tightened(GUARD_LINES, { maxFirstByteP95Ms: 5_000 })).toThrow(/loosen/);
    expect(() => tightened(GUARD_LINES, { maxErrorShare: 0.05 })).toThrow(/loosen/);
  });
});
