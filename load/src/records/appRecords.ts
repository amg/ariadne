import {
  exchangeRecordSchema,
  jobRecordSchema,
  requestRecordSchema,
  stateRecordSchema,
} from '@ari/lib/api/schemas/appRecords/records';
import type { z } from 'zod';
import { recordKind } from './versioned.ts';

/**
 * The backend's own records as a run stores them: one file per kind, each
 * line a record without its `kind`. A change to the backend's schema that
 * old files do not satisfy raises the run folder's schema version.
 */
const exchangeSchema = exchangeRecordSchema.omit({ kind: true });
export type ExchangeLine = z.infer<typeof exchangeSchema>;
export const exchangeRecords = recordKind('exchange', exchangeSchema);

export { judgedVerdictOrNull } from '@ari/lib/api/schemas/appRecords/records';

const jobSchema = jobRecordSchema.omit({ kind: true });
export type JobLine = z.infer<typeof jobSchema>;
export const jobRecords = recordKind('job', jobSchema);

const appRequestSchema = requestRecordSchema.omit({ kind: true });
export type AppRequestLine = z.infer<typeof appRequestSchema>;
export const appRequestRecords = recordKind('app-request', appRequestSchema);

const appStateSchema = stateRecordSchema.omit({ kind: true });
export type AppStateLine = z.infer<typeof appStateSchema>;
export const appStateRecords = recordKind('app-state', appStateSchema);
