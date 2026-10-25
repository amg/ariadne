import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import type { Wire } from '../common/wire.ts';
import { FACT_CATEGORIES } from './facts.ts';

export const userSettingsSchema = z.object({
  /** Capture Facts as segments close, and seed new Threads with them. */
  memoryEnabled: z.boolean(),
  /** Categories never captured and never seeded. */
  memoryBlockedCategories: z.array(z.enum(FACT_CATEGORIES)),
});
export type UserSettings = Wire<typeof userSettingsSchema>;

/** A change to some settings. A category listed twice counts once. */
export const settingsPatchSchema = z.object({
  memoryEnabled: z.boolean().exactOptional(),
  memoryBlockedCategories: z
    .array(z.enum(FACT_CATEGORIES))
    .transform((categories) => [...new Set(categories)])
    .exactOptional(),
});
export type SettingsPatch = Wire<typeof settingsPatchSchema>;

export const getSettings = endpoint({
  method: 'GET',
  path: '/api/settings',
  replies: { 200: userSettingsSchema },
});

export const updateSettings = endpoint({
  method: 'PATCH',
  path: '/api/settings',
  body: settingsPatchSchema,
  replies: { 200: userSettingsSchema, 400: errorBody },
});
