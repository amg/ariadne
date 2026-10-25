import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPTS = new URL('../../../infra/scripts/', import.meta.url).pathname;

/**
 * The shell around the load command, run as it is with the AWS calls
 * replaced: a stand-in for the harness's aws:run command (reached through the
 * same `npm run`) that ends the way the test says, and functions that note
 * what the shell did with the generators' stack and the day's budget.
 */
const SHELL = `
set -euo pipefail
source "${SCRIPTS}steps/aws/load-archive-run.sh"
source "${SCRIPTS}steps/aws/load-run-generators.sh"
step() { :; }
info() { echo "$*" >&2; note "info $*"; }
fail() { echo "$*" >&2; exit 1; }
stack_output() { echo "$1.$2"; }
raised_seed_snapshot() { echo snapshot; }
run_cdk() { note "run_cdk $*"; [[ -z "\${DEPLOY_FAILS:-}" ]]; }
origin_security_group() { echo sg-origin; }
load_image_tag() { echo "generators-$1"; }
delete_stack() { note "delete_stack $*"; [[ -z "\${DELETE_FAILS:-}" ]]; }
release_budget() { note "release_budget $*"; }
LOAD_STACK=load APP_STACK=app OUT_ORIGIN_DNS_NAME=origin
OUT_LOAD_CLUSTER=cluster OUT_LOAD_TASK_DEFINITION=definition
OUT_LOAD_SUBNETS=subnets OUT_LOAD_SECURITY_GROUP=group
AUTH_CORE_TAG=auth-1 INFRA_DIR="\${REPO_DIR}/infra"
STEP_GENERATORS=1 STEP_USERS=1
BUDGET_CLAIM_AT=claim-1
run_generators "\${RUN_STEP:-smoke}" tag "\${RUN_MODE:-load}" "\${RUN_PATH:-direct}"
note "run_generators returned"
`;

/** Notes what it was given and how the test says it ends, with the run folder it leaves. */
const HARNESS = `
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
const note = (text) => appendFileSync(process.env.NOTES, text + '\\n');
const args = process.argv.slice(2);
const runId = args[args.indexOf('--run') + 1];
note('harness ' + args.join(' '));
// Two tests may start in the same second, and so share a run id.
const leaveRun = () => {
  rmSync('.runs/' + runId, { recursive: true, force: true });
  if (process.env.RUN_FOLDER === 'none') return;
  mkdirSync('.runs/' + runId, { recursive: true });
  if (process.env.RUN_FOLDER === 'sealed') writeFileSync('.runs/' + runId + '/manifest.json', '{}');
};
for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    note('harness told to stop');
    setTimeout(() => { leaveRun(); process.exit(status); }, 300);
  });
}
if (process.env.ENDS_AT_ONCE) {
  leaveRun();
  process.exit(Number(process.env.ENDS_AT_ONCE === 'finished' ? 0 : 1));
}
note('harness up');
setInterval(() => {}, 1_000);
`;

let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'load-shell-'));
  mkdirSync(join(folder, 'repo', 'load'), { recursive: true });
  mkdirSync(join(folder, 'bin'));
  writeFileSync(
    join(folder, 'repo', 'package.json'),
    JSON.stringify({ name: 'repo', private: true, workspaces: ['load'] }),
  );
  writeFileSync(
    join(folder, 'repo', 'load', 'package.json'),
    JSON.stringify({
      name: 'load',
      version: '1.0.0',
      private: true,
      scripts: { 'aws:run': 'node harness.mjs' },
    }),
  );
  writeFileSync(join(folder, 'repo', 'load', 'harness.mjs'), HARNESS);
  // Stands in for the step configuration the shell asks the infra app for.
  writeFileSync(join(folder, 'bin', 'npx'), '#!/bin/sh\necho "{}"\n');
  chmodSync(join(folder, 'bin', 'npx'), 0o755);
  mkdirSync(join(folder, 'repo', 'infra'));
  writeFileSync(
    join(folder, 'command.sh'),
    `note() { echo "$*" >> "$NOTES"; }\nREPO_DIR="${join(folder, 'repo')}"\n${SHELL}`,
  );
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

