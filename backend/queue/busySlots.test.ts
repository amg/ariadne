import { env } from '@config/env';
import { describe, expect, it } from 'vitest';
import { runningInSlot, workerSlots } from './busySlots';

describe('the worker’s slots', () => {
  it('count a job as busy only while its work runs, however it ends', async () => {
    let release: () => void = () => undefined;
    const running = runningInSlot(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const failing = runningInSlot(async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    expect(workerSlots().busy).toBe(1);

    release();
    await running;
    expect(workerSlots().busy).toBe(0);
  });

  it('give back what the work gave', async () => {
    await expect(runningInSlot(async () => 'done')).resolves.toBe('done');
  });

  it('say how many jobs the process runs side by side at most', () => {
    expect(workerSlots().total).toBe(env.WORKER_JOB_CONCURRENCY);
  });
});
