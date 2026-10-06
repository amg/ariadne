/** Which features this deployment runs, as the server reports them. */
export interface FeatureFlags {
  /** Fact capture, Thread Seeds, and the Memory screen and settings. */
  memory: boolean;
}

/** Every feature off: what the app assumes until the server says otherwise. */
export const FEATURE_DEFAULTS: FeatureFlags = { memory: false };

/**
 * The flags the server reported, each read strictly: anything other than
 * an explicit `true` keeps the feature at its default, so a garbled or
 * missing answer can hide a feature but never expose one.
 */
export function featuresFromServer(served: unknown): FeatureFlags {
  if (typeof served !== 'object' || served === null) return FEATURE_DEFAULTS;
  const flags = served as Partial<Record<keyof FeatureFlags, unknown>>;
  return { memory: flags.memory === true };
}
