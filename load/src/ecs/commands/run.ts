import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ECSClient } from '@aws-sdk/client-ecs';
import { z } from 'zod';
import { generatorTaskKeeper } from '../../archive/index.ts';
import { awsRunRecord } from '../awsRunRecord.ts';
import { carryOutRun, exitStatusOf } from '../carryOutRun.ts';
import { ecsPortOf } from '../ecsPort.ts';
import { interruptionOf } from '../interruption.ts';
import { runGenerators } from '../runGenerators.ts';
import { parseStepConfig } from '../stepConfig.ts';
import { stopEveryGenerator } from '../stopEveryGenerator.ts';

const RUNS_DIR = new URL('../../../.runs/', import.meta.url).pathname;

/** How often the generators' tasks are asked about. */
const POLL_EVERY_MS = 10_000;

/** ECS limits how fast tasks are started, and the client waits and asks again when it is told to slow down. */
const ECS_ATTEMPTS = 8;

const USAGE = `usage: run --run <id> --mode load|seed --config <file>
         --cluster <name> --task-definition <arn> --subnets <a,b> --security-group <id>
         [load only: --step <step> --path direct|cloudflare --images <json> --app-stack <name> --load-stack <name>]`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    run: { type: 'string' },
    mode: { type: 'string' },
    config: { type: 'string' },
    cluster: { type: 'string' },
    'task-definition': { type: 'string' },
    subnets: { type: 'string' },
    'security-group': { type: 'string' },
    step: { type: 'string' },
    path: { type: 'string' },
    images: { type: 'string' },
    'app-stack': { type: 'string' },
    'load-stack': { type: 'string' },
  },
});

const text = z.string().min(1);
const common = {
  run: text,
  config: text,
  cluster: text,
  'task-definition': text,
  subnets: text,
  'security-group': text,
};
const parsed = z
  .discriminatedUnion('mode', [
    z.object({ ...common, mode: z.literal('seed') }),
    z.object({
      ...common,
      mode: z.literal('load'),
      step: text,
      path: z.enum(['direct', 'cloudflare']),
      images: text,
      'app-stack': text,
      'load-stack': text,
    }),
  ])
  .safeParse(values);
if (!parsed.success) {
  const problems = parsed.error.issues.map(
    (issue) => `--${issue.path.join('.')}: ${issue.message}`,
  );
  console.error(`${problems.join('\n')}\n${USAGE}`);
  process.exit(2);
}
const options = parsed.data;

const config = parseStepConfig(readFileSync(options.config, 'utf8'));
const imagesSchema = z.record(z.string(), z.string());

/**
 * One run of the generators on aws-prod, from opening it to its verdict:
 *   npm run aws:run --workspace=load -- <options>
 *
 * A load run opens its record, runs the fleet, and however the fleet ends,
 * stops every generator, seals the run with how it ended and rebuilds it.
 * The users are shared between the generators. A generator that stops
 * before the run's end, such as one Spot took back or one stopped by hand,
 * is started again on the same slice of users, which come back over about
 * a minute, and holds only for the time the run has left. Every generator
 * that stops is kept in the run's folder as ECS described it, with its
 * reason, so that the archive has it after ECS forgets.
 *
 * A step with a warm-up first runs the same fleet unrecorded, under
 * `<run>-warm-up`, so that the load balancer has grown before the run
 * begins. The run does not begin when the warm-up does not finish.
 *
 * A seeding run runs the same fleet On-Demand, replaces no generator, and
 * keeps no record.
 *
 * Ctrl-C and SIGTERM end the run early. The command exits with 0 when the
 * run finished its plan, 130 when it was interrupted and 1 when it failed.
 */
const ecs = ecsPortOf(new ECSClient({ maxAttempts: ECS_ATTEMPTS }), {
  cluster: options.cluster,
  taskDefinition: options['task-definition'],
  subnets: options.subnets.split(','),
  securityGroup: options['security-group'],
});
const say = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((done) => setTimeout(done, milliseconds));
const signal = interruptionOf(process, (repeated) =>
  say(
    `${repeated} received again. The run is already ending: it stops its generators and seals itself before the command returns.`,
  ),
);
const fleet = {
  ecs,
  mode: options.mode,
  placement: config.load.spot ? ('spot' as const) : ('on-demand' as const),
  users: config.load.users,
  generators: config.load.generators,
  rampSeconds: config.load.rampSeconds,
  thinkSeconds: config.load.thinkSeconds,
  signal,
  say,
  pollEveryMs: POLL_EVERY_MS,
  sleep,
};
const stopGenerators = (reason: string) =>
  stopEveryGenerator({ ecs, reason, pollEveryMs: POLL_EVERY_MS, sleep });

const { warmUp } = config.load;
if (options.mode === 'load' && warmUp !== null) {
  say(
    `Warm-up: the users come up over ${warmUp.rampSeconds} s and hold for ${warmUp.holdSeconds} s, unrecorded`,
  );
  const warmedUp = await carryOutRun({
    recordOrNull: null,
    runFleet: () =>
      runGenerators({
        ...fleet,
        runId: `${options.run}-warm-up`,
        rampSeconds: warmUp.rampSeconds,
        holdSeconds: warmUp.holdSeconds,
        keepStoppedTask: async () => undefined,
      }),
    stopEveryGenerator: stopGenerators,
    say,
  });
  if (warmedUp !== 'finished') {
    say(`The warm-up ended ${warmedUp}, so run ${options.run} does not begin`);
    process.exit(exitStatusOf(warmedUp));
  }
  say(`Warm-up finished; run ${options.run} begins`);
}

const startedAt = new Date().toISOString();
const keepStoppedTask =
  options.mode === 'load'
    ? generatorTaskKeeper(join(RUNS_DIR, options.run)).keep
    : async () => undefined;

const outcome = await carryOutRun({
  recordOrNull:
    options.mode === 'load'
      ? awsRunRecord({
          runsFolder: RUNS_DIR,
          runId: options.run,
          step: options.step,
          loadPath: options.path,
          config,
          images: imagesSchema.parse(JSON.parse(options.images)),
          appStack: options['app-stack'],
          loadStack: options['load-stack'],
          startedAt,
          say,
        })
      : null,
  runFleet: () =>
    runGenerators({
      ...fleet,
      runId: options.run,
      holdSeconds: config.load.holdSeconds,
      keepStoppedTask,
    }),
  stopEveryGenerator: stopGenerators,
  say,
});
process.exit(exitStatusOf(outcome));
