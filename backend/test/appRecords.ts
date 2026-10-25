import { stateRecordSchema } from '@ari/lib/api/schemas/appRecords/records';
import { afterEach, beforeEach, vi } from 'vitest';
import type { AppRecord, StateRecord } from '../src/appRecords/records';
import { logger } from '../src/logger';

type RecordOf<Kind extends AppRecord['kind']> = Extract<AppRecord, { kind: Kind }>;

/**
 * Collects the app records the code under test writes. Call it at the top
 * of a test file; read `written(kind)` inside a test. The records still
 * reach the log as they would anywhere else.
 */
export function useAppRecordCapture() {
  let spy = vi.spyOn(logger, 'info');
  beforeEach(() => {
    spy = vi.spyOn(logger, 'info');
  });
  afterEach(() => {
    spy.mockRestore();
  });
  return {
    written<Kind extends AppRecord['kind']>(kind: Kind): RecordOf<Kind>[] {
      const all = spy.mock.calls.flatMap(([fields]) => {
        // The logger takes any object; a record sits under `appRecord` when there is one.
        const { appRecord } = fields as { appRecord?: AppRecord };
        return appRecord === undefined ? [] : [appRecord];
      });
      return all.filter((record): record is RecordOf<Kind> => record.kind === kind);
    },
  };
}

/** A state record that measures nothing, but for the figures a test gives it. */
export function stateRecordOf(changes: Partial<StateRecord> = {}) {
  return stateRecordSchema.parse({
    kind: 'state',
    copy: 't1',
    at: '2026-01-02T03:04:05.678Z',
    pushStreamsOpen: null,
    oldestJobWaitMs: null,
    ...changes,
  });
}
