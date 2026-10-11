import { logger } from '../src/logger';

/**
 * On SIGINT or SIGTERM, runs `stop` once (letting running background jobs
 * finish), then exits.
 */
export function stopOnSignals(stop: () => Promise<void>): void {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      logger.info(`${signal} received, stopping`);
      void stop()
        .catch((error: unknown) => logger.error({ err: error }, 'did not stop cleanly'))
        .finally(() => process.exit(0));
    });
  }
}
