import type { z } from 'zod';
import type { Wire } from './wire.ts';

/**
 * One endpoint: where it lives, what it accepts and what it answers with,
 * by status. A status with no body maps to `null`, and one whose body is
 * streamed rather than JSON maps to `'stream'`.
 */
export type Endpoint = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: `/api/${string}`;
  params?: z.ZodType;
  body?: z.ZodType;
  replies: Readonly<Record<number, z.ZodType | null | 'stream'>>;
};

/** The body a client sends to an endpoint. */
export type RequestOf<E extends Endpoint> = E['body'] extends z.ZodType ? Wire<E['body']> : never;

/** Declares an endpoint, keeping its exact schemas in the type. */
export function endpoint<const E extends Endpoint>(definition: E): E {
  return definition;
}

/** An endpoint's path with its `:name` parameters filled in. */
export function pathOf(
  target: Pick<Endpoint, 'path'>,
  params: Readonly<Record<string, string>> = {},
) {
  return target.path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${target.path} needs a value for ${name}`);
    return encodeURIComponent(value);
  });
}
