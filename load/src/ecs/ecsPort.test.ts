import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import { describe, expect, it, vi } from 'vitest';
import { ecsPortOf } from './ecsPort.ts';

const site = {
  cluster: 'load-cluster',
  taskDefinition: 'generator:7',
  subnets: ['subnet-a', 'subnet-b'],
  securityGroup: 'sg-1',
};

/** An ECS client that answers each command with what `answer` gives, and keeps the commands it was sent. */
function fakeClient(answer: (command: unknown) => unknown) {
  const client = new ECSClient({ region: 'ap-southeast-2' });
  const sent: unknown[] = [];
  const fake = async (command: unknown): Promise<unknown> => {
    sent.push(command);
    return answer(command);
  };
  // `send` is overloaded by command; a fake answering by command class cannot be typed against it.
  vi.spyOn(client, 'send').mockImplementation(fake as never);
  /** The commands of one kind that were sent, in order. */
  const sentOf = <Command>(kind: new (...args: never[]) => Command): Command[] =>
    sent.filter((command): command is Command => command instanceof kind);
  return { client, sent, sentOf };
}

describe('startTask', () => {
  it('asks for one task on the capacity provider of the placement, with no public address of its own and the slice in its environment', async () => {
    const { client, sentOf } = fakeClient(() => ({ tasks: [{ taskArn: 'arn:task/load/abc' }] }));

    const outcome = await ecsPortOf(client, site).startTask({
      placement: 'spot',
      environment: { GENERATOR: '3', FIRST_USER: '15' },
    });

    expect(outcome).toEqual({ started: true, taskArn: 'arn:task/load/abc' });
    expect(sentOf(RunTaskCommand)).toHaveLength(1);
    expect(sentOf(RunTaskCommand)[0]?.input).toMatchObject({
      cluster: 'load-cluster',
      taskDefinition: 'generator:7',
      count: 1,
      capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-a', 'subnet-b'],
          securityGroups: ['sg-1'],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'generator',
            environment: [
              { name: 'GENERATOR', value: '3' },
              { name: 'FIRST_USER', value: '15' },
            ],
          },
        ],
      },
    });
  });

  it('asks for On-Demand capacity when that is the placement', async () => {
    const { client, sentOf } = fakeClient(() => ({ tasks: [{ taskArn: 'arn:task/load/abc' }] }));

    await ecsPortOf(client, site).startTask({ placement: 'on-demand', environment: {} });

    expect(sentOf(RunTaskCommand)[0]?.input.capacityProviderStrategy).toEqual([
      { capacityProvider: 'FARGATE', weight: 1 },
    ]);
  });

  it('says when ECS has no capacity, and gives any other refusal as it is', async () => {
    const noCapacity = fakeClient(() => ({
      tasks: [],
      failures: [{ reason: 'Capacity is unavailable at this time. Try again later.' }],
    }));
    const refused = fakeClient(() => ({ tasks: [], failures: [{ reason: 'RESOURCE:CPU' }] }));

    expect(
      await ecsPortOf(noCapacity.client, site).startTask({ placement: 'spot', environment: {} }),
    ).toEqual({
      started: false,
      reason: 'Capacity is unavailable at this time. Try again later.',
      noCapacity: true,
    });
    expect(
      await ecsPortOf(refused.client, site).startTask({ placement: 'spot', environment: {} }),
    ).toEqual({ started: false, reason: 'RESOURCE:CPU', noCapacity: false });
  });
});

describe('startTask when ECS refuses by throwing', () => {
  const refusing = (message: string) =>
    fakeClient(() => {
      throw new Error(message);
    });

  it('counts a vCPU limit as no room, so a launch on Spot can be made again On-Demand', async () => {
    const { client } = refusing(
      'You’ve reached the limit on the number of vCPUs you can run concurrently',
    );

    expect(
      await ecsPortOf(client, site).startTask({ placement: 'spot', environment: {} }),
    ).toMatchObject({ started: false, noCapacity: true });
  });

  it('lets any other refusal through, for it would fail On-Demand as well', async () => {
    const { client } = refusing('AccessDeniedException: not allowed to run tasks');

    await expect(
      ecsPortOf(client, site).startTask({ placement: 'spot', environment: {} }),
    ).rejects.toThrow('AccessDeniedException');
  });
});

describe('describeTasks', () => {
  const task = (taskArn: string, lastStatus: string): Task => ({
    taskArn,
    lastStatus,
    stopCode: 'SpotInterruption',
    stoppedReason: 'Your Spot Task was interrupted.',
    capacityProviderName: 'FARGATE_SPOT',
    containers: [{ exitCode: 0 }],
  });

  it('tells a stopped task from a running one, and gives null for a task ECS has forgotten', async () => {
    const { client } = fakeClient(() => ({
      tasks: [task('arn:task/load/a', 'STOPPED'), task('arn:task/load/b', 'RUNNING')],
    }));

    const described = await ecsPortOf(client, site).describeTasks([
      'arn:task/load/a',
      'arn:task/load/b',
      'arn:task/load/c',
    ]);

    expect(described.get('arn:task/load/a')).toMatchObject({
      stopped: true,
      info: { taskId: 'a', stopCode: 'SpotInterruption', capacityProvider: 'FARGATE_SPOT' },
    });
    expect(described.get('arn:task/load/b')).toMatchObject({ stopped: false });
    expect(described.get('arn:task/load/c')).toBeNull();
  });

  it('asks about at most a hundred tasks at a time', async () => {
    const { client, sentOf } = fakeClient(() => ({ tasks: [] }));
    const arns = Array.from({ length: 150 }, (_, index) => `arn:task/load/${index}`);

    await ecsPortOf(client, site).describeTasks(arns);

    expect(sentOf(DescribeTasksCommand)).toHaveLength(2);
    expect(sentOf(DescribeTasksCommand)[1]?.input.tasks).toHaveLength(50);
  });
});

describe('stopTask', () => {
  it('stops the task with the reason given, which ECS keeps with it', async () => {
    const { client, sentOf } = fakeClient(() => ({}));

    await ecsPortOf(client, site).stopTask('arn:task/load/a', 'The run ended');

    expect(sentOf(StopTaskCommand)[0]?.input).toEqual({
      cluster: 'load-cluster',
      task: 'arn:task/load/a',
      reason: 'The run ended',
    });
  });
});

describe('runningTaskArns', () => {
  it('lists the tasks of the cluster that have not stopped, across every page', async () => {
    const { client, sentOf } = fakeClient((command) =>
      (command as ListTasksCommand).input.nextToken === undefined
        ? { taskArns: ['arn:task/load/a'], nextToken: 'more' }
        : { taskArns: ['arn:task/load/b'] },
    );

    const arns = await ecsPortOf(client, site).runningTaskArns();

    expect(arns).toEqual(['arn:task/load/a', 'arn:task/load/b']);
    expect(sentOf(ListTasksCommand)[0]?.input).toMatchObject({
      cluster: 'load-cluster',
      desiredStatus: 'RUNNING',
    });
  });
});
