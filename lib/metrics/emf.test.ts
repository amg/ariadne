import { describe, expect, it } from 'vitest';
import { metricFields } from './emf.ts';

const AT = new Date('2026-01-02T03:04:05.678Z');

describe('metricFields', () => {
  it('names each group’s figures and dimensions, and carries their values beside them', () => {
    const fields = metricFields('Ari/App', AT, [
      { dimensions: { Task: 'send' }, measures: [{ name: 'JobsRun', value: 1, unit: 'Count' }] },
      { measures: [{ name: 'JobWaitMs', value: 42, unit: 'Milliseconds' }] },
    ]);

    expect(fields).toEqual({
      _aws: {
        Timestamp: AT.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: 'Ari/App',
            Dimensions: [['Task']],
            Metrics: [{ Name: 'JobsRun', Unit: 'Count' }],
          },
          {
            Namespace: 'Ari/App',
            Dimensions: [[]],
            Metrics: [{ Name: 'JobWaitMs', Unit: 'Milliseconds' }],
          },
        ],
      },
      Task: 'send',
      JobsRun: 1,
      JobWaitMs: 42,
    });
  });

  it('adds nothing when no group has a figure', () => {
    expect(metricFields('Ari/App', AT, [])).toEqual({});
    expect(metricFields('Ari/App', AT, [{ dimensions: { Task: 'send' }, measures: [] }])).toEqual(
      {},
    );
  });

  it('leaves out a group that has no figure but keeps the others', () => {
    const fields = metricFields('Ari/Load', AT, [
      { dimensions: { Kind: 'chat' }, measures: [] },
      { measures: [{ name: 'ChatFirstByteMs', value: 900, unit: 'Milliseconds' }] },
    ]);

    expect(fields).toMatchObject({ ChatFirstByteMs: 900 });
    expect(fields).not.toHaveProperty('Kind');
    expect(JSON.stringify(fields)).not.toContain('"Kind"');
  });
});
