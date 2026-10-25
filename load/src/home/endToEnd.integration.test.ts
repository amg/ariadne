import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD_LINES } from '../criteria/guardLines.ts';
import { rebuildRun } from '../rebuild/rebuildRun.ts';
import { LAYOUT } from '../records/layout.ts';
import { readManifest } from '../records/manifest.ts';
import { carryOut, finishRun } from './homeRun.ts';
import {
  devConnections,
  hostAddress,
  loadAccountPassword,
  readDevEnvFile,
} from './stack/devHost.ts';
import { DEFAULT_GLANCES_URL } from './watch/glances.ts';

/**
 * A few virtual users against the local stack and its mock inference, end
 * to end: the run, its archive and its rebuild. It starts the backend on
 * dev's database, so it runs only when asked for, with the operator's dev
 * backend stopped:
 *   npm run test:integration --workspace=load
 */
describe.runIf(process.env.LOAD_INTEGRATION === '1')('a home run, end to end', () => {
  it('is archived into a sealed folder whose rebuild gives the verdict the run ended with', async () => {
    const envFile = readDevEnvFile();
    const connections = devConnections(envFile, hostAddress());
    const startedAt = new Date();
    const folder = mkdtempSync(join(tmpdir(), 'home-run-'));
    const run = {
      options: {
        inference: 'mock',
        users: 3,
        generators: 3,
        rampSeconds: 2,
        holdSeconds: 10,
        thinkSeconds: 2,
        guard: GUARD_LINES,
      },
      runId: 'integration-home-smoke',
      folder,
      startedAt,
      password: loadAccountPassword(process.env, envFile),
      glancesUrl: process.env.GLANCES_URL || DEFAULT_GLANCES_URL,
      connections,
    } as const;

    const { failure } = await carryOut(run);
    expect(failure).toBeNull();
    const { incompleteBecause, rebuilt } = await finishRun({ run, failure });

    expect(incompleteBecause).toEqual([]);
    expect(readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8')).seal.status).toBe(
      'complete',
    );
    expect(rebuilt).toMatchObject({ verdict: 'pass', reasons: [] });

    const endOfRun = readFileSync(join(folder, LAYOUT.verdict), 'utf8');
    rebuildRun(folder);
    expect(readFileSync(join(folder, LAYOUT.verdict), 'utf8')).toBe(endOfRun);
  }, 240_000);
});
