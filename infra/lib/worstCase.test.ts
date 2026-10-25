import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAFETY_NET } from '../config/names.ts';
import { PRICES } from '../config/prices.ts';
import { type Step, stepNamed } from '../config/steps.ts';
import { worstCaseOf } from './worstCase.ts';

const LOAD_HOURS = SAFETY_NET.loadMinutes / 60;

/** The worst case rounds up to the cent, so two of them differ from the exact sum by less than this. */
const ROUNDING_USD = 0.01;

const smoke = stepNamed('smoke');

/** Smoke's load with some of its figures changed. */
const withLoad = (load: Partial<Step['load']>) => ({
  ...smoke,
  load: { ...smoke.load, ...load },
});

const loadUsdOf = (load: Partial<Step['load']>) => worstCaseOf(withLoad(load)).loadUsd;

function assertClose(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) < ROUNDING_USD,
    `expected about ${expected.toFixed(4)}, got ${actual.toFixed(4)}`,
  );
}

describe('the worst case of a load run', () => {
  it('counts the load network’s gateway and public address for the whole of the load stack’s life, even with no traffic', () => {
    const noGateway = loadUsdOf({ generators: 0, egressGbPerHour: 0, logsGbPerHour: 0 });

    const lcuFloor = PRICES.loadBalancer.perLcuHour;
    const cacheFloor =
      smoke.cache.maxStorageGb * PRICES.redisServerless.perGbHour +
      ((smoke.cache.maxEcpuPerSecond * 3_600) / 1_000_000) * PRICES.redisServerless.perMillionEcpu;
    const gateway = PRICES.natGateway.perHour + PRICES.publicAddressPerHour;
    assertClose(noGateway, (lcuFloor + cacheFloor + gateway) * LOAD_HOURS);
  });

  it('counts every GB the generators receive twice: once leaving the app, once through the gateway', () => {
    const added = loadUsdOf({ egressGbPerHour: 11 }) - loadUsdOf({ egressGbPerHour: 1 });

    assertClose(added, 10 * (PRICES.egressPerGb + PRICES.natGateway.perGb) * LOAD_HOURS);
  });

  it('counts every GB of the generators’ lines through the gateway as well as into the logs', () => {
    const added = loadUsdOf({ logsGbPerHour: 11 }) - loadUsdOf({ logsGbPerHour: 1 });

    assertClose(added, 10 * (PRICES.logsIngestPerGb + PRICES.natGateway.perGb) * LOAD_HOURS);
  });
});

describe('the worst case of a raise', () => {
  it('counts the load balancer’s reserved capacity for the whole of the app stack’s life', () => {
    const reserving = (units: number | null): number =>
      worstCaseOf({ ...smoke, loadBalancer: { reservedCapacityUnits: units } }).raiseUsd;

    assertClose(
      reserving(100) - reserving(null),
      100 * PRICES.loadBalancer.perLcuHour * (SAFETY_NET.appMinutes / 60),
    );
  });
});

describe('the worst case of a load run on a reserved load balancer', () => {
  it('does not pay again for capacity units the raise already reserves', () => {
    const reserving = (units: number | null): number =>
      worstCaseOf({ ...smoke, loadBalancer: { reservedCapacityUnits: units } }).loadUsd;

    assertClose(reserving(null) - reserving(1_000), PRICES.loadBalancer.perLcuHour * LOAD_HOURS);
  });
});
