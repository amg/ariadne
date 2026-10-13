import { App } from 'aws-cdk-lib';
import { REGION, STACKS } from '../config/names.ts';
import { STEP_NAMES, stepNamed } from '../config/steps.ts';
import { AppStack } from '../lib/app/appStack.ts';
import { CoreStack } from '../lib/core/coreStack.ts';
import { LoadStack } from '../lib/load/loadStack.ts';

/**
 * The aws-prod CDK app: the core, app and load stacks. The app synthesizes
 * nothing without a step (`-c step=<name> -c imageTag=<tag>`); core is
 * step-sized only so the app has a shape to synthesize, and its deploy
 * touches the core stack alone.
 */
const app = new App();

const stepName: unknown = app.node.tryGetContext('step');
if (typeof stepName !== 'string') {
  console.error(
    `Pass the step: -c step=<name>, one of ${STEP_NAMES.join(' ')}. Without a step, nothing is synthesized.`,
  );
  process.exit(1);
}

const imageTag: unknown = app.node.tryGetContext('imageTag');
if (typeof imageTag !== 'string') throw new Error('Pass -c imageTag=<tag> along with the step');

/** Only the load command passes it, for a run on the direct path. */
const originAddress: unknown = app.node.tryGetContext('originAddress');

const step = stepNamed(stepName);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

const core = new CoreStack(app, STACKS.core, { env });
new AppStack(app, STACKS.app, { env, step, imageTag, core: core.resources });
new LoadStack(app, STACKS.load, {
  env,
  step,
  imageTag,
  core: core.resources,
  originAddress: typeof originAddress === 'string' ? originAddress : undefined,
});
