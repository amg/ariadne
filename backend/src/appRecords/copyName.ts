import { hostname } from 'node:os';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../logger';

const METADATA_TIMEOUT_MS = 2_000;

/** What ECS answers of the task a process runs in; only its ARN is read. */
const taskMetadataSchema = z.object({ TaskARN: z.string().min(1) });

let name = `${hostname()}:${process.pid}`;

/** The name of this copy of the backend, which every record it writes gives. */
export function copyName() {
  return name;
}

/**
 * Learns the ECS task this copy runs in, so that its records name the
 * task by its id. Outside ECS, or when ECS does not answer, the records
 * keep naming the host and process. Never throws.
 */
export async function learnCopyName() {
  const metadata = env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadata === undefined) return;
  try {
    const response = await fetch(`${metadata}/task`, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    const { TaskARN } = taskMetadataSchema.parse(await response.json());
    name = TaskARN.split('/').at(-1) ?? name;
  } catch (error) {
    logger.warn({ err: error }, 'could not learn the ECS task; records name the host instead');
  }
}
