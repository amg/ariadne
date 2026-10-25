/**
 * The accounts home runs sign in with. They follow the population's
 * naming, `user-000000@load.invalid` and on, under a domain only the
 * home harness uses. They are created once through sign-up and reused by
 * every run.
 */
export const LOAD_ACCOUNTS = {
  emailDomain: 'load.invalid',
  /** The most accounts a run or the creation command may ask for. */
  largestCount: 999,
  /** How many the creation command makes when not told. */
  defaultCount: 300,
} as const;
