import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';

/** The arrival text of a Thread's newest exchange when it was abandoned and never completed. */
export const resumeDraftSchema = z.object({ messageId: id, text: z.string() });
export type ResumeDraft = Wire<typeof resumeDraftSchema>;

/** The Thread's resume draft; 204 when nothing is owed. */
export const threadDraft = endpoint({
  method: 'GET',
  path: '/api/threads/:id/draft',
  params: threadParams,
  replies: { 200: resumeDraftSchema, 204: null, 400: errorBody, 404: errorBody },
});
