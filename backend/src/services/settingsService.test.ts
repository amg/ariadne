import { randomUUID } from 'node:crypto';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DEFAULT_USER_SETTINGS,
  getUserSettings,
  resolvedUserSettings,
  updateUserSettings,
} from '@services/settingsService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('settingsService', () => {
  useTestDb();

  it('resolves a missing document to the defaults', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });

    expect(await getUserSettings({ userId })).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('falls back per key on invalid stored values and ignores unknown keys', () => {
    expect(
      resolvedUserSettings({
        memoryEnabled: 'yes',
        memoryBlockedCategories: ['health', 'health'],
        retired: true,
      }),
    ).toEqual({ memoryEnabled: true, memoryBlockedCategories: ['health'] });
    expect(resolvedUserSettings({ memoryBlockedCategories: ['nonsense'] })).toEqual(
      DEFAULT_USER_SETTINGS,
    );
  });

  it('merges a patch over the stored settings', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });

    await updateUserSettings({ userId, patch: { memoryEnabled: false } });
    await updateUserSettings({ userId, patch: { memoryBlockedCategories: ['health'] } });

    expect(await getUserSettings({ userId })).toEqual({
      memoryEnabled: false,
      memoryBlockedCategories: ['health'],
    });
  });
});
