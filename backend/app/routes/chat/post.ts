import { randomUUID } from 'node:crypto';
import {
  CHAT_CONFLICT_CODES,
  type ChatConflictCode,
  GATE_WAIT_CODES,
  type GateWaitCode,
  VERDICT_PART_TYPE,
  chat,
} from '@ari/lib/api/schemas/chat/chat';
import type { streamVerdictSchema } from '@ari/lib/api/schemas/common/driftGate';
import type { Served } from '@ari/lib/api/schemas/common/wire';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import {
  clearActiveExchange,
  isDriftPause,
  registerActiveExchange,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type {
  ArrivalJudging,
  ChatStreamHandle,
  DriftPause,
  RetryChoice,
} from '../../../src/types/aiService';
import type { MemoryFeature } from '../../../src/types/memory';
import type { ResultError } from '../../../src/types/result';
import { type RouteOf, parsedOrNull } from '../contract';
import { threadIdOrReject, userIdOf } from '../request';

type ThreadTitling = Parameters<typeof submitChat>[0]['titling'];

type ChatReply = FastifyReply<RouteOf<typeof chat>>;
type ChatMessages = NonNullable<Served<typeof chat.body>['messages']>;

/** How the chat flow queues and finds Drift gate judgments. */
const judging: ArrivalJudging = {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
};

/** How a settled Exchange reaches the Thread's titling. */
const titling: ThreadTitling = { enqueueThreadGenerateTitle };

/** The newest user text in the request's messages is the message. */
function extractLastUserText(messages: ChatMessages | undefined) {
  if (!messages) return '';
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return '';
  return lastUser.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

/** Failures where the thread's state forbids the exchange, with their fallback text. */
const CONFLICT_MESSAGES: Record<ChatConflictCode, string> = {
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
const GATE_WAIT_MESSAGES: Record<GateWaitCode, string> = {
  gate_pending: 'The message is still being checked.',
  gate_failed: 'The message could not be checked.',
};
const GATE_RETRY_AFTER_SECONDS = 5;

const isOneOf = <Code extends string>(codes: readonly Code[], code: string): code is Code =>
  codes.some((known) => known === code);

/** Maps exchange startup failures to responses, each carrying its `errorCode`. */
function sendExchangeError(reply: ChatReply, result: ResultError) {
  const errorCode = result.code;
  if (isOneOf(CHAT_CONFLICT_CODES, errorCode)) {
    reply.code(409).send({ error: result.message ?? CONFLICT_MESSAGES[errorCode], errorCode });
    return;
  }
  if (isOneOf(GATE_WAIT_CODES, errorCode)) {
    reply.header('Retry-After', String(GATE_RETRY_AFTER_SECONDS));
    reply.code(503).send({ error: result.message ?? GATE_WAIT_MESSAGES[errorCode], errorCode });
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
  if ('retryAfter' in result) {
    reply.header('Retry-After', String(result.retryAfter));
    reply.code(429).send({
      error: result.message,
      errorCode: result.code,
      retryAfter: result.retryAfter,
    });
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
 * The gate's verdict as a reply-stream part. It is transient: the client
 * reads it as it arrives, and the message parts never keep it.
 */
function verdictPart(verdict: Served<typeof streamVerdictSchema>) {
  const data: Served<typeof streamVerdictSchema> = {
    messageId: verdict.messageId,
    verdict: verdict.verdict,
    fireChannel: verdict.fireChannel,
  };
  return { type: VERDICT_PART_TYPE, id: randomUUID(), data, transient: true } as const;
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
      if (handle.threadVerdict) writer.write(verdictPart(handle.threadVerdict));
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
      writer.write(verdictPart(pause.threadVerdict));
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
function clientGoneSignal(reply: ChatReply) {
  const gone = new AbortController();
  reply.raw.once('close', () => gone.abort());
  return gone.signal;
}

type ChatRequest = { kind: 'submit'; content: string } | { kind: 'retry'; choice: RetryChoice };

/** Responds to a submit or a retry: an exchange stream, a pause, or an error. */
async function respondToChat(
  reply: ChatReply,
  input: {
    userId: string;
    threadId: string;
    request: ChatRequest;
    memory: MemoryFeature;
    threadAnalysisMode: ThreadAnalysisMode;
  },
) {
  const { userId, threadId, request, memory, threadAnalysisMode } = input;
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
          threadAnalysisMode,
          signal,
        })
      : await submitChat({
          userId,
          threadId,
          content: request.content,
          judging,
          titling,
          memory,
          threadAnalysisMode,
          signal,
        });
  if (result.type === 'error') return sendExchangeError(reply, result);
  if (isDriftPause(result.data)) return createPauseResponse(result.data);
  registerActiveExchange({ userId, threadId }, result.data);
  return createStreamResponse(input.threadId, result.data, signal);
}

export function setupChatPostRoute(
  fastify: FastifyInstance,
  { memory, threadAnalysisMode }: { memory: MemoryFeature; threadAnalysisMode: ThreadAnalysisMode },
) {
  fastify.route<RouteOf<typeof chat>>({
    method: chat.method,
    url: chat.path,
    // Each request triggers a billable DeepInfra call — throttle hard.
    preHandler: verifySession(),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = threadIdOrReject({ request, reply });
      if (threadId === null) return reply;
      const body = parsedOrNull(chat.body, request.body ?? {});
      if (!body) return reply.code(400).send({ error: 'Unsupported chat request' });

      // Retry of the last inference (useChat `regenerate()`). The server is
      // authoritative: DB state decides the exchange, client messages ignored.
      if (body.trigger === 'regenerate-message') {
        const choice: RetryChoice = body.choice ?? 'retry';
        return respondToChat(reply, {
          userId,
          threadId,
          request: { kind: 'retry', choice },
          memory,
          threadAnalysisMode,
        });
      }

      const content = extractLastUserText(body.messages);
      if (!content) return reply.code(400).send({ error: 'Missing message content' });

      return respondToChat(reply, {
        userId,
        threadId,
        request: { kind: 'submit', content },
        memory,
        threadAnalysisMode,
      });
    },
  });
}
