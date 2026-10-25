import { stateRecordOf } from '@test/appRecords';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { copyName } from './copyName';
import { logAppRecord } from './records';

// A record as its writer gives it, before the copy is named.
const { copy: _named, ...state } = stateRecordOf({ pushStreamsOpen: 12 });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function loggedFields() {
  const spy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  logAppRecord(state);
  return spy.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('logAppRecord', () => {
  it('writes the record alone where metrics are not published, naming the copy that wrote it', () => {
    expect(loggedFields()).toEqual({ appRecord: { ...state, copy: copyName() } });
  });

  it('adds the record’s metric fields to the same line where metrics are published', () => {
    vi.stubEnv('PUBLISH_METRICS', 'true');

    expect(loggedFields()).toMatchObject({ appRecord: state, PushStreamsOpen: 12 });
  });
});
