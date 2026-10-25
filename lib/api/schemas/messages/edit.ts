import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { nonBlankText } from '../common/text.ts';
import { messageSchema } from './message.ts';

/**
 * Edits the Thread's last user message. The old arrival is abandoned and
 * the edited text lands as a new one, which the Drift gate judges. 409
 * when the message is not the last.
 */
export const editMessage = endpoint({
  method: 'PATCH',
  path: '/api/threads/:id/messages/:messageId',
  params: z.object({ id, messageId: id }),
  body: z.object({ content: nonBlankText }),
  replies: {
    200: messageSchema,
    400: errorBody,
    404: errorBody,
    409: errorBody,
    500: errorBody,
  },
});
