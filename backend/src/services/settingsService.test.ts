import { randomUUID } from 'node:crypto';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DEFAULT_USER_SETTINGS,
  getUserSettings,
  resolvedUserSettings,
  updateUserSettings,
  validatedSettingsPatch,
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

  it('accepts known keys only, each with a valid value', () => {
    expect(validatedSettingsPatch({ memoryEnabled: false })).toEqual({
      type: 'success',
      data: { memoryEnabled: false },
    });
    expect(validatedSettingsPatch({ memoryEnabled: 'no' })).toMatchObject({ type: 'error' });
    expect(validatedSettingsPatch({ memoryBlockedCategories: ['bogus'] })).toMatchObject({
      type: 'error',
    });
    expect(validatedSettingsPatch({ theme: 'dark' })).toMatchObject({ type: 'error' });
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
