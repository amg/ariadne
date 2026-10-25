import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import { errorBody } from '../common/errors.ts';
import { threadParams } from '../common/threadParams.ts';
import type { Wire } from '../common/wire.ts';

/** What a capture pass did. */
export const captureReportSchema = z.object({
  /** False when memory is off: nothing was read. */
  memoryEnabled: z.boolean(),
  /** Segments that owed a capture; 0 means nothing new since the last pass. */
  owed: z.number(),
  failed: z.number(),
  /** Why the first failed segment failed; null while none has. */
  failureCode: z.string().nullable(),
  added: z.number(),
  /** Known Facts restated or corrected, now replaced by the newer reading. */
  replaced: z.number(),
});
export type MemoryCaptureReport = Wire<typeof captureReportSchema>;

/**
 * Captures everything in the Thread not read yet. 502 when a segment
 * failed, with the report; that segment is tried again on the next pass.
 * 403 while thread analysis is off.
 */
export const captureThreadMemory = endpoint({
  method: 'POST',
  path: '/api/threads/:id/capture-memory',
  params: threadParams,
  replies: {
    200: captureReportSchema,
    400: errorBody,
    403: errorBody,
    404: errorBody,
    502: captureReportSchema.extend({ error: z.string() }),
  },
});
