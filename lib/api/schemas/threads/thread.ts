import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { instant } from '../common/instant.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';

export const threadSchema = z.object({
  id,
  /** Null until the Thread is named. */
  title: z.string().nullable(),
  createdAt: instant,
});
export type Thread = Wire<typeof threadSchema>;

export const listThreads = endpoint({
  method: 'GET',
  path: '/api/threads',
  replies: { 200: z.array(threadSchema) },
});

export const createThread = endpoint({
  method: 'POST',
  path: '/api/threads',
  body: z.object({}),
  replies: { 200: threadSchema, 400: errorBody },
});

export const renameThread = endpoint({
  method: 'PATCH',
  path: '/api/threads/:id',
  params: threadParams,
  body: z.object({ title: z.string() }),
  replies: { 200: threadSchema, 400: errorBody, 404: errorBody },
});

export const deleteThread = endpoint({
  method: 'DELETE',
  path: '/api/threads/:id',
  params: threadParams,
  replies: { 204: null, 400: errorBody, 404: errorBody },
});
