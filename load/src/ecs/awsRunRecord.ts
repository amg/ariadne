import { join } from 'node:path';
import { METRICS_WAIT, archiveAwsRun, awsSources, openAwsRun } from '../archive/index.ts';
import { limitsFor } from '../criteria/index.ts';
import { rebuildRun } from '../rebuild/index.ts';
import type { carryOutRun } from './carryOutRun.ts';

type RunRecord = NonNullable<Parameters<typeof carryOutRun>[0]['recordOrNull']>;

/** Where an aws-prod run is recorded, and what it is made of. */
type AwsRunDescription = {
  /** The folder that holds every run, on this machine. */
  runsFolder: string;
  runId: string;
  step: string;
  loadPath: 'direct' | 'cloudflare';
  /** The step's whole configuration. */
  config: Readonly<Record<string, unknown>>;
  images: Readonly<Record<string, string>>;
  appStack: string;
  loadStack: string;
  startedAt: string;
  say: (line: string) => void;
};

/**
 * The record of a run on aws-prod, in its folder under `runsFolder`. The
 * run is judged by the limits its step had when the run began.
 */
export function awsRunRecord(run: AwsRunDescription): RunRecord {
  const folder = join(run.runsFolder, run.runId);
  return {
    async open() {
      run.say(`Archive: recording how run ${run.runId} begins`);
      await openAwsRun({
        folder,
        runId: run.runId,
        step: run.step,
        loadPath: run.loadPath,
        config: run.config,
        images: run.images,
        limitsOrNull: limitsFor(run.step, run.config),
        startedAt: run.startedAt,
        appStack: run.appStack,
        loadStack: run.loadStack,
      });
    },

    async seal({ outcome, endedAtOrNull }) {
      run.say(`Archive: collecting run ${run.runId}`);
      const { manifest } = await archiveAwsRun({
        runId: run.runId,
        folder,
        sourcesFor: awsSources,
        wait: METRICS_WAIT,
        outcome,
        ...(endedAtOrNull === null ? {} : { endedAt: endedAtOrNull }),
      });
      run.say(`Run ${run.runId} is sealed as ${manifest.seal.status}`);
      if (manifest.seal.status === 'incomplete') {
        for (const reason of manifest.seal.reasons) run.say(`  ${reason.check}: ${reason.detail}`);
      }
    },

    async rebuild() {
      run.say(`Rebuild: verdict and report of run ${run.runId}`);
      const rebuilt = rebuildRun(folder);
      run.say(rebuilt.verdictText);
      run.say(`Written under ${folder}: ${rebuilt.written.join(', ')}`);
    },
  };
}
