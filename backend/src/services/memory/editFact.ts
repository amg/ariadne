import type { UserFact } from '@db/types';
import { findCurrentUserFactOrNull } from '@queries/userFacts/findCurrentUserFact';
import { updateUserFact } from '@queries/userFacts/updateUserFact';
import { EMBEDDING_MODEL_ID, classifyFact, embedText } from '@services/aiService';
import { type Result, err, ok } from '../../types/result';

type EditFactContentProps = {
  factId: string;
  userId: string;
  newContent: string;
};

/**
 * Replaces a current Fact with the edited sentence, filed afresh from
 * that sentence alone: category, entity columns, and the date it states
 * (none stated means no date). Suppression and the source Turn carry
 * over. The old row is invalidated, never overwritten. Fails with
 * `fact_not_found` for a missing or superseded Fact, and leaves the Fact
 * untouched when classification or embedding fails.
 */
export async function editFactContent({
  factId,
  userId,
  newContent,
}: EditFactContentProps): Promise<Result<UserFact>> {
  const current = await findCurrentUserFactOrNull({ factId, userId });
  if (current === null) return err('fact_not_found', 'Fact not found');

  const content = newContent.trim();
  const classified = await classifyFact({
    content,
    today: new Date(),
    current: { category: current.category, subject: current.subject },
  });
  if (classified.type === 'error') return classified;

  const embedded = await embedText(content);
  if (embedded.type === 'error') return embedded;

  const replacement = await updateUserFact({
    factId,
    userId,
    replacement: {
      content,
      ...classified.data.fields,
      embedding: embedded.data.embedding,
      modelId: EMBEDDING_MODEL_ID,
      sourceMessageId: current.sourceMessageId,
      suppressed: current.suppressed,
    },
  });
  return ok(replacement);
}
