import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { threadParams } from '../common/threadParams.ts';

/**
 * Queues the Thread's titling and answers at once. `forced` names the
 * Thread from its first segment, replacing any title it has.
 */
export const generateTitle = endpoint({
  method: 'POST',
  path: '/api/threads/:id/generate-title',
  params: threadParams,
  body: z.object({ forced: z.boolean().optional() }),
  replies: {
    202: z.object({ success: z.literal(true), queued: z.literal(true) }),
    400: errorBody,
    404: errorBody,
  },
});
