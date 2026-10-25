import { FACT_CATEGORIES, type FactCategory } from '@db/types';
import { findUserSettingsDocumentOrNull } from '@queries/userSettings/findUserSettingsDocument';
import { saveUserSettingsDocument } from '@queries/userSettings/saveUserSettingsDocument';

/**
 * Per-user settings. The stored document may be partial or carry keys a
 * newer or older build wrote: every read resolves it against the defaults
 * here, so adding a setting never needs a migration.
 */
interface UserSettings {
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

type UserSettingsPatch = Partial<UserSettings>;

function isFactCategory(value: unknown): value is FactCategory {
  return FACT_CATEGORIES.some((category) => category === value);
}

function categoryListOrNull(value: unknown) {
  if (!Array.isArray(value) || !value.every(isFactCategory)) return null;
  return [...new Set(value)];
}

function asRecord(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  // Narrowed to a plain object above; the record view only reads keys.
  return value as Record<string, unknown>;
}

/** A stored document resolved against the defaults; invalid values fall back. */
export function resolvedUserSettings(document: unknown) {
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

export async function getUserSettings({ userId }: { userId: string }) {
  return resolvedUserSettings(await findUserSettingsDocumentOrNull({ userId }));
}

/** Applies a validated patch and returns the resolved settings. */
export async function updateUserSettings({
  userId,
  patch,
}: {
  userId: string;
  patch: UserSettingsPatch;
}) {
  const next: UserSettings = { ...(await getUserSettings({ userId })), ...patch };
  await saveUserSettingsDocument({ userId, settings: { ...next } });
  return next;
}
