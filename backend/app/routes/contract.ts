import type { Endpoint } from '@ari/lib/api/schemas/common/endpoint';
import type { Served } from '@ari/lib/api/schemas/common/wire';
import type { z } from 'zod';

/**
 * The Fastify route types of an endpoint: what each status may send, as
 * the backend holds it. A reply is checked against its status's schema
 * when it is sent through `reply.code(status).send(...)`. A streamed
 * reply is a web `Response` the handler returns.
 */
export type RouteOf<E extends Endpoint> = {
  Reply: {
    [Status in keyof E['replies']]: ReplyOf<E['replies'][Status]>;
  };
};

type ReplyOf<Reply> = Reply extends z.ZodType
  ? Served<Reply>
  : Reply extends 'stream'
    ? Response
    : undefined;

/**
 * `input` read through `schema`: keys the schema does not name are dropped,
 * and anything that does not fit gives null.
 */
export function parsedOrNull<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> | null {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
