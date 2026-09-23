import { embed } from 'ai';
import { type Result, err, ok } from '../../types/result';
import {
  NOT_CONFIGURED_MESSAGE,
  createEmbeddingModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';

/**
 * The embed export of the provider boundary.
 * Built on the DeepInfra provider's embedding model, inheriting the
 * established provider config resolution (mock switch, configured check)
 * exactly like the chat path — callers never hand-roll provider config.
 */

export interface EmbedTextData {
  embedding: number[];
  /** Provider-reported prompt tokens for this call (embedding-cost accounting input). */
  promptTokens: number;
}

export async function embedText(value: string): Promise<Result<EmbedTextData>> {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }
  try {
    // maxRetries 0, like the chat path: failures abort cleanly instead of
    // multiplying requests (abort-and-resume relies on exact accounting).
    const result = await embed({ model: createEmbeddingModel(config), value, maxRetries: 0 });
    return ok({ embedding: [...result.embedding], promptTokens: result.usage.tokens });
  } catch (error) {
    console.error('[embedText] embedding call failed:', error);
    return err('embed_failed', 'The embedding provider rejected the call.');
  }
}
