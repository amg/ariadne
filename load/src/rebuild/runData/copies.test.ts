import { describe, expect, it } from 'vitest';
import { copyLabelsOf } from './copies.ts';
import { appStateWith } from './testing.ts';

describe('copyLabelsOf', () => {
  it('labels each copy by what it does and the start of its name', () => {
    const labels = copyLabelsOf([
      appStateWith({ copy: '8536ff1a178f409a', pushStreamsOpen: 10 }),
      appStateWith({ copy: '1f6fcd6a677b42b3', workerSlots: 16 }),
      appStateWith({ copy: 'cubi:1234', pushStreamsOpen: 2, workerSlots: 4 }),
      appStateWith({ copy: null, pushStreamsOpen: null }),
    ]);

    expect([...labels.values()]).toEqual([
      'api-8536ff1a',
      'backend-cubi:123',
      'copy-unnamed',
      'worker-1f6fcd6a',
    ]);
  });

  it('keeps the whole names of copies whose names start alike, so that no two share a label', () => {
    const labels = copyLabelsOf([
      appStateWith({ copy: 'worker-task-1', workerSlots: 16 }),
      appStateWith({ copy: 'worker-task-10', workerSlots: 16 }),
    ]);

    expect([...labels.values()]).toEqual(['worker-worker-task-1', 'worker-worker-task-10']);
  });
});