type Ended = { status: number | null; notes: string[] };

/** Starts the shell, with `environment` on top of its own. */
function shellStarted(name: string, environment: NodeJS.ProcessEnv = {}) {
  const notesFile = join(folder, `${name}.notes`);
  writeFileSync(notesFile, '');
  const notes = (): string[] => readFileSync(notesFile, 'utf8').split('\n').filter(Boolean);
  const command = spawn('bash', [join(folder, 'command.sh')], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      RUN_FOLDER: 'sealed',
      ...environment,
      PATH: `${join(folder, 'bin')}:${process.env.PATH}`,
      NOTES: notesFile,
    },
  });
  const ended = new Promise<number | null>((resolve) => command.on('exit', resolve));
  return { command, notes, ended };
}

/** Runs the shell to its end, with a harness that ends at once the way `endsAs` says. */
async function shellRun(
  name: string,
  endsAs: 'finished' | 'failed',
  environment: NodeJS.ProcessEnv = {},
) {
  const { notes, ended } = shellStarted(name, { ...environment, ENDS_AT_ONCE: endsAs });
  return { status: await ended, notes: notes() };
}

/**
 * Runs the shell, sends `signal` to its whole process group while the
 * harness is up, as a terminal does for Ctrl-C, and says how the shell ended
 * and what it noted.
 */
