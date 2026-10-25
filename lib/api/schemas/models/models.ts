import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';

/**
 * Refreshes model prices from the provider. A refresh asked for too soon
 * after the last one changes nothing and says so with `rateLimited`.
 */
export const refreshModels = endpoint({
  method: 'POST',
  path: '/api/models/refresh',
  replies: {
    200: z.object({
      success: z.literal(true),
      modelsUpdated: z.number(),
      rateLimited: z.boolean().exactOptional(),
    }),
    500: errorBody.extend({ modelsUpdated: z.number(), rateLimited: z.boolean() }),
  },
});
