import { z } from 'zod';

/** An id in the shape Postgres stores ids in. */
export const id = z.guid();
