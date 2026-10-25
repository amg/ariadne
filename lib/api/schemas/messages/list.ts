import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { threadParams } from '../common/threadParams.ts';
import { messageSchema } from './message.ts';

export const listMessages = endpoint({
  method: 'GET',
  path: '/api/threads/:id/messages',
  params: threadParams,
  replies: { 200: z.array(messageSchema), 400: errorBody, 404: errorBody },
});
