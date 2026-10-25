import type { z } from 'zod';

/** A value as it travels as JSON. Clients send and read this shape. */
export type Wire<Schema extends z.ZodType> = z.input<Schema>;

/** A value as the backend holds it, before JSON writes it to the wire. */
export type Served<Schema extends z.ZodType> = z.output<Schema>;
