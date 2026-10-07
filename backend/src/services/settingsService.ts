import { FACT_CATEGORIES, type FactCategory } from '@db/types';
import { findUserSettingsDocumentOrNull } from '@queries/userSettings/findUserSettingsDocument';
import { saveUserSettingsDocument } from '@queries/userSettings/saveUserSettingsDocument';
import { type Result, err, ok } from '../types/result';

/**
 * Per-user settings. The stored document may be partial or carry keys a
 * newer or older build wrote: every read resolves it against the defaults
 * here, so adding a setting never needs a migration.
 */
export interface UserSettings {
  /** Capture Facts at segment close and seed fresh Threads with them. */
  memoryEnabled: boolean;
  /**
   * Fact categories never captured and never seeded. Facts stored before a
   * category was blocked stay in the store, hidden from Seeds.
   */
  memoryBlockedCategories: FactCategory[];
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  memoryEnabled: true,
  memoryBlockedCategories: ['credentials'],
};

export type UserSettingsPatch = Partial<UserSettings>;

function isFactCategory(value: unknown): value is FactCategory {
  return FACT_CATEGORIES.some((category) => category === value);
}

function categoryListOrNull(value: unknown): FactCategory[] | null {
  if (!Array.isArray(value) || !value.every(isFactCategory)) return null;
  return [...new Set(value)];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  // Narrowed to a plain object above; the record view only reads keys.
  return value as Record<string, unknown>;
}

/** A stored document resolved against the defaults; invalid values fall back. */
export function resolvedUserSettings(document: unknown): UserSettings {
  const stored = asRecord(document);
  return {
    memoryEnabled:
      typeof stored.memoryEnabled === 'boolean'
        ? stored.memoryEnabled
        : DEFAULT_USER_SETTINGS.memoryEnabled,
    memoryBlockedCategories:
      categoryListOrNull(stored.memoryBlockedCategories) ??
      DEFAULT_USER_SETTINGS.memoryBlockedCategories,
  };
}

/** Validates a client patch: known keys only, each with a valid value. */
export function validatedSettingsPatch(body: unknown): Result<UserSettingsPatch> {
  const input = asRecord(body);
  const patch: UserSettingsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'memoryEnabled') {
      if (typeof value !== 'boolean')
        return err('invalid_settings', 'memoryEnabled must be a boolean.');
      patch.memoryEnabled = value;
      continue;
    }
    if (key === 'memoryBlockedCategories') {
      const categories = categoryListOrNull(value);
      if (categories === null) {
        return err(
          'invalid_settings',
          `memoryBlockedCategories must list categories from: ${FACT_CATEGORIES.join(', ')}.`,
        );
      }
      patch.memoryBlockedCategories = categories;
      continue;
    }
    return err('invalid_settings', `Unknown setting: ${key}.`);
  }
  return ok(patch);
}

export async function getUserSettings({ userId }: { userId: string }): Promise<UserSettings> {
  return resolvedUserSettings(await findUserSettingsDocumentOrNull({ userId }));
}

/** Applies a validated patch and returns the resolved settings. */
export async function updateUserSettings({
  userId,
  patch,
}: {
  userId: string;
  patch: UserSettingsPatch;
}): Promise<UserSettings> {
  const next: UserSettings = { ...(await getUserSettings({ userId })), ...patch };
  await saveUserSettingsDocument({ userId, settings: { ...next } });
  return next;
}
