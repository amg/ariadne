import { z } from 'zod';

/** Text with something in it besides whitespace; kept as sent. */
export const nonBlankText = z.string().refine((text) => text.trim().length > 0);
