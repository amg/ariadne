import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { threadParams } from '../common/threadParams.ts';

/** Stops the Thread's live exchange; 404 when none runs. */
export const stopExchange = endpoint({
  method: 'POST',
  path: '/api/threads/:id/stop',
  params: threadParams,
  replies: {
    200: z.object({ status: z.literal('interrupted') }),
    400: errorBody,
    404: errorBody,
  },
});