async function shellSignalled(
  signal: 'SIGINT' | 'SIGTERM',
  name: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const { command, notes, ended } = shellStarted(name, environment);
  const giveUpAt = Date.now() + 20_000;
  while (!notes().includes('harness up')) {
    if (Date.now() > giveUpAt) throw new Error(`the shell never got going: ${notes().join(' | ')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.kill(-(command.pid ?? 0), signal);
  return { status: await ended, notes: notes() };
}

describe.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)('the shell around the load command signalled with %s', (signal, status) => {
  it('leaves the signal to the command, ends with its status, releases the budget claim and deletes the generators’ stack', async () => {
    const result = await shellSignalled(signal, signal);

    expect(result.notes).toContain('harness told to stop');
    expect(result.status).toBe(status);
    expect(result.notes).toContain('release_budget claim-1 interrupted');
    expect(result.notes.indexOf('harness told to stop')).toBeLessThan(
      result.notes.indexOf('delete_stack load'),
    );
  }, 30_000);
});

describe('the shell around the load command', () => {
  it('deletes the generators’ stack and keeps the budget claim when the run finished', async () => {
    const result = await shellRun('finished', 'finished');

    expect(result.status).toBe(0);
    expect(result.notes.filter((line) => line === 'delete_stack load')).toHaveLength(1);
    expect(result.notes).not.toContainEqual(expect.stringMatching(/^release_budget/));
  }, 30_000);

  it('deletes the generators’ stack before the command goes on, so that a seeding run does not keep it through the snapshot', async () => {
    const result = await shellRun('stack-before-snapshot', 'finished');

    expect(result.notes.indexOf('delete_stack load')).toBeGreaterThan(-1);
    expect(result.notes.indexOf('delete_stack load')).toBeLessThan(
      result.notes.indexOf('run_generators returned'),
    );
  }, 30_000);

  it('releases the budget claim and deletes the stack when the run failed', async () => {
    const result = await shellRun('failed', 'failed');

    expect(result.status).toBe(1);
    expect(result.notes).toContain('release_budget claim-1 failed');
    expect(result.notes).toContain('delete_stack load');
  }, 30_000);

  it('keeps the stack for the archive, and keeps the budget claim, when a finished run was not sealed', async () => {
    const result = await shellRun('unsealed', 'finished', { RUN_FOLDER: 'unsealed' });

    expect(result.status).toBe(1);
    expect(result.notes).not.toContain('delete_stack load');
    expect(result.notes).not.toContainEqual(expect.stringMatching(/^release_budget/));
    expect(result.notes).toContainEqual(
      expect.stringMatching(/^info Run \S+ is not sealed.*aws-prod archive/),
    );
  }, 30_000);

  it('keeps the stack for the archive when an interrupted run was not sealed', async () => {
    const result = await shellSignalled('SIGINT', 'unsealed-interrupted', {
      RUN_FOLDER: 'unsealed',
    });

    expect(result.status).toBe(130);
    expect(result.notes).toContain('release_budget claim-1 interrupted');
    expect(result.notes).not.toContain('delete_stack load');
  }, 30_000);

  it('fails the command when the stack could not be deleted after a finished run', async () => {
    const result = await shellRun('delete-fails', 'finished', { DELETE_FAILS: '1' });

    expect(result.status).toBe(1);
    expect(result.notes).toContainEqual(
      expect.stringMatching(/^info The generators' stack is still there/),
    );
  }, 30_000);

  it('deletes the stack at once, with no run to seal, when the deploy fails', async () => {
    const { notes, ended } = shellStarted('deploy-fails', { DEPLOY_FAILS: '1' });

    expect(await ended).not.toBe(0);
    expect(notes()).toContain('delete_stack load');
    expect(notes()).not.toContainEqual(expect.stringMatching(/^harness /));
  }, 30_000);

  it('deletes the stack when the command ended before its run began recording', async () => {
    const result = await shellRun('no-run-folder', 'failed', { RUN_FOLDER: 'none' });

    expect(result.status).toBe(1);
    expect(result.notes).toContain('delete_stack load');
  }, 30_000);
});

describe('the shell around the load command on the direct path', () => {
  it('deploys the load stack with the origin’s address and security group, so the stack lets its generators in', async () => {
    const result = await shellRun('deploy', 'finished');

    const deploy = result.notes.find((line) => line.startsWith('run_cdk deploy load '));
    expect(deploy).toContain('-c originAddress=app.origin');
    expect(deploy).toContain('-c originSecurityGroup=sg-origin');
  }, 30_000);

  it('deploys the load stack with the generators’ image, which need not be the raise’s own', async () => {
    const result = await shellRun('deploy-load-image', 'finished');

    const deploy = result.notes.find((line) => line.startsWith('run_cdk deploy load '));
    expect(deploy).toContain('-c imageTag=tag -c loadImageTag=generators-tag');
  }, 30_000);
});

describe('what the shell hands the load command', () => {
  const harnessLine = (result: Ended): string =>
    result.notes.find((line) => line.startsWith('harness --run')) ?? '';

  it('gives a load run its step, path, images and stacks', async () => {
    const result = await shellRun('args-load', 'finished', { RUN_PATH: 'edge' });

    const line = harnessLine(result);
    expect(line).toMatch(/--run \S+-smoke-load /);
    expect(line).toContain('--mode load');
    expect(line).toContain('--step smoke --path cloudflare');
    expect(line).toContain(
      '--images {"backend":"tag","web":"tag","tools":"tag","load":"generators-tag","auth":"auth-1"}',
    );
    expect(line).toContain('--app-stack app --load-stack load');
    expect(line).toContain('--cluster load.cluster --task-definition load.definition');
  }, 30_000);

  it('names a direct run so, and gives a seeding run nothing to record', async () => {
    const direct = await shellRun('args-direct', 'finished');
    const seeding = await shellRun('args-seed', 'finished', { RUN_MODE: 'seed', RUN_STEP: 'seed' });

    expect(harnessLine(direct)).toMatch(/--run \S+-smoke-load-direct /);
    expect(harnessLine(seeding)).toContain('--mode seed');
    expect(harnessLine(seeding)).not.toContain('--step');
  }, 30_000);
});
