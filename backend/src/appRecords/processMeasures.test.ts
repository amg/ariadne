import { describe, expect, it } from 'vitest';
import { measureProcess } from './processMeasures';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('measureProcess', () => {
  it('reads the delay of a held-up event loop, then none until the loop has turned again', async () => {
    const process = measureProcess();
    await sleep(30);
    const blockedUntil = Date.now() + 300;
    while (Date.now() < blockedUntil) {
      // Holds the thread, as a long synchronous piece of work does.
    }
    await sleep(30);

    expect(process.eventLoopDelayP99Ms()).toBeGreaterThan(150);
    expect(process.eventLoopDelayP99Ms()).toBeNull();
  });

  it('reads no delay before the event loop has turned', () => {
    expect(measureProcess().eventLoopDelayP99Ms()).toBeNull();
  });

  it('reads the memory the process holds', () => {
    const { heapUsedBytes, residentBytes } = measureProcess().memory();

    expect(heapUsedBytes).toBeGreaterThan(0);
    expect(residentBytes).toBeGreaterThanOrEqual(heapUsedBytes);
  });
});
