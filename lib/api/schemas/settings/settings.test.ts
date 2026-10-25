import { describe, expect, it } from 'vitest';
import { settingsPatchSchema } from './settings.ts';

describe('a settings patch', () => {
  it('drops keys that are not settings', () => {
    expect(settingsPatchSchema.parse({ memoryEnabled: false, theme: 'dark' })).toEqual({
      memoryEnabled: false,
    });
  });

  it('counts a category listed twice once', () => {
    expect(settingsPatchSchema.parse({ memoryBlockedCategories: ['health', 'health'] })).toEqual({
      memoryBlockedCategories: ['health'],
    });
  });

  it('refuses an unknown category, a value of the wrong type, and an explicit undefined', () => {
    expect(settingsPatchSchema.safeParse({ memoryBlockedCategories: ['bogus'] }).success).toBe(
      false,
    );
    expect(settingsPatchSchema.safeParse({ memoryEnabled: 'no' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ memoryEnabled: undefined }).success).toBe(false);
  });
});
