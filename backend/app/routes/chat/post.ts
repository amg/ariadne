import { randomUUID } from 'node:crypto';
import {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import {
  type ArrivalJudging,
  type ChatStreamHandle,
  type DriftPause,
  type RetryChoice,
  type ThreadTitling,
  clearActiveExchange,
  isDriftPause,
  registerActiveExchange,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import type { MemoryFeature } from '@services/memory';
import { isValidUuid } from '@services/validation';
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { Result } from '../../../src/types/result';

type ThreadParams = {
  id: string;
};

type ChatRequestBody = {
  messages?: UIMessage[];
  /** useChat transport trigger: 'submit-message' | 'regenerate-message' | 'resume-stream'. */
  trigger?: string;
  /** On a retry: 'continue' keeps a Paused arrival in this Thread and replies to it. */
  choice?: unknown;
};

/** How the chat flow queues and finds Drift gate judgments. */
const judging: ArrivalJudging = {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
};

/** How a settled Exchange reaches the Thread's titling. */
const titling: ThreadTitling = { enqueueThreadGenerateTitle };

/** The `useChat` POST contains the client's message list; we take the last user text. */
function extractLastUserText(messages: ChatRequestBody['messages']): string {
  if (!messages) return '';
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return '';
  return lastUser.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/** Failures where the thread's state forbids the exchange, with their fallback text. */
const CONFLICT_MESSAGES: Record<string, string> = {
  arrival_paused: 'The last message is waiting for a choice.',
  arrival_unanswered: 'The last message has no reply yet.',
  arrival_answered: 'The message is already being answered.',
  arrival_abandoned: 'The message was edited or moved before its reply started.',
  nothing_to_regenerate: 'The thread has no exchange to retry.',
  exchange_in_flight: 'An exchange is already running in this thread.',
};

/**
 * A verdict not in yet: temporarily unavailable, not failed. The message
 * stays in the Thread and the client retries after the hinted delay.
 */
const GATE_WAIT_MESSAGES: Record<string, string> = {
  gate_pending: 'The message is still being checked.',
  gate_failed: 'The message could not be checked.',
};
const GATE_RETRY_AFTER_SECONDS = 5;

/** Maps exchange startup failures to responses, each carrying its `errorCode`. */
function sendExchangeError(
  reply: FastifyReply,
  result: Extract<Result<ChatStreamHandle>, { type: 'error' }>,
): void {
  const errorCode = result.code;
  const conflict = CONFLICT_MESSAGES[errorCode];
  if (conflict !== undefined) {
    reply.code(409).send({ error: result.message ?? conflict, errorCode });
    return;
  }
  const gateWait = GATE_WAIT_MESSAGES[errorCode];
  if (gateWait !== undefined) {
    reply.header('Retry-After', String(GATE_RETRY_AFTER_SECONDS));
    reply.code(503).send({ error: result.message ?? gateWait, errorCode });
    return;
  }
  // Unknown thread and foreign thread stay indistinguishable (404).
  if (errorCode === 'thread_not_found') {
    reply.code(404).send({ error: 'Thread not found', errorCode });
    return;
  }
  // Nobody is left to read the answer; the status only reaches the logs.
  if (errorCode === 'client_gone') {
    reply.code(499).send({ error: 'Client closed the request', errorCode });
    return;
  }
  // Budget exceeded — 429 with Retry-After header (seconds until UTC midnight).
  if (result.code === 'budget_exceeded') {
    // Type guard: BudgetExceededError has retryAfter, StandardError doesn't
    if ('retryAfter' in result) {
      reply.header('Retry-After', String(result.retryAfter));
      reply.code(429).send({
        error: result.message ?? 'Daily spend budget exceeded.',
        errorCode,
        retryAfter: result.retryAfter,
      });
    }
    return;
  }
  // Failure-swap classes the UI can act on (vs the generic 500).
  if (errorCode === 'provider_not_configured') {
    reply.code(503).send({ error: result.message ?? 'AI provider is not configured.', errorCode });
    return;
  }
  reply.code(500).send({ error: 'Failed to start the AI exchange.', errorCode: 'internal_error' });
}

/**
 * Streams an exchange handle to the client. A client gone at any point,
 * already gone while the exchange was starting included, aborts the
 * provider, which persists the partial text as 'interrupted'.
 */
function createStreamResponse(threadId: string, handle: ChatStreamHandle, clientGone: AbortSignal) {
  let finished = false;
  void handle.outcome.finally(() => {
    finished = true;
    clearActiveExchange(threadId, handle);
  });
  const abortUnfinished = () => {
    if (!finished) handle.abort();
  };
  if (clientGone.aborted) abortUnfinished();
  else clientGone.addEventListener('abort', abortUnfinished, { once: true });

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // The live gate's verdict rides the stream as the FIRST event: the
      // arrival was judged before inference ran, so the UI tints the user
      // bubble before the reply starts growing. Transient — the settled
      // verdict lives on the persisted signal, not the message parts.
      if (handle.threadVerdict) {
        writer.write({
          type: 'data-thread-verdict',
          id: randomUUID(),
          data: {
            messageId: handle.threadVerdict.messageId,
            verdict: handle.threadVerdict.verdict,
            fireChannel: handle.threadVerdict.fireChannel,
          },
          transient: true,
        });
      }
      writer.merge(handle.stream);
    },
    onError: () => 'An error occurred while generating the reply.',
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * Streams a paused arrival: the verdict event alone, then the stream ends
 * with no reply. The UI marks the message and offers the choice.
 */
function createPauseResponse(pause: DriftPause) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({
        type: 'data-thread-verdict',
        id: randomUUID(),
        data: pause.threadVerdict,
        transient: true,
      });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * Aborts once the client is gone, for the whole request: the gate wait
 * and the exchange's stream both stop on it. Listens on the response
 * socket: under Fastify v5 and current Node, the request's 'close' and
 * 'aborted' events don't fire for streaming responses.
 */
function clientGoneSignal(reply: FastifyReply): AbortSignal {
  const gone = new AbortController();
  reply.raw.once('close', () => gone.abort());
  return gone.signal;
}

type ChatRequest = { kind: 'submit'; content: string } | { kind: 'retry'; choice: RetryChoice };

/** Responds to a submit or a retry: an exchange stream, a pause, or an error. */
async function respondToChat(
  reply: FastifyReply,
  input: { userId: string; threadId: string; request: ChatRequest; memory: MemoryFeature },
) {
  const { userId, threadId, request, memory } = input;
  const signal = clientGoneSignal(reply);
  const result =
    request.kind === 'retry'
      ? await retryLastExchange({
          userId,
          threadId,
          choice: request.choice,
          judging,
          titling,
          memory,
          signal,
        })
      : await submitChat({
          userId,
          threadId,
          content: request.content,
          judging,
          titling,
          memory,
          signal,
        });
  if (result.type === 'error') return sendExchangeError(reply, result);
  if (isDriftPause(result.data)) return createPauseResponse(result.data);
  registerActiveExchange(input.threadId, result.data);
  return createStreamResponse(input.threadId, result.data, signal);
}

export async function setupChatPostRoute(
  fastify: FastifyInstance,
  { memory }: { memory: MemoryFeature },
) {
  fastify.post(
    '/api/threads/:id/chat',
    {
      // Each request triggers a billable DeepInfra call — throttle hard.
      preHandler: verifySession(),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (
      request: FastifyRequest<{ Params: ThreadParams; Body: ChatRequestBody }>,
      reply: FastifyReply,
    ) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }

      const trigger = request.body?.trigger;
      if (
        trigger !== undefined &&
        trigger !== 'submit-message' &&
        trigger !== 'regenerate-message'
      ) {
        return reply.code(400).send({ error: `Unsupported trigger: ${trigger}` });
      }

      // Retry of the last inference (useChat `regenerate()`). The server is
      // authoritative: DB state decides the exchange, client messages ignored.
      if (trigger === 'regenerate-message') {
        const choice: RetryChoice = request.body?.choice === 'continue' ? 'continue' : 'retry';
        return respondToChat(reply, {
          userId,
          threadId,
          request: { kind: 'retry', choice },
          memory,
        });
      }

      const content = extractLastUserText(request.body?.messages);
      if (!content) {
        return reply.code(400).send({ error: 'Missing message content' });
      }

      return respondToChat(reply, {
        userId,
        threadId,
        request: { kind: 'submit', content },
        memory,
      });
    },
  );
}
