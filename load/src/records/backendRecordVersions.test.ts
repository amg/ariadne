import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appRequestRecords, appStateRecords, exchangeRecords, jobRecords } from './appRecords.ts';
import { RUN_FOLDER_VERSION } from './manifest.ts';

/** A short digest of a schema's shape, which changes whenever the shape does. */
function shapeDigest(schema: z.ZodType) {
  return createHash('sha256')
    .update(JSON.stringify(z.toJSONSchema(schema)))
    .digest('hex')
    .slice(0, 16);
}

describe("the backend's record kinds", () => {
  // The shapes come from the backend's shared schemas. A digest that no
  // longer matches means a shape changed: raise the run folder's version in
  // manifest.ts if old files no longer satisfy it, then record the new
  // digest here beside it.
  it.each([
    [exchangeRecords.name, exchangeRecords, 'fb7ced65f34d822e'],
    [jobRecords.name, jobRecords, '8b21f4e335bd6176'],
    [appRequestRecords.name, appRequestRecords, '5a2f828c43101717'],
    [appStateRecords.name, appStateRecords, '33e55bb0251e4dd8'],
  ] as const)("keeps %s at a known shape for the run folder's version", (_name, kind, digest) => {
    expect({ version: RUN_FOLDER_VERSION, digest: shapeDigest(kind.schema) }).toEqual({
      version: 2,
      digest,
    });
  });

  it('reads lines written before records named their copy or said a verdict was replayed', () => {
    const at = '2026-10-15T00:00:00.000Z';
    const [exchange] = exchangeRecords.readLines(
      JSON.stringify({
        userId: 'u1',
        trigger: 'retry',
        arrivedAt: at,
        verdict: 'pass',
        verdictAfterMs: 1,
        firstTokenAfterMs: null,
        endedAfterMs: 2,
        outcome: 'completed',
        errorCode: null,
        assistantMessageId: null,
      }),
    );
    const [state] = appStateRecords.readLines(
      JSON.stringify({ at, pushStreamsOpen: 1, oldestJobWaitMs: 0 }),
    );

    expect(exchange).toMatchObject({ copy: null, verdictReplayed: false });
    expect(state).toMatchObject({ copy: null });
  });

  it('reads state lines written before copies said how loaded they were, with those figures null', () => {
    const [state] = appStateRecords.readLines(
      JSON.stringify({
        copy: 'api-1',
        at: '2026-10-15T00:00:00.000Z',
        pushStreamsOpen: 1,
        oldestJobWaitMs: 0,
      }),
    );

    expect(state).toMatchObject({
      eventLoopDelayP99Ms: null,
      heapUsedBytes: null,
      residentBytes: null,
      dbConnectionsInUse: null,
      dbConnectionsWaiting: null,
      workerSlotsBusy: null,
      workerSlots: null,
      pushBusFailures: null,
    });
  });
});
