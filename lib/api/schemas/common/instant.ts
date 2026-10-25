import { z } from 'zod';

/**
 * A moment in time. On the wire it is ISO text in UTC. The backend may
 * hold it as a `Date` or as that text already, because JSON writes both
 * the same way.
 */
export const instant = z.codec(z.iso.datetime(), z.union([z.date(), z.iso.datetime()]), {
  decode: (text) => new Date(text),
  encode: (value) => (typeof value === 'string' ? value : value.toISOString()),
});
