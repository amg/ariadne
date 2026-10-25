/**
 * Frontend half of the backend's error-code contract
 * (`backend/src/types/errorCodes.ts`). Failed API calls carry a stable
 * `errorCode` — the raw provider details never cross the wire; this map
 * turns each code into friendly copy for toasts/UI. Unknown codes degrade
 * to the generic message, so add codes here the moment the backend does.
 */

const MESSAGE_BY_CODE: Record<string, string> = {
  thread_not_found: 'Chat not found — it may have been deleted.',
  provider_not_configured: 'Title generation is unavailable right now.',
  title_provider_error: 'The AI service rejected the title request. Try again in a bit.',
  title_timeout: 'Title generation timed out. Please try again.',
  title_empty_response: "The AI couldn't come up with a title. Please try again.",
  internal_error: 'Something went wrong. Please try again.',
};

const DEFAULT_FRIENDLY_MESSAGE = 'Something went wrong. Please try again.';

export function friendlyErrorMessage(errorCode: unknown, fallback = DEFAULT_FRIENDLY_MESSAGE) {
  if (typeof errorCode !== 'string') return fallback;
  return MESSAGE_BY_CODE[errorCode] ?? fallback;
}
