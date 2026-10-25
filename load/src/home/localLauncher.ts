import { join } from 'node:path';
import { LAYOUT } from '../records/index.ts';
import type { GeneratorLauncher } from '../types/run.ts';
import { startGenerator } from './generatorRun.ts';
import { generatorEnvironment } from './stack/index.ts';
import type { UsersSoFar } from './types.ts';
import { followRequests } from './watch/index.ts';

/** How often a generator writes a line of its running state. */
const STATE_EVERY_SECONDS = 2;

type LocalLauncher = GeneratorLauncher & {
  /** What the users of every generator started so far saw, from their request lines. */
  users: () => UsersSoFar;
};

/**
 * Starts each generator as a process of this machine, out of the way of
 * its other work. Each writes its output into the run folder.
 */
export function localLauncher(input: {
  folder: string;
  runId: string;
  backendUrl: string;
  password: string;
  /** The name a generator's process goes by. */
  nameOf: (generator: number) => string;
}): LocalLauncher {
  const requests = followRequests();
  return {
    launch(start) {
      const outputName = LAYOUT.generatorOutput(start.generator, start.attempt);
      const outputFile = join(input.folder, outputName);
      requests.follow(outputFile);
      const running = startGenerator({
        name: input.nameOf(start.generator),
        generator: start.generator,
        env: generatorEnvironment(process.env.PATH, {
          runId: input.runId,
          generator: start.generator,
          attempt: start.attempt,
          mode: 'load',
          backendUrl: input.backendUrl,
          password: input.password,
          firstUser: start.firstUser,
          userCount: start.userCount,
          chattingShare: 1,
          rampSeconds: start.rampSeconds,
          holdSeconds: start.holdSeconds,
          endsAt: start.endsAt,
          thinkSeconds: start.thinkSeconds,
          seedConcurrency: 1,
          stateSeconds: STATE_EVERY_SECONDS,
        }),
        outputFile,
        outputName,
        timeoutMs: start.timeoutMs,
      });
      return {
        task: `pid-${running.process.groupId}`,
        spot: false,
        ended: running.ended,
        stop: () => running.process.stop(),
      };
    },
    users: () => requests.soFar(),
  };
}
