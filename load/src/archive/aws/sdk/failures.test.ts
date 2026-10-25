import { ECSClient } from '@aws-sdk/client-ecs';
import { PIClient } from '@aws-sdk/client-pi';
import { describe, expect, it, vi } from 'vitest';
import { SourceUnavailable } from '../sources.ts';
import { ecsSources } from './ecs.ts';
import { assertDescribed } from './failures.ts';
import { insightSources } from './insights.ts';

const window = {
  from: new Date('2026-10-15T00:00:00.000Z'),
  to: new Date('2026-10-15T01:00:00.000Z'),
};

/** An ECS client that answers each command from `answer` instead of going to AWS. */
function ecsAnswering(answer: (command: object) => object) {
  const client = new ECSClient({ region: 'ap-southeast-2' });
  // Only the network call is replaced; `send` is overloaded, which a plain function cannot match.
  vi.spyOn(client, 'send').mockImplementation(async (command: object) => answer(command) as never);
  return client;
}

describe('assertDescribed', () => {
  it('stops on a failure, naming what ECS could not describe and why', () => {
    expect(() =>
      assertDescribed('tasks of load', [{ arn: 'arn:task/t1', reason: 'MISSING' }]),
    ).toThrowError('ECS could not describe tasks of load: arn:task/t1: MISSING');
  });

  it('passes when ECS reports none', () => {
    expect(() => assertDescribed('tasks of load', [])).not.toThrow();
    expect(() => assertDescribed('tasks of load', undefined)).not.toThrow();
  });
});

describe('ecsSources', () => {
  it('stops the archive when ECS could not describe a task', async () => {
    const client = ecsAnswering((command) =>
      command.constructor.name === 'ListTasksCommand'
        ? { taskArns: ['arn:task/t1'] }
        : { tasks: [], failures: [{ arn: 'arn:task/t1', reason: 'MISSING' }] },
    );

    await expect(ecsSources(client).tasks('load')).rejects.toThrowError('MISSING');
  });

  it('stops the archive when ECS could not describe a service', async () => {
    const client = ecsAnswering(() => ({
      services: [],
      failures: [{ arn: 'arn:service/api', reason: 'MISSING' }],
    }));

    await expect(ecsSources(client).serviceEvents('app', ['api'])).rejects.toThrowError('MISSING');
  });
});

describe('insightSources', () => {
  it.each(['NotAuthorizedException', 'InvalidArgumentException'])(
    'stops the archive on %s, which says the call is wrong and not that the database is gone',
    async (name) => {
      const client = new PIClient({ region: 'ap-southeast-2' });
      vi.spyOn(client, 'send').mockImplementation(async () => {
        throw Object.assign(new Error('refused'), { name });
      });

      const reading = insightSources(client).databaseInsights('db-ABC', window);

      await expect(reading).rejects.toThrowError('refused');
      await expect(reading).rejects.not.toBeInstanceOf(SourceUnavailable);
    },
  );
});
