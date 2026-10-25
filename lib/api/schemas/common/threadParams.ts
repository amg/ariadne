import { z } from 'zod';
import { id } from './id.ts';

/** The route parameters of anything addressed through its Thread. */
export const threadParams = z.object({ id });
