/**
 * The stable codes a titling failure is recorded with. Raw provider
 * details stay in the server log only.
 */
export const ErrorCodes = {
  THREAD_NOT_FOUND: 'thread_not_found',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
  /** Third-party (DeepInfra) rejected the call; real reason logged server-side. */
  TITLE_PROVIDER_ERROR: 'title_provider_error',
  TITLE_EMPTY_RESPONSE: 'title_empty_response',
  TITLE_TIMEOUT: 'title_timeout',
  INTERNAL_ERROR: 'internal_error',
} as const;

/** Union of every contract code above; the titling flow can produce all of them. */
export type TitlingErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
