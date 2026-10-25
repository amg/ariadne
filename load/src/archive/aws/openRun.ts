import { AWS_PROD_TARGET, type Manifest } from '../../records/index.ts';
import { currentCommit } from '../commits.ts';
import { beginAwsRun } from './awsArchive.ts';
import { discoverRaise } from './discover.ts';

/** What the operator's command knows of a run when it begins. */
type RunToOpen = {
  /** The run's folder. */
  folder: string;
  runId: string;
  step: string;
  loadPath: Manifest['loadPath'];
  /** The step's whole configuration. */
  config: Readonly<Manifest['config']>;
  images: Readonly<Manifest['images']>;
  /** The limits the run is judged by; null for a step with none. */
  limitsOrNull: Manifest['limits'];
  startedAt: string;
  appStack: string;
  loadStack: string;
};

/**
 * Opens a run on aws-prod: writes what the raise is made of and the run's
 * description into the run's folder, which holds no manifest until the run
 * is sealed. Nothing is written when the raise cannot be read.
 */
export async function openAwsRun(run: RunToOpen) {
  const raise = await discoverRaise({ appStack: run.appStack, loadStack: run.loadStack });
  const commit = currentCommit();
  beginAwsRun({
    folder: run.folder,
    raise,
    description: {
      runId: run.runId,
      step: run.step,
      config: run.config,
      target: AWS_PROD_TARGET,
      loadPath: run.loadPath,
      images: run.images,
      commits: { app: commit, harness: commit },
      limits: run.limitsOrNull,
      startedAt: run.startedAt,
      endedAt: null,
      trailingEndsAt: null,
    },
  });
}
