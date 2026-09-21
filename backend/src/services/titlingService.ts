import { env } from '@config/env';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  errorReason,
  logExchangeError,
  logExchangeRequest,
  logExchangeResponse,
  logger,
} from '../logger';
import { ErrorCodes, type TitlingErrorCode } from '../types/errorCodes';
import { createModel, isInferenceConfigured, resolveInferenceConfig } from './aiService/config';
import { renameThread } from './threadService';

/**
 * Titling must never hang the UI: it owns its own time budget, independent
 * of the chat stream's idle timeout. Read from centralized env config.
 * 5s gives the uncapped final shape room for long thinking (~4s) plus the
 * ~1s spent on the cheap first attempt.
 */
function resolveTitlingTimeoutMs(): number {
  return env.AI_TITLING_TIMEOUT_MS ?? 5000;
}

/** How much of each message the prompt learns from — keeps prefill cheap. */
const TITLING_CONTEXT_CHARS = 300;
/** Titles are a few words; cap output so nothing rambles — but only for the
 *  cheap first attempt. The final attempt is uncapped by design. */
const TITLING_MAX_OUTPUT_TOKENS = 40;

/**
 * Terminal outcomes, mapped to HTTP responses by the route. `message` is the
 * server-side detail (logged only) — the client receives just the contract
 * `code` (see `../types/errorCodes`).
 */
export type TitlingOutcome =
  | { type: 'titled'; title: string }
  /** No usable title; the sentinel (if present) was settled to the fallback. */
  | { type: 'settled' }
  /** Generation blew up; the sentinel (if present) was still settled. */
  | { type: 'failed'; code: TitlingErrorCode; message: string };

type GenerationResult =
  | { ok: true; text: string; attempt: number }
  | { ok: false; code: TitlingErrorCode; message: string };

function clipped(value?: string): string {
  return (value ?? '').slice(0, TITLING_CONTEXT_CHARS);
}

/**
 * Low-effort generation, with a graduated fallback so a single unsupported
 * option (or a flaky provider response shape) doesn't kill titling. One hard
 * time budget caps the whole sequence. Every attempt is logged: the shape it
 * tried (warn), and — with DEBUG=true — the full prompt sent and the text
 * returned (colored exchange blocks in the dev console).
 */
async function generateTitleText(model: LanguageModel, prompt: string): Promise<GenerationResult> {
  const controller = new AbortController();
  const timeoutMs = resolveTitlingTimeoutMs();
  const budget = setTimeout(() => controller.abort(), timeoutMs);

  const base = {
    model,
    prompt,
    // SDK-level retries OFF: our own graduated attempts handle it, predictably.
    maxRetries: 0,
    abortSignal: controller.signal,
  };

  const attempts: Array<Parameters<typeof generateText>[0]> = [
    // Cheapest: bound output and disable the thinking phase — DeepInfra
    // deployments honour this only via `chat_template_kwargs.enable_thinking`
    // (a top-level `enable_thinking` is accepted but ignored —). Working: ~3s, direct title.
    {
      ...base,
      maxOutputTokens: TITLING_MAX_OUTPUT_TOKENS,
      providerOptions: {
        deepinfra: { chat_template_kwargs: { enable_thinking: false } },
      },
    },
    // The always-runnable shape: nothing to be rejected (no knobs) and no
    // output cap to race — thinking models fill any cap with reasoning and
    // answer empty `content` at `finish_reason: length` (spec evidence, incl.
    // caps of 400). Uncapped, the model finishes thinking and emits the
    // title; the shared time budget, not tokens, bounds this attempt.
    { ...base },
  ];

  try {
    let lastError: unknown;
    let lastWasEmpty = false;
    let attemptNo = 0;
    for (const attempt of attempts) {
      attemptNo += 1;
      const label = `generate-title ${attemptNo}/${attempts.length}`;
      try {
        logExchangeRequest(label, prompt);
        const { text } = await generateText(attempt);
        logExchangeResponse(label, text);
        if (!text.trim()) {
          // Call succeeded but nothing usable came back (an output cap got
          // consumed by a thinking phase, or a bare empty reply). Treat it
          // like a rejected shape: climb the ladder if attempts remain.
          lastError = new Error('provider returned empty content');
          lastWasEmpty = true;
          logger.warn(
            `Auto-titling attempt ${attemptNo}/${attempts.length} returned empty content — trying next shape`,
          );
          continue;
        }
        if (attemptNo > 1) {
          logger.warn(`Auto-titling succeeded on fallback attempt ${attemptNo}/${attempts.length}`);
        }
        return { ok: true, text, attempt: attemptNo };
      } catch (error) {
        lastError = error;
        lastWasEmpty = false;
        const reason = errorReason(error);
        logExchangeError(label, reason);
        logger.warn(`Auto-titling attempt ${attemptNo}/${attempts.length} failed: ${reason}`);
      }
    }
    // Shared budget fired → timeout; otherwise the provider either rejected
    // every shape or only ever answered with empty content. The detail stays
    // here (server log), the client gets the code.
    if (controller.signal.aborted) {
      return {
        ok: false,
        code: ErrorCodes.TITLE_TIMEOUT,
        message: `aborted after ${timeoutMs}ms budget: ${errorReason(lastError)}`,
      };
    }
    return {
      ok: false,
      code: lastWasEmpty ? ErrorCodes.TITLE_EMPTY_RESPONSE : ErrorCodes.TITLE_PROVIDER_ERROR,
      message: errorReason(lastError),
    };
  } finally {
    clearTimeout(budget);
  }
}

/**
 * Derives a short title for a thread from the first exchange.
 * Used asynchronously to avoid blocking the main chat stream.
 */
export async function autoTitleThread(userId: string, threadId: string): Promise<TitlingOutcome> {
  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return {
      type: 'failed',
      code: ErrorCodes.PROVIDER_NOT_CONFIGURED,
      message: 'no AI provider configured (no base URL and no API key)',
    };
  }

  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) {
    return {
      type: 'failed',
      code: ErrorCodes.THREAD_NOT_FOUND,
      message: `thread ${threadId} not found for user ${userId}`,
    };
  }

  const messages = await listMessagesByThread({ threadId });
  if (messages.length < 2) {
    return { type: 'settled' };
  }

  const prompt = `Given the following conversation, generate a very short, concise title (max 5 words). Do not use quotes, punctuation, or generic filler like "Chat about". Reply with only the title.

User: ${clipped(messages[0]?.content)}
Assistant: ${clipped(messages[1]?.content)}`;

  try {
    const modelStr = env.TITLING_MODEL || config.model;
    const model = createModel({ ...config, model: modelStr });

    const generation = await generateTitleText(model, prompt);
    if (!generation.ok) {
      return { type: 'failed', code: generation.code, message: generation.message };
    }

    const generatedTitle = generation.text.trim().replace(/^["']|["']$/g, '');

    await renameThread({ userId, threadId, title: generatedTitle });
    return { type: 'titled', title: generatedTitle };
  } catch (error) {
    logger.error({ err: error }, `Auto-titling failed for thread ${threadId}`);
    return { type: 'failed', code: ErrorCodes.INTERNAL_ERROR, message: errorReason(error) };
  }
}
