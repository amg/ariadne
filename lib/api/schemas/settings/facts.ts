import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { id } from '../common/id.ts';
import { instant } from '../common/instant.ts';
import { nonBlankText } from '../common/text.ts';
import type { Wire } from '../common/wire.ts';

export const FACT_CATEGORIES = [
  'identity',
  'preference',
  'health',
  'relationships',
  'work',
  'location',
  'credentials',
  'other',
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/** One sentence the Memory holds about the user. */
export const userFactSchema = z.object({
  id,
  content: z.string(),
  category: z.enum(FACT_CATEGORIES),
  /** Who the Fact is about; `user` for the user. */
  subject: z.string().nullable(),
  predicate: z.string().nullable(),
  object: z.string().nullable(),
  modelId: z.string(),
  /** The user message the Fact came from; null once its Thread is gone. */
  sourceMessageId: id.nullable(),
  /** When the Fact became true, as the conversation states it. */
  validAt: instant.nullable(),
  /** When the Fact stopped being current; null while it is. */
  invalidAt: instant.nullable(),
  /** Kept, but never given to a new Thread. */
  suppressed: z.boolean(),
  createdAt: instant,
});
export type UserFact = Wire<typeof userFactSchema>;

/** Every Fact of the user, suppressed ones included, newest first. */
export const listFacts = endpoint({
  method: 'GET',
  path: '/api/memory/facts',
  replies: { 200: z.array(userFactSchema) },
});

const factParams = z.object({ id });

/**
 * Edits a Fact's text, which replaces the Fact with a new one, or turns
 * its suppression on or off. 502 when an edit cannot be judged again; the
 * Fact stays as it was.
 */
export const updateFact = endpoint({
  method: 'PATCH',
  path: '/api/memory/facts/:id',
  params: factParams,
  body: z.union([z.object({ suppressed: z.boolean() }), z.object({ content: nonBlankText })]),
  replies: { 200: userFactSchema, 400: errorBody, 404: errorBody, 502: errorBody },
});

export const deleteFact = endpoint({
  method: 'DELETE',
  path: '/api/memory/facts/:id',
  params: factParams,
  replies: { 204: null, 400: errorBody, 404: errorBody },
});
