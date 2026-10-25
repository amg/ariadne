import type { HostSample } from '../../records/index.ts';
import type { GuardLines } from '../../types/criteria.ts';
import type { UsersSoFar } from '../types.ts';

/** Fewer requests than this say too little to judge a share or a percentile. */
const MIN_REQUESTS_TO_JUDGE = 20;

type GuardLine = 'host-cpu' | 'memory' | 'first-byte-p95' | 'errors' | 'host-unreadable';

/** A line that was crossed, and by how much. */
type Breach = {
  line: GuardLine;
  observed: number;
  limit: number;
  message: string;
};

/** A run stopped by the guard. */
export class GuardTripped extends Error {
  readonly breach: Breach;

  constructor(breach: Breach) {
    super(`Stopped by the guard: ${breach.message}`);
    this.breach = breach;
  }
}

/**
 * The lines with the given ones made stricter. A line can be tightened on
 * purpose, to see the guard act; it cannot be loosened, because the guard
 * exists to protect the house.
 */
export function tightened(lines: GuardLines, overrides: Partial<GuardLines>) {
  for (const [name, wanted] of Object.entries(overrides)) {
    // The names come from `overrides`, which is typed by GuardLines.
    const key = name as keyof GuardLines;
    const limit = lines[key];
    if (wanted > limit)
      throw new Error(`${name} of ${wanted} would loosen the guard's line of ${limit}`);
  }
  return { ...lines, ...overrides };
}

/** Judges the host from one reading, by level: CPU and memory in use. */
export function judgeHost(lines: GuardLines, current: HostSample): Breach | null {
  if (current.cpuPercent > lines.maxHostCpuPercent) {
    return {
      line: 'host-cpu',
      observed: current.cpuPercent,
      limit: lines.maxHostCpuPercent,
      message: `host CPU was ${current.cpuPercent.toFixed(1)}%, over the ${lines.maxHostCpuPercent}% line`,
    };
  }
  if (current.memoryUsedPercent > lines.maxMemoryUsedPercent) {
    return {
      line: 'memory',
      observed: current.memoryUsedPercent,
      limit: lines.maxMemoryUsedPercent,
      message: `memory in use was ${current.memoryUsedPercent.toFixed(1)}%, over the ${lines.maxMemoryUsedPercent}% line`,
    };
  }
  return null;
}

/** Judges what the users saw so far: the chat first byte p95, and the share of requests that failed. */
export function judgeUsers(lines: GuardLines, users: UsersSoFar): Breach | null {
  const firstBytes = users.chatFirstBytesMs;
  if (firstBytes.length >= MIN_REQUESTS_TO_JUDGE) {
    const p95 = p95Of(firstBytes);
    if (p95 > lines.maxFirstByteP95Ms) {
      return {
        line: 'first-byte-p95',
        observed: p95,
        limit: lines.maxFirstByteP95Ms,
        message: `chat first byte p95 was ${p95} ms, over the ${lines.maxFirstByteP95Ms} ms line`,
      };
    }
  }
  const { failed, attempts } = users;
  if (attempts >= MIN_REQUESTS_TO_JUDGE && failed / attempts > lines.maxErrorShare) {
    return {
      line: 'errors',
      observed: failed / attempts,
      limit: lines.maxErrorShare,
      message: `${((failed / attempts) * 100).toFixed(1)}% of requests failed, over the ${lines.maxErrorShare * 100}% line`,
    };
  }
  return null;
}

/** The smallest figure with at least 95% of the figures at or below it. */
function p95Of(figures: readonly number[]) {
  const sorted = [...figures].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}
