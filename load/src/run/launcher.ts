/** A launch that failed with its task left behind that could not be stopped, which may still start and load its users. */
export class TaskMayStillRun extends Error {}

/** A generator that could not be kept running to the end of its plan. */
export class GeneratorDidNotFinish extends Error {
  readonly reason: 'timed-out' | 'failed';

  constructor(reason: 'timed-out' | 'failed', message: string) {
    super(message);
    this.reason = reason;
  }
}
