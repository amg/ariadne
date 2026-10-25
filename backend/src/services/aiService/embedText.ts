import { embed } from 'ai';
import { err, ok } from '../../types/result';
import {
  NOT_CONFIGURED_MESSAGE,
  createEmbeddingModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';

export async function embedText(value: string) {
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
