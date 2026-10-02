/** UUID v1–5 shape check. Postgres rejects malformed uuids at query time
 *  (22P02 → 500); route layers validate up front so bad ids get a clean 4xx. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

import { type Result, err, ok } from '../types/result';

/** Hard cap on a single message edit/submit — far beyond any realistic prompt. */
export const MAX_MESSAGE_CONTENT_LENGTH = 10_000;

export function validateMessageContent(content: string): Result<string> {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return err('invalid_content', 'Message content cannot be empty.');
  }
  if (normalized.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return err(
      'invalid_content',
      `Message content exceeds ${MAX_MESSAGE_CONTENT_LENGTH} characters.`,
    );
  }
  return ok(normalized);
}
