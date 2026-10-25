import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rebuildRun } from '../rebuild/index.ts';
import { LAYOUT, readManifest } from '../records/index.ts';
import { STEP50_SCALE, archiveScaleRun, leaveScaleRun } from './scaleRun.ts';

/**
 * A run of step50's size: a million requests from ten generators over
 * thirty-five minutes, and a backend log of about a gigabyte. It takes a
 * minute or two, so it runs only when asked for:
 *   npm run test:scale --workspace=load
 */
const SCALE = process.env.LOAD_SCALE === '1';
const REBUILD_WITHIN_MS = 60_000;
/** What a streaming archive may hold at once, far under the size of the log it sorts. */
const MOST_MEMORY_BYTES = 512 * 1_048_576;

const options = {
  ...STEP50_SCALE,
  requestsPerGenerator: Number(
    process.env.LOAD_SCALE_REQUESTS ?? STEP50_SCALE.requestsPerGenerator,
  ),
  backendNoiseMegabytes: Number(process.env.LOAD_SCALE_NOISE_MB ?? 500),
};

/** Samples the memory in use while `work` runs, and says the most it saw. */
async function peakMemoryOf(work: () => Promise<void>) {
  const inUse = (): number => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  let peak = inUse();
  const watching = setInterval(() => {
    peak = Math.max(peak, inUse());
  }, 50);
  try {
    await work();
  } finally {
    clearInterval(watching);
  }
  return Math.max(peak, inUse());
}

describe.runIf(SCALE)('a run of step50’s size', () => {
  const folder = mkdtempSync(join(tmpdir(), 'scale-run-'));

  it('is archived and sealed complete with the memory of one piece of its logs', async () => {
    await leaveScaleRun(folder, options);
    const logBytes = statSync(join(folder, LAYOUT.processLog('backend'))).size;

    const peak = await peakMemoryOf(() => archiveScaleRun(folder, options));

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.seal.status).toBe('complete');
    console.log(
      `log ${Math.round(logBytes / 1_048_576)} MB, archive peak ${Math.round(peak / 1_048_576)} MB`,
    );
    expect(peak).toBeLessThan(MOST_MEMORY_BYTES);
  }, 900_000);

  it('is rebuilt in under a minute', () => {
    const started = performance.now();
    rebuildRun(folder);
    const took = performance.now() - started;

    console.log(`rebuilt in ${Math.round(took)} ms`);
    expect(took).toBeLessThan(REBUILD_WITHIN_MS);
  }, 900_000);
});
