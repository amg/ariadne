import { recordArrivalEmbedding } from '@queries/messageEmbeddings/recordArrivalEmbedding';
import { computeEmbeddingCostUsd } from '@services/aiService/pricing';
import { err, ok } from '../../../types/result';
import { EMBEDDING_MODEL_ID, embedText } from '../../aiService';
import { formattedProspectiveTurn } from '../turns';
import { currentModelVectorOrNull, withEmbedding } from './liveChain';
import type { MessageStep } from './messageStep';

/**
 * Embed step: embeds the rewrite step's decision — the self-contained
 * reading when one was accepted, otherwise the raw arrival — into the
 * same arrival row. A stored row that already has a vector for this
 * embedding model short-circuits the call (never re-embed the arrival).
 * When two passes embed the same arrival at once, the first vector stored
 * stands, and the verdict step of both reads it.
 *
 * This step cannot fail open: a missing or failed embedding aborts the
 * transformer and the exchange surfaces the failure.
 */
export const embedMessageStep: MessageStep = {
  name: 'embed',
  async run({ chain, arrivalIndex }) {
    const arrival = chain.arrivals[arrivalIndex];
    if (!arrival) return err('thread_not_found');
    const userMessageId = arrival.userMessage.id;
    const stored = chain.embeddings.get(userMessageId);
    if (currentModelVectorOrNull(stored) !== null) return ok(chain);

    const text = stored?.rewrittenText ?? arrival.userMessage.content;
    const embedded = await embedText(formattedProspectiveTurn(text));
    if (embedded.type === 'error') return embedded;
    // The step's spend rides the arrival row.
    const embeddingCostUsd = await computeEmbeddingCostUsd(embedded.data.promptTokens);
    const recorded = await recordArrivalEmbedding({
      messageId: userMessageId,
      embedding: embedded.data.embedding,
      modelId: EMBEDDING_MODEL_ID,
      embeddingCostUsd,
    });
    return ok(withEmbedding(chain, recorded));
  },
};
