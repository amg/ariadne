import {
  DescribeTasksCommand,
  type ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { taskInfoOf } from '../archive/index.ts';
import type { TaskInfo } from '../types/archive.ts';
import { messageOf } from './messageOf.ts';

/** Where a generator runs: on Spot, which AWS can take back, or On-Demand. */
export type Placement = 'spot' | 'on-demand';

/**
 * What ECS says when it cannot place a task for lack of room: no Spot
 * capacity, or the account's vCPU limit for that kind of capacity.
 */
const NO_ROOM = /capacity|limit on the number of vCPUs|quota/i;

/** What ECS answered to a request to start a generator. */
export type StartOutcome =
  | { started: true; taskArn: string }
  | { started: false; reason: string; noCapacity: boolean };

/** A generator's task as ECS last described it. */
export type DescribedTask = {
  /** Whether the task is running its container. */
  running: boolean;
  /** Whether the task has stopped for good. */
  stopped: boolean;
  info: TaskInfo;
};

/** The few things the launcher asks of ECS. */
export type EcsPort = {
  startTask: (input: {
    placement: Placement;
    /** The environment this task gets in addition to its task definition's. */
    environment: Readonly<Record<string, string>>;
  }) => Promise<StartOutcome>;
  /** Each task by its ARN; null for one ECS does not know, as when it was stopped long ago. */
  describeTasks: (
    taskArns: readonly string[],
  ) => Promise<ReadonlyMap<string, DescribedTask | null>>;
  stopTask: (taskArn: string, reason: string) => Promise<void>;
  /** The ARNs of the tasks in the cluster that have not stopped, whoever started them. */
  runningTaskArns: () => Promise<readonly string[]>;
};

/** The most tasks ECS describes in one request. */
const TASKS_PER_REQUEST = 100;

const CAPACITY_PROVIDERS: Record<Placement, string> = {
  spot: 'FARGATE_SPOT',
  'on-demand': 'FARGATE',
};

/** Where ECS starts generators: one cluster, with the task definition and network the load stack made. */
type GeneratorSite = {
  cluster: string;
  taskDefinition: string;
  subnets: readonly string[];
  securityGroup: string;
};

/** The ECS of an AWS account, asked for the generators of one load stack. */
export function ecsPortOf(client: ECSClient, site: GeneratorSite): EcsPort {
  return {
    async startTask({ placement, environment }) {
      const command = new RunTaskCommand({
        cluster: site.cluster,
        taskDefinition: site.taskDefinition,
        count: 1,
        capacityProviderStrategy: [{ capacityProvider: CAPACITY_PROVIDERS[placement], weight: 1 }],
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...site.subnets],
            securityGroups: [site.securityGroup],
            // Every generator leaves through the load network's one public address.
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: 'generator',
              environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
            },
          ],
        },
      });
      try {
        const { tasks, failures } = await client.send(command);
        const taskArn = tasks?.[0]?.taskArn;
        if (taskArn !== undefined) return { started: true, taskArn };
        const reason = failures?.[0]?.reason ?? 'ECS gave neither a task nor a reason';
        return { started: false, reason, noCapacity: NO_ROOM.test(reason) };
      } catch (error) {
        // ECS reports some refusals by throwing; only one for lack of room is an answer.
        if (!NO_ROOM.test(messageOf(error))) throw error;
        return { started: false, reason: messageOf(error), noCapacity: true };
      }
    },

    async describeTasks(taskArns) {
      const found = new Map<string, DescribedTask | null>(taskArns.map((arn) => [arn, null]));
      for (let first = 0; first < taskArns.length; first += TASKS_PER_REQUEST) {
        const { tasks } = await client.send(
          new DescribeTasksCommand({
            cluster: site.cluster,
            tasks: taskArns.slice(first, first + TASKS_PER_REQUEST),
          }),
        );
        for (const task of tasks ?? []) {
          if (task.taskArn === undefined) continue;
          found.set(task.taskArn, {
            running: task.lastStatus === 'RUNNING',
            stopped: task.lastStatus === 'STOPPED',
            info: taskInfoOf(site.cluster, task),
          });
        }
      }
      return found;
    },

    async stopTask(taskArn, reason) {
      await client.send(new StopTaskCommand({ cluster: site.cluster, task: taskArn, reason }));
    },

    async runningTaskArns() {
      const arns: string[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListTasksCommand({ cluster: site.cluster, desiredStatus: 'RUNNING', nextToken }),
        );
        arns.push(...(page.taskArns ?? []));
        nextToken = page.nextToken;
      } while (nextToken !== undefined);
      return arns;
    },
  };
}
