import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DeployPolicy, type Step, stepNamed } from '../config/steps.ts';
import { checkQuotas, vcpuNeedOf } from './quotas.ts';

const step50 = stepNamed('step50');

/** Production's policy: every old task runs beside its new one. */
const SURGE: DeployPolicy = stepNamed('step-prod').deploy;

/** What a refusal says; fails the test when the step fitted. */
function refusalOf(verdict: ReturnType<typeof checkQuotas>): string {
  assert.equal(verdict.fits, false, 'the step should not fit');
  return verdict.fits ? '' : verdict.message;
}

/** The step with its generators changed. */
const withGenerators = (step: Step, load: Partial<Step['load']>) => ({
  ...step,
  load: { ...step.load, ...load },
});

/** The step with another deploy policy. */
const withDeploy = (step: Step, deploy: DeployPolicy) => ({ ...step, deploy });

describe('the vCPUs a step needs', () => {
  it('counts every service at its ceiling, and no extra tasks for a deploy that replaces old tasks', () => {
    // 20 API + 40 worker + 16 auth at 2 + 6 mock + 2 web at a quarter.
    assert.equal(vcpuNeedOf(step50).onDemand, 20 + 40 + 32 + 6 + 0.5);
  });

  it('counts twice the vCPU for a deploy that runs old tasks beside new ones', () => {
    assert.equal(vcpuNeedOf(withDeploy(step50, SURGE)).onDemand, 2 * vcpuNeedOf(step50).onDemand);
  });

  it('counts a scaling service at its ceiling rather than its floor', () => {
    const prod = stepNamed('step-prod');
    // API 8 and worker 12 at half a vCPU, auth 6, mock a quarter, 2 web at a quarter, each doubled.
    assert.equal(vcpuNeedOf(prod).onDemand, (4 + 6 + 6 + 0.25 + 0.5) * 2);
  });

  it('puts the generators of a Spot step on Spot, and none of them on-demand', () => {
    const withoutGenerators = withGenerators(step50, { generators: 0 });

    assert.equal(vcpuNeedOf(step50).spot, 10);
    assert.equal(vcpuNeedOf(step50).onDemand, vcpuNeedOf(withoutGenerators).onDemand);
  });

  it('puts the generators of a step that cannot use Spot on On-Demand beside the services', () => {
    const seed = stepNamed('seed');
    const need = vcpuNeedOf(seed);

    assert.equal(need.spot, 0);
    // 2 API + 1 worker + 16 auth + 0.5 mock + 0.25 web, and two 4 vCPU generators.
    assert.equal(need.onDemand, 2 + 1 + 16 + 0.5 + 0.25 + 2 * 4);
  });
});

describe('checking a step against the account’s quotas', () => {
  it('lets a step through that fits both quotas, exactly filling one included', () => {
    const need = vcpuNeedOf(step50);

    assert.deepEqual(checkQuotas(step50, { onDemand: 160, spot: 64 }), { fits: true });
    assert.deepEqual(checkQuotas(step50, { onDemand: need.onDemand, spot: need.spot }), {
      fits: true,
    });
  });

  it('refuses a step whose services need more On-Demand vCPU than the quota, with both figures', () => {
    const verdict = checkQuotas(step50, { onDemand: 98, spot: 64 });

    const message = refusalOf(verdict);
    assert.ok(message.includes('On-Demand needs 98.5 vCPU'));
    assert.ok(message.includes('quota is 98'));
    assert.ok(!message.includes('Spot'));
  });

  it('refuses a step whose generators need more Spot vCPU than the quota', () => {
    const verdict = checkQuotas(step50, { onDemand: 160, spot: 9 });

    const message = refusalOf(verdict);
    assert.ok(message.includes('Spot needs 10 vCPU'));
    assert.ok(message.includes('quota is 9'));
  });

  it('names both quotas when neither fits', () => {
    const verdict = checkQuotas(withGenerators(step50, { generators: 80 }), {
      onDemand: 90,
      spot: 64,
    });

    const message = refusalOf(verdict);
    assert.ok(message.includes('On-Demand needs 98.5 vCPU'));
    assert.ok(message.includes('Spot needs 80 vCPU'));
  });

  it('shows a quarter of a vCPU as a decimal', () => {
    const verdict = checkQuotas(stepNamed('smoke'), { onDemand: 1, spot: 64 });

    assert.match(refusalOf(verdict), /needs \d+\.\d+ vCPU/);
  });

  it('refuses step50 against 160 On-Demand vCPU when its deploy would run old tasks beside new ones', () => {
    const message = refusalOf(checkQuotas(withDeploy(step50, SURGE), { onDemand: 160, spot: 64 }));

    assert.ok(message.includes('On-Demand needs 197 vCPU'));
  });

  it('fits every step that deploys by replacing, on the quotas the account has', () => {
    for (const name of ['seed', 'smoke', 'step10', 'step50', 'step100'] as const) {
      assert.deepEqual(
        checkQuotas(stepNamed(name), { onDemand: 160, spot: 64 }),
        { fits: true },
        name,
      );
    }
  });
});
