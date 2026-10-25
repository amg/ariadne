import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { codedError, errorBody } from '../common/errors.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';
import { MESSAGE_ROLES } from '../messages/message.ts';

/**
 * Why the Thread's state refuses an exchange (409): the last message waits
 * for a choice, has no reply yet, or is already being answered.
 */
export const CHAT_CONFLICT_CODES = [
  'arrival_paused',
  'arrival_unanswered',
  'arrival_answered',
  'arrival_abandoned',
  'nothing_to_regenerate',
  'exchange_in_flight',
] as const;
export type ChatConflictCode = (typeof CHAT_CONFLICT_CODES)[number];

/**
 * The Drift gate has no verdict yet (503 with `Retry-After`). The message
 * stays in its Thread, and the client tries again after the pause.
 */
export const GATE_WAIT_CODES = ['gate_pending', 'gate_failed'] as const;
export type GateWaitCode = (typeof GATE_WAIT_CODES)[number];

/** One message as the chat client sends it. Only text parts are read. */
const chatMessageSchema = z.object({
  role: z.enum(MESSAGE_ROLES),
  parts: z.array(z.object({ type: z.string(), text: z.string().exactOptional() })),
});

/**
 * A chat request. `submit-message` answers the newest user text in
 * `messages`. `regenerate-message` retries the last exchange from what the
 * server stores; `choice: 'continue'` keeps a paused arrival in its Thread
 * and replies to it.
 */
export const chatRequestSchema = z.object({
  trigger: z.enum(['submit-message', 'regenerate-message']).exactOptional(),
  messages: z.array(chatMessageSchema).exactOptional(),
  choice: z.enum(['continue', 'retry']).exactOptional(),
});
export type ChatRequest = Wire<typeof chatRequestSchema>;

/**
 * Sends one message, or retries the last exchange. A 200 is a reply
 * stream: the gate's verdict part first, then the reply. A paused
 * arrival's stream carries the verdict and no reply.
 */
export const chat = endpoint({
  method: 'POST',
  path: '/api/threads/:id/chat',
  params: threadParams,
  body: chatRequestSchema,
  replies: {
    200: 'stream',
    400: errorBody,
    404: codedError(['thread_not_found']),
    409: codedError(CHAT_CONFLICT_CODES),
    429: codedError(['budget_exceeded']).extend({
      /** Seconds until the daily budget resets. */
      retryAfter: z.number(),
    }),
    499: codedError(['client_gone']),
    500: codedError(['internal_error']),
    503: codedError([...GATE_WAIT_CODES, 'provider_not_configured']),
  },
});

/** The type of the reply-stream part that carries the gate's verdict. */
export const VERDICT_PART_TYPE = 'data-thread-verdict';
