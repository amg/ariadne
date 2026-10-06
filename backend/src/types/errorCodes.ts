/**
 * Error-code contract shared with the frontend (mirrored by
 * `frontend/src/services/errorCodes.ts`).
 *
 * Policy (curated error surface):
 *  - The client receives a stable `errorCode` and nothing else.
 *  - Raw provider details (DeepInfra rejection messages, stack context) stay
 *    in the server console only — the frontend is public, these aren't.
 *  - The frontend maps each code to its own friendly copy for toasts/UI.
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
