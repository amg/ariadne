import { monitorEventLoopDelay } from 'node:perf_hooks';
import { roundedToTenthMs } from './records';

/** How finely the event loop's delay is sampled. */
const SAMPLE_EVERY_MS = 10;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/**
 * Starts watching the event loop of this process. The watch sees only the
 * turns that follow this call, and does not hold the process open.
 */
export function measureProcess() {
  const delays = monitorEventLoopDelay({ resolution: SAMPLE_EVERY_MS });
  delays.enable();
  return {
    eventLoopDelayP99Ms() {
      if (delays.count === 0) return null;
      // Each sampled turn lasts the sampling interval plus its delay, so the interval is taken off.
      const turnMs = delays.percentile(99) / NANOSECONDS_PER_MILLISECOND;
      delays.reset();
      return roundedToTenthMs(Math.max(0, turnMs - SAMPLE_EVERY_MS));
    },
    memory() {
      const { heapUsed, rss } = process.memoryUsage();
      return { heapUsedBytes: heapUsed, residentBytes: rss };
    },
  };
}
