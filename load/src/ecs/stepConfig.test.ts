import { describe, expect, it } from 'vitest';
import { limitsFor } from '../criteria/index.ts';
import { parseStepConfig } from './stepConfig.ts';

/** A step's configuration as the infra app prints it, cut down to a few services. */
const PRINTED_STEP10 = JSON.stringify({
  name: 'step10',
  database: { instanceClass: 'm7g.xlarge', storageGiB: 400, source: 'seedSnapshot' },
  services: { worker: { cpu: 1024, memoryMiB: 2048, count: 4, jobConcurrency: 16 } },
  load: {
    generators: 2,
    generator: { cpu: 1024, memoryMiB: 4096, count: 1 },
    spot: true,
    users: 10_000,
    chattingShare: 0.2,
    rampSeconds: 600,
    holdSeconds: 1_200,
    thinkSeconds: 30,
    egressGbPerHour: 2,
    logsGbPerHour: 0.5,
  },
  signupOpen: false,
});

describe('parseStepConfig', () => {
  it('keeps everything the step printed, so that the run records the whole configuration', () => {
    const config = parseStepConfig(PRINTED_STEP10);

    expect(config).toMatchObject({
      services: { worker: { jobConcurrency: 16 } },
      load: { generator: { cpu: 1024 }, egressGbPerHour: 2 },
    });
  });

  it('gives the limits of a sized step what they need to be worked out', () => {
    const config = parseStepConfig(PRINTED_STEP10);

    expect(limitsFor('step10', config)).toMatchObject({
      minPushStreams: 9_800,
      minChatters: 1_960,
    });
  });

  it('refuses a configuration that does not say how many of the users chat', () => {
    const load = Object.fromEntries(
      Object.entries(JSON.parse(PRINTED_STEP10).load).filter(([key]) => key !== 'chattingShare'),
    );

    expect(() => parseStepConfig(JSON.stringify({ load }))).toThrow(
      /not usable[\s\S]*load\.chattingShare/,
    );
  });
});
