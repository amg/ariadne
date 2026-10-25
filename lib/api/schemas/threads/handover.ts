import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';
import { threadSchema } from './thread.ts';

/** The fresh Thread a paused arrival moved into, and the arrival's stored copy there. */
export const handoverSchema = z.object({
  thread: threadSchema,
  message: z.object({ id, content: z.string() }),
});
export type Handover = Wire<typeof handoverSchema>;

/**
 * Starts a new chat from the Thread's paused arrival. 503 `capture_pending`
 * while the old Thread's memory is still being saved: nothing moved, so ask
 * again. 409 when the message is not, or no longer, a paused arrival.
 */
export const handOver = endpoint({
  method: 'POST',
  path: '/api/threads/:id/handover',
  params: threadParams,
  body: z.object({ messageId: id }),
  replies: {
    200: handoverSchema,
    400: errorBody,
    404: errorBody,
    409: errorBody,
    503: errorBody,
  },
});
