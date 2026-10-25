import { findCurrentUserFact } from '@queries/userFacts/findCurrentUserFact';
import { replaceCurrentUserFactOrNull } from '@queries/userFacts/replaceCurrentUserFactOrNull';
import { EMBEDDING_MODEL_ID, classifyFact, embedText } from '@services/aiService';
import { err, ok } from '../../types/result';

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
 * `fact_not_found` for a missing or superseded Fact, including one
 * superseded while the edit was being filed, and leaves the Fact
 * untouched when classification or embedding fails.
 */
export async function editFactContent({ factId, userId, newContent }: EditFactContentProps) {
  const current = await findCurrentUserFact({ factId, userId });
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

  const replacement = await replaceCurrentUserFactOrNull({
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
  if (replacement === null) return err('fact_not_found', 'Fact not found');
  return ok(replacement);
}
