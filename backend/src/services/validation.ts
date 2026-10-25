import { err, ok } from '../types/result';

/** Hard cap on a single message edit/submit — far beyond any realistic prompt. */
const MAX_MESSAGE_CONTENT_LENGTH = 10_000;

export function validateMessageContent(content: string) {
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
