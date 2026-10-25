import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';

export const health = endpoint({
  method: 'GET',
  path: '/api/health',
  replies: { 200: z.object({ status: z.literal('ok'), message: z.string() }) },
});
