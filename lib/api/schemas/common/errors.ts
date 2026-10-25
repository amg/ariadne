import { z } from 'zod';

/** What every failed request answers with. `errorCode` is set where a client acts on the reason. */
export const errorBody = z.object({
  error: z.string(),
  errorCode: z.string().exactOptional(),
});

/** The failed request's body, with `errorCode` one of the given codes. */
export const codedError = <const Codes extends readonly [string, ...string[]]>(codes: Codes) =>
  z.object({ error: z.string(), errorCode: z.enum(codes) });
