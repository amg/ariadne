import { z } from 'zod';

/** A moment in UTC with milliseconds, as `Date.toISOString` writes it. */
export const instant = z.iso.datetime({ precision: 3 });
